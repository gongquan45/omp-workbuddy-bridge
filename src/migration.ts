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
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { canonicalProjectRoot, initializeProjectDatabase, openReadConnection, openWriteConnection, withImmediate, readMeta, writeMeta, nextRevision, closeQueueConnection } from "./queue";
import { readAllWorkRecords } from "./collaboration";
import { readBinding, readTask, readTaskLock, isPidAlive, WbTaskError } from "./tasks";
import { WB_ERROR_CODE, type TaskReceipt } from "./types";

/** The DNS namespace UUIDv5 uses; the plan fixes it for legacy request ids. */
const UUID5_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Derives the deterministic legacy requestId for one imported round:
 * UUIDv5 over `omp-wb-bridge/legacy/<taskId>/<round>` in the DNS namespace,
 * so the same history always imports to the same identity.
 */
export function legacyRequestId(taskId: string, round: number): string {
	const name = `omp-wb-bridge/legacy/${taskId}/${round}`;
	const namespace = uuidStringToBytes(UUID5_DNS_NAMESPACE);
	const bytes = new Uint8Array(16 + name.length);
	bytes.set(namespace, 0);
	for (let i = 0; i < name.length; i++) {
		bytes[16 + i] = name.charCodeAt(i) & 0xff;
	}
	const digest = new Uint8Array(awaitCryptoDigest(bytes));
	// Set version 5 and variant bits per RFC 4122.
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

function awaitCryptoDigest(bytes: Uint8Array): Uint8Array {
	return createHash("sha1").update(bytes).digest();
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
	// nothing to do. A database WITHOUT the marker is a previous attempt that
	// died mid-flight — it must be migrated into (or fail loudly), never
	// mistaken for a finished migration. The gate check is read-only: the
	// census below must stay the first thing this module writes.
	if (existsSync(dbPath)) {
		const existing = openReadConnection(canonicalRoot);
		if (existing === null) {
			throw new WbTaskError(
				WB_ERROR_CODE.storageError,
				`Project state database at ${dbPath} exists but cannot be opened read-only`,
			);
		}
		try {
			if (readMeta(existing, "migration_completed") !== null) {
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
	// openWriteConnection below is the first byte this module writes.
	const db = openWriteConnection(canonicalRoot);
	try {
		withImmediate(db, () => {
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
				writeMeta(db, "project_enabled_at", new Date().toISOString());
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
					// A legacy receipt-only task gets its historical work record so
					// receipt-only and collaboration-linked projects merge uniformly.
					const workId = `work-${taskId}-${round.number}`;
					db.run(
						`INSERT OR IGNORE INTO works(work_id, revision, state, record_json, task_id, round)
						 VALUES(?, ?, 'released', ?, ?, ?)`,
						[
							workId,
							nextRevision(db),
							JSON.stringify({
								version: 1,
								workId,
								projectRoot: canonicalRoot,
								owner: "omp",
								source: "delegated",
								taskId,
								round: round.number,
								nativeRef: null,
								title: round.goal.objective.slice(0, 80),
								scope: null,
								state: "released",
								phase: "history",
								milestone: "",
								blocker: "",
								updatedAt: new Date(round.consent ? Date.parse(round.consent.at) || Date.now() : Date.now()).toISOString(),
								revision: 1,
								artifacts: [],
								remoteResults: [],
								reviews: [],
							}),
							taskId,
							round.number,
						],
					);
				}
			}

			// Collaboration records: imported with their real state, matching the
			// same workId as a same-id receipt round where one exists.
			for (const record of works) {
				const round = record.round ?? 0;
				const workId = record.taskId !== null ? `work-${record.taskId}-${round}` : record.workId;
				db.run(
					`INSERT INTO works(work_id, revision, state, record_json, task_id, round)
					 VALUES(?, ?, ?, ?, ?, ?)
					 ON CONFLICT(work_id) DO UPDATE SET record_json = excluded.record_json, state = excluded.state`,
					[
						workId,
						nextRevision(db),
						record.state,
						JSON.stringify(record),
						record.taskId,
						record.round,
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
			writeMeta(db, "migration_completed", new Date().toISOString());
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
