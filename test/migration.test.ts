import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	closeQueueConnection,
	openProjectQueue,
	openWriteConnection,
	readMeta,
	readProjectAccess,
	withImmediate,
} from "../src/queue";
import { legacyRequestId, migrateProjectToQueue } from "../src/migration";
import { atomicWriteFile } from "../src/storage";
import { WbTaskError } from "../src/tasks";
import { WB_ERROR_CODE, type TaskReceipt } from "../src/types";
import { spawn, process } from "node:child_process";

let root = "";
/** Set only once a fixture root exists; guards the cleanup below. */
let rootReady = false;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-migration-")));
	rootReady = true;
});

afterEach(async () => {
	// Guard against a setup failure leaving root unset: rm("") would
	// resolve against the process cwd, which for bun test is this repository.
	if (!rootReady || !path.isAbsolute(root) || root.length < 8) {
		return;
	}
	rootReady = false;
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	await rm(root, { recursive: true, force: true });
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
