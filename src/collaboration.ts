/**
 * Read-only collaboration history plus the project-context projection.
 *
 * This module used to own a second, file-backed live work protocol (`work_claim`
 * / `work_publish` and their lock and record writers). The queue is now the only
 * authority for occupancy, and the live writers were removed rather than left as
 * a dormant fallback: two writers cannot both decide who owns a scope.
 *
 * What remains is deliberately read-only:
 *
 *  - the historical `.wb-bridge/collaboration/*.json` parser, still needed to
 *    read projects migrated from the file store;
 *  - current-byte helpers (`effectiveAcceptance`) that compare a historical
 *    review against the bytes on disk;
 *  - `getProjectContext`, which projects the queue's live `works` rows and fills
 *    in historical records the queue does not know.
 *
 * Nothing here writes a record. A caller that needs to change work state uses the
 * queue's lifecycle commands.
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { computeFileSha256, readTask, resolveRoundPaths, WbTaskError } from "./tasks";
import { openProjectQueue } from "./queue";
import type { FileArtifact, RemoteResult, WorkRecord, WorkReview } from "./types";
import { WB_ERROR_CODE } from "./types";
import { normalizeScopePath, pathsOverlap } from "./scope";
export { normalizeScopePath, pathsOverlap } from "./scope";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Reads the historical work records in `.wb-bridge/collaboration/`.
 *
 * A missing directory is an empty history. A single corrupt file is skipped so
 * one bad record cannot hide every other one; callers that need to report the
 * corruption use the migration census instead.
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
			// Skip a single corrupt record; the rest of the history is still readable.
		}
	}
	return records;
}

/**
 * Reads a single historical work record by workId.
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
 * The directory a work record's artifacts actually live in.
 *
 * Delegated work is resolved through {@link resolveRoundPaths} from its parent
 * task and round — never from `workId`, which is a derived id rather than a task
 * — so the detail view, the task tool and the receipt all name the same
 * directory. Native work keeps its own outputs root.
 *
 * A record whose parent cannot be determined returns `null` instead of a
 * plausible-looking substitute: reporting the project root as an outputs
 * directory looks authoritative and is wrong, which is precisely how a consumer
 * ends up opening a file that is not the deliverable.
 */
async function outputsDirFor(root: string, record: WorkRecord): Promise<string | null> {
	if (record.source !== "delegated" || record.taskId === null || record.round === null) {
		return record.owner === "workbuddy"
			? path.join(root, ".wb-bridge", "workbuddy", record.workId, "outputs")
			: null;
	}
	// The layout comes from the receipt when one exists: a migrated task keeps its
	// outputs directly under the task directory, so assuming the round layout would
	// name a directory that never existed for it. A record may also legitimately
	// precede its receipt (it is created at enqueue), and such a round uses the
	// round layout it will be written with.
	const receipt = await readTask(root, record.taskId).catch(() => null);
	const layout = receipt?.rounds.find((entry) => entry.number === record.round)?.layout ?? "round";
	try {
		return resolveRoundPaths(root, record.taskId, record.round, layout).outputsDir;
	} catch {
		// An invalid task id in a stored record is a data problem, not a path.
		return null;
	}
}

/**
 * Reports whether an artifact's acceptance still applies to its current bytes.
 *
 * Historical reviews are never rewritten: a `changes_requested` opinion about
 * older bytes stays true about those older bytes. What changes is *effectiveness*
 * — an acceptance covers the exact bytes it was given, so once the file is
 * rewritten or deleted the acceptance no longer describes what is on disk and a
 * fresh review is required. Without this projection an accepted artifact would
 * stay "accepted" forever, which is exactly the N02 observation.
 */
export async function effectiveAcceptance(
	projectRoot: string,
	record: WorkRecord,
	relativePath: string,
): Promise<{ accepted: boolean; reason: "artifact_changed" | "artifact_missing" | null; reviewAt: string | null }> {
	const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
	const normalized = path.isAbsolute(relativePath)
		? path.relative(canonicalRoot, relativePath).split(path.sep).join("/")
		: relativePath.replaceAll("\\", "/");
	const acceptedReviews = record.reviews.filter(
		(review) =>
			review.verdict === "accepted" &&
			review.artifacts.some(
				(artifact) =>
					(path.isAbsolute(artifact.path)
						? path.relative(canonicalRoot, artifact.path).split(path.sep).join("/")
						: artifact.path.replaceAll("\\", "/")) === normalized,
			),
	);
	if (acceptedReviews.length === 0) {
		return { accepted: false, reason: null, reviewAt: null };
	}
	const latest = acceptedReviews[acceptedReviews.length - 1]!;
	const acceptedSha = latest.artifacts.find((artifact) => {
		const artifactRel = path.isAbsolute(artifact.path)
			? path.relative(canonicalRoot, artifact.path).split(path.sep).join("/")
			: artifact.path.replaceAll("\\", "/");
		return artifactRel === normalized;
	})!.sha256;

	const absolute = path.join(canonicalRoot, ...normalized.split("/"));
	const fileReal = await realpath(absolute).catch(() => null);
	if (fileReal === null) {
		return { accepted: false, reason: "artifact_missing", reviewAt: latest.at };
	}
	const relFromRoot = path.relative(canonicalRoot, fileReal);
	if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
		// A path that escapes the project cannot be a deliverable.
		return { accepted: false, reason: "artifact_missing", reviewAt: latest.at };
	}
	const current = await computeFileSha256(fileReal);
	if (current !== acceptedSha) {
		// Still accepted in history, no longer effective: the bytes a human approved
		// are not the bytes on disk.
		return { accepted: false, reason: "artifact_changed", reviewAt: latest.at };
	}
	return { accepted: true, reason: null, reviewAt: latest.at };
}

/**
 * Returns project context or a detailed work summary.
 *
 * The queue is the live authority: its `works` rows are read first and win for
 * any work id they know. Historical file records fill in the ids the queue does
 * not have, which keeps migrated history visible without letting a frozen file
 * record mask a newer queue state.
 */
export async function getProjectContext(
	projectRoot: string,
	query: ProjectContextQuery
): Promise<ProjectContextResult> {
	const canonicalRoot = await realpath(projectRoot);
	const queueRecords = await queueBackedRecords(canonicalRoot);
	const historical = await readAllWorkRecords(canonicalRoot);
	const known = new Set(queueRecords.map((record) => record.workId));
	const combined = [...queueRecords, ...historical.filter((record) => !known.has(record.workId))];

	if (query.workId !== undefined) {
		const found = combined.find((r) => r.workId === query.workId);
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
				outputsDir: await outputsDirFor(canonicalRoot, found),
				artifacts: pagedArtifacts,
				latestReview,
				reviewCount: found.reviews.length,
			},
		};
	}

	// Filters, sort and paging run over the already-merged list, so both sources are
	// treated alike: merging after pagination would exceed `limit` and leak released work
	// into a default listing.

	// Filter by includeClosed
	let filtered = query.includeClosed ? combined : combined.filter((r) => r.state !== "released");

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

/**
 * The queue's own work rows, projected onto the collaboration record shape.
 *
 * Projected as records rather than summaries so the caller's filters, sort and paging
 * apply to both sources uniformly. Returns nothing when the project has no queue, so a
 * pre-queue project keeps the answer it had before, and one unreadable row is
 * skipped instead of failing the whole listing.
 */
async function queueBackedRecords(projectRoot: string): Promise<WorkRecord[]> {
	let queue;
	try {
		queue = openProjectQueue(projectRoot, { mode: "read" });
	} catch {
		return [];
	}
	if (queue === null) {
		return [];
	}
	try {
		return queue.works().flatMap(
			(row: { workId: string; revision: number; state: string; round: number | null; recordJson: string }) => {
				let record: Record<string, unknown>;
				try {
					record = JSON.parse(row.recordJson) as Record<string, unknown>;
				} catch {
					return [];
				}
				const scope = (record["scope"] ?? null) as { readPaths: string[]; writePaths: string[] } | null;
				return [
					{
						version: 1,
						workId: row.workId,
						owner: record["owner"] === "workbuddy" ? "workbuddy" : "omp",
						revision: row.revision,
						title: String(record["title"] ?? row.workId).slice(0, 160),
						phase: String(record["phase"] ?? row.state).slice(0, 160),
						scope,
						state: row.state as WorkRecord["state"],
						round: row.round,
						milestone: String(record["milestone"] ?? "").slice(0, 240),
						blocker: String(record["blocker"] ?? "").slice(0, 240),
						// The record's own timestamps, or "now" for a record that predates them:
						// `works` carries no clock of its own.
						createdAt: String(record["createdAt"] ?? new Date().toISOString()),
						updatedAt: String(record["updatedAt"] ?? new Date().toISOString()),
						artifacts: Array.isArray(record["artifacts"]) ? (record["artifacts"] as WorkRecord["artifacts"]) : [],
						reviews: [],
						nativeRef: null,
					} as unknown as WorkRecord,
				];
			},
		);
	} finally {
		queue.close();
	}
}
