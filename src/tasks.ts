import { createReadStream } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { atomicWriteFile, tryCreateLockFile } from "./storage";
import type {
	Binding,
	BoundSession,
	DeliveryMode,
	ExternalAction,
	FileArtifact,
	InputSnapshot,
	ManifestApproval,
	ManifestInput,
	OwnerIdentity,
	PreparedTask,
	RoundConfirmation,
	RoundConfirmationV3,
	StagedTask,
	StoredTaskSummary,
	TargetPolicy,
	TaskError,
	TaskGoal,
	TaskListWarning,
	TaskLock,
	TaskManifestPayload,
	TaskReceipt,
	TaskRequest,
	TaskRound,
	TaskStatus,
} from "./types";
import { taskError, WB_ERROR_CODE, WbTaskError } from "./types";
export { WbTaskError };
/**
 * Standard UUID format (8-4-4-4-12 hex). Used to validate task IDs before
 * touching the filesystem so arbitrary path traversal via taskId is impossible.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the in-memory or deserialized object shape of a Binding.
 * Throws WB_BINDING_INVALID if any contract requirements are unmet.
 */
function validateBindingShape(raw: unknown, source: string): Binding {
	if (typeof raw !== "object" || raw === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: root must be a JSON object`
		);
	}

	if (!("version" in raw) || (raw.version !== 1 && raw.version !== 2)) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: expected version 1 or 2, got ${String("version" in raw ? raw.version : "missing")}`
		);
	}
	const version = raw.version;

	if (!("projectRoot" in raw) || typeof raw.projectRoot !== "string" || raw.projectRoot.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: projectRoot must be a non-empty string`
		);
	}

	if (!("sessionId" in raw) || typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: sessionId must be a non-empty string`
		);
	}

	if (!("workbuddyVersion" in raw) || typeof raw.workbuddyVersion !== "string" || raw.workbuddyVersion.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: workbuddyVersion must be a non-empty string`
		);
	}

	// A v2 binding carries a session roster. It is validated fail-closed: a
	// malformed entry rejects the whole file rather than being filtered out,
	// because silently accepting a scrubbed roster would let any writer widen
	// the set of sessions this project may delegate to.
	const result: Binding = {
		version,
		projectRoot: raw.projectRoot,
		sessionId: raw.sessionId,
		workbuddyVersion: raw.workbuddyVersion,
	};
	if (version === 2) {
		if (!("sessions" in raw) || !Array.isArray(raw.sessions)) {
			throw new WbTaskError(
				WB_ERROR_CODE.bindingInvalid,
				`Malformed binding file at ${source}: version 2 requires a sessions array`
			);
		}
		const sessions: BoundSession[] = [];
		for (const entry of raw.sessions) {
			if (typeof entry !== "object" || entry === null) {
				throw new WbTaskError(
					WB_ERROR_CODE.bindingInvalid,
					`Malformed binding file at ${source}: every roster entry must be an object`
				);
			}
			const candidate = entry as Record<string, unknown>;
			if (
				typeof candidate.sessionId !== "string" ||
				candidate.sessionId.trim().length === 0
			) {
				throw new WbTaskError(
					WB_ERROR_CODE.bindingInvalid,
					`Malformed binding file at ${source}: every roster entry needs a non-empty sessionId`
				);
			}
			if (candidate.role !== undefined && typeof candidate.role !== "string") {
				throw new WbTaskError(
					WB_ERROR_CODE.bindingInvalid,
					`Malformed binding file at ${source}: roster entry role must be a string when present`
				);
			}
			if (candidate.title !== undefined && typeof candidate.title !== "string") {
				throw new WbTaskError(
					WB_ERROR_CODE.bindingInvalid,
					`Malformed binding file at ${source}: roster entry title must be a string when present`
				);
			}
			if (candidate.isDefault !== undefined && typeof candidate.isDefault !== "boolean") {
				throw new WbTaskError(
					WB_ERROR_CODE.bindingInvalid,
					`Malformed binding file at ${source}: roster entry isDefault must be a boolean when present`
				);
			}
			const rosterEntry: BoundSession = { sessionId: candidate.sessionId };
			if (candidate.role !== undefined) {
				rosterEntry.role = candidate.role;
			}
			if (candidate.title !== undefined) {
				rosterEntry.title = candidate.title;
			}
			if (candidate.isDefault !== undefined) {
				rosterEntry.isDefault = candidate.isDefault;
			}
			sessions.push(rosterEntry);
		}
		result.sessions = sessions;
	} else if ("sessions" in raw) {
		// A roster under a v1 version marker means the file was edited without
		// bumping the version: treat it as tampering, not as a v2 binding.
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: version 1 must not carry a sessions roster`
		);
	}
	return result;
}

/**
 * Validates the in-memory or deserialized object shape of a TaskReceipt.
 * Throws WB_TASK_STATE_INVALID if any structural requirements are missing or corrupted.
 */
function parseErrorField(rawError: unknown, source: string): TaskError | null {
	if (rawError === null) {
		return null;
	}
	if (
		typeof rawError !== "object" ||
		!("code" in rawError) ||
		typeof rawError.code !== "string" ||
		!("message" in rawError) ||
		typeof rawError.message !== "string"
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: error must be null or an object with string code and message`
		);
	}
	return {
		code: rawError.code,
		message: rawError.message,
	};
}

function parseStatusField(rawStatus: unknown, source: string): TaskStatus {
	switch (rawStatus) {
		case "running":
		case "awaiting_approval":
		case "completed":
		case "failed":
		case "cancelled":
		case "interrupted":
			return rawStatus;
		default:
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: unknown status "${String(rawStatus)}"`
			);
	}
}

export function currentRound(receipt: TaskReceipt): TaskRound {
	if (!receipt || !Array.isArray(receipt.rounds) || receipt.rounds.length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Receipt for task ${receipt?.taskId ?? "unknown"} has no execution rounds`
		);
	}
	for (let i = 0; i < receipt.rounds.length; i++) {
		const round = receipt.rounds[i];
		if (!round || round.number !== i + 1) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Receipt for task ${receipt.taskId} has discontinuous round number at index ${i}: expected ${i + 1}, got ${round?.number}`
			);
		}
	}
	return receipt.rounds[receipt.rounds.length - 1]!;
}

export async function computeFileSha256(filePath: string): Promise<string> {
	const hash = crypto.createHash("sha256");
	const stream = createReadStream(filePath);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	stream.on("data", (chunk) => hash.update(chunk));
	stream.on("end", () => resolve(hash.digest("hex")));
	stream.on("error", reject);
	return promise;
}

/** Every on-disk directory one round owns, resolved from its layout. */
export interface RoundPaths {
	roundDir: string;
	inputsDir: string;
	outputsDir: string;
	briefPath: string;
}

/**
 * The single source of truth for where a round keeps its files.
 *
 * `legacy` receipts predate rounds and keep their inputs/outputs directly under
 * the task directory; `round` receipts nest them under `rounds/<n>`. Every
 * consumer (prompt rendering, staging, artifact collection) must resolve paths
 * here, because a second implementation silently disagrees about where a
 * deliverable lives and the only symptom is a round stuck on missing outputs.
 */
export function resolveRoundPaths(projectRoot: string, taskId: string, round: number, layout: "legacy" | "round"): RoundPaths {
	// Defense in depth: callers already validate, but a task id reaches a
	// filesystem path right here, so this is the last gate before traversal.
	if (!UUID_PATTERN.test(taskId)) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Task id "${taskId}" must be a valid UUID`);
	}
	if (!Number.isInteger(round) || round < 1) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Round must be a positive integer, got: ${String(round)}`);
	}
	const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", taskId);
	if (layout === "legacy") {
		return {
			roundDir: taskDir,
			inputsDir: path.join(taskDir, "inputs"),
			outputsDir: path.join(taskDir, "outputs"),
			briefPath: path.join(taskDir, "brief.md"),
		};
	}
	const roundDir = path.join(taskDir, "rounds", String(round));
	return {
		roundDir,
		inputsDir: path.join(roundDir, "inputs"),
		outputsDir: path.join(roundDir, "outputs"),
		briefPath: path.join(roundDir, "brief.md"),
	};
}

export function renderTaskPrompt(
	goal: TaskGoal,
	options: {
		taskId: string;
		round: number;
		inputsDir: string;
		outputsDir: string;
		inputFiles: InputSnapshot[];
		expectedOutputs: string[];
	}
): string {
	const lines: string[] = [];
	lines.push(`# Objective and Intent`);
	lines.push(goal.objective);
	lines.push("");

	if (goal.context.trim().length > 0) {
		lines.push(`## Background Context`);
		lines.push(goal.context);
		lines.push("");
	}

	lines.push(`## Execution Coordinates`);
	lines.push(`- Task ID: \`${options.taskId}\``);
	lines.push(`- Execution Round: ${options.round}`);
	lines.push(`- Outputs Directory: \`${options.outputsDir}\``);
	lines.push("");

	lines.push(`## Input Snapshots`);
	if (options.inputFiles.length > 0) {
		for (const input of options.inputFiles) {
			const absPath = path.resolve(options.inputsDir, path.normalize(input.path));
			lines.push(`- \`${input.path}\` (SHA-256: \`${input.sha256 ?? "unknown"}\`): snapshot located at \`${absPath}\``);
		}
	} else {
		lines.push("None provided for this round.");
	}
	lines.push("");

	lines.push(`## Expected Deliverables and Acceptance Conditions`);
	if (options.expectedOutputs.length > 0) {
		for (const out of options.expectedOutputs) {
			const dest = path.join(options.outputsDir, out);
			lines.push(`- \`${out}\`: must be written into \`${dest}\``);
		}
	} else {
		lines.push("No specific output files declared for this round.");
	}
	if (goal.acceptance.length > 0) {
		lines.push("");
		lines.push(`### Acceptance Criteria`);
		for (const item of goal.acceptance) {
			lines.push(`- ${item}`);
		}
	}
	lines.push("");

	if (goal.constraints.length > 0) {
		lines.push(`## Constraints`);
		for (const c of goal.constraints) {
			lines.push(`- ${c}`);
		}
		lines.push("");
	}

	if (goal.externalActions.length > 0) {
		lines.push(`## Planned External Actions (Human Confirmed)`);
		for (const act of goal.externalActions) {
			lines.push(`- [${act.kind}] target: ${act.target}, operation: ${act.operation}, parameters: ${act.parameters}`);
		}
		lines.push("");
	}

	lines.push(`## Collaboration and Guidelines`);
	lines.push(`- WorkBuddy must utilize its native skills, tools, and domain abilities to achieve this objective.`);
	lines.push(`- Deliverables must be placed inside the declared outputs directory (\`${options.outputsDir}\`).`);
	lines.push(`- Query project collaboration context or report progress checkpoints using the collaboration MCP tools if available.`);
	lines.push(`- Do NOT issue instructions or commands to OMP via collaboration records.`);
	lines.push(`- Do NOT modify project source files outside the authorized scope.`);
	lines.push(`- External publishing, deployment, or cloud actions require explicit authorization; do not perform unconfirmed external side-effects.`);

	return lines.join("\n");
}

/**
 * Validates the in-memory or deserialized object shape of a TaskReceipt (v1 or v2).
 * If v1, normalizes to an in-memory v2 receipt with a single legacy round.
 * Throws WB_TASK_STATE_INVALID if any structural requirements are missing or corrupted.
 */
function validateReceiptObject(raw: unknown, source: string): TaskReceipt {
	if (typeof raw !== "object" || raw === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: root must be a JSON object`
		);
	}

	if (!("version" in raw)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: missing version field`
		);
	}

	if (!("taskId" in raw) || typeof raw.taskId !== "string" || !UUID_PATTERN.test(raw.taskId)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: taskId must be a valid UUID`
		);
	}

	if (!("sessionId" in raw) || typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: sessionId must be a non-empty string`
		);
	}

	if (!("projectRoot" in raw) || typeof raw.projectRoot !== "string" || raw.projectRoot.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: projectRoot must be a non-empty string`
		);
	}

	if (raw.version === 1) {
		const v1 = raw as Record<string, unknown>;
		const status = parseStatusField(v1.status, source);
		if (typeof v1.prompt !== "string") {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: prompt must be a string`);
		}
		if (!Array.isArray(v1.inputFiles) || v1.inputFiles.some((x) => typeof x !== "string")) {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: inputFiles must be string[]`);
		}
		if (!Array.isArray(v1.expectedOutputs) || v1.expectedOutputs.some((x) => typeof x !== "string")) {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: expectedOutputs must be string[]`);
		}
		if (typeof v1.summary !== "string") {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: summary must be a string`);
		}
		if (!Array.isArray(v1.artifacts) || v1.artifacts.some((x) => typeof x !== "string")) {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: artifacts must be string[]`);
		}
		const parsedError = parseErrorField(v1.error, source);

		const round1: TaskRound = {
			number: 1,
			layout: "legacy",
			goal: {
				objective: v1.prompt,
				context: "",
				constraints: [],
				acceptance: [],
				externalActions: [],
			},
			inputFiles: v1.inputFiles.map((p: string) => ({ path: p, sha256: null })),
			expectedOutputs: [...v1.expectedOutputs],
			status,
			summary: v1.summary,
			error: parsedError,
			artifacts: v1.artifacts.map((p: string) => ({
				kind: "file",
				path: p,
				sha256: null,
				bytes: null,
				role: "final",
				provenance: "legacy_unverified",
				importedFrom: null,
			})),
			consent: null,
		};

		return {
			version: 2,
			taskId: raw.taskId,
			sessionId: raw.sessionId,
			projectRoot: raw.projectRoot,
			rounds: [round1],
		};
	}

	if (raw.version === 2) {
		const v2 = raw as Record<string, unknown>;
		if (!Array.isArray(v2.rounds) || v2.rounds.length === 0) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: rounds must be a non-empty array`
			);
		}

		const rounds: TaskRound[] = [];
		for (let i = 0; i < v2.rounds.length; i++) {
			const r = v2.rounds[i] as Record<string, unknown>;
			if (typeof r !== "object" || r === null) {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: round ${i + 1} must be an object`);
			}
			if (r.number !== i + 1) {
				throw new WbTaskError(
					WB_ERROR_CODE.taskStateInvalid,
					`Malformed task receipt at ${source}: round number at index ${i} must be ${i + 1}`
				);
			}
			if (r.layout !== "legacy" && r.layout !== "round") {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: round layout must be legacy or round`);
			}
			if (typeof r.goal !== "object" || r.goal === null) {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: round goal must be an object`);
			}
			const g = r.goal as Record<string, unknown>;
			if (typeof g.objective !== "string") {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: goal.objective must be a string`);
			}
			const context = typeof g.context === "string" ? g.context : "";
			const constraints = Array.isArray(g.constraints) ? g.constraints.map(String) : [];
			const acceptance = Array.isArray(g.acceptance) ? g.acceptance.map(String) : [];
			const externalActions: ExternalAction[] = [];
			if (Array.isArray(g.externalActions)) {
				for (const act of g.externalActions) {
					if (typeof act === "object" && act !== null) {
						const a = act as Record<string, unknown>;
						if (
							(a.kind === "publish" || a.kind === "deploy" || a.kind === "cloud_write" || a.kind === "schedule") &&
							typeof a.target === "string" &&
							typeof a.operation === "string" &&
							typeof a.parameters === "string"
						) {
							externalActions.push({
								kind: a.kind,
								target: a.target,
								operation: a.operation,
								parameters: a.parameters,
							});
						}
					}
				}
			}

			const status = parseStatusField(r.status, source);
			const summary = typeof r.summary === "string" ? r.summary : "";
			const error = parseErrorField(r.error, source);

			if (!Array.isArray(r.inputFiles)) {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: inputFiles must be an array`);
			}
			const inputFiles: InputSnapshot[] = r.inputFiles.map((item: unknown) => {
				if (typeof item === "object" && item !== null && "path" in item && typeof item.path === "string") {
					const sha256 = "sha256" in item && typeof item.sha256 === "string" ? item.sha256 : null;
					return {
						path: item.path,
						sha256,
					};
				}
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: invalid inputFiles element`);
			});

			if (!Array.isArray(r.expectedOutputs) || r.expectedOutputs.some((x) => typeof x !== "string")) {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: expectedOutputs must be string[]`);
			}

			if (!Array.isArray(r.artifacts)) {
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: artifacts must be an array`);
			}
			const artifacts: FileArtifact[] = r.artifacts.map((art: unknown) => {
				if (typeof art === "object" && art !== null && "path" in art && typeof art.path === "string") {
					const sha256 = "sha256" in art && typeof art.sha256 === "string" ? art.sha256 : null;
					const bytes = "bytes" in art && typeof art.bytes === "number" ? art.bytes : null;
					const role = "role" in art && art.role === "supporting" ? "supporting" : "final";
					const provenance = "provenance" in art && (art.provenance === "imported" || art.provenance === "legacy_unverified") ? art.provenance : "native";
					const importedFrom = "importedFrom" in art && typeof art.importedFrom === "string" ? art.importedFrom : null;
					return {
						kind: "file",
						path: art.path,
						sha256,
						bytes,
						role,
						provenance,
						importedFrom,
					};
				}
				throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed task receipt at ${source}: invalid artifacts element`);
			});

			let consent: { source: "host_dialog" | "user_command"; at: string } | null = null;
			if (typeof r.consent === "object" && r.consent !== null) {
				const c = r.consent as Record<string, unknown>;
				if ((c.source === "host_dialog" || c.source === "user_command") && typeof c.at === "string") {
					consent = { source: c.source, at: c.at };
				}
			}

			rounds.push({
				number: i + 1,
				layout: r.layout,
				goal: {
					objective: g.objective,
					context,
					constraints,
					acceptance,
					externalActions,
				},
				inputFiles,
				expectedOutputs: [...r.expectedOutputs],
				status,
				summary,
				error,
				artifacts,
				consent,
			});
		}

		return {
			version: 2,
			taskId: raw.taskId,
			sessionId: raw.sessionId,
			projectRoot: raw.projectRoot,
			rounds,
		};
	}

	throw new WbTaskError(
		WB_ERROR_CODE.taskStateInvalid,
		`Malformed task receipt at ${source}: unsupported version ${String(raw.version)}`
	);
}

/**
 * Reports a durable-state read or write failure with the task and stage it hit.
 *
 * Only the task id, the stage and the underlying reason are included: prompts,
 * tokens and raw network responses must never reach an error report.
 */
function storageFailure(taskId: string, stage: string, err: unknown): WbTaskError {
	const reason = err instanceof Error ? err.message : String(err);
	return new WbTaskError(
		WB_ERROR_CODE.storageError,
		`Storage failure for task ${taskId} during ${stage}: ${reason}`
	);
}

/**
 * True when a pid is still running.
 *
 * Only ESRCH — the OS's own "no such process" — is treated as dead. Any other
 * failure (notably EPERM for a live process owned by somebody else) leaves the
 * answer uncertain, and an uncertain lock is reported as live so a running task
 * is never reaped by mistake.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err) {
			return err.code !== "ESRCH";
		}
		return true;
	}
}

/**
 * Reads the project's single-task lock without creating, repairing or removing
 * anything.
 *
 * Per-session locks are the beta-era form; stage 4 replaces this file-lock path entirely.
 *
 * @param projectRoot The project root directory.
 * @param sessionId Optional session identifier. When provided, reads `.wb-bridge/active-<sessionId>.lock`
 *   first and falls back to legacy `active.lock` if absent.
 * @returns The lock record, or null when the project or the lock is absent.
 * @throws WbTaskError `WB_TASK_STATE_INVALID` when the lock is present but not a
 *   real, well-formed lock file and `WB_STORAGE_ERROR` when it cannot be read.
 */
export async function readTaskLock(projectRoot: string, sessionId?: string): Promise<TaskLock | null> {
	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return null;
		}
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Failed to resolve project root ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	async function readSingleLock(lockPath: string): Promise<TaskLock | null> {
		// The lock must be a real regular file: a symlink could point anywhere, and
		// reading through it would report state that is not this project's.
		let entryStat;
		try {
			entryStat = await lstat(lockPath);
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				return null;
			}
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Failed to inspect active lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		if (!entryStat.isFile()) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Lock file at ${lockPath} is not a regular file`
			);
		}

		let lockReal: string;
		try {
			lockReal = await realpath(lockPath);
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				// Removed between the lstat and the resolution: the slot is free.
				return null;
			}
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Failed to resolve active lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		const relFromRoot = path.relative(root, lockReal);
		if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Lock file at ${lockPath} resolves outside the project root`
			);
		}

		let content: string;
		try {
			content = await readFile(lockPath, "utf-8");
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				return null;
			}
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Failed to read active lock file at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		return parseLockContent(content, lockPath);
	}

	if (sessionId !== undefined) {
		if (!UUID_PATTERN.test(sessionId)) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Supplied sessionId "${sessionId}" must be a valid UUID`
			);
		}
		const sessionLockPath = path.join(root, ".wb-bridge", `active-${sessionId}.lock`);
		const sessionLock = await readSingleLock(sessionLockPath);
		if (sessionLock !== null) {
			return sessionLock;
		}
	}

	const legacyLockPath = path.join(root, ".wb-bridge", "active.lock");
	return readSingleLock(legacyLockPath);
}


/** Validates one lock file's bytes, keeping the state-invalid classification. */
function parseLockContent(content: string, lockPath: string): TaskLock {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Invalid JSON in lock file at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("ownerPid" in parsed) ||
		typeof parsed.ownerPid !== "number" ||
		!Number.isInteger(parsed.ownerPid) ||
		parsed.ownerPid <= 0 ||
		!("taskId" in parsed) ||
		typeof parsed.taskId !== "string" ||
		!UUID_PATTERN.test(parsed.taskId)
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Lock file at ${lockPath} is invalid or owner PID cannot be determined`
		);
	}

	return { ownerPid: parsed.ownerPid, taskId: parsed.taskId };
}

/**
 * Acquires the single-task mutual exclusion lock using exclusive create semantics.
 * If held by a dead process, reaps the lock after marking the orphaned task interrupted.
 */
async function acquireLock(projectRoot: string, taskId: string): Promise<void> {
	const bridgeDir = path.join(projectRoot, ".wb-bridge");
	await mkdir(bridgeDir, { recursive: true });
	const lockPath = path.join(bridgeDir, "active.lock");

	for (let attempt = 0; attempt < 5; attempt++) {
		const lockContent = JSON.stringify({ ownerPid: process.pid, taskId, acquiredAt: Date.now() }, null, 2);
		const claimed = await tryCreateLockFile(lockPath, lockContent);
		if (claimed) {
			return;
		}

		// The file already exists; inspect the active lock to see if the holder is alive.
		// A corrupt or unreadable lock is never silently discarded, because it may
		// describe a task whose state a human still needs; its error propagates.
		const held = await readTaskLock(projectRoot);
		if (held === null) {
			// The lock was freed right after the link failed; retry the loop.
			continue;
		}

		const ownerPid = held.ownerPid;
		const staleTaskId = held.taskId;

		if (isPidAlive(ownerPid)) {
			throw new WbTaskError(
				WB_ERROR_CODE.busy,
				`Task lock is held by live process PID ${ownerPid} for task ${staleTaskId}`
			);
		}

		// The owner is dead. Its receipt must record the interruption before the
		// lock goes away, otherwise the next task would start beside an orphan
		// that still looks alive. Only a receipt that is genuinely absent permits
		// lock-only recovery; every other read failure keeps the lock in place so
		// the orphan's evidence survives.
		let orphan: TaskReceipt | null = null;
		try {
			orphan = await readTask(projectRoot, staleTaskId);
		} catch (err: unknown) {
			if (!(err instanceof WbTaskError && err.code === WB_ERROR_CODE.taskNotFound)) {
				throw new WbTaskError(
					err instanceof WbTaskError ? err.code : WB_ERROR_CODE.storageError,
					`Task lock kept: the orphaned task ${staleTaskId} could not be read (${
						err instanceof Error ? err.message : String(err)
					})`
				);
			}
		}
		if (orphan !== null) {
			const current = currentRound(orphan);
			if (current.status === "running" || current.status === "awaiting_approval") {
				current.status = "interrupted";
				current.error = taskError(
					WB_ERROR_CODE.interrupted,
					`Owner process ${ownerPid} is no longer running`
				);
				try {
					await writeTask(orphan);
				} catch (err: unknown) {
					throw storageFailure(staleTaskId, "orphan receipt commit, so the lock was kept", err);
				}
			}
		}

		try {
			await unlink(lockPath);
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				// The lock was already unlinked by a concurrent process; proceed to retry.
			} else {
				throw err;
			}
		}
	}

	throw new WbTaskError(
		WB_ERROR_CODE.busy,
		"Exceeded maximum lock acquisition attempts due to concurrent contention"
	);
}

/**
 * Reads and parses the project's binding record from `.wb-bridge/binding.json`.
 * Returns null if the file does not exist. Throws WB_BINDING_INVALID if malformed.
 */
export async function readBinding(projectRoot: string): Promise<Binding | null> {
	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch (err: unknown) {
		// If the project directory itself cannot be found, no binding exists.
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return null;
		}
		throw err;
	}

	const filePath = path.join(root, ".wb-bridge", "binding.json");
	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return null;
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Failed to read binding file at ${filePath}: ${msg}`
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed JSON in binding file at ${filePath}: ${msg}`
		);
	}

	return validateBindingShape(parsed, filePath);
}

/**
 * Atomically stores the binding record to `.wb-bridge/binding.json`.
 * Resolves projectRoot to its canonical realpath and creates parent folders if needed.
 */
export async function writeBinding(binding: Binding): Promise<void> {
	const root = await realpath(binding.projectRoot);
	const bridgeDir = path.join(root, ".wb-bridge");
	const targetPath = path.join(bridgeDir, "binding.json");

	validateBindingShape(binding, targetPath);

	const content = JSON.stringify(
		{
			version: binding.version,
			projectRoot: root,
			sessionId: binding.sessionId,
			workbuddyVersion: binding.workbuddyVersion,
			// A v1 file must not carry a roster: the validator rejects that shape
			// as tampering, so writing it would make our own file unreadable.
			...(binding.version === 2 ? { sessions: binding.sessions ?? [] } : {}),
		},
		null,
		2
	);

	await atomicWriteFile(bridgeDir, targetPath, content);
}

/**
 * Reads a task receipt from disk by its UUID.
 * Fails with WB_TASK_NOT_FOUND if missing, or WB_TASK_STATE_INVALID if corrupted.
 */
export async function readTask(projectRoot: string, taskId: string): Promise<TaskReceipt> {
	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskNotFound,
				`Project root directory not found: ${projectRoot}`
			);
		}
		throw err;
	}

	if (!UUID_PATTERN.test(taskId)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskNotFound,
			`Task ID "${taskId}" is not a valid UUID`
		);
	}

	const receiptPath = path.join(root, ".wb-bridge", "tasks", taskId, "receipt.json");
	let content: string;
	try {
		content = await readFile(receiptPath, "utf-8");
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskNotFound,
				`Task receipt not found for task ${taskId}`
			);
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Failed to read receipt file at ${receiptPath}: ${msg}`
		);
	}

	return parseReceiptJson(content, receiptPath);
}

/**
 * Decodes one receipt's bytes into a validated receipt.
 *
 * Shared by single-task reads and the history index so both report the same
 * `WB_TASK_STATE_INVALID` classification for the same corrupt bytes.
 */
function parseReceiptJson(content: string, source: string): TaskReceipt {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed JSON in task receipt at ${source}: ${msg}`
		);
	}

	return validateReceiptObject(parsed, source);
}

/**
 * Lists every readable task this project has on disk, newest first.
 *
 * One damaged task never hides the others: it becomes a warning and the scan
 * continues. A directory-level failure is reported instead of returning an empty
 * list, because "no history" and "history unreadable" are different answers.
 *
 * Nothing here writes, repairs or follows a link, and the canonical project root
 * is resolved once for the whole scan.
 */
export async function readTaskIndex(
	projectRoot: string
): Promise<{ entries: StoredTaskSummary[]; warnings: TaskListWarning[] }> {
	const entries: StoredTaskSummary[] = [];
	const warnings: TaskListWarning[] = [];

	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Cannot list tasks: project root ${projectRoot} could not be resolved (${
				err instanceof Error ? err.message : String(err)
			})`
		);
	}

	const tasksRoot = path.join(root, ".wb-bridge", "tasks");
	let names: string[];
	try {
		names = await readdir(tasksRoot);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			// No tasks directory yet is an empty history, not a failure.
			return { entries, warnings };
		}
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Cannot list tasks in ${tasksRoot}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	// The tasks root itself must stay inside the project, so a link standing in
	// for the whole directory cannot expose another location's history.
	try {
		const tasksReal = await realpath(tasksRoot);
		const relFromRoot = path.relative(root, tasksReal);
		if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Cannot list tasks: ${tasksRoot} resolves outside the project root`
			);
		}
	} catch (err: unknown) {
		if (err instanceof WbTaskError) {
			throw err;
		}
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Cannot list tasks: ${tasksRoot} could not be resolved (${
				err instanceof Error ? err.message : String(err)
			})`
		);
	}

	for (const name of names) {
		if (!UUID_PATTERN.test(name)) {
			// Anything that is not a UUID-named task directory is not ours to read.
			continue;
		}

		const taskDir = path.join(tasksRoot, name);
		try {
			const dirStat = await lstat(taskDir);
			if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
				warnings.push({
					taskId: name,
					error: taskError(WB_ERROR_CODE.taskStateInvalid, `Task entry ${name} is not a real directory`),
				});
				continue;
			}
			const dirReal = await realpath(taskDir);
			const relFromTasks = path.relative(await realpath(tasksRoot), dirReal);
			if (relFromTasks.startsWith("..") || path.isAbsolute(relFromTasks) || relFromTasks === "") {
				warnings.push({
					taskId: name,
					error: taskError(WB_ERROR_CODE.taskStateInvalid, `Task entry ${name} resolves outside the tasks directory`),
				});
				continue;
			}

			const receiptPath = path.join(taskDir, "receipt.json");
			const receiptStat = await lstat(receiptPath);
			if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
				warnings.push({
					taskId: name,
					error: taskError(WB_ERROR_CODE.taskStateInvalid, `Receipt for ${name} is not a real file`),
				});
				continue;
			}
			const receiptReal = await realpath(receiptPath);
			const relReceipt = path.relative(root, receiptReal);
			if (relReceipt.startsWith("..") || path.isAbsolute(relReceipt) || relReceipt === "") {
				warnings.push({
					taskId: name,
					error: taskError(WB_ERROR_CODE.taskStateInvalid, `Receipt for ${name} resolves outside the project root`),
				});
				continue;
			}

			const receipt = parseReceiptJson(await readFile(receiptPath, "utf-8"), receiptPath);

			// The record has to belong to this project and to this directory, or it
			// would be reported under an identity it does not actually have.
			if (receipt.taskId.toLowerCase() !== name.toLowerCase()) {
				warnings.push({
					taskId: name,
					error: taskError(
						WB_ERROR_CODE.taskStateInvalid,
						`Receipt in ${name} declares task ${receipt.taskId}`
					),
				});
				continue;
			}
			if (receipt.projectRoot !== root) {
				warnings.push({
					taskId: name,
					error: taskError(
						WB_ERROR_CODE.taskStateInvalid,
						`Receipt in ${name} belongs to ${receipt.projectRoot}`
					),
				});
				continue;
			}

			const current = currentRound(receipt);
			entries.push({
				taskId: receipt.taskId,
				sessionId: receipt.sessionId,
				round: current.number,
				status: current.status,
				updatedAt: receiptStat.mtimeMs,
			});
		} catch (err: unknown) {
			// A missing, corrupt, unreadable or vanished task is reported without
			// stopping the scan, and without echoing the receipt's own contents.
			warnings.push({
				taskId: name,
				error: taskError(
					err instanceof WbTaskError ? err.code : WB_ERROR_CODE.taskStateInvalid,
					err instanceof Error ? err.message : String(err)
				),
			});
		}
	}

	return { entries, warnings };
}

/**
 * Writes a task receipt to disk atomically. Validates structure prior to disk access.
 *
 * Structure problems are reported as `WB_TASK_STATE_INVALID` by validation
 * itself; every failure after that point is a filesystem failure and is
 * reported as `WB_STORAGE_ERROR` so callers can tell the two apart.
 */
export async function writeTask(receipt: TaskReceipt): Promise<void> {
	if (receipt.version !== 2) {
		const unk = receipt as unknown;
		const ver = typeof unk === "object" && unk !== null && "version" in unk ? unk.version : undefined;
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Cannot write receipt: expected version 2, got ${String(ver)}`
		);
	}
	validateReceiptObject(receipt, "<in-memory receipt>");

	let root: string;
	try {
		root = await realpath(receipt.projectRoot);
	} catch (err: unknown) {
		throw storageFailure(receipt.taskId, "project root resolution", err);
	}
	const taskDir = path.join(root, ".wb-bridge", "tasks", receipt.taskId);
	const receiptPath = path.join(taskDir, "receipt.json");

	const content = JSON.stringify(receipt, null, 2);
	try {
		await atomicWriteFile(taskDir, receiptPath, content);
	} catch (err: unknown) {
		throw storageFailure(receipt.taskId, "receipt write", err);
	}
}

/**
 * Releases the single-task mutual exclusion lock if and only if the lock belongs
 * to this process and the stored taskId matches the caller's taskId.
 *
 * Missing locks, mismatches and locks owned by another process are safe no-ops.
 * A lock that cannot be read or removed raises `WB_STORAGE_ERROR` rather than
 * reporting a release that never happened.
 */
export async function releaseTask(projectRoot: string, taskId: string): Promise<void> {
	const held = await readTaskLock(projectRoot);
	if (held === null) {
		return;
	}
	// A lock belonging to another process or another task is never removed: doing
	// so would free a slot whose owner is still using it.
	if (held.taskId !== taskId || held.ownerPid !== process.pid) {
		return;
	}

	let root: string;
	try {
		root = await realpath(projectRoot);
	} catch (err: unknown) {
		throw storageFailure(taskId, "project root resolution before release", err);
	}
	try {
		await unlink(path.join(root, ".wb-bridge", "active.lock"));
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return;
		}
		throw storageFailure(taskId, "lock release", err);
	}
}

/**
 * Prepares task storage, input snapshots, instruction brief, and receipt.
 * Holds the single-task mutual-exclusion lock for the task's execution lifecycle.
 */
export async function prepareTask(
	binding: Binding,
	request: TaskRequest,
	confirmation: RoundConfirmation
): Promise<PreparedTask> {
	if (typeof request.goal !== "object" || request.goal === null) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "Task goal must be an object");
	}
	if (typeof request.goal.objective !== "string" || request.goal.objective.trim().length === 0) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "Task objective must be a non-empty string");
	}
	if (
		!Array.isArray(request.goal.acceptance) ||
		request.goal.acceptance.length === 0 ||
		request.goal.acceptance.some((a) => typeof a !== "string" || a.trim().length === 0)
	) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "Task goal must have at least one non-empty acceptance criterion");
	}

	const root = await realpath(binding.projectRoot);

	if (confirmation.sessionId !== binding.sessionId) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Confirmation session ID "${confirmation.sessionId}" does not match bound session "${binding.sessionId}"`
		);
	}

	let isSupplementary = false;
	let existingReceipt: TaskReceipt | null = null;
	let taskId = "";
	let roundNumber = 1;

	if (request.taskId !== undefined) {
		if (!UUID_PATTERN.test(request.taskId)) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Supplied taskId "${request.taskId}" must be a valid UUID`
			);
		}
		taskId = request.taskId;

		existingReceipt = await readTask(root, taskId);
		const current = currentRound(existingReceipt);

		if (current.status === "running" || current.status === "awaiting_approval") {
			throw new WbTaskError(
				WB_ERROR_CODE.busy,
				`Task ${taskId} is currently ${current.status}; supplementary work requires a terminal state`
			);
		}

		if (confirmation.previousRound !== existingReceipt.rounds.length) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Confirmation previous round (${confirmation.previousRound}) does not match existing rounds count (${existingReceipt.rounds.length})`
			);
		}

		isSupplementary = true;
		roundNumber = existingReceipt.rounds.length + 1;
	} else {
		if (confirmation.previousRound !== 0) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`New task confirmation previous round must be 0, got ${confirmation.previousRound}`
			);
		}
		taskId = crypto.randomUUID();
		roundNumber = 1;
	}

	// 1. Resolve and validate inputFiles
	const validatedInputs: string[] = [];
	if (request.inputFiles && request.inputFiles.length > 0) {
		const seenInputs = new Set<string>();
		for (const rawInput of request.inputFiles) {
			if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file path must be a non-empty string, got: "${String(rawInput)}"`
				);
			}

			if (
				path.isAbsolute(rawInput) ||
				rawInput.startsWith("/") ||
				rawInput.startsWith("\\") ||
				/^[a-zA-Z]:/.test(rawInput)
			) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file path must be relative: "${rawInput}"`
				);
			}

			const segments = rawInput.split(/[/\\]/);
			if (segments.some((seg) => seg === "..")) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file path contains '..' traversal: "${rawInput}"`
				);
			}

			const resolvedInput = path.resolve(root, rawInput);

			let st;
			try {
				st = await stat(resolvedInput);
			} catch {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file does not exist: "${rawInput}"`
				);
			}

			if (!st.isFile()) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file is not a regular file: "${rawInput}"`
				);
			}

			let targetReal: string;
			try {
				targetReal = await realpath(resolvedInput);
			} catch {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file realpath resolution failed: "${rawInput}"`
				);
			}

			// Reject files or symlinks resolving outside the project root boundary.
			const relFromRoot = path.relative(root, targetReal);
			if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file resolves outside project root: "${rawInput}"`
				);
			}

			const normalized = path.normalize(rawInput).split(path.sep).join("/");
			if (!seenInputs.has(normalized)) {
				seenInputs.add(normalized);
				validatedInputs.push(normalized);
			}
		}
	}

	// 2. Validate expectedOutputs
	const paths = resolveRoundPaths(root, taskId, roundNumber, "round");
	const validatedOutputs: string[] = [];
	if (request.expectedOutputs && request.expectedOutputs.length > 0) {
		const seenOutputs = new Set<string>();
		for (const rawOut of request.expectedOutputs) {
			if (typeof rawOut !== "string" || rawOut.trim().length === 0) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Expected output path must be a non-empty string, got: "${String(rawOut)}"`
				);
			}

			if (
				path.isAbsolute(rawOut) ||
				rawOut.startsWith("/") ||
				rawOut.startsWith("\\") ||
				/^[a-zA-Z]:/.test(rawOut)
			) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Expected output path must be relative to outputs directory: "${rawOut}"`
				);
			}

			const segments = rawOut.split(/[/\\]/);
			if (segments.some((seg) => seg === "..")) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Expected output path contains '..' traversal: "${rawOut}"`
				);
			}

			const resolvedOut = path.resolve(paths.outputsDir, rawOut);
			const relFromOutputs = path.relative(paths.outputsDir, resolvedOut);
			if (relFromOutputs.startsWith("..") || path.isAbsolute(relFromOutputs) || relFromOutputs === "") {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Expected output path escapes outputs directory: "${rawOut}"`
				);
			}

			const normalized = path.normalize(rawOut).split(path.sep).join("/");
			if (!seenOutputs.has(normalized)) {
				seenOutputs.add(normalized);
				validatedOutputs.push(normalized);
			}
		}
	}

	// 3. Acquire exclusive single-task lock
	await acquireLock(root, taskId);

	try {
		// Re-check status under the lock to prevent concurrency races.
		if (isSupplementary && existingReceipt !== null) {
			const latestReceipt = await readTask(root, taskId);
			const latestCurrent = currentRound(latestReceipt);
			if (latestCurrent.status === "running" || latestCurrent.status === "awaiting_approval") {
				throw new WbTaskError(
					WB_ERROR_CODE.busy,
					`Task ${taskId} transitioned to ${latestCurrent.status} concurrently`
				);
			}
			if (latestReceipt.rounds.length !== confirmation.previousRound) {
				throw new WbTaskError(
					WB_ERROR_CODE.taskStateInvalid,
					`Task ${taskId} round count changed concurrently`
				);
			}
			existingReceipt = latestReceipt;
		}

		// 4. Create round directories and copy input files
		await mkdir(paths.roundDir, { recursive: true });
		await mkdir(paths.inputsDir, { recursive: true });
		await mkdir(paths.outputsDir, { recursive: true });

		const roundInputs: InputSnapshot[] = [];
		for (const inputRel of validatedInputs) {
			const sourceFile = path.resolve(root, inputRel);
			const targetFile = path.join(paths.inputsDir, path.normalize(inputRel));
			await mkdir(path.dirname(targetFile), { recursive: true });
			await copyFile(sourceFile, targetFile);
			const fileHash = await computeFileSha256(targetFile);
			roundInputs.push({
				path: inputRel,
				sha256: fileHash,
			});
		}

		// Verify stream hashes against confirmation.inputs
		if (confirmation.inputs.length !== roundInputs.length) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input snapshot count (${roundInputs.length}) does not match confirmed inputs count (${confirmation.inputs.length})`
			);
		}
		for (let i = 0; i < roundInputs.length; i++) {
			const preparedInput = roundInputs[i];
			const confirmedInput = confirmation.inputs[i];
			if (!preparedInput || !confirmedInput) {
				throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "Input confirmation index out of bounds");
			}
			if (preparedInput.path !== confirmedInput.path || preparedInput.sha256 !== confirmedInput.sha256) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Input file "${preparedInput.path}" changed during preparation (expected SHA-256 ${confirmedInput.sha256}, got ${preparedInput.sha256})`
				);
			}
		}

		// 5. Construct and write brief.md
		const briefContent = renderTaskPrompt(request.goal, {
			taskId,
			round: roundNumber,
			inputsDir: paths.inputsDir,
			outputsDir: paths.outputsDir,
			inputFiles: roundInputs,
			expectedOutputs: validatedOutputs,
		});

		await writeFile(paths.briefPath, briefContent, "utf-8");

		// 6. Record receipt.json
		const newRound: TaskRound = {
			number: roundNumber,
			layout: "round",
			goal: request.goal,
			inputFiles: roundInputs,
			expectedOutputs: validatedOutputs,
			status: "running",
			summary: "",
			error: null,
			artifacts: [],
			consent: {
				source: confirmation.source,
				at: confirmation.at,
			},
		};

		const receipt: TaskReceipt =
			isSupplementary && existingReceipt !== null
				? {
						...existingReceipt,
						version: 2,
						rounds: [...existingReceipt.rounds, newRound],
					}
				: {
						version: 2,
						taskId,
						sessionId: binding.sessionId,
						projectRoot: root,
						rounds: [newRound],
					};

		await writeTask(receipt);

		return {
			receipt,
			round: roundNumber,
			briefPath: path.resolve(paths.briefPath),
			outputsDir: path.resolve(paths.outputsDir),
		};
	} catch (err) {
		try {
			await releaseTask(root, taskId);
		} catch (releaseErr: unknown) {
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Task preparation failed (${err instanceof Error ? err.message : String(err)}) and rolling back task ${taskId} also failed (${
					releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
				}); its lock was kept`
			);
		}
		throw err;
	}
}

/**
 * Collects deliverables from a task's outputs directory.
 * Discovers real regular files recursively, verifies they remain within outputs/,
 * and computes any missing outputs against the expected manifest.
 */
export async function collectArtifacts(
	receipt: TaskReceipt
): Promise<{ artifacts: FileArtifact[]; missingOutputs: string[] }> {
	const root = await realpath(receipt.projectRoot);
	const current = currentRound(receipt);
	const paths = resolveRoundPaths(root, receipt.taskId, current.number, current.layout);
	const taskOutputsDir = paths.outputsDir;

	let outputsReal: string;
	try {
		outputsReal = await realpath(taskOutputsDir);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return {
				artifacts: [],
				missingOutputs: [...current.expectedOutputs],
			};
		}
		throw err;
	}

	const artifacts: FileArtifact[] = [];

	async function scanDirectory(currentDir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				try {
					const dirReal = await realpath(fullPath);
					const rel = path.relative(outputsReal, dirReal);
					if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "") {
						await scanDirectory(fullPath);
					}
				} catch {
					// Ignore unresolvable directories or symlink loops.
				}
			} else if (entry.isFile()) {
				try {
					const fileReal = await realpath(fullPath);
					const rel = path.relative(outputsReal, fileReal);
					if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "") {
						const normalizedRel = rel.split(path.sep).join("/");
						const isFinal = current.expectedOutputs.includes(normalizedRel);
						const st = await stat(fileReal);
						const fileHash = await computeFileSha256(fileReal);
						artifacts.push({
							kind: "file",
							path: path.resolve(fullPath),
							sha256: fileHash,
							bytes: st.size,
							role: isFinal ? "final" : "supporting",
							provenance: "native",
							importedFrom: null,
						});
					}
				} catch {
					// Ignore broken links or unreadable entries.
				}
			}
		}
	}

	await scanDirectory(taskOutputsDir);
	artifacts.sort((a, b) => a.path.localeCompare(b.path));

	const missingOutputs: string[] = [];
	for (const expected of current.expectedOutputs) {
		const expectedPath = path.resolve(taskOutputsDir, expected);
		let exists = false;
		try {
			const fileReal = await realpath(expectedPath);
			const st = await stat(fileReal);
			if (st.isFile()) {
				const rel = path.relative(outputsReal, fileReal);
				if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "") {
					exists = true;
				}
			}
		} catch {
			exists = false;
		}

		if (!exists) {
			missingOutputs.push(expected);
		}
	}

	return {
		artifacts,
		missingOutputs,
	};
}

// ---------------------------------------------------------------------------
// Frozen staging: the manifest that a confirmed round is executed against.
// ---------------------------------------------------------------------------

/**
 * Normalizes a project-relative path for manifests and stage snapshots.
 *
 * Project-relative paths inside frozen manifests and stage snapshots must
 * never traverse outside the project root or use drive letters / absolute paths,
 * so that relative resolution always stays contained within the project and
 * produces identical path keys across platforms.
 *
 * @throws WbTaskError `WB_ERROR_CODE.inputInvalid` if path is absolute, has drive
 *   letters, or contains '..' traversal segments.
 */
export function canonicalRelPath(raw: string): string {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Scope path must be a non-empty string, got: "${String(raw)}"`
		);
	}

	if (
		path.isAbsolute(raw) ||
		/^[a-zA-Z]:/.test(raw) ||
		raw.startsWith("/") ||
		raw.startsWith("\\")
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Scope path must be relative: "${raw}"`
		);
	}

	const rawSegments = raw.split(/[/\\]/);
	if (rawSegments.some((seg) => seg === "..")) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Scope path contains '..' traversal: "${raw}"`
		);
	}

	const normalized = path.normalize(raw).split(path.sep).join("/");
	const normSegments = normalized.split("/");
	if (normSegments.some((seg) => seg === "..")) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Scope path contains '..' traversal: "${raw}"`
		);
	}

	const cleaned = normalized.replace(/\/+$/, "");
	if (cleaned === "" || cleaned === ".") {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Scope path cannot target the entire project root: "${raw}"`
		);
	}

	return cleaned;
}

/**
 * Validates one expected-output path relative to a round's outputs directory.
 *
 * Rejects non-string/empty inputs, absolute paths, drive letters, '..' segments,
 * and escapes from the target outputs directory so that tasks cannot declare
 * outputs that overwrite project files or escape staging boundaries.
 */
export function validateOutputPath(rawOut: string, outputsDir: string): string {
	if (typeof rawOut !== "string" || rawOut.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Expected output path must be a non-empty string, got: "${String(rawOut)}"`
		);
	}

	if (
		path.isAbsolute(rawOut) ||
		rawOut.startsWith("/") ||
		rawOut.startsWith("\\") ||
		/^[a-zA-Z]:/.test(rawOut)
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Expected output path must be relative to outputs directory: "${rawOut}"`
		);
	}

	const segments = rawOut.split(/[/\\]/);
	if (segments.some((seg) => seg === "..")) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Expected output path contains '..' traversal: "${rawOut}"`
		);
	}

	const resolvedOut = path.resolve(outputsDir, rawOut);
	const relFromOutputs = path.relative(outputsDir, resolvedOut);
	if (relFromOutputs.startsWith("..") || path.isAbsolute(relFromOutputs) || relFromOutputs === "") {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Expected output path escapes outputs directory: "${rawOut}"`
		);
	}

	return path.normalize(rawOut).split(path.sep).join("/");
}

/**
 * Validates and normalizes an optional list of expected outputs against the outputs directory.
 * Dedupes preserving first-occurrence order, returning an empty array when none are given.
 */
export function validatedOutputPaths(expectedOutputs: string[] | undefined, outputsDir: string): string[] {
	if (!expectedOutputs || expectedOutputs.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const validated: string[] = [];
	for (const rawOut of expectedOutputs) {
		const normalized = validateOutputPath(rawOut, outputsDir);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			validated.push(normalized);
		}
	}
	return validated;
}

/**
 * Canonical JSON serialization used to compute deterministic manifest digests.
 *
 * Object keys are sorted recursively (lexicographically by UTF-16 code units),
 * array elements preserve their exact order, undefined object values are omitted,
 * and no whitespace is emitted.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
	}
	const entries = Object.entries(value).filter(([, v]) => v !== undefined);
	entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const serializedEntries = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
	return `{${serializedEntries.join(",")}}`;
}

/**
 * Builds a deterministic manifest payload for a task round.
 *
 * Pure function with no filesystem I/O.
 * Invariants:
 * 1. `expectedOutputs` is shallow-copied.
 * 2. `inputs` is shallow-copied and sorted by `path` ascending BEFORE hashing.
 *    This sort order establishes the digest invariant so every caller (confirmation
 *    dialog, staging, and queue verification) hashes the exact same sequence.
 */
export function buildTaskManifestPayload(input: {
	projectRoot: string;
	requestId: string;
	taskId: string;
	round: number;
	owner: OwnerIdentity;
	goal: TaskGoal;
	targetPolicy: TargetPolicy;
	expectedOutputs: string[];
	inputs: ManifestInput[];
	deliveryMode: DeliveryMode;
}): TaskManifestPayload {
	const sortedInputs = [...input.inputs]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((item) => ({ ...item }));

	return {
		version: 1,
		projectRoot: input.projectRoot,
		requestId: input.requestId,
		taskId: input.taskId,
		round: input.round,
		owner: input.owner,
		goal: input.goal,
		targetPolicy: input.targetPolicy,
		expectedOutputs: [...input.expectedOutputs],
		inputs: sortedInputs,
		deliveryMode: input.deliveryMode,
	};
}

/**
 * Computes the canonical SHA-256 digest of a task manifest payload.
 *
 * Only the payload is hashed; the approval block and the digest itself are
 * excluded so nothing self-references.
 */
export function hashManifestPayload(payload: TaskManifestPayload): string {
	return crypto.createHash("sha256").update(canonicalJson(payload), "utf-8").digest("hex");
}

/**
 * Stages frozen input snapshots and writes the manifest for a confirmed round.
 *
 * Staging guarantees:
 * 1. The stage UUID and physical directory path are deliberately excluded from
 *    the payload digest, making the digest pure and portable across hosts.
 * 2. The snapshot root is the directory CONTAINING `inputs/`; every input file
 *    is placed in `inputs/<project-relative-path>`.
 * 3. Concurrent or retried stagings of the same request never overwrite an existing
 *    stage directory because each invocation allocates a fresh random stage UUID.
 * 4. Staged copies are verified against their confirmed sha256 digests and source
 *    file sizes/mtimes before and after copying to ensure inputs did not mutate mid-flight.
 *
 * @param root The project root directory.
 * @param confirmation Human confirmation with expected payload hash and inputs.
 * @param request The task request carrying goal, inputs, and expected outputs.
 * @param taskId Unique task UUID.
 * @param round Round number for this task execution.
 * @returns The staged task details including paths, payload, and approval record.
 */
export async function stageTask(
	root: string,
	confirmation: RoundConfirmationV3,
	request: TaskRequest,
	taskId: string,
	round: number
): Promise<StagedTask> {
	// 1. Validate confirmation.requestId, taskId and targetPolicy kind
	if (!UUID_PATTERN.test(confirmation.requestId)) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Supplied requestId "${confirmation.requestId}" must be a valid UUID`
		);
	}
	if (!UUID_PATTERN.test(taskId)) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Supplied taskId "${taskId}" must be a valid UUID`
		);
	}
	if (
		!confirmation.targetPolicy ||
		(confirmation.targetPolicy.kind !== "session" && confirmation.targetPolicy.kind !== "workspace_pool")
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Target policy kind must be "session" or "workspace_pool"`
		);
	}

	// 2. Canonicalize project root once; every digest and boundary check uses this real root.
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(root);
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Project root does not exist or cannot be resolved: "${root}"`
		);
	}

	// 3. Cross-check request.inputFiles against confirmation.inputs BY PATH (both directions)
	const requestInputPaths = new Set<string>();
	for (const rawPath of request.inputFiles ?? []) {
		const rel = canonicalRelPath(rawPath);
		requestInputPaths.add(rel);
	}

	const confirmedInputPaths = new Set<string>();
	const confirmedByPath = new Map<string, { path: string; sha256: string }>();
	for (const input of confirmation.inputs) {
		const rel = canonicalRelPath(input.path);
		confirmedInputPaths.add(rel);
		confirmedByPath.set(rel, { path: rel, sha256: input.sha256 });
	}

	for (const p of requestInputPaths) {
		if (!confirmedInputPaths.has(p)) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Requested input file "${p}" is not part of the confirmed manifest`
			);
		}
	}

	for (const p of confirmedInputPaths) {
		if (!requestInputPaths.has(p)) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Confirmed input file "${p}" is missing from the request`
			);
		}
	}

	// 4. Build confirmedByPath map, sort keys, stat source, realpath, and check boundary
	const sortedPaths = [...confirmedByPath.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	interface VerifiedSource {
		relPath: string;
		absoluteSource: string;
		confirmedSha: string;
		size: number;
		mtimeMs: number;
	}
	const verifiedSources: VerifiedSource[] = [];

	for (const relPath of sortedPaths) {
		const confirmed = confirmedByPath.get(relPath);
		if (confirmed === undefined) {
			continue;
		}
		const absoluteSource = path.resolve(canonicalRoot, relPath);
		let st;
		try {
			st = await stat(absoluteSource);
		} catch {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file does not exist: "${relPath}"`
			);
		}
		if (!st.isFile()) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file is not a regular file: "${relPath}"`
			);
		}

		let sourceReal: string;
		try {
			sourceReal = await realpath(absoluteSource);
		} catch {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file realpath resolution failed: "${relPath}"`
			);
		}

		const relFromRoot = path.relative(canonicalRoot, sourceReal);
		if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file resolves outside project root: "${relPath}"`
			);
		}

		verifiedSources.push({
			relPath,
			absoluteSource,
			confirmedSha: confirmed.sha256,
			size: st.size,
			mtimeMs: st.mtimeMs,
		});
	}

	// 5. Build payload via buildTaskManifestPayload with validatedOutputPaths
	const outputsDir = resolveRoundPaths(canonicalRoot, taskId, round, "round").outputsDir;
	const expectedOutputs = validatedOutputPaths(request.expectedOutputs, outputsDir);

	const initialManifestInputs: ManifestInput[] = verifiedSources.map((s) => ({
		path: s.relPath,
 		snapshotPath: `inputs/${s.relPath}`,
		bytes: s.size,
		sha256: s.confirmedSha,
	}));

	const payload = buildTaskManifestPayload({
		projectRoot: canonicalRoot,
		requestId: confirmation.requestId,
		taskId,
		round,
		owner: confirmation.owner,
		goal: request.goal,
		targetPolicy: confirmation.targetPolicy,
		expectedOutputs,
		inputs: initialManifestInputs,
		deliveryMode: confirmation.deliveryMode,
	});

	// 6. Check payloadSha256 against confirmation.manifestSha256
	const payloadSha256 = hashManifestPayload(payload);
	if (payloadSha256 !== confirmation.manifestSha256) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Manifest payload digest (${payloadSha256}) does not match confirmed digest (${confirmation.manifestSha256}): inputs may have changed between confirmation and staging`
		);
	}

	// 7. Create stage dir with inputs/ subdir, copy files, re-stat before and after, hash copy
	const stageUuid = crypto.randomUUID();
	const snapshotRoot = path.join(canonicalRoot, ".wb-bridge", "requests", confirmation.requestId, "stages", stageUuid);
	const stageInputsDir = path.join(snapshotRoot, "inputs");
	await mkdir(stageInputsDir, { recursive: true });

	const stagedInputs: ManifestInput[] = [];
	for (const source of verifiedSources) {
		const preStat = await stat(source.absoluteSource);
		if (preStat.size !== source.size || preStat.mtimeMs !== source.mtimeMs) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file "${source.relPath}" changed while being staged (pre-copy stat mismatch)`
			);
		}

		const targetFile = path.join(stageInputsDir, path.normalize(source.relPath));
		await mkdir(path.dirname(targetFile), { recursive: true });
		await copyFile(source.absoluteSource, targetFile);

		const postStat = await stat(source.absoluteSource);
		if (postStat.size !== source.size || postStat.mtimeMs !== source.mtimeMs) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Input file "${source.relPath}" changed while being staged (post-copy stat mismatch)`
			);
		}

		const copySha = await computeFileSha256(targetFile);
		if (copySha !== source.confirmedSha) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Staged copy of "${source.relPath}" does not match the confirmed hash (got ${copySha}, expected ${source.confirmedSha})`
			);
		}

		stagedInputs.push({
			path: source.relPath,
			snapshotPath: `inputs/${source.relPath}`,
			bytes: postStat.size,
			sha256: copySha,
		});
	}

	// 8. Write manifest.json via atomicWriteFile
	const manifestPath = path.join(snapshotRoot, "manifest.json");
	const approval: ManifestApproval = {
		source: confirmation.source,
		at: confirmation.at,
		payloadSha256,
	};
	const finalPayload: TaskManifestPayload = {
		...payload,
		inputs: stagedInputs,
	};
	const manifestContent = JSON.stringify(
		{
			payload: finalPayload,
			approval,
		},
		null,
		2
	);
	// Self-check before publishing: the bytes about to be written must hash to
	// the same digest the caller confirmed, or enqueue would later reject the
	// manifest as tampered. This is an internal invariant, not user input.
	if (hashManifestPayload(finalPayload) !== payloadSha256) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Staged manifest inputs diverged from the confirmed payload digest`
		);
	}
	await atomicWriteFile(snapshotRoot, manifestPath, manifestContent);

	// 9. Return StagedTask
	return {
		snapshotRoot,
		manifestPath,
		manifestSha256: payloadSha256,
		manifest: {
			payload: finalPayload,
			approval,
		},
	};
}

// ---------------------------------------------------------------------------
// Deterministic identifiers
//
// Collision-free ids derived from stable inputs (task id + round) rather than
// random UUIDs, so the same logical round always maps to the same record.
// RFC 4122 UUIDv5 in the DNS namespace, matching the legacy receipt importer.
// ---------------------------------------------------------------------------

/** The UUIDv5 DNS namespace; fixed by RFC 4122. */
export const UUID5_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Renders a UUIDv5 over `name` in the DNS namespace. */
export function uuid5(name: string): string {
	const namespace = uuidStringToBytes(UUID5_DNS_NAMESPACE);
	const bytes = new Uint8Array(16 + name.length);
	bytes.set(namespace, 0);
	for (let i = 0; i < name.length; i++) {
		bytes[16 + i] = name.charCodeAt(i) & 0xff;
	}
	const digest = new Uint8Array(crypto.createHash("sha1").update(bytes).digest());
	// Version 5 and RFC 4122 variant bits.
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidStringToBytes(uuid: string): Uint8Array {
	const hex = uuid.replace(/-/g, "");
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * The work id for one delegated round.
 *
 * The collaboration layer validates `workId` as a UUID, so the queue and the
 * receipt importer must both derive this same deterministic value rather than
 * composing a `work-<taskId>-<round>` string that cannot be read back.
 */
export function delegatedWorkId(taskId: string, round: number): string {
	return uuid5(`omp-wb-bridge/work/${taskId}/${round}`);
}
