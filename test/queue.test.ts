import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
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
import {
	buildTaskManifestPayload,
	hashManifestPayload,
	stageTask,
} from "../src/tasks";
import { WB_ERROR_CODE, type RoundConfirmationV3, type TaskRequest } from "../src/types";

let root = "";
/** Set only once a fixture root exists; guards the cleanup below. */
let rootReady = false;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-queue-")));
	rootReady = true;
});

afterEach(async () => {
	// Guard against a setup failure leaving root unset: rm("") would resolve
	// against the process cwd, which for bun test is this repository.
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
}): Promise<{ input: ApprovedEnqueue; confirmation: RoundConfirmationV3 }> {
	const inputRel = options.inputRel ?? "input.txt";
	const targetSessionId = options.targetSessionId ?? "wb-session-1";
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
		targetPolicy: { kind: "session", sessionId: targetSessionId },
		expectedOutputs: ["result.txt"],
		inputs: [{ path: inputRel, snapshotPath: `inputs/${inputRel}`, bytes: Buffer.byteLength(content), sha256: sourceSha }],
		deliveryMode: "foreground",
	});
	const confirmation: RoundConfirmationV3 = {
		source: "host_dialog",
		at: new Date().toISOString(),
		targetPolicy: { kind: "session", sessionId: targetSessionId },
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
			targetPolicy: { kind: "session", sessionId: targetSessionId },
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

	it("makes an overlapping write wait with scope_conflict while read/read shares", async () => {
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
				expect(conflicting.blockerIds[0]).toContain(TASK_A);
			}
			// read/read sharing: a third round on a third WorkBuddy session reading
			// the same input as the running task (write path distinct) claims fine.
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
			const sharing = queue.claim(thirdOwner, Date.now());
			expect(sharing.kind).toBe("claimed");
		} finally {
			queue.close();
		}
	});

	it("keeps claiming younger unrelated rounds while the oldest waits on a busy session", async () => {
		prepareProject();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// Round A targets wb-session-1; round B (same OMP owner) targets
			// wb-session-2 with a disjoint input. wb-session-1 is occupied by a
			// pre-existing hold, so the oldest candidate is blocked — B must still
			// claim instead of starving behind A.
			const secondStage = await stageRealSnapshot({
				taskId: TASK_B,
				round: 1,
				requestId: REQUEST_B,
				inputRel: "other-input.txt",
				targetSessionId: "wb-session-2",
			});
			queue.enqueue(secondStage.input);
			const first = await stageRealSnapshot({ taskId: TASK_A, round: 1, requestId: REQUEST_A });
			queue.enqueue(first.input);
			// Occupy wb-session-1 directly (as an already-running round would).
			const db = openWriteConnection(root);
			withImmediate(db, () => {
				db.run(
					`INSERT INTO holds(session_id, parent_kind, task_id, round, attempt_id, kind)
					 VALUES('wb-session-1', 'delegated', ?, 1, NULL, 'execution')`,
					[TASK_B],
				);
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind === "claimed") {
				expect(claim.sessionId).toBe("wb-session-2");
			}
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
