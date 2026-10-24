/**
 * Delivery: durable facts, host sends, and the receive boundary.
 *
 * These tests use a real project database and real receipt/artifact files. The
 * properties a user feels are the ones asserted here: a fact wakes the OMP once,
 * a failed send can be retried without resending WorkBuddy work, a sent message
 * is not a received one, an interrupted wait neither cancels the work nor
 * silently switches it to background, a same-session restart can still find the
 * pending review while a foreign session finds nothing, and a known result
 * whose receipt failed is reported as a storage problem instead of a
 * fabricated deliverable.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
	acknowledgeReviewedResult,
	flushDelivery,
	listDeliveryInbox,
	publishDelivery,
	readDeliveryPolicy,
	readDeliveryResult,
	renderDeliveryMessage,
	resolveWaitEnd,
	RESULT_FACT_REVISION,
	setDeliveryMode,
	type DeliveryInboxItem,
	type DeliveryMessage,
	type DeliveryPolicy,
	type PublishDeliveryOutcome,
	type SetDeliveryModeOutcome,
} from "../src/delivery";
import {
	closeQueueConnection,
	enableProject,
	openWriteConnection,
	registerOwner,
	retireOwner,
} from "../src/queue";
import { resolveRoundPaths } from "../src/tasks";
import type { DeliveryMode, FileArtifact, OwnerIdentity, TaskReceiptV3 } from "../src/types";
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

function owner(sessionId = "omp-session-1", generation = "gen-1"): OwnerIdentity {
	return {
		sessionId,
		generation,
		processId: process.pid,
		instanceId: `instance-${sessionId}-${generation}`,
	};
}

async function project(prefix = "wb-delivery-"): Promise<string> {
	const root = await createFixtureRoot(prefix);
	roots.push(root);
	await enableProject(root);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	return root;
}

interface SeedOptions {
	ownerSession?: string;
	ownerGeneration?: string;
	status?: string;
	phase?: string;
	outcome?: { status: "completed" | "failed" | "cancelled" | "interrupted"; error: unknown } | null;
	commitState?: "pending" | "committed" | "failed";
	dispatchState?: "not_sent" | "possibly_sent" | "ended";
	storageError?: string | null;
	deliveryMode?: DeliveryMode;
	consentJson?: string | null;
}

/**
 * Seeds one round with an open write connection, then closes it: no test keeps
 * a cached Database across an await that goes through the delivery module.
 */
async function seedRound(root: string, options: SeedOptions = {}): Promise<{ taskId: string; requestId: string }> {
	const db = openWriteConnection(root);
	try {
		return seedRoundOn(db, options);
	} finally {
		closeQueueConnection(root, "write");
	}
}

function seedRoundOn(db: Database, options: SeedOptions = {}): { taskId: string; requestId: string } {
	const taskId = randomUUID();
	const requestId = randomUUID();
	const now = Date.now();
	const approval = JSON.stringify({
		source: "host_dialog",
		at: "2026-10-20T00:00:00.000Z",
		payloadSha256: "manifest-hash",
	});
	db.run(
		`INSERT INTO rounds(
			task_id, round, request_id, record_kind, revision, status, phase,
			target_policy_json, desired_scope_json, selected_session,
			owner_session, owner_generation, manifest_path, manifest_sha256,
			approval_json, approval_consumed, attempt_id, enqueued_at,
			dispatch_state, cancel_requested, commit_state, review_state,
			delivery_mode, delivery_consent_json, turns_json, updated_at,
			outcome_json, storage_error_json, receipt_sha256, result_revision
		) VALUES(
			?, 1, ?, 'approved', 1, ?, ?,
			'{"kind":"session","sessionId":"wb-session"}', '{"readPaths":[],"writePaths":[]}', 'wb-session',
			?, ?, '/tmp/manifest.json', 'manifest-hash',
			?, 1, 'attempt-1', ?,
			?, 0, ?, 'pending',
			?, ?, '[]', ?,
			?, ?, NULL, NULL
		)`,
		[
			taskId,
			requestId,
			options.status ?? "running",
			options.phase ?? "running",
			options.ownerSession ?? "omp-session-1",
			options.ownerGeneration ?? "gen-1",
			approval,
			now,
			options.dispatchState ?? "ended",
			options.commitState ?? "pending",
			options.deliveryMode ?? "foreground",
			options.consentJson ?? null,
			now,
			options.outcome === undefined || options.outcome === null
				? null
				: JSON.stringify({ status: options.outcome.status, error: options.outcome.error }),
			options.storageError ?? null,
		],
	);
	return { taskId, requestId };
}

/** Updates one seeded round's terminal facts on a fresh write connection. */
async function setOutcome(
	root: string,
	taskId: string,
	input: {
		status: "completed" | "failed" | "cancelled" | "interrupted";
		phase: string;
		commitState: "pending" | "committed" | "failed";
		error?: unknown;
		receiptSha?: string | null;
		storageError?: string | null;
		dispatchState?: string;
	},
): Promise<void> {
	const db = openWriteConnection(root);
	try {
		db.run(
			`UPDATE rounds SET status = ?, phase = ?, outcome_json = ?, commit_state = ?,
				receipt_sha256 = ?, storage_error_json = ?, dispatch_state = ?,
				result_revision = revision + 1, revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = 1`,
			[
				input.status,
				input.phase,
				JSON.stringify({ status: input.status, error: input.error ?? null }),
				input.commitState,
				input.receiptSha ?? null,
				input.storageError ?? null,
				input.dispatchState ?? "ended",
				Date.now(),
				taskId,
			],
		);
	} finally {
		closeQueueConnection(root, "write");
	}
}

async function createArtifact(root: string, relativePath: string, content: string): Promise<FileArtifact> {
	const absolute = path.join(root, relativePath);
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf-8");
	return {
		kind: "file",
		path: absolute,
		sha256: createHash("sha256").update(content, "utf-8").digest("hex"),
		bytes: Buffer.byteLength(content, "utf-8"),
		role: "final",
		provenance: "native",
		importedFrom: null,
	};
}

function receiptFor(input: {
	root: string;
	taskId: string;
	requestId: string;
	round?: number;
	status: "completed" | "failed" | "cancelled" | "interrupted";
	summary: string;
	artifacts: FileArtifact[];
}): TaskReceiptV3 {
	return {
		version: 3,
		taskId: input.taskId,
		sessionId: "wb-session",
		projectRoot: input.root,
		rounds: [
			{
				number: input.round ?? 1,
				layout: "round",
				goal: { objective: "write the report", context: "", constraints: [], acceptance: [], externalActions: [] },
				inputFiles: [],
				expectedOutputs: [],
				status: input.status,
				summary: input.summary,
				error: null,
				artifacts: input.artifacts,
				recordKind: "approved",
				requestId: input.requestId,
				targetPolicy: { kind: "session", sessionId: "wb-session" },
				snapshotRoot: input.root,
				owner: null,
				manifestSha256: null,
				commitToken: { requestId: input.requestId, resultRevision: 0 },
				turns: [],
				consent: null,
			},
		],
	};
}

async function writeReceipt(
	root: string,
	taskId: string,
	round: number,
	receipt: TaskReceiptV3,
): Promise<string> {
	const paths = resolveRoundPaths(root, taskId, round, "round");
	await mkdir(paths.roundDir, { recursive: true });
	const content = JSON.stringify(receipt);
	await writeFile(paths.receiptPath, content, "utf-8");
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** A fully committed, receipt-proven round for one session. */
async function committedResult(
	root: string,
	content = "report body",
	session = "omp-session-1",
	generation = "gen-1",
): Promise<{
	taskId: string;
	requestId: string;
	artifact: FileArtifact;
	digest: string;
}> {
	const { taskId, requestId } = await seedRound(root, { ownerSession: session, ownerGeneration: generation });
	const artifact = await createArtifact(root, path.join("outputs", "report.txt"), content);
	const receipt = receiptFor({
		root,
		taskId,
		requestId,
		status: "completed",
		summary: "The report is ready.",
		artifacts: [artifact],
	});
	const digest = await writeReceipt(root, taskId, 1, receipt);
	await setOutcome(root, taskId, { status: "completed", phase: "terminal", commitState: "committed", receiptSha: digest });
	return { taskId, requestId, artifact, digest };
}

/** Publishes one result fact on a fresh connection. */
async function publishResult(root: string, who: OwnerIdentity, taskId: string): Promise<string> {
	const db = openWriteConnection(root);
	try {
		const outcome = publishDelivery(db, { owner: who, taskId, round: 1, kind: "result", revision: RESULT_FACT_REVISION });
		if (outcome.kind === "refused") {
			throw new Error(`publish refused: ${outcome.reason}`);
		}
		return outcome.deliveryId;
	} finally {
		closeQueueConnection(root, "write");
	}
}

/** Registers an owner on a fresh connection. */
async function register(root: string, who: OwnerIdentity): Promise<void> {
	const db = openWriteConnection(root);
	try {
		registerOwner(db, who, Date.now());
	} finally {
		closeQueueConnection(root, "write");
	}
}

/** Retires an owner on a fresh connection. */
async function retire(root: string, who: OwnerIdentity): Promise<void> {
	const db = openWriteConnection(root);
	try {
		retireOwner(db, who);
	} finally {
		closeQueueConnection(root, "write");
	}
}

/** Reads one outbox row as a plain record, on a fresh connection. */
async function outboxRow(root: string, requestId: string): Promise<Record<string, unknown> | null> {
	const db = openWriteConnection(root);
	try {
		return (db.query("SELECT * FROM outbox WHERE request_id = ?").get(requestId) ?? null) as Record<
			string,
			unknown
		> | null;
	} finally {
		closeQueueConnection(root, "write");
	}
}

describe("delivery publication and flushing", () => {
	it("publishes the same result fact once even when called again", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId } = await seedRound(root, { outcome: { status: "completed", error: null } });

		const db = openWriteConnection(root);
		let first: PublishDeliveryOutcome;
		let again: PublishDeliveryOutcome;
		let badRevision: PublishDeliveryOutcome;
		let count: { count: number };
		try {
			first = publishDelivery(db, { owner: me, taskId, round: 1, kind: "result", revision: RESULT_FACT_REVISION });
			again = publishDelivery(db, { owner: me, taskId, round: 1, kind: "result", revision: RESULT_FACT_REVISION });
			badRevision = publishDelivery(db, { owner: me, taskId, round: 1, kind: "result", revision: 2 });
			count = db.query("SELECT COUNT(*) AS count FROM outbox").get() as { count: number };
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(first.kind).toBe("created");
		// The same fact is idempotent: the second publish reports the row it found rather
		// than claiming a second creation.
		expect(again.kind).toBe("existing");
		// Both describe one row: the idempotent publish names the same delivery.
		const firstId = first.kind === "refused" ? null : first.deliveryId;
		const againId = again.kind === "refused" ? null : again.deliveryId;
		expect(againId).toBe(firstId);
		expect(count.count).toBe(1);
		expect(badRevision).toEqual({ kind: "refused", reason: "invalid_revision" });
	});

	it("sends once, skips duplicate and concurrent flushes, and records sent only after the callback", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId } = await committedResult(root);
		await publishResult(root, me, taskId);

		// The row is not sent merely because it was published.
		const before = await outboxRow(root, requestId);
		expect(before?.["notified_generation"]).toBeNull();

		let sends = 0;
		const messages: DeliveryMessage[] = [];
		const first = await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async (message) => {
				sends += 1;
				messages.push(message);
			},
		});
		expect(first).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
		expect(sends).toBe(1);
		expect(messages[0]?.taskId).toBe(taskId);
		expect(messages[0]?.round).toBe(1);
		expect(messages[0]?.text).toContain("Open, run or compare");
		expect(messages[0]?.text).toContain("not a receipt or acceptance");

		const second = await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async () => {
				sends += 1;
			},
		});
		expect(second).toMatchObject({ sent: 0, failed: 0 });
		expect(sends).toBe(1);

		// Two concurrent flushes share one in-process flight instead of racing the
		// same claim into two callbacks.
		// A result is only notification-worthy once its commit is proven; a pending
		// commit is deliberately skipped by the claim scan, so this seeds a real one.
		const { taskId: secondTask } = await committedResult(root, "second body");
		await publishResult(root, me, secondTask);
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let concurrentSends = 0;
		let slowSendStarted: (() => void) | null = null;
		const sendStarted = new Promise<void>((resolve) => {
			// Resolves on the first real callback invocation, so the assertion waits
			// for the event itself instead of a guessed duration.
			slowSendStarted = resolve;
		});
		const slowSend = async (): Promise<void> => {
			concurrentSends += 1;
			slowSendStarted?.();
			await gate;
		};
		const left = flushDelivery({ projectRoot: root, owner: me, sendMessage: slowSend });
		const right = flushDelivery({ projectRoot: root, owner: me, sendMessage: slowSend });
		// A concurrent flush joins the flight rather than starting a second send, so the
		// first callback may be the only one that ever runs.
		await sendStarted;
		expect(concurrentSends).toBe(1);
		// The shared flight itself must be the same promise, which is what makes the two
		// callers observe one send instead of two.
		expect(left).toBe(right);
		(release as ((value: void) => void) | null)?.();
		const [leftResult, rightResult] = await Promise.all([left, right]);
		expect(leftResult).toEqual(rightResult);
		expect(concurrentSends).toBe(1);
	});

	it("keeps a rejected send recoverable and never resends the work itself", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId } = await committedResult(root);
		await publishResult(root, me, taskId);

		const failed = await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async () => {
				throw new Error("host follow-up refused");
			},
		});
		expect(failed).toMatchObject({ sent: 0, failed: 1 });
		expect(failed.failures[0]?.reason).toContain("refused");
		const row = await outboxRow(root, requestId);
		expect(row?.["notified_generation"]).toBeNull();
		expect(row?.["acknowledged_at"]).toBeNull();

		const retry = await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async () => undefined,
		});
		expect(retry).toMatchObject({ sent: 1, failed: 0 });
	});

	it("distinguishes sent from received and only acknowledges after a real review", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId } = await committedResult(root);
		const deliveryId = await publishResult(root, me, taskId);
		void deliveryId;

		// Published but not sent, and never reviewed: nothing to acknowledge yet.
		const db0 = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(db0, { owner: me, taskId, round: 1, evidence: { at: Date.now(), reference: "" } }),
			).toEqual({ kind: "refused", reason: "evidence_required" });
		} finally {
			closeQueueConnection(root, "write");
		}

		await flushDelivery({ projectRoot: root, owner: me, sendMessage: async () => undefined });
		const sentButNotReceived = await readDeliveryResult(root, taskId, 1);
		expect(sentButNotReceived?.notification).toMatchObject({ sent: true, received: false });
		const inboxDb = openWriteConnection(root);
		try {
			expect(listDeliveryInbox(inboxDb, me)).toHaveLength(1);
		} finally {
			closeQueueConnection(root, "write");
		}

		// A review of the round is the evidence: it names what was actually consumed.
		const ackDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(ackDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "wb_review review-1" },
				}),
			).toEqual({ kind: "acked" });
		} finally {
			closeQueueConnection(root, "write");
		}
		const received = await readDeliveryResult(root, taskId, 1);
		expect(received?.notification).toMatchObject({ sent: true, received: true });
		const emptyDb = openWriteConnection(root);
		try {
			expect(listDeliveryInbox(emptyDb, me)).toEqual([]);
		} finally {
			closeQueueConnection(root, "write");
		}
		// A second acknowledgement is idempotent, not a second receive event.
		const againDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(againDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "wb_review review-1" },
				}),
			).toEqual({ kind: "acked" });
		} finally {
			closeQueueConnection(root, "write");
		}
	});

	it("continues a pre-send failure after a same-session restart and keeps the sent result discoverable", async () => {
		const root = await project();
		const firstOwner = owner("omp-session-1", "gen-1");
		await register(root, firstOwner);
		const { taskId, requestId } = await committedResult(root);
		await publishResult(root, firstOwner, taskId);
		const failed = await flushDelivery({
			projectRoot: root,
			owner: firstOwner,
			sendMessage: async () => {
				throw new Error("socket closed before send");
			},
		});
		expect(failed.failed).toBe(1);

		await retire(root, firstOwner);
		const successor = owner("omp-session-1", "gen-2");
		await register(root, successor);
		// Publishing again with the successor rebinds the stale intended owner, but
		// the fact stays the same row.
		const republishDb = openWriteConnection(root);
		try {
			const republished = publishDelivery(republishDb, {
				owner: successor,
				taskId,
				round: 1,
				kind: "result",
				revision: RESULT_FACT_REVISION,
			});
			expect(republished.kind).toBe("existing");
		} finally {
			closeQueueConnection(root, "write");
		}
		const rebound = await outboxRow(root, requestId);
		expect(rebound?.["owner_generation"]).toBe("gen-2");

		const inboxDb = openWriteConnection(root);
		try {
			const inbox = listDeliveryInbox(inboxDb, successor);
			expect(inbox).toHaveLength(1);
			expect(inbox[0]).toMatchObject({ taskId, round: 1, sent: false, received: false });
		} finally {
			closeQueueConnection(root, "write");
		}

		const sent = await flushDelivery({
			projectRoot: root,
			owner: successor,
			sendMessage: async () => undefined,
		});
		expect(sent.sent).toBe(1);

		// A second restart must not auto-notify again, but the sent result remains
		// discoverable as pending review in the inbox.
		await retire(root, successor);
		const third = owner("omp-session-1", "gen-3");
		await register(root, third);
		const skipped = await flushDelivery({
			projectRoot: root,
			owner: third,
			sendMessage: async () => {
				throw new Error("must not be sent twice");
			},
		});
		expect(skipped).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
		const pendingDb = openWriteConnection(root);
		let pending: DeliveryInboxItem[];
		try {
			pending = listDeliveryInbox(pendingDb, third);
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ taskId, round: 1, sent: true, received: false });
		// The new generation may acknowledge after actually reviewing it.
		const ackDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(ackDb, {
					owner: third,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "wb_review review-restart" },
				}),
			).toEqual({ kind: "acked" });
		} finally {
			closeQueueConnection(root, "write");
		}
	});

	it("refuses foreign OMP sessions for publish, flush, inbox and acknowledgement", async () => {
		const root = await project();
		const me = owner("omp-session-1", "gen-1");
		const other = owner("omp-other", "gen-1");
		await register(root, me);
		await register(root, other);
		const { taskId } = await committedResult(root);

		const publishDb = openWriteConnection(root);
		try {
			expect(
				publishDelivery(publishDb, { owner: other, taskId, round: 1, kind: "result", revision: RESULT_FACT_REVISION }),
			).toEqual({ kind: "refused", reason: "foreign_session" });
		} finally {
			closeQueueConnection(root, "write");
		}
		const deliveryId = await publishResult(root, me, taskId);
		await flushDelivery({ projectRoot: root, owner: me, sendMessage: async () => undefined });

		let foreignSends = 0;
		const foreignFlush = await flushDelivery({
			projectRoot: root,
			owner: other,
			sendMessage: async () => {
				foreignSends += 1;
			},
		});
		expect(foreignFlush).toMatchObject({ sent: 0, skipped: 0, failed: 0 });
		expect(foreignSends).toBe(0);
		const inboxDb = openWriteConnection(root);
		try {
			expect(listDeliveryInbox(inboxDb, other)).toEqual([]);
		} finally {
			closeQueueConnection(root, "write");
		}
		const ackDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(ackDb, {
					owner: other,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "wb_review review-foreign" },
				}),
			).toEqual({ kind: "refused", reason: "foreign_session" });
		} finally {
			closeQueueConnection(root, "write");
		}
		void deliveryId;
	});

	it("acknowledges an in-band reviewed result without a fake send, and refuses one without review evidence", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId } = await committedResult(root);
		const deliveryId = await publishResult(root, me, taskId);

		void deliveryId;
		// No review is referenced: refused before anything else is considered.
		const noReferenceDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(noReferenceDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "  " },
				}),
			).toEqual({ kind: "refused", reason: "evidence_required" });
		} finally {
			closeQueueConnection(root, "write");
		}

		// A foreign session never saw the in-band result.
		const other = owner("omp-other", "gen-1");
		await register(root, other);
		const foreignDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(foreignDb, {
					owner: other,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "review-1" },
				}),
			).toEqual({ kind: "refused", reason: "foreign_session" });
		} finally {
			closeQueueConnection(root, "write");
		}

		// The host really reviewed: acknowledged even though nothing was async-sent.
		const ackDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(ackDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: `wb_review ${requestId}` },
				}),
			).toEqual({ kind: "acked" });
		} finally {
			closeQueueConnection(root, "write");
		}
		const report = await readDeliveryResult(root, taskId, 1);
		expect(report?.notification).toMatchObject({ sent: false, received: true });
		// Idempotent: reviewing twice is one receive event.
		const againDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(againDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: `wb_review ${requestId}` },
				}),
			).toEqual({ kind: "acked" });
		} finally {
			closeQueueConnection(root, "write");
		}
	});

	it("refuses an in-band acknowledgement for an uncommitted or unregistered owner", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId } = await seedRound(root, { outcome: { status: "completed", error: null } });
		await publishResult(root, me, taskId);

		// Outcome exists but the commit has not settled.
		const pendingDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(pendingDb, {
					owner: me,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "review-1" },
				}),
			).toEqual({ kind: "refused", reason: "commit_pending" });
		} finally {
			closeQueueConnection(root, "write");
		}

		// An owner identity that was never registered is not active.
		const stranger = owner("omp-session-1", "gen-9");
		const strangerDb = openWriteConnection(root);
		try {
			expect(
				acknowledgeReviewedResult(strangerDb, {
					owner: stranger,
					taskId,
					round: 1,
					evidence: { at: Date.now(), reference: "review-1" },
				}),
			).toEqual({ kind: "refused", reason: "owner_not_active" });
		} finally {
			closeQueueConnection(root, "write");
		}
	});
});

describe("delivery policy and truthful results", () => {
	it("requires host-created consent for background and never lets a wait ending flip the mode", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId } = await seedRound(root);

		const db = openWriteConnection(root);
		let foreground: DeliveryPolicy | null;
		let refused: SetDeliveryModeOutcome;
		let changed: SetDeliveryModeOutcome;
		try {
			foreground = readDeliveryPolicy(db, taskId, 1);
			refused = setDeliveryMode(db, { owner: me, taskId, round: 1, mode: "background" });
			const consent = { source: "host_dialog" as const, at: "2026-10-20T12:00:00.000Z" };
			changed = setDeliveryMode(db, { owner: me, taskId, round: 1, mode: "background", consent });
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(foreground).toEqual({ mode: "foreground", backgroundConsent: null, backgroundAuthorized: false });
		expect(resolveWaitEnd(foreground!, "expired")).toEqual({
			mode: "foreground",
			followupRequired: true,
			backgroundReport: false,
			cancelsExecution: false,
		});
		expect(refused).toEqual({ kind: "refused", reason: "background_requires_consent", policy: foreground });

		expect(changed.kind).toBe("updated");
		if (changed.kind === "updated") {
			expect(changed.policy).toMatchObject({ mode: "background", backgroundAuthorized: true });
		}
		// Persisted across a connection restart, not only in memory.
		const reopened = openWriteConnection(root);
		let policy: DeliveryPolicy | null;
		try {
			policy = readDeliveryPolicy(reopened, taskId, 1);
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(policy).toMatchObject({ mode: "background", backgroundAuthorized: true });
		expect(policy?.backgroundConsent?.source).toBe("host_dialog");

		// A steered/aborted wait does not go back to foreground and does not cancel
		// the work; it still reports through the authorized background path.
		expect(resolveWaitEnd(policy!, "steered")).toEqual({
			mode: "background",
			followupRequired: true,
			backgroundReport: true,
			cancelsExecution: false,
		});
		expect(resolveWaitEnd(policy!, "aborted")).toEqual({
			mode: "background",
			followupRequired: true,
			backgroundReport: true,
			cancelsExecution: false,
		});

		// The mode is history once the first outcome exists.
		await setOutcome(root, taskId, { status: "completed", phase: "terminal", commitState: "pending" });
		const terminalDb = openWriteConnection(root);
		try {
			expect(
				setDeliveryMode(terminalDb, { owner: me, taskId, round: 1, mode: "foreground" }),
			).toMatchObject({ kind: "refused", reason: "terminal_round" });
		} finally {
			closeQueueConnection(root, "write");
		}
	});

	it("never promotes a background row that lost its consent evidence", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		// A row whose mode was set to background without any recorded consent
		// (legacy damage or manual write): reported, never silently promoted.
		const { taskId } = await seedRound(root, { deliveryMode: "background", consentJson: null });

		const db = openWriteConnection(root);
		let policy: DeliveryPolicy | null;
		try {
			policy = readDeliveryPolicy(db, taskId, 1);
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(policy).toEqual({ mode: "background", backgroundConsent: null, backgroundAuthorized: false });
		expect(resolveWaitEnd(policy!, "expired")).toMatchObject({
			mode: "background",
			backgroundReport: false,
			cancelsExecution: false,
		});
	});

	it("reports a committed receipt with re-hashed artifact refs and marks changed bytes", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId, artifact, digest } = await committedResult(root, "first bytes");

		const report = await readDeliveryResult(root, taskId, 1);
		expect(report).toMatchObject({
			state: "committed",
			taskId,
			round: 1,
			requestId,
			outcome: { status: "completed" },
			commit: "committed",
			receipt: { sha256: digest },
			summary: "The report is ready.",
			dispatchState: "ended",
		});
		expect(report?.artifacts).toEqual([
			{
				path: artifact.path,
				sha256: artifact.sha256,
				bytes: artifact.bytes,
				role: "final",
				state: "verified",
			},
		]);

		// Rewriting the file after the commit is reported, not accepted silently.
		await writeFile(artifact.path, "different bytes", "utf-8");
		const changed = await readDeliveryResult(root, taskId, 1);
		expect(changed?.state).toBe("committed");
		expect(changed?.artifacts[0]?.state).toBe("changed");
		const message = renderDeliveryMessage({
			kind: "result",
			taskId,
			round: 1,
			requestId,
			revision: RESULT_FACT_REVISION,
			report: changed!,
		});
		expect(message).toContain("changed");
		expect(message).toContain("do not present them as delivered");

		await rm(artifact.path);
		const missing = await readDeliveryResult(root, taskId, 1);
		expect(missing?.artifacts[0]?.state).toBe("missing");
	});

	it("keeps the first known outcome but reports a storage failure without fabricated artifacts", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId } = await seedRound(root);
		const artifact = await createArtifact(root, path.join("outputs", "unproven.txt"), "bytes that are not committed");
		// A receipt file may exist after a failed commit attempt; it is not proof.
		const receipt = receiptFor({
			root,
			taskId,
			requestId,
			status: "completed",
			summary: "An unproven summary.",
			artifacts: [artifact],
		});
		await writeReceipt(root, taskId, 1, receipt);
		const storageError = JSON.stringify({
			code: "WB_STORAGE_ERROR",
			message: "the receipt could not be confirmed",
		});
		await setOutcome(root, taskId, {
			status: "completed",
			phase: "recovery_required",
			commitState: "failed",
			storageError,
			dispatchState: "ended",
		});

		const report = await readDeliveryResult(root, taskId, 1);
		expect(report).toMatchObject({
			state: "storage_failure",
			commit: "failed",
			outcome: { status: "completed" },
			receipt: null,
			artifacts: [],
			storageError: { code: "WB_STORAGE_ERROR", message: "the receipt could not be confirmed" },
		});
		const message = renderDeliveryMessage({
			kind: "result",
			taskId,
			round: 1,
			requestId,
			revision: RESULT_FACT_REVISION,
			report: report!,
		});
		expect(message).toContain("first business outcome is preserved");
		expect(message).toContain("Do not resend the WorkBuddy work");
		expect(message).not.toContain(artifact.path);

		await publishResult(root, me, taskId);
		const sent: DeliveryMessage[] = [];
		await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async (message) => {
				sent.push(message);
			},
		});
		expect(sent[0]?.text).toContain("WB_STORAGE_ERROR");
		expect(sent[0]?.text).toContain("first business outcome is preserved");
	});

	it("does not trust a receipt whose digest or request identity disagrees with the queue row", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, requestId } = await committedResult(root);

		// Rewrite the receipt without updating the committed digest.
		const paths = resolveRoundPaths(root, taskId, 1, "round");
		await writeFile(paths.receiptPath, JSON.stringify({ version: 3, taskId, projectRoot: root, rounds: [] }), "utf-8");
		const digestMismatch = await readDeliveryResult(root, taskId, 1);
		expect(digestMismatch).toMatchObject({ state: "storage_failure", artifacts: [], receipt: null });
		expect(digestMismatch?.storageError?.message).toContain("no longer match");

		// Restore a matching digest but make the receipt describe another request.
		const foreignRequestId = randomUUID();
		const receipt = receiptFor({
			root,
			taskId,
			requestId: foreignRequestId,
			status: "completed",
			summary: "wrong request",
			artifacts: [],
		});
		const digest = await writeReceipt(root, taskId, 1, receipt);
		await setOutcome(root, taskId, { status: "completed", phase: "terminal", commitState: "committed", receiptSha: digest });
		const identityMismatch = await readDeliveryResult(root, taskId, 1);
		expect(identityMismatch).toMatchObject({ state: "storage_failure", artifacts: [] });
		expect(identityMismatch?.storageError?.message).toContain("does not describe");

		// A committed local result that may still be running remotely is reported
		// with the unresolved remote end, not treated as a free resource.
		const clean = await committedResult(root);
		await setOutcome(root, clean.taskId, {
			status: "completed",
			phase: "recovery_required",
			commitState: "committed",
			receiptSha: clean.digest,
			dispatchState: "possibly_sent",
		});
		const quarantined = await readDeliveryResult(root, clean.taskId, 1);
		expect(quarantined).toMatchObject({ state: "committed", dispatchState: "possibly_sent" });
		const message = renderDeliveryMessage({
			kind: "result",
			taskId: clean.taskId,
			round: 1,
			requestId: clean.requestId,
			revision: RESULT_FACT_REVISION,
			report: quarantined!,
		});
		expect(message).toContain("remote execution end is unresolved");
	});

	it("reports an unreadable stored outcome as invalid instead of inventing one", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId } = await seedRound(root);

		const db = openWriteConnection(root);
		try {
			db.run("UPDATE rounds SET outcome_json = '{not-json' WHERE task_id = ?", [taskId]);
		} finally {
			closeQueueConnection(root, "write");
		}

		const report = await readDeliveryResult(root, taskId, 1);
		expect(report).toMatchObject({ state: "running", outcome: null });
		expect(report?.storageError).toMatchObject({ code: "WB_TASK_STATE_INVALID" });
		expect(report?.storageError?.message).toContain("unreadable");
	});

	it("sends the verified committed view, and a storage failure message without fabricated artifacts", async () => {
		const root = await project();
		const me = owner();
		await register(root, me);
		const { taskId, artifact } = await committedResult(root);
		await publishResult(root, me, taskId);

		const sent: DeliveryMessage[] = [];
		await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async (message) => {
				sent.push(message);
			},
		});
		// The flush message carries the file-verified view: same truth as
		// readDeliveryResult, because verification ran before the send.
		expect(sent[0]?.text).toContain("receipt committed and verified");
		expect(sent[0]?.text).toContain(artifact.path);
		expect(sent[0]?.text).toContain("[verified]");

		// A receipt that no longer matches its committed digest is reported as a
		// storage failure, never as a deliverable. The tampering is applied to the
		// round being flushed, not to the one already delivered above.
		const { taskId: secondTask } = await committedResult(root, "second body");
		await publishResult(root, me, secondTask);
		await writeFile(resolveRoundPaths(root, secondTask, 1, "round").receiptPath, "tampered", "utf-8");
		const second: DeliveryMessage[] = [];
		await flushDelivery({
			projectRoot: root,
			owner: me,
			sendMessage: async (message) => {
				second.push(message);
			},
		});
		expect(second[0]?.text).toContain("could not be proven");
		expect(second[0]?.text).not.toContain("[verified]");
	});
});
