import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { Database } from "bun:sqlite";
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
	type ProjectQueue,
} from "../src/queue";
import {
	buildTaskManifestPayload,
	delegatedWorkId,
	hashManifestPayload,
	stageTask,
} from "../src/tasks";
import { WB_ERROR_CODE, type OwnerIdentity, type RoundConfirmationV3, type TaskRequest } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

let root = "";
/** Set only once a fixture root exists; guards the cleanup below. */
let rootReady = false;

beforeEach(async () => {
	root = await createFixtureRoot("wb-queue-");
	rootReady = true;
});

afterEach(async () => {
	if (!rootReady) {
		return;
	}
	rootReady = false;
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	// The helper refuses any path this process did not register, so a broken
	// fixture fails the cleanup instead of deleting an unrelated directory.
	await removeFixtureRoot(root);
});

const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "33333333-3333-4333-8333-333333333333";
const TASK_C = "55555555-5555-4555-8555-555555555555";
const REQUEST_A = "22222222-2222-4222-8222-222222222222";
const REQUEST_B = "44444444-4444-4444-8444-444444444444";
const REQUEST_C = "66666666-6666-4666-8666-666666666666";

function owner(overrides: Partial<{ sessionId: string; generation: string; processId: number; instanceId: string }> = {}) {
	return {
		sessionId: "omp-session-1",
		generation: "gen-1",
		processId: 12345,
		instanceId: "instance-1",
		...overrides,
	};
}

function testRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
	return {
		goal: {
			objective: "stage a frozen snapshot",
			context: "",
			constraints: [],
			acceptance: ["outputs exist"],
			externalActions: [],
		},
		inputFiles: ["input.txt"],
		expectedOutputs: ["result.txt"],
		...overrides,
	};
}

/**
 * Stages a real frozen snapshot through the production path: writes the source
 * input files, derives the manifest payload, and runs `stageTask`. Returns the
 * enqueue input plus the confirmation the caller can reuse for a same-digest
 * re-submission.
 */
async function stageRealSnapshot(options: {
	taskId: string;
	round: number;
	requestId: string;
	sourceContent?: string;
	inputRel?: string;
	targetSessionId?: string;
	/** Stage against the project pool instead of one named session. */
	targetPolicy?: { kind: "session"; sessionId: string } | { kind: "workspace_pool"; role: string | null };
}): Promise<{ input: ApprovedEnqueue; confirmation: RoundConfirmationV3 }> {
	const inputRel = options.inputRel ?? "input.txt";
	const targetSessionId = options.targetSessionId ?? "wb-session-1";
	const targetPolicy = options.targetPolicy ?? { kind: "session" as const, sessionId: targetSessionId };
	const sourcePath = path.join(root, inputRel);
	await mkdir(path.dirname(sourcePath), { recursive: true });
	const content = options.sourceContent ?? "frozen bytes\n";
	await writeFile(sourcePath, content, "utf-8");

	const { computeFileSha256 } = await import("../src/tasks");
	const sourceSha = await computeFileSha256(sourcePath);
	const projectOwner = owner();
	const payload = buildTaskManifestPayload({
		projectRoot: root,
		requestId: options.requestId,
		taskId: options.taskId,
		round: options.round,
		owner: projectOwner,
		goal: testRequest().goal,
		targetPolicy,
		expectedOutputs: ["result.txt"],
		inputs: [{ path: inputRel, snapshotPath: `inputs/${inputRel}`, bytes: Buffer.byteLength(content), sha256: sourceSha }],
		deliveryMode: "foreground",
	});
	const confirmation: RoundConfirmationV3 = {
		source: "host_dialog",
		at: new Date().toISOString(),
		targetPolicy,
		requestId: options.requestId,
		manifestSha256: hashManifestPayload(payload),
		owner: projectOwner,
		previousRound: 0,
		inputs: [{ path: inputRel, sha256: sourceSha }],
		deliveryMode: "foreground",
	};
	const staged = await stageTask(
		root,
		confirmation,
		testRequest({ inputFiles: [inputRel] }),
		options.taskId,
		options.round,
	);
	return {
		input: {
			taskId: options.taskId,
			round: options.round,
			requestId: options.requestId,
			manifestSha256: staged.manifestSha256,
			manifestPath: staged.manifestPath,
			snapshotRoot: staged.snapshotRoot,
			expectedPreviousRound: null,
			readPaths: [inputRel],
			writePaths: [`.wb-bridge/tasks/${options.taskId}/rounds/${options.round}/outputs`],
			targetPolicy,
			ownerSession: projectOwner.sessionId,
			ownerGeneration: projectOwner.generation,
			executorInstanceId: projectOwner.instanceId,
			approval: { source: "host_dialog", at: confirmation.at, payloadSha256: staged.manifestSha256 },
			title: `Task ${options.taskId.slice(0, 4)}`,
			deliveryMode: "foreground",
		},
		confirmation,
	};
}

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
	it("refuses enqueue with WB_MIGRATION_REQUIRED while the project is not enabled", async () => {
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.migrationRequired);
		} finally {
			queue.close();
		}
	});

	it("refuses enqueue with WB_OWNER_UNAVAILABLE when the owner row is not registered", async () => {
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const db = openWriteConnection(root);
			withImmediate(db, () => writeMeta(db, "project_enabled_at", new Date().toISOString()));
			queue.enqueue(input);
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.ownerUnavailable);
		} finally {
			queue.close();
		}
	});

	it("refuses enqueue from an owner whose generation was retired", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const db = openWriteConnection(root);
			withImmediate(db, () => retireOwner(db, owner()));
			expect(isOwnerActive(openWriteConnection(root), owner())).toBeFalse();
			queue.enqueue(input);
			throw new Error("enqueue should have failed");
		} catch (err: unknown) {
			expect((err as { code?: string }).code).toBe(WB_ERROR_CODE.ownerUnavailable);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - enqueue idempotency", () => {
	it("returns the original row for the same requestId and digest, leaving one round", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const first = queue.enqueue(input);
			const second = queue.enqueue(input);
			expect(second.taskId).toBe(first.taskId);
			expect(second.revision).toBe(first.revision);
			const snapshot = queue.inspect({ taskId: TASK_A });
			expect(snapshot.tasks).toHaveLength(1);
		} finally {
			queue.close();
		}
	});

	it("rejects the same requestId with a different digest via WB_REVISION_CONFLICT", async () => {
		prepareProject();
		const { input, confirmation } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			// A different digest from the same request id: stage a second snapshot
			// with different source content so the payload digest differs.
			const { input: divergent } = await stageRealSnapshot({
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				sourceContent: "different bytes\n",
			});
			// The divergent stage legitimately hashes differently; the digest
			// carried in its confirmation is the one enqueue must reject.
			expect(divergent.manifestSha256).not.toBe(confirmation.manifestSha256);
			expect(() => queue.enqueue(divergent)).toThrow(/WB_REVISION_CONFLICT|different manifest digest/);
			// The losing write must not have touched the original row.
			const snapshot = queue.inspect({ taskId: TASK_A });
			expect(snapshot.tasks).toHaveLength(1);
			expect(snapshot.tasks[0]?.manifest_sha256).toBe(confirmation.manifestSha256);
		} finally {
			queue.close();
		}
	});

	it("requires the previous round to be committed for a supplemental round", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			const { input: supplemental } = await stageRealSnapshot({
				taskId: TASK_A,
				round: 2,
				requestId: REQUEST_B,
			});
			expect(() =>
				queue.enqueue({ ...supplemental, expectedPreviousRound: 1 }),
			).toThrow(/committed/);
		} finally {
			queue.close();
		}
	});

	it("accepts a supplemental round once the previous round is committed", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run(
					"UPDATE rounds SET commit_state = 'committed' WHERE task_id = ? AND round = 1",
					[TASK_A],
				);
			});
			const { input: supplemental } = await stageRealSnapshot({
				taskId: TASK_A,
				round: 2,
				requestId: REQUEST_B,
			});
			const accepted = queue.enqueue({ ...supplemental, expectedPreviousRound: 1 });
			expect(accepted.round).toBe(2);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - waiting work records", () => {
	it("records a waiting scope without a hold: queued work never occupies", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
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

	it("persists the staged manifest's per-file input rows", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			const db = openWriteConnection(root);
			const rows = db.query("SELECT * FROM inputs WHERE task_id = ?").all(TASK_A) as Array<{
				path: string;
				snapshot_path: string;
				sha256: string;
				bytes: number;
			}>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.path).toBe("input.txt");
			expect(rows[0]?.snapshot_path).toBe("inputs/input.txt");
			expect(rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(rows[0]?.bytes).toBe("frozen bytes\n".length);
		} finally {
			queue.close();
		}
	});
});

describe("project queue - claim arbitration", () => {
	it("claims the oldest queued round and moves phase to preparing while status stays queued", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind === "claimed") {
				expect(claim.taskId).toBe(TASK_A);
				expect(claim.sessionId).toBe("wb-session-1");
				expect(claim.attemptId).toMatch(/^[0-9a-f-]{36}$/);
			}
			const row = queue.inspect({ taskId: TASK_A }).tasks[0];
			expect(row?.status).toBe("queued");
			expect(row?.phase).toBe("preparing");
			expect(row?.dispatch_state).toBe("not_sent");
			expect(row?.selected_session).toBe("wb-session-1");
		} finally {
			queue.close();
		}
	});

	it("creates one execution hold and promotes the waiting scope to active on claim", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
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

	it("makes a second round for the same WorkBuddy session wait with session_busy", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// Task A and task B both target wb-session-1 but have disjoint scopes
			// and different OMP owners, so only the session hold can explain a wait.
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			const first = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
			queue.enqueue(first.input);
			const secondStage = await stageRealSnapshot({
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "other-input.txt",
			});
			queue.enqueue({
				...secondStage.input,
				ownerSession: otherOwner.sessionId,
				ownerGeneration: otherOwner.generation,
				executorInstanceId: otherOwner.instanceId,
			});
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			// The second claimant's round must wait on the held WorkBuddy session:
			// both rounds target wb-session-1, so that session is the blocker.
			const second = queue.claim(otherOwner, Date.now());
			expect(second).toMatchObject({ kind: "waiting", reason: "session_busy" });
			if (second.kind === "waiting") {
				expect(second.blockerIds).toContain("wb-session-1");
			}
		} finally {
			queue.close();
		}
	});

	it("waits on conflicting scope and lets nonconflicting work run independently", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			const first = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
			queue.enqueue(first.input);
			// Write-vs-read conflict: TASK_B's staged input lives inside TASK_A's
			// outputs directory (a chained follow-up reading the previous round's
			// deliverable while TASK_A is still running). Real file, real hash.
			const chainedRel = `.wb-bridge/tasks/${TASK_A}/rounds/1/outputs/chain-input.txt`;
			const secondStage = await stageRealSnapshot({
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: chainedRel,
				targetSessionId: "wb-session-2",
			});
			queue.enqueue({
				...secondStage.input,
				ownerSession: otherOwner.sessionId,
				ownerGeneration: otherOwner.generation,
				executorInstanceId: otherOwner.instanceId,
			});
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			const conflicting = queue.claim(otherOwner, Date.now());
			expect(conflicting).toMatchObject({ kind: "waiting", reason: "scope_conflict" });
			if (conflicting.kind === "waiting") {
				// The blocker is the occupying round's work id, which is derived
				// from task+round rather than composed from the task id.
				expect(conflicting.blockerIds[0]).toBe(delegatedWorkId(TASK_A, 1));
			}
			// A third task with a disjoint scope and its own WorkBuddy session
			// does not wait for the first one: independent work runs concurrently.
			// The project is no longer serialized as a whole — only the per-session
			// hold, the scope and the quarantine still gate execution.
			const thirdOwner = owner({ sessionId: "omp-session-3", generation: "gen-3", instanceId: "instance-3" });
			const thirdDb = openWriteConnection(root);
			withImmediate(thirdDb, () => registerOwner(thirdDb, thirdOwner, Date.now()));
			const thirdStage = await stageRealSnapshot({
				taskId: TASK_C,
				round: 1,
				requestId: REQUEST_C,
				targetSessionId: "wb-session-3",
			});
			queue.enqueue({
				...thirdStage.input,
				ownerSession: thirdOwner.sessionId,
				ownerGeneration: thirdOwner.generation,
				executorInstanceId: thirdOwner.instanceId,
			});
			const independent = queue.claim(thirdOwner, Date.now());
			expect(independent).toMatchObject({ kind: "claimed" });
			if (independent.kind === "claimed") {
				expect(independent.sessionId).toBe("wb-session-3");
			}
			// The first task's hold is still in place: it was not released by the
			// second claim.
			expect(queue.holds().map((hold) => hold.sessionId).sort()).toEqual([
				"wb-session-1",
				"wb-session-3",
			]);
			// The holder releases through the exact-attempt path, which is the only one
			// the live code uses: it proves who is giving the round back.
			const heldRow = queue.inspect({ taskId: TASK_A }).tasks[0]!;
			expect(
				queue.rollbackClaim({
					taskId: TASK_A,
					round: 1,
					attemptId: String(heldRow["attempt_id"]),
					reason: "test release",
					now: Date.now(),
				}).kind,
			).toBe("requeued");
		} finally {
			queue.close();
		}
	});


	it("does not advance the domain revision when a claim loses its race", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
			queue.enqueue(input);
			const revisionBefore = queue.inspect({}).revision;
			// A pre-existing hold on the target session forces every candidate
			// into the waiting path: no revision may be burned by the attempt.
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run(
					`INSERT INTO holds(session_id, parent_kind, task_id, round, attempt_id, kind)
					 VALUES('wb-session-1', 'delegated', ?, 1, NULL, 'execution')`,
					[TASK_A],
				);
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim).toMatchObject({ kind: "waiting", reason: "session_busy" });
			const revisionAfter = queue.inspect({}).revision;
			expect(revisionAfter).toBe(revisionBefore);
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

	it("ignores rounds owned by a different OMP session", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
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

	it("serves inspect from an existing database and refuses writes", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const snapshot = queue.inspect({});
			expect(snapshot.tasks).toHaveLength(0);
			const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
			expect(() => queue.enqueue(input)).toThrow(/read-mode queue cannot enqueue/);
		} finally {
			queue.close();
		}
	});

	it("refuses a database that belongs to a different project", async () => {
		prepareProject();
		const otherRoot = await createFixtureRoot("wb-queue-other-");
		try {
			const { copyFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(path.join(otherRoot, ".wb-bridge"), { recursive: true });
			copyFileSync(path.join(root, ".wb-bridge", "state.sqlite"), path.join(otherRoot, ".wb-bridge", "state.sqlite"));
			expect(() => openProjectQueue(otherRoot, { mode: "read" })).toThrow(/belongs to/);
		} finally {
			closeQueueConnection(otherRoot, "read");
			await removeFixtureRoot(otherRoot);
		}
	});
});

describe("project queue - real subprocess contention", () => {
	it("lets exactly one of two concurrent claimants win one attempt", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		queue.enqueue(input);
		queue.close();

		// Two real processes race for the same single round. Each runs the
		// fixture binary with its own claim instruction; the SQLite write lock
		// decides the winner, and the loser must observe either waiting or empty
		// — never a second claimed attempt.
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
		// The single winner must own the one attempt the round can have.
		expect(claimed[0]?.taskId).toBe(TASK_A);
	});

	it("enqueues through a real child process and the parent sees the row", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
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

describe("works.revision is the record version, not the audit counter", () => {
	/** Reads the column and the serialized record version side by side. */
	function worksVersions(workId: string): { column: number; record: number } | null {
		const db = openWriteConnection(root);
		const row = db.query("SELECT revision, record_json FROM works WHERE work_id = ?").get(workId) as
			| { revision: number; record_json: string }
			| null;
		if (row === null) {
			return null;
		}
		const record = JSON.parse(row.record_json) as { revision?: number };
		return { column: row.revision, record: record.revision ?? -1 };
	}

	it("keeps the column and record_json in step across enqueue and claim", async () => {
		prepareProject();
		const { input } = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.enqueue(input);
			const workId = delegatedWorkId(TASK_A, 1);

			const queued = worksVersions(workId);
			expect(queued).not.toBeNull();
			// A fresh record starts at version 1 regardless of how many other
			// records the project has written before it.
			expect(queued!.column).toBe(1);
			expect(queued!.record).toBe(1);

			// A second unrelated round must not inflate this record's version.
			const other = await stageRealSnapshot({
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "other-input.txt",
				targetSessionId: "wb-session-2",
			});
			queue.enqueue(other.input);
			expect(worksVersions(workId)!.column).toBe(1);

			// Claiming promotes the scope: a record change, so both readers advance.
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			const afterClaim = worksVersions(workId);
			expect(afterClaim!.column).toBe(2);
			expect(afterClaim!.record).toBe(2);
			expect(afterClaim!.column).toBe(afterClaim!.record);
		} finally {
			queue.close();
		}
	});
});

// ---------------------------------------------------------------------------
// The project pool: roster, atomic selection, durable affinity and context
// isolation.
// ---------------------------------------------------------------------------

const WB_ONE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const WB_TWO = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const WB_THREE = "cccccccc-3333-4333-8333-cccccccccccc";

/** Enrolls a set of verified, idle pool members. */
function enrollPool(
	queue: ProjectQueue | null,
	members: Array<{
		sessionId: string; availability?: "idle" | "busy" | "offline" | "unknown";
		verified?: boolean; role?: string; ownershipConflict?: boolean;
	}>,
): void {
	queue!.syncProjectSessions(
		members.map((member) => ({
			sessionId: member.sessionId,
			workbuddyVersion: "1.2.3",
			availability: member.availability ?? "idle",
			role: member.role ?? "general",
			verified: member.verified ?? true,
			ownershipConflict: member.ownershipConflict,
		})),
		Date.now(),
	);
}

/** Enqueues a pool-targeted round owned by `ownerIdentity`. */
async function enqueuePoolRound(
	queue: ProjectQueue | null,
	options: {
		taskId: string; round: number; requestId: string; inputRel: string;
		ownerIdentity?: OwnerIdentity; role?: string;
	},
): Promise<void> {
	const staged = await stageRealSnapshot({
		taskId: options.taskId,
		round: options.round,
		requestId: options.requestId,
		inputRel: options.inputRel,
		targetPolicy: { kind: "workspace_pool", role: options.role ?? null },
	});
	queue!.enqueue({
		...staged.input,
		...(options.ownerIdentity
			? {
					ownerSession: options.ownerIdentity.sessionId,
					ownerGeneration: options.ownerIdentity.generation,
					executorInstanceId: options.ownerIdentity.instanceId,
				}
			: {}),
	});
}

describe("project pool - roster registration", () => {
	it("records the authorized roster and makes an idle member claimable", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			const sessions = queue.inspect({ include: { sessions: true } }).sessions;
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.["session_id"]).toBe(WB_ONE);
			expect(sessions[0]?.["enrolled"]).toBe(1);
			expect(sessions[0]?.["identity"]).toBe("verified");
		} finally {
			queue.close();
		}
	});

	it("refuses a roster member that discovery did not verify", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE, verified: false }]);
			const sessions = queue.inspect({ include: { sessions: true } }).sessions;
			// It is enrolled — the roster knows it belongs to this project — but
			// it is not verified, so it may not take work.
			expect(sessions[0]?.["enrolled"]).toBe(1);
			expect(sessions[0]?.["identity"]).toBe("pending");
		} finally {
			queue.close();
		}
	});

	it("keeps an offline member enrolled instead of dropping it", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			// The next refresh does not see it: it is offline, not removed.
			enrollPool(queue, [{ sessionId: WB_TWO }]);
			const sessions = queue.inspect({ include: { sessions: true } }).sessions;
			expect(sessions).toHaveLength(2);
			const offline = sessions.find((row) => row["session_id"] === WB_ONE);
			expect(offline?.["enrolled"]).toBe(1);
			expect(offline?.["availability"]).toBe("offline");
		} finally {
			queue.close();
		}
	});

	it("quarantines a member whose verified metadata contradicts project ownership", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			queue.syncProjectSessions(
				[
					{
						sessionId: WB_ONE,
						workbuddyVersion: "1.2.3",
						availability: "idle",
						verified: true,
						ownershipConflict: true,
					},
				],
				Date.now(),
			);
			const sessions = queue.inspect({ include: { sessions: true } }).sessions;
			expect(sessions[0]?.["ownership_conflict"]).toBe(1);
			expect(sessions[0]?.["enrolled"]).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("refuses a roster update through a read-mode queue", async () => {
		prepareProject();
		const writer = openProjectQueue(root, { mode: "write" })!;
		enrollPool(writer, [{ sessionId: WB_ONE }]);
		writer.close();
		const reader = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(() =>
				reader.syncProjectSessions(
					[{ sessionId: WB_TWO, workbuddyVersion: "1.2.3", availability: "idle" }],
					Date.now(),
				),
			).toThrow(/read-mode queue cannot record project sessions/);
		} finally {
			reader.close();
		}
	});
});

describe("project pool - atomic selection", () => {
	it("claims a pool round onto an enrolled idle session and records the affinity", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }, { sessionId: WB_TWO }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind === "claimed") {
				expect([WB_ONE, WB_TWO]).toContain(claim.sessionId);
			}
			expect(queue.taskSession(TASK_A)).not.toBeNull();
		} finally {
			queue.close();
		}
	});

	it("runs two unrelated pool tasks in two different contexts concurrently", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }, { sessionId: WB_TWO }]);
			const secondOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, secondOwner, Date.now()));
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			await enqueuePoolRound(queue, {
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "pool-b.txt",
				ownerIdentity: secondOwner,
			});
			const first = queue.claim(owner(), Date.now());
			const second = queue.claim(secondOwner, Date.now());
			expect(first.kind).toBe("claimed");
			expect(second.kind).toBe("claimed");
			if (first.kind === "claimed" && second.kind === "claimed") {
				// Two independent tasks must never share one WorkBuddy context.
				expect(first.sessionId).not.toBe(second.sessionId);
			}
		} finally {
			queue.close();
		}
	});

	it("waits with a scope conflict when the requested scope collides", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }, { sessionId: WB_TWO }]);
			const secondOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, secondOwner, Date.now()));
			const chainedRel = `.wb-bridge/tasks/${TASK_A}/rounds/1/outputs/chain-input.txt`;
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			await enqueuePoolRound(queue, {
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: chainedRel,
				ownerIdentity: secondOwner,
			});
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			const conflicting = queue.claim(secondOwner, Date.now());
			expect(conflicting).toMatchObject({ kind: "waiting", reason: "scope_conflict" });
			if (conflicting.kind === "waiting") {
				expect(conflicting.blockerIds[0]).toBe(delegatedWorkId(TASK_A, 1));
			}
		} finally {
			queue.close();
		}
	});

	it("reports no_unused_session when the pool has no other member", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const first = queue.claim(owner(), Date.now());
			expect(first.kind).toBe("claimed");
			// The only member now carries this task, so no context is left for
			// an unrelated one.
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			const db = openWriteConnection(root);
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			await enqueuePoolRound(queue, {
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "pool-b.txt",
				ownerIdentity: otherOwner,
			});
			const second = queue.claim(otherOwner, Date.now());
			expect(second).toMatchObject({ kind: "waiting", reason: "no_unused_session" });
		} finally {
			queue.close();
		}
	});

	it("reports all_sessions_busy when every member is busy", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE, availability: "busy" }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "all_sessions_busy",
			});
		} finally {
			queue.close();
		}
	});

	it("distinguishes busy and offline unused sessions before claiming the newly available member", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [
				{ sessionId: WB_ONE, availability: "busy" },
				{ sessionId: WB_TWO, availability: "offline" },
			]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "sessions_busy_or_unavailable",
				blockerIds: [WB_ONE, WB_TWO],
				sessionBlockers: [
					{ sessionId: WB_ONE, reason: "session_busy" },
					{ sessionId: WB_TWO, reason: "session_unavailable" },
				],
			});
			enrollPool(queue, [
				{ sessionId: WB_ONE, availability: "busy" },
				{ sessionId: WB_TWO, availability: "idle" },
			]);
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "claimed",
				taskId: TASK_A,
				sessionId: WB_TWO,
			});
		} finally {
			queue.close();
		}
	});

	it("reports sessions_unavailable when every member is offline", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE, availability: "offline" }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "sessions_unavailable",
			});
		} finally {
			queue.close();
		}
	});

	it("never selects a session that is not proven live", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// The roster knows the session, but nothing proves a live worker of
			// this project owns it right now.
			enrollPool(queue, [{ sessionId: WB_ONE, verified: false }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const outcome = queue.claim(owner(), Date.now());
			expect(outcome).toMatchObject({ kind: "waiting" });
			if (outcome.kind === "waiting") {
				// The member is enrolled, so the wait names it — but it is not
				// available, and the round stays queued.
				expect(outcome.blockerIds).toContain(WB_ONE);
				expect(outcome.reason).toBe("sessions_unavailable");
			}
		} finally {
			queue.close();
		}
	});

	it("does not describe idle sessions with the wrong role as busy", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE, role: "general" }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A, round: 1, requestId: REQUEST_A, inputRel: "pool-a.txt", role: "document",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting", reason: "sessions_unavailable", sessionBlockers: [],
			});
			enrollPool(queue, [
				{ sessionId: WB_ONE, role: "general" },
				{ sessionId: WB_TWO, role: "document" },
			]);
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "claimed", taskId: TASK_A, sessionId: WB_TWO,
			});
		} finally {
			queue.close();
		}
	});

	it("keeps a project ownership conflict distinct from its busy sibling", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [
				{ sessionId: WB_ONE, ownershipConflict: true },
				{ sessionId: WB_TWO, availability: "busy" },
			]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A, round: 1, requestId: REQUEST_A, inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "ownership_conflict",
				sessionBlockers: [
					{ sessionId: WB_ONE, reason: "ownership_conflict" },
					{ sessionId: WB_TWO, reason: "session_busy" },
				],
			});
		} finally {
			queue.close();
		}
	});

	it("says a project with no enrolled session has none, rather than that it is used up", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// Nothing has enrolled a session for this project at all.
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const outcome = queue.claim(owner(), Date.now());
			expect(outcome).toMatchObject({
				kind: "waiting",
				reason: "no_enrolled_session",
			});
			if (outcome.kind === "waiting") {
				// An absent pool has no session to name, so it names none.
				expect(outcome.blockerIds).toEqual([]);
				expect(outcome.sessionBlockers).toEqual([]);
			}
		} finally {
			queue.close();
		}
	});

	it("reports a session that already carried a task as used, not as offline", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			// The prompt was armed, so the context is definitely not clean.
			queue.armPrompt({
				taskId: TASK_A,
				round: 1,
				attemptId: claim.attemptId,
				sessionId: claim.sessionId,
				promptSha256: "b".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run("DELETE FROM holds WHERE task_id = ? AND round = 1", [TASK_A]);
				db.run("UPDATE works SET state = 'released' WHERE task_id = ? AND round = 1", [TASK_A]);
			});
			// The session now looks idle, but it carries this task's work.
			enrollPool(queue, [{ sessionId: WB_ONE, availability: "idle" }]);
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			await enqueuePoolRound(queue, {
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "pool-b.txt",
				ownerIdentity: otherOwner,
			});
			const outcome = queue.claim(otherOwner, Date.now());
			expect(outcome.kind).toBe("waiting");
			if (outcome.kind !== "waiting") {
				return;
			}
			// The wait is exhaustion, and the session is reported as the used
			// conversation it is — not as an offline one.
			expect(outcome.reason).toBe("no_unused_session");
			expect(outcome.sessionBlockers).toEqual([
				{ sessionId: WB_ONE, reason: "already_used_by_other_task" },
			]);
		} finally {
			queue.close();
		}
	});

	it("reports a quarantined session as one whose state is unknown", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				// A quarantine names the work it is holding: the row is the
				// record that a round may still be running on that session.
				db.run(
					`INSERT INTO works(work_id, revision, state, record_json, task_id, round)
					 VALUES(?, 1, 'blocked', '{"scope":null}', NULL, NULL)`,
					[`quarantine-${WB_ONE}`],
				);
				db.run(
					`INSERT INTO holds(session_id, parent_kind, task_id, round, parent_work_id, attempt_id, kind)
					 VALUES(?, 'delegated', NULL, NULL, ?, NULL, 'quarantine')`,
					[WB_ONE, `quarantine-${WB_ONE}`],
				);
			});
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const outcome = queue.claim(owner(), Date.now());
			expect(outcome.kind).toBe("waiting");
			if (outcome.kind !== "waiting") {
				return;
			}
			// A quarantined session is not busy and not offline: what is unknown
			// is whether the worker still holds the round.
			expect(outcome.reason).toBe("native_state_unknown");
			expect(outcome.sessionBlockers).toEqual([
				{ sessionId: WB_ONE, reason: "native_state_unknown" },
			]);
		} finally {
			queue.close();
		}
	});

	it("refreshes read-only wait diagnostics when an unavailable session becomes busy", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [
				{ sessionId: WB_ONE, availability: "busy" },
				{ sessionId: WB_TWO, availability: "offline" },
			]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "sessions_busy_or_unavailable",
			});
			enrollPool(queue, [
				{ sessionId: WB_ONE, availability: "busy" },
				{ sessionId: WB_TWO, availability: "busy" },
			]);
			const reader = openProjectQueue(root, { mode: "read" })!;
			try {
				expect(reader.waitState(TASK_A, 1)).toEqual({
					reason: "all_sessions_busy",
					blockerIds: [WB_ONE, WB_TWO],
					sessionBlockers: [
						{ sessionId: WB_ONE, reason: "session_busy" },
						{ sessionId: WB_TWO, reason: "session_busy" },
					],
				});
			} finally {
				reader.close();
			}
		} finally {
			queue.close();
		}
	});
});

describe("project pool - durable affinity", () => {
	it("keeps the affinity through an unsent rollback", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }, { sessionId: WB_TWO }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			const sessionId = claim.sessionId;
			// The send failed before anything left: the round returns to the queue.
			expect(
				queue.rollbackClaim({
					taskId: TASK_A,
					round: 1,
					attemptId: claim.attemptId,
					reason: "test rollback",
					now: Date.now(),
				}).kind,
			).toBe("requeued");
			// The affinity survives: the task still belongs to that context.
			expect(queue.taskSession(TASK_A)).toBe(sessionId);
			// And the re-claim lands in the very same context.
			const again = queue.claim(owner(), Date.now());
			expect(again.kind).toBe("claimed");
			if (again.kind === "claimed") {
				expect(again.sessionId).toBe(sessionId);
			}
		} finally {
			queue.close();
		}
	});

	it("keeps the affinity across a restart, so a rework round stays pinned", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		enrollPool(queue, [{ sessionId: WB_ONE }, { sessionId: WB_TWO }]);
		await enqueuePoolRound(queue, {
			taskId: TASK_A,
			round: 1,
			requestId: REQUEST_A,
			inputRel: "pool-a.txt",
		});
		const claim = queue.claim(owner(), Date.now());
		expect(claim.kind).toBe("claimed");
		if (claim.kind !== "claimed") {
			return;
		}
		const sessionId = claim.sessionId;
		queue.close();

		// A fresh process sees the same affinity: the roster and the task's
		// context are durable facts, not in-memory state.
		const restarted = openProjectQueue(root, { mode: "write" })!;
		try {
			expect(restarted.taskSession(TASK_A)).toBe(sessionId);
		} finally {
			restarted.close();
		}
	});

	it("refuses to move a task that already has a context", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
			// A later round that names a different session is a redirect of work
			// that already lives in another conversation: it is refused.
			const redirect = await stageRealSnapshot({
				taskId: TASK_A,
				round: 2,
				requestId: REQUEST_B,
				inputRel: "pool-a2.txt",
				targetPolicy: { kind: "session", sessionId: WB_TWO },
			});
			expect(() => queue.enqueue(redirect.input)).toThrow(/pinned to WorkBuddy session/);
		} finally {
			queue.close();
		}
	});
});

describe("project pool - context isolation", () => {
	it("never reuses a context that already carried a finished task", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			// The prompt was armed: the context is definitely not clean.
			const armed = queue.armPrompt({
				taskId: TASK_A,
				round: 1,
				attemptId: claim.attemptId,
				sessionId: claim.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			expect(armed.kind).toBe("armed");
			// The task ends; its hold and scope are released.
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run("DELETE FROM holds WHERE task_id = ? AND round = 1", [TASK_A]);
				db.run("UPDATE works SET state = 'released' WHERE task_id = ? AND round = 1", [TASK_A]);
			});

			// An unrelated task now finds the pool empty of usable contexts.
			const otherOwner = owner({ sessionId: "omp-session-2", generation: "gen-2", instanceId: "instance-2" });
			withImmediate(db, () => registerOwner(db, otherOwner, Date.now()));
			await enqueuePoolRound(queue, {
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "pool-b.txt",
				ownerIdentity: otherOwner,
			});
			expect(queue.claim(otherOwner, Date.now())).toMatchObject({
				kind: "waiting",
				reason: "no_unused_session",
			});
		} finally {
			queue.close();
		}
	});

	it("frees a provably untouched reservation when the round is cancelled unsent", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			// Cancelled before anything was sent: the context was never touched.
			const cancelled = queue.requestCancel({
				taskId: TASK_A,
				round: 1,
				now: Date.now(),
				reason: "user_cancel",
			});
			expect(cancelled.kind).toBe("cancelled");
			expect(cancelled.dispatchState).toBe("not_sent");
			const db = openWriteConnection(root);
			const usage = db.query("SELECT * FROM session_usage").all();
			expect(usage).toHaveLength(0);
		} finally {
			queue.close();
		}
	});

	it("keeps the usage ledger after a terminal release", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			enrollPool(queue, [{ sessionId: WB_ONE }]);
			await enqueuePoolRound(queue, {
				taskId: TASK_A,
				round: 1,
				requestId: REQUEST_A,
				inputRel: "pool-a.txt",
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			queue.armPrompt({
				taskId: TASK_A,
				round: 1,
				attemptId: claim.attemptId,
				sessionId: claim.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			const db = openWriteConnection(root);
			const usage = db.query("SELECT session_id, task_id, state FROM session_usage").all() as Array<{
				session_id: string;
				task_id: string;
				state: string;
			}>;
			expect(usage).toHaveLength(1);
			expect(usage[0]?.state).toBe("used");
			expect(usage[0]?.task_id).toBe(TASK_A);
		} finally {
			queue.close();
		}
	});
});

describe("closing the queue releases the project's database", () => {
	it("releases the state file immediately instead of holding the lock until collection", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// A read that leaves a cached prepared statement outstanding, which is
			// what a long-lived handle always has.
			queue.inspect({ include: { sessions: true, works: true } });
		} finally {
			queue.close();
		}
		// The caller believes the project is closed. The state file must be free
		// right now: a handle that lingers until the garbage collector runs keeps
		// the file locked, and the project directory cannot be removed.
		const statePath = path.join(root, ".wb-bridge", "state.sqlite");
		await rm(statePath, { force: true });
		const { existsSync } = await import("node:fs");
		expect(existsSync(statePath)).toBeFalse();
	});

	it("releases the file even when a statement is still outstanding", async () => {
		// The mechanism Bun documents: `close(false)` leaves statements created
		// with `prepare` alive, and the connection is released only once they are
		// finalized or collected — which on Windows means the file stays locked
		// until the collector happens to run. `close(true)` finalizes them and
		// releases the handle immediately.
		const heldPath = path.join(root, ".wb-bridge", "held.sqlite");
		await mkdir(path.dirname(heldPath), { recursive: true });
		const db = new Database(heldPath, { create: true });
		db.run("CREATE TABLE held (a INTEGER)");
		const outstanding = db.prepare("SELECT * FROM held");
		outstanding.all();
		db.close(true);
		// The statement was finalized with the connection, so nothing holds the
		// file any more.
		expect(() => outstanding.all()).toThrow(/closed/i);
		await rm(heldPath, { force: true });
		const { existsSync } = await import("node:fs");
		expect(existsSync(heldPath)).toBeFalse();
	});
});
