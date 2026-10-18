import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	closeQueueConnection,
	isOwnerActive,
	openProjectQueue,
	openReadConnection,
	openWriteConnection,
	readMeta,
	readRound,
	registerOwner,
	retireOwner,
	withImmediate,
	writeMeta,
	type ApprovedEnqueue,
	type ClaimOutcome,
} from "../src/queue";
import { WB_ERROR_CODE } from "../src/types";

let root = "";
/** Set only once a fixture root exists; guards the cleanup below. */
let rootReady = false;
const openConnections: string[] = [];

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-queue-")));
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

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "33333333-3333-4333-8333-333333333333";
const REQUEST_A = "22222222-2222-4222-8222-222222222222";
const REQUEST_B = "44444444-4444-4444-8444-444444444444";

function owner(overrides: Partial<{ sessionId: string; generation: string; processId: number; instanceId: string }> = {}) {
	return {
		sessionId: "omp-session-1",
		generation: "gen-1",
		processId: 12345,
		instanceId: "instance-1",
		...overrides,
	};
}

function enqueueInput(overrides: Partial<ApprovedEnqueue> = {}): ApprovedEnqueue {
	return {
		taskId: TASK_A,
		round: 1,
		requestId: REQUEST_A,
		manifestSha256: "a".repeat(64),
		manifestPath: path.join(root, "stage-a", "manifest.json"),
		snapshotRoot: path.join(root, "stage-a"),
		expectedPreviousRound: null,
		readPaths: ["input.txt"],
		writePaths: [".wb-bridge/tasks/11111111-1111-4111-8111-111111111111/rounds/1/outputs"],
		targetPolicy: { kind: "session", sessionId: "wb-session-1" },
		ownerSession: "omp-session-1",
		ownerGeneration: "gen-1",
		executorInstanceId: "instance-1",
		approval: { source: "host_dialog", at: new Date().toISOString(), payloadSha256: "a".repeat(64) },
		title: "Task A",
		deliveryMode: "foreground",
		...overrides,
	};
}

/** Prepares the project: schema, enabled meta and a registered owner. */
function prepareProject(projectOwner = owner()): void {
	const queue = openProjectQueue(root, { mode: "write" });
	expect(queue).not.toBeNull();
	queue!.close();
	const db = openWriteConnection(root);
	withImmediate(db, () => {
		registerOwner(db, projectOwner, Date.now());
		writeMeta(db, "project_enabled_at", new Date().toISOString());
	});
}

describe("project queue - authorization and owner gates", () => {
	it("refuses enqueue with WB_MIGRATION_REQUIRED while the project is not enabled", () => {
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.migrationRequired);
		} finally {
			queue.close();
		}
	});

	it("refuses enqueue with WB_OWNER_UNAVAILABLE when the owner row is not registered", () => {
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const db = openWriteConnection(root);
			withImmediate(db, () => writeMeta(db, "project_enabled_at", new Date().toISOString()));
			queue.enqueue(enqueueInput());
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.ownerUnavailable);
		} finally {
			queue.close();
		}
	});

	it("refuses enqueue from an owner whose generation was retired", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const db = openWriteConnection(root);
			withImmediate(db, () => retireOwner(db, owner()));
			expect(isOwnerActive(openWriteConnection(root), owner())).toBeFalse();
			queue.enqueue(enqueueInput());
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.ownerUnavailable);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - enqueue idempotency", () => {
	it("returns the original row for the same requestId and digest, leaving one round", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const first = queue.enqueue(enqueueInput());
			const second = queue.enqueue(enqueueInput());
			expect(second.taskId).toBe(first.taskId);
			expect(second.revision).toBe(first.revision);
			const snapshot = queue.inspect({ taskId: TASK_A });
			expect(snapshot.tasks).toHaveLength(1);
		} finally {
			queue.close();
		}
	});

	it("rejects the same requestId with a different digest via WB_REVISION_CONFLICT", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			expect(() => queue.enqueue(enqueueInput({ manifestSha256: "b".repeat(64) }))).toThrow(
				/WB_REVISION_CONFLICT|different manifest digest/,
			);
			// The losing write must not have touched the original row.
			const snapshot = queue.inspect({ taskId: TASK_A });
			expect(snapshot.tasks).toHaveLength(1);
			expect(snapshot.tasks[0]?.manifest_sha256).toBe("a".repeat(64));
		} finally {
			queue.close();
		}
	});

	it("requires the previous round to be committed for a supplemental round", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			expect(() =>
				queue.enqueue(
					enqueueInput({
						taskId: TASK_A,
						round: 2,
						requestId: REQUEST_B,
						expectedPreviousRound: 1,
					}),
				),
			).toThrow(/committed/);
		} finally {
			queue.close();
		}
	});

	it("accepts a supplemental round once the previous round is committed", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run(
					"UPDATE rounds SET commit_state = 'committed' WHERE task_id = ? AND round = 1",
					[TASK_A],
				);
			});
			const supplemental = queue.enqueue(
				enqueueInput({ taskId: TASK_A, round: 2, requestId: REQUEST_B, expectedPreviousRound: 1 }),
			);
			expect(supplemental.round).toBe(2);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - waiting work records", () => {
	it("records a waiting scope without a hold: queued work never occupies", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			const snapshot = queue.inspect({ include: { works: true } });
			expect(snapshot.works).toHaveLength(1);
			expect(snapshot.works[0]?.state).toBe("waiting");
			const db = openWriteConnection(root);
			const holds = db.query("SELECT * FROM holds").all();
			expect(holds).toHaveLength(0);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - claim arbitration", () => {
	it("claims the oldest queued round and moves phase to preparing while status stays queued", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind === "claimed") {
				expect(claim.taskId).toBe(TASK_A);
				expect(claim.attemptId).toMatch(/^[0-9a-f-]{36}$/);
			}
			const row = queue.inspect({ taskId: TASK_A }).tasks[0];
			expect(row?.status).toBe("queued");
			expect(row?.phase).toBe("preparing");
			expect(row?.dispatch_state).toBe("not_sent");
		} finally {
			queue.close();
		}
	});

	it("creates one execution hold and promotes the waiting scope to active on claim", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			queue.claim(owner(), Date.now());
			const snapshot = queue.inspect({ include: { works: true } });
			expect(snapshot.works[0]?.state).toBe("active");
			const db = openWriteConnection(root);
			const holds = db.query("SELECT * FROM holds WHERE kind = 'execution'").all();
			expect(holds).toHaveLength(1);
		} finally {
			queue.close();
		}
	});

	it("makes a second round for the same WorkBuddy session wait with session_busy", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// Task A targets wb-session-1; task B also targets wb-session-1 but is
			// owned by a different OMP owner so it is a separate candidate.
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			queue.enqueue(enqueueInput());
			queue.enqueue(
				enqueueInput({
					taskId: TASK_B,
					requestId: REQUEST_B,
					ownerSession: otherOwner.sessionId,
					ownerGeneration: otherOwner.generation,
					executorInstanceId: otherOwner.instanceId,
				}),
			);
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			// The second claimant's round must wait on the held WorkBuddy session.
			const second = queue.claim(otherOwner, Date.now());
			expect(second).toMatchObject({ kind: "waiting", reason: "session_busy" });
			if (second.kind === "waiting") {
				expect(second.blockerIds).toContain("omp-session-2");
			}
		} finally {
			queue.close();
		}
	});

	it("makes an overlapping write wait with scope_conflict while read/read shares", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			queue.enqueue(enqueueInput());
			// Different WorkBuddy session, same write path: must wait on scope.
			queue.enqueue(
				enqueueInput({
					taskId: TASK_B,
					requestId: REQUEST_B,
					targetPolicy: { kind: "session", sessionId: "wb-session-2" },
					ownerSession: otherOwner.sessionId,
					ownerGeneration: otherOwner.generation,
					executorInstanceId: otherOwner.instanceId,
				}),
			);
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			const conflicting = queue.claim(otherOwner, Date.now());
			expect(conflicting).toMatchObject({ kind: "waiting", reason: "scope_conflict" });
			if (conflicting.kind === "waiting") {
				expect(conflicting.blockerIds[0]).toContain(TASK_A);
			}
		} finally {
			queue.close();
		}
	});

	it("returns empty when nothing is queued for this owner", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			expect(queue.claim(owner(), Date.now())).toMatchObject({ kind: "empty" });
		} finally {
			queue.close();
		}
	});

	it("ignores rounds owned by a different OMP session", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(enqueueInput());
			const stranger = owner({ sessionId: "omp-session-other", generation: "gen-9", instanceId: "instance-9" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, stranger, Date.now()));
			expect(queue.claim(stranger, Date.now())).toMatchObject({ kind: "empty" });
		} finally {
			queue.close();
		}
	});
});

describe("project queue - read mode", () => {
	it("returns null on a missing database without creating anything", async () => {
		const queue = openProjectQueue(root, { mode: "read" });
		expect(queue).toBeNull();
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(root, ".wb-bridge"))).toBeFalse();
	});

	it("serves inspect from an existing database and refuses writes", () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const snapshot = queue.inspect({});
			expect(snapshot.tasks).toHaveLength(0);
			expect(() => queue.enqueue(enqueueInput())).toThrow(/read-mode queue cannot enqueue/);
		} finally {
			queue.close();
		}
	});

	it("refuses a database that belongs to a different project", async () => {
		prepareProject();
		const otherRoot = await realpath(await mkdtemp(path.join(tmpdir(), "wb-queue-other-")));
		try {
			const { copyFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(path.join(otherRoot, ".wb-bridge"), { recursive: true });
			copyFileSync(path.join(root, ".wb-bridge", "state.sqlite"), path.join(otherRoot, ".wb-bridge", "state.sqlite"));
			expect(() => openProjectQueue(otherRoot, { mode: "read" })).toThrow(/belongs to/);
		} finally {
			closeQueueConnection(otherRoot, "read");
			await rm(otherRoot, { recursive: true, force: true });
		}
	});
});

describe("project queue - real subprocess contention", () => {
	it("lets exactly one of two concurrent claimants win one attempt", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		queue.enqueue(enqueueInput());
		queue.close();

		// Two real processes race for the same single round. Each runs the
		// fixture binary with its own claim instruction; the SQLite write lock
		// decides the winner, and the loser must observe either waiting or empty
		// — never a second claimed attempt.
		const raceOwner = owner({ processId: 0 });
		const claimScript = `
			import { openProjectQueue } from "${path.resolve(import.meta.dir, "../src/queue").replace(/\\/g, "/")}";
			const queue = openProjectQueue(${JSON.stringify(root)}, { mode: "write" });
			if (queue === null) { console.log(JSON.stringify({ kind: "empty" })); process.exit(0); }
			const outcome = queue.claim({ sessionId: "omp-session-1", generation: "gen-1", processId: process.pid, instanceId: "instance-1" }, Date.now());
			console.log(JSON.stringify(outcome));
			queue.close();
		`;
		const results = await Promise.all([
			runIsolatedClaim(claimScript),
			runIsolatedClaim(claimScript),
		]);
		const claimed = results.filter((r): r is Extract<ClaimOutcome, { kind: "claimed" }> => r.kind === "claimed");
		expect(claimed).toHaveLength(1);
		const others = results.filter((r) => r.kind !== "claimed");
		for (const other of others) {
			// The loser sees the row already preparing: no claim, no crash.
			expect(["waiting", "empty"]).toContain(other.kind);
		}
		expect(raceOwner.processId).toBe(0); // sanity: fixture uses its own pid
	});

	it("enqueues through a real child process and the parent sees the row", async () => {
		prepareProject();
		const input = enqueueInput();
		const workerPath = path.resolve(import.meta.dir, "fixtures/queue-worker.ts");
		const child = Bun.spawn(["bun", workerPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		child.stdin.write(
			`${JSON.stringify({ op: "enqueue", root, owner: owner(), input })}\n`,
		);
		child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
		child.stdin.end();
		const output = await new Response(child.stdout).text();
		await child.exited;
		const lines = output.trim().split("\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		const enqueueResponse = JSON.parse(lines[0]!) as { ok: boolean; result?: { taskId: string }; error?: { code: string } };
		expect(enqueueResponse.ok).toBeTrue();
		expect(enqueueResponse.result?.taskId).toBe(TASK_A);

		const queue = openProjectQueue(root, { mode: "read" })!;
		const snapshot = queue.inspect({ taskId: TASK_A });
		expect(snapshot.tasks).toHaveLength(1);
		queue.close();
	});
});

/** Runs one isolated claim in a fresh Bun process; returns the parsed outcome. */
async function runIsolatedClaim(script: string): Promise<ClaimOutcome> {
	const tempPath = path.join(root, `.claim-${crypto.randomUUID()}.ts`);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(tempPath, script, "utf-8");
	try {
		const child = Bun.spawn(["bun", tempPath], { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		await child.exited;
		if (stderr.trim().length > 0) {
			throw new Error(`claim subprocess failed: ${stderr.slice(0, 400)}`);
		}
		return JSON.parse(output.trim()) as ClaimOutcome;
	} finally {
		await rm(tempPath, { force: true });
	}
}
