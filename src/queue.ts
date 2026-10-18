/**
 * The project queue: the single write authority for bridge state.
 *
 * `.wb-bridge/state.sqlite` owns task rounds, owners, session rosters, work
 * records, holds, help requests, continuations, outbox and issues. Every
 * arbitration decision is a short `BEGIN IMMEDIATE` transaction containing no
 * file, network or model I/O. Receipts, inputs, artifacts and briefs stay
 * ordinary files — the database stores references and digests, not blobs.
 *
 * Read mode opens an existing database read-only and returns `null` when the
 * file does not exist: a reader never creates schema, directories or
 * migrations. Write mode is only opened by authorized init, enqueue and
 * collaboration commands.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { scopesConflict } from "./scope";
import { delegatedWorkId, hashManifestPayload, WbTaskError } from "./tasks";
import { WB_ERROR_CODE, type ManifestInput, type OwnerIdentity, type TaskManifestPayload } from "./types";

/** Schema version this module writes; readers refuse anything else. */
export const QUEUE_SCHEMA_VERSION = 1;

/** Retry backoff for pure-DB transactions that lose the write lock. */
const BUSY_BACKOFF_MS = [100, 200, 400];

/** How long a write connection waits on SQLite's own busy handler. */
const BUSY_TIMEOUT_MS = 100;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owners (
	instance_id TEXT NOT NULL,
	generation TEXT NOT NULL,
	session_id TEXT NOT NULL,
	pid INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('active','inactive','dead')),
	heartbeat_at INTEGER NOT NULL,
	PRIMARY KEY (instance_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS owners_session_generation ON owners(session_id, generation);
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	role TEXT NOT NULL,
	title TEXT NOT NULL,
	title_source TEXT NOT NULL,
	use_hint TEXT NOT NULL CHECK (use_hint IN ('delegation','native','unknown')),
	identity TEXT NOT NULL CHECK (identity IN ('verified','pending')),
	availability TEXT NOT NULL CHECK (availability IN ('idle','busy','offline','unknown')),
	reason_code TEXT,
	source_complete INTEGER NOT NULL CHECK (source_complete IN (0,1)),
	observed_at INTEGER NOT NULL,
	owner_pid INTEGER,
	worker_version TEXT,
	last_assigned_at INTEGER
);
CREATE TABLE IF NOT EXISTS omp_sessions (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	source TEXT NOT NULL,
	modified_at INTEGER NOT NULL,
	observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
	task_id TEXT NOT NULL,
	round INTEGER NOT NULL,
	request_id TEXT UNIQUE,
	record_kind TEXT NOT NULL CHECK (record_kind IN ('approved','legacy')),
	revision INTEGER NOT NULL,
	result_revision INTEGER,
	status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','awaiting_help','completed','failed','cancelled','interrupted')),
	phase TEXT NOT NULL CHECK (phase IN ('queued','preparing','running','awaiting_approval','awaiting_help','committing','terminal','recovery_required')),
	target_policy_json TEXT NOT NULL,
	desired_scope_json TEXT NOT NULL,
	selected_session TEXT,
	owner_session TEXT,
	owner_generation TEXT,
	manifest_path TEXT,
	manifest_sha256 TEXT,
	approval_json TEXT,
	approval_consumed INTEGER NOT NULL CHECK (approval_consumed IN (0,1)),
	enqueued_at INTEGER NOT NULL,
	attempt_id TEXT,
	executor_instance TEXT,
	execution_token_json TEXT,
	dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('not_sent','possibly_sent','ended')),
	cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
	outcome_json TEXT,
	commit_state TEXT NOT NULL CHECK (commit_state IN ('pending','committed','failed')),
	receipt_sha256 TEXT,
	storage_error_json TEXT,
	review_state TEXT NOT NULL CHECK (review_state IN ('pending','accepted','changes_requested','unverified')),
	delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground','background')),
	delivery_consent_json TEXT,
	turns_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (task_id, round),
	CHECK (record_kind != 'approved' OR (owner_session IS NOT NULL AND manifest_path IS NOT NULL AND manifest_sha256 IS NOT NULL AND approval_json IS NOT NULL)),
	-- An approved round may only leave not_sent once an attempt exists. Legacy
	-- rows never dispatch. Without an attempt the dispatch state must be not_sent.
	CHECK (record_kind = 'legacy' OR attempt_id IS NOT NULL OR dispatch_state = 'not_sent')
);
CREATE INDEX IF NOT EXISTS rounds_dispatch ON rounds(status, enqueued_at, request_id);
CREATE TABLE IF NOT EXISTS inputs (
	task_id TEXT NOT NULL,
	round INTEGER NOT NULL,
	path TEXT NOT NULL,
	snapshot_path TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	PRIMARY KEY (task_id, round, path),
	FOREIGN KEY (task_id, round) REFERENCES rounds(task_id, round) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS works (
	work_id TEXT PRIMARY KEY,
	revision INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('waiting','active','blocked','released')),
	record_json TEXT NOT NULL,
	task_id TEXT,
	round INTEGER
);
CREATE TABLE IF NOT EXISTS holds (
	session_id TEXT PRIMARY KEY,
	parent_kind TEXT NOT NULL CHECK (parent_kind IN ('delegated','native')),
	task_id TEXT,
	round INTEGER,
	parent_work_id TEXT,
	attempt_id TEXT,
	continuation_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('execution','help_wait','quarantine')),
	CHECK ((task_id IS NOT NULL AND round IS NOT NULL AND parent_work_id IS NULL) OR (task_id IS NULL AND round IS NULL AND parent_work_id IS NOT NULL)),
	FOREIGN KEY (task_id, round) REFERENCES rounds(task_id, round),
	FOREIGN KEY (parent_work_id) REFERENCES works(work_id)
);
CREATE TABLE IF NOT EXISTS help (
	request_id TEXT PRIMARY KEY,
	task_id TEXT,
	round INTEGER,
	parent_work_id TEXT,
	session_id TEXT NOT NULL,
	attempt_id TEXT,
	payload_sha256 TEXT NOT NULL,
	snapshot_root TEXT NOT NULL,
	manifest_sha256 TEXT NOT NULL,
	owner_session TEXT,
	owner_generation TEXT,
	solver_claim_id TEXT,
	solver_token_json TEXT,
	solver_work_id TEXT,
	state TEXT NOT NULL CHECK (state IN ('pending','running','resolved','unable','cancelled','expired')),
	continuation_state TEXT NOT NULL CHECK (continuation_state IN ('inline_waiting','confirmation_required','resume_queued','resume_possible','resumed')),
	revision INTEGER NOT NULL,
	body_json TEXT NOT NULL,
	response_json TEXT,
	late_response_json TEXT,
	deadline_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((task_id IS NOT NULL AND round IS NOT NULL AND parent_work_id IS NULL) OR (task_id IS NULL AND round IS NULL AND parent_work_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS help_owner_state ON help(owner_session, state);
CREATE TABLE IF NOT EXISTS continuations (
	continuation_id TEXT PRIMARY KEY,
	help_request_id TEXT UNIQUE NOT NULL,
	parent_kind TEXT NOT NULL CHECK (parent_kind IN ('delegated','native')),
	task_id TEXT,
	round INTEGER,
	parent_work_id TEXT,
	session_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	owner_session TEXT NOT NULL,
	owner_generation TEXT NOT NULL,
	prompt_path TEXT NOT NULL,
	prompt_sha256 TEXT NOT NULL,
	consent_json TEXT NOT NULL,
	attempt_id TEXT,
	executor_instance TEXT,
	execution_token_json TEXT,
	dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('not_sent','possibly_sent','ended')),
	end_evidence_json TEXT,
	requested_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((parent_kind = 'delegated' AND task_id IS NOT NULL AND round IS NOT NULL AND parent_work_id IS NULL) OR (parent_kind = 'native' AND task_id IS NULL AND round IS NULL AND parent_work_id IS NOT NULL)),
	FOREIGN KEY (task_id, round) REFERENCES rounds(task_id, round),
	FOREIGN KEY (parent_work_id) REFERENCES works(work_id),
	FOREIGN KEY (help_request_id) REFERENCES help(request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_help_delegated ON help(task_id, round) WHERE task_id IS NOT NULL AND parent_work_id IS NULL AND state != 'cancelled' AND continuation_state != 'resumed';
CREATE UNIQUE INDEX IF NOT EXISTS one_open_help_native ON help(parent_work_id) WHERE parent_work_id IS NOT NULL AND task_id IS NULL AND state != 'cancelled' AND continuation_state != 'resumed';
CREATE TABLE IF NOT EXISTS outbox (
	delivery_id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('help','result','recovery')),
	revision INTEGER NOT NULL,
	owner_session TEXT NOT NULL,
	owner_generation TEXT NOT NULL,
	notified_generation TEXT,
	acknowledged_at INTEGER
);
CREATE TABLE IF NOT EXISTS issues (
	id TEXT PRIMARY KEY,
	code TEXT NOT NULL,
	relative_source TEXT NOT NULL,
	detail_json TEXT NOT NULL
);
`;

/** Meta keys the queue owns; unknown versions refuse writes. */
const META_KEYS = [
	"project_root",
	"schema_version",
	"project_enabled_at",
	"migration_completed",
	"revision",
	"maintenance",
	"logRetentionDays",
	"default_session_id",
] as const;

/** Read-only database handle plus the helpers it may use. */
export interface ProjectQueueRead {
	readonly mode: "read";
}

// The full ProjectQueue interface lands with the command layer below; the
// connection plumbing comes first so each piece stays reviewable.

interface QueueConnection {
	db: Database;
	mode: "read" | "write";
}

/** One cached connection per process, project and mode. */
const connections = new Map<string, QueueConnection>();

function connectionKey(root: string, mode: "read" | "write"): string {
	return `${canonicalProjectRoot(root).toLowerCase()}::${mode}`;
}

function databasePath(root: string): string {
	return path.join(root, ".wb-bridge", "state.sqlite");
}

/**
 * The one canonical form of a project root: the realpath. Every stored and
 * compared root (meta.project_root, manifest payloads, scope boundaries) is
 * expressed this way, so a junction, an 8.3 short name or a differently-cased
 * drive letter still refers to the same project. Synchronous by design:
 * connection open and transaction bodies must not interleave async work.
 */
export function canonicalProjectRoot(root: string): string {
	// An empty or relative root would resolve against the process cwd — for a
	// test runner that is the repository, which is how a stray cleanup can
	// destroy real files. Fail loudly instead of guessing.
	if (typeof root !== "string" || root.trim().length === 0 || !path.isAbsolute(root)) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Project root must be a non-empty absolute path, got: ${JSON.stringify(root)}`,
		);
	}
	try {
		return realpathSync(root);
	} catch {
		// A root that does not exist yet cannot be canonicalized; resolve is the
		// best available form and openWriteConnection will mkdir it first.
		return path.resolve(root);
	}
}

/** Applies the write connection's durability pragmas, one statement each. */
function applyWritePragmas(db: Database): void {
	db.run(`PRAGMA journal_mode=WAL`);
	db.run(`PRAGMA synchronous=FULL`);
	db.run(`PRAGMA foreign_keys=ON`);
	db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
}

/**
 * Opens a read-mode connection. Returns `null` when the database file does not
 * exist yet — a reader must not create directories, schema or migrations.
 */
export function openReadConnection(root: string): Database | null {
	const key = connectionKey(root, "read");
	const existing = connections.get(key);
	if (existing) {
		return existing.db;
	}
	const filePath = databasePath(root);
	if (!existsSync(filePath)) {
		return null;
	}
	let db: Database;
	try {
		db = new Database(filePath, { readonly: true, create: false });
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Project state database at ${filePath} could not be opened read-only: ${messageOf(err)}`,
		);
	}
	connections.set(key, { db, mode: "read" });
	return db;
}

/**
 * Opens (or reuses) the write connection, creating directories and schema.
 * Schema creation and the enabling meta row are applied idempotently.
 */
export function openWriteConnection(root: string): Database {
	const key = connectionKey(root, "write");
	const existing = connections.get(key);
	if (existing) {
		return existing.db;
	}
	const filePath = databasePath(root);
	mkdirSync(path.dirname(filePath), { recursive: true });
	let db: Database;
	try {
		db = new Database(filePath, { create: true });
		applyWritePragmas(db);
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Project state database at ${filePath} could not be opened for writing: ${messageOf(err)}`,
		);
	}
	// PRAGMA/DDL statements each run separately inside one transaction (SQLite
	// cannot batch them), so a failed init rolls back instead of leaving a
	// half-created database that looks valid to the meta checks.
	// The splitter is comment- and literal-aware: a `;` inside a `--` comment
	// or a '…' literal must not cut a statement.
	try {
		withImmediate(db, () => {
			for (const statement of splitSqlStatements(SCHEMA_SQL)) {
				const sql = statement.trim();
				if (sql.length > 0) {
					db.run(sql);
				}
			}
		});
	} catch (err: unknown) {
		try {
			db.close(false);
		} catch {
			// The original error is the one worth surfacing.
		}
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Project state database schema at ${filePath} could not be initialized: ${messageOf(err)}`,
		);
	}
	connections.set(key, { db, mode: "write" });
	return db;
}

/**
 * Splits a DDL script on `;` that are outside `--` line comments and outside
 * single-quoted literals (with `''` escapes), so schema comments cannot break
 * statement boundaries.
 */
function splitSqlStatements(script: string): string[] {
	const statements: string[] = [];
	let current = "";
	let inComment = false;
	let inLiteral = false;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i];
		const next = script[i + 1];
		if (inComment) {
			if (ch === "\n") {
				inComment = false;
				current += ch;
			}
			continue;
		}
		if (inLiteral) {
			if (ch === "'" && next === "'") {
				current += "''";
				i++;
				continue;
			}
			if (ch === "'") {
				inLiteral = false;
			}
			current += ch;
			continue;
		}
		if (ch === "-" && next === "-") {
			inComment = true;
			current += "--";
			i++;
			continue;
		}
		if (ch === "'") {
			inLiteral = true;
			current += ch;
			continue;
		}
		if (ch === ";") {
			statements.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) {
		statements.push(current);
	}
	return statements;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** True when the error is SQLite's write-lock loss, retryable in full. */
function isBusyError(err: unknown): boolean {
	const message = messageOf(err).toUpperCase();
	return message.includes("SQLITE_BUSY") || message.includes("DATABASE IS LOCKED") || message.includes("BUSY");
}

/**
 * Runs one pure-DB transaction under `BEGIN IMMEDIATE`, retrying whole
 * transactions on SQLITE_BUSY with the fixed backoff. `work` must not await
 * files, network or models — the transaction is synchronous by construction,
 * and the backoff sleep is synchronous so no other code interleaves.
 */
export function withImmediate<T>(db: Database, work: () => T): T {
	const run = db.transaction(work);
	let lastError: unknown;
	for (let attempt = 0; attempt <= BUSY_BACKOFF_MS.length; attempt++) {
		if (attempt > 0) {
			const waitMs = BUSY_BACKOFF_MS[attempt - 1] ?? BUSY_BACKOFF_MS[0] ?? 100;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
		}
		try {
			return run.immediate() as T;
		} catch (err: unknown) {
			lastError = err;
			if (!isBusyError(err)) {
				throw err;
			}
		}
	}
	throw new WbTaskError(
		WB_ERROR_CODE.queueBusy,
		`Project queue stayed busy after ${BUSY_BACKOFF_MS.length + 1} attempts: ${messageOf(lastError)}`,
	);
}

/** Reads one meta value, or null when absent. */
export function readMeta(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
	return row?.value ?? null;
}

/** Writes one meta value inside the caller's transaction. */
export function writeMeta(db: Database, key: string, value: string): void {
	if (!(META_KEYS as readonly string[]).includes(key)) {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Unknown meta key "${key}"`);
	}
	db.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

/**
 * Validates the database belongs to this project and is a known schema
 * version; throws on mismatch so a foreign or newer database is never
 * silently written. Never writes: validation only, on read or write paths.
 * The one-time initialization of `project_root`/`schema_version` belongs to
 * {@link initializeProjectDatabase} in the write-open path, and to the
 * stage-3 migration after that.
 */
export function assertProjectDatabase(db: Database, root: string): void {
	const storedRoot = readMeta(db, "project_root");
	const expected = canonicalProjectRoot(root);
	if (storedRoot === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Project state database has no project_root row; run the migration before opening ${expected}`,
		);
	}
	if (storedRoot !== expected) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Project state database belongs to ${storedRoot}, not ${expected}`,
		);
	}
	const version = readMeta(db, "schema_version");
	if (version !== String(QUEUE_SCHEMA_VERSION)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Project state database schema version ${version ?? "(missing)"} is not ${QUEUE_SCHEMA_VERSION}`,
		);
	}
}

/**
 * First-write setup of the project identity meta rows, used only by the
 * write-open path (and later the stage-3 migration, which becomes the sole
 * writer once it lands).
 */
export function initializeProjectDatabase(db: Database, root: string): void {
	writeMeta(db, "project_root", canonicalProjectRoot(root));
	writeMeta(db, "schema_version", String(QUEUE_SCHEMA_VERSION));
}

/** Closes this process's connection for the project (one mode or both). */
export function closeQueueConnection(root: string, mode?: "read" | "write"): void {
	for (const key of [...connections.keys()]) {
		if (!key.startsWith(`${canonicalProjectRoot(root).toLowerCase()}::`)) {
			continue;
		}
		if (mode !== undefined && !key.endsWith(`::${mode}`)) {
			continue;
		}
		const connection = connections.get(key);
		connections.delete(key);
		try {
			connection?.db.close(false);
		} catch {
			// A close failure must not mask the caller's actual result.
		}
	}
}

/** Resolves the monotonic domain revision, bumping it by one. */
export function nextRevision(db: Database): number {
	const current = readMeta(db, "revision");
	const value = current === null ? 1 : Number.parseInt(current, 10) + 1;
	writeMeta(db, "revision", String(value));
	return value;
}

/** What the authorization gate needs to know about a project. */
export interface ProjectAccess {
	projectRoot: string;
	/** The project has been enabled (migrated) and may dispatch. */
	enabled: boolean;
	/** The old file state has been imported; false means migration pending. */
	migrated: boolean;
}

/**
 * The only authorization source for every entry point (MCP gate, task
 * tools, init/bind/status/doctor). Reads the database's meta strictly
 * read-only: a missing database is `{enabled:false, migrated:false}`, and no
 * directory, schema or migration is ever created here.
 */
export async function readProjectAccess(root: string): Promise<ProjectAccess | null> {
	const canonicalRoot = canonicalProjectRoot(root);
	const db = openReadConnection(canonicalRoot);
	if (db === null) {
		return { projectRoot: canonicalRoot, enabled: false, migrated: false };
	}
	try {
		const storedRoot = readMeta(db, "project_root");
		// A database belonging to another project is not this project's state;
		// treat it as absent rather than answering for someone else.
		if (storedRoot !== null && storedRoot !== canonicalRoot) {
			return { projectRoot: canonicalRoot, enabled: false, migrated: false };
		}
		return {
			projectRoot: canonicalRoot,
			enabled: readMeta(db, "project_enabled_at") !== null,
			migrated: readMeta(db, "migration_completed") !== null,
		};
	} finally {
		closeQueueConnection(canonicalRoot, "read");
	}
}

/** Fetches one round row as a plain record, or null. */
export function readRound(db: Database, taskId: string, round: number): Record<string, unknown> | null {
	return (
		(db.query("SELECT * FROM rounds WHERE task_id = ? AND round = ?").get(taskId, round) as Record<string, unknown>) ??
		null
	);
}

/** Fetches the newest round row for a task, or null. */
export function readCurrentRound(db: Database, taskId: string): Record<string, unknown> | null {
	return (
		(db.query("SELECT * FROM rounds WHERE task_id = ? ORDER BY round DESC LIMIT 1").get(taskId) as Record<string, unknown>) ??
		null
	);
}

/** Registers or refreshes this activation's owner row. */
export function registerOwner(db: Database, owner: OwnerIdentity, now: number): void {
	db.run(
		`INSERT INTO owners(instance_id, generation, session_id, pid, state, heartbeat_at)
		 VALUES(?, ?, ?, ?, 'active', ?)
		 ON CONFLICT(instance_id, generation) DO UPDATE SET state = 'active', heartbeat_at = excluded.heartbeat_at, pid = excluded.pid`,
		[owner.instanceId, owner.generation, owner.sessionId, owner.processId, now],
	);
}

/** Marks an owner inactive inside the caller's transaction. */
export function retireOwner(db: Database, owner: OwnerIdentity): void {
	db.run("UPDATE owners SET state = 'inactive' WHERE instance_id = ? AND generation = ?", [
		owner.instanceId,
		owner.generation,
	]);
}

/** True when an owner row exists and is still marked active. */
export function isOwnerActive(db: Database, owner: OwnerIdentity): boolean {
	const row = db
		.query("SELECT state FROM owners WHERE instance_id = ? AND generation = ?")
		.get(owner.instanceId, owner.generation) as { state: string } | null;
	return row?.state === "active";
}

// ---------------------------------------------------------------------------
// ProjectQueue facade
// ---------------------------------------------------------------------------

/** Everything enqueue needs; the stage must already be frozen and verified. */
export interface ApprovedEnqueue {
	taskId: string;
	round: number;
	requestId: string;
	/** Canonical payload digest from the confirmation (verified by stageTask). */
	manifestSha256: string;
	/** Absolute path to the stage's manifest.json. */
	manifestPath: string;
	/** Stage root containing inputs/ and manifest.json. */
	snapshotRoot: string;
	/** `null` marks a first round; a supplemental round pins the prior one. */
	expectedPreviousRound: number | null;
	/** Desired scope: readPaths = original input paths, writePaths = outputs dir. */
	readPaths: string[];
	writePaths: string[];
	targetPolicy: TargetPolicyJson;
	ownerSession: string;
	ownerGeneration: string;
	/** Instance id of the registering owner (must have a live owners row). */
	executorInstanceId: string;
	/** Human approval evidence recorded on the approved round. */
	approval: { source: "host_dialog" | "user_command"; at: string; payloadSha256: string };
	/** Work record title shown in lists. */
	title: string;
	deliveryMode: "foreground" | "background";
	enqueuedAt?: number;
}

export type TargetPolicyJson = { kind: "session"; sessionId: string } | { kind: "workspace_pool"; role: string | null };

/** Result of one claim attempt. */
export type ClaimOutcome =
	| { kind: "claimed"; taskId: string; round: number; requestId: string; attemptId: string; sessionId: string; manifestPath: string }
	| { kind: "waiting"; taskId: string; round: number; reason: string; blockerIds: string[] }
	| { kind: "empty" };

/** Snapshot rows returned by inspect; shaped for views, not raw columns. */
export interface QueueSnapshot {
	tasks: Array<Record<string, unknown>>;
	sessions: Array<Record<string, unknown>>;
	works: Array<Record<string, unknown>>;
	help: Array<Record<string, unknown>>;
	warnings: Array<Record<string, unknown>>;
	revision: number;
}

export interface QueueQuery {
	taskId?: string;
	status?: string;
	limit?: number;
	offset?: number;
	include?: QueueInclude;
}

/** The persisted-queue handle one process holds per project. */
export interface ProjectQueue {
	enqueue(input: ApprovedEnqueue): { taskId: string; round: number; revision: number };
	claim(owner: OwnerIdentity, now: number): ClaimOutcome;
	inspect(query: QueueQuery): QueueSnapshot;
	close(): void;
}

/** Optional inspect sections; unrequested arrays come back empty. */
export interface QueueInclude {
	sessions?: boolean;
	works?: boolean;
	help?: boolean;
	diagnostics?: boolean;
}

/** Opens the queue facade. `write` requires the project to be enabled. */
export function openProjectQueue(root: string, options: { mode: "read" | "write" }): ProjectQueue | null {
	const canonicalRoot = canonicalProjectRoot(root);
	if (options.mode === "read") {
		const db = openReadConnection(canonicalRoot);
		if (db === null) {
			return null;
		}
		assertProjectReadSafe(db, canonicalRoot);
		return new ReadQueue(canonicalRoot, db);
	}
	const db = openWriteConnection(canonicalRoot);
	withImmediate(db, () => {
		// First open initializes the identity meta rows; every later open
		// validates only. The stage-3 migration will become the sole writer.
		const storedRoot = readMeta(db, "project_root");
		if (storedRoot === null) {
			initializeProjectDatabase(db, canonicalRoot);
			return;
		}
		assertProjectDatabase(db, canonicalRoot);
	});
	return new WriteQueue(canonicalRoot, db);
}

function assertProjectReadSafe(db: Database, root: string): void {
	const storedRoot = readMeta(db, "project_root");
	if (storedRoot !== null && storedRoot !== canonicalProjectRoot(root)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Project state database belongs to ${storedRoot}, not ${canonicalProjectRoot(root)}`,
		);
	}
}

class ReadQueue implements ProjectQueue {
	readonly mode = "read" as const;
	constructor(
		private readonly root: string,
		private readonly db: Database,
	) {}

	enqueue(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot enqueue");
	}

	claim(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot claim");
	}

	inspect(query: QueueQuery): QueueSnapshot {
		const base = inspectRounds(this.db, query);
		return { ...base, sessions: [], works: [], help: [], warnings: [] };
	}

	close(): void {
		closeQueueConnection(this.root, "read");
	}
}

/** Shared rounds query honoring taskId/status/limit/offset only. */
function inspectRounds(db: Database, query: QueueQuery): Pick<QueueSnapshot, "tasks" | "revision"> {
	const limit = Math.min(query.limit ?? 50, 200);
	const offset = query.offset ?? 0;
	const params: (string | number)[] = [];
	let where = "";
	if (query.taskId !== undefined) {
		where = " WHERE task_id = ?";
		params.push(query.taskId);
	}
	if (query.status !== undefined) {
		where = where === "" ? " WHERE status = ?" : `${where} AND status = ?`;
		params.push(query.status);
	}
	params.push(limit, offset);
	const tasks = db
		.query(`SELECT * FROM rounds${where} ORDER BY enqueued_at ASC, request_id ASC LIMIT ? OFFSET ?`)
		.all(...params) as Array<Record<string, unknown>>;
	return {
		tasks,
		revision: Number.parseInt(readMeta(db, "revision") ?? "0", 10),
	};
}

class WriteQueue implements ProjectQueue {
	readonly mode = "write" as const;
	constructor(
		private readonly root: string,
		private readonly db: Database,
	) {}

	enqueue(input: ApprovedEnqueue): { taskId: string; round: number; revision: number } {
		const now = input.enqueuedAt ?? Date.now();
		// Cheap pre-check outside the transaction: an already-enqueued requestId
		// with the same digest returns its original row without touching the
		// stage directory, so a cleaned-up stage never breaks idempotency. The
		// definitive check happens again inside the transaction below.
		const preexisting = this.db.query("SELECT task_id, round, revision, manifest_sha256 FROM rounds WHERE request_id = ?").get(input.requestId) as
			| { task_id: string; round: number; revision: number; manifest_sha256: string | null }
			| null;
		if (preexisting !== null) {
			if (preexisting.manifest_sha256 === input.manifestSha256) {
				return { taskId: preexisting.task_id, round: preexisting.round, revision: preexisting.revision };
			}
			throw new WbTaskError(
				WB_ERROR_CODE.revisionConflict,
				`Request ${input.requestId} is already enqueued with a different manifest digest`,
			);
		}
		// File read outside the transaction: the transaction body stays pure DB.
		// The manifest is the digest-bearing source of truth, so the persisted
		// input rows come from it — a caller cannot pass a divergent list.
		let manifestBytes: string;
		try {
			manifestBytes = readFileSync(input.manifestPath, "utf-8");
		} catch (err: unknown) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Staged manifest at ${input.manifestPath} could not be read: ${messageOf(err)}`,
			);
		}
		const manifestOnDisk = JSON.parse(manifestBytes) as {
			payload: TaskManifestPayload;
			approval: { source: string; at: string; payloadSha256: string };
		};
		const manifestInputs = manifestOnDisk.payload.inputs;
		if (!Array.isArray(manifestInputs) || manifestInputs.some((i) => typeof i?.path !== "string" || typeof i?.sha256 !== "string")) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Stage manifest at ${input.manifestPath} has a malformed inputs list`,
			);
		}
		// The persisted rows must be the ones the confirmed digest covers.
		const recomputedSha = hashManifestPayload(manifestOnDisk.payload);
		if (recomputedSha !== input.manifestSha256) {
			throw new WbTaskError(
				WB_ERROR_CODE.revisionConflict,
				`Stage manifest at ${input.manifestPath} hashes to ${recomputedSha}, not the confirmed ${input.manifestSha256}`,
			);
		}
		// The approval must cover the manifest being enqueued. Without this the
		// two digests would each pass their own check while describing different
		// payloads, and a human could approve one round while another executed.
		if (input.approval.payloadSha256 !== recomputedSha) {
			throw new WbTaskError(
				WB_ERROR_CODE.revisionConflict,
				`Approval covers payload ${input.approval.payloadSha256}, but the stage manifest is ${recomputedSha}`,
			);
		}
		// Snapshot paths resolve against the stage root; a mismatched root would
		// make every frozen digest unverifiable at execution time.
		const manifestDir = path.dirname(input.manifestPath);
		if (path.resolve(input.snapshotRoot) !== manifestDir) {
			throw new WbTaskError(
				WB_ERROR_CODE.inputInvalid,
				`Snapshot root ${input.snapshotRoot} does not contain the manifest at ${input.manifestPath}`,
			);
		}
		return withImmediate(this.db, () => {
			// Project authorization and a live owner are prerequisites, not
			// afterthoughts: an unauthorized or ownerless enqueue is refused.
			const enabledAt = readMeta(this.db, "project_enabled_at");
			if (enabledAt === null) {
				throw new WbTaskError(
					WB_ERROR_CODE.migrationRequired,
					`Project ${this.root} is not enabled; run /wb bind (or the integration wizard) first`,
				);
			}
			if (!isOwnerActive(this.db, {
				instanceId: input.executorInstanceId,
				generation: input.ownerGeneration,
				sessionId: input.ownerSession,
				processId: 0,
			})) {
				throw new WbTaskError(
					WB_ERROR_CODE.ownerUnavailable,
					`Owner generation ${input.ownerGeneration} of session ${input.ownerSession} is not registered; register_owner must precede enqueue`,
				);
			}

			// Idempotency first: the same requestId with the same digest returns
			// the original row; a different digest is a hard conflict.
			const existing = this.db.query("SELECT * FROM rounds WHERE request_id = ?").get(input.requestId) as
				| Record<string, unknown>
				| null;
			if (existing !== null) {
				const existingDigest = existing.manifest_sha256;
				if (existingDigest === input.manifestSha256) {
					return {
						taskId: existing.task_id as string,
						round: existing.round as number,
						revision: existing.revision as number,
					};
				}
				throw new WbTaskError(
					WB_ERROR_CODE.revisionConflict,
					`Request ${input.requestId} is already enqueued with a different manifest digest`,
				);
			}

			// Digest-covered facts come from the verified manifest, not from
			// caller fields: the human approved this payload, so a caller
			// overriding targetPolicy or task identity would silently redirect.
			const payloadTargetPolicy = manifestOnDisk.payload.targetPolicy;
			const payloadTaskId = manifestOnDisk.payload.taskId;
			const payloadRound = manifestOnDisk.payload.round;
			if (
				input.taskId !== payloadTaskId ||
				input.round !== payloadRound ||
				JSON.stringify(input.targetPolicy) !== JSON.stringify(payloadTargetPolicy)
			) {
				throw new WbTaskError(
					WB_ERROR_CODE.revisionConflict,
					`Enqueue request (task ${input.taskId} round ${input.round}) disagrees with the approved manifest (task ${payloadTaskId} round ${payloadRound}); a frozen manifest may not be redirected`,
				);
			}

			if (input.expectedPreviousRound !== null) {
				const previous = readRound(this.db, payloadTaskId, input.expectedPreviousRound);
				if (previous === null) {
					throw new WbTaskError(
						WB_ERROR_CODE.taskStateInvalid,
						`Supplemental round ${payloadRound} expects previous round ${input.expectedPreviousRound} of task ${payloadTaskId}, which does not exist`,
					);
				}
				if (previous.commit_state !== "committed") {
					throw new WbTaskError(
						WB_ERROR_CODE.revisionConflict,
						`Supplemental round ${payloadRound} requires previous round ${input.expectedPreviousRound} to be committed, but it is ${previous.commit_state}`,
					);
				}
			}

			const revision = nextRevision(this.db);
			const derivedReadPaths = manifestInputs.map((i) => i.path);
			const derivedWritePaths = [`.wb-bridge/tasks/${payloadTaskId}/rounds/${payloadRound}/outputs`];
			this.db.run(
				`INSERT INTO rounds(
					task_id, round, request_id, record_kind, revision, status, phase,
					target_policy_json, desired_scope_json, owner_session, owner_generation,
					manifest_path, manifest_sha256, approval_json, approval_consumed,
					enqueued_at, dispatch_state, cancel_requested, commit_state,
					review_state, delivery_mode, turns_json, updated_at
				) VALUES (?, ?, ?, 'approved', ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'not_sent', 0, 'pending', 'pending', ?, '[]', ?)`,
				[
					payloadTaskId,
					payloadRound,
					input.requestId,
					revision,
					JSON.stringify(payloadTargetPolicy),
					JSON.stringify({ readPaths: derivedReadPaths, writePaths: derivedWritePaths }),
					input.ownerSession,
					input.ownerGeneration,
					input.manifestPath,
					input.manifestSha256,
					JSON.stringify(input.approval),
					now,
					input.deliveryMode,
					now,
				],
			);
			// Waiting work record for visibility; no active scope, no hold. The
			// record is a real WorkRecord so context rendering and stage-3
			// migration can validate it with the existing domain validator.
			const workRecord = {
				version: 1 as const,
				workId: delegatedWorkId(payloadTaskId, payloadRound),
				projectRoot: this.root,
				owner: "omp" as const,
				source: "delegated" as const,
				taskId: payloadTaskId,
				round: payloadRound,
				nativeRef: null,
				title: input.title,
				scope: { readPaths: derivedReadPaths, writePaths: derivedWritePaths },
				state: "waiting" as const,
				phase: "queued",
				milestone: "",
				blocker: "",
				updatedAt: new Date(now).toISOString(),
				revision,
				artifacts: [],
				remoteResults: [],
				reviews: [],
			};
			this.db.run(
				`INSERT INTO works(work_id, revision, state, record_json, task_id, round)
				 VALUES(?, ?, 'waiting', ?, ?, ?)`,
				[workRecord.workId, revision, JSON.stringify(workRecord), payloadTaskId, payloadRound],
			);
			// Persist the staged manifest's per-file rows: execution reads these
			// snapshot paths and re-verifies the frozen digests before prompting.
			for (const manifestInput of manifestInputs) {
				this.db.run(
					`INSERT INTO inputs(task_id, round, path, snapshot_path, sha256, bytes)
					 VALUES(?, ?, ?, ?, ?, ?)`,
					[payloadTaskId, payloadRound, manifestInput.path, manifestInput.snapshotPath, manifestInput.sha256, manifestInput.bytes],
				);
			}
			return { taskId: payloadTaskId, round: payloadRound, revision };
		});
	}

	claim(owner: OwnerIdentity, now: number): ClaimOutcome {
		return withImmediate(this.db, () => {
			const candidates = this.db
				.query(
					`SELECT * FROM rounds
					 WHERE status = 'queued' AND phase = 'queued' AND cancel_requested = 0
					   AND owner_session = ? AND owner_generation = ?
					 ORDER BY enqueued_at ASC, request_id ASC`,
				)
				.all(owner.sessionId, owner.generation) as Array<Record<string, unknown>>;
			// The oldest blocked candidate is remembered; younger candidates keep
			// being tried so one busy session or one scope conflict never starves
			// unrelated work of the same owner.
			let firstWait: ClaimOutcome | null = null;
			for (const candidate of candidates) {
				const taskId = candidate.task_id as string;
				const round = candidate.round as number;
				// The dispatch target is the WorkBuddy session from the round's
				// target policy, not the OMP owner: holds and blocker ids key on it.
				const targetPolicy = JSON.parse(candidate.target_policy_json as string) as TargetPolicyJson;
				let wbSession: string;
				if (targetPolicy.kind === "session") {
					wbSession = targetPolicy.sessionId;
				} else {
					// Pool rounds are pinned to their verified WorkBuddy session at
					// arm time; until then the owner session is the placeholder hold
					// owner. Dispatch never double-books a pool either.
					wbSession = `pool:${owner.sessionId}`;
				}
				// One execution hold per WorkBuddy session: a second round for the
				// same target session must wait, not double-dispatch. The wait is
				// recorded and younger candidates keep being tried, so one busy
				// session never starves unrelated work of the same owner.
				const sessionHold = this.db
					.query("SELECT session_id FROM holds WHERE session_id = ? AND kind = 'execution'")
					.get(wbSession) as { session_id: string } | null;
				if (sessionHold !== null) {
					firstWait ??= {
						kind: "waiting",
						taskId,
						round,
						reason: "session_busy",
						blockerIds: [wbSession],
					} as ClaimOutcome;
					continue;
				}
				// Scope arbitration: desired read/write paths vs active/blocked works.
				const scope = JSON.parse(candidate.desired_scope_json as string) as {
					readPaths: string[];
					writePaths: string[];
				};
				const occupied = this.db
					.query("SELECT work_id, record_json FROM works WHERE state IN ('active','blocked')")
					.all() as Array<{ work_id: string; record_json: string }>;
				const conflicting = occupied.find((row) => {
					const record = JSON.parse(row.record_json) as {
						scope: { readPaths: string[]; writePaths: string[] } | null;
					};
					if (record.scope === null || row.work_id === delegatedWorkId(taskId, round)) {
						return false;
					}
					return scopesConflict(scope, record.scope);
				});
				if (conflicting !== undefined) {
					firstWait ??= {
						kind: "waiting",
						taskId,
						round,
						reason: "scope_conflict",
						blockerIds: [conflicting.work_id],
					} as ClaimOutcome;
					continue;
				}

				const attemptId = crypto.randomUUID();
				const executionToken = { attemptId, executorInstance: owner.instanceId, issuedAt: now };
				// The revision advances only when the CAS decides this claimant owns
				// the row: a loser must not burn a domain revision.
				const result = this.db.run(
					`UPDATE rounds SET
						phase = 'preparing', attempt_id = ?, executor_instance = ?,
						execution_token_json = ?, revision = revision + 1, updated_at = ?, selected_session = ?
					 WHERE task_id = ? AND round = ? AND status = 'queued' AND attempt_id IS NULL`,
					[attemptId, owner.instanceId, JSON.stringify(executionToken), now, wbSession, taskId, round],
				);
				if (result.changes !== 1) {
					// Another claimant won this row inside its own transaction; try
					// the next candidate.
					continue;
				}
				const revision = (readRound(this.db, taskId, round)?.revision as number) ?? (candidate.revision as number);
				const holdResult = this.db.run(
					`INSERT INTO holds(session_id, parent_kind, task_id, round, attempt_id, kind)
					 VALUES(?, 'delegated', ?, ?, ?, 'execution')
					 ON CONFLICT(session_id) DO NOTHING`,
					[wbSession, taskId, round, attemptId],
				);
				if (holdResult.changes !== 1) {
					// A concurrent writer grabbed the same WorkBuddy session between
					// the hold lookup and this insert (both inside this transaction
					// would be impossible, but stay defensive): roll the attempt back
					// and restore the revision the row had before this claim.
					this.db.run(
						`UPDATE rounds SET phase = 'queued', attempt_id = NULL, executor_instance = NULL,
							execution_token_json = NULL, selected_session = NULL, revision = ?, updated_at = ?
						 WHERE task_id = ? AND round = ? AND attempt_id = ?`,
						[candidate.revision as number, now, taskId, round, attemptId],
					);
					firstWait ??= {
						kind: "waiting",
						taskId,
						round,
						reason: "session_busy",
						blockerIds: [wbSession],
					} as ClaimOutcome;
					continue;
				}
				this.db.run(
					`UPDATE works SET state = 'active', revision = ?
					 WHERE task_id = ? AND round = ? AND state = 'waiting'`,
					[revision, taskId, round],
				);
				return {
					kind: "claimed",
					taskId,
					round,
					requestId: candidate.request_id as string,
					attemptId,
					sessionId: wbSession,
					manifestPath: candidate.manifest_path as string,
				} as ClaimOutcome;
			}
			return firstWait ?? ({ kind: "empty" } as ClaimOutcome);
		});
	}

	inspect(query: QueueQuery): QueueSnapshot {
		const base = inspectRounds(this.db, query);
		return {
			tasks: base.tasks,
			sessions: query.include?.sessions === true
				? (this.db.query("SELECT * FROM sessions ORDER BY session_id ASC").all() as Array<Record<string, unknown>>)
				: [],
			works: query.include?.works === true
				? (this.db.query("SELECT * FROM works ORDER BY work_id ASC").all() as Array<Record<string, unknown>>)
				: [],
			help: query.include?.help === true
				? (this.db.query("SELECT * FROM help ORDER BY created_at ASC").all() as Array<Record<string, unknown>>)
				: [],
			warnings: query.include?.diagnostics === true
				? (this.db.query("SELECT * FROM issues ORDER BY id ASC").all() as Array<Record<string, unknown>>)
				: [],
			revision: base.revision,
		};
	}

	close(): void {
		closeQueueConnection(this.root, "write");
	}
}

