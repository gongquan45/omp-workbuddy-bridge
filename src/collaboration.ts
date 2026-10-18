import { lstat, mkdir, readdir, readFile, realpath, stat, unlink, copyFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { atomicWriteFile, tryCreateLockFile } from "./storage";
import { isPidAlive, computeFileSha256, WbTaskError } from "./tasks";
import type { FileArtifact, RemoteResult, WorkRecord, WorkReview } from "./types";
import { WB_ERROR_CODE } from "./types";
import { normalizeScopePath, pathsOverlap } from "./scope";
export { normalizeScopePath, pathsOverlap } from "./scope";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ShortLockRecord {
	ownerPid: number;
	lockId: string;
}

export interface ScopeDefinition {
	readPaths: string[];
	writePaths: string[];
}

export interface ClaimWorkRequest {
	workId?: string;
	expectedRevision?: number;
	title: string;
	scope: ScopeDefinition;
	taskId?: string | null;
	round?: number | null;
	nativeRef?: { sessionId: string; goalId: string | null } | null;
}

export interface PublishWorkRequest {
	workId: string;
	expectedRevision: number | null;
	progress?: {
		state: "active" | "blocked";
		phase: string;
		milestone: string;
		blocker: string;
	};
	files?: Array<{
		path: string;
		role: "final" | "supporting";
		importFrom?: string;
	}>;
	remoteResults?: RemoteResult[];
	review?: {
		round: number | null;
		artifacts: Array<{ path: string; sha256: string }>;
		verdict: "accepted" | "changes_requested" | "unverified";
		note: string;
	};
	release?: boolean;
}

export interface ProjectContextQuery {
	workId?: string;
	paths?: string[];
	includeClosed?: boolean;
	offset?: number;
	limit?: number;
}

export interface WorkRecordSummary {
	workId: string;
	owner: "omp" | "workbuddy";
	revision: number | null;
	title: string;
	phase: string;
	scope: {
		readPaths: string[];
		writePaths: string[];
		totalRead: number;
		totalWrite: number;
	} | null;
	state: "waiting" | "active" | "blocked" | "released";
	workerStatus: string | null;
	round: number | null;
	milestone: string;
	blocker: string;
	updatedAt: string;
	artifactCount: number;
	warnings: string[];
}

export interface ProjectContextResult {
	entries: WorkRecordSummary[];
	total: number;
	nextOffset: number | null;
	detail?: {
		record: WorkRecord;
		outputsDir: string | null;
		artifacts: FileArtifact[];
		latestReview: WorkReview | null;
		reviewCount: number;
	};
}

/**
 * Executes an operation inside the short collaboration metadata lock.
 * Lock is acquired at `.wb-bridge/collaboration.lock` and released on completion.
 */
export async function withCollaborationLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
	const bridgeDir = path.join(projectRoot, ".wb-bridge");
	await mkdir(bridgeDir, { recursive: true });
	const lockPath = path.join(bridgeDir, "collaboration.lock");
	const lockId = crypto.randomUUID();
	let acquired = false;

	for (let attempt = 0; attempt < 5; attempt++) {
		const content = JSON.stringify({ ownerPid: process.pid, lockId });
		const claimed = await tryCreateLockFile(lockPath, content);
		if (claimed) {
			acquired = true;
			break;
		}

		let lockContent: string | null = null;
		try {
			lockContent = await readFile(lockPath, "utf-8");
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				continue;
			}
			throw new WbTaskError(WB_ERROR_CODE.storageError, `Cannot read collaboration lock: ${String(err)}`);
		}

		let parsed: unknown = null;
		try {
			parsed = JSON.parse(lockContent);
		} catch {
			throw new WbTaskError(WB_ERROR_CODE.busy, "Collaboration lock is corrupted");
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("ownerPid" in parsed) ||
			typeof parsed.ownerPid !== "number" ||
			!("lockId" in parsed) ||
			typeof parsed.lockId !== "string"
		) {
			throw new WbTaskError(WB_ERROR_CODE.busy, "Collaboration lock shape is invalid");
		}

		if (isPidAlive(parsed.ownerPid)) {
			throw new WbTaskError(
				WB_ERROR_CODE.busy,
				`Collaboration lock held by live process PID ${parsed.ownerPid}`
			);
		}

		// Owner is provably dead; attempt to reap stale lock
		try {
			await unlink(lockPath);
		} catch (err: unknown) {
			if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) {
				throw new WbTaskError(WB_ERROR_CODE.storageError, `Failed to unlink dead collaboration lock: ${String(err)}`);
			}
		}
	}

	if (!acquired) {
		throw new WbTaskError(WB_ERROR_CODE.busy, "Exceeded maximum attempts to acquire collaboration lock");
	}

	try {
		return await action();
	} finally {
		try {
			const currentContent = await readFile(lockPath, "utf-8");
			const parsed = JSON.parse(currentContent) as ShortLockRecord;
			if (parsed.ownerPid === process.pid && parsed.lockId === lockId) {
				await unlink(lockPath);
			}
		} catch {
			// Best effort release
		}
	}
}

/**
 * Validates in-memory or persisted WorkRecord shape.
 */
export function validateWorkRecord(raw: unknown, source: string): WorkRecord {
	if (typeof raw !== "object" || raw === null) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: root must be an object`);
	}
	const r = raw as Record<string, unknown>;
	if (r.version !== 1) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: expected version 1`);
	}
	if (typeof r.workId !== "string" || !UUID_PATTERN.test(r.workId)) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: workId must be a valid UUID`);
	}
	if (typeof r.projectRoot !== "string" || r.projectRoot.trim().length === 0) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: projectRoot must be non-empty`);
	}
	if (r.owner !== "omp" && r.owner !== "workbuddy") {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: owner must be omp or workbuddy`);
	}
	if (r.source !== "native" && r.source !== "delegated") {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: source must be native or delegated`);
	}
	if (
		r.state !== "waiting" &&
		r.state !== "active" &&
		r.state !== "blocked" &&
		r.state !== "released"
	) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Malformed work record at ${source}: state must be waiting, active, blocked, or released`
		);
	}
	if (typeof r.title !== "string") {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: title must be a string`);
	}
	if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 1) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Malformed work record at ${source}: revision must be a positive integer`);
	}

	let scope: { readPaths: string[]; writePaths: string[] } | null = null;
	if (r.scope !== null && typeof r.scope === "object") {
		const s = r.scope as Record<string, unknown>;
		if (Array.isArray(s.readPaths) && Array.isArray(s.writePaths)) {
			scope = {
				readPaths: s.readPaths.map(String),
				writePaths: s.writePaths.map(String),
			};
		}
	}

	const artifacts: FileArtifact[] = [];
	if (Array.isArray(r.artifacts)) {
		for (const art of r.artifacts) {
			if (typeof art === "object" && art !== null && "path" in art && typeof art.path === "string") {
				const a = art as Record<string, unknown>;
				artifacts.push({
					kind: "file",
					path: art.path,
					sha256: typeof a.sha256 === "string" ? a.sha256 : null,
					bytes: typeof a.bytes === "number" ? a.bytes : null,
					role: a.role === "supporting" ? "supporting" : "final",
					provenance: a.provenance === "imported" ? "imported" : a.provenance === "legacy_unverified" ? "legacy_unverified" : "native",
					importedFrom: typeof a.importedFrom === "string" ? a.importedFrom : null,
				});
			}
		}
	}

	const remoteResults: RemoteResult[] = [];
	if (Array.isArray(r.remoteResults)) {
		for (const res of r.remoteResults) {
			if (typeof res === "object" && res !== null) {
				const rr = res as Record<string, unknown>;
				if (
					(rr.kind === "publish" || rr.kind === "deploy" || rr.kind === "cloud_write" || rr.kind === "schedule") &&
					typeof rr.target === "string" &&
					typeof rr.evidence === "string"
				) {
					remoteResults.push({
						kind: rr.kind,
						target: rr.target,
						evidence: rr.evidence,
						verification: "reported",
					});
				}
			}
		}
	}

	const reviews: WorkReview[] = [];
	if (Array.isArray(r.reviews)) {
		for (const rev of r.reviews) {
			if (typeof rev === "object" && rev !== null) {
				const rv = rev as Record<string, unknown>;
				if (
					(rv.reviewer === "omp" || rv.reviewer === "workbuddy") &&
					(rv.verdict === "accepted" || rv.verdict === "changes_requested" || rv.verdict === "unverified") &&
					typeof rv.note === "string" &&
					typeof rv.at === "string" &&
					Array.isArray(rv.artifacts)
				) {
					reviews.push({
						reviewer: rv.reviewer,
						round: typeof rv.round === "number" ? rv.round : null,
						artifacts: rv.artifacts.map((a: { path: unknown; sha256: unknown }) => ({
							path: String(a.path),
							sha256: String(a.sha256),
						})),
						verdict: rv.verdict,
						note: rv.note,
						at: rv.at,
					});
				}
			}
		}
	}

	let nativeRef: { sessionId: string; goalId: string | null } | null = null;
	if (typeof r.nativeRef === "object" && r.nativeRef !== null && "sessionId" in r.nativeRef && typeof r.nativeRef.sessionId === "string") {
		const nr = r.nativeRef as { sessionId: string; goalId?: unknown };
		nativeRef = {
			sessionId: nr.sessionId,
			goalId: typeof nr.goalId === "string" ? nr.goalId : null,
		};
	}

	return {
		version: 1,
		workId: r.workId,
		projectRoot: r.projectRoot,
		owner: r.owner,
		source: r.source,
		taskId: typeof r.taskId === "string" ? r.taskId : null,
		round: typeof r.round === "number" ? r.round : null,
		nativeRef,
		title: r.title,
		scope,
		state: r.state,
		phase: typeof r.phase === "string" ? r.phase : "",
		milestone: typeof r.milestone === "string" ? r.milestone : "",
		blocker: typeof r.blocker === "string" ? r.blocker : "",
		updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
		revision: r.revision,
		artifacts,
		remoteResults,
		reviews,
	};
}

/**
 * Reads all readable work records in `.wb-bridge/collaboration/`.
 */
export async function readAllWorkRecords(projectRoot: string): Promise<WorkRecord[]> {
	const collabDir = path.join(projectRoot, ".wb-bridge", "collaboration");
	let files: string[];
	try {
		files = await readdir(collabDir);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return [];
		}
		throw new WbTaskError(WB_ERROR_CODE.storageError, `Cannot list collaboration records: ${String(err)}`);
	}

	const records: WorkRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const filePath = path.join(collabDir, file);
		try {
			const content = await readFile(filePath, "utf-8");
			const parsed = JSON.parse(content);
			records.push(validateWorkRecord(parsed, filePath));
		} catch {
			// Skip single corrupt record with warning
		}
	}
	return records;
}

/**
 * Reads a single work record by workId.
 */
export async function readWorkRecord(projectRoot: string, workId: string): Promise<WorkRecord | null> {
	if (!UUID_PATTERN.test(workId)) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Invalid workId UUID: "${workId}"`);
	}
	const filePath = path.join(projectRoot, ".wb-bridge", "collaboration", `${workId}.json`);
	try {
		const content = await readFile(filePath, "utf-8");
		return validateWorkRecord(JSON.parse(content), filePath);
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return null;
		}
		throw new WbTaskError(WB_ERROR_CODE.storageError, `Failed to read work record ${workId}: ${String(err)}`);
	}
}

/**
 * Writes a work record atomically.
 */
export async function writeWorkRecord(record: WorkRecord): Promise<void> {
	validateWorkRecord(record, "<in-memory WorkRecord>");
	const collabDir = path.join(record.projectRoot, ".wb-bridge", "collaboration");
	const filePath = path.join(collabDir, `${record.workId}.json`);
	await atomicWriteFile(collabDir, filePath, JSON.stringify(record, null, 2));
}

/**
 * Validates scope conflicts against all currently active and blocked records.
 */
export async function checkScopeConflict(
	projectRoot: string,
	currentWorkId: string,
	proposedScope: ScopeDefinition
): Promise<void> {
	const allRecords = await readAllWorkRecords(projectRoot);
	for (const rec of allRecords) {
		// Occupancy is only `active`/`blocked`: a `waiting` record is a published
		// but not-yet-granted scope and must never block anyone. Never invert this
		// back into `state !== "released"`.
		if (rec.workId === currentWorkId || (rec.state !== "active" && rec.state !== "blocked") || rec.scope === null) {
			continue;
		}
		// Check proposed writePaths against existing read and write paths
		for (const pw of proposedScope.writePaths) {
			for (const er of rec.scope.readPaths) {
				if (pathsOverlap(pw, er)) {
					throw new WbTaskError(
						WB_ERROR_CODE.scopeConflict,
						`Proposed write path "${pw}" conflicts with read path "${er}" of ${rec.owner} work ${rec.workId}`
					);
				}
			}
			for (const ew of rec.scope.writePaths) {
				if (pathsOverlap(pw, ew)) {
					throw new WbTaskError(
						WB_ERROR_CODE.scopeConflict,
						`Proposed write path "${pw}" conflicts with write path "${ew}" of ${rec.owner} work ${rec.workId}`
					);
				}
			}
		}

		// Check proposed readPaths against existing write paths
		for (const pr of proposedScope.readPaths) {
			for (const ew of rec.scope.writePaths) {
				if (pathsOverlap(pr, ew)) {
					throw new WbTaskError(
						WB_ERROR_CODE.scopeConflict,
						`Proposed read path "${pr}" conflicts with write path "${ew}" of ${rec.owner} work ${rec.workId}`
					);
				}
			}
		}
	}
}

/**
 * Claims or updates a collaboration work item.
 */
export async function claimWork(
	projectRoot: string,
	actor: "omp" | "workbuddy",
	request: ClaimWorkRequest
): Promise<{ record: WorkRecord; outputsDir: string }> {
	const canonicalRoot = await realpath(projectRoot);
	return await withCollaborationLock(canonicalRoot, async () => {
		const isNew = request.workId === undefined;
		const workId = isNew ? crypto.randomUUID() : request.workId!;
		if (!UUID_PATTERN.test(workId)) {
			throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Invalid workId UUID: "${workId}"`);
		}

		let outputsDir: string;
		let writePaths: string[];

		if (actor === "workbuddy") {
			if (request.scope.writePaths && request.scope.writePaths.length > 0) {
				writePaths = request.scope.writePaths.map(normalizeScopePath);
				outputsDir = path.resolve(canonicalRoot, writePaths[0]!);
			} else {
				const relOutputs = `.wb-bridge/workbuddy/${workId}/outputs`;
				outputsDir = path.join(canonicalRoot, ...relOutputs.split("/"));
				await mkdir(outputsDir, { recursive: true });
				writePaths = [relOutputs];
			}
		} else {
			outputsDir = canonicalRoot;
			writePaths = (request.scope.writePaths ?? []).map(normalizeScopePath);
		}

		const readPaths = (request.scope.readPaths ?? []).map(normalizeScopePath);

		for (const p of [...readPaths, ...writePaths]) {
			if (p === ".wb-bridge" || p.startsWith(".wb-bridge/")) {
				const isWbNativeOutputs = actor === "workbuddy" && p.startsWith(`.wb-bridge/workbuddy/${workId}/outputs`);
				const isWbTaskOutputs = actor === "workbuddy" && p.startsWith(`.wb-bridge/tasks/${workId}/`);
				if (!isWbNativeOutputs && !isWbTaskOutputs) {
					throw new WbTaskError(
						WB_ERROR_CODE.inputInvalid,
						`Cannot declare bridge internal directory "${p}" as business scope`
					);
				}
			}
		}

		const validatedScope: ScopeDefinition = { readPaths, writePaths };
		await checkScopeConflict(canonicalRoot, workId, validatedScope);

		const existing = await readWorkRecord(canonicalRoot, workId);
		let record: WorkRecord;
		if (existing === null) {
			if (request.expectedRevision !== undefined) {
				throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `Work record ${workId} does not exist`);
			}
			record = {
				version: 1,
				workId,
				projectRoot: canonicalRoot,
				owner: actor,
				source: request.taskId ? "delegated" : "native",
				taskId: request.taskId ?? null,
				round: request.round ?? null,
				nativeRef: request.nativeRef ?? null,
				title: request.title.trim().slice(0, 160),
				scope: validatedScope,
				state: "active",
				phase: "claimed",
				milestone: "initial",
				blocker: "",
				updatedAt: new Date().toISOString(),
				revision: 1,
				artifacts: [],
				remoteResults: [],
				reviews: [],
			};
		} else {
			if (existing.owner !== actor) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Cannot modify work owned by ${existing.owner} (caller is ${actor})`
				);
			}
			if (existing.state === "released" && !request.taskId) {
				throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Cannot re-claim released work ${workId}`);
			}
			if (request.expectedRevision !== undefined && existing.revision !== request.expectedRevision) {
				throw new WbTaskError(
					WB_ERROR_CODE.revisionConflict,
					`Revision conflict for ${workId}: expected ${request.expectedRevision}, got ${existing.revision}`
				);
			}

			const isSupplementary = request.taskId !== undefined && typeof request.round === "number" && request.round > 1;
			record = {
				...existing,
				round: request.round ?? existing.round,
				title: request.title.trim().slice(0, 160),
				scope: validatedScope,
				state: "active",
				phase: isSupplementary ? "claimed" : existing.phase,
				milestone: isSupplementary ? "supplementary" : existing.milestone,
				blocker: isSupplementary ? "" : existing.blocker,
				artifacts: isSupplementary ? [] : existing.artifacts,
				remoteResults: isSupplementary ? [] : existing.remoteResults,
				updatedAt: new Date().toISOString(),
				revision: existing.revision + 1,
			};
		}

		await writeWorkRecord(record);
		return { record, outputsDir };
	});
}

/**
 * Hardens review artifact validation: checks path normalization, existence,
 * containment, regular file status, and recomputes the current hash so a review
 * always describes the bytes that are actually on disk.
 */
async function verifyReviewArtifacts(
	projectRoot: string,
	artifacts: Array<{ path: string; sha256: string }> | undefined
): Promise<void> {
	if (!artifacts || artifacts.length === 0) {
		return;
	}
	const root = await realpath(projectRoot);
	for (const entry of artifacts) {
		let rawPath = entry.path;
		if (path.isAbsolute(rawPath)) {
			const relToRoot = path.relative(root, rawPath);
			if (!relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
				rawPath = relToRoot;
			}
		}
		const rel = normalizeScopePath(rawPath);
		const absolute = path.join(root, ...rel.split("/"));
		const fileReal = await realpath(absolute).catch(() => null);
		if (fileReal === null) {
			throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Review artifact "${entry.path}" does not exist`);
		}
		const relFromRoot = path.relative(root, fileReal);
		if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
			throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Review artifact "${entry.path}" escapes project root: "${relFromRoot}"`);
		}
		const st = await stat(fileReal);
		if (!st.isFile()) {
			throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Review artifact "${entry.path}" is not a regular file`);
		}
		const currentSha = await computeFileSha256(fileReal);
		if (entry.sha256 !== currentSha) {
			throw new WbTaskError(
				WB_ERROR_CODE.artifactChanged,
				`Review artifact "${entry.path}" changed since it was reviewed (expected ${entry.sha256}, found ${currentSha})`
			);
		}
		// The caller's hash must match the bytes on disk: that is the whole point
		// of re-verifying (N02). Comparing against the artifact's *published* hash
		// is deliberately NOT a rejection: a file that changed since publication is
		// a legitimate re-review, and blocking it would make such an artifact
		// permanently unacceptable because the published hash never changes.
	}
}

/**
 * Publishes progress, files, remote results, reviews, or releases work.
 */
export async function publishWork(
	projectRoot: string,
	actor: "omp" | "workbuddy",
	request: PublishWorkRequest
): Promise<WorkRecord> {
	const canonicalRoot = await realpath(projectRoot);
	return await withCollaborationLock(canonicalRoot, async () => {
		const existing = await readWorkRecord(canonicalRoot, request.workId);
		if (existing === null) {
			if (request.expectedRevision !== null) {
				throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `Work record ${request.workId} not found`);
			}
			// Null expectedRevision: check if this is a first review-only entry for a real historic task
			if (request.review === undefined) {
				throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `Work record ${request.workId} not found`);
			}
			await verifyReviewArtifacts(canonicalRoot, request.review.artifacts);
			const historicRecord: WorkRecord = {
				version: 1,
				workId: request.workId,
				projectRoot: canonicalRoot,
				owner: "workbuddy",
				source: "delegated",
				taskId: request.workId,
				round: request.review.round,
				nativeRef: null,
				title: "Historic Task",
				scope: null,
				state: "released",
				phase: "completed",
				milestone: "historic",
				blocker: "",
				updatedAt: new Date().toISOString(),
				revision: 1,
				artifacts: [],
				remoteResults: [],
				reviews: [
					{
						reviewer: actor,
						round: request.review.round,
						artifacts: request.review.artifacts,
						verdict: request.review.verdict,
						note: request.review.note.slice(0, 240),
						at: new Date().toISOString(),
					},
				],
			};
			await writeWorkRecord(historicRecord);
			return historicRecord;
		}

		if (request.expectedRevision !== null && existing.revision !== request.expectedRevision) {
			throw new WbTaskError(
				WB_ERROR_CODE.revisionConflict,
				`Revision conflict for ${request.workId}: expected ${request.expectedRevision}, current ${existing.revision}`
			);
		}

		const isOwner = existing.owner === actor;

		// Non-owner is only allowed to add reviews
		if (!isOwner) {
			if (request.progress || request.files || request.remoteResults || request.release) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Non-owner (${actor}) can only add reviews to work owned by ${existing.owner}`
				);
			}
		}

		// Released work only accepts reviews
		if (existing.state === "released") {
			if (request.progress || request.files || request.remoteResults || request.release) {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Work ${existing.workId} is already released; only reviews can be appended`
				);
			}
		}

		// A `waiting` record holds a published-but-ungranted scope. Only the
		// queue's claim path may grant it, so publish must not move it into an
		// occupying state. `progress.state` cannot express "stay waiting", so any
		// progress update on such a record is refused.
		if (existing.state === "waiting" && request.progress !== undefined) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Work ${existing.workId} is waiting for its scope grant; publish cannot update it`
			);
		}

		let updatedState = existing.state;
		let updatedPhase = existing.phase;
		let updatedMilestone = existing.milestone;
		let updatedBlocker = existing.blocker;

		if (request.progress) {
			updatedState = request.progress.state;
			updatedPhase = request.progress.phase.slice(0, 160);
			updatedMilestone = request.progress.milestone.slice(0, 240);
			updatedBlocker = request.progress.blocker.slice(0, 240);
		}

		if (request.release === true) {
			updatedState = "released";
		}

		// Process artifacts
		const updatedArtifacts = [...existing.artifacts];
		if (request.files && request.files.length > 0) {
			for (const fileReq of request.files) {
				if (actor === "workbuddy") {
					// WorkBuddy outputs directory
					const baseOutputs = existing.taskId
						? path.join(canonicalRoot, ".wb-bridge", "tasks", existing.taskId, "rounds", String(existing.round ?? 1), "outputs")
						: path.join(canonicalRoot, ".wb-bridge", "workbuddy", existing.workId, "outputs");

					let targetAbsPath: string;
					let importedFrom: string | null = null;
					let provenance: "native" | "imported" = "native";

					if (fileReq.importFrom) {
						// Import from project
						const srcRel = normalizeScopePath(fileReq.importFrom);
						const srcAbs = path.resolve(canonicalRoot, srcRel);
						const relFromRoot = path.relative(canonicalRoot, srcAbs);
						if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
							throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `importFrom escapes project: "${fileReq.importFrom}"`);
						}
						const destRel = normalizeScopePath(fileReq.path);
						targetAbsPath = path.resolve(baseOutputs, destRel);
						await mkdir(path.dirname(targetAbsPath), { recursive: true });
						await copyFile(srcAbs, targetAbsPath);
						importedFrom = srcRel;
						provenance = "imported";
					} else {
						const destRel = normalizeScopePath(fileReq.path);
						targetAbsPath = path.resolve(baseOutputs, destRel);
					}

					const st = await stat(targetAbsPath);
					const fileHash = await computeFileSha256(targetAbsPath);
					updatedArtifacts.push({
						kind: "file",
						path: path.resolve(targetAbsPath),
						sha256: fileHash,
						bytes: st.size,
						role: fileReq.role,
						provenance,
						importedFrom,
					});
				} else {
					// OMP files stay in original place
					const relPath = normalizeScopePath(fileReq.path);
					const absPath = path.resolve(canonicalRoot, relPath);
					const st = await stat(absPath);
					const fileHash = await computeFileSha256(absPath);
					updatedArtifacts.push({
						kind: "file",
						path: path.resolve(absPath),
						sha256: fileHash,
						bytes: st.size,
						role: fileReq.role,
						provenance: "native",
						importedFrom: null,
					});
				}
			}
		}

		// Process remote results
		const updatedRemote = [...existing.remoteResults];
		if (request.remoteResults) {
			for (const rr of request.remoteResults) {
				updatedRemote.push({
					kind: rr.kind,
					target: rr.target,
					evidence: rr.evidence,
					verification: "reported",
				});
			}
		}

		// Process review
		const updatedReviews = [...existing.reviews];
		if (request.review) {
			await verifyReviewArtifacts(canonicalRoot, request.review.artifacts);

			// An accepted review makes the reviewed bytes the current truth, so the
			// record's artifact hash must follow. Without this the record keeps
			// claiming the first published hash forever and every later projection
			// reports a stale mismatch against a file the human just accepted.
			// `changes_requested` / `unverified` deliberately do NOT write back:
			// their whole meaning is that the current bytes are not accepted.
			if (request.review.verdict === "accepted") {
				for (const reviewed of request.review.artifacts) {
					const reviewedRel = normalizeScopePath(
						path.isAbsolute(reviewed.path) ? path.relative(canonicalRoot, reviewed.path) : reviewed.path
					);
					const target = updatedArtifacts.find((artifact) => {
						const artifactRel = path.isAbsolute(artifact.path)
							? path.relative(canonicalRoot, artifact.path).split(path.sep).join("/")
							: artifact.path;
						return artifactRel === reviewedRel;
					});
					if (target === undefined) {
						// The file exists on disk but was never published for this work,
						// so accepting it would bless a deliverable the record does not
						// know about.
						throw new WbTaskError(
							WB_ERROR_CODE.artifactChanged,
							`Review artifact "${reviewed.path}" is not a published artifact of ${existing.workId}`
						);
					}
					target.sha256 = reviewed.sha256;
					const stat2 = await stat(path.join(canonicalRoot, ...reviewedRel.split("/"))).catch(() => null);
					if (stat2 !== null) {
						target.bytes = stat2.size;
					}
				}
			}

			updatedReviews.push({
				reviewer: actor,
				round: request.review.round,
				artifacts: request.review.artifacts,
				verdict: request.review.verdict,
				note: request.review.note.slice(0, 240),
				at: new Date().toISOString(),
			});
		}

		const updatedRecord: WorkRecord = {
			...existing,
			state: updatedState,
			phase: updatedPhase,
			milestone: updatedMilestone,
			blocker: updatedBlocker,
			scope: updatedState === "released" ? null : existing.scope,
			artifacts: updatedArtifacts,
			remoteResults: updatedRemote,
			reviews: updatedReviews,
			updatedAt: new Date().toISOString(),
			revision: existing.revision + 1,
		};

		await writeWorkRecord(updatedRecord);
		return updatedRecord;
	});
}

/**
 * Releases a work record scope explicitly.
 */
export async function releaseWork(projectRoot: string, workId: string): Promise<WorkRecord> {
	const canonicalRoot = await realpath(projectRoot);
	return await withCollaborationLock(canonicalRoot, async () => {
		const existing = await readWorkRecord(canonicalRoot, workId);
		if (existing === null) {
			throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `Work record ${workId} does not exist`);
		}
		const updated: WorkRecord = {
			...existing,
			state: "released",
			scope: null,
			updatedAt: new Date().toISOString(),
			revision: existing.revision + 1,
		};
		await writeWorkRecord(updated);
		return updated;
	});
}

/**
 * Returns project collaboration context or detailed work summary.
 */
export async function getProjectContext(
	projectRoot: string,
	query: ProjectContextQuery
): Promise<ProjectContextResult> {
	const canonicalRoot = await realpath(projectRoot);
	const allRecords = await readAllWorkRecords(canonicalRoot);

	if (query.workId !== undefined) {
		const found = allRecords.find((r) => r.workId === query.workId);
		if (!found) {
			throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `Work record ${query.workId} not found`);
		}
		const limit = Math.min(Math.max(query.limit ?? 8, 1), 20);
		const offset = Math.max(query.offset ?? 0, 0);
		const pagedArtifacts = found.artifacts.slice(offset, offset + limit);
		const nextOffset = offset + limit < found.artifacts.length ? offset + limit : null;
		const latestReview = found.reviews.length > 0 ? found.reviews[found.reviews.length - 1]! : null;

		return {
			entries: [],
			total: found.artifacts.length,
			nextOffset,
			detail: {
				record: found,
				outputsDir: found.owner === "workbuddy" ? path.join(canonicalRoot, ".wb-bridge", "workbuddy", found.workId, "outputs") : canonicalRoot,
				artifacts: pagedArtifacts,
				latestReview,
				reviewCount: found.reviews.length,
			},
		};
	}

	// Filter by includeClosed
	let filtered = query.includeClosed ? allRecords : allRecords.filter((r) => r.state !== "released");

	// Filter by paths overlap if requested
	if (query.paths && query.paths.length > 0) {
		const checkPaths = query.paths.map(normalizeScopePath);
		filtered = filtered.filter((r) => {
			if (r.scope === null) {
				return false;
			}
			const allWorkPaths = [...r.scope.readPaths, ...r.scope.writePaths];
			return checkPaths.some((cp) => allWorkPaths.some((wp) => pathsOverlap(cp, wp)));
		});
	}

	// Sort: blocked first, then updatedAt desc, then workId asc
	filtered.sort((a, b) => {
		if (a.state === "blocked" && b.state !== "blocked") return -1;
		if (a.state !== "blocked" && b.state === "blocked") return 1;
		const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
		if (timeDiff !== 0) return timeDiff;
		return a.workId.localeCompare(b.workId);
	});

	const limit = Math.min(Math.max(query.limit ?? 8, 1), 20);
	const offset = Math.max(query.offset ?? 0, 0);
	const paged = filtered.slice(offset, offset + limit);
	const nextOffset = offset + limit < filtered.length ? offset + limit : null;

	const entries: WorkRecordSummary[] = paged.map((r) => {
		const readTop = r.scope ? r.scope.readPaths.slice(0, 4) : [];
		const writeTop = r.scope ? r.scope.writePaths.slice(0, 4) : [];
		const totalRead = r.scope ? r.scope.readPaths.length : 0;
		const totalWrite = r.scope ? r.scope.writePaths.length : 0;
		return {
			workId: r.workId,
			owner: r.owner,
			revision: r.revision,
			title: r.title.slice(0, 160),
			phase: r.phase.slice(0, 160),
			scope: r.scope ? { readPaths: readTop, writePaths: writeTop, totalRead, totalWrite } : null,
			state: r.state,
			workerStatus: null,
			round: r.round,
			milestone: r.milestone.slice(0, 240),
			blocker: r.blocker.slice(0, 240),
			updatedAt: r.updatedAt,
			artifactCount: r.artifacts.length,
			warnings: [],
		};
	});

	return {
		entries,
		total: filtered.length,
		nextOffset,
	};
}
