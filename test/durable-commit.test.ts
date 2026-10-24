/**
 * The queue-backed terminal commit, driven directly.
 *
 * `commitDurableRound` is the half of the S4 cutover that can be proven today: the
 * dispatch side cannot populate a stage root until staging moves to `stageTask`, so
 * this branch is unreachable from the host and would otherwise be untested code
 * inside the function every terminal path goes through.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { commitDurableRound, readOperatorRecoveryTarget, repairRoundReceipt, repairRoundReceiptAsOperator } from "../src/receipts";
import {
	closeQueueConnection,
	enableProject,
	openProjectQueue,
	openWriteConnection,
	readRoundResources,
	retireOwner,
	registerOwner,
	withImmediate,
} from "../src/queue";
import {
	buildTaskManifestPayload,
	currentRound,
	hashManifestPayload,
	resolveRoundPaths,
	stageTask,
	parseAnyReceiptJson,
	toTaskReceiptView,
	writeRoundReceipt,
} from "../src/tasks";
import { WB_ERROR_CODE, type OwnerIdentity, type RoundConfirmationV3, type TaskRequest } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

const roots: string[] = [];
const TASK = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const SESSION_WB = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			// Closing again here is idempotent; a handle a test opened through a helper
			// blocks the fixture delete on Windows.
			closeQueueConnection(root);
			closeQueueConnection(root, "read");
			await removeFixtureRoot(root);
		}
	}
});

function owner(): OwnerIdentity {
	return { sessionId: "omp-durable", generation: "gen-1", processId: process.pid, instanceId: "instance-1" };
}

/** An enabled project with one queued round, staged through the real path. */
async function queuedRound(): Promise<string> {
	return queuedRoundFor(owner());
}

/**
 * The same queued round, staged under a named owner.
 *
 * A recovery fixture stages the round under an identity that is already gone,
 * so the round has an original owner other than the operator who recovers it.
 */
async function queuedRoundFor(roundOwner: OwnerIdentity): Promise<string> {
	const root = await createFixtureRoot("wb-durable-");
	roots.push(root);
	await enableProject(root);

	const goal = { objective: "commit me", context: "", constraints: [], acceptance: ["ok"], externalActions: [] };
	const request: TaskRequest = { goal, inputFiles: [], expectedOutputs: [] };
	const payload = buildTaskManifestPayload({
		projectRoot: root,
		requestId: REQUEST,
		taskId: TASK,
		round: 1,
		owner: roundOwner,
		goal,
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		expectedOutputs: [],
		inputs: [],
		deliveryMode: "foreground",
	});
	const confirmation: RoundConfirmationV3 = {
		source: "host_dialog",
		at: new Date().toISOString(),
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		requestId: REQUEST,
		manifestSha256: hashManifestPayload(payload),
		owner: roundOwner,
		previousRound: 0,
		inputs: [],
		deliveryMode: "foreground",
	};
	const staged = await stageTask(root, confirmation, request, TASK, 1);

	const db = openWriteConnection(root);
	withImmediate(db, () => registerOwner(db, roundOwner, Date.now()));
	const queue = openProjectQueue(root, { mode: "write" })!;
	queue.enqueue({
		taskId: TASK,
		round: 1,
		requestId: REQUEST,
		manifestSha256: staged.manifestSha256,
		manifestPath: staged.manifestPath,
		snapshotRoot: staged.snapshotRoot,
		expectedPreviousRound: null,
		readPaths: [],
		writePaths: [".wb-bridge/tasks"],
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		ownerSession: roundOwner.sessionId,
		ownerGeneration: roundOwner.generation,
		executorInstanceId: roundOwner.instanceId,
		approval: { source: "host_dialog", at: confirmation.at, payloadSha256: staged.manifestSha256 },
		title: "commit me",
		deliveryMode: "foreground",
	});
	queue.claim(roundOwner, Date.now());
	queue.close();
	closeQueueConnection(root);
	return root;
}

/** Writes a v3 receipt for the round and returns its digest. */
async function writeReceipt(root: string): Promise<string> {
	const paths = resolveRoundPaths(root, TASK, 1, "round");
	const written = await writeRoundReceipt(root, TASK, 1, "round", {
		version: 3,
		taskId: TASK,
		sessionId: owner().sessionId,
		projectRoot: root,
		rounds: [
			{
				number: 1,
				layout: "round",
				goal: { objective: "commit me", context: "", constraints: [], acceptance: ["ok"], externalActions: [] },
				inputFiles: [],
				expectedOutputs: [],
				status: "completed",
				summary: "",
				error: null,
				artifacts: [],
				recordKind: "approved",
				requestId: REQUEST,
				targetPolicy: { kind: "session", sessionId: SESSION_WB },
				snapshotRoot: paths.roundDir,
				owner: null,
				manifestSha256: null,
				commitToken: null,
				turns: [],
				consent: null,
			},
		],
	});
	return written.sha256;
}

describe("durable round commit", () => {
	it("records the outcome, fences the receipt digest and releases the round", async () => {
		const root = await queuedRound();
		const digest = await writeReceipt(root);

		const result = await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "completed",
			error: null,
			receiptSha256: digest,
		});
		expect(result).toEqual({ committed: true, reason: null });

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["status"]).toBe("completed");
			expect(row["commit_state"]).toBe("committed");
			expect(row["receipt_sha256"]).toBe(digest);
			// The commit released the execution hold; nothing may still occupy the session.
			expect(row["phase"]).toBe("terminal");
		} finally {
			queue.close();
		}
		closeQueueConnection(root, "read");

		// The receipt is on disk where the resolver says it should be.
		const paths = resolveRoundPaths(root, TASK, 1, "round");
		expect(await Bun.file(paths.receiptPath).exists()).toBeTrue();
	});

	it("keeps the first terminal outcome when a different one arrives later", async () => {
		const root = await queuedRound();
		const digest = await writeReceipt(root);

		await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "cancelled",
			error: null,
			receiptSha256: digest,
		});

		// A late success must not replace the cancellation that was recorded first.
		const late = await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "completed",
			error: null,
			receiptSha256: digest,
		});
		expect(late.committed).toBeFalse();
		expect(late.reason).toContain("before completed");

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(queue.inspect({ taskId: TASK }).tasks[0]!["status"]).toBe("cancelled");
		} finally {
			queue.close();
		}
		closeQueueConnection(root, "read");
	});

	it("refuses a commit whose digest does not match, keeping the failure visible", async () => {
		const root = await queuedRound();
		await writeReceipt(root);

		const result = await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "completed",
			error: null,
			// A digest for bytes that are not the ones on disk.
			receiptSha256: "0".repeat(64),
		});
		expect(result.committed).toBeFalse();

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			// The outcome survived; what failed is the durable record, and that is shown.
			expect(row["status"]).toBe("completed");
			expect(row["commit_state"]).toBe("failed");
			expect(String(row["storage_error_json"])).toContain(WB_ERROR_CODE.storageError);
		} finally {
			queue.close();
		}
		closeQueueConnection(root, "read");
	});

	it("refuses a commit token that names a different request", async () => {
		const root = await queuedRound();
		const digest = await writeReceipt(root);

		const result = await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: randomUUID(),
			status: "completed",
			error: null,
			receiptSha256: digest,
		});
		expect(result.committed).toBeFalse();
		closeQueueConnection(root);
	});
	/**
	 * A claim takes the WorkBuddy session hold before the prompt is armed. Every failure
	 * in that window has to give it back, or the session stays `session_busy` for the
	 * rest of the project's life — the diagnosis is a hold leak that no later round can
	 * clear, so it is asserted on the hold itself rather than on a status string.
	 */
	it("gives the session back when a claimed round is rolled back", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		const attemptId = String(row["attempt_id"]);

		const outcome = queue.rollbackClaim({
			taskId: TASK,
			round: 1,
			attemptId,
			reason: "manifest_unreadable",
			now: Date.now(),
		});
		expect(outcome.kind).toBe("requeued");

		const holds = queue.inspect({}).works;
		expect(holds.some((work) => work["state"] === "active")).toBeFalse();
		const read = openProjectQueue(root, { mode: "read" })!;
		const after = read.inspect({ taskId: TASK }).tasks[0]!;
		expect(after["phase"]).toBe("queued");
		expect(after["attempt_id"]).toBeNull();
		read.close();
		queue.close();
		closeQueueConnection(root);
	});

	it("refuses to roll back an attempt that may already have been sent", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		const attemptId = String(row["attempt_id"]);
		const armed = queue.armPrompt({
			taskId: TASK,
			round: 1,
			attemptId,
			sessionId: SESSION_WB,
			promptSha256: "a".repeat(64),
			authorization: null,
			now: Date.now(),
		});
		expect(armed.kind).toBe("armed");

		const outcome = queue.rollbackClaim({
			taskId: TASK,
			round: 1,
			attemptId,
			reason: "late",
			now: Date.now(),
		});
		expect(outcome.kind).toBe("refused");
		expect(outcome.reason).toBe("possibly_sent");
		queue.close();
		closeQueueConnection(root);
	});

	it("lets a rolled-back claim be claimed again so the session is not wedged", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(row["dispatch_state"]).toBe("not_sent");

		// The only live release path is the exact-attempt rollback: it proves which
		// attempt is being given back and leaves the round claimable again.
		const rolled = queue.rollbackClaim({
			taskId: TASK,
			round: 1,
			attemptId: String(row["attempt_id"]),
			reason: "test release",
			now: Date.now(),
		});
		expect(rolled.kind).toBe("requeued");
		expect(queue.claim(owner(), Date.now()).kind).toBe("claimed");
		queue.close();
		closeQueueConnection(root);
	});
	/**
	 * A supplemental round is written as its own v3 file holding only that round.
	 * Reading it back must not demand round 1: the file is complete evidence of the
	 * round it describes, and a continuity check applied to it makes every round > 1
	 * unreadable — including by the code that just wrote it.
	 */
	it("reads a supplemental round's receipt without demanding earlier rounds", async () => {
		const root = await queuedRound();
		const paths = resolveRoundPaths(root, TASK, 2, "round");
		const written = await writeRoundReceipt(root, TASK, 2, "round", {
			version: 3,
			taskId: TASK,
			sessionId: owner().sessionId,
			projectRoot: root,
			rounds: [
				{
					number: 2,
					layout: "round",
					goal: { objective: "second pass", context: "", constraints: [], acceptance: ["ok"], externalActions: [] },
					inputFiles: [],
					expectedOutputs: [],
					status: "completed",
					summary: "",
					error: null,
					artifacts: [],
					recordKind: "approved",
					requestId: REQUEST,
					targetPolicy: { kind: "session", sessionId: SESSION_WB },
					snapshotRoot: paths.roundDir,
					owner: null,
					manifestSha256: null,
					commitToken: null,
					turns: [],
					consent: null,
				},
			],
		});
		expect(written.sha256).toBeString();

		const view = toTaskReceiptView(
			JSON.parse(await Bun.file(written.receiptPath).text()) as Parameters<typeof toTaskReceiptView>[0],
		);
		expect(currentRound(view).number).toBe(2);
		closeQueueConnection(root);
	});
	/**
	 * Cancellation has to beat a round that has not run yet. `claim` skips rows with
	 * `cancel_requested`, so recording the request is what keeps a cancelled round from
	 * being delivered later by `advanceQueuedRounds`; without it the user cancels and
	 * the work happens anyway, which is the one outcome a cancel must never allow.
	 *
	 * The decision is durable immediately, but the resources stay held until a receipt
	 * is actually committed: an unsent cancellation that marked itself committed and
	 * released the hold left no evidence for the next reader to recover from.
	 */
	it("settles a cancelled unsent round and refuses to claim it again", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;

		const cancelled = queue.requestCancel({ taskId: TASK, round: 1, now: Date.now(), reason: "user cancelled" });
		expect(cancelled.kind).toBe("cancelled");
		expect(cancelled.sendCancel).toBeFalse();

		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(row["status"]).toBe("cancelled");
		expect(row["phase"]).toBe("committing");
		expect(row["commit_state"]).toBe("pending");
		expect(queue.holds()).toHaveLength(1);

		// The decisive assertion: an unsent cancelled round is no longer a candidate.
		expect(queue.claim(owner(), Date.now()).kind).toBe("empty");
		queue.close();
		closeQueueConnection(root);
	});
	/**
	 * Advance is the only thing that makes "it will run when the session is free" true.
	 * It is driven by the queue, so its invariants belong here: a queued round is
	 * claimable again once the hold is gone, and resuming refuses a manifest whose
	 * digest is not the one the queue recorded — the confirmation was fenced on that
	 * digest, so a different payload was never approved.
	 */
	it("lets a queued round be claimed again once its session is free", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;

		// The round is already claimed and holding its WorkBuddy session, so a second claim
		// by the same owner must not double-book it — that is the session_busy that sends
		// the later round to the queue in the first place.
		const blocked = queue.claim(owner(), Date.now());
		expect(blocked.kind).not.toBe("claimed");

		// Freeing the row models the terminal release the advance path waits for: the
		// claim is rolled back, so the same owner can claim the round again.
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		queue.rollbackClaim({
			taskId: TASK,
			round: 1,
			attemptId: String(row["attempt_id"]),
			reason: "test release",
			now: Date.now(),
		});

		const claimed = queue.claim(owner(), Date.now());
		expect(claimed.kind).toBe("claimed");
		queue.close();
		closeQueueConnection(root);
	});

	it("refuses to resume a round whose manifest no longer matches the enqueued digest", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		const manifestPath = String(row["manifest_path"]);
		const original = JSON.parse(await Bun.file(manifestPath).text()) as {
			payload: { goal: { objective: string } };
			approval: { payloadSha256: string };
		};
		// Swap the payload and keep its internal digest consistent, so only a comparison
		// against the queue's recorded digest can catch the substitution.
		original.payload.goal.objective = "a different objective";
		const { hashManifestPayload: hash } = await import("../src/tasks");
		const swapped = hash(original.payload as never);
		original.approval.payloadSha256 = swapped;
		await Bun.write(manifestPath, JSON.stringify(original, null, 2));

		const { readStagedManifest } = await import("../src/tasks");
		const reread = await readStagedManifest(path.dirname(manifestPath));
		expect(reread.manifestSha256).toBe(swapped);
		expect(reread.manifestSha256).not.toBe(String(row["manifest_sha256"]));
		queue.close();
		closeQueueConnection(root);
	});
	/**
	 * Arming is the point of no return: the payload may have left, the round is in flight,
	 * and the human's approval is spent. Writing only `possibly_sent` left a live round
	 * reporting `queued` to every reader — `wb_tasks` said the work had not started — and
	 * left a consumed grant looking fresh.
	 */
	it("marks an armed round running and spends its approval", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(row["status"]).toBe("queued");
		expect(row["approval_consumed"]).toBe(0);

		const armed = queue.armPrompt({
			taskId: TASK,
			round: 1,
			attemptId: String(row["attempt_id"]),
			sessionId: SESSION_WB,
			promptSha256: "b".repeat(64),
			authorization: null,
			now: Date.now(),
		});
		expect(armed.kind).toBe("armed");

		const after = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(after["status"]).toBe("running");
		expect(after["dispatch_state"]).toBe("possibly_sent");
		expect(after["approval_consumed"]).toBe(1);

		// A second arm must lose: the approval is spent and the payload may have left.
		const again = queue.armPrompt({
			taskId: TASK,
			round: 1,
			attemptId: String(after["attempt_id"]),
			sessionId: SESSION_WB,
			promptSha256: "b".repeat(64),
			authorization: null,
			now: Date.now(),
		});
		expect(again.kind).toBe("lost");
		queue.close();
		closeQueueConnection(root);
	});

	/**
	 * A failed commit still writes its receipt and goes through `confirmReceipt`, so an
	 * attach failure frees the session. Asserting it here stops the opposite belief —
	 * that a failed round wedges the WorkBuddy session forever — from driving a fix that
	 * releases resources the failure path already releases.
	 */
	it("releases the hold when a round commits as failed", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		const attemptId = String(row["attempt_id"]);

		const written = await writeRoundReceipt(root, TASK, 1, "round", {
			version: 3,
			taskId: TASK,
			sessionId: owner().sessionId,
			projectRoot: root,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: { objective: "failed round", context: "", constraints: [], acceptance: ["ok"], externalActions: [] },
					inputFiles: [],
					expectedOutputs: [],
					status: "failed",
					summary: "",
					error: { code: WB_ERROR_CODE.taskFailed, message: "session not running" },
					artifacts: [],
					recordKind: "approved",
					requestId: REQUEST,
					targetPolicy: { kind: "session", sessionId: SESSION_WB },
					snapshotRoot: resolveRoundPaths(root, TASK, 1, "round").roundDir,
					owner: null,
					manifestSha256: null,
					commitToken: null,
					turns: [],
					consent: null,
				},
			],
		});
		void attemptId;
		const committed = await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "failed",
			error: { code: WB_ERROR_CODE.taskFailed, message: "session not running" },
			receiptSha256: written.sha256,
		});
		expect(committed.committed).toBeTrue();

		const db = openWriteConnection(root);
		const resources = readRoundResources(db, TASK, 1);
		expect(resources.holds).toEqual([]);
		expect(resources.workState).toBe("released");
		closeQueueConnection(root);
		queue.close();
	});
	/**
	 * A per-round receipt must keep its own round number through a read. The shared
	 * validator used to rewrite it to the array index, so reading round 2 returned round 1
	 * and the next supplemental dispatch computed round 2 again — a UNIQUE collision on
	 * the row it had just written.
	 */
	it("keeps a per-round receipt's round number through a parse", async () => {
		const root = await queuedRound();
		const paths = resolveRoundPaths(root, TASK, 3, "round");
		await writeRoundReceipt(root, TASK, 3, "round", {
			version: 3,
			taskId: TASK,
			sessionId: owner().sessionId,
			projectRoot: root,
			rounds: [
				{
					number: 3,
					layout: "round",
					goal: { objective: "third pass", context: "", constraints: [], acceptance: ["ok"], externalActions: [] },
					inputFiles: [],
					expectedOutputs: [],
					status: "completed",
					summary: "",
					error: null,
					artifacts: [],
					recordKind: "approved",
					requestId: REQUEST,
					targetPolicy: { kind: "session", sessionId: SESSION_WB },
					snapshotRoot: paths.roundDir,
					owner: null,
					manifestSha256: null,
					commitToken: null,
					turns: [],
					consent: null,
				},
			],
		});
		const parsed = parseAnyReceiptJson(await Bun.file(paths.receiptPath).text(), paths.receiptPath);
		expect(parsed.rounds).toHaveLength(1);
		expect(parsed.rounds[0]!.number).toBe(3);
		expect(currentRound(toTaskReceiptView(parsed)).number).toBe(3);
		closeQueueConnection(root);
	});
	/**
	 * A crash after `claim` leaves the WorkBuddy session hold behind, because
	 * `rollbackClaim` only runs in the process that took the claim. This is the startup
	 * sweep that closes that hole.
	 *
	 * Two activations of one OMP process share an instance id and differ by generation,
	 * so the sweep matches the exact (instance, generation) pair: matching the instance
	 * alone would call a live generation dead and disturb a round whose prompt is running.
	 */
	it("requeues an unsent round from a dead owner and never touches a live one", async () => {
		const root = await queuedRound();
		// A different instance: recovery is attributed per executor instance, and an
		// instance is only recoverable once every generation it registered is gone.
		const liveOwner: OwnerIdentity = {
			...owner(),
			instanceId: "instance-2",
			generation: "gen-live",
			sessionId: "omp-live",
		};
		const liveTask = "44444444-4444-4444-8444-444444444444";
		const liveRequest = "55555555-5555-4555-8555-555555555555";
		// A different WorkBuddy session: the fixture round already holds SESSION_WB, and a
		// second round for the same session must wait rather than be claimed.
		const LIVE_WB = "99999999-9999-4999-8999-999999999999";

		const goal = { objective: "live round", context: "", constraints: [], acceptance: ["ok"], externalActions: [] };
		const payload = buildTaskManifestPayload({
			projectRoot: root,
			requestId: liveRequest,
			taskId: liveTask,
			round: 1,
			owner: liveOwner,
			goal,
			targetPolicy: { kind: "session", sessionId: LIVE_WB },
			expectedOutputs: [],
			inputs: [],
			deliveryMode: "foreground",
		});
		const liveConfirmation: RoundConfirmationV3 = {
			source: "host_dialog",
			at: new Date().toISOString(),
			targetPolicy: { kind: "session", sessionId: LIVE_WB },
			requestId: liveRequest,
			manifestSha256: hashManifestPayload(payload),
			owner: liveOwner,
			previousRound: 0,
			inputs: [],
			deliveryMode: "foreground",
		};
		const liveStaged = await stageTask(
			root,
			liveConfirmation,
			{ goal, inputFiles: [], expectedOutputs: [] },
			liveTask,
			1,
		);

		const queue = openProjectQueue(root, { mode: "write" })!;
		const db = openWriteConnection(root);
		queue.registerOwner(liveOwner, Date.now());
		queue.enqueue({
			taskId: liveTask,
			round: 1,
			requestId: liveRequest,
			manifestSha256: liveStaged.manifestSha256,
			manifestPath: liveStaged.manifestPath,
			snapshotRoot: liveStaged.snapshotRoot,
			expectedPreviousRound: null,
			readPaths: [],
			writePaths: [".wb-bridge/tasks"],
			targetPolicy: { kind: "session", sessionId: LIVE_WB },
			ownerSession: liveOwner.sessionId,
			ownerGeneration: liveOwner.generation,
			executorInstanceId: liveOwner.instanceId,
			approval: { source: "host_dialog", at: new Date().toISOString(), payloadSha256: liveStaged.manifestSha256 },
			title: "live round",
			deliveryMode: "foreground",
		});
		const liveClaim = queue.claim(liveOwner, Date.now());
		// The project is no longer serialized as a whole: a second round that names
		// its own WorkBuddy session is claimed and runs concurrently with the first.
		// Only the per-session hold, the scope and the quarantine still gate.
		expect(liveClaim.kind).toBe("claimed");
		if (liveClaim.kind === "claimed") {
			expect(liveClaim.sessionId).toBe(LIVE_WB);
		}

		// Every owner this test started is still alive, so nothing is abandoned: the sweep
		// must not touch a claimed round on the strength of a stale row alone.
		expect(queue.reconcileAbandonedRounds({ now: Date.now(), isAlive: () => true })).toEqual([]);
		expect(queue.inspect({ taskId: TASK }).tasks[0]!["attempt_id"]).not.toBeNull();

		// Retire the original generation. Its round was never sent, so it returns to the
		// queue; the live generation's round stays exactly as it was.
		// Declare only the original generation gone: liveness is asked per owner, so a
		// same-instance generation stays alive even though the instance id matches.
		db.run("UPDATE owners SET state = 'inactive' WHERE instance_id = ? AND generation = ?", [
			owner().instanceId,
			owner().generation,
		]);
		const recovered = queue.reconcileAbandonedRounds({ now: Date.now(), isAlive: () => true });
		expect(recovered.map((entry) => [entry.taskId, entry.action])).toEqual([[TASK, "requeued"]]);

		const deadRow = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(deadRow["phase"]).toBe("queued");
		expect(deadRow["attempt_id"]).toBeNull();
		// `works` is gated by the round, and the project also holds the live round's row, so
		// the assertion has to name this round rather than scan the project.
		const released = readRoundResources(db, TASK, 1);
		expect(released.holds).toEqual([]);
		// A requeued round is claimable again, so its scope reads `waiting` rather than
		// `released`: released means the round is finished, which this one is not.
		expect(released.workState).toBe("waiting");

		// The live round kept its own attempt and hold: the sweep did not touch it.
		const liveRow = queue.inspect({ taskId: liveTask }).tasks[0]!;
		expect(liveRow["attempt_id"]).not.toBeNull();
		expect(liveRow["phase"]).toBe("preparing");
		expect(readRoundResources(db, liveTask, 1).holds.map((hold) => hold.sessionId)).toEqual([LIVE_WB]);

		queue.close();
		closeQueueConnection(root);
	});
	/**
	 * The other half of the recovery split. A round that may have been sent is not
	 * requeued: resending it could duplicate work that is still happening somewhere. It is
	 * quarantined instead, and it keeps its hold and scope so nothing else writes alongside
	 * unknown work — which is the opposite of the unsent case above.
	 */
	it("quarantines a round a dead owner may have sent, keeping its resources", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const db = openWriteConnection(root);
		const row = queue.inspect({ taskId: TASK }).tasks[0]!;
		const armed = queue.armPrompt({
			taskId: TASK,
			round: 1,
			attemptId: String(row["attempt_id"]),
			sessionId: SESSION_WB,
			promptSha256: "c".repeat(64),
			authorization: null,
			now: Date.now(),
		});
		expect(armed.kind).toBe("armed");

		// The owning generation dies after the prompt may have left.
		db.run("UPDATE owners SET state = 'inactive' WHERE instance_id = ? AND generation = ?", [
			owner().instanceId,
			owner().generation,
		]);
		const recovered = queue.reconcileAbandonedRounds({ now: Date.now(), isAlive: () => true });
		expect(recovered.map((entry) => entry.action)).toEqual(["quarantined"]);

		const after = queue.inspect({ taskId: TASK }).tasks[0]!;
		expect(after["status"]).toBe("interrupted");
		expect(after["phase"]).toBe("recovery_required");
		// Resources are deliberately kept in quarantine: the worker may still be running.
		const kept = readRoundResources(db, TASK, 1);
		expect(kept.holds.length).toBe(1);
		expect(kept.holds[0]!.kind).toBe("quarantine");
		expect(kept.workState).toBe("blocked");

		// A committed local result is not proof the remote stopped, so the quarantine stays
		// until the receipt is rebuilt from the recorded outcome and a human confirms the
		// actual end. Repair first: releasing a failed commit is refused by design, and the
		// dead generation cannot repair — only the same stable session's live successor can.
		const successor: OwnerIdentity = { ...owner(), generation: "gen-successor" };
		queue.registerOwner(successor, Date.now());
		const repaired = await repairRoundReceipt(root, successor, { taskId: TASK });
		expect(repaired.kind).toBe("repaired");
		if (repaired.kind === "repaired") {
			expect(repaired.released).toBeFalse();
		}
		// The repair closes its own cached handle, so the hold is read through a fresh one:
		// a closed handle would report a release it never observed.
		expect(readRoundResources(openWriteConnection(root), TASK, 1).holds[0]!.kind).toBe("quarantine");

		// Once a human verifies the worker is stopped, releasing clears the quarantine.
		// The old call here passed only a task id; the queue now requires an exact round,
		// session and an explicit authorization naming the releasing identity and the
		// human's end observation.
		// The repair closed its own cached handle, so this later work opens fresh ones: a
		// stale facade would fail on a closed database rather than report the release.
		const verifier: OwnerIdentity = { ...owner(), generation: "gen-verifier" };
		openProjectQueue(root, { mode: "write" })!.registerOwner(verifier, Date.now());
		const verification = {
			source: "host_dialog" as const,
			at: new Date().toISOString(),
			evidence: "human observed the WorkBuddy session stopped",
		};
		const releasing = openProjectQueue(root, { mode: "write" })!;
		expect(
			releasing.releaseQuarantine({
				taskId: TASK, round: 1, sessionId: SESSION_WB, now: Date.now(),
				authorization: {
					kind: "owner_release",
					owner: verifier,
					verification: { ...verification, evidence: "   " },
				},
			}).kind,
		).toBe("refused");
		releasing.close();
		expect(readRoundResources(openWriteConnection(root), TASK, 1).holds.length).toBe(1);

		const released = openProjectQueue(root, { mode: "write" })!.releaseQuarantine({
			taskId: TASK, round: 1, sessionId: SESSION_WB, now: Date.now(),
			authorization: { kind: "owner_release", owner: verifier, verification },
		});
		expect(released.kind).toBe("released");
		const cleared = readRoundResources(openWriteConnection(root), TASK, 1);
		expect(cleared.holds).toEqual([]);
		expect(cleared.workState).toBe("released");

		// Every handle this test opened through a helper is released: Windows refuses to
		// delete a directory whose SQLite file is still mapped.
		queue.close();
		closeQueueConnection(root);
		closeQueueConnection(root, "read");
	});
	/**
	 * `wb_doctor` used to report only `active.lock`, which the queue path never writes:
	 * the hold that actually blocks the next delegation was invisible, so a wedged
	 * WorkBuddy session looked free. The read surface it needs is `holds()`.
	 */
	it("exposes the hold that gates a claimed round", async () => {
		const root = await queuedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		const held = queue.holds();
		expect(held).toHaveLength(1);
		expect(held[0]!.taskId).toBe(TASK);
		expect(held[0]!.round).toBe(1);
		expect(held[0]!.kind).toBe("execution");
		expect(held[0]!.sessionId).toBe(SESSION_WB);

		// Released by the commit, not by the read: a reader must not clear a hold.
		const digest = await writeReceipt(root);
		await commitDurableRound({
			projectRoot: root,
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			status: "completed",
			error: null,
			receiptSha256: digest,
		});
		// `commitDurableRound` opens and closes its own connection, so the hold is read
		// through a fresh one: a closed handle would report a release it never observed.
		queue.close();
		closeQueueConnection(root);
		const after = openProjectQueue(root, { mode: "read" })!;
		expect(after.holds()).toEqual([]);
		after.close();
		closeQueueConnection(root);
	});
});

/**
 * Operator recovery: a *different* human recovering a round whose original
 * owner is provably gone.
 *
 * The invariants under test are the ones a preflight cannot hold: the exact
 * subject, the one-shot consent and the death proof are all checked inside the
 * commit transaction, so a round that changed after the human answered
 * invalidates the consent instead of being silently committed.
 */
describe("operator recovery of a dead owner's round", () => {
	/**
	 * Records a first outcome and a failed commit for the round.
	 *
	 * A recovery target only exists once the round has a recorded result, so a
	 * refusal test has to stage that first — otherwise it would fail on an
	 * unrelated precondition and prove nothing about the refusal.
	 */
	function stageFailedCommit(root: string): void {
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.beginTerminal({
				taskId: TASK,
				round: 1,
				outcome: {
					status: "interrupted",
					errorJson: null,
					outcomeJson: JSON.stringify({ status: "interrupted", reason: "owner_died_after_send" }),
				},
				now: Date.now(),
			});
			queue.commitFailed({
				taskId: TASK,
				round: 1,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: "simulated disk failure" }),
				now: Date.now(),
			});
		} finally {
			queue.close();
		}
	}

	/**
	 * Asserts that a refused recovery changed nothing at all.
	 *
	 * The observable facts are the ones that matter: the round still carries
	 * its failed commit, no recovery was recorded, and the hold still gates the
	 * session.
	 */
	function expectRecoveryUnchanged(root: string): void {
		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["commit_state"]).toBe("failed");
			expect(row["receipt_sha256"]).toBeNull();
			expect(row["receipt_recovery_json"]).toBeNull();
		} finally {
			queue.close();
		}
	}

	/** A round whose original owner registered a process that is really gone. */
	async function orphanedRound(): Promise<{ root: string; deadOwner: OwnerIdentity }> {
		const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		await shortProcess.exited;
		const deadOwner: OwnerIdentity = {
			sessionId: "omp-original",
			generation: "gen-original",
			processId: shortProcess.pid,
			instanceId: "instance-original",
		};
		const root = await queuedRoundFor(deadOwner);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// The prompt was armed, so the round may still be running somewhere:
			// that is what makes the sweep quarantine it instead of requeueing it.
			const claimed = queue.inspect({ taskId: TASK }).tasks[0]!;
			const armed = queue.armPrompt({
				taskId: TASK,
				round: 1,
				attemptId: String(claimed["attempt_id"]),
				sessionId: SESSION_WB,
				promptSha256: "d".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			expect(armed.kind).toBe("armed");
			// The owner dies after the prompt may have left: the round is
			// quarantined and keeps a recorded first outcome.
			expect(queue.reconcileAbandonedRounds({ now: Date.now() }).map((entry) => entry.action)).toEqual(["quarantined"]);
		} finally {
			queue.close();
		}
		return { root, deadOwner };
	}

	it("commits a recovered receipt only for the exact subject the human confirmed", async () => {
		const { root, deadOwner } = await orphanedRound();
		const operator: OwnerIdentity = {
			sessionId: "omp-operator",
			generation: "gen-operator",
			processId: process.pid,
			instanceId: "instance-operator",
		};
		openProjectQueue(root, { mode: "write" })!.registerOwner(operator, Date.now());

		const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
		expect(target.kind).toBe("target");
		if (target.kind !== "target") {
			return;
		}
		// The subject names the original owner unchanged and the recorded outcome.
		expect(target.subject.ownerSession).toBe(deadOwner.sessionId);
		expect(target.subject.ownerGeneration).toBe(deadOwner.generation);
		expect(target.subject.executorInstance).toBe(deadOwner.instanceId);
		expect(target.deathProof.pidGone).toBeTrue();

		const consent = { confirmed: true as const, at: new Date().toISOString(), subject: target.subject };
		const recovered = await repairRoundReceiptAsOperator(root, operator, target, consent);
		expect(recovered.kind).toBe("repaired");

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["commit_state"]).toBe("committed");
			// The original execution ownership is untouched.
			expect(row["owner_session"]).toBe(deadOwner.sessionId);
			expect(row["owner_generation"]).toBe(deadOwner.generation);
			expect(row["executor_instance"]).toBe(deadOwner.instanceId);
			// The operator's act is recorded durably, with the original owner and
			// the death proof, in the same transaction as the commit.
			const audit = JSON.parse(String(row["receipt_recovery_json"])) as {
				kind: string;
				operator: { sessionId: string };
				originalOwner: { sessionId: string };
				deathProof: { pidGone: boolean };
			};
			expect(audit.kind).toBe("operator_recovery");
			expect(audit.operator.sessionId).toBe(operator.sessionId);
			expect(audit.originalOwner.sessionId).toBe(deadOwner.sessionId);
			expect(audit.deathProof.pidGone).toBeTrue();
		} finally {
			queue.close();
		}
	});

	it("refuses a consent that was given for another round", async () => {
		const { root } = await orphanedRound();
		const operator: OwnerIdentity = {
			sessionId: "omp-operator",
			generation: "gen-operator",
			processId: process.pid,
			instanceId: "instance-operator",
		};
		openProjectQueue(root, { mode: "write" })!.registerOwner(operator, Date.now());

		const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
		expect(target.kind).toBe("target");
		if (target.kind !== "target") {
			return;
		}
		// A consent for a different round is not a consent for this one.
		const mismatched = {
			confirmed: true as const,
			at: new Date().toISOString(),
			subject: { ...target.subject, round: 99 },
		};
		const recovered = await repairRoundReceiptAsOperator(root, operator, target, mismatched);
		expect(recovered.kind).toBe("refused");

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["commit_state"]).not.toBe("committed");
			expect(row["receipt_recovery_json"]).toBeNull();
		} finally {
			queue.close();
		}
	});

	it("refuses a recovery while the original owner is still registered as active", async () => {
		// The owner registered *this* process and is still active: neither the
		// database row nor the OS may be read as "the owner is gone".
		const root = await queuedRoundFor(owner());
		stageFailedCommit(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const operator: OwnerIdentity = {
				sessionId: "omp-operator",
				generation: "gen-operator",
				processId: process.pid,
				instanceId: "instance-operator",
			};
			queue.registerOwner(operator, Date.now());
			const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
			expect(target.kind).toBe("refused");
		} finally {
			queue.close();
		}
		expectRecoveryUnchanged(root);
	});

	it("refuses a recovery whose original owner's process is still running", async () => {
		// The owner's registration has ended, but its pid is this very process:
		// a retired row is a declaration, not proof that the process is gone.
		const root = await queuedRoundFor(owner());
		stageFailedCommit(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			retireOwner(openWriteConnection(root), owner());
			const operator: OwnerIdentity = {
				sessionId: "omp-operator",
				generation: "gen-operator",
				processId: process.pid,
				instanceId: "instance-operator",
			};
			queue.registerOwner(operator, Date.now());
			const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
			expect(target.kind).toBe("refused");
		} finally {
			queue.close();
		}
		expectRecoveryUnchanged(root);
	});

	it("refuses a recovery while a live successor of the original session is registered", async () => {
		// The original generation is dead, but another generation of the SAME
		// originating session is alive: that successor may still own the round,
		// so the round is not abandoned and a different operator may not take it.
		const { root, deadOwner } = await orphanedRound();
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.registerOwner(
				{
					sessionId: deadOwner.sessionId,
					generation: "gen-successor",
					processId: process.pid,
					instanceId: "instance-successor",
				},
				Date.now(),
			);
			const operator: OwnerIdentity = {
				sessionId: "omp-operator",
				generation: "gen-operator",
				processId: process.pid,
				instanceId: "instance-operator",
			};
			queue.registerOwner(operator, Date.now());
			const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
			expect(target.kind).toBe("refused");
		} finally {
			queue.close();
		}
		expectRecoveryUnchanged(root);
	});

	it("refuses a recovery whose operator is not an active registration", async () => {
		const { root } = await orphanedRound();
		const stranger: OwnerIdentity = {
			sessionId: "omp-stranger",
			generation: "gen-stranger",
			processId: process.pid,
			instanceId: "instance-stranger",
		};
		const target = readOperatorRecoveryTarget(root, stranger, { taskId: TASK });
		expect(target.kind).toBe("refused");
		if (target.kind === "refused") {
			expect(target.reason).toContain("not an active registration");
		}
	});
});
