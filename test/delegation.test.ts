/**
 * Criterion review and the task's one correction (G06).
 *
 * The point of these cases is not that a review is stored, but that it binds to
 * bytes: a review of content nobody can prove is refused, an accepted round stops
 * being accepted when its file is rewritten, and a task can spend exactly one
 * correction with a deterministic plan. Every case drives the real queue.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { closeQueueConnection, enableProject, openProjectQueue, openWriteConnection } from "../src/queue";
import {
	readEffectiveTaskReview,
	readTaskReviews,
	releaseTaskCorrection,
	reserveTaskCorrection,
	submitTaskReview,
	validateTaskCorrection,
} from "../src/delegation";
import {
	buildConfirmationDigest,
	computeFileSha256,
	resolveRoundPaths,
	stageTask,
	writeRoundReceipt,
} from "../src/tasks";
import { WB_ERROR_CODE, type OwnerIdentity, type TaskGoal, type TaskManifestPayload } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];
const TASK = "dddddddd-1111-4111-8111-dddddddddddd";
const REQUEST = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const WB = "ffffffff-3333-4333-8333-ffffffffffff";

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			closeQueueConnection(root);
			closeQueueConnection(root, "read");
			await releaseProjectFixture(root);
		}
	}
});

function owner(generation = "gen-review"): OwnerIdentity {
	return { sessionId: "omp-review", generation, processId: process.pid, instanceId: "instance-review" };
}

const GOAL: TaskGoal = {
	objective: "Produce the quarterly summary",
	context: "Use the provided sales rows.",
	constraints: ["Markdown only"],
	acceptance: ["Totals match the input", "Every product appears"],
	externalActions: [],
};

interface Delivered {
	root: string;
	artifact: string;
	artifactSha: string;
}

/**
 * One enabled project with a completed, committed round and a real artifact.
 *
 * The round is written the way a real dispatch writes it: staged manifest, queue
 * row, then the terminal receipt through the same writer the host uses.
 */
async function deliveredRound(options: { outcome?: "committed" | "possibly_sent"; content?: string } = {}): Promise<Delivered> {
	const root = await createFixtureRoot("wb-review-");
	roots.push(root);
	await enableProject(root);
	const content = options.content ?? "# Summary\n\ntotal: 42\n";
	const outputsDir = resolveRoundPaths(root, TASK, 1, "round").outputsDir;
	await mkdir(outputsDir, { recursive: true });
	const artifactPath = path.join(outputsDir, "summary.md");
	await writeFile(artifactPath, content, "utf-8");
	const artifactSha = await computeFileSha256(artifactPath);

	const goal: TaskGoal = { ...GOAL, context: `${GOAL.context}\nArtifact: summary.md` };
	const target = { kind: "session" as const, sessionId: WB };
	const confirmation = {
		source: "host_dialog" as const,
		at: new Date().toISOString(),
		targetPolicy: target,
		requestId: REQUEST,
		manifestSha256: buildConfirmationDigest({
			projectRoot: root,
			requestId: REQUEST,
			taskId: TASK,
			round: 1,
			owner: owner(),
			goal,
			targetPolicy: target,
			expectedOutputs: ["summary.md"],
			inputs: [],
			deliveryMode: "foreground",
		}),
		owner: owner(),
		previousRound: 0,
		inputs: [],
		deliveryMode: "foreground" as const,
	};
	const staged = await stageTask(root, confirmation, { goal, inputFiles: [], expectedOutputs: ["summary.md"] }, TASK, 1);

	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		queue.registerOwner(owner(), Date.now());
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
			targetPolicy: target,
			ownerSession: owner().sessionId,
			ownerGeneration: owner().generation,
			executorInstanceId: owner().instanceId,
			approval: { source: confirmation.source, at: confirmation.at, payloadSha256: staged.manifestSha256 },
			title: "quarterly summary",
			deliveryMode: "foreground",
		});
		const claim = queue.claim(owner(), Date.now());
		expect(claim.kind).toBe("claimed");
		if (claim.kind === "claimed") {
			expect(
				queue.armPrompt({
					taskId: TASK,
					round: 1,
					attemptId: claim.attemptId,
					sessionId: WB,
					promptSha256: staged.manifestSha256,
					authorization: null,
					now: Date.now(),
				}).kind,
			).toBe("armed");
		}
		queue.beginTerminal({
			taskId: TASK,
			round: 1,
			outcome: {
				status: "completed",
				errorJson: null,
				outcomeJson: JSON.stringify({
					status: "completed",
					error: null,
					summary: "summary written",
					artifacts: [{ path: artifactPath, sha256: artifactSha, bytes: content.length, role: "final" }],
				}),
			},
			now: Date.now(),
		});
	} finally {
		queue.close();
	}

	const receipt = {
		version: 3,
		taskId: TASK,
		sessionId: owner().sessionId,
		projectRoot: await realpath(root),
		rounds: [
			{
				number: 1,
				layout: "round",
				goal,
				inputFiles: [],
				expectedOutputs: ["summary.md"],
				status: "completed",
				summary: "summary written",
				error: null,
				artifacts: [
					{ kind: "file", path: artifactPath, sha256: artifactSha, bytes: content.length, role: "final", provenance: "native", importedFrom: null },
				],
				recordKind: "approved",
				requestId: REQUEST,
				targetPolicy: target,
				snapshotRoot: staged.snapshotRoot,
				owner: owner(),
				manifestSha256: staged.manifestSha256,
				commitToken: null,
				turns: [],
				consent: { source: confirmation.source, at: confirmation.at },
			},
		],
	};
	const written = await writeRoundReceipt(root, TASK, 1, "round", receipt);
	const committing = openProjectQueue(root, { mode: "write" })!;
	try {
		const row = committing.inspect({ taskId: TASK }).tasks[0]!;
		const confirmed = committing.confirmReceipt({
			taskId: TASK,
			round: 1,
			receiptSha256: written.sha256,
			commitToken: { requestId: REQUEST, resultRevision: Number(row["revision"]) },
			now: Date.now(),
		});
		expect(confirmed.kind).toBe("committed");
		// The execution end is separate evidence from the commit.
		committing.registerOwner(owner(), Date.now());
		const ended = committing.recordExecutionEnd({
			taskId: TASK,
			round: 1,
			attemptId: String(row["attempt_id"]),
			sessionId: WB,
			now: Date.now(),
		});
		expect(ended.kind).toBe("recorded");
	} finally {
		committing.close();
	}
	closeQueueConnection(root);
	return { root, artifact: artifactPath, artifactSha };
}

function findings(status: "passed" | "failed", note = "checked the totals"): Array<{
	criterion: string;
	status: "passed" | "failed" | "blocked";
	note: string;
	evidence: string[];
}> {
	return [
		{ criterion: GOAL.acceptance[0]!, status, note, evidence: ["read summary.md"] },
		{ criterion: GOAL.acceptance[1]!, status: "passed", note: "every product listed", evidence: ["counted the rows"] },
	];
}

describe("criterion review", () => {
	it("records the reviewer's findings against the bytes on disk", async () => {
		const delivered = await deliveredRound();
		const submitted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK,
			round: 1,
			findings: findings("passed"),
			verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(submitted.kind).toBe("recorded");

		const effective = await readEffectiveTaskReview(delivered.root, { taskId: TASK });
		expect(effective?.review.verdict).toBe("accepted");
		expect(effective?.effective).toBeTrue();
		expect(effective?.review.findings).toHaveLength(2);
		// The denormalized hint on the round follows the newest review.
		const queue = openProjectQueue(delivered.root, { mode: "read" })!;
		try {
			expect(queue.inspect({ taskId: TASK }).tasks[0]!["review_state"]).toBe("accepted");
		} finally {
			queue.close();
		}
	});

	it("stops being effective when the reviewed file is rewritten, keeping the history", async () => {
		const delivered = await deliveredRound();
		await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("passed"), verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		await writeFile(delivered.artifact, "# Summary\n\ntotal: 7\n", "utf-8");

		const effective = await readEffectiveTaskReview(delivered.root, { taskId: TASK });
		expect(effective?.effective).toBeFalse();
		expect(effective?.invalidation).toBe("artifact_changed");
		// History is intact: the old verdict is still what was recorded.
		expect(await readTaskReviews(delivered.root, TASK)).toHaveLength(1);
	});

	it("refuses a review whose hash does not describe the file", async () => {
		const delivered = await deliveredRound();
		const submitted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("passed"), verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: "0".repeat(64) }],
		});
		expect(submitted).toEqual({ kind: "refused", reason: "review_mismatched" });
		expect(await readTaskReviews(delivered.root, TASK)).toEqual([]);
	});

	it("refuses an accepted verdict that leaves a criterion unpassed, and a critique with no failed criterion", async () => {
		const delivered = await deliveredRound();
		const accepted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("failed"), verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(accepted).toEqual({ kind: "refused", reason: "review_mismatched" });

		const critique = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("passed"), verdict: "changes_requested",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(critique).toEqual({ kind: "refused", reason: "review_mismatched" });
	});

	it("requires every original criterion, exactly once, with evidence", async () => {
		const delivered = await deliveredRound();
		const partial = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, verdict: "accepted",
			findings: [{ criterion: GOAL.acceptance[0]!, status: "passed", note: "ok", evidence: ["read it"] }],
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(partial).toEqual({ kind: "refused", reason: "review_incomplete" });

		const noEvidence = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, verdict: "accepted",
			findings: [
				{ criterion: GOAL.acceptance[0]!, status: "passed", note: "ok", evidence: [] },
				{ criterion: GOAL.acceptance[1]!, status: "passed", note: "ok", evidence: ["rows"] },
			],
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(noEvidence).toEqual({ kind: "refused", reason: "review_incomplete" });
	});

	it("refuses a review from a different OMP session", async () => {
		const delivered = await deliveredRound();
		const submitted = await submitTaskReview(delivered.root, { ...owner(), sessionId: "omp-other" }, {
			taskId: TASK, round: 1, findings: findings("passed"), verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		expect(submitted).toEqual({ kind: "refused", reason: "foreign_session" });
	});
});

describe("one correction per task", () => {
	/** Records a changes_requested review and returns its id. */
	async function reviewedChanges(delivered: Delivered): Promise<string> {
		const submitted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("failed", "the totals do not match"), verdict: "changes_requested",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		if (submitted.kind !== "recorded") {
			throw new Error(`review refused: ${submitted.reason}`);
		}
		return submitted.review.reviewId;
	}

	it("freezes a deterministic plan that continues the original goal", async () => {
		const delivered = await deliveredRound();
		const reviewId = await reviewedChanges(delivered);
		const reserved = await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		expect(reserved.kind).toBe("reserved");
		if (reserved.kind !== "reserved") {
			return;
		}
		const plan = reserved.plan;
		expect(plan.targetRound).toBe(2);
		expect(plan.requestId).toBeString();
		// The original authorization is what the correction continues.
		expect(plan.baseAuthorization.requestId).toBe(REQUEST);
		expect(plan.baseAuthorization.manifestSha256).toBeString();
		// The goal is repeated, not replaced: only the context gains the defect.
		expect(plan.request.goal.objective).toBe(GOAL.objective);
		expect(plan.request.goal.acceptance).toEqual(GOAL.acceptance);
		expect(plan.request.goal.constraints).toEqual(GOAL.constraints);
		expect(plan.request.goal.context).toContain("totals do not match");
		// Only the criterion the reviewer marked failed is carried into the correction.
		expect(plan.failedCriteria.map((finding) => finding.criterion)).toEqual([GOAL.acceptance[0]!]);
		// The reviewed output is frozen as an input, so the correction works from it.
		expect(plan.inputs.some((entry) => entry.sha256 === delivered.artifactSha)).toBeTrue();

		// A retry returns the same frozen plan instead of a second one.
		const again = await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		expect(again).toEqual({ kind: "existing", plan });
	});

	it("refuses a second review's correction once the task has spent its one", async () => {
		const delivered = await deliveredRound();
		const reviewId = await reviewedChanges(delivered);
		expect((await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId })).kind).toBe("reserved");

		// Pretend the reserved round was armed, which is what spends the correction.
		const db = openWriteConnection(delivered.root);
		try {
			db.run("UPDATE task_corrections SET state = 'consumed' WHERE task_id = ?", [TASK]);
		} finally {
			closeQueueConnection(delivered.root, "write");
		}
		const second = await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		expect(second.kind).toBe("needs_human");
		if (second.kind === "needs_human") {
			expect(second.reason).toContain("one correction");
		}
	});

	it("refuses to correct an accepted round or a foreign session", async () => {
		const delivered = await deliveredRound();
		const accepted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("passed"), verdict: "accepted",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		if (accepted.kind !== "recorded") {
			throw new Error("review refused");
		}
		const reserved = await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId: accepted.review.reviewId });
		expect(reserved.kind).toBe("needs_human");

		const reviewId = await reviewedChanges(delivered);
		const foreign = await reserveTaskCorrection(delivered.root, { ...owner("gen-foreign"), sessionId: "omp-other" }, {
			taskId: TASK, reviewId,
		});
		expect(foreign.kind).toBe("needs_human");
	});

	it("keeps a valid plan valid and refuses one whose frozen bytes moved", async () => {
		const delivered = await deliveredRound();
		const reviewId = await reviewedChanges(delivered);
		const reserved = await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		if (reserved.kind !== "reserved") {
			throw new Error(`reservation refused: ${reserved.kind === "needs_human" ? reserved.reason : reserved.kind}`);
		}
		expect(await validateTaskCorrection(delivered.root, owner(), reserved.plan)).toEqual({ ok: true });

		await writeFile(delivered.artifact, "# Summary\n\ntotal: 3\n", "utf-8");
		const challenged = await validateTaskCorrection(delivered.root, owner(), reserved.plan);
		expect(challenged.ok).toBeFalse();
		if (!challenged.ok) {
			expect(challenged.reason).toContain("changed since the review");
		}
	});

	it("releases an unused reservation and refuses to release a consumed one", async () => {
		const delivered = await deliveredRound();
		const reviewId = await reviewedChanges(delivered);
		await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		expect(await releaseTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId })).toEqual({ kind: "released" });
		// A released reservation may be reserved again, because no round exists yet.
		expect((await reserveTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId })).kind).toBe("reserved");

		const db = openWriteConnection(delivered.root);
		try {
			db.run("UPDATE task_corrections SET state = 'consumed' WHERE task_id = ?", [TASK]);
		} finally {
			closeQueueConnection(delivered.root, "write");
		}
		const refused = await releaseTaskCorrection(delivered.root, owner(), { taskId: TASK, reviewId });
		expect(refused.kind).toBe("refused");
		if (refused.kind === "refused") {
			expect(refused.reason).toBe("already_consumed");
		}
	});
});

describe("the correction send fence", () => {
	/**
	 * The queue's arming fence is the last thing that can stop a correction: a rework
	 * round must not become `possibly_sent` unless the task's reservation is still
	 * `reserved` for exactly that review.
	 */
	it("refuses to arm a rework round without a live reservation, and arms it once reserved", async () => {
		const delivered = await deliveredRound();
		// A real review row, because the reservation's foreign key is not decorative.
		const submitted = await submitTaskReview(delivered.root, owner(), {
			taskId: TASK, round: 1, findings: findings("failed"), verdict: "changes_requested",
			artifacts: [{ path: delivered.artifact, sha256: delivered.artifactSha }],
		});
		if (submitted.kind !== "recorded") {
			throw new Error(`review refused: ${submitted.reason}`);
		}
		const reviewId = submitted.review.reviewId;
		const reworkRequest = "87654321-2222-4222-8222-876543218765";
		const goal: TaskGoal = { ...GOAL, context: "correction of the totals" };
		const target = { kind: "session" as const, sessionId: WB };
		const confirmation = {
			source: "host_dialog" as const,
			at: new Date().toISOString(),
			targetPolicy: target,
			requestId: reworkRequest,
			manifestSha256: buildConfirmationDigest({
				projectRoot: delivered.root,
				requestId: reworkRequest,
				taskId: TASK,
				round: 2,
				owner: owner(),
				goal,
				targetPolicy: target,
				expectedOutputs: ["summary.md"],
				inputs: [],
				deliveryMode: "foreground",
			}),
			owner: owner(),
			previousRound: 1,
			inputs: [],
			deliveryMode: "foreground" as const,
		};
		const staged = await stageTask(
			delivered.root, confirmation, { goal, inputFiles: [], expectedOutputs: ["summary.md"] }, TASK, 2,
		);

		const queue = openProjectQueue(delivered.root, { mode: "write" })!;
		let attemptId: string;
		let outcome: string;
		let afterReservation: string;
		try {
			queue.registerOwner(owner(), Date.now());
			queue.enqueue({
				taskId: TASK,
				round: 2,
				requestId: reworkRequest,
				manifestSha256: staged.manifestSha256,
				manifestPath: staged.manifestPath,
				snapshotRoot: staged.snapshotRoot,
				expectedPreviousRound: 1,
				readPaths: [],
				writePaths: [".wb-bridge/tasks"],
				targetPolicy: target,
				ownerSession: owner().sessionId,
				ownerGeneration: owner().generation,
				executorInstanceId: owner().instanceId,
				approval: { source: confirmation.source, at: confirmation.at, payloadSha256: staged.manifestSha256 },
				title: "correction",
				deliveryMode: "foreground",
				correctionOfReviewId: reviewId,
			});
			const claim = queue.claim(owner(), Date.now());
			expect(claim.kind).toBe("claimed");
			if (claim.kind !== "claimed") {
				return;
			}
			attemptId = claim.attemptId;
			const refused = queue.armPrompt({
				taskId: TASK, round: 2, attemptId, sessionId: WB,
				promptSha256: staged.manifestSha256, authorization: null, now: Date.now(),
			});
			outcome = refused.kind === "lost" ? refused.reason ?? "lost" : refused.kind;

			// The reservation is what licenses the send; without it the round stays unsent.
			const db = openWriteConnection(delivered.root);
			try {
				db.run(
					`INSERT INTO task_corrections(task_id, review_id, plan_json, state, created_at, updated_at)
					 VALUES(?, ?, '{"version":1}', 'reserved', ?, ?)`,
					[TASK, reviewId, Date.now(), Date.now()],
				);
			} finally {
				closeQueueConnection(delivered.root, "write");
			}
			// The reservation write closed its own handle; arming uses a fresh facade.
			const arming = openProjectQueue(delivered.root, { mode: "write" })!;
			try {
				const armed = arming.armPrompt({
					taskId: TASK, round: 2, attemptId, sessionId: WB,
					promptSha256: staged.manifestSha256, authorization: null, now: Date.now(),
				});
				afterReservation = armed.kind;
			} finally {
				arming.close();
			}
		} finally {
			queue.close();
		}
		expect(outcome).toBe("correction_not_reserved");
		expect(afterReservation).toBe("armed");
	});
});

/** The manifest payload shape a staged round carries, for the plan assertions. */
export type _PlanManifest = TaskManifestPayload;
void WB_ERROR_CODE;
