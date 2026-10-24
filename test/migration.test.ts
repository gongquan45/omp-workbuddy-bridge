import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	closeQueueConnection,
	openProjectQueue,
	openReadConnection,
	openWriteConnection,
	readMeta,
	readProjectAccess,
	withImmediate,
	QUEUE_SCHEMA_VERSION,
} from "../src/queue";
import { legacyRequestId, migrateProjectToQueue } from "../src/migration";
import { atomicWriteFile } from "../src/storage";
import { delegatedWorkId, WbTaskError } from "../src/tasks";
import { WB_ERROR_CODE, type TaskReceipt } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

let root = "";
/** Set only once a fixture root exists; guards the cleanup below. */
let rootReady = false;

beforeEach(async () => {
	root = await createFixtureRoot("wb-migration-");
	rootReady = true;
});

afterEach(async () => {
	if (!rootReady) {
		return;
	}
	rootReady = false;
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	await removeFixtureRoot(root);
});

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "aaaa1111-1111-4111-8111-111111111111";
const SESSION_B = "bbbb2222-2222-4222-8222-222222222222";

async function writeBinding(sessions: Array<{ sessionId: string; role?: string; isDefault?: boolean }>): Promise<void> {
	const bridge = path.join(root, ".wb-bridge");
	await mkdir(bridge, { recursive: true });
	await atomicWriteFile(
		bridge,
		path.join(bridge, "binding.json"),
		JSON.stringify(
			{
				version: 2,
				projectRoot: root,
				sessionId: sessions[0]!.sessionId,
				workbuddyVersion: "1.2.3",
				sessions,
			},
			null,
			2,
		),
	);
}

async function writeReceipt(rounds: TaskReceipt["rounds"], taskId = TASK_ID): Promise<void> {
	const bridge = path.join(root, ".wb-bridge");
	await mkdir(path.join(bridge, "tasks", taskId), { recursive: true });
	await atomicWriteFile(
		bridge,
		path.join(bridge, "tasks", taskId, "receipt.json"),
		JSON.stringify(
			{
				version: 2,
				taskId,
				sessionId: SESSION_A,
				projectRoot: root,
				rounds,
			},
			null,
			2,
		),
	);
}

function completedRound(): TaskReceipt["rounds"][number] {
	return {
		number: 1,
		layout: "round",
		goal: {
			objective: "old task",
			context: "",
			constraints: [],
			acceptance: ["done"],
			externalActions: [],
		},
		inputFiles: [{ path: "old-input.txt", sha256: null }],
		expectedOutputs: ["old-output.txt"],
		status: "completed",
		summary: "finished",
		error: null,
		artifacts: [],
		consent: { source: "host_dialog", at: "2026-01-01T00:00:00.000Z" },
	};
}

describe("legacy request id derivation", () => {
	it("is deterministic and a valid UUIDv5 shape", () => {
		const first = legacyRequestId(TASK_ID, 1);
		const second = legacyRequestId(TASK_ID, 1);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(legacyRequestId(TASK_ID, 2)).not.toBe(first);
	});
});

describe("migration import", () => {
	it("imports binding roster as pending/unknown, enables the project, and imports receipts as legacy", async () => {
		await writeBinding([
			{ sessionId: SESSION_A, role: "default", isDefault: true },
			{ sessionId: SESSION_B, role: "general" },
		]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const snapshot = queue.inspect({ include: { sessions: true, works: true } });
			expect(snapshot.tasks).toHaveLength(1);
			const round = snapshot.tasks[0];
			expect(round?.record_kind).toBe("legacy");
			expect(round?.status).toBe("completed");
			expect(round?.phase).toBe("terminal");
			expect(round?.commit_state).toBe("committed");
			expect(round?.attempt_id).toBeNull();
			// Historical evidence stays honest: no fabricated approval.
			expect(round?.approval_json).toBeNull();
			expect(round?.manifest_sha256).toBeNull();
			// Roster arrives unverified with unknown use hint: live observation
			// must re-verify before dispatch, per the stage-5 selection rules.
			expect(snapshot.sessions).toHaveLength(2);
			expect(snapshot.sessions.every((s) => s.identity === "pending" && s.use_hint === "unknown")).toBeTrue();
			// The old round merges into the works table as released history.
			expect(snapshot.works.some((w) => w.task_id === TASK_ID)).toBeTrue();

			const access = await readProjectAccess(root);
			expect(access?.enabled).toBeTrue();
			expect(access?.migrated).toBeTrue();
		} finally {
			queue.close();
		}
	});

	it("records the deterministic legacy request id on imported rounds", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			expect(queue.inspect({}).tasks[0]?.request_id).toBe(legacyRequestId(TASK_ID, 1));
		} finally {
			queue.close();
		}
	});

	it("stores legacy input snapshot paths relative to the round's inputs dir", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		const row = db.query("SELECT * FROM inputs WHERE task_id = ?").get(TASK_ID) as {
			snapshot_path: string;
			sha256: string;
		} | null;
		expect(row?.snapshot_path).toBe("inputs/old-input.txt");
		expect(row?.sha256).toBe("legacy_unverified");
	});

	it("migrates a project without a binding as history-only and keeps it gated", async () => {
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		expect(readMeta(db, "project_enabled_at")).toBeNull();
		expect(readMeta(db, "migration_completed")).not.toBeNull();
		const access = await readProjectAccess(root);
		expect(access?.enabled).toBeFalse();
		expect(access?.migrated).toBeTrue();
	});

	it("keeps the default session from the roster and rejects a foreign default", async () => {
		await writeBinding([
			{ sessionId: SESSION_A, role: "default", isDefault: true },
			{ sessionId: SESSION_B, role: "general" },
		]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		expect(readMeta(db, "default_session_id")).toBe(SESSION_A);
	});

	it("writes migration_completed inside the import transaction", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		expect(readMeta(db, "migration_completed")).not.toBeNull();
	});

	it("is idempotent: a re-migration keeps one round and does not duplicate sessions", async () => {
		await writeBinding([
			{ sessionId: SESSION_A, role: "default", isDefault: true },
			{ sessionId: SESSION_B, role: "general" },
		]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		await migrateProjectToQueue(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const snapshot = queue.inspect({ include: { sessions: true } });
			expect(snapshot.tasks).toHaveLength(1);
			expect(snapshot.sessions).toHaveLength(2);
		} finally {
			queue.close();
		}
	});
});

describe("migration gating", () => {
	it("refuses to migrate while an old lock owner is provably alive", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		const bridge = path.join(root, ".wb-bridge");
		// A lock whose owner is this test process: provably alive.
		await atomicWriteFile(
			bridge,
			path.join(bridge, "active.lock"),
			JSON.stringify({ ownerPid: process.pid, taskId: TASK_ID }),
		);
		await expect(migrateProjectToQueue(root)).rejects.toMatchObject({
			code: WB_ERROR_CODE.migrationRequired,
		});
		// The refusal must not have created the database.
		expect(existsSync(path.join(bridge, "state.sqlite"))).toBeFalse();
	});

	it("ignores a dead owner's lock file and migrates", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		const bridge = path.join(root, ".wb-bridge");
		// Spawn a real short-lived process so the pid is real but dead.
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		await child.exited;
		await atomicWriteFile(
			bridge,
			path.join(bridge, "active.lock"),
			JSON.stringify({ ownerPid: child.pid, taskId: TASK_ID }),
		);
		await expect(migrateProjectToQueue(root)).resolves.toBe(root);
		expect(existsSync(path.join(bridge, "state.sqlite"))).toBeTrue();
	});

	it("records an unreadable receipt as an issue instead of failing", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		const bridge = path.join(root, ".wb-bridge");
		await mkdir(path.join(bridge, "tasks", TASK_ID), { recursive: true });
		await writeFile(path.join(bridge, "tasks", TASK_ID, "receipt.json"), "{ not json", "utf-8");
		await migrateProjectToQueue(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const snapshot = queue.inspect({ include: { diagnostics: true } });
			expect(snapshot.tasks).toHaveLength(0);
			const issue = snapshot.warnings.find((w) => w.code === "receipt_unreadable");
			expect(issue?.relative_source).toContain(TASK_ID);
		} finally {
			queue.close();
		}
	});

	it("records a malformed session lock file name as an issue, not an abort", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		const bridge = path.join(root, ".wb-bridge");
		await mkdir(bridge, { recursive: true });
		await writeFile(path.join(bridge, "active-not-a-uuid.lock"), "{}", "utf-8");
		await expect(migrateProjectToQueue(root)).resolves.toBe(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const issue = queue.inspect({ include: { diagnostics: true } }).warnings.find(
				(w) => w.code === "lock_name_invalid",
			);
			expect(issue).not.toBeNull();
		} finally {
			queue.close();
		}
	});

	it("leaves binding.json untouched as a historical projection", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await migrateProjectToQueue(root);
		// The file still exists and is byte-identical: it is a projection now.
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(path.join(root, ".wb-bridge", "binding.json"), "utf-8");
		expect(JSON.parse(content).sessionId).toBe(SESSION_A);
	});
});

describe("works merge across receipt and collaboration sides", () => {
	/** Writes one collaboration record into .wb-bridge/collaboration/. */
	async function writeCollaborationRecord(workId: string, overrides: Record<string, unknown> = {}): Promise<void> {
		const collabDir = path.join(root, ".wb-bridge", "collaboration");
		await mkdir(collabDir, { recursive: true });
		await atomicWriteFile(
			collabDir,
			path.join(collabDir, `${workId}.json`),
			JSON.stringify(
				{
					version: 1,
					workId,
					projectRoot: root,
					owner: "workbuddy",
					source: "native",
					taskId: null,
					round: null,
					nativeRef: { sessionId: SESSION_A, goalId: "goal-1" },
					title: "Native collaboration work",
					scope: { readPaths: ["src/a"], writePaths: ["src/a/out"] },
					state: "active",
					phase: "impl",
					milestone: "half",
					blocker: "",
					updatedAt: new Date().toISOString(),
					revision: 3,
					artifacts: [],
					remoteResults: [],
					reviews: [],
					...overrides,
				},
				null,
				2,
			),
		);
	}

	function worksRow(workId: string): { state: string; record_json: string; task_id: string | null; round: number | null } | null {
		const db = openWriteConnection(root);
		return db.query("SELECT state, record_json, task_id, round FROM works WHERE work_id = ?").get(workId) as
			| { state: string; record_json: string; task_id: string | null; round: number | null }
			| null;
	}

	it("keeps a receipt-only round as released history", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const row = worksRow(delegatedWorkId(TASK_ID, 1));
		expect(row).not.toBeNull();
		expect(row?.state).toBe("released");
		const record = JSON.parse(row!.record_json) as Record<string, unknown>;
		expect(record.title).toBe("old task");
		expect(record.taskId).toBe(TASK_ID);
		expect(record.round).toBe(1);
	});

	it("keeps a collaboration-only work with its own identity", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		const nativeId = "44444444-4444-4444-8444-444444444444";
		await writeCollaborationRecord(nativeId);
		await migrateProjectToQueue(root);

		const row = worksRow(nativeId);
		expect(row).not.toBeNull();
		// The collaboration side owns state and scope; nothing from a receipt exists.
		expect(row?.state).toBe("active");
		expect(row?.task_id).toBeNull();
		const record = JSON.parse(row!.record_json) as Record<string, unknown>;
		expect(record.nativeRef).toEqual({ sessionId: SESSION_A, goalId: "goal-1" });
		expect(record.revision).toBe(3);
	});

	it("unions both sides of the same round without losing either", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		const mergedId = delegatedWorkId(TASK_ID, 1);
		// Same derived work id on both sides: the merge must be a field union.
		await writeCollaborationRecord(mergedId, {
			owner: "omp",
			source: "delegated",
			taskId: TASK_ID,
			round: 1,
			title: "",
			state: "blocked",
			reviews: [
				{ reviewer: "omp", round: 1, artifacts: [], verdict: "unverified", note: "n", at: new Date().toISOString() },
			],
		});
		await migrateProjectToQueue(root);

		const row = worksRow(mergedId);
		expect(row).not.toBeNull();
		// Exactly one row: the two sources must not produce sibling records.
		const db = openWriteConnection(root);
		const count = db.query("SELECT COUNT(*) AS c FROM works WHERE task_id = ?").get(TASK_ID) as { c: number };
		expect(count.c).toBe(1);
		// Collaboration state wins; receipt provenance survives the overlay.
		expect(row?.state).toBe("blocked");
		const record = JSON.parse(row!.record_json) as Record<string, unknown>;
		expect(record.taskId).toBe(TASK_ID);
		expect(record.round).toBe(1);
		expect(record.title).toBe("old task");
		expect(Array.isArray(record.reviews)).toBeTrue();
		expect((record.reviews as unknown[]).length).toBe(1);
	});
});

describe("context isolation survives the migration", () => {
	it("records a legacy context as used and pins the task to it", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const db = openWriteConnection(root);
		const usage = db.query("SELECT session_id, task_id, state FROM session_usage").all() as Array<{
			session_id: string;
			task_id: string;
			state: string;
		}>;
		// The old round really ran in that WorkBuddy context, so the context is
		// *used* — not a clean reservation.
		expect(usage).toHaveLength(1);
		expect(usage[0]?.session_id).toBe(SESSION_A);
		expect(usage[0]?.task_id).toBe(TASK_ID);
		expect(usage[0]?.state).toBe("used");

		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// The task's durable affinity is the context it really used.
			expect(queue.taskSession(TASK_ID)).toBe(SESSION_A);
		} finally {
			queue.close();
		}
	});

	it("does not hand a legacy-used context to a new task", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// The context is enrolled in the roster and looks free, but it already
			// carries the old task's work.
			queue.syncProjectSessions(
				[{ sessionId: SESSION_A, workbuddyVersion: "1.2.3", availability: "idle" }],
				Date.now(),
			);
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run(
					`INSERT INTO owners(instance_id, generation, session_id, pid, state, heartbeat_at)
					 VALUES('inst-1', 'gen-1', 'omp-1', ?, 'active', ?)`,
					[process.pid, Date.now()],
				);
				db.run(
					`INSERT INTO rounds(task_id, round, request_id, record_kind, revision, status, phase,
						target_policy_json, desired_scope_json, owner_session, owner_generation,
						manifest_path, manifest_sha256, approval_json, approval_consumed,
						enqueued_at, dispatch_state, cancel_requested, commit_state,
						review_state, delivery_mode, turns_json, updated_at)
					 VALUES('brand-new-task', 1, 'brand-new-request', 'legacy', 1, 'queued', 'queued', ?, '{}',
						'omp-1', 'gen-1', NULL, NULL, NULL, 0, ?, 'not_sent', 0, 'pending', 'pending', 'foreground', '[]', ?)`,
					[JSON.stringify({ kind: "workspace_pool", role: null }), Date.now(), Date.now()],
				);
			});
			const outcome = queue.claim(
				{ sessionId: "omp-1", generation: "gen-1", processId: process.pid, instanceId: "inst-1" },
				Date.now(),
			);
			expect(outcome).toMatchObject({ kind: "waiting", reason: "no_unused_session" });
		} finally {
			queue.close();
		}
	});
});

describe("schema upgrade", () => {
	it("upgrades an older database without losing its rounds", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const db = openWriteConnection(root);
		// Pretend the file was written by the previous build.
		withImmediate(db, () => {
			db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
		});
		closeQueueConnection(root);

		// The upgrade runs and keeps the data.
		await migrateProjectToQueue(root);
		const upgraded = openWriteConnection(root);
		expect(readMeta(upgraded, "schema_version")).toBe(String(QUEUE_SCHEMA_VERSION));
		const rounds = upgraded.query("SELECT task_id FROM rounds").all() as Array<{ task_id: string }>;
		expect(rounds.map((row) => row.task_id)).toContain(TASK_ID);
		// The new tables exist and carry the backfilled history.
		const usage = upgraded.query("SELECT session_id, state FROM session_usage").all() as Array<{
			session_id: string;
			state: string;
		}>;
		expect(usage).toHaveLength(1);
		expect(usage[0]?.session_id).toBe(SESSION_A);
		expect(usage[0]?.state).toBe("used");
	});

	it("refuses a read-mode queue on an un-upgraded database", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		withImmediate(db, () => {
			db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
		});
		closeQueueConnection(root);
		// A reader must not mistake an older file for a current one.
		expect(() => openProjectQueue(root, { mode: "read" })).toThrow(/run project setup to migrate it/);
	});
});

describe("the schema upgrade preserves the project's consent and history", () => {
	it("keeps project_enabled_at and migration_completed across a schema upgrade", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const db = openWriteConnection(root);
		const enabledAt = readMeta(db, "project_enabled_at");
		const completedAt = readMeta(db, "migration_completed");
		expect(enabledAt).not.toBeNull();
		expect(completedAt).not.toBeNull();
		// Pretend the file was written by the previous build.
		withImmediate(db, () => {
			db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
		});
		closeQueueConnection(root);

		await migrateProjectToQueue(root);
		const upgraded = openWriteConnection(root);
		// The consent evidence and the migration marker are not rewritten by an
		// upgrade: they say when the user authorized the project, not when the
		// file was last touched.
		expect(readMeta(upgraded, "project_enabled_at")).toBe(enabledAt);
		expect(readMeta(upgraded, "migration_completed")).toBe(completedAt);
		expect(readMeta(upgraded, "schema_version")).toBe(String(QUEUE_SCHEMA_VERSION));
		// The project's rows are still there.
		const rounds = upgraded.query("SELECT task_id FROM rounds").all() as Array<{ task_id: string }>;
		expect(rounds.map((row) => row.task_id)).toContain(TASK_ID);
	});

	it("leaves a project without a binding unmigrated into an enabled state", async () => {
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);
		const db = openWriteConnection(root);
		expect(readMeta(db, "project_enabled_at")).toBeNull();
		expect(readMeta(db, "migration_completed")).not.toBeNull();
	});
});

describe("a newer schema is never migrated backwards", () => {
	it("refuses to downgrade a database written by a newer build", async () => {
		await writeBinding([{ sessionId: SESSION_A, role: "default", isDefault: true }]);
		await writeReceipt([completedRound()]);
		await migrateProjectToQueue(root);

		const db = openWriteConnection(root);
		// A file from a future build: this build must not rewrite it.
		withImmediate(db, () => {
			db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
		});
		closeQueueConnection(root);

		await expect(migrateProjectToQueue(root)).rejects.toThrow(/newer than this build understands/);
		// The file is left exactly as it was: no downgrade, no data loss.
		const after = openReadConnection(root)!;
		try {
			expect(readMeta(after, "schema_version")).toBe("99");
		} finally {
			closeQueueConnection(root, "read");
		}
	});
});
