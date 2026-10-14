import {
	copyFile,
	link,
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
import type {
	Binding,
	StoredTaskSummary,
	TaskError,
	TaskListWarning,
	TaskLock,
	TaskReceipt,
	TaskStatus,
} from "./types";
import { taskError, WB_ERROR_CODE } from "./types";

/**
 * Standard UUID format (8-4-4-4-12 hex). Used to validate task IDs before
 * touching the filesystem so arbitrary path traversal via taskId is impossible.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extension error signaling operational or validation failures.
 * Callers branch on the machine-readable `code` property matching `WB_ERROR_CODE`.
 */
export class WbTaskError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WbTaskError";
		this.code = code;
	}
}

/**
 * Writes data to a target path atomically by creating a unique temporary file
 * in the same directory and renaming it into place. This prevents concurrent readers
 * or system crashes from seeing partially written JSON files.
 */
async function atomicWriteFile(directory: string, targetPath: string, content: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const tempPath = path.join(directory, `.tmp-${crypto.randomUUID()}`);
	try {
		await writeFile(tempPath, content, "utf-8");
		await rename(tempPath, targetPath);
	} catch (err: unknown) {
		// Clean up the partial temporary file on failure so no stale files linger.
		try {
			await unlink(tempPath);
		} catch {
			// Ignore errors if the temp file was never written or already removed.
		}
		throw err;
	}
}

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

	if (!("version" in raw) || raw.version !== 1) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Malformed binding file at ${source}: expected version 1, got ${String("version" in raw ? raw.version : "missing")}`
		);
	}

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

	return {
		version: 1,
		projectRoot: raw.projectRoot,
		sessionId: raw.sessionId,
		workbuddyVersion: raw.workbuddyVersion,
	};
}

/**
 * Validates the in-memory or deserialized object shape of a TaskReceipt.
 * Throws WB_TASK_STATE_INVALID if any structural requirements are missing or corrupted.
 */
function validateReceiptObject(raw: unknown, source: string): TaskReceipt {
	if (typeof raw !== "object" || raw === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: root must be a JSON object`
		);
	}

	if (!("version" in raw) || raw.version !== 1) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: expected version 1`
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

	if (!("status" in raw) || typeof raw.status !== "string") {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: status must be a string`
		);
	}

	let status: TaskStatus;
	switch (raw.status) {
		case "running":
		case "awaiting_approval":
		case "completed":
		case "failed":
		case "cancelled":
		case "interrupted":
			status = raw.status;
			break;
		default:
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: unknown status "${String(raw.status)}"`
			);
	}

	if (!("prompt" in raw) || typeof raw.prompt !== "string") {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: prompt must be a string`
		);
	}

	if (!("inputFiles" in raw) || !Array.isArray(raw.inputFiles)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: inputFiles must be an array of strings`
		);
	}
	for (const item of raw.inputFiles) {
		if (typeof item !== "string") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: inputFiles elements must be strings`
			);
		}
	}

	if (!("expectedOutputs" in raw) || !Array.isArray(raw.expectedOutputs)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: expectedOutputs must be an array of strings`
		);
	}
	for (const item of raw.expectedOutputs) {
		if (typeof item !== "string") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: expectedOutputs elements must be strings`
			);
		}
	}

	if (!("summary" in raw) || typeof raw.summary !== "string") {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: summary must be a string`
		);
	}

	if (!("artifacts" in raw) || !Array.isArray(raw.artifacts)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: artifacts must be an array of strings`
		);
	}
	for (const item of raw.artifacts) {
		if (typeof item !== "string") {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: artifacts elements must be strings`
			);
		}
	}

	if (!("error" in raw)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed task receipt at ${source}: missing error field`
		);
	}

	let parsedError: TaskError | null = null;
	if (raw.error !== null) {
		if (
			typeof raw.error !== "object" ||
			!("code" in raw.error) ||
			typeof raw.error.code !== "string" ||
			!("message" in raw.error) ||
			typeof raw.error.message !== "string"
		) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Malformed task receipt at ${source}: error must be null or an object with string code and message`
			);
		}
		parsedError = {
			code: raw.error.code,
			message: raw.error.message,
		};
	}

	return {
		version: 1,
		taskId: raw.taskId,
		sessionId: raw.sessionId,
		projectRoot: raw.projectRoot,
		status,
		prompt: raw.prompt,
		inputFiles: [...raw.inputFiles],
		expectedOutputs: [...raw.expectedOutputs],
		summary: raw.summary,
		artifacts: [...raw.artifacts],
		error: parsedError,
	};
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
 * @returns The lock record, or null when the project or the lock is absent.
 * @throws WbTaskError `WB_TASK_STATE_INVALID` when the lock is present but not a
 *   real, well-formed lock file and `WB_STORAGE_ERROR` when it cannot be read.
 */
export async function readTaskLock(projectRoot: string): Promise<TaskLock | null> {
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

	const lockPath = path.join(root, ".wb-bridge", "active.lock");

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
		// The claim is written to a private file first and then linked into place.
		// `link` either creates the lock with its complete contents or fails with
		// EEXIST, so a contender can never observe a half-written lock and cannot
		// mistake another process's in-progress claim for a corrupt file.
		const stagingPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.claim`;
		let claimed = false;
		try {
			await writeFile(
				stagingPath,
				JSON.stringify({ ownerPid: process.pid, taskId, acquiredAt: Date.now() }, null, 2),
				"utf-8"
			);
			await link(stagingPath, lockPath);
			claimed = true;
		} catch (err: unknown) {
			if (!(typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST")) {
				throw err;
			}
		} finally {
			await unlink(stagingPath).catch(() => undefined);
		}

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
		if (orphan !== null && (orphan.status === "running" || orphan.status === "awaiting_approval")) {
			orphan.status = "interrupted";
			orphan.error = taskError(
				WB_ERROR_CODE.interrupted,
				`Owner process ${ownerPid} is no longer running`
			);
			try {
				await writeTask(orphan);
			} catch (err: unknown) {
				throw storageFailure(staleTaskId, "orphan receipt commit, so the lock was kept", err);
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
			version: 1,
			projectRoot: root,
			sessionId: binding.sessionId,
			workbuddyVersion: binding.workbuddyVersion,
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

			entries.push({
				taskId: receipt.taskId,
				sessionId: receipt.sessionId,
				status: receipt.status,
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
	request: {
		prompt: string;
		inputFiles?: string[];
		expectedOutputs?: string[];
		taskId?: string;
	}
): Promise<{ receipt: TaskReceipt; briefPath: string; outputsDir: string }> {
	if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			"Task prompt must be a non-empty string"
		);
	}

	const root = await realpath(binding.projectRoot);

	let isSupplementary = false;
	let existingReceipt: TaskReceipt | null = null;
	let taskId = "";

	if (request.taskId !== undefined) {
		if (!UUID_PATTERN.test(request.taskId)) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Supplied taskId "${request.taskId}" must be a valid UUID`
			);
		}
		taskId = request.taskId;

		existingReceipt = await readTask(root, taskId);

		if (existingReceipt.status === "running" || existingReceipt.status === "awaiting_approval") {
			throw new WbTaskError(
				WB_ERROR_CODE.busy,
				`Task ${taskId} is currently ${existingReceipt.status}; supplementary work requires a terminal state`
			);
		}
		isSupplementary = true;
	} else {
		taskId = crypto.randomUUID();
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
	const taskDir = path.join(root, ".wb-bridge", "tasks", taskId);
	const outputsDir = path.join(taskDir, "outputs");
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

			const resolvedOut = path.resolve(outputsDir, rawOut);
			const relFromOutputs = path.relative(outputsDir, resolvedOut);
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
			if (latestReceipt.status === "running" || latestReceipt.status === "awaiting_approval") {
				throw new WbTaskError(
					WB_ERROR_CODE.busy,
					`Task ${taskId} transitioned to ${latestReceipt.status} concurrently`
				);
			}
			existingReceipt = latestReceipt;
		}

		// 4. Create task directories and copy input files
		const inputsDir = path.join(taskDir, "inputs");
		await mkdir(inputsDir, { recursive: true });
		await mkdir(outputsDir, { recursive: true });

		for (const inputRel of validatedInputs) {
			const sourceFile = path.resolve(root, inputRel);
			const targetFile = path.join(inputsDir, path.normalize(inputRel));
			await mkdir(path.dirname(targetFile), { recursive: true });
			await copyFile(sourceFile, targetFile);
		}

		let finalInputs: string[];
		let finalOutputs: string[];

		if (isSupplementary && existingReceipt !== null) {
			const inputSet = new Set<string>(existingReceipt.inputFiles);
			finalInputs = [...existingReceipt.inputFiles];
			for (const inp of validatedInputs) {
				if (!inputSet.has(inp)) {
					inputSet.add(inp);
					finalInputs.push(inp);
				}
			}

			const outputSet = new Set<string>(existingReceipt.expectedOutputs);
			finalOutputs = [...existingReceipt.expectedOutputs];
			for (const out of validatedOutputs) {
				if (!outputSet.has(out)) {
					outputSet.add(out);
					finalOutputs.push(out);
				}
			}
		} else {
			finalInputs = validatedInputs;
			finalOutputs = validatedOutputs;
		}

		// 5. Construct and write brief.md
		let inputsSection = "None provided (pure consultation task).";
		if (finalInputs.length > 0) {
			const lines: string[] = [];
			for (const rel of finalInputs) {
				const abs = path.resolve(inputsDir, path.normalize(rel));
				lines.push(`- \`${rel}\`: \`${abs}\``);
			}
			inputsSection = lines.join("\n");
		}

		let outputsSection = "No file deliverables expected (pure consultation task).";
		if (finalOutputs.length > 0) {
			const lines: string[] = [];
			for (const out of finalOutputs) {
				const expectedDest = path.join(outputsDir, out);
				lines.push(`- \`${out}\`: Acceptance condition: File must be created in \`${expectedDest}\` and contain the complete deliverable.`);
			}
			outputsSection = lines.join("\n");
		}

		const briefPath = path.join(taskDir, "brief.md");
		const briefContent = `# Task Brief

## Objective
${request.prompt}

## Input Snapshots
${inputsSection}

## Expected Deliverables and Acceptance Conditions
${outputsSection}

## Execution Guidelines
- WorkBuddy must utilize its native skills and plugins to carry out this task.
- Deliverables must be written ONLY into this task's outputs directory:
  \`${outputsDir}\`
- The final response must list the real produced artifacts and their filenames.

## Prohibitions and Safety Boundaries
- Do NOT call back into OMP.
- Do NOT modify project source files.
- Do NOT publish, send, or transmit anything externally.
- Do NOT self-approve permissions.
- This boundary is an explicit division of labour between orchestrator and specialized agent, not an operating system security sandbox.
`;
		await writeFile(briefPath, briefContent, "utf-8");

		// 6. Record receipt.json
		const receipt: TaskReceipt = {
			version: 1,
			taskId,
			sessionId: binding.sessionId,
			projectRoot: root,
			status: "running",
			prompt: request.prompt,
			inputFiles: finalInputs,
			expectedOutputs: finalOutputs,
			summary: "",
			artifacts: isSupplementary && existingReceipt !== null ? existingReceipt.artifacts : [],
			error: null,
		};
		await writeTask(receipt);

		return {
			receipt,
			briefPath: path.resolve(briefPath),
			outputsDir: path.resolve(outputsDir),
		};
	} catch (err) {
		// The task never reached the caller, so its slot must be freed. When that
		// rollback itself fails, both stages are reported and the lock is left in
		// place: silently keeping a lock whose slot is occupied would block every
		// later delegation with no explanation.
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
): Promise<{ artifacts: string[]; missingOutputs: string[] }> {
	const root = await realpath(receipt.projectRoot);
	const taskOutputsDir = path.join(root, ".wb-bridge", "tasks", receipt.taskId, "outputs");

	let outputsReal: string;
	try {
		outputsReal = await realpath(taskOutputsDir);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return {
				artifacts: [],
				missingOutputs: [...receipt.expectedOutputs],
			};
		}
		throw err;
	}

	const artifacts: string[] = [];

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
						artifacts.push(path.resolve(fullPath));
					}
				} catch {
					// Ignore broken links or unreadable entries.
				}
			}
		}
	}

	await scanDirectory(taskOutputsDir);
	artifacts.sort();

	const missingOutputs: string[] = [];
	for (const expected of receipt.expectedOutputs) {
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
