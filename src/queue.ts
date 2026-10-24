/**
 * The project queue: the single write authority for bridge state.
 *
 * `.wb-bridge/state.sqlite` owns task rounds, owners, session rosters, work
 * records, holds, reviews, corrections, outbox and issues. Every
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
import crypto from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { scopesConflict } from "./scope";
import { delegatedWorkId, hashManifestPayload, isPidAlive, WbTaskError } from "./tasks";
import {
	WB_ERROR_CODE,
	type ManifestInput,
	type OperatorRecoveryAuthorization,
	type OwnerDeathProof,
	type OwnerIdentity,
	type PoolWaitReason,
	type QuarantineReleaseAuthorization,
	type ReceiptAuthorization,
	type RecoveryConsent,
	type RecoverySubject,
	type SessionBlocker,
	type SessionBlockerReason,
	type TaskManifestPayload,
	type WaitReason,
} from "./types";

/** Schema version this module writes; readers refuse anything else. */
export const QUEUE_SCHEMA_VERSION = 3;

/** Retry backoff for pure-DB transactions that lose the write lock. */
const BUSY_BACKOFF_MS = [100, 200, 400];

/** How long a write connection waits on SQLite's own busy handler. */
const BUSY_TIMEOUT_MS = 100;

/** The complete schema; applying it is idempotent and is how upgrades work. */
export const SCHEMA_SQL = `
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
	last_assigned_at INTEGER,
	-- The project pool: an enrolled session is an authorized member of this
	-- project's roster and may be selected for a workspace_pool round.
	enrolled INTEGER NOT NULL DEFAULT 0 CHECK (enrolled IN (0,1)),
	-- Set when newly verified metadata contradicts the session's project
	-- ownership. Such a session is quarantined: it is never offered for new
	-- work, while its historical task affinity is preserved.
	ownership_conflict INTEGER NOT NULL DEFAULT 0 CHECK (ownership_conflict IN (0,1))
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
	-- Work-package binding. approval_json stays the stored authorization
	-- *reference*; per-round consent that predates packages is kept separately in
	-- legacy_approval_json so no old evidence is lost and none is upgraded into a
	-- package grant it never was.
	package_id TEXT,
	authorization_id TEXT,
	authorization_revision INTEGER,
	deliverable_id TEXT,
	purpose TEXT CHECK (purpose IS NULL OR purpose IN ('planned','rework')),
	rework_of_review_id TEXT,
	legacy_approval_json TEXT,
	enqueued_at INTEGER NOT NULL,
	attempt_id TEXT,
	executor_instance TEXT,
	execution_token_json TEXT,
	execution_end_json TEXT,
	-- Durable audit of an operator recovery: who acted, which original owner was
	-- proven dead, the exact subject and the human's consent. Written in the
	-- same transaction that commits the recovered receipt.
	receipt_recovery_json TEXT,
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
	round INTEGER,
	-- Follow-up responsibility: who is expected to collect and review this work.
	-- Deliberately separate from the record's owner column (who *executed* it),
	-- because an OMP can take over collecting work it did not run, and dropping
	-- follow-up must never look like cancelling execution.
	followup_session TEXT,
	followup_generation TEXT,
	followup_claimed_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_sessions (
	-- Durable task <-> WorkBuddy context affinity.
	--
	-- rounds.selected_session is NOT this: a rollback clears it before the
	-- prompt was ever sent, and a terminal release leaves it stale. The
	-- affinity row is written once, at claim time, and is never removed except
	-- when the task itself is deleted. Rework and supplement rounds read it
	-- instead of re-selecting a context.
	task_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	round INTEGER NOT NULL,
	-- How the affinity was established: 'pool' (the queue selected it) or
	-- 'pinned' (the approved manifest named it).
	kind TEXT NOT NULL CHECK (kind IN ('pool','pinned')),
	assigned_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_sessions_session ON task_sessions(session_id);
CREATE TABLE IF NOT EXISTS session_usage (
	-- Every WorkBuddy context this project has handed to a task.
	--
	-- A context is used by exactly one task lineage: an unrelated task must
	-- never be sent into a conversation that already holds another task's
	-- work. The row survives terminal release, rollback and restart, so a
	-- released context is never silently recycled.
	session_id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	first_round INTEGER NOT NULL,
	-- 'reserved' means the context was claimed but no prompt may have left;
	-- 'used' means a prompt was armed or sent, so the context is definitely
	-- not clean.
	state TEXT NOT NULL CHECK (state IN ('reserved','used')),
	first_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_usage_task ON session_usage(task_id);
CREATE TABLE IF NOT EXISTS holds (
	session_id TEXT PRIMARY KEY,
	parent_kind TEXT NOT NULL CHECK (parent_kind IN ('delegated','native')),
	task_id TEXT,
	round INTEGER,
	parent_work_id TEXT,
	attempt_id TEXT,
	continuation_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('execution','quarantine')),
	CHECK ((task_id IS NOT NULL AND round IS NOT NULL AND parent_work_id IS NULL) OR (task_id IS NULL AND round IS NULL AND parent_work_id IS NOT NULL)),
	FOREIGN KEY (task_id, round) REFERENCES rounds(task_id, round),
	FOREIGN KEY (parent_work_id) REFERENCES works(work_id)
);
CREATE TABLE IF NOT EXISTS outbox (
	delivery_id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('result','recovery')),
	revision INTEGER NOT NULL,
	owner_session TEXT NOT NULL,
	owner_generation TEXT NOT NULL,
	notified_generation TEXT,
	acknowledged_at INTEGER,
	-- CAS claim bookkeeping: a notification may be attempted by one followup
	-- generation at a time, and a claim that is never acknowledged stays visible
	-- rather than being silently retried into a duplicate wake-up.
	claimed_by TEXT,
	claimed_generation TEXT,
	claimed_at INTEGER
);
CREATE TABLE IF NOT EXISTS issues (
	id TEXT PRIMARY KEY,
	code TEXT NOT NULL,
	relative_source TEXT NOT NULL,
	detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
	review_id TEXT PRIMARY KEY,
	parent_kind TEXT NOT NULL CHECK (parent_kind IN ('delegated','native')),
	task_id TEXT,
	round INTEGER,
	parent_work_id TEXT,
	artifact_set_json TEXT NOT NULL,
	criteria_json TEXT NOT NULL,
	verdict TEXT NOT NULL CHECK (verdict IN ('accepted','changes_requested','unverified')),
	reviewer_json TEXT NOT NULL,
	reviewed_at INTEGER NOT NULL,
	CHECK ((parent_kind = 'delegated' AND task_id IS NOT NULL AND round IS NOT NULL AND parent_work_id IS NULL) OR (parent_kind = 'native' AND task_id IS NULL AND round IS NULL AND parent_work_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reviews_task_round ON reviews(task_id, round, reviewed_at);
CREATE INDEX IF NOT EXISTS reviews_work ON reviews(parent_work_id, reviewed_at);
CREATE TABLE IF NOT EXISTS task_corrections (
	task_id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL,
	plan_json TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY (review_id) REFERENCES reviews(review_id)
);
`;

/**
 * Columns added to `rounds` after the first shipped schema.
 *
 * They are declared in {@link SCHEMA_SQL} for new databases and applied with
 * `ALTER TABLE` for existing ones; both paths end in the same table shape. This
 * list is the single source for both, which is what makes an upgraded database
 * and a fresh install converge.
 */
const ROUNDS_ADDED_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
	{ name: "package_id", definition: "TEXT" },
	{ name: "authorization_id", definition: "TEXT" },
	{ name: "authorization_revision", definition: "INTEGER" },
	{ name: "deliverable_id", definition: "TEXT" },
	{ name: "purpose", definition: "TEXT CHECK (purpose IS NULL OR purpose IN ('planned','rework'))" },
	{ name: "rework_of_review_id", definition: "TEXT" },
	{ name: "legacy_approval_json", definition: "TEXT" },
	{ name: "execution_end_json", definition: "TEXT" },
	// The durable audit of an operator recovery. It is written in the same
	// transaction that commits the recovered receipt, so a best-effort log line
	// can never be the only record of who recovered a dead owner's round.
	{ name: "receipt_recovery_json", definition: "TEXT" },
];

/**
 * Columns added to `outbox` after the first shipped schema.
 *
 * Kept separate from the rounds list so each table's evolution is legible, and
 * applied by the same idempotent helper pattern.
 */
const WORKS_ADDED_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
	{ name: "followup_session", definition: "TEXT" },
	{ name: "followup_generation", definition: "TEXT" },
	{ name: "followup_claimed_at", definition: "INTEGER" },
];

const OUTBOX_ADDED_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
	{ name: "claimed_by", definition: "TEXT" },
	{ name: "claimed_generation", definition: "TEXT" },
	{ name: "claimed_at", definition: "INTEGER" },
];

/**
 * Columns added to `sessions` when the project pool became a real roster.
 *
 * `enrolled` marks a session as an authorized member of this project's pool;
 * `ownership_conflict` quarantines a session whose newly verified metadata
 * contradicts the project it was enrolled for. Both default to 0, so an
 * upgraded database keeps every existing row exactly as it was: an old roster
 * member is not silently promoted into the pool, and no old row is deleted.
 */
const SESSIONS_ADDED_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
	{ name: "enrolled", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (enrolled IN (0,1))" },
	{ name: "ownership_conflict", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (ownership_conflict IN (0,1))" },
];

/**
 * Adds any missing `rounds` column, idempotently.
 *
 * Callers must already hold the write connection; each `ALTER` is a no-op when
 * the column is present, checked through `PRAGMA table_info` because SQLite has
 * no `ADD COLUMN IF NOT EXISTS`.
 */
export function ensureRoundsColumns(db: Database): void {
	const existing = new Set(
		(db.query("PRAGMA table_info(rounds)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	for (const column of ROUNDS_ADDED_COLUMNS) {
		if (!existing.has(column.name)) {
			db.run(`ALTER TABLE rounds ADD COLUMN ${column.name} ${column.definition}`);
		}
	}
	// Copies of the same reasoning for the other two tables: an older file gains the
	// columns, a fresh one already declares them.
	const worksExisting = new Set(
		(db.query("PRAGMA table_info(works)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	for (const column of WORKS_ADDED_COLUMNS) {
		if (!worksExisting.has(column.name)) {
			db.run(`ALTER TABLE works ADD COLUMN ${column.name} ${column.definition}`);
		}
	}
	// The outbox gained claim bookkeeping after it first shipped; both tables are
	// brought forward here so an upgrade and a fresh install converge.
	const outboxExisting = new Set(
		(db.query("PRAGMA table_info(outbox)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	for (const column of OUTBOX_ADDED_COLUMNS) {
		if (!outboxExisting.has(column.name)) {
			db.run(`ALTER TABLE outbox ADD COLUMN ${column.name} ${column.definition}`);
		}
	}
	// The session roster gained pool membership and ownership-conflict markers
	// with the multi-session pool. Same idempotent pattern as the tables above.
	const sessionsExisting = new Set(
		(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	for (const column of SESSIONS_ADDED_COLUMNS) {
		if (!sessionsExisting.has(column.name)) {
			db.run(`ALTER TABLE sessions ADD COLUMN ${column.name} ${column.definition}`);
		}
	}
}

/**
 * Verifies that `rounds` carries every column this build expects.
 *
 * `openWriteConnection` runs the additions, so a failure here means the file was
 * modified outside this module; refusing is safer than writing against a table
 * whose shape is not the one the queries were written for.
 */
export function assertRoundColumns(db: Database): void {
	const existing = new Set(
		(db.query("PRAGMA table_info(rounds)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	const missing = ROUNDS_ADDED_COLUMNS.filter((column) => !existing.has(column.name)).map((c) => c.name);
	if (missing.length > 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.migrationRequired,
			`Project state database is missing rounds column(s) ${missing.join(", ")}; run project setup to migrate it`,
		);
	}
}

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
	// Work-package policy defaults. Separate keys from the package rows so a
	// project-wide change never rewrites an existing package's grant.
	"default_rework_mode",
	"default_max_rework",
	"maintenance_reason",
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

/**
 * Applies the write connection's durability pragmas, one statement each.
 *
 * Order matters: `journal_mode=WAL` needs a brief exclusive lock, so it must
 * run *after* `busy_timeout` is installed. With the default zero timeout the
 * WAL switch fails immediately with SQLITE_BUSY whenever another process is
 * between transactions, which surfaces as "could not be opened for writing"
 * under real contention even though the database is perfectly healthy.
 */
function applyWritePragmas(db: Database): void {
	db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
	db.run(`PRAGMA journal_mode=WAL`);
	db.run(`PRAGMA synchronous=FULL`);
	db.run(`PRAGMA foreign_keys=ON`);
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
 * Options for {@link openWriteConnection}.
 *
 * `allowSchemaMismatch` exists for exactly one caller: the upgrade path, which
 * must open the older file in order to rewrite it. Every other caller leaves it
 * unset so an outdated database is refused before anything is written.
 */
export interface OpenWriteOptions {
	readonly allowSchemaMismatch?: boolean;
}

/**
 * Opens (or reuses) the write connection, creating directories and schema.
 * Schema creation and the enabling meta row are applied idempotently.
 */
export function openWriteConnection(root: string, options: OpenWriteOptions = {}): Database {
	const key = connectionKey(root, "write");
	const existing = connections.get(key);
	if (existing) {
		return existing.db;
	}
	const filePath = databasePath(root);
	mkdirSync(path.dirname(filePath), { recursive: true });

	// An existing database declares its own schema version, and this build must
	// check that declaration *before* touching it. `CREATE TABLE IF NOT EXISTS`
	// would silently no-op against an older file, so the code would then run
	// against columns that do not exist and fail somewhere unrelated. The probe
	// uses its own short-lived handle so the shared connection cache stays
	// untouched, and it deliberately has no `catch`: the version error must
	// reach the caller as `WB_MIGRATION_REQUIRED`, not be rewrapped as storage.
	if (existsSync(filePath) && options.allowSchemaMismatch !== true) {
		let probe: Database | undefined;
		try {
			probe = new Database(filePath, { readonly: true, create: false });
			// The probe runs while other processes may hold the write lock, so it
			// needs the same bounded wait the shared read path installs. Without it
			// a concurrent writer turns a healthy database into an instant failure.
			probe.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
			const declared = readMeta(probe, "schema_version");
			if (declared !== String(QUEUE_SCHEMA_VERSION)) {
				throw new WbTaskError(
					WB_ERROR_CODE.migrationRequired,
					`Project state database at ${filePath} declares schema version ${declared ?? "(missing)"}, not ${QUEUE_SCHEMA_VERSION}; run project setup to migrate it`,
				);
			}
		} finally {
			// The probe is discarded right here, so its statements must be
			// finalized with it: `close(false)` would keep the file locked until
			// the garbage collector runs, and this handle is never referenced
			// again.
			probe?.close(true);
		}
	}

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
			// `CREATE TABLE IF NOT EXISTS` never adds a column, so an older file that
			// reaches this path gets the additions explicitly. Fresh files already
			// declare them; the call is a no-op there.
			ensureRoundsColumns(db);
			// Opening for write must always yield a *usable* database. Writing the
			// identity rows here (rather than only in `openProjectQueue`) is what
			// makes that true: otherwise this function could create a file with
			// tables but no schema version, and its own guard would then refuse it on
			// the next call.
			if (readMeta(db, "project_root") === null) {
				initializeProjectDatabase(db, canonicalProjectRoot(root));
			}
		});
	} catch (err: unknown) {
		try {
			// This handle is abandoned: the schema could not be initialized. Its
			// statements are finalized with it so the file is released now
			// rather than whenever the collector happens to run.
			db.close(true);
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
export function splitSqlStatements(script: string): string[] {
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
		// A version mismatch is not corrupt data: the bytes are fine, this build
		// simply must not write them. Reporting `migration_required` is what lets a
		// read entry point tell the user to run setup (or upgrade) instead of
		// declaring the project broken.
		throw new WbTaskError(
			WB_ERROR_CODE.migrationRequired,
			`Project state database schema version ${version ?? "(missing)"} is not ${QUEUE_SCHEMA_VERSION}; run project setup to migrate it`,
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

/**
 * Enables dispatch for a project without requiring a bound session.
 *
 * A project may legitimately be enabled with an empty session pool: the plan
 * allows it so a user who has not opened a WorkBuddy conversation yet can still
 * authorise the project, and later sessions join the pool automatically. This is
 * also the only enable path that does not go through an imported binding.
 *
 * Idempotent: an existing `project_enabled_at` is returned untouched, so a
 * repeated setup never rewrites the original authorization time.
 */
export function enableProject(root: string, now: number = Date.now()): string {
	const canonicalRoot = canonicalProjectRoot(root);
	const db = openWriteConnection(canonicalRoot);
	return withImmediate(db, () => {
		// Enable is a state transition on an existing project, never a bootstrap:
		// silently creating identity meta here would let a typo'd path pretend to
		// be a project. Bootstrapping belongs to the migration/write-open path.
		assertProjectDatabase(db, canonicalRoot);
		const existing = readMeta(db, "project_enabled_at");
		if (existing !== null) {
			return existing;
		}
		const stamp = new Date(now).toISOString();
		writeMeta(db, "project_enabled_at", stamp);
		nextRevision(db);
		return stamp;
	});
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
			// Finalize retained prepared statements before discarding this handle.
			// Lazy close can keep the Windows state file locked until they are
			// finalized or collected. Callers must already be done with the facade.
			connection?.db.close(true);
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

/** What one directory's bridge state says about project ownership. */
export type ProjectMarkerState =
	/** The database exists, belongs to this root, and records enablement. */
	| "enabled"
	/** The database exists and belongs here, but setup never enabled it. */
	| "disabled"
	/** A database exists here but was created for a different project root. */
	| "foreign"
	/**
	 * A pre-database `.wb-bridge/` exists (binding and/or task records) with no
	 * `state.sqlite`: the project is real, but its state still needs importing.
	 * This is the state every v2 user is in right after upgrading, so it must be
	 * reported as a project that needs migration, never as "not a project".
	 */
	| "legacy"
	/** No bridge state at all — nothing has been set up here. */
	| "absent";

/**
 * Entries that make a `.wb-bridge/` directory recognizable as pre-queue state.
 *
 * Only entries the old writer actually produced are listed. A receipt never lives
 * at the `.wb-bridge` root (receipts are under `tasks/<id>/`), and `active.lock`
 * is a transient lock: either would let a stray file keep a directory classified
 * as a project forever, which is the opposite of failing closed.
 */
const LEGACY_STATE_ENTRIES = ["binding.json", "tasks"] as const;

/**
 * True when this directory carries pre-database bridge state.
 *
 * Only entry names are inspected — never their contents — because this runs on
 * read-only paths that must not parse or validate another process's records.
 */
function hasLegacyState(directory: string): boolean {
	const bridge = path.join(directory, ".wb-bridge");
	let names: string[];
	try {
		if (!statSync(bridge).isDirectory()) {
			return false;
		}
		names = readdirSync(bridge);
	} catch {
		return false;
	}
	return LEGACY_STATE_ENTRIES.some((entry) => names.includes(entry));
}

/**
 * Classifies the bridge state at one directory, strictly read-only.
 *
 * This is the single implementation of "is this database ours and is it
 * enabled"; `readProjectAccess` is expressed in terms of it so the two answers
 * cannot drift. It never creates directories, schema or migrations, and it
 * closes the read connection before returning.
 */
export function inspectProjectMarker(root: string): ProjectMarkerState {
	const canonicalRoot = canonicalProjectRoot(root);
	const db = openReadConnection(canonicalRoot);
	if (db === null) {
		// No database: the project may still exist as pre-queue file state, which
		// setup imports. Reporting it as "absent" would tell an upgrading user
		// their project does not exist.
		return hasLegacyState(canonicalRoot) ? "legacy" : "absent";
	}
	try {
		const storedRoot = readMeta(db, "project_root");
		// A database belonging to another project is not this project's state.
		// Reporting it explicitly (rather than as "absent") lets the resolver treat
		// a copied or moved checkout as something to verify instead of overwriting.
		if (storedRoot !== null && storedRoot !== canonicalRoot) {
			return "foreign";
		}
		return readMeta(db, "project_enabled_at") !== null ? "enabled" : "disabled";
	} finally {
		closeQueueConnection(canonicalRoot, "read");
	}
}

/**
 * The only authorization source for every entry point (MCP gate, task
 * tools, init/bind/status/doctor). Reads the database's meta strictly
 * read-only: a missing database is `{enabled:false, migrated:false}`, and no
 * directory, schema or migration is ever created here.
 *
 * Ownership and enablement come from {@link inspectProjectMarker} so this and
 * the resolver cannot disagree about which database belongs to whom. The
 * migration marker is read here because only this shape exposes it.
 */
export async function readProjectAccess(root: string): Promise<ProjectAccess | null> {
	const canonicalRoot = canonicalProjectRoot(root);
	const marker = inspectProjectMarker(canonicalRoot);
	if (marker === "absent" || marker === "foreign") {
		// `foreign` answers "not this project's state" rather than reporting
		// another project's enablement; setup must decide what to do with it.
		// `legacy` falls through: the project exists and needs importing.
		return { projectRoot: canonicalRoot, enabled: false, migrated: false };
	}
	const db = openReadConnection(canonicalRoot);
	if (db === null) {
		return { projectRoot: canonicalRoot, enabled: false, migrated: false };
	}
	try {
		return {
			projectRoot: canonicalRoot,
			enabled: marker === "enabled",
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

/** Matches an active registration, including its originating session and known PID. */
export function isOwnerActive(
	db: Database,
	owner: Pick<OwnerIdentity, "instanceId" | "generation" | "sessionId"> & { processId?: number },
): boolean {
	const row = db
		.query("SELECT state, session_id, pid FROM owners WHERE instance_id = ? AND generation = ?")
		.get(owner.instanceId, owner.generation) as { state: string; session_id: string; pid: number } | null;
	return row?.state === "active" && row.session_id === owner.sessionId &&
		(owner.processId === undefined || row.pid === owner.processId);
}

// ---------------------------------------------------------------------------
// Operator recovery: the exact subject, the death proof, the consent.
//
// Recovery by a *different* operator is only lawful when three things are all
// true at the moment the recovery commits:
//
//  1. the original execution owner is provably gone — its registered OS
//     process no longer exists, not merely "the row says inactive";
//  2. the human consented to *this exact subject* — the round, the attempt,
//     the session, the original owner, the approved manifest, the recorded
//     first outcome — and that consent has not been consumed yet;
//  3. the round still is that subject. Any concurrent change to the round
//     invalidates the consent instead of being silently adopted.
//
// All three are checked inside the same `BEGIN IMMEDIATE` transaction that
// commits the receipt, so there is no window in which a stale consent could
// authorize a changed round.
// ---------------------------------------------------------------------------

/** The digest of an outcome blob, as the recovery subject freezes it. */
function digestOf(value: string): string {
	return crypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

/**
 * Freezes the exact subject of one recovery act from the queue's own rows.
 *
 * The subject is a snapshot: it is read in one scope and compared later, in
 * another transaction, against the row as it is *then*. A recovery that
 * freezes nothing has nothing to compare, and a comparison against a
 * recomputed subject would silently accept whatever the round became.
 *
 * Returns `null` when the round does not exist or carries no recorded first
 * outcome: there is nothing to recover in that case.
 */
export function readRecoverySubject(db: Database, taskId: string, round: number): RecoverySubject | null {
	const row = readRound(db, taskId, round);
	if (row === null) {
		return null;
	}
	const outcomeJson = row.outcome_json;
	if (typeof outcomeJson !== "string" || outcomeJson.length === 0) {
		return null;
	}
	const ownerSession = row.owner_session;
	const ownerGeneration = row.owner_generation;
	const executorInstance = row.executor_instance;
	const manifestSha256 = row.manifest_sha256;
	const requestId = row.request_id;
	if (
		typeof ownerSession !== "string" || ownerSession.length === 0 ||
		typeof ownerGeneration !== "string" || ownerGeneration.length === 0 ||
		typeof executorInstance !== "string" || executorInstance.length === 0 ||
		typeof manifestSha256 !== "string" || manifestSha256.length === 0 ||
		typeof requestId !== "string" || requestId.length === 0
	) {
		return null;
	}
	const selectedSession = row.selected_session;
	const attemptId = row.attempt_id;
	const receiptSha256 = row.receipt_sha256;
	return {
		taskId,
		round,
		requestId,
		attemptId: typeof attemptId === "string" && attemptId.length > 0 ? attemptId : null,
		sessionId: typeof selectedSession === "string" && selectedSession.length > 0 ? selectedSession : null,
		ownerSession,
		ownerGeneration,
		executorInstance,
		manifestSha256,
		outcomeSha256: digestOf(outcomeJson),
		receiptSha256: typeof receiptSha256 === "string" && receiptSha256.length > 0 ? receiptSha256 : null,
		revision: Number(row.revision),
	};
}

/**
 * Proves that an original execution owner is gone.
 *
 * Three facts are needed and none of them is enough alone.
 *
 * 1. The owner's own registration must have ended cleanly (`inactive` or
 *    `dead`). An `active` registration belongs to a generation that may still
 *    be winding its work down.
 * 2. The OS must agree that the registered process id no longer exists. A
 *    process that is still alive — or whose liveness cannot be determined — is
 *    not a dead owner no matter what the database says.
 * 3. No *live* successor of the same originating session may exist.
 *
 * The third fact is what makes the proof about the whole originating session
 * rather than about one generation. A dead generation's round can be resumed
 * by a later generation of the same OMP session, and that successor is a
 * legal owner of the work: it may still hold the round, finish it, or repair
 * it itself. So while any registration of that session is active and its
 * process is alive, the round is not abandoned and a *different* operator may
 * not recover it.
 *
 * A registration that cannot be found at all is refused: an unknown owner is
 * not a provably dead one.
 */
export function proveOwnerDead(
	db: Database,
	owner: Pick<OwnerIdentity, "instanceId" | "generation" | "sessionId">,
	now: number,
	isAlive: (pid: number) => boolean = isPidAlive,
): { ok: true; proof: OwnerDeathProof } | { ok: false; reason: string } {
	const row = db
		.query("SELECT instance_id, generation, session_id, pid, state FROM owners WHERE instance_id = ? AND generation = ?")
		.get(owner.instanceId, owner.generation) as
		| { instance_id: string; generation: string; session_id: string; pid: number; state: string }
		| null;
	if (row === null) {
		return { ok: false, reason: "the original owner's registration is unknown" };
	}
	if (row.session_id !== owner.sessionId) {
		return { ok: false, reason: "the original owner's registration belongs to a different session" };
	}
	if (row.state === "active") {
		// An active registration is a live generation. It may be a legal
		// successor of the same originating session, and in any case its work is
		// not provably finished.
		return { ok: false, reason: "the original owner's generation is still registered as active" };
	}
	if (row.state !== "inactive" && row.state !== "dead") {
		return { ok: false, reason: `the original owner's registration is in an unknown state (${row.state})` };
	}
	// The OS has the last word. `isPidAlive` reports uncertainty as "alive",
	// so an EPERM or any other inconclusive answer refuses the recovery here.
	if (isAlive(row.pid)) {
		return { ok: false, reason: `the original owner's process ${row.pid} is still running` };
	}
	// The originating session as a whole must be gone. Another generation of
	// the same session may still be alive and may still own this round, so
	// while one is, the round is not abandoned.
	const successors = db
		.query("SELECT instance_id, generation, pid, state FROM owners WHERE session_id = ? AND state = 'active'")
		.all(owner.sessionId) as Array<{ instance_id: string; generation: string; pid: number; state: string }>;
	for (const successor of successors) {
		// The liveness of a successor is asked of the OS, not of the database.
		// An uncertain answer counts as alive: a successor that cannot be
		// checked is a successor that may still be running.
		if (isAlive(successor.pid)) {
			return {
				ok: false,
				reason: `the originating session ${owner.sessionId} still has a live registration (generation ${successor.generation}, process ${successor.pid})`,
			};
		}
	}
	return {
		ok: true,
		proof: {
			sessionId: row.session_id,
			generation: row.generation,
			instanceId: row.instance_id,
			processId: row.pid,
			state: row.state,
			pidGone: true,
			provedAt: now,
		},
	};
}

/**
 * Compares two frozen subjects for exact equality.
 *
 * Every field participates. A subject that differs in any field describes a
 * different round state, and a consent given for the other one may not be
 * reused.
 */
export function sameRecoverySubject(left: RecoverySubject, right: RecoverySubject): boolean {
	return (
		left.taskId === right.taskId &&
		left.round === right.round &&
		left.requestId === right.requestId &&
		left.attemptId === right.attemptId &&
		left.sessionId === right.sessionId &&
		left.ownerSession === right.ownerSession &&
		left.ownerGeneration === right.ownerGeneration &&
		left.executorInstance === right.executorInstance &&
		left.manifestSha256 === right.manifestSha256 &&
		left.outcomeSha256 === right.outcomeSha256 &&
		left.receiptSha256 === right.receiptSha256 &&
		left.revision === right.revision
	);
}

/**
 * Validates a one-shot consent against the subject it was given for.
 *
 * The consent must be exactly `true`, must carry a parseable timestamp, and
 * must name the same subject. A consent whose subject differs is not a
 * consent for this round — it is a consent for something else.
 */
function consentMatchesSubject(consent: RecoveryConsent, subject: RecoverySubject): boolean {
	if (consent === null || consent.confirmed !== true) {
		return false;
	}
	if (typeof consent.at !== "string" || !Number.isFinite(Date.parse(consent.at))) {
		return false;
	}
	return sameRecoverySubject(consent.subject, subject);
}

/**
 * Verifies one operator recovery authorization against the live row.
 *
 * Called inside the commit transaction. It answers one question: may this
 * operator, with this consent, commit this round *as it is right now*.
 *
 * The checks, in order of what they protect:
 *
 *  - the operator is an actively registered identity of this project;
 *  - the operator is not the original owner (the ordinary owner path does not
 *    need a recovery grant);
 *  - the original owner is the one the round really belonged to;
 *  - the original owner's process is still gone;
 *  - the frozen subject still describes the round;
 *  - the consent names that subject and has not been consumed.
 */
function verifyRecoveryAuthorization(
	db: Database,
	row: Record<string, unknown>,
	recovery: OperatorRecoveryAuthorization,
	now: number,
): { ok: true } | { ok: false; reason: string } {
	if (recovery === undefined || recovery.kind !== "operator_recovery") {
		return { ok: false, reason: "the recovery authorization is not an operator recovery" };
	}
	const operator = recovery.operator;
	if (operator === undefined || !isOwnerActive(db, operator)) {
		return { ok: false, reason: "the recovering operator is not an active registration" };
	}
	const original = recovery.originalOwner;
	if (
		original === undefined ||
		row.owner_session !== original.sessionId ||
		row.owner_generation !== original.generation ||
		row.executor_instance !== original.instanceId
	) {
		return { ok: false, reason: "the round does not belong to the original owner named in the recovery" };
	}
	if (original.sessionId === operator.sessionId && original.generation === operator.generation) {
		return { ok: false, reason: "the recovering operator is the original owner; this recovery grant is redundant" };
	}
	const death = proveOwnerDead(db, original, now);
	if (!death.ok) {
		return { ok: false, reason: `the original owner is not provably gone: ${death.reason}` };
	}
	// The proof the caller carries must be the one the queue can reproduce. A
	// proof for a different process or a different generation is not a proof.
	const carried = recovery.deathProof;
	if (
		carried === null || carried === undefined ||
		carried.sessionId !== original.sessionId ||
		carried.generation !== original.generation ||
		carried.instanceId !== original.instanceId ||
		carried.processId !== death.proof.processId ||
		original.processId !== death.proof.processId ||
		carried.pidGone !== true
	) {
		return { ok: false, reason: "the recovery carries no valid death proof for the original owner" };
	}
	// The subject is recomputed from the row as it is *now*: a round that
	// changed since the human answered invalidates the consent instead of
	// being silently adopted.
	const current = readRecoverySubject(db, String(row.task_id), Number(row.round));
	if (current === null) {
		return { ok: false, reason: "the round no longer carries a recorded first outcome" };
	}
	if (!sameRecoverySubject(current, recovery.subject)) {
		return { ok: false, reason: "the round changed after the operator's confirmation; the recovery is no longer about this round" };
	}
	if (!consentMatchesSubject(recovery.consent, current)) {
		return { ok: false, reason: "the operator's confirmation does not cover this exact round" };
	}
	return { ok: true };
}

/**
 * Verifies one operator recovery authorization against the round as it is now.
 *
 * This is the *same* verification the commit transaction performs, exposed so
 * a caller can refuse an unlawful recovery before it writes any bytes: a
 * receipt file on disk for a recovery that was refused would leave evidence of
 * an act that never happened.
 *
 * The transaction re-runs it, because a preflight can be raced: the round may
 * change between the check and the commit. One helper serves both, so the two
 * cannot drift apart.
 */
export function verifyOperatorRecovery(
	db: Database,
	taskId: string,
	round: number,
	recovery: OperatorRecoveryAuthorization,
	now: number,
): { ok: true } | { ok: false; reason: string } {
	const row = readRound(db, taskId, round);
	if (row === null) {
		return { ok: false, reason: `no round ${round} for task ${taskId}` };
	}
	return verifyRecoveryAuthorization(db, row, recovery, now);
}

/**
 * The durable audit row of one operator recovery.
 *
 * It names the operator who actually acted, the original owner unchanged, the
 * proof that the original owner was gone, the exact subject and the human's
 * consent. It is written in the same transaction as the commit it authorizes,
 * so the audit and the effect cannot come apart.
 */
export interface RecoveryAudit {
	kind: "operator_recovery";
	operator: OwnerIdentity;
	originalOwner: OwnerIdentity;
	deathProof: OwnerDeathProof;
	subject: RecoverySubject;
	consent: RecoveryConsent;
	requestedAt: number;
	recordedAt: number;
}

/** Builds the audit record written next to a recovered receipt. */
function recoveryAudit(recovery: OperatorRecoveryAuthorization, now: number): RecoveryAudit {
	return {
		kind: "operator_recovery",
		operator: recovery.operator,
		originalOwner: recovery.originalOwner,
		deathProof: recovery.deathProof,
		subject: recovery.subject,
		consent: recovery.consent,
		requestedAt: recovery.requestedAt,
		recordedAt: now,
	};
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
	/** A task-level quality correction, independent of historical package links. */
	correctionOfReviewId?: string;
	/**
	 * Work-package authorization this round runs under.
	 *
	 * Optional only for legacy/imported rounds that predate packages; anything
	 * admitted through `task.submit` must supply it, because the round's
	 * authorization is what the queue verifies before arming a prompt.
	 */
}

export type TargetPolicyJson = { kind: "session"; sessionId: string } | { kind: "workspace_pool"; role: string | null };

/**
 * One observed WorkBuddy session in the project's pool.
 *
 * The host fills this from verified discovery; the queue records it and is the
 * only authority that decides which of these may actually receive work.
 */
export interface ProjectSessionObservation {
	sessionId: string;
	workbuddyVersion: string;
	availability: "idle" | "busy" | "offline" | "unknown";
	role?: string;
	title?: string;
	/**
	 * Whether a live worker of this project owns the session right now.
	 *
	 * A member that is only *known* (enrolled from the desktop catalog, or
	 * carried over from a previous roster without a live proof) must never
	 * receive new work, whatever its availability says. The host may set this
	 * to `false` to withhold such a member.
	 */
	verified?: boolean;
	/**
	 * Set when newly verified metadata contradicts the session's project
	 * ownership. Such a session is quarantined: never offered for new work,
	 * while its historical task affinity is preserved.
	 */
	ownershipConflict?: boolean;
}

/** Result of one claim attempt. */
export type ClaimOutcome =
	| { kind: "claimed"; taskId: string; round: number; requestId: string; attemptId: string; sessionId: string; manifestPath: string }
	| {
			kind: "waiting";
			taskId: string;
			round: number;
			/**
			 * Why the round is waiting.
			 *
			 * A pool wait names one of the pool reasons; every other wait names
			 * the domain reason it already had. The reason is derived from the
			 * queue's facts, never guessed.
			 */
			reason: WaitReason;
			/**
			 * The records that block this round.
			 *
			 * A scope conflict names the occupying work id; a pool wait names
			 * the WorkBuddy sessions that cannot take the task.
			 */
			blockerIds: string[];
			/**
			 * The per-session facts behind a pool wait.
			 *
			 * Empty for every other kind of wait: only a pool chooses among
			 * sessions, so only a pool has sessions to report.
			 */
			sessionBlockers: SessionBlocker[];
	  }
	| { kind: "empty" };

/** Snapshot rows returned by inspect; shaped for views, not raw columns. */
export interface QueueSnapshot {
	tasks: Array<Record<string, unknown>>;
	sessions: Array<Record<string, unknown>>;
	works: Array<Record<string, unknown>>;
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
	/**
	 * Records the authorized project roster and its latest observations.
	 *
	 * The queue is the only authority for pool membership: a host that kept
	 * its own roster would let a session that is not enrolled receive work.
	 * A read-mode queue refuses the call — a reader must never mutate.
	 */
	syncProjectSessions(sessions: readonly ProjectSessionObservation[], now: number): void;
	/**
	 * The durable WorkBuddy context this task is pinned to, or `null`.
	 *
	 * This is not `rounds.selected_session`: a rollback clears that column
	 * before anything was sent, and a terminal release leaves it stale. The
	 * affinity survives both, so a rework or supplement round is dispatched
	 * into the same conversation that already holds the task's work.
	 */
	taskSession(taskId: string): string | null;
	/**
	 * Why a queued round is waiting, as the queue's own facts describe it.
	 *
	 * The answer comes from the same derivation the claim uses, so a status
	 * read and the wait that was recorded cannot disagree. A round that is not
	 * waiting has no reason and no blockers.
	 */
	waitState(taskId: string, round: number): TaskWaitState;
	inspect(query: QueueQuery): QueueSnapshot;
	close(): void;
	/**
	 * Lifecycle commands.
	 *
	 * They are part of the facade so a host adapter never reaches for the database:
	 * the arm/terminal/commit ordering is only safe if every caller uses these and
	 * nothing else. The standalone functions remain the implementation and are what
	 * the offline lifecycle suite drives directly.
	 */
	/** Records this activation's owner row through the queue's own connection. */
	registerOwner(owner: OwnerIdentity, now: number): void;
	/** Marks this activation's generation inactive, so a later process can prove it dead. */
	retireOwner(owner: OwnerIdentity): void;
	armPrompt(input: Parameters<typeof armPrompt>[1]): ArmOutcome;
	recordExecutionEnd(input: Parameters<typeof recordExecutionEnd>[1]): { kind: "recorded" | "refused"; reason?: string };
	adoptUnsentRounds(input: Parameters<typeof adoptUnsentRounds>[1]): number;
	beginTerminal(input: Parameters<typeof beginTerminal>[1]): { kind: "applied" | "unchanged"; status: string };
	rollbackClaim(input: Parameters<typeof rollbackClaim>[1]): { kind: "requeued" | "refused"; reason?: string };
	reconcileAbandonedRounds(input: Parameters<typeof reconcileAbandonedRounds>[1]): AbandonedRound[];
	/** Releases only an exact quarantined round after recorded human verification. */
	releaseQuarantine(input: Parameters<typeof releaseQuarantine>[1]): RecoveryRelease;
	/**
	 * Freezes the exact subject of a recovery act.
	 *
	 * The subject names the round, the attempt, the session, the original owner,
	 * the approved manifest, the recorded first outcome and the round's
	 * revision. It is the thing a human is asked about and the thing the commit
	 * is checked against.
	 */
	recoverySubject(taskId: string, round: number): RecoverySubject | null;
	/**
	 * Proves that an original execution owner is gone.
	 *
	 * The registration must have ended *and* the OS must agree that its
	 * process no longer exists. An unknown registration, a live process and an
	 * inconclusive liveness answer all refuse.
	 */
	proveOwnerDead(owner: Pick<OwnerIdentity, "instanceId" | "generation" | "sessionId">, now: number):
		{ ok: true; proof: OwnerDeathProof } | { ok: false; reason: string };
	/** Read surface: the holds currently gating execution in this project. */
	holds(): Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }>;
	/** Read surface: the project's work rows, for context listings. */
	works(): Array<{ workId: string; revision: number; state: string; round: number | null; recordJson: string }>;
	confirmReceipt(input: Parameters<typeof confirmReceipt>[1]): { kind: "committed" | "mismatch"; reason?: string };
	commitFailed(input: Parameters<typeof commitFailed>[1]): void;
	requestCancel(input: Parameters<typeof requestCancel>[1]): {
		kind: "cancelled";
		dispatchState: string;
		sendCancel: boolean;
	};
}

/** Optional inspect sections; unrequested arrays come back empty. */
export interface QueueInclude {
	sessions?: boolean;
	works?: boolean;
	diagnostics?: boolean;
}

/**
 * Execution lifecycle commands.
 *
 * The lifetime of one attempt spans several processes and must survive a crash
 * between any two statements, so each transition is a single transaction that
 * records the evidence a later recovery needs. The ordering that matters:
 *
 *  - arm happens *before* the prompt is sent and is the only place an attempt
 *    becomes `possibly_sent`; whoever loses that CAS sends nothing;
 *  - the first terminal outcome wins and is never overwritten by a later
 *    end_turn, cancellation or shutdown;
 *  - the receipt is written as a file first and confirmed here second, so a
 *    resource is released only after the evidence that justifies releasing it
 *    is provably on disk.
 */

/** Immutable identity of one attempt, fixed at arm time. */
export interface ExecutionToken {
	attemptId: string;
	executorInstance: string;
	issuedAt: number;
}

/** Result of claiming the right to send exactly one prompt. */
export type ArmOutcome =
	| { kind: "armed"; attemptId: string; token: ExecutionToken; promptSha256: string; sessionId: string }
	| {
			kind: "lost";
			/**
			 * Why the caller may not send.
			 *
			 * `already_armed` is a benign race (another process won this instant and
			 * is about to send); `already_sent` means the round was armed earlier and
			 * may already have been delivered, which requires recovery rather than a
			 * retry. Collapsing the two would make a resumed-after-crash round look
			 * like a harmless loss and invite a re-send.
			 */
			reason: "already_armed" | "already_sent" | "not_queued" | "authorization_changed" | "cancelled" | "execution_identity_mismatch" | "correction_not_reserved";
	  };

/**
 * Marks the attempt as possibly sent and binds it to an immutable token.
 *
 * This is the only place a round may leave `not_sent`. Everything the send needs
 * (which session, which prompt bytes, which authorization) is verified here, and
 * the CAS makes exactly one caller win: a second process, a retry after a
 * reconnect, or a duplicate submission finds `possibly_sent` and sends nothing.
 */
export function armPrompt(
	db: Database,
	input: {
		taskId: string;
		round: number;
		attemptId: string;
		sessionId: string;
		promptSha256: string;
		/** Authorization the caller believes it holds; compared, never trusted. */
		authorization: { packageId: string; authorizationId: string; revision: number } | null;
		now: number;
	},
): ArmOutcome {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			return { kind: "lost", reason: "not_queued" };
		}
		if (row.cancel_requested === 1) {
			return { kind: "lost", reason: "cancelled" };
		}
		// The stored attempt must be the one this caller was granted by `claim`.
		if (row.attempt_id !== input.attemptId) {
			return { kind: "lost", reason: "already_armed" };
		}
		if (row.dispatch_state !== "not_sent") {
			// The payload may have reached the worker already; the caller must recover,
			// not resend.
			return { kind: "lost", reason: "already_sent" };
		}
		if (row.selected_session !== input.sessionId || row.phase !== "preparing") {
			return { kind: "lost", reason: "execution_identity_mismatch" };
		}
		// A round admitted under a package must still be under that same
		// authorization when the prompt is about to leave.
		if (input.authorization !== null) {
			const storedPackage = row.package_id as string | null;
			const storedAuthorization = row.authorization_id as string | null;
			const storedRevision = row.authorization_revision as number | null;
			if (
				storedPackage !== input.authorization.packageId ||
				storedAuthorization !== input.authorization.authorizationId ||
				storedRevision !== input.authorization.revision
			) {
				return { kind: "lost", reason: "authorization_changed" };
			}
			const authorization = db
				.query(
					`SELECT revoked_at FROM package_authorizations
					 WHERE authorization_id = ? AND package_id = ? AND revision = ?`,
				)
				.get(input.authorization.authorizationId, input.authorization.packageId, input.authorization.revision) as
				| { revoked_at: number | null }
				| null;
			if (authorization === null || authorization.revoked_at !== null) {
				return { kind: "lost", reason: "authorization_changed" };
			}
		}
		if (row.purpose === "rework") {
			const correction = db.query(
				"SELECT state FROM task_corrections WHERE task_id = ? AND review_id = ?",
			).get(input.taskId, row.rework_of_review_id as string) as { state: string } | null;
			if (correction?.state !== "reserved") {
				return { kind: "lost", reason: "correction_not_reserved" };
			}
		}

		const token: ExecutionToken = {
			attemptId: input.attemptId,
			executorInstance: String(row.executor_instance),
			issuedAt: input.now,
		};
		// Arming is the point of no return for three facts at once: the payload may have
		// left (`possibly_sent`), the round is now actually in flight (`running`), and the
		// human's approval has been spent (`approval_consumed`). Writing only the first
		// left a live round reporting `queued` to every reader, and left a spent grant
		// looking unused, so a later resume could not tell a fresh round from a re-arm.
		const updated = db.run(
			`UPDATE rounds SET dispatch_state = 'possibly_sent', status = 'running',
				approval_consumed = 1, selected_session = ?,
				execution_token_json = ?, updated_at = ?, revision = revision + 1
			 WHERE task_id = ? AND round = ? AND attempt_id = ? AND dispatch_state = 'not_sent'
			   AND cancel_requested = 0 AND approval_consumed = 0`,
			[input.sessionId, JSON.stringify(token), input.now, input.taskId, input.round, input.attemptId],
		);
		if (updated.changes !== 1) {
			// Someone else moved the row between the read and the write.
			return { kind: "lost", reason: "already_armed" };
		}
		if (row.purpose === "rework") {
			db.run(
				"UPDATE task_corrections SET state = 'consumed', updated_at = ? WHERE task_id = ? AND review_id = ? AND state = 'reserved'",
				[input.now, input.taskId, row.rework_of_review_id as string],
			);
		}
		// The prompt may now leave: the context is definitely not clean anymore.
		// The ledger records that permanently, so no unrelated task is ever sent
		// into this conversation.
		db.run("UPDATE session_usage SET state = 'used' WHERE session_id = ?", [input.sessionId]);
		return {
			kind: "armed",
			attemptId: input.attemptId,
			token,
			promptSha256: input.promptSha256,
			sessionId: input.sessionId,
		};
	});
}

/** Keeps the queryable scope state and its public record at the same revision. */
function setRoundWorkState(db: Database, taskId: string, round: number, state: "waiting" | "blocked" | "released", now: number): void {
	const works = db.query(
		"SELECT work_id, state, revision, record_json FROM works WHERE task_id = ? AND round = ?",
	).all(taskId, round) as Array<{ work_id: string; state: string; revision: number; record_json: string }>;
	for (const work of works) {
		if ((work.state === "released" && state !== "waiting") || work.state === state || (state === "blocked" && work.state === "waiting")) {
			continue;
		}
		const record: unknown = JSON.parse(work.record_json);
		if (typeof record !== "object" || record === null || Array.isArray(record)) {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Invalid scope record ${work.work_id}`);
		}
		const revision = work.revision + 1;
		db.run("UPDATE works SET state = ?, revision = ?, record_json = ? WHERE work_id = ?", [
			state,
			revision,
			JSON.stringify({ ...record, state, revision, updatedAt: new Date(now).toISOString() }),
			work.work_id,
		]);
	}
}

function releaseRoundResources(db: Database, taskId: string, round: number, now: number): void {
	db.run("DELETE FROM holds WHERE task_id = ? AND round = ?", [taskId, round]);
	setRoundWorkState(db, taskId, round, "released", now);
}

/** A resolved prompt outcome is end evidence; socket errors and local commits are not. */
export function recordExecutionEnd(
	db: Database,
	input: { taskId: string; round: number; attemptId: string; sessionId: string; now: number },
): { kind: "recorded" | "refused"; reason?: string } {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null || row.attempt_id !== input.attemptId || row.selected_session !== input.sessionId) {
			return { kind: "refused", reason: "execution_identity_mismatch" };
		}
		if (row.dispatch_state !== "possibly_sent" && row.dispatch_state !== "ended") {
			return { kind: "refused", reason: "execution_was_not_armed" };
		}
		if (row.dispatch_state !== "ended") {
			db.run(
				"UPDATE rounds SET dispatch_state = 'ended', execution_end_json = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND round = ?",
				[
					JSON.stringify({ source: "prompt_outcome", attemptId: input.attemptId, sessionId: input.sessionId, at: new Date(input.now).toISOString() }),
					input.now, input.taskId, input.round,
				],
			);
		}
		if (row.commit_state === "committed") {
			releaseRoundResources(db, input.taskId, input.round, input.now);
			db.run("UPDATE rounds SET phase = 'terminal' WHERE task_id = ? AND round = ?", [input.taskId, input.round]);
		}
		return { kind: "recorded" };
	});
}

/** The first terminal outcome of one round, as committed. */
export interface TerminalOutcome {
	status: "completed" | "failed" | "cancelled" | "interrupted";
	errorJson: string | null;
	outcomeJson: string;
}

/**
 * Records the first terminal outcome for a round.
 *
 * First writer wins: a late `end_turn` after a cancellation, or a shutdown after
 * a completion, joins the existing outcome instead of replacing it. The worker's
 * own result is never overwritten by a later local decision, which is what keeps
 * "the work finished" and "we stopped waiting" as separate facts.
 */
export function beginTerminal(
	db: Database,
	input: { taskId: string; round: number; outcome: TerminalOutcome; now: number },
): { kind: "applied" | "unchanged"; status: string } {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `No round ${input.round} for task ${input.taskId}`);
		}
		if (row.outcome_json !== null) {
			// Already decided; the caller learns which outcome it must respect.
			return { kind: "unchanged", status: row.status as string };
		}
		db.run(
			`UPDATE rounds SET status = ?, phase = 'committing', outcome_json = ?,
				revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ? AND outcome_json IS NULL`,
			[
				input.outcome.status,
				input.outcome.outcomeJson,
				input.now,
				input.taskId,
				input.round,
			],
		);
		return { kind: "applied", status: input.outcome.status };
	});
}

/**
 * Confirms that the receipt for a committed outcome is durably on disk.
 *
 * Only this transition releases the execution hold and the scope: a task whose
 * receipt could not be written keeps its resources, because releasing them would
 * let another task write into a directory whose owner is not yet recorded. The
 * commit state therefore stays `failed` and the failure stays visible.
 *
 * The authorization is enforced *here*, inside the same transaction that
 * commits the receipt, not in a preflight somewhere else. A preflight can be
 * raced: the round may change between the check and the commit, and the
 * consent the human gave was for the round as it was when they gave it. Here
 * the subject is recomputed from the row and compared, so a round that changed
 * invalidates the consent instead of being silently adopted.
 *
 * Two authorizations are accepted:
 *
 *  - `owner`: the round's own owner. This is the ordinary terminal commit and
 *    it needs no extra grant — the round's owner row is already the authority.
 *  - `operator_recovery`: a *different* human recovering a round whose
 *    original owner is provably gone. It carries the actual operator, the
 *    original owner, the death proof, the exact subject and the human's
 *    one-shot consent, and it is recorded in the same transaction.
 */
export function confirmReceipt(
	db: Database,
	input: {
		taskId: string;
		round: number;
		receiptSha256: string;
		commitToken: { requestId: string; resultRevision: number };
		now: number;
		/**
		 * Who is committing. Required: a commit without an authorization is
		 * refused rather than treated as "the owner", because "nobody said so"
		 * and "the owner said so" are different facts.
		 */
		authorization?: ReceiptAuthorization;
	},
): { kind: "committed" | "mismatch"; reason?: string } {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `No round ${input.round} for task ${input.taskId}`);
		}
		if (row.status === "queued" || row.outcome_json === null) {
			return { kind: "mismatch", reason: "no terminal outcome to commit" };
		}
		if (row.request_id !== input.commitToken.requestId) {
			// A confirmation for a different request must not commit this round.
			return { kind: "mismatch", reason: "commit token names a different request" };
		}
		// The fence must name the revision this commit is being applied to, and the
		// digest must be the one already recorded for a receipt. Without the second
		// check any digest would commit, which is the difference between "a receipt
		// exists" and "this receipt is the evidence".
		if (row.receipt_sha256 !== null && row.receipt_sha256 !== input.receiptSha256) {
			return {
				kind: "mismatch",
				reason: "a different receipt digest was already recorded for this round",
			};
		}
		if (row.commit_state !== "committed" && Number(row.revision) !== input.commitToken.resultRevision) {
			return { kind: "mismatch", reason: "commit token names a stale result revision" };
		}
		// The authorization is checked before anything is written, and a refusal
		// writes nothing at all: the round keeps its failed commit state and its
		// resources, because a refused recovery proved nothing.
		//
		// No authorization at all is the ordinary terminal commit: the round's own
		// owner row is already the authority for it, exactly as it was before
		// recovery existed.
		const authorization = input.authorization;
		let audit: RecoveryAudit | null = null;
		if (authorization !== undefined && authorization.kind === "owner") {
			// The committing identity must still be the round's own originating
			// session and an active registration. A generation retired while the
			// receipt was being written must not still commit it, but a later
			// generation of the *same* originating session is its legal
			// successor and may commit it.
			if (
				row.owner_session !== authorization.owner.sessionId ||
				!isOwnerActive(db, authorization.owner)
			) {
				return { kind: "mismatch", reason: "Only an active originating OMP identity may commit this receipt" };
			}
		} else if (authorization !== undefined && authorization.kind === "operator_recovery") {
			const verified = verifyRecoveryAuthorization(db, row, authorization.recovery, input.now);
			if (!verified.ok) {
				return { kind: "mismatch", reason: verified.reason };
			}
			audit = recoveryAudit(authorization.recovery, input.now);
		}
		const updated = db.run(
			`UPDATE rounds SET commit_state = 'committed', phase = ?, receipt_sha256 = ?,
				storage_error_json = NULL, result_revision = ?, receipt_recovery_json = ?,
				revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ? AND commit_state != 'committed'`,
			[
				row.dispatch_state === "possibly_sent" ? "recovery_required" : "terminal",
				input.receiptSha256,
				input.commitToken.resultRevision,
				audit === null
					? (typeof row.receipt_recovery_json === "string" ? row.receipt_recovery_json : null)
					: JSON.stringify(audit),
				input.now,
				input.taskId,
				input.round,
			],
		);
		if (updated.changes !== 1 && row.commit_state !== "committed") {
			return { kind: "mismatch", reason: "commit did not apply" };
		}
		if (row.dispatch_state === "possibly_sent") {
			// A committed local result cannot certify that the remote execution stopped.
			db.run("UPDATE holds SET kind = 'quarantine' WHERE task_id = ? AND round = ?", [input.taskId, input.round]);
			setRoundWorkState(db, input.taskId, input.round, "blocked", input.now);
		} else {
			releaseRoundResources(db, input.taskId, input.round, input.now);
		}
		return { kind: "committed" };
	});
}

/**
 * Records that the receipt could not be written.
 *
 * The outcome is preserved and the resources are deliberately kept: an unproven
 * write is not evidence that the directory is free. The round is not left looking
 * like it is still running either — the phase says the commit failed.
 */
export function commitFailed(
	db: Database,
	input: { taskId: string; round: number; errorJson: string; now: number },
): void {
	withImmediate(db, () => {
		db.run(
			`UPDATE rounds SET commit_state = 'failed', phase = 'recovery_required',
				storage_error_json = ?, revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ?`,
			[input.errorJson, input.now, input.taskId, input.round],
		);
		db.run("UPDATE holds SET kind = 'quarantine' WHERE task_id = ? AND round = ?", [input.taskId, input.round]);
		setRoundWorkState(db, input.taskId, input.round, "blocked", input.now);
	});
}


/**
 * The project's work rows, projected for read surfaces.
 *
 * `works` rows are the queue's scope records; a reader that cannot see them cannot show
 * which work is occupying the project, which is exactly what a context listing is for.
 */
export function readWorks(
	db: Database,
): Array<{ workId: string; revision: number; state: string; round: number | null; recordJson: string }> {
	// `works` has no timestamp column of its own: the record it carries does, and an
	// invented column would only fail at read time.
	const rows = db
		.query("SELECT work_id, revision, state, round, record_json FROM works ORDER BY work_id")
		.all() as Array<{
		work_id: string;
		revision: number;
		state: string;
		round: number | null;
		record_json: string;
	}>;
	return rows.map((row) => ({
		workId: row.work_id,
		revision: row.revision,
		state: row.state,
		round: row.round,
		recordJson: row.record_json,
	}));
}

/**
 * Every hold this project currently records.
 *
 * Exposed on the facade because it is a *read surface*: `holds` gate execution and
 * are the replacement for the file lock, so a diagnosis that cannot see them would
 * report a wedged WorkBuddy session as free.
 */
export function readHolds(db: Database): Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }> {
	const rows = db
		.query("SELECT session_id, task_id, round, kind FROM holds ORDER BY session_id")
		.all() as Array<{ session_id: string; task_id: string | null; round: number | null; kind: string }>;
	return rows.map((row) => ({ sessionId: row.session_id, taskId: row.task_id, round: row.round, kind: row.kind }));
}

export type RecoveryRelease =
	| { kind: "released"; clearedHolds: number }
	| { kind: "not_found"; clearedHolds: 0 }
	| { kind: "refused"; clearedHolds: 0; reason: string };

/**
 * Releases one quarantined execution after a human observed that it stopped.
 *
 * A release is a *separate* human act from the repair that committed the
 * receipt. The receipt proves what the round decided; it proves nothing about
 * whether the remote worker is still running. So the release needs its own
 * end observation, and it must not be inferred from a repaired receipt.
 *
 * The authorization is enforced inside the same transaction that clears the
 * hold: the operator must be an active registration, the exact subject must
 * still describe the round, and the one-shot consent must cover it. A round
 * that changed since the human answered invalidates the consent instead of
 * being silently released.
 */
export function releaseQuarantine(
	db: Database,
	input: {
		taskId: string;
		round: number;
		sessionId: string;
		/**
		 * Who is releasing, and on whose observation.
		 *
		 * The union is required: a release is either the originating session
		 * releasing its own round (`owner_release`) or a different human
		 * releasing a round whose original owner is provably gone
		 * (`quarantine_release`). There is no third, looser shape — a release
		 * without an explicit authorization is refused.
		 */
		authorization: QuarantineReleaseAuthorization;
		now: number;
	},
): RecoveryRelease {
	return withImmediate(db, () => {
		const hold = db.query(
			"SELECT session_id, task_id, round, kind FROM holds WHERE task_id = ? AND round = ? AND session_id = ?",
		).get(input.taskId, input.round, input.sessionId) as { session_id: string; task_id: string; round: number; kind: string } | null;
		if (hold === null) {
			return { kind: "not_found", clearedHolds: 0 };
		}
		const row = readRound(db, input.taskId, input.round);
		if (hold.kind !== "quarantine" || row === null || row.phase !== "recovery_required" || row.outcome_json === null) {
			return { kind: "refused", clearedHolds: 0, reason: "execution_is_not_quarantined" };
		}
		if (row.commit_state !== "committed") {
			return { kind: "refused", clearedHolds: 0, reason: "repair_receipt_commit_before_release" };
		}
		const authorization = input.authorization;
		if (authorization === undefined) {
			return { kind: "refused", clearedHolds: 0, reason: "human_end_verification_required" };
		}
		if (authorization.kind === "owner_release") {
			// The originating session releases its own round. Its authority is
			// the round's owner row, exactly as it always was; the human's end
			// observation is still required, because a receipt never proves that
			// the worker stopped.
			const verification = authorization.verification;
			if (
				verification?.source !== "host_dialog" ||
				typeof verification.at !== "string" || !Number.isFinite(Date.parse(verification.at)) ||
				typeof verification.evidence !== "string" || verification.evidence.trim().length === 0 ||
				authorization.owner?.sessionId !== row.owner_session ||
				!isOwnerActive(db, authorization.owner)
			) {
				return { kind: "refused", clearedHolds: 0, reason: "human_end_verification_required" };
			}
			db.run(
				`UPDATE rounds SET dispatch_state = 'ended', execution_end_json = ?, phase = 'terminal',
					updated_at = ?, revision = revision + 1 WHERE task_id = ? AND round = ?`,
				[
					JSON.stringify({
						source: "host_dialog",
						at: verification.at,
						evidence: verification.evidence,
						operator: authorization.owner,
						originalOwner: authorization.owner,
					}),
					input.now,
					input.taskId,
					input.round,
				],
			);
			releaseRoundResources(db, input.taskId, input.round, input.now);
			return { kind: "released", clearedHolds: 1 };
		}
		const observation = authorization.endObservation;
		if (
			observation?.source !== "host_dialog" ||
			typeof observation.at !== "string" || !Number.isFinite(Date.parse(observation.at)) ||
			typeof observation.evidence !== "string" || observation.evidence.trim().length === 0
		) {
			return { kind: "refused", clearedHolds: 0, reason: "human_end_verification_required" };
		}
		const operator = authorization.operator;
		if (operator === undefined || !isOwnerActive(db, operator)) {
			return { kind: "refused", clearedHolds: 0, reason: "human_end_verification_required" };
		}
		const originalOwner = authorization.originalOwner;
		if (
			originalOwner === undefined ||
			row.owner_session !== originalOwner.sessionId ||
			row.owner_generation !== originalOwner.generation ||
			row.executor_instance !== originalOwner.instanceId
		) {
			return { kind: "refused", clearedHolds: 0, reason: "the round does not belong to the original owner named in the release" };
		}
		// The original owner may only be released for by somebody else when that
		// owner is provably gone; its own session releases its own round
		// through the ordinary path.
		if (originalOwner.sessionId !== operator.sessionId) {
			const death = proveOwnerDead(db, originalOwner, input.now);
			if (!death.ok) {
				return { kind: "refused", clearedHolds: 0, reason: `the original owner is not provably gone: ${death.reason}` };
			}
			const carried = authorization.deathProof;
			if (
				carried === null || carried === undefined ||
				carried.sessionId !== originalOwner.sessionId ||
				carried.generation !== originalOwner.generation ||
				carried.instanceId !== originalOwner.instanceId ||
				carried.processId !== death.proof.processId ||
				originalOwner.processId !== death.proof.processId ||
				carried.pidGone !== true
			) {
				return { kind: "refused", clearedHolds: 0, reason: "the release carries no valid death proof for the original owner" };
			}
		}
		// The subject is recomputed from the row as it is now. A release must
		// name the committed receipt digest, so a round whose receipt changed
		// invalidates the consent.
		const current = readRecoverySubject(db, input.taskId, input.round);
		if (current === null) {
			return { kind: "refused", clearedHolds: 0, reason: "the round no longer carries a recorded first outcome" };
		}
		const committedReceipt = row.receipt_sha256;
		if (typeof committedReceipt !== "string" || committedReceipt.length === 0) {
			return { kind: "refused", clearedHolds: 0, reason: "repair_receipt_commit_before_release" };
		}
		const currentSubject: RecoverySubject = { ...current, receiptSha256: committedReceipt };
		if (!sameRecoverySubject(currentSubject, authorization.subject)) {
			return { kind: "refused", clearedHolds: 0, reason: "the round changed after the operator's confirmation; the release is no longer about this round" };
		}
		if (!consentMatchesSubject(authorization.consent, currentSubject)) {
			return { kind: "refused", clearedHolds: 0, reason: "the operator's confirmation does not cover this exact round" };
		}
		// The end observation is recorded with the operator, the original owner
		// and the death proof, so the audit answers who released it and on what
		// evidence — not merely that somebody pressed a button.
		const endRecord = {
			source: "host_dialog" as const,
			at: observation.at,
			evidence: observation.evidence,
			operator,
			originalOwner,
			deathProof: authorization.deathProof,
			subject: currentSubject,
			consent: authorization.consent,
			requestedAt: authorization.requestedAt,
		};
		db.run(
			`UPDATE rounds SET dispatch_state = 'ended', execution_end_json = ?, phase = 'terminal',
				updated_at = ?, revision = revision + 1 WHERE task_id = ? AND round = ?`,
			[JSON.stringify(endRecord), input.now, input.taskId, input.round],
		);
		releaseRoundResources(db, input.taskId, input.round, input.now);
		return { kind: "released", clearedHolds: 1 };
	});
}

/** One round abandoned by an owner this process proved dead. */
export interface AbandonedRound {
	taskId: string;
	round: number;
	sessionId: string;
	/** `requeued` when nothing was sent, `quarantined` when a prompt may have left. */
	action: "requeued" | "quarantined";
}

/**
 * Recovers rounds left behind by an owner that is provably gone.
 *
 * `rollbackClaim` only runs in the process that took the claim, and `session_shutdown`
 * only finalizes tasks that process still tracks — so a crash after `claim` leaves the
 * WorkBuddy session hold behind forever, and every later round in the project reports
 * `session_busy` with no way out. This is the startup sweep that closes that hole.
 *
 * Only provably dead owners are touched, and the split is by evidence, not by
 * optimism: a round still at `not_sent` never reached the worker, so it returns to the
 * queue; a round that may have been sent is quarantined instead, because resending it
 * could duplicate work that is still happening somewhere.
 *
 * `isAlive` is injected so a caller cannot accidentally treat "this process does not
 * know the owner" as "the owner died"; the default consults the OS.
 */
export function reconcileAbandonedRounds(
	db: Database,
	input: { now: number; isAlive?: (pid: number) => boolean },
): AbandonedRound[] {
	const isAlive = input.isAlive ?? isPidAlive;
	return withImmediate(db, () => {
		const owners = db
			.query("SELECT instance_id, generation, pid, state FROM owners")
			.all() as Array<{ instance_id: string; generation: string; pid: number; state: string }>;
		// One activation, one generation: two activations of the same OMP process share an
		// instance id and differ only by generation, so the pair is the unit that can be
		// declared dead. Matching the instance alone would release a session whose prompt
		// is still running under a live generation.
		const dead = new Set<string>();
		for (const owner of owners) {
			// A generation this process retired is gone by declaration; otherwise the OS has
			// to agree that its pid no longer exists.
			const provablyDead = owner.state !== "active" || !isAlive(owner.pid);
			if (!provablyDead) {
				continue;
			}
			dead.add(`${owner.instance_id}::${owner.generation}`);
			if (owner.state === "active") {
				db.run("UPDATE owners SET state = 'dead' WHERE instance_id = ? AND generation = ?", [
					owner.instance_id,
					owner.generation,
				]);
			}
		}
		if (dead.size === 0) {
			return [];
		}
		const rows = db
			.query(`SELECT * FROM rounds r WHERE attempt_id IS NOT NULL AND (
				outcome_json IS NULL OR commit_state = 'pending' OR
				(commit_state = 'failed' AND EXISTS (
					SELECT 1 FROM holds h WHERE h.task_id = r.task_id AND h.round = r.round AND h.kind != 'quarantine'
				))
			)`)
			.all() as Array<Record<string, unknown>>;
		const recovered: AbandonedRound[] = [];
		for (const row of rows) {
			const taskId = String(row.task_id);
			const round = Number(row.round);
			// Exact pair: `enqueue` recorded the generation that authorized this round, and
			// `executor_instance` names who ran it. Both must belong to a generation proven
			// dead before anything is touched.
			if (!dead.has(`${String(row.executor_instance ?? "")}::${String(row.owner_generation ?? "")}`)) {
				continue;
			}
			const sessionId = String(row.selected_session ?? row.owner_session ?? "");
			if (row.outcome_json !== null) {
				// Preserve the known first business result. Only the unfinished commit
				// needs recovery; never turn it into a new unknown-execution outcome.
				db.run(
					`UPDATE rounds SET phase = 'recovery_required', commit_state = 'failed',
						storage_error_json = COALESCE(storage_error_json, ?), revision = revision + 1, updated_at = ?
					 WHERE task_id = ? AND round = ?`,
					[
						JSON.stringify({ code: WB_ERROR_CODE.storageError, message: "Owner exited before its result commit was proven; repair the receipt without resending work" }),
						input.now, taskId, round,
					],
				);
				db.run("UPDATE holds SET kind = 'quarantine' WHERE task_id = ? AND round = ?", [taskId, round]);
				setRoundWorkState(db, taskId, round, "blocked", input.now);
				recovered.push({ taskId, round, sessionId, action: "quarantined" });
				continue;
			}
			if (row.dispatch_state === "not_sent") {
				db.run("DELETE FROM holds WHERE task_id = ? AND round = ?", [taskId, round]);
				db.run(
					`UPDATE rounds SET phase = 'queued', attempt_id = NULL, executor_instance = NULL,
						execution_token_json = NULL, selected_session = NULL, revision = revision + 1, updated_at = ?
					 WHERE task_id = ? AND round = ?`,
					[input.now, taskId, round],
				);
				setRoundWorkState(db, taskId, round, "waiting", input.now);
				recovered.push({ taskId, round, sessionId, action: "requeued" });
			} else {
				// A prompt may be running somewhere. The round keeps its hold and scope so
				// nothing else writes alongside it, and reads as needing a human decision.
				db.run(
					`UPDATE rounds SET status = 'interrupted', phase = 'recovery_required',
						commit_state = 'failed', outcome_json = ?,
						storage_error_json = ?, revision = revision + 1, updated_at = ?
					 WHERE task_id = ? AND round = ? AND outcome_json IS NULL`,
					[
						JSON.stringify({ status: "interrupted", reason: "owner_died_after_send" }),
						JSON.stringify({
							code: "WB_TASK_INTERRUPTED",
							message: "The owning process died after this round may have been sent; verify the worker before resending",
						}),
						input.now,
						taskId,
						round,
					],
				);
				db.run("UPDATE holds SET kind = 'quarantine' WHERE task_id = ? AND round = ?", [taskId, round]);
				setRoundWorkState(db, taskId, round, "blocked", input.now);
				recovered.push({ taskId, round, sessionId, action: "quarantined" });
			}
		}
		return recovered;
	});
}

/** Transfers only provably unsent work to a successor of the same originating OMP session. */
export function adoptUnsentRounds(
	db: Database,
	input: { owner: OwnerIdentity; now: number; isAlive?: (pid: number) => boolean },
): number {
	const isAlive = input.isAlive ?? isPidAlive;
	return withImmediate(db, () => {
		if (!isOwnerActive(db, input.owner)) {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "Successor must register its active owner identity first");
		}
		const rows = db.query(
			`SELECT r.task_id, r.round, r.owner_generation, o.state, o.pid
			 FROM rounds r JOIN owners o ON o.session_id = r.owner_session AND o.generation = r.owner_generation
			 WHERE r.owner_session = ? AND r.owner_generation != ?
			   AND r.status = 'queued' AND r.phase = 'queued' AND r.dispatch_state = 'not_sent'
			   AND r.outcome_json IS NULL AND r.cancel_requested = 0 AND r.attempt_id IS NULL`,
		).all(input.owner.sessionId, input.owner.generation) as Array<{
			task_id: string; round: number; owner_generation: string; state: string; pid: number;
		}>;
		let adopted = 0;
		for (const row of rows) {
			if (row.state === "active" && isAlive(row.pid)) {
				continue;
			}
			const changed = db.run(
				`UPDATE rounds SET owner_generation = ?, revision = revision + 1, updated_at = ?
				 WHERE task_id = ? AND round = ? AND owner_generation = ? AND dispatch_state = 'not_sent'
				   AND outcome_json IS NULL AND attempt_id IS NULL`,
				[input.owner.generation, input.now, row.task_id, row.round, row.owner_generation],
			);
			adopted += changed.changes;
			// Manifest/approval bytes still name the original human-authorized owner.
			// Only the execution/follow-through generation changes here.
		}
		return adopted;
	});
}

/**
 * Returns a claimed round to the queue without deciding its outcome.
 *
 * A claim takes the WorkBuddy session hold and the scope before the prompt is
 * armed. If anything fails in that window — an unreadable manifest, a session that
 * is not running, an arm that loses its race — the round was never delivered, so it
 * is a requeue, not a failure. Leaving the hold in place would make that session
 * permanently `session_busy` for every later round in the project, which is the
 * worst possible outcome for a transient error.
 *
 * Refuses after `possibly_sent`: at that point a prompt may have reached the worker,
 * and resending it would duplicate the work.
 */
export function rollbackClaim(
	db: Database,
	input: { taskId: string; round: number; attemptId: string; reason: string; now: number },
): { kind: "requeued" | "refused"; reason?: string } {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			return { kind: "refused", reason: "not_found" };
		}
		if (row.attempt_id !== input.attemptId) {
			// A different attempt owns the row now; its claim must not be undone here.
			return { kind: "refused", reason: "attempt_changed" };
		}
		if (row.dispatch_state !== "not_sent") {
			return { kind: "refused", reason: "possibly_sent" };
		}
		if (row.commit_state === "committed" || row.outcome_json !== null) {
			return { kind: "refused", reason: "already_decided" };
		}
		db.run("DELETE FROM holds WHERE task_id = ? AND round = ?", [input.taskId, input.round]);
		db.run(
			`UPDATE rounds SET phase = 'queued', attempt_id = NULL, executor_instance = NULL,
				execution_token_json = NULL, selected_session = NULL, revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ? AND attempt_id = ? AND dispatch_state = 'not_sent'`,
			[input.now, input.taskId, input.round, input.attemptId],
		);
		setRoundWorkState(db, input.taskId, input.round, "waiting", input.now);
		return { kind: "requeued" };
	});
}

/**
 * Records a cancellation request.
 *
 * The outcome is decided here so a turn that finishes afterwards cannot claim
 * success. Sending evidence is separate; even an unsent cancellation keeps its
 * resources until the terminal receipt is durably confirmed.
 */
export function requestCancel(
	db: Database,
	input: { taskId: string; round: number; now: number; reason: string },
): { kind: "cancelled"; dispatchState: string; sendCancel: boolean } {
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			throw new WbTaskError(WB_ERROR_CODE.taskNotFound, `No round ${input.round} for task ${input.taskId}`);
		}
		const dispatchState = row.dispatch_state as string;
		const alreadyTerminal = row.outcome_json !== null;
		db.run(
			`UPDATE rounds SET cancel_requested = 1, revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ?`,
			[input.now, input.taskId, input.round],
		);
		if (!alreadyTerminal) {
			// Deciding the result is not committing its receipt. The host writes and
			// verifies that receipt before confirmReceipt releases an unsent claim.
			db.run(
				`UPDATE rounds SET status = 'cancelled', phase = 'committing', outcome_json = ?,
					revision = revision + 1, updated_at = ?
				 WHERE task_id = ? AND round = ? AND outcome_json IS NULL`,
				[
					JSON.stringify({ status: "cancelled", reason: input.reason }),
					input.now,
					input.taskId,
					input.round,
				],
			);
		}
		// A cancellation of a round that was never armed is the one case where a
		// reserved context is provably untouched: no prompt could have left it.
		// The reservation is released so the context can serve an unrelated task
		// again. A round that was armed keeps its context for good — the
		// conversation may still hold that work.
		//
		// The affinity goes with the reservation: the task never used that
		// conversation, so keeping the pin would tie it to a context that is now
		// serving somebody else.
		if (dispatchState === "not_sent") {
			const usage = db
				.query("SELECT session_id, state FROM session_usage WHERE task_id = ?")
				.get(input.taskId) as { session_id: string; state: string } | null;
			if (usage !== null && usage.state === "reserved") {
				db.run("DELETE FROM session_usage WHERE session_id = ? AND task_id = ? AND state = 'reserved'", [
					usage.session_id,
					input.taskId,
				]);
				db.run("DELETE FROM task_sessions WHERE task_id = ? AND session_id = ?", [input.taskId, usage.session_id]);
			}
		}
		return {
			kind: "cancelled" as const,
			dispatchState,
			// A prompt that could have been sent needs the worker told; one that never
			// left needs nothing, and telling an unknown session would be a guess.
			sendCancel: dispatchState === "possibly_sent",
		};
	});
}


/** Stable delivery id for one fact, so re-notifying the same fact is idempotent. */
export function outboxDeliveryId(requestId: string, kind: "result" | "recovery", revision: number): string {
	return `${requestId}:${kind}:${revision}`;
}

/**
 * Enqueues one notification.
 *
 * Idempotent on the derived id: a second enqueue for the same fact returns the
 * existing row unchanged, so a retried publish cannot wake a consumer twice.
 */
export function enqueueOutbox(
	db: Database,
	input: {
		requestId: string;
		kind: "result" | "recovery";
		revision: number;
		owner: OwnerIdentity;
	},
): { kind: "created" | "existing"; deliveryId: string } {
	const deliveryId = outboxDeliveryId(input.requestId, input.kind, input.revision);
	return withImmediate(db, () => {
		const existing = db
			.query("SELECT delivery_id FROM outbox WHERE delivery_id = ?")
			.get(deliveryId) as { delivery_id: string } | null;
		if (existing !== null) {
			return { kind: "existing" as const, deliveryId };
		}
		// `owner_generation` is the *intended recipient*; `claimed_generation` (set at
		// claim time) is who actually took it. They start equal and diverge only when
		// a re-route hands the row to a successor.
		db.run(
			`INSERT INTO outbox(delivery_id, request_id, kind, revision, owner_session, owner_generation)
			 VALUES(?, ?, ?, ?, ?, ?)`,
			[deliveryId, input.requestId, input.kind, input.revision, input.owner.sessionId, input.owner.generation],
		);
		return { kind: "created" as const, deliveryId };
	});
}

/** One claimed notification, as returned to the sender. */
export interface OutboxClaim {
	deliveryId: string;
	requestId: string;
	kind: "result" | "recovery";
	revision: number;
}

/**
 * Claims pending notifications for one followup generation.
 *
 * Three rules, all expressed in the one predicate:
 *
 *  - an unclaimed, unacknowledged row for this session is claimable;
 *  - a row already claimed by *this* generation is returned again, so an attempt
 *    that died mid-send is retryable without inventing a generation;
 *  - a row claimed by a generation that is no longer live is claimable again.
 *
 * The third is what keeps a notification from being durable-but-undeliverable: an
 * owner that retires (session switch, exit) previously left its claims stuck, so a
 * re-claiming generation could never see them. Liveness is read from the owners
 * table rather than inferred, so this re-routes on evidence.
 *
 * Acknowledged rows are never returned, and a row claimed by another *live*
 * generation is left alone.
 */
export function claimOutbox(db: Database, owner: OwnerIdentity, limit: number): OutboxClaim[] {
	const bounded = Math.max(1, Math.min(limit, 100));
	return withImmediate(db, () => {
		const rows = db
			.query(
				`SELECT delivery_id, request_id, kind, revision, claimed_generation, notified_generation
				 FROM outbox
				 WHERE acknowledged_at IS NULL AND owner_session = ?
				 ORDER BY revision ASC, delivery_id ASC`,
			)
			.all(owner.sessionId) as Array<{
			delivery_id: string;
			request_id: string;
			kind: "result" | "recovery";
			revision: number;
			claimed_generation: string | null;
			notified_generation: string | null;
		}>;
		// Liveness cannot be expressed in SQL: a generation is live only while its row
		// says active *and* the process that registered it is still running. Checking
		// the state alone left a crashed process's claim owning the row forever, which
		// is exactly the durable-but-undeliverable hole this exists to close.
		const liveGenerations = new Set<string>();
		const claimed = [...new Set(rows.map((row) => row.claimed_generation).filter((value): value is string => value !== null))];
		for (const generation of claimed) {
			const registration = db
				.query("SELECT state, pid FROM owners WHERE session_id = ? AND generation = ?")
				.get(owner.sessionId, generation) as { state: string; pid: number } | null;
			if (registration !== null && registration.state === "active" && isPidAlive(registration.pid)) {
				liveGenerations.add(generation);
			}
		}
		const claimable = rows.filter((row) => {
			// A row already sent to this session is still claimed, not filtered out: the
			// claim is what lets this generation acknowledge it, while the send phase
			// skips it so a restart never wakes the same conversation twice.
			if (row.claimed_generation === null || row.claimed_generation === owner.generation) {
				// Unclaimed, or claimed by this same generation: a send attempt that died
				// is retryable without inventing a generation.
				return true;
			}
			return !liveGenerations.has(row.claimed_generation);
		});
		const batch = claimable.slice(0, bounded);
		for (const row of batch) {
			db.run(
				`UPDATE outbox SET claimed_by = ?, claimed_generation = ?, claimed_at = ?
				 WHERE delivery_id = ?`,
				[owner.sessionId, owner.generation, Date.now(), row.delivery_id],
			);
		}
		return batch.map((row) => ({
			deliveryId: row.delivery_id,
			requestId: row.request_id,
			kind: row.kind,
			revision: row.revision,
		}));
	});
}

/**
 * Records that a consumer actually acted on a notification.
 *
 * Deliberately separate from claiming and from sending: a delivered message is not
 * an accepted one, and only a real acknowledgement clears the row.
 */
export function ackOutbox(db: Database, deliveryId: string, owner: OwnerIdentity, at: number): { kind: "acked" | "unchanged" } {
	return withImmediate(db, () => {
		// Acknowledgement is fenced by *who currently holds the claim*, not by the
		// generation the row was originally addressed to. After a re-route those
		// differ, and checking the addressee would make a legitimately claimed
		// delivery impossible to acknowledge — the row would be picked up and then
		// stay pending forever.
		const updated = db.run(
			`UPDATE outbox SET acknowledged_at = ?
			 WHERE delivery_id = ? AND acknowledged_at IS NULL AND claimed_generation = ?`,
			[at, deliveryId, owner.generation],
		);
		return updated.changes === 1 ? { kind: "acked" as const } : { kind: "unchanged" as const };
	});
}

/** Reads the pending outbox for display; never claims or acknowledges. */
export function listOutbox(db: Database, limit: number): Array<Record<string, unknown>> {
	return db
		.query(
			`SELECT delivery_id, request_id, kind, revision, owner_session, claimed_generation, acknowledged_at
			 FROM outbox ORDER BY revision ASC, delivery_id ASC LIMIT ?`,
		)
		.all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
}


/**
 * Reads the resource rows that gate one round.
 *
 * Kept separate from `inspect`: the snapshot is shaped for lists and views, while
 * this answers "is this round still holding the session and the scope", which is
 * what release has to be verified against. A receipt that exists while the hold is
 * still present is the N03 contradiction, and only this projection can show it.
 */
export function readRoundResources(
	db: Database,
	taskId: string,
	round: number,
): { holds: Array<{ sessionId: string; kind: string }>; workState: string | null } {
	const holds = db
		.query("SELECT session_id, kind FROM holds WHERE task_id = ? AND round = ?")
		.all(taskId, round) as Array<{ session_id: string; kind: string }>;
	const work = db
		.query("SELECT state FROM works WHERE task_id = ? AND round = ?")
		.get(taskId, round) as { state: string } | null;
	return {
		holds: holds.map((row) => ({ sessionId: row.session_id, kind: row.kind })),
		workState: work?.state ?? null,
	};
}

// ---------------------------------------------------------------------------
// Project pool: roster, durable affinity, and context isolation.
//
// Three facts, kept apart because they have different lifetimes:
//
//  1. The roster (`sessions`) says which WorkBuddy contexts this project is
//     allowed to use and what is known about each right now. It changes on
//     every discovery refresh.
//  2. The affinity (`task_sessions`) says which context one *task* belongs
//     to. It is written once, at claim time, and survives rollback, terminal
//     release and restart. Rework and supplement rounds read it.
//  3. The usage ledger (`session_usage`) says which contexts have already
//     carried a task. It is append-only: a context that has held work is not
//     clean again, and an unrelated task must never be sent into it.
// ---------------------------------------------------------------------------

/** One roster row as the queue stores it. */
interface PoolRow {
	session_id: string;
	role: string;
	title: string;
	identity: string;
	availability: string;
	reason_code: string | null;
	worker_version: string | null;
	enrolled: number;
	ownership_conflict: number;
	observed_at: number;
}

/**
 * Records the authorized roster and the latest observations.
 *
 * The queue owns pool membership, so this is the only place a session becomes
 * eligible for new work. A session that was already enrolled but is not in the
 * incoming roster keeps its row: an offline member is not a removed member,
 * and deleting it would erase the evidence that it was ever authorized.
 *
 * A session whose newly verified metadata contradicts the project's ownership
 * is *quarantined*, not deleted: it stops being a claim target, and its
 * historical task affinity is preserved.
 */
export function syncProjectSessions(
	db: Database,
	sessions: readonly ProjectSessionObservation[],
	now: number,
): void {
	withImmediate(db, () => {
		for (const observation of sessions) {
			if (typeof observation.sessionId !== "string" || observation.sessionId.trim().length === 0) {
				throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "A project session observation needs a session id");
			}
			const availability = observation.availability;
			if (availability !== "idle" && availability !== "busy" && availability !== "offline" && availability !== "unknown") {
				throw new WbTaskError(
					WB_ERROR_CODE.inputInvalid,
					`Unknown session availability ${JSON.stringify(availability)} for ${observation.sessionId}`,
				);
			}
			const verified = observation.verified !== false;
			const conflict = observation.ownershipConflict === true;
			const existing = db
				.query("SELECT session_id FROM sessions WHERE session_id = ?")
				.get(observation.sessionId) as { session_id: string } | null;
			if (existing === null) {
				db.run(
					`INSERT INTO sessions(session_id, role, title, title_source, use_hint, identity, availability,
						reason_code, source_complete, observed_at, owner_pid, worker_version, last_assigned_at,
						enrolled, ownership_conflict)
					 VALUES(?, ?, ?, 'discovery', 'delegation', ?, ?, NULL, 1, ?, NULL, ?, NULL, ?, ?)`,
					[
						observation.sessionId,
						observation.role ?? "general",
						observation.title ?? `Session ${observation.sessionId.slice(0, 8)}`,
						verified ? "verified" : "pending",
						availability,
						now,
						observation.workbuddyVersion,
						// Enrollment and eligibility are two different facts. A member
						// that is known but not proven live still belongs to this
						// project, so it is enrolled — but it may not take work. A
						// member whose ownership was disproved is not enrolled at all.
						conflict ? 0 : 1,
						conflict ? 1 : 0,
					],
				);
				continue;
			}
			// An existing row keeps its history: the title, the role and the
			// enrollment decision are not re-derived from a single observation.
			// Only the volatile facts are refreshed, and a contradicted member is
			// withdrawn from the pool without losing the row.
			//
			// The conflict flag is evaluated from the *incoming* observation, not
			// from the stored row: SQLite evaluates every SET expression against
			// the row as it was before the update, so reading the column here
			// would see the old (zero) value and enroll a quarantined member.
			db.run(
				`UPDATE sessions SET
					availability = ?,
					identity = CASE WHEN ? = 1 THEN 'verified' ELSE 'pending' END,
					worker_version = ?,
					observed_at = ?,
					ownership_conflict = ?,
					enrolled = CASE WHEN ? = 1 THEN 0 ELSE 1 END
				 WHERE session_id = ?`,
				[
					availability,
					verified ? 1 : 0,
					observation.workbuddyVersion,
					now,
					conflict ? 1 : 0,
					conflict ? 1 : 0,
					observation.sessionId,
				],
			);
		}
		// A member that this refresh did not mention keeps its row, its
		// enrollment and its history: an offline member is not a removed
		// member, and deleting it would erase the evidence that it was ever
		// authorized. It is however no longer *known to be there*, so its
		// availability becomes offline — otherwise a stale "idle" from an
		// earlier refresh would let the pool select a session that is gone.
		const seen = new Set(sessions.map((observation) => observation.sessionId));
		const absent = db
			.query("SELECT session_id FROM sessions WHERE enrolled = 1")
			.all() as Array<{ session_id: string }>;
		for (const row of absent) {
			if (seen.has(row.session_id)) {
				continue;
			}
			db.run("UPDATE sessions SET availability = 'offline', observed_at = ? WHERE session_id = ?", [now, row.session_id]);
		}
		nextRevision(db);
	});
}

/**
 * The durable context a task is pinned to, or `null`.
 *
 * `rounds.selected_session` cannot answer this: a rollback clears it before
 * anything was sent, and a terminal release leaves whatever the last claim
 * wrote. The affinity row is written at claim time and never removed, so a
 * rework, a supplement or a resumed round finds the same conversation.
 */
export function readTaskSession(db: Database, taskId: string): string | null {
	const row = db
		.query("SELECT session_id FROM task_sessions WHERE task_id = ?")
		.get(taskId) as { session_id: string } | null;
	return row?.session_id ?? null;
}

/** Writes (or confirms) the durable task↔context affinity. */
function recordTaskAffinity(
	db: Database,
	taskId: string,
	sessionId: string,
	round: number,
	kind: "pool" | "pinned",
	now: number,
): void {
	const existing = db
		.query("SELECT session_id FROM task_sessions WHERE task_id = ?")
		.get(taskId) as { session_id: string } | null;
	if (existing !== null) {
		// The affinity is decided once. A later claim that would move the task
		// to a different context is a bug, not a re-assignment: the task's work
		// already lives in the first conversation.
		if (existing.session_id !== sessionId) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`Task ${taskId} is already pinned to WorkBuddy session ${existing.session_id}; it may not be moved to ${sessionId}`,
			);
		}
		db.run("UPDATE task_sessions SET round = ?, updated_at = ? WHERE task_id = ?", [round, now, taskId]);
		return;
	}
	db.run(
		`INSERT INTO task_sessions(task_id, session_id, round, kind, assigned_at, updated_at)
		 VALUES(?, ?, ?, ?, ?, ?)`,
		[taskId, sessionId, round, kind, now, now],
	);
}

/**
 * Records that a context has been handed to a task.
 *
 * The ledger is append-only and is what makes context isolation durable. A
 * `reserved` row means the context was claimed but nothing may have left;
 * a `used` row means a prompt was armed, so the context is definitely not
 * clean. Either way, the context is unavailable to *other* tasks.
 */
function recordSessionUsage(
	db: Database,
	sessionId: string,
	taskId: string,
	round: number,
	state: "reserved" | "used",
	now: number,
): void {
	const existing = db
		.query("SELECT task_id, state FROM session_usage WHERE session_id = ?")
		.get(sessionId) as { task_id: string; state: string } | null;
	if (existing !== null) {
		if (existing.task_id !== taskId) {
			// Two tasks tried to share one context. The first owner keeps it; the
			// second must not be told it may proceed.
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`WorkBuddy session ${sessionId} already carries task ${existing.task_id}; it may not be reused for task ${taskId}`,
			);
		}
		if (state === "used" && existing.state !== "used") {
			db.run("UPDATE session_usage SET state = 'used' WHERE session_id = ?", [sessionId]);
		}
		return;
	}
	db.run(
		`INSERT INTO session_usage(session_id, task_id, first_round, state, first_used_at)
		 VALUES(?, ?, ?, ?, ?)`,
		[sessionId, taskId, round, state, now],
	);
}

/** One pool candidate, as the selector sees it. */
interface PoolCandidate {
	sessionId: string;
	role: string;
	availability: string;
	usable: boolean;
	/**
	 * Why this candidate cannot take the task, as one of the per-session facts.
	 *
	 * `null` on a usable candidate. The value is the classifier's single input:
	 * the wait reason is derived from these facts and never re-guessed from
	 * availability.
	 */
	reason: SessionBlockerReason | null;
}

/**
 * The eligible pool for one claim.
 *
 * A session is eligible when it is enrolled, not quarantined by an ownership
 * conflict, not already carrying another task, not held by anyone, and
 * actually idle. The reasons are kept per candidate so the wait can say
 * *why* there is nothing to run on instead of a flat "busy".
 *
 * The order of the checks is the order of the facts, not an accident: the
 * first fact that disqualifies a session is the one that explains it. A
 * session that already carried another task is *used*, whatever its
 * availability says right now — reporting it as "offline" would blame the
 * network for a conversation that is simply not clean. The role filter comes
 * before the usage check, because a session of the wrong role is not a
 * candidate at all, whatever its history.
 */
function poolCandidates(
	db: Database,
	role: string | null,
	taskId: string,
): { candidates: PoolCandidate[]; enrolledCount: number } {
	const rows = db
		.query(
			`SELECT session_id, role, identity, availability, reason_code, worker_version,
				enrolled, ownership_conflict, observed_at
			 FROM sessions ORDER BY session_id ASC`,
		)
		.all() as PoolRow[];
	const usage = db.query("SELECT session_id, task_id FROM session_usage").all() as Array<{
		session_id: string;
		task_id: string;
	}>;
	const usageBySession = new Map(usage.map((row) => [row.session_id, row.task_id]));
	const holds = db
		.query("SELECT session_id, kind FROM holds WHERE kind IN ('execution','quarantine')")
		.all() as Array<{ session_id: string; kind: string }>;
	const holdBySession = new Map(holds.map((row) => [row.session_id, row.kind]));
	const candidates: PoolCandidate[] = [];
	// Every enrolled member of this project, whether or not it is a candidate
	// for this round. The count separates "this project has no WorkBuddy
	// session" from "none of its sessions fits this round", which are
	// different facts with different remedies.
	let enrolledCount = 0;
	for (const row of rows) {
		if (row.ownership_conflict === 1) {
			// The session was enrolled and its ownership was disproved. It is
			// not a candidate any more, but the conflict is the fact that
			// explains the wait, so it is reported rather than dropped.
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: "ownership_conflict",
			});
			continue;
		}
		if (row.enrolled !== 1) {
			// Not a member of this project's pool. An unregistered session is
			// never selected, no matter how idle it looks.
			continue;
		}
		enrolledCount += 1;
		if (role !== null && row.role !== role) {
			// A member of the wrong role is not a candidate for this round at
			// all: it is neither used nor busy, and saying so would blame a
			// session for a role it was never asked to fill.
			continue;
		}
		const owner = usageBySession.get(row.session_id);
		if (owner !== undefined && owner !== taskId) {
			// The context already carries another task's work. Recycling it would
			// mix two unrelated tasks into one conversation. This is true
			// whatever the session is doing right now, so it is checked before
			// the live facts: a used session that happens to be offline is
			// still a used session.
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: "already_used_by_other_task",
			});
			continue;
		}
		const hold = holdBySession.get(row.session_id);
		if (hold !== undefined) {
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: hold === "quarantine" ? "native_state_unknown" : "session_busy",
			});
			continue;
		}
		if (row.availability === "busy") {
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: "session_busy",
			});
			continue;
		}
		if (row.availability !== "idle") {
			// Offline, unknown, or merely known without a live worker: the
			// session belongs to this project, yet nothing shows a worker of
			// this project owns it right now. Being known is not the same as
			// being there, so it may not take work.
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: "session_unavailable",
			});
			continue;
		}
		if (row.identity !== "verified") {
			// Enrolled and idle on paper, but no live worker proved it owns
			// this conversation: an idle roster row is not a live session.
			candidates.push({
				sessionId: row.session_id,
				role: row.role,
				availability: row.availability,
				usable: false,
				reason: "session_unavailable",
			});
			continue;
		}
		candidates.push({
			sessionId: row.session_id,
			role: row.role,
			availability: row.availability,
			usable: true,
			reason: null,
		});
	}
	return { candidates, enrolledCount };
}

/**
 * Turns a candidate set into the single wait reason the user sees.
 *
 * The distinction matters: "every session is busy" is a wait, "there is no
 * session for this project at all" is a request to open one. Collapsing them
 * into a single "busy" would hide the only action that can unblock the task.
 *
 * The classifier reads the candidates' own reasons and nothing else, so the
 * reason can never disagree with the per-session facts reported beside it.
 * It is only called when there is no usable candidate, so there is no
 * "there is something to run on" case to answer here.
 *
 * The precedence is the order of how badly the wait needs a human:
 *
 *  - an empty pool is not exhaustion, it is an absent project roster;
 *  - an ownership conflict is a fact about the project, not about the
 *    session's capacity, so it dominates a busy sibling;
 *  - "every session has already carried a task" is exhaustion, and only
 *    exhaustion justifies telling the user to open another conversation;
 *  - a busy pool and an unavailable pool are waits, not exhaustion;
 *  - a mixed pool is one wait with one action, and is named as mixed rather
 *    than as "all busy" or "all used", because neither of those is true.
 */
function poolWaitReason(candidates: readonly PoolCandidate[], enrolledCount: number): {
	reason: PoolWaitReason;
	blockerIds: string[];
	sessionBlockers: SessionBlocker[];
} {
	const blockerIds = candidates.map((candidate) => candidate.sessionId);
	const sessionBlockers: SessionBlocker[] = candidates.map((candidate) => ({
		sessionId: candidate.sessionId,
		reason: candidate.reason ?? "session_unavailable",
	}));
	if (candidates.length === 0) {
		if (enrolledCount === 0) {
			// No session is enrolled for this project at all. That is not the
			// same as "every enrolled session has been used": there is nothing
			// to reuse because there is nothing there.
			return { reason: "no_enrolled_session", blockerIds, sessionBlockers };
		}
		// The project has sessions, but none of them fits this round's role.
		// That is not exhaustion and not absence either: it is a pool whose
		// members are all accounted for and none of them is eligible. The
		// reason names that no eligible session is available, which is the
		// truth; "busy or unavailable" would blame capacity for a role
		// mismatch that no amount of waiting can fix.
		return { reason: "sessions_unavailable", blockerIds, sessionBlockers };
	}
	if (candidates.some((candidate) => candidate.reason === "ownership_conflict")) {
		return { reason: "ownership_conflict", blockerIds, sessionBlockers };
	}
	if (candidates.every((candidate) => candidate.reason === "already_used_by_other_task")) {
		return { reason: "no_unused_session", blockerIds, sessionBlockers };
	}
	if (candidates.every((candidate) => candidate.reason === "native_state_unknown")) {
		return { reason: "native_state_unknown", blockerIds, sessionBlockers };
	}
	if (candidates.every((candidate) => candidate.reason === "session_busy")) {
		return { reason: "all_sessions_busy", blockerIds, sessionBlockers };
	}
	if (candidates.every((candidate) => candidate.reason === "session_unavailable")) {
		return { reason: "sessions_unavailable", blockerIds, sessionBlockers };
	}
	return { reason: "sessions_busy_or_unavailable", blockerIds, sessionBlockers };
}

/**
 * The approved target policy of one round, or the pool when it has none.
 *
 * A round whose policy cannot be read is treated as a pool round: the pool is
 * the only policy that never names a session it was not approved for, so
 * falling back to it cannot send work to an unauthorized target.
 */
function readTargetPolicy(db: Database, taskId: string, round: number): TargetPolicyJson {
	const row = readRound(db, taskId, round);
	if (row === null) {
		return { kind: "workspace_pool", role: null };
	}
	try {
		const parsed = JSON.parse(String(row["target_policy_json"])) as TargetPolicyJson;
		if (parsed.kind === "session" && typeof parsed.sessionId === "string") {
			return parsed;
		}
	} catch {
		// An unreadable policy is handled by the fallback below.
	}
	return { kind: "workspace_pool", role: null };
}

/**
 * Why one queued round is waiting, as the queue's own facts describe it.
 *
 * The read side needs the same answer the claim gives, or the status page
 * would describe a wait differently from the moment it was created. Both
 * therefore derive from the same two facts — the scope conflicts and the pool
 * candidates — and neither stores a reason of its own: a stored reason is a
 * second truth that can disagree with the roster.
 */
export interface TaskWaitState {
	/** The single wait reason, or `null` when nothing blocks the round. */
	reason: WaitReason | null;
	/** The records that block the round. */
	blockerIds: string[];
	/** The per-session facts behind a pool wait; empty for every other wait. */
	sessionBlockers: SessionBlocker[];
}

/**
 * Derives a queued round's wait state from the queue's facts.
 *
 * The order matches the claim exactly: scope first, because a scope conflict
 * is a property of the task rather than of any session, then the session the
 * round is pinned to or would be chosen from.
 */
function readTaskWaitState(
	db: Database,
	taskId: string,
	round: number,
	targetPolicy: TargetPolicyJson,
): TaskWaitState {
	const row = readRound(db, taskId, round);
	if (row === null) {
		return { reason: null, blockerIds: [], sessionBlockers: [] };
	}
	const scope = parseScope(String(row["desired_scope_json"]));
	const occupied = db
		.query("SELECT work_id, record_json FROM works WHERE state IN ('active','blocked')")
		.all() as Array<{ work_id: string; record_json: string }>;
	const conflicting = occupied.find((entry) => {
		const record = JSON.parse(entry.record_json) as {
			scope: { readPaths: string[]; writePaths: string[] } | null;
		};
		if (record.scope === null || entry.work_id === delegatedWorkId(taskId, round)) {
			return false;
		}
		return scopesConflict(scope, record.scope);
	});
	if (conflicting !== undefined) {
		return { reason: "scope_conflict", blockerIds: [conflicting.work_id], sessionBlockers: [] };
	}
	// The context this task belongs to: a dispatched task keeps its own
	// conversation, and only a round without one is decided by the pool.
	const affinity = readTaskSession(db, taskId);
	const pinned = affinity ?? (targetPolicy.kind === "session" ? targetPolicy.sessionId : null);
	if (pinned !== null) {
		const hold = db
			.query("SELECT session_id, kind FROM holds WHERE session_id = ? AND kind IN ('execution', 'quarantine')")
			.get(pinned) as { session_id: string; kind: string } | null;
		if (hold !== null) {
			return {
				reason: hold.kind === "quarantine" ? "native_state_unknown" : "session_busy",
				blockerIds: [pinned],
				sessionBlockers: [],
			};
		}
		const usage = db
			.query("SELECT task_id FROM session_usage WHERE session_id = ?")
			.get(pinned) as { task_id: string } | null;
		if (usage !== null && usage.task_id !== taskId) {
			return { reason: "no_unused_session", blockerIds: [pinned], sessionBlockers: [] };
		}
		return { reason: null, blockerIds: [], sessionBlockers: [] };
	}
	// The round is a pool round, so the pool decides among its members.
	const pool = poolCandidates(db, targetPolicy.kind === "workspace_pool" ? targetPolicy.role : null, taskId);
	if (pool.candidates.some((candidate) => candidate.usable)) {
		return { reason: null, blockerIds: [], sessionBlockers: [] };
	}
	const wait = poolWaitReason(pool.candidates, pool.enrolledCount);
	return { reason: wait.reason, blockerIds: wait.blockerIds, sessionBlockers: wait.sessionBlockers };
}

/**
 * Reads a stored scope, tolerating a legacy or empty record.
 *
 * An imported round may carry `{}` — it declares no paths and therefore
 * conflicts with nothing. A record that cannot be parsed is treated the same
 * way: it cannot prove a conflict, and crashing the claim over a malformed
 * legacy row would be worse than letting it proceed.
 */
function parseScope(raw: string): { readPaths: string[]; writePaths: string[] } {
	try {
		const parsed = JSON.parse(raw) as { readPaths?: unknown; writePaths?: unknown };
		return {
			readPaths: Array.isArray(parsed.readPaths) ? (parsed.readPaths as string[]) : [],
			writePaths: Array.isArray(parsed.writePaths) ? (parsed.writePaths as string[]) : [],
		};
	} catch {
		return { readPaths: [], writePaths: [] };
	}
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

/**
 * Validates a database before a read-only surface uses it.
 *
 * A reader must reach the same conclusion the writer would: an uninitialized
 * file has no rows to misread, a foreign file is not this project's state, and a
 * version or shape this build does not know is `migration_required` rather than
 * a raw SQLite error surfacing from an arbitrary later query.
 */
function assertProjectReadSafe(db: Database, root: string): void {
	const storedRoot = readMeta(db, "project_root");
	if (storedRoot === null) {
		return;
	}
	if (storedRoot !== canonicalProjectRoot(root)) {
		throw new WbTaskError(
			WB_ERROR_CODE.taskStateInvalid,
			`Project state database belongs to ${storedRoot}, not ${canonicalProjectRoot(root)}`,
		);
	}
	const declared = readMeta(db, "schema_version");
	if (declared !== String(QUEUE_SCHEMA_VERSION)) {
		throw new WbTaskError(
			WB_ERROR_CODE.migrationRequired,
			`Project state database declares schema version ${declared ?? "(missing)"}, not ${QUEUE_SCHEMA_VERSION}; run project setup to migrate it`,
		);
	}
	assertRoundColumns(db);
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

	syncProjectSessions(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot record project sessions");
	}

	taskSession(taskId: string): string | null {
		// Reading the durable affinity is not a mutation: a read-mode queue
		// exposes it so a host can show where a task actually runs.
		return readTaskSession(this.db, taskId);
	}

	waitState(taskId: string, round: number): TaskWaitState {
		// Reading the wait state is not a mutation either: it is derived from
		// the same durable facts the claim reads.
		return readTaskWaitState(this.db, taskId, round, readTargetPolicy(this.db, taskId, round));
	}

	registerOwner(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot register an owner");
	}

	retireOwner(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot retire an owner");
	}

	armPrompt(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot arm a prompt");
	}

	recordExecutionEnd(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot record execution end");
	}

	adoptUnsentRounds(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot adopt an unsent round");
	}

	beginTerminal(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot record an outcome");
	}

	rollbackClaim(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot roll back a claim");
	}

	reconcileAbandonedRounds(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot recover rounds");
	}

	releaseQuarantine(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot release a quarantine");
	}

	recoverySubject(taskId: string, round: number): RecoverySubject | null {
		// Reading the subject is not a mutation: a diagnosis must be able to
		// show what a recovery would be about without repairing anything.
		return readRecoverySubject(this.db, taskId, round);
	}

	proveOwnerDead(
		owner: Pick<OwnerIdentity, "instanceId" | "generation" | "sessionId">,
		now: number,
	): { ok: true; proof: OwnerDeathProof } | { ok: false; reason: string } {
		// Proving a death is a read of the registration plus the OS. It changes
		// nothing, so a reader may answer it.
		return proveOwnerDead(this.db, owner, now);
	}

	holds(): Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }> {
		// Reading holds is not a mutation: a read-mode queue exposes them too.
		return readHolds(this.db);
	}

	works(): Array<{ workId: string; revision: number; state: string; round: number | null; recordJson: string }> {
		return readWorks(this.db);
	}

	confirmReceipt(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot confirm a receipt");
	}

	commitFailed(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot record a commit failure");
	}

	requestCancel(): never {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "A read-mode queue cannot cancel a round");
	}

	inspect(query: QueueQuery): QueueSnapshot {
		const base = inspectRounds(this.db, query);
		return {
			...base,
			// The roster is read-only state, so a reader exposes it too: the
			// status and workbench pages report each session's real
			// availability, and they read through this handle.
			sessions:
				query.include?.sessions === true
					? (this.db.query("SELECT * FROM sessions ORDER BY session_id ASC").all() as Array<
							Record<string, unknown>
						>)
					: [],
			works: [],
			warnings: [],
		};
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
		if (input.targetPolicy.kind !== "session" && input.targetPolicy.kind !== "workspace_pool") {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "Delegation requires a session or a workspace pool target");
		}
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
					`Project ${this.root} is not enabled; run /wb setup (or /wb init) first`,
				);
			}
			if (!isOwnerActive(this.db, {
				instanceId: input.executorInstanceId,
				generation: input.ownerGeneration,
				sessionId: input.ownerSession,
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

			// A round that belongs to a task which already has a context must not
			// name a different one. The frozen manifest is not rewritten here: the
			// approved policy stays as the human saw it, and the queue enforces
			// the affinity at claim time instead. What this check refuses is the
			// attempt to *move* a task's work into another conversation.
			const existingAffinity = readTaskSession(this.db, payloadTaskId);
			if (
				existingAffinity !== null &&
				payloadTargetPolicy.kind === "session" &&
				payloadTargetPolicy.sessionId !== existingAffinity
			) {
				throw new WbTaskError(
					WB_ERROR_CODE.taskStateInvalid,
					`Task ${payloadTaskId} is already pinned to WorkBuddy session ${existingAffinity}; round ${payloadRound} may not be redirected to ${payloadTargetPolicy.sessionId}`,
				);
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
					review_state, delivery_mode, turns_json, updated_at,
					package_id, authorization_id, authorization_revision, deliverable_id,
					purpose, rework_of_review_id
				) VALUES (?, ?, ?, 'approved', ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'not_sent', 0, 'pending', 'pending', ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
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
					null,
					null,
					null,
					null,
					input.correctionOfReviewId === undefined ? null : "rework",
					input.correctionOfReviewId ?? null,
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
				// Record version, not the project-wide audit counter: this is what
				// expectedRevision CAS compares against.
				revision: 1,
				artifacts: [],
				remoteResults: [],
				reviews: [],
			};
			this.db.run(
				`INSERT INTO works(work_id, revision, state, record_json, task_id, round)
				 VALUES(?, ?, 'waiting', ?, ?, ?)`,
				[workRecord.workId, 1, JSON.stringify(workRecord), payloadTaskId, payloadRound],
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

	registerOwner(owner: OwnerIdentity, now: number): void {
		withImmediate(this.db, () => registerOwner(this.db, owner, now));
	}

	syncProjectSessions(sessions: readonly ProjectSessionObservation[], now: number): void {
		syncProjectSessions(this.db, sessions, now);
	}

	taskSession(taskId: string): string | null {
		return readTaskSession(this.db, taskId);
	}

	waitState(taskId: string, round: number): TaskWaitState {
		return readTaskWaitState(this.db, taskId, round, readTargetPolicy(this.db, taskId, round));
	}

	retireOwner(owner: OwnerIdentity): void {
		withImmediate(this.db, () => retireOwner(this.db, owner));
	}

	armPrompt(input: Parameters<typeof armPrompt>[1]): ArmOutcome {
		return armPrompt(this.db, input);
	}
	recordExecutionEnd(input: Parameters<typeof recordExecutionEnd>[1]): { kind: "recorded" | "refused"; reason?: string } {
		return recordExecutionEnd(this.db, input);
	}

	adoptUnsentRounds(input: Parameters<typeof adoptUnsentRounds>[1]): number {
		return adoptUnsentRounds(this.db, input);
	}


	beginTerminal(input: Parameters<typeof beginTerminal>[1]): { kind: "applied" | "unchanged"; status: string } {
		return beginTerminal(this.db, input);
	}

	rollbackClaim(input: Parameters<typeof rollbackClaim>[1]): { kind: "requeued" | "refused"; reason?: string } {
		return rollbackClaim(this.db, input);
	}

	reconcileAbandonedRounds(input: Parameters<typeof reconcileAbandonedRounds>[1]): AbandonedRound[] {
		return reconcileAbandonedRounds(this.db, input);
	}

	releaseQuarantine(input: Parameters<typeof releaseQuarantine>[1]): RecoveryRelease {
		return releaseQuarantine(this.db, input);
	}

	recoverySubject(taskId: string, round: number): RecoverySubject | null {
		// Reading the subject is not a mutation: a host must be able to show the
		// human what they are being asked about before it asks.
		return readRecoverySubject(this.db, taskId, round);
	}

	proveOwnerDead(
		owner: Pick<OwnerIdentity, "instanceId" | "generation" | "sessionId">,
		now: number,
	): { ok: true; proof: OwnerDeathProof } | { ok: false; reason: string } {
		return proveOwnerDead(this.db, owner, now);
	}

	holds(): Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }> {
		return readHolds(this.db);
	}

	works(): Array<{ workId: string; revision: number; state: string; round: number | null; recordJson: string }> {
		return readWorks(this.db);
	}

	confirmReceipt(input: Parameters<typeof confirmReceipt>[1]): { kind: "committed" | "mismatch"; reason?: string } {
		return confirmReceipt(this.db, input);
	}

	commitFailed(input: Parameters<typeof commitFailed>[1]): void {
		commitFailed(this.db, input);
	}

	requestCancel(input: Parameters<typeof requestCancel>[1]): {
		kind: "cancelled";
		dispatchState: string;
		sendCancel: boolean;
	} {
		return requestCancel(this.db, input);
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
				// The dispatch target comes from the round's approved target policy,
				// not from the OMP owner: holds and blocker ids key on it.
				const targetPolicy = JSON.parse(candidate.target_policy_json as string) as TargetPolicyJson;
				// Scope arbitration: desired read/write paths vs active/blocked works.
				// Scope is checked before the target is chosen, because a scope
				// conflict is a property of the task, not of any session.
				//
				// A legacy row may carry an empty scope object; it declares no
				// paths, which conflicts with nothing. The parse is defensive on
				// purpose: an unreadable scope must not crash the claim.
				const scope = parseScope(candidate.desired_scope_json as string);
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
						sessionBlockers: [],
					} as ClaimOutcome;
					continue;
				}

				// The context this task belongs to. A task that has already been
				// dispatched keeps its context: rework and supplement rounds are
				// pinned to the conversation that holds the work, and the affinity
				// survives rollback and terminal release.
				const affinity = readTaskSession(this.db, taskId);
				let wbSession: string;
				let affinityKind: "pool" | "pinned";
				if (affinity !== null) {
					wbSession = affinity;
					affinityKind = "pinned";
				} else if (targetPolicy.kind === "session") {
					wbSession = targetPolicy.sessionId;
					affinityKind = "pinned";
				} else {
					// A pool round: the queue picks the context. Selection is
					// atomic with the claim — the winner takes the session hold in
					// the same transaction, so two claimants can never pick the
					// same context.
					const pool = poolCandidates(this.db, targetPolicy.role, taskId);
					const usable = pool.candidates.filter((entry) => entry.usable);
					if (usable.length === 0) {
						const wait = poolWaitReason(pool.candidates, pool.enrolledCount);
						firstWait ??= {
							kind: "waiting",
							taskId,
							round,
							reason: wait.reason,
							blockerIds: wait.blockerIds,
							sessionBlockers: wait.sessionBlockers,
						} as ClaimOutcome;
						continue;
					}
					wbSession = usable[0]!.sessionId;
					affinityKind = "pool";
				}

				// One execution hold per WorkBuddy session: a second round for the
				// same target session must wait, not double-dispatch. The wait is
				// recorded and younger candidates keep being tried, so one busy
				// session never starves unrelated work of the same owner.
				const sessionHold = this.db
					.query("SELECT session_id, kind FROM holds WHERE session_id = ? AND kind IN ('execution', 'quarantine')")
					.get(wbSession) as { session_id: string; kind: string } | null;
				if (sessionHold !== null) {
					firstWait ??= {
						kind: "waiting",
						taskId,
						round,
						reason: sessionHold.kind === "quarantine" ? "native_state_unknown" : "session_busy",
						blockerIds: [wbSession],
						sessionBlockers: [],
					} as ClaimOutcome;
					continue;
				}
				// Context isolation: a context that already carries another task's
				// work may never be handed to this task. The hold check above
				// covers concurrent work; this covers work that has already ended.
				const usage = this.db
					.query("SELECT task_id, state FROM session_usage WHERE session_id = ?")
					.get(wbSession) as { task_id: string; state: string } | null;
				if (usage !== null && usage.task_id !== taskId) {
					firstWait ??= {
						kind: "waiting",
						taskId,
						round,
						reason: "no_unused_session",
						blockerIds: [wbSession],
						sessionBlockers: [],
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
						sessionBlockers: [],
					} as ClaimOutcome;
					continue;
				}
				// The claim owns the context now. The durable affinity and the usage
				// ledger are written in the same transaction as the hold: a context
				// that has been handed to this task is never handed to another one,
				// and the task keeps this context across rollback and release.
				recordTaskAffinity(this.db, taskId, wbSession, round, affinityKind, now);
				recordSessionUsage(this.db, wbSession, taskId, round, "reserved", now);
				// Promoting the scope is a record change: bump the record version and
				// keep record_json in step with the column, so a later
				// expectedRevision CAS sees the same number from either reader.
				const pendingRow = this.db
					.query("SELECT record_json FROM works WHERE task_id = ? AND round = ?")
					.get(taskId, round) as { record_json: string } | null;
				if (pendingRow !== null) {
					const pendingRecord = JSON.parse(pendingRow.record_json) as Record<string, unknown>;
					const nextVersion = ((pendingRecord.revision as number | undefined) ?? 1) + 1;
					this.db.run(
						`UPDATE works SET state = 'active', revision = ?, record_json = ?
						 WHERE task_id = ? AND round = ? AND state = 'waiting'`,
						[
							nextVersion,
							JSON.stringify({ ...pendingRecord, state: "active", revision: nextVersion }),
							taskId,
							round,
						],
					);
				}
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
