/**
 * Schema upgrade: an existing v1 project must reach exactly the shape a fresh
 * install has.
 *
 * Every other suite creates a brand-new database, so nothing there would notice
 * a migration that only *creates missing tables* and forgets the column
 * additions (`CREATE TABLE IF NOT EXISTS` never adds a column). This suite
 * builds a real v1 file and upgrades it, which is the only way to prove the two
 * paths converge.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { migrateProjectToQueue } from "../src/migration";
import {
	assertRoundColumns,
	closeQueueConnection,
	ensureRoundsColumns,
	openProjectQueue,
	openWriteConnection,
	QUEUE_SCHEMA_VERSION,
	readMeta,
	withImmediate,
	writeMeta,
} from "../src/queue";
import { WB_ERROR_CODE } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await releaseProjectFixture(root);
		}
	}
});

async function fixtureRoot(): Promise<string> {
	const root = await createFixtureRoot("wb-upgrade-");
	roots.push(root);
	return root;
}

/** Column names of `rounds`, order-insensitive. */
function roundColumns(db: Database): string[] {
	return (db.query("PRAGMA table_info(rounds)").all() as Array<{ name: string }>)
		.map((row) => row.name)
		.sort();
}

/**
 * Builds a database in the *first shipped* shape: the v1 `rounds` table with no
 * package columns, plus a `schema_version` of 1.
 *
 * Written by hand rather than through this build's schema on purpose — using the
 * current DDL would make the test pass no matter what the migration does.
 */
async function writeV1Database(root: string, taskId: string): Promise<void> {
	const bridge = path.join(root, ".wb-bridge");
	await mkdir(bridge, { recursive: true });
	const db = new Database(path.join(bridge, "state.sqlite"), { create: true });
	try {
		db.run("PRAGMA journal_mode=WAL");
		db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		db.run(`CREATE TABLE rounds (
			task_id TEXT NOT NULL,
			round INTEGER NOT NULL,
			request_id TEXT UNIQUE,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('approved','legacy')),
			revision INTEGER NOT NULL,
			result_revision INTEGER,
			status TEXT NOT NULL,
			phase TEXT NOT NULL,
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
			dispatch_state TEXT NOT NULL,
			cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
			outcome_json TEXT,
			commit_state TEXT NOT NULL,
			receipt_sha256 TEXT,
			storage_error_json TEXT,
			review_state TEXT NOT NULL,
			delivery_mode TEXT NOT NULL,
			delivery_consent_json TEXT,
			turns_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (task_id, round)
		)`);
		const now = Date.now();
		db.run(
			`INSERT INTO rounds(task_id, round, request_id, record_kind, revision, status, phase,
				target_policy_json, desired_scope_json, approval_consumed, enqueued_at, dispatch_state,
				cancel_requested, commit_state, review_state, delivery_mode, turns_json, updated_at)
			 VALUES(?, 1, ?, 'legacy', 1, 'completed', 'terminal', ?, ?, 0, ?, 'not_sent', 0, 'pending', 'pending', 'foreground', '[]', ?)`,
			[
				taskId,
				"22222222-2222-4222-8222-222222222222",
				JSON.stringify({ kind: "session", sessionId: "s-1" }),
				JSON.stringify({ readPaths: [], writePaths: [] }),
				now,
				now,
			],
		);
		db.run("INSERT INTO meta(key, value) VALUES('project_root', ?)", [root]);
		db.run("INSERT INTO meta(key, value) VALUES('schema_version', '1')");
	} finally {
		db.close(false);
	}
}

describe("schema upgrade from v1", () => {
	it("adds every rounds column so an upgraded database matches a fresh one", async () => {
		const upgraded = await fixtureRoot();
		const fresh = await fixtureRoot();
		const taskId = "11111111-1111-4111-8111-111111111111";
		await writeV1Database(upgraded, taskId);

		// A fresh database is whatever this build creates today.
		const freshDb = openWriteConnection(fresh);
		const freshColumns = roundColumns(freshDb);
		closeQueueConnection(fresh);

		await migrateProjectToQueue(upgraded);

		const upgradedDb = openWriteConnection(upgraded);
		try {
			expect(roundColumns(upgradedDb)).toEqual(freshColumns);
			// And the columns the new code actually writes are all present.
			expect(freshColumns).toContain("package_id");
			expect(freshColumns).toContain("authorization_revision");
			expect(freshColumns).toContain("purpose");
			expect(() => assertRoundColumns(upgradedDb)).not.toThrow();
			expect(readMeta(upgradedDb, "schema_version")).toBe(String(QUEUE_SCHEMA_VERSION));
		} finally {
			closeQueueConnection(upgraded);
		}

		// The pre-existing round survives as history: it is not rewritten into an
		// authorized round, and no package authorization is invented for it.
		const verify = openWriteConnection(upgraded);
		try {
			const row = verify
				.query("SELECT record_kind, package_id, authorization_id FROM rounds WHERE task_id = ?")
				.get(taskId) as { record_kind: string; package_id: string | null; authorization_id: string | null } | null;
			expect(row?.record_kind).toBe("legacy");
			expect(row?.package_id).toBeNull();
			expect(row?.authorization_id).toBeNull();
		} finally {
			closeQueueConnection(upgraded);
		}
	});

	it("backs the database up before changing it", async () => {
		const root = await fixtureRoot();
		await writeV1Database(root, "11111111-1111-4111-8111-111111111111");

		await migrateProjectToQueue(root);

		// A per-migration backup directory holds a readable copy of the pre-upgrade
		// file, so an interrupted upgrade has something to restore from.
		const backups = path.join(root, ".wb-bridge", "backups");
		const entries = await Array.fromAsync(new Bun.Glob("*/db-before.sqlite").scan({ cwd: backups }));
		expect(entries.length).toBe(1);
		const backup = path.join(backups, entries[0]!);
		const copy = new Database(backup, { readonly: true });
		try {
			const version = copy.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
				| { value: string }
				| null;
			// The snapshot is of the *old* file: it still declares version 1.
			expect(version?.value).toBe("1");
			// And it is a complete database, not a truncated copy.
			const count = copy.query("SELECT COUNT(*) AS n FROM rounds").get() as { n: number };
			expect(count.n).toBe(1);
		} finally {
			copy.close(false);
		}
	});

	it("refuses a newer or unreadable schema version instead of writing it", async () => {
		const root = await fixtureRoot();
		await writeV1Database(root, "11111111-1111-4111-8111-111111111111");
		// Simulate a database written by a future build.
		const db = new Database(path.join(root, ".wb-bridge", "state.sqlite"));
		db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
		db.close(false);

		// The ordinary open path refuses; only the upgrade path may open it.
		expect(() => openWriteConnection(root)).toThrow(/schema version 99/);
		try {
			openWriteConnection(root);
		} catch (err: unknown) {
			expect(err).toMatchObject({ code: WB_ERROR_CODE.migrationRequired });
		}
		// Nothing was created or rewritten by the refused open.
		const bytes = await readFile(path.join(root, ".wb-bridge", "state.sqlite"));
		expect(bytes.length).toBeGreaterThan(0);
		const probe = new Database(path.join(root, ".wb-bridge", "state.sqlite"), { readonly: true });
		try {
			expect(readMeta(probe, "schema_version")).toBe("99");
		} finally {
			// Close the verification handle: an open connection would block cleanup.
			probe.close(false);
		}
	});

	it("refuses a v1 database to the read path as well, with a diagnosable code", async () => {
		const root = await fixtureRoot();
		await writeV1Database(root, "11111111-1111-4111-8111-111111111111");

		// A read surface must reach the same conclusion the writer does. Without
		// this the first version-specific query fails somewhere unrelated, which
		// reads as corruption instead of "run setup".
		expect(() => openProjectQueue(root, { mode: "read" })).toThrow(/schema version 1/);
		try {
			openProjectQueue(root, { mode: "read" });
		} catch (err: unknown) {
			expect(err).toMatchObject({ code: WB_ERROR_CODE.migrationRequired });
		}
	});

	it("is idempotent: upgrading a current database changes nothing", async () => {
		const root = await fixtureRoot();
		await migrateProjectToQueue(root);
		const first = openWriteConnection(root);
		const before = readMeta(first, "schema_version");
		const columnsBefore = roundColumns(first);
		withImmediate(first, () => {
			// Re-running the column helper must be a no-op, not a duplicate-column error.
			ensureRoundsColumns(first);
		});
		expect(roundColumns(first)).toEqual(columnsBefore);
		expect(readMeta(first, "schema_version")).toBe(before);
		closeQueueConnection(root);

		await migrateProjectToQueue(root);
		const after = openWriteConnection(root);
		expect(readMeta(after, "schema_version")).toBe(before);
		expect(roundColumns(after)).toEqual(columnsBefore);
		closeQueueConnection(root);
	});

	it("does not enable a project it only upgraded", async () => {
		const root = await fixtureRoot();
		await writeV1Database(root, "11111111-1111-4111-8111-111111111111");
		await migrateProjectToQueue(root);

		const db = openWriteConnection(root);
		try {
			// Migration imports history; enabling is a separate, explicit user act.
			expect(readMeta(db, "project_enabled_at")).toBeNull();
		} finally {
			closeQueueConnection(root);
		}
	});
});
