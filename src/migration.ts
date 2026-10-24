/**
 * One-time migration from the v1/v2 file-based state to the SQLite queue.
 *
 * A fresh `.wb-bridge/state.sqlite` is created and populated with the old
 * binding, receipt history and collaboration records in a single
 * transaction: a failure rolls the whole database back, leaving no file for
 * the next attempt to retry cleanly. Live or uncertain old lock owners make
 * the migration refuse with `WB_MIGRATION_REQUIRED` — old bridge work must
 * finish (or its process die) before this project can switch authorities.
 *
 * The migration is the sole writer of `meta.project_root` identity after
 * this module lands; `binding.json` stays on disk untouched as an optional
 * historical projection, never consulted for authorization again.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { canonicalProjectRoot, ensureRoundsColumns, initializeProjectDatabase, openReadConnection, openWriteConnection, QUEUE_SCHEMA_VERSION, SCHEMA_SQL, splitSqlStatements, withImmediate, readMeta, writeMeta, nextRevision, closeQueueConnection } from "./queue";
import { readAllWorkRecords } from "./collaboration";
import { delegatedWorkId, isPidAlive, readBinding, readTask, readTaskLock, uuid5, WbTaskError } from "./tasks";
import { WB_ERROR_CODE, type TaskReceipt } from "./types";

/** The DNS namespace UUIDv5 uses; the plan fixes it for legacy request ids. */
/**
 * Derives the deterministic legacy requestId for one imported round.
 *
 * Same UUIDv5 recipe as every other derived identifier, in the legacy
 * namespace so an imported round never collides with a live one.
 */
export function legacyRequestId(taskId: string, round: number): string {
	return uuid5(`omp-wb-bridge/legacy/${taskId}/${round}`);
}

/** Legacy receipt status normalization: running states become interrupted. */
function legacyStatusOf(status: string): string {
	return status === "running" || status === "awaiting_approval" ? "interrupted" : status;
}

/** The snapshot root of a legacy round: the task dir for old layouts. */
function legacySnapshotRoot(root: string, taskId: string): string {
	return path.join(root, ".wb-bridge", "tasks", taskId);
}

/** One issue recorded when old state could not be imported. */
function recordIssue(db: import("bun:sqlite").Database, code: string, relativeSource: string, detail: string): void {
	// Idempotent on (code, source): a schema upgrade re-runs the whole import,
	// and the same unreadable file must not pile up a new issue row every time.
	const existing = db
		.query("SELECT id FROM issues WHERE code = ? AND relative_source = ?")
		.get(code, relativeSource) as { id: string } | null;
	if (existing !== null) {
		db.run("UPDATE issues SET detail_json = ? WHERE id = ?", [JSON.stringify({ detail }), existing.id]);
		return;
	}
	db.run("INSERT INTO issues(id, code, relative_source, detail_json) VALUES(?, ?, ?, ?)", [
		crypto.randomUUID(),
		code,
		relativeSource,
		JSON.stringify({ detail }),
	]);
}

/**
 * Migrates the project under `root` into the SQLite queue.
 *
 * Idempotent: an already-migrated database (or a project with no old state)
 * is a no-op that only ensures the database exists and is enabled. Returns
 * the canonical root the database was created for.
 */
export async function migrateProjectToQueue(root: string): Promise<string> {
	const canonicalRoot = canonicalProjectRoot(root);
	const bridgeDir = path.join(canonicalRoot, ".wb-bridge");
	const dbPath = path.join(bridgeDir, "state.sqlite");

	// A database that exists with the completion marker is fully migrated:
	// nothing to do — unless it still declares an older *schema* version, in
	// which case the schema upgrade must still run. The two markers answer
	// different questions: `migration_completed` says the file-based state was
	// imported, `schema_version` says which shape the bytes have. A database
	// WITHOUT the completion marker is a previous attempt that died mid-flight
	// — it must be migrated into (or fail loudly), never mistaken for a
	// finished migration. The gate check is read-only: the census below must
	// stay the first thing this module writes.
	if (existsSync(dbPath)) {
		const existing = openReadConnection(canonicalRoot);
		if (existing === null) {
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Project state database at ${dbPath} exists but cannot be opened read-only`,
			);
		}
		try {
			const completed = readMeta(existing, "migration_completed") !== null;
			const schema = readMeta(existing, "schema_version");
			if (completed && schema === String(QUEUE_SCHEMA_VERSION)) {
				return canonicalRoot;
			}
		} finally {
			closeQueueConnection(canonicalRoot, "read");
		}
		// Fall through: the import below runs again against the surviving
		// schema. Old rows would conflict, so the imports use OR IGNORE and the
		// marker write makes the retry definitive.
	}

	// Old state census: binding, task receipts, collaboration records, locks.
	const oldBinding = await readBinding(canonicalRoot).catch((err: unknown) => {
		if (err instanceof WbTaskError && err.code === WB_ERROR_CODE.bindingInvalid) {
			return "invalid" as const;
		}
		throw err;
	});

	// A live or uncertain old lock owner must finish before the switch.
	const locks: Array<{ taskId: string; ownerPid: number; sessionId?: string }> = [];
	const unnamedLocks: string[] = [];
	const lockFile = path.join(bridgeDir, "active.lock");
	if (existsSync(lockFile)) {
		const held = await readTaskLock(canonicalRoot);
		if (held !== null) {
			locks.push({ taskId: held.taskId, ownerPid: held.ownerPid });
		}
	}
	// Per-session locks are enumerated by listing the bridge directory.
	try {
		const entries = await readdir(bridgeDir);
		for (const entry of entries) {
			if (entry.startsWith("active-") && entry.endsWith(".lock")) {
				const sessionId = entry.slice("active-".length, -".lock".length);
				// A hand-created or corrupt lock name is recorded as an issue, not
				// a migration abort: the file cannot identify an owner, but it also
				// cannot prove the project is unsafe to switch.
				if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
					unnamedLocks.push(entry);
					continue;
				}
				const held = await readTaskLock(canonicalRoot, sessionId);
				if (held !== null) {
					locks.push({ taskId: held.taskId, ownerPid: held.ownerPid, sessionId });
				}
			}
		}
	} catch {
		// No bridge directory: nothing to enumerate.
	}
	for (const lock of locks) {
		// Liveness treats non-ESRCH failures as alive, so an uncertain owner
		// blocks the migration exactly like a live one.
		if (isPidAlive(lock.ownerPid)) {
			throw new WbTaskError(
				WB_ERROR_CODE.migrationRequired,
				`Old bridge process ${lock.ownerPid} still holds task ${lock.taskId}${lock.sessionId ? ` (session ${lock.sessionId})` : ""}; finish or exit the old bridge work, then retry. The WorkBuddy desktop session is untouched.`,
			);
		}
	}

	// Collect receipts first: parsing happens outside the transaction, which
	// must stay pure DB.
	const taskIds = await listTaskIds(canonicalRoot);
	const receipts: Array<{ taskId: string; receipt: TaskReceipt }> = [];
	const receiptFailures: Array<{ taskId: string; detail: string }> = [];
	for (const taskId of taskIds) {
		try {
			receipts.push({ taskId, receipt: await readTask(canonicalRoot, taskId) });
		} catch (err: unknown) {
			receiptFailures.push({
				taskId,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	let collaborationIssue: string | null = null;
	const works = await readAllWorkRecords(canonicalRoot).catch((err: unknown): import("./types").WorkRecord[] => {
		// Unreadable collaboration state is recorded, not fatal: the project can
		// still dispatch, but the workbench shows the issue until repaired.
		collaborationIssue = `collaboration records unreadable: ${err instanceof Error ? err.message : String(err)}`;
		return [];
	});

	// The census runs before the database exists: an aborted migration (a live
	// old owner, an unreadable project) leaves no state.sqlite behind, so the
	// user is never told "nothing was touched" over a schema-complete file.
	//
	// Ordering from here on: snapshot the existing database (when there is one),
	// then open it in upgrade mode, then rewrite it in one transaction. The
	// snapshot is what makes an interrupted upgrade recoverable, and it must be
	// taken before any schema change — `VACUUM INTO` produces a consistent copy
	// even while the source is in WAL mode, unlike copying the file bytes.
	const backup = await snapshotBeforeUpgrade(canonicalRoot);
	const db = openWriteConnection(canonicalRoot, {
		// Migration is the one caller allowed to open an older schema: refusing
		// here would leave an upgrading project with no path forward at all.
		allowSchemaMismatch: true,
	});
	try {
		withImmediate(db, () => {
			upgradeSchema(db, canonicalRoot);
			initializeProjectDatabase(db, canonicalRoot);
			// Authorization evidence comes from the binding: a project with
			// history but no readable binding migrates as history-only, with
			// dispatch still gated until the wizard enables it.
			let enabled = false;

			// Binding import: project authorization plus session roster.
			if (typeof oldBinding === "object" && oldBinding !== null && !("invalid" in oldBinding)) {
				const defaultId = oldBinding.sessionId;
				const roster = oldBinding.sessions && oldBinding.sessions.length > 0 ? oldBinding.sessions : [{ sessionId: defaultId, role: "default", isDefault: true }];
				// The old binding's history is not evidence that every roster row
				// is a verified delegation target: imports arrive as pending with
				// an unknown use hint until a live observation re-verifies them.
				const rosterIds = new Set<string>();
				for (const session of roster) {
					rosterIds.add(session.sessionId);
					db.run(
						`INSERT INTO sessions(session_id, role, title, title_source, use_hint, identity, availability, reason_code, source_complete, observed_at, owner_pid, worker_version, last_assigned_at)
						 VALUES(?, ?, ?, 'binding', 'unknown', 'pending', 'unknown', NULL, 0, ?, NULL, NULL, NULL)
						 ON CONFLICT(session_id) DO NOTHING`,
						[session.sessionId, session.role ?? "general", session.title ?? `Session ${session.sessionId.slice(0, 8)}`, Date.now()],
					);
				}
				// The default must be a roster member; a binding whose default id
				// is foreign keeps the first roster entry instead.
				if (rosterIds.has(defaultId)) {
					writeMeta(db, "default_session_id", defaultId);
				} else if (roster.length > 0 && roster[0] !== undefined) {
					writeMeta(db, "default_session_id", roster[0].sessionId);
				}
				enabled = true;
			} else if (oldBinding === "invalid") {
				recordIssue(db, "binding_invalid", ".wb-bridge/binding.json", "Binding file could not be parsed; fix or remove it before dispatch.");
			}
			if (enabled) {
				// The enablement time is consent evidence: it says when the user
				// authorized this project. A schema upgrade re-runs this import,
				// and the original timestamp must survive it — rewriting it would
				// make the consent look like it was given today.
				if (readMeta(db, "project_enabled_at") === null) {
					writeMeta(db, "project_enabled_at", new Date().toISOString());
				}
			}

			// Receipt import: every history round becomes a legacy v3 row. The
			// retry path (a previous attempt's schema without the marker) meets
			// the same rows again: ignore and keep the first import.
			for (const { taskId, receipt } of receipts) {
				for (const round of receipt.rounds) {
					const requestId = legacyRequestId(taskId, round.number);
					const status = legacyStatusOf(round.status);
					db.run(
						`INSERT OR IGNORE INTO rounds(
							task_id, round, request_id, record_kind, revision, status, phase,
							target_policy_json, desired_scope_json, owner_session, owner_generation,
							manifest_path, manifest_sha256, approval_json, approval_consumed,
							enqueued_at, dispatch_state, cancel_requested, commit_state,
							review_state, delivery_mode, turns_json, updated_at
						) VALUES (?, ?, ?, 'legacy', ?, ?, 'terminal', ?, '{}', NULL, NULL, NULL, NULL, NULL, 0, ?, 'not_sent', 0, ?, 'pending', 'foreground', '[]', ?)`,
						[
							taskId,
							round.number,
							requestId,
							nextRevision(db),
							status,
							JSON.stringify({ kind: "session", sessionId: receipt.sessionId }),
							round.consent ? Date.parse(round.consent.at) || Date.now() : Date.now(),
							status === "completed" || status === "cancelled" || status === "failed" ? "committed" : "pending",
							round.consent ? Date.parse(round.consent.at) || Date.now() : Date.now(),
						],
					);
					// The legacy round already ran in a real WorkBuddy context.
					// That context is *used*: it holds the work of this task and
					// must never be handed to an unrelated task. The row is
					// recorded as used — not as a clean reservation — so the
					// history is preserved truthfully instead of being
					// back-dated into a fresh context.
					db.run(
						`INSERT OR IGNORE INTO session_usage(session_id, task_id, first_round, state, first_used_at)
						 VALUES(?, ?, ?, 'used', ?)`,
						[receipt.sessionId, taskId, round.number, Date.now()],
					);
					// The same fact, expressed as the task's durable affinity: the
					// old context is where this task's work lives.
					db.run(
						`INSERT OR IGNORE INTO task_sessions(task_id, session_id, round, kind, assigned_at, updated_at)
						 VALUES(?, ?, ?, 'pinned', ?, ?)`,
						[taskId, receipt.sessionId, round.number, Date.now(), Date.now()],
					);
					// Legacy input hashes are unknown when the receipt predates
					// hashing; snapshot paths are stored relative to the round's
					// legacy inputs directory (task dir for legacy layouts, round
					// dir for round layouts), matching where v2 copied them.
					for (const input of round.inputFiles) {
						db.run(
							`INSERT OR IGNORE INTO inputs(task_id, round, path, snapshot_path, sha256, bytes)
							 VALUES(?, ?, ?, ?, ?, 0)`,
							[
								taskId,
								round.number,
								input.path,
								path.join("inputs", input.path).split(path.sep).join("/"),
								input.sha256 ?? "legacy_unverified",
							],
						);
					}
				}
			}

			// Collaboration records are the richer side: they carry revisions, reviews,
			// nativeRef and the real scope. A receipt round contributes what the file
			// side never knew (task identity, title, timestamp), so the merge below is a
			// field-by-field union rather than "whoever inserted last wins".
			const receiptWork = new Map<string, { title: string; taskId: string; round: number; at: number }>();
			for (const { taskId, receipt } of receipts) {
				for (const round of receipt.rounds) {
					const parsed = round.consent ? Date.parse(round.consent.at) : Number.NaN;
					receiptWork.set(delegatedWorkId(taskId, round.number), {
						title: round.goal.objective.slice(0, 80),
						taskId,
						round: round.number,
						at: Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now(),
					});
				}
			}

			const merged = new Map<string, Record<string, unknown>>();
			for (const [workId, meta] of receiptWork) {
				merged.set(workId, {
					version: 1,
					workId,
					projectRoot: canonicalRoot,
					owner: "omp",
					source: "delegated",
					taskId: meta.taskId,
					round: meta.round,
					nativeRef: null,
					title: meta.title,
					scope: null,
					state: "released",
					phase: "history",
					milestone: "",
					blocker: "",
					updatedAt: new Date(meta.at).toISOString(),
					revision: 1,
					artifacts: [],
					remoteResults: [],
					reviews: [],
				});
			}
			// The collaboration side overlays: it owns the work's identity (owner,
			// scope, state, revisions, reviews, nativeRef). Provenance fields fall back
			// to the receipt side when the file record does not carry them.
			for (const record of works) {
				const round = record.round ?? 0;
				const workId = record.taskId !== null ? delegatedWorkId(record.taskId, round) : record.workId;
				const base = merged.get(workId);
				merged.set(workId, {
					...(base ?? {}),
					...record,
					workId,
					taskId: record.taskId ?? (base?.taskId as string | undefined) ?? null,
					round: record.round ?? (base?.round as number | undefined) ?? null,
					title: record.title.length > 0 ? record.title : ((base?.title as string | undefined) ?? record.title),
				});
			}

			for (const [workId, record] of merged) {
				db.run(
					`INSERT INTO works(work_id, revision, state, record_json, task_id, round)
					 VALUES(?, ?, ?, ?, ?, ?)
					 ON CONFLICT(work_id) DO UPDATE SET
						record_json = excluded.record_json,
						state = excluded.state,
						revision = excluded.revision,
						task_id = excluded.task_id,
						round = excluded.round`,
					[
						workId,
						// Record version from the merged object, not the project-wide
						// audit counter: expectedRevision CAS compares against this, and
						// the two would otherwise diverge the moment either side bumps.
						(record.revision as number | undefined) ?? 1,
						record.state as string,
						JSON.stringify(record),
						(record.taskId as string | null) ?? null,
						(record.round as number | null) ?? null,
					],
				);
			}
			for (const failure of receiptFailures) {
				recordIssue(db, "receipt_unreadable", `.wb-bridge/tasks/${failure.taskId}/receipt.json`, failure.detail);
			}
			for (const entry of unnamedLocks) {
				recordIssue(db, "lock_name_invalid", `.wb-bridge/${entry}`, "Lock file name is not a valid session UUID; remove or rename it so its owner can be identified.");
			}
			if (collaborationIssue !== null) {
				recordIssue(db, "collaboration_unreadable", ".wb-bridge/collaboration", collaborationIssue);
				collaborationIssue = null;
			}

			// The completion marker lands inside the same transaction as the
			// imports: a committed database is always a migrated database, and
			// anything that failed rolls back to an empty file for the retry.
			//
			// A schema upgrade re-runs this import against a database that is
			// already migrated, so the original marker is kept: the time the
			// project was migrated is history, not something the upgrade may
			// rewrite.
			if (readMeta(db, "migration_completed") === null) {
				writeMeta(db, "migration_completed", new Date().toISOString());
			}
		});
	} catch (err: unknown) {
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Migration transaction for ${canonicalRoot} failed and rolled back: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return canonicalRoot;
}

/**
 * Collaboration records: imported with their real state, matching the
 * same workId as a same-id receipt round where one exists.
 */


/**
 * Copies the existing database to a per-migration backup directory.
 *
 * Returns the backup path, or `null` when there is nothing to upgrade yet (a
 * first-time migration writes into a file that does not exist). The copy is
 * verified by re-reading it, so a truncated backup is reported instead of being
 * silently relied on.
 */
async function snapshotBeforeUpgrade(root: string): Promise<string | null> {
	const source = path.join(root, ".wb-bridge", "state.sqlite");
	if (!existsSync(source)) {
		return null;
	}
	const migrationId = crypto.randomUUID();
	const directory = path.join(root, ".wb-bridge", "backups", migrationId);
	await mkdir(directory, { recursive: true });
	const target = path.join(directory, "db-before.sqlite");
	const source_db = new Database(source, { readonly: true });
	try {
		source_db.run("PRAGMA busy_timeout = 5000");
		// A consistent copy, including WAL contents, without assuming any Bun-only
		// backup API: `VACUUM INTO` is plain SQLite.
		source_db.run("VACUUM INTO ?", [target]);
	} finally {
		// This handle is discarded here, so its statements are finalized with
		// it: `close(false)` would keep the file locked until the garbage
		// collector runs, which on Windows is exactly when the project
		// directory could be removed.
		source_db.close(true);
	}
	// Read the copy back: an unreadable backup must fail the migration now, not
	// when someone needs it.
	const check = new Database(target, { readonly: true });
	try {
		const version = readMeta(check, "schema_version");
		if (version === null) {
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Migration backup at ${target} does not declare a schema version; refusing to upgrade ${root}`,
			);
		}
	} finally {
		check.close(true);
	}
	return target;
}

/**
 * Brings an existing database up to the current schema version.
 *
 * Runs inside the migration transaction, so a failure leaves the previous file
 * untouched. New tables are created idempotently; the version marker is written
 * last so a half-applied upgrade never claims to be complete.
 */
function upgradeSchema(db: Database, root: string): void {
	const declared = readMeta(db, "schema_version");
	if (declared === String(QUEUE_SCHEMA_VERSION)) {
		return;
	}
	// A database written by a *newer* build is not this build's to rewrite. The
	// additive statements below would happily "upgrade" a version 99 file back
	// to version 3 and quietly drop whatever that version added, so a future
	// schema is refused instead: the project must be opened by a build that
	// understands it.
	const declaredVersion = declared === null ? Number.NaN : Number.parseInt(declared, 10);
	if (Number.isFinite(declaredVersion) && declaredVersion > QUEUE_SCHEMA_VERSION) {
		throw new WbTaskError(
			WB_ERROR_CODE.migrationRequired,
			`Project state database at ${root} declares schema version ${declared}, which is newer than this build understands (${QUEUE_SCHEMA_VERSION}); upgrade the bridge instead of migrating it backwards`,
		);
	}
	// Every v2 table is additive: no existing column changes meaning, so applying
	// the schema statements is the whole upgrade. Rows keep their `legacy` record
	// kind, and no authorization is invented for them.
	for (const statement of splitSqlStatements(SCHEMA_SQL)) {
		const sql = statement.trim();
		if (sql.length > 0) {
			db.run(sql);
		}
	}
	// New tables are created by the statements above, but added columns are not:
	// `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched. Without
	// this, an upgraded database would silently lack every v2 round column while
	// a fresh one has them.
	ensureRoundsColumns(db);
	// The v3 pool adds two tables and two roster columns. The backfill below
	// gives every round that already ran a concrete context its durable
	// affinity and its usage record, so an upgraded project does not pretend
	// that a used conversation is clean.
	backfillContextIsolation(db);
	const violations = db.query("PRAGMA foreign_key_check").all();
	if (violations.length > 0) {
		throw new WbTaskError(
			WB_ERROR_CODE.storageError,
			`Upgrading ${root} would violate ${violations.length} foreign key constraint(s); the previous database is unchanged`,
		);
	}
	writeMeta(db, "schema_version", String(QUEUE_SCHEMA_VERSION));
}

/**
 * Gives every round that already ran a context its durable affinity and its
 * usage record.
 *
 * The upgrade must not pretend that a conversation which already carried a
 * task is clean: if the old rows are left alone, the new pool would hand that
 * conversation to an unrelated task and mix two tasks into one transcript.
 *
 * The rule is conservative on purpose:
 *
 *  - a round with a concrete `selected_session` really did run there, so the
 *    context is *used* and the task is pinned to it;
 *  - a round that only names a session in its target policy but never selected
 *    one was never dispatched (or its selection was cleared by a rollback), so
 *    it is pinned to that context but recorded as *reserved*, not used;
 *  - a round with no concrete context at all keeps no affinity, because there
 *    is nothing to pin it to.
 */
function backfillContextIsolation(db: Database): void {
	const rows = db
		.query(
			`SELECT task_id, round, selected_session, target_policy_json, dispatch_state, status
			 FROM rounds ORDER BY task_id ASC, round ASC`,
		)
		.all() as Array<{
		task_id: string;
		round: number;
		selected_session: string | null;
		target_policy_json: string;
		dispatch_state: string;
		status: string;
	}>;
	for (const row of rows) {
		const selected = typeof row.selected_session === "string" ? row.selected_session : null;
		let policySession: string | null = null;
		try {
			const policy = JSON.parse(row.target_policy_json) as { kind?: string; sessionId?: string };
			if (policy.kind === "session" && typeof policy.sessionId === "string") {
				policySession = policy.sessionId;
			}
		} catch {
			// A malformed policy is left alone: it cannot name a context, and
			// inventing one would be worse than recording nothing.
			policySession = null;
		}
		const sessionId = selected ?? policySession;
		if (sessionId === null) {
			continue;
		}
		// A round that was armed or ended definitely used its context; a round
		// that never left only reserved it.
		const state = row.dispatch_state === "not_sent" ? "reserved" : "used";
		db.run(
			`INSERT OR IGNORE INTO session_usage(session_id, task_id, first_round, state, first_used_at)
			 VALUES(?, ?, ?, ?, ?)`,
			[sessionId, row.task_id, row.round, state, Date.now()],
		);
		db.run(
			`INSERT OR IGNORE INTO task_sessions(task_id, session_id, round, kind, assigned_at, updated_at)
			 VALUES(?, ?, ?, 'pinned', ?, ?)`,
			[row.task_id, sessionId, row.round, Date.now(), Date.now()],
		);
	}
}

/** Lists task ids under the project's tasks directory. */
async function listTaskIds(root: string): Promise<string[]> {
	const tasksRoot = path.join(root, ".wb-bridge", "tasks");
	try {
		// Strict UUID shape (8-4-4-4-12), matching tasks.ts's own UUID_PATTERN:
		// a stray directory is filtered out here rather than surfacing later as
		// a misleading "unreadable receipt" issue.
		return (await readdir(tasksRoot)).filter((name) =>
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name),
		);
	} catch {
		return [];
	}
}
