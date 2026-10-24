/**
 * Execution lifecycle: one prompt, one outcome, one commit.
 *
 * These are the invariants that make a delegation safe to lose a process over.
 * Each test injects the situation that used to produce a duplicate or a lost
 * result — two claimants, a late end_turn after a cancellation, a receipt that
 * cannot be written — and asserts the observable consequence rather than an
 * internal flag.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
	armPrompt,
	beginTerminal,
	closeQueueConnection,
	commitFailed,
	confirmReceipt,
	enableProject,
	openProjectQueue,
	openWriteConnection,
	readRound,
	recordExecutionEnd,
	registerOwner,
	requestCancel,
	withImmediate,
	type ClaimOutcome,
} from "../src/queue";
import { buildTaskManifestPayload, hashManifestPayload, stageTask } from "../src/tasks";
import {
	WB_ERROR_CODE,
	type OwnerIdentity,
	type RoundConfirmationV3,
	type TaskRequest,
} from "../src/types";
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

const TASK_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_A = "22222222-2222-4222-8222-222222222222";
const SESSION_WB = "33333333-3333-4333-8333-333333333333";

function owner(): OwnerIdentity {
	return { sessionId: "omp-session-1", generation: "gen-1", processId: process.pid, instanceId: "instance-1" };
}

/** Creates and enables a project with one queued round; returns its root. */
async function preparedProject(taskId = TASK_A, requestId = REQUEST_A): Promise<string> {
	const root = await createFixtureRoot("wb-lifecycle-");
	roots.push(root);
	await enableProject(root);

	const goal = {
		objective: "write the report",
		context: "",
		constraints: [],
		acceptance: ["report exists"],
		externalActions: [],
	};
	const payload = buildTaskManifestPayload({
		projectRoot: root,
		requestId,
		taskId,
		round: 1,
		owner: owner(),
		goal,
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		expectedOutputs: [],
		inputs: [],
		deliveryMode: "foreground",
	});
	// The confirmation carries the digest a human would have seen, which is what
	// staging verifies the staged copies against.
	const confirmation: RoundConfirmationV3 = {
		source: "host_dialog",
		at: new Date().toISOString(),
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		requestId,
		manifestSha256: hashManifestPayload(payload),
		owner: owner(),
		previousRound: 0,
		inputs: [],
		deliveryMode: "foreground",
	};
	const staged = await stageTask(
		root,
		confirmation,
		{ goal, inputFiles: [], expectedOutputs: [], rawRequest: {}, createdAt: new Date().toISOString() } as TaskRequest,
		taskId,
		1,
	);

	const db = openWriteConnection(root);
	withImmediate(db, () => {
		registerOwner(db, owner(), Date.now());
	});
	const queue = openProjectQueue(root, { mode: "write" })!;
	queue.enqueue({
		taskId,
		round: 1,
		requestId,
		manifestSha256: staged.manifestSha256,
		manifestPath: staged.manifestPath,
		snapshotRoot: staged.snapshotRoot,
		expectedPreviousRound: null,
		readPaths: [],
		writePaths: [".wb-bridge/tasks"],
		targetPolicy: { kind: "session", sessionId: SESSION_WB },
		ownerSession: owner().sessionId,
		ownerGeneration: owner().generation,
		executorInstanceId: owner().instanceId,
		approval: { source: "host_dialog", at: new Date().toISOString(), payloadSha256: staged.manifestSha256 },
		title: "write the report",
		deliveryMode: "foreground",
	});
	queue.close();
	closeQueueConnection(root);
	return root;
}

/** Claims the queued round and returns the winning attempt. */
function claimOne(root: string): Extract<ClaimOutcome, { kind: "claimed" }> {
	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		const outcome = queue.claim(owner(), Date.now());
		if (outcome.kind !== "claimed") {
			throw new Error(`expected a claim, got ${outcome.kind}`);
		}
		return outcome;
	} finally {
		queue.close();
	}
}

describe("arming exactly one prompt", () => {
	it("arms the claimed attempt once and refuses the second caller", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			const first = armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			expect(first.kind).toBe("armed");

			// A retry, a reconnect or a second process must send nothing.
			const second = armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			// Distinct from a benign race: the round may already have been delivered,
			// so recovery applies rather than a retry.
			expect(second).toEqual({ kind: "lost", reason: "already_sent" });

			// A different attempt id cannot take over a round armed by another.
			const foreign = armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: randomUUID(),
				sessionId: claimed.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			expect(foreign).toEqual({ kind: "lost", reason: "already_armed" });
		} finally {
			closeQueueConnection(root);
		}
	});

	it("refuses to arm a round the user cancelled before sending", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			requestCancel(db, { taskId: claimed.taskId, round: claimed.round, now: Date.now(), reason: "user_cancel" });
			const armed = armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "b".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			// Zero prompts is the only safe answer: the user already said stop.
			expect(armed).toEqual({ kind: "lost", reason: "cancelled" });
			const row = readRound(db, claimed.taskId, claimed.round)!;
			expect(row.dispatch_state).toBe("not_sent");
		} finally {
			closeQueueConnection(root);
		}
	});

});

describe("the queue facade is the public lifecycle entry", () => {
	it("performs arm, terminal, commit and cancel through ProjectQueue", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			// A host adapter talks to the facade, never to the database: the ordering is
			// only safe if every caller takes the same path.
			const armed = queue.armPrompt({
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "7".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			expect(armed.kind).toBe("armed");
			queue.recordExecutionEnd({
				taskId: claimed.taskId, round: claimed.round, attemptId: claimed.attemptId,
				sessionId: claimed.sessionId, now: Date.now(),
			});

			const terminal = queue.beginTerminal({
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: JSON.stringify({ stopReason: "end_turn" }) },
				now: Date.now(),
			});
			expect(terminal).toEqual({ kind: "applied", status: "completed" });

			const committed = queue.confirmReceipt({
				taskId: claimed.taskId,
				round: claimed.round,
				receiptSha256: "8".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: Number(queue.inspect({ taskId: TASK_A }).tasks[0]?.revision) },
				now: Date.now(),
			});
			expect(committed.kind).toBe("committed");
		} finally {
			queue.close();
		}
	});

	it("refuses every lifecycle command on a read-mode queue", async () => {
		const root = await preparedProject();
		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			// A reader must not transition anything; each of these is a programming
			// error rather than a silent no-op.
			for (const call of [
				() => queue.armPrompt({} as never),
				() => queue.beginTerminal({} as never),
				() => queue.confirmReceipt({} as never),
				() => queue.commitFailed({} as never),
				() => queue.requestCancel({} as never),
				// Every mutator added after the original five belongs here too: a facade that
				// enforces read-only for some commands is not read-only.
				() => queue.rollbackClaim({} as never),
				() => queue.reconcileAbandonedRounds({} as never),
			]) {
				expect(call).toThrow(/read-mode queue/);
			}
			// Reading is not a transition: a reader may inspect the holds that gate work.
			expect(queue.holds()).toEqual([]);
		} finally {
			queue.close();
		}
	});

	it("records a commit failure through the facade without releasing resources", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.armPrompt({
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "9".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			queue.beginTerminal({
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: "{}" },
				now: Date.now(),
			});
			queue.commitFailed({
				taskId: claimed.taskId,
				round: claimed.round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: "disk full" }),
				now: Date.now(),
			});
			const row = queue.inspect({ taskId: claimed.taskId }).tasks[0]!;
			expect(row.commit_state).toBe("failed");
			expect(row.phase).toBe("recovery_required");
		} finally {
			queue.close();
		}
	});
});

describe("first terminal outcome wins", () => {
	it("keeps a cancellation when the worker's success arrives afterwards", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "e".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			const cancelled = requestCancel(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				now: Date.now(),
				reason: "user_cancel",
			});
			// A prompt may have gone out, so the worker has to be told.
			expect(cancelled.sendCancel).toBeTrue();

			const late = beginTerminal(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: JSON.stringify({ stopReason: "end_turn" }) },
				now: Date.now(),
			});
			expect(late).toEqual({ kind: "unchanged", status: "cancelled" });
			expect(readRound(db, claimed.taskId, claimed.round)?.status).toBe("cancelled");
		} finally {
			closeQueueConnection(root);
		}
	});

	it("keeps an unsent cancellation's resources until its receipt is committed", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			// Cancelled before arm: nothing was sent, so no session/cancel is issued.
			const cancelled = requestCancel(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				now: Date.now(),
				reason: "user_cancel",
			});
			expect(cancelled.dispatchState).toBe("not_sent");
			expect(cancelled.sendCancel).toBeFalse();
			const row = readRound(db, claimed.taskId, claimed.round)!;
			expect(row.status).toBe("cancelled");
			expect(row.commit_state).toBe("pending");
			expect(db.query("SELECT session_id FROM holds").all()).toHaveLength(1);
			const confirmed = confirmReceipt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				receiptSha256: "0".repeat(64),
				commitToken: { requestId: claimed.requestId, resultRevision: Number(row.revision) },
				now: Date.now(),
			});
			expect(confirmed.kind).toBe("committed");
			expect(db.query("SELECT session_id FROM holds").all()).toEqual([]);
		} finally {
			closeQueueConnection(root);
		}
	});
});

describe("receipt commit gates resource release", () => {
	it("releases the hold and scope only after a confirmed receipt", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "f".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			recordExecutionEnd(db, {
				taskId: claimed.taskId, round: claimed.round, attemptId: claimed.attemptId,
				sessionId: claimed.sessionId, now: Date.now(),
			});
			beginTerminal(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: JSON.stringify({ stopReason: "end_turn" }) },
				now: Date.now(),
			});

			// Before confirmation the hold is still there: the receipt may not exist.
			const heldBefore = db.query("SELECT session_id FROM holds WHERE task_id = ? AND round = ?").all(claimed.taskId, claimed.round);
			expect(heldBefore.length).toBe(1);

			const committed = confirmReceipt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				receiptSha256: "1".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: Number(readRound(db, TASK_A, 1)?.revision) },
				now: Date.now(),
			});
			expect(committed.kind).toBe("committed");

			const heldAfter = db.query("SELECT session_id FROM holds WHERE task_id = ? AND round = ?").all(claimed.taskId, claimed.round);
			expect(heldAfter).toEqual([]);
			const work = db.query("SELECT state FROM works WHERE task_id = ? AND round = ?").get(claimed.taskId, claimed.round) as
				| { state: string }
				| null;
			expect(work?.state).toBe("released");
			expect(readRound(db, claimed.taskId, claimed.round)?.commit_state).toBe("committed");
		} finally {
			closeQueueConnection(root);
		}
	});

	it("keeps resources and the failure visible when the receipt could not be written", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			armPrompt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "0".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			beginTerminal(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: JSON.stringify({ stopReason: "end_turn" }) },
				now: Date.now(),
			});
			commitFailed(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: "disk full" }),
				now: Date.now(),
			});

			const row = readRound(db, claimed.taskId, claimed.round)!;
			expect(row.commit_state).toBe("failed");
			// Not shown as running: the outcome is known, the write is not.
			expect(row.phase).toBe("recovery_required");
			expect(row.storage_error_json).toContain("disk full");
			// The outcome is preserved, not replaced by the failure.
			expect(row.status).toBe("completed");

			// Resources stay: an unproven write is not proof the directory is free.
			const holds = db.query("SELECT session_id FROM holds WHERE task_id = ? AND round = ?").all(claimed.taskId, claimed.round);
			expect(holds.length).toBe(1);
			const work = db.query("SELECT state FROM works WHERE task_id = ? AND round = ?").get(claimed.taskId, claimed.round) as
				| { state: string }
				| null;
			expect(work?.state).not.toBe("released");
		} finally {
			closeQueueConnection(root);
		}
	});

	it("refuses a commit token that names a different request", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			beginTerminal(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				outcome: { status: "completed", errorJson: null, outcomeJson: "{}" },
				now: Date.now(),
			});
			const mismatched = confirmReceipt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				receiptSha256: "2".repeat(64),
				commitToken: { requestId: randomUUID(), resultRevision: 1 },
				now: Date.now(),
			});
			expect(mismatched.kind).toBe("mismatch");
			expect(readRound(db, claimed.taskId, claimed.round)?.commit_state).not.toBe("committed");
		} finally {
			closeQueueConnection(root);
		}
	});

	it("refuses to confirm a receipt for a round with no outcome yet", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const db = openWriteConnection(root);
		try {
			const early = confirmReceipt(db, {
				taskId: claimed.taskId,
				round: claimed.round,
				receiptSha256: "3".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: 1 },
				now: Date.now(),
			});
			expect(early.kind).toBe("mismatch");
		} finally {
			closeQueueConnection(root);
		}
	});
});

describe("manual recovery cannot unlock a live execution", () => {
	it("keeps an active hold when recovery is requested by task or session identity", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.armPrompt({
				taskId: claimed.taskId,
				round: claimed.round,
				attemptId: claimed.attemptId,
				sessionId: claimed.sessionId,
				promptSha256: "a".repeat(64),
				authorization: null,
				now: Date.now(),
			});
			const held = queue.holds();
			for (const target of [claimed.taskId, claimed.sessionId]) {
				expect(queue.releaseQuarantine({
					taskId: target, round: claimed.round, sessionId: claimed.sessionId,
					authorization: {
						kind: "owner_release",
						owner: owner(),
						verification: {
							source: "host_dialog", at: new Date().toISOString(),
							evidence: "Operator inspected this exact worker session",
						},
					},
					now: Date.now(),
				}).kind).not.toBe("released");
				expect(queue.holds()).toEqual(held);
			}
		} finally {
			queue.close();
		}
	});
});

describe("execution end and receipt commit are independent facts", () => {
	it("keeps a committed unknown execution isolated until exact end evidence arrives", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.armPrompt({
				taskId: claimed.taskId, round: 1, attemptId: claimed.attemptId,
				sessionId: claimed.sessionId, promptSha256: "b".repeat(64), authorization: null, now: Date.now(),
			});
			queue.beginTerminal({
				taskId: TASK_A, round: 1, outcome: {
					status: "interrupted", errorJson: null,
					outcomeJson: JSON.stringify({ status: "interrupted", reason: "transport_lost" }),
				},
				now: Date.now(),
			});
			expect(queue.confirmReceipt({
				taskId: TASK_A, round: 1, receiptSha256: "c".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: Number(queue.inspect({ taskId: TASK_A }).tasks[0]?.revision) },
				now: Date.now(),
			}).kind).toBe("committed");
			expect(queue.holds()).toEqual([
				{ sessionId: SESSION_WB, taskId: TASK_A, round: 1, kind: "quarantine" },
			]);
			expect(queue.works()[0]?.state).toBe("blocked");
			expect(queue.armPrompt({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId,
				sessionId: SESSION_WB, promptSha256: "b".repeat(64), authorization: null, now: Date.now(),
			}).kind).toBe("lost");
			expect(queue.recordExecutionEnd({
				taskId: TASK_A, round: 1, attemptId: randomUUID(), sessionId: SESSION_WB, now: Date.now(),
			}).kind).toBe("refused");
			expect(queue.holds()[0]?.kind).toBe("quarantine");
			expect(queue.recordExecutionEnd({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB, now: Date.now(),
			}).kind).toBe("recorded");
			expect(queue.holds()).toEqual([]);
			expect(queue.works()[0]?.state).toBe("released");
			expect(queue.inspect({ taskId: TASK_A }).tasks[0]?.status).toBe("interrupted");
		} finally {
			queue.close();
		}
	});

	it("lets only a legal same-session successor consume unsent work once", async () => {
		const root = await preparedProject();
		const originalClaim = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.retireOwner(owner());
			queue.reconcileAbandonedRounds({ now: Date.now() });
			const stranger = { ...owner(), sessionId: "another-omp", generation: "foreign", instanceId: "foreign" };
			queue.registerOwner(stranger, Date.now());
			expect(queue.adoptUnsentRounds({ owner: stranger, now: Date.now() })).toBe(0);
			const successor = { ...owner(), generation: "successor", instanceId: "successor" };
			queue.registerOwner(successor, Date.now());
			expect(queue.adoptUnsentRounds({ owner: successor, now: Date.now() })).toBe(1);
			const claimed = queue.claim(successor, Date.now());
			if (claimed.kind !== "claimed") {
				throw new Error(`successor could not consume the recovered task: ${claimed.kind}`);
			}
			expect(claimed.taskId).toBe(TASK_A);
			expect(claimed.attemptId).not.toBe(originalClaim.attemptId);
			expect(queue.works()[0]?.state).toBe("active");
			expect(JSON.parse(queue.works()[0]!.recordJson).state).toBe("active");
			const arm = {
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB,
				promptSha256: "d".repeat(64), authorization: null, now: Date.now(),
			};
			expect(queue.armPrompt(arm).kind).toBe("armed");
			expect(queue.armPrompt(arm).kind).toBe("lost");
			expect(queue.adoptUnsentRounds({ owner: successor, now: Date.now() })).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("preserves a known business result when its owner exits before the receipt commit", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.armPrompt({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB,
				promptSha256: "e".repeat(64), authorization: null, now: Date.now(),
			});
			queue.recordExecutionEnd({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB, now: Date.now(),
			});
			const firstResult = JSON.stringify({ status: "completed", summary: "verified worker result" });
			queue.beginTerminal({
				taskId: TASK_A, round: 1,
				outcome: { status: "completed", errorJson: null, outcomeJson: firstResult }, now: Date.now(),
			});
			queue.retireOwner(owner());
			queue.reconcileAbandonedRounds({ now: Date.now() });
			const row = queue.inspect({ taskId: TASK_A }).tasks[0]!;
			expect(row.status).toBe("completed");
			expect(row.outcome_json).toBe(firstResult);
			expect(row.dispatch_state).toBe("ended");
			expect(row.commit_state).toBe("failed");
			expect(queue.holds()[0]?.kind).toBe("quarantine");
			expect(queue.confirmReceipt({
				taskId: TASK_A, round: 1, receiptSha256: "f".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: Number(row.revision) }, now: Date.now(),
			}).kind).toBe("committed");
			expect(queue.holds()).toEqual([]);
			expect(queue.inspect({ taskId: TASK_A }).tasks[0]?.outcome_json).toBe(firstResult);
		} finally {
			queue.close();
		}
	});
});


// ---------------------------------------------------------------------------
// Context isolation and durable affinity across the whole lifecycle.
// ---------------------------------------------------------------------------

describe("a WorkBuddy context carries exactly one task", () => {
	it("keeps the affinity and the usage ledger across a terminal release", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			expect(queue.taskSession(TASK_A)).toBe(SESSION_WB);
			expect(queue.armPrompt({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB,
				promptSha256: "1".repeat(64), authorization: null, now: Date.now(),
			}).kind).toBe("armed");
			queue.recordExecutionEnd({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB, now: Date.now(),
			});
			queue.beginTerminal({
				taskId: TASK_A, round: 1,
				outcome: { status: "completed", errorJson: null, outcomeJson: "{}" }, now: Date.now(),
			});
			const row = queue.inspect({ taskId: TASK_A }).tasks[0]!;
			expect(queue.confirmReceipt({
				taskId: TASK_A, round: 1, receiptSha256: "2".repeat(64),
				commitToken: { requestId: REQUEST_A, resultRevision: Number(row.revision) }, now: Date.now(),
			}).kind).toBe("committed");
			// The hold and the scope are released...
			expect(queue.holds()).toEqual([]);
			// ...but the context stays attributed to this task forever.
			expect(queue.taskSession(TASK_A)).toBe(SESSION_WB);
			const db = openWriteConnection(root);
			const usage = db.query("SELECT session_id, task_id, state FROM session_usage").all() as Array<{
				session_id: string; task_id: string; state: string;
			}>;
			expect(usage).toHaveLength(1);
			expect(usage[0]?.state).toBe("used");
			expect(usage[0]?.task_id).toBe(TASK_A);
		} finally {
			queue.close();
		}
	});

	it("keeps the affinity when an unsent claim is rolled back", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			expect(queue.rollbackClaim({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, reason: "nothing was sent", now: Date.now(),
			}).kind).toBe("requeued");
			// The round is queued again, but the task still belongs to its context.
			expect(queue.taskSession(TASK_A)).toBe(SESSION_WB);
			const row = queue.inspect({ taskId: TASK_A }).tasks[0]!;
			expect(row["selected_session"]).toBeNull();
			// The re-claim lands in the same context.
			const again = queue.claim(owner(), Date.now());
			expect(again.kind).toBe("claimed");
			if (again.kind === "claimed") {
				expect(again.sessionId).toBe(SESSION_WB);
			}
		} finally {
			queue.close();
		}
	});

	it("refuses a second task on a context that already carried one", async () => {
		const root = await preparedProject();
		const claimed = claimOne(root);
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.armPrompt({
				taskId: TASK_A, round: 1, attemptId: claimed.attemptId, sessionId: SESSION_WB,
				promptSha256: "3".repeat(64), authorization: null, now: Date.now(),
			});
			const db = openWriteConnection(root);
			// A second, unrelated task points at the same WorkBuddy session.
			withImmediate(db, () => {
				db.run(
					`INSERT INTO rounds(task_id, round, request_id, record_kind, revision, status, phase,
						target_policy_json, desired_scope_json, owner_session, owner_generation,
						manifest_path, manifest_sha256, approval_json, approval_consumed,
						enqueued_at, dispatch_state, cancel_requested, commit_state,
						review_state, delivery_mode, turns_json, updated_at)
					 VALUES('other-task', 1, 'other-request', 'legacy', 1, 'queued', 'queued', ?, '{}',
						?, ?, NULL, NULL, NULL, 0, ?, 'not_sent', 0, 'pending', 'pending', 'foreground', '[]', ?)`,
					[
						JSON.stringify({ kind: "session", sessionId: SESSION_WB }),
						owner().sessionId,
						owner().generation,
						Date.now(),
						Date.now(),
					],
				);
			});
			// The context already carries this other task's work: it is refused.
			// The hold is still in place, so the first reason is the busy session.
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "session_busy",
			});
			// Once the hold is released — the first task finished — the context is
			// still not available: it is not clean any more.
			withImmediate(db, () => {
				db.run("DELETE FROM holds WHERE session_id = ?", [SESSION_WB]);
			});
			expect(queue.claim(owner(), Date.now())).toMatchObject({
				kind: "waiting",
				reason: "no_unused_session",
			});
		} finally {
			queue.close();
		}
	});
});
