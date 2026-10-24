/**
 * Criterion-level review of a delegated round, and the single correction it may
 * authorize.
 *
 * The queue is the only authority: reviews live in its `reviews` table, the
 * frozen correction plan lives in `task_corrections`, and `armPrompt` consumes
 * that reservation in the same transaction that marks the round possibly sent.
 * Nothing here writes a second ledger.
 *
 * Two rules shape the whole module:
 *
 *  - A review describes exact bytes. It is stored forever, but it is only
 *    *effective* while those bytes are still on disk; a rewrite invalidates the
 *    verdict without deleting the history.
 *  - A task may spend one correction, once, and only one. The reservation is keyed
 *    by task and review, so a retry, a restart or a concurrent caller reaches the
 *    same frozen plan instead of creating another round.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { closeQueueConnection, isOwnerActive, openProjectQueue, openWriteConnection, withImmediate } from "./queue";
import {
	canonicalJson,
	computeFileSha256,
	parseRoundReceiptJson,
	readStagedManifest,
	resolveRoundPaths,
	uuid5,
	WbTaskError,
} from "./tasks";
import {
	WB_ERROR_CODE,
	type CorrectionPlan,
	type CorrectionReservation,
	type EffectiveTaskReview,
	type OwnerIdentity,
	type TaskReceiptV3,
	type TaskManifestPayload,
	type TaskReviewFinding,
	type TaskReviewRecord,
} from "./types";

/** Why a review submission was refused; the caller reports these verbatim. */
export type ReviewRefusal =
	| "round_not_found"
	| "round_not_committed"
	| "execution_not_ended"
	| "foreign_session"
	| "owner_not_active"
	| "review_incomplete"
	| "review_mismatched";

/** Input to {@link submitTaskReview}: findings authored by the reviewing OMP. */
export interface SubmitReviewInput {
	taskId: string;
	round: number;
	findings: TaskReviewFinding[];
	verdict: "accepted" | "changes_requested" | "unverified";
	/** Exact artifacts the reviewer opened, as project-relative or absolute paths. */
	artifacts: Array<{ path: string; sha256: string }>;
}

/** Outcome of submitting one review. */
export type ReviewSubmission =
	| { kind: "recorded"; review: TaskReviewRecord }
	| { kind: "refused"; reason: ReviewRefusal };

/** One round of the queue, as this module reads it. */
interface RoundFacts {
	requestId: string;
	round: number;
	ownerSession: string;
	outcome: { status: string; errorJson: string | null; summary?: string } | null;
	commitState: string;
	dispatchState: string;
	expectedOutputs: string[];
	manifestPath: string | null;
	manifestSha256: string | null;
	revision: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseOutcome(raw: unknown): RoundFacts["outcome"] {
	if (typeof raw !== "string") {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") {
			return null;
		}
		const record = parsed as Record<string, unknown>;
		return {
			status: typeof record["status"] === "string" ? record["status"] : "",
			errorJson: record["error"] === undefined || record["error"] === null ? null : JSON.stringify(record["error"]),
			summary: typeof record["summary"] === "string" ? record["summary"] : "",
		};
	} catch {
		return null;
	}
}

function roundFacts(row: Record<string, unknown> | null): RoundFacts | null {
	if (row === null) {
		return null;
	}
	const expected: string[] = [];
	return {
		requestId: typeof row["request_id"] === "string" ? row["request_id"] : "",
		round: Number(row["round"]),
		ownerSession: typeof row["owner_session"] === "string" ? row["owner_session"] : "",
		outcome: parseOutcome(row["outcome_json"]),
		commitState: typeof row["commit_state"] === "string" ? row["commit_state"] : "",
		dispatchState: typeof row["dispatch_state"] === "string" ? row["dispatch_state"] : "",
		expectedOutputs: expected,
		manifestPath: typeof row["manifest_path"] === "string" ? row["manifest_path"] : null,
		manifestSha256: typeof row["manifest_sha256"] === "string" ? row["manifest_sha256"] : null,
		revision: Number(row["revision"]),
	};
}

/** Rejects a finding the reviewer did not actually articulate. */
function findingIsComplete(finding: TaskReviewFinding): boolean {
	return (
		typeof finding.criterion === "string" && finding.criterion.trim().length > 0 &&
		(finding.status === "passed" || finding.status === "failed" || finding.status === "blocked") &&
		typeof finding.note === "string" && finding.note.trim().length > 0 &&
		Array.isArray(finding.evidence) && finding.evidence.length > 0 &&
		finding.evidence.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	);
}

/** Reads the newest review for a round, with its current-byte standing. */
export async function readEffectiveTaskReview(
	projectRoot: string,
	input: { taskId: string; round?: number },
): Promise<EffectiveTaskReview | null> {
	const db = openWriteConnection(projectRoot);
	let stored: {
		review_id: string;
		round: number;
		artifact_set_json: string;
		criteria_json: string;
		verdict: TaskReviewRecord["verdict"];
		reviewer_json: string;
		reviewed_at: number;
	} | null;
	try {
		stored = db
			.query(
				`SELECT review_id, round, artifact_set_json, criteria_json, verdict, reviewer_json, reviewed_at
				 FROM reviews WHERE task_id = ? AND parent_kind = 'delegated'
				   AND (? IS NULL OR round = ?)
				 ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`,
			)
			.get(input.taskId, input.round ?? null, input.round ?? null) as typeof stored;
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
	if (stored === null) {
		return null;
	}
	let reviewer: OwnerIdentity;
	let findings: TaskReviewFinding[];
	let artifacts: Array<{ path: string; sha256: string }>;
	try {
		reviewer = JSON.parse(stored.reviewer_json) as OwnerIdentity;
		findings = JSON.parse(stored.criteria_json) as TaskReviewFinding[];
		artifacts = JSON.parse(stored.artifact_set_json) as Array<{ path: string; sha256: string }>;
	} catch {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Review ${stored.review_id} is unreadable`);
	}
	const review: TaskReviewRecord = {
		reviewId: stored.review_id,
		taskId: input.taskId,
		round: stored.round,
		findings,
		verdict: stored.verdict,
		artifacts,
		reviewer,
		reviewedAt: stored.reviewed_at,
	};
	const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
	let invalidation: EffectiveTaskReview["invalidation"] = null;
	for (const artifact of artifacts) {
		const absolute = path.isAbsolute(artifact.path)
			? artifact.path
			: path.join(canonicalRoot, ...artifact.path.split("/"));
		const real = await realpath(absolute).catch(() => null);
		if (real === null) {
			invalidation = "artifact_missing";
			break;
		}
		const rel = path.relative(canonicalRoot, real);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			invalidation = "artifact_missing";
			break;
		}
		if ((await computeFileSha256(real)) !== artifact.sha256) {
			invalidation = "artifact_changed";
			break;
		}
	}
	return { review, effective: invalidation === null, invalidation };
}

/** All reviews of one task, newest first, exactly as recorded. */
export async function readTaskReviews(projectRoot: string, taskId: string): Promise<TaskReviewRecord[]> {
	const db = openWriteConnection(projectRoot);
	let rows: Array<Record<string, unknown>>;
	try {
		rows = db
			.query(
				`SELECT review_id, round, artifact_set_json, criteria_json, verdict, reviewer_json, reviewed_at
				 FROM reviews WHERE task_id = ? AND parent_kind = 'delegated'
				 ORDER BY reviewed_at DESC, rowid DESC`,
			)
			.all(taskId) as Array<Record<string, unknown>>;
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
	return rows.map((row) => ({
		reviewId: String(row["review_id"]),
		taskId,
		round: Number(row["round"]),
		findings: JSON.parse(String(row["criteria_json"])) as TaskReviewFinding[],
		verdict: String(row["verdict"]) as TaskReviewRecord["verdict"],
		artifacts: JSON.parse(String(row["artifact_set_json"])) as Array<{ path: string; sha256: string }>,
		reviewer: JSON.parse(String(row["reviewer_json"])) as OwnerIdentity,
		reviewedAt: Number(row["reviewed_at"]),
	}));
}

/**
 * Records the reviewing OMP's own criterion verdict.
 *
 * The review must describe the bytes that are actually on disk: each artifact is
 * rehashed here, so a stale hash or a missing file is refused instead of being
 * stored as a judgement of content nobody saw. Exactly the round's own criteria
 * are required, once each.
 */
export async function submitTaskReview(
	projectRoot: string,
	owner: OwnerIdentity,
	input: SubmitReviewInput,
): Promise<ReviewSubmission> {
	if (input.findings.length === 0 || !input.findings.every(findingIsComplete)) {
		return { kind: "refused", reason: "review_incomplete" };
	}
	const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
	const receiptPath = resolveRoundPaths(canonicalRoot, input.taskId, input.round, "round").receiptPath;

	// One synchronous snapshot of the row, then no handle is held across file IO.
	let facts: RoundFacts | null;
	const queue = openProjectQueue(projectRoot, { mode: "write" });
	if (queue === null) {
		return { kind: "refused", reason: "round_not_found" };
	}
	try {
		const row = queue.inspect({ taskId: input.taskId }).tasks.find((entry) => Number(entry["round"]) === input.round) ?? null;
		facts = roundFacts(row);
		if (facts === null) {
			return { kind: "refused", reason: "round_not_found" };
		}
		if (facts.ownerSession !== owner.sessionId) {
			return { kind: "refused", reason: "foreign_session" };
		}
		if (!isOwnerActive(openWriteConnection(projectRoot), owner)) {
			return { kind: "refused", reason: "owner_not_active" };
		}
		if (facts.commitState !== "committed") {
			return { kind: "refused", reason: "round_not_committed" };
		}
		// A possibly-sent execution has no proven end; judging its output as final
		// would treat work that may still be running as finished.
		if (facts.outcome === null || facts.dispatchState === "possibly_sent") {
			return { kind: "refused", reason: "execution_not_ended" };
		}
	} finally {
		queue.close();
	}

	const receiptText = await readFile(receiptPath, "utf-8").catch(() => null);
	if (receiptText === null) {
		return { kind: "refused", reason: "round_not_committed" };
	}
	let receipt: TaskReceiptV3;
	try {
		receipt = parseRoundReceiptJson(receiptText, receiptPath);
	} catch {
		return { kind: "refused", reason: "round_not_committed" };
	}
	const reviewedRound = receipt.rounds[0];
	if (reviewedRound === undefined || reviewedRound.requestId !== facts.requestId) {
		return { kind: "refused", reason: "review_mismatched" };
	}

	// The criteria are the human's, not the reviewer's: a review that invents or
	// drops one is judging a different task.
	const criteria = reviewedRound.goal.acceptance;
	if (
		input.findings.length !== criteria.length ||
		criteria.some((criterion) => input.findings.filter((finding) => finding.criterion === criterion).length !== 1)
	) {
		return { kind: "refused", reason: "review_incomplete" };
	}
	if (input.verdict === "accepted" && input.findings.some((finding) => finding.status !== "passed")) {
		return { kind: "refused", reason: "review_mismatched" };
	}
	if (input.verdict === "changes_requested" && !input.findings.some((finding) => finding.status === "failed")) {
		return { kind: "refused", reason: "review_mismatched" };
	}

	const outputsDir = resolveRoundPaths(canonicalRoot, input.taskId, input.round, "round").outputsDir;
	const recorded: Array<{ path: string; sha256: string }> = [];
	for (const artifact of input.artifacts) {
		const absolute = path.isAbsolute(artifact.path)
			? artifact.path
			: path.join(canonicalRoot, ...artifact.path.split("/"));
		const real = await realpath(absolute).catch(() => null);
		if (real === null) {
			return { kind: "refused", reason: "review_mismatched" };
		}
		const insideOutputs = path.relative(outputsDir, real);
		if (insideOutputs.startsWith("..") || path.isAbsolute(insideOutputs) || insideOutputs === "") {
			return { kind: "refused", reason: "review_mismatched" };
		}
		const info = await stat(real);
		if (!info.isFile()) {
			return { kind: "refused", reason: "review_mismatched" };
		}
		if ((await computeFileSha256(real)) !== artifact.sha256) {
			return { kind: "refused", reason: "review_mismatched" };
		}
		recorded.push({ path: path.relative(canonicalRoot, real).split(path.sep).join("/"), sha256: artifact.sha256 });
	}
	// Acceptance requires every declared deliverable to exist; a missing output is
	// a real defect, and the reviewer has to say so rather than pass the round.
	if (input.verdict === "accepted") {
		for (const expected of reviewedRound.expectedOutputs) {
			const expectedPath = path.join(outputsDir, ...expected.split("/"));
			const real = await realpath(expectedPath).catch(() => null);
			if (real === null) {
				return { kind: "refused", reason: "review_mismatched" };
			}
		}
	}

	const reviewId = uuid5(`omp-wb-bridge/review/${input.taskId}/${input.round}/${recorded.map((entry) => entry.sha256).join(",")}`);
	const reviewedAt = Date.now();
	const writeDb = openWriteConnection(projectRoot);
	try {
		withImmediate(writeDb, () => {
			writeDb.run(
				`INSERT OR REPLACE INTO reviews(review_id, parent_kind, task_id, round, parent_work_id,
					artifact_set_json, criteria_json, verdict, reviewer_json, reviewed_at)
				 VALUES(?, 'delegated', ?, ?, NULL, ?, ?, ?, ?, ?)`,
				[
					reviewId, input.taskId, input.round,
					canonicalJson(recorded), canonicalJson(input.findings), input.verdict,
					canonicalJson(owner), reviewedAt,
				],
			);
			writeDb.run(
				"UPDATE rounds SET review_state = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND round = ?",
				[input.verdict, reviewedAt, input.taskId, input.round],
			);
		});
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
	return {
		kind: "recorded",
		review: {
			reviewId,
			taskId: input.taskId,
			round: input.round,
			findings: input.findings,
			verdict: input.verdict,
			artifacts: recorded,
			reviewer: owner,
			reviewedAt,
		},
	};
}

/**
 * Reserves the task's one correction, freezing the plan that will be staged.
 *
 * The transaction checks every fact the correction depends on at once: the review
 * is the newest one and asks for changes, its round is committed with a proven
 * end, the originating session is the live one, and the task has not already
 * spent its correction. Freezing inside the transaction is what makes a retry,
 * a restart or a concurrent request reach the same plan instead of a second round.
 *
 * `releaseTaskCorrection` returns an unused reservation; a consumed one is never
 * refunded, because the round it armed may already have run.
 */
export async function reserveTaskCorrection(
	projectRoot: string,
	owner: OwnerIdentity,
	input: { taskId: string; reviewId: string },
): Promise<CorrectionReservation> {
	const needsHuman = (reason: string): CorrectionReservation => ({ kind: "needs_human", reason });

	/** Everything one reservation depends on, read in one synchronous pass. */
	interface Facts {
		reviewRound: number;
		findings: TaskReviewFinding[];
		artifacts: Array<{ path: string; sha256: string }>;
		base: RoundFacts;
		existingPlan: CorrectionPlan | null;
		existingState: "reserved" | "consumed" | "released" | null;
		reworkRound: number | null;
	}

	const inspect = (): { facts: Facts } | { refused: string } => {
		const db = openWriteConnection(projectRoot);
		try {
			if (!isOwnerActive(db, owner)) {
				return { refused: "the calling OMP session is not an active registration" };
			}
			const review = db
				.query(
					`SELECT round, artifact_set_json, criteria_json, verdict
					 FROM reviews WHERE review_id = ? AND task_id = ? AND parent_kind = 'delegated'`,
				)
				.get(input.reviewId, input.taskId) as
				| { round: number; artifact_set_json: string; criteria_json: string; verdict: string }
				| null;
			if (review === null) {
				return { refused: "that review does not belong to this task" };
			}
			const newest = db
				.query(
					`SELECT review_id FROM reviews WHERE task_id = ? AND parent_kind = 'delegated'
					 ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`,
				)
				.get(input.taskId) as { review_id: string } | null;
			if (newest?.review_id !== input.reviewId) {
				return { refused: "a newer review of this task exists; correct from the newest one" };
			}
			if (review.verdict !== "changes_requested") {
				return { refused: `the review verdict is ${review.verdict}; only changes_requested may be corrected` };
			}
			const rows = db
				.query("SELECT * FROM rounds WHERE task_id = ? ORDER BY round DESC")
				.all(input.taskId) as Array<Record<string, unknown>>;
			const base = roundFacts(rows.find((row) => Number(row["round"]) === review.round) ?? null);
			if (base === null) {
				return { refused: "the reviewed round is missing from the queue" };
			}
			if (base.commitState !== "committed" || base.outcome === null || base.dispatchState === "possibly_sent") {
				return { refused: "the reviewed round has no committed result with a proven execution end" };
			}
			if (base.ownerSession !== owner.sessionId) {
				return { refused: "only the originating OMP session may correct this task" };
			}
			if (base.manifestPath === null || base.manifestSha256 === null) {
				return { refused: "the reviewed round has no approved manifest to continue" };
			}
			const correction = db
				.query("SELECT plan_json, state FROM task_corrections WHERE task_id = ?")
				.get(input.taskId) as { plan_json: string; state: "reserved" | "consumed" | "released" } | null;
			const reworkRow = rows.find((row) => row["purpose"] === "rework");
			return {
				facts: {
					reviewRound: review.round,
					findings: JSON.parse(review.criteria_json) as TaskReviewFinding[],
					artifacts: JSON.parse(review.artifact_set_json) as Array<{ path: string; sha256: string }>,
					base,
					existingPlan: correction === null ? null : parseCorrectionPlan(correction.plan_json),
					existingState: correction?.state ?? null,
					reworkRound: reworkRow === undefined ? null : Number(reworkRow["round"]),
				},
			};
		} finally {
			closeQueueConnection(projectRoot, "write");
		}
	};

	const first = inspect();
	if ("refused" in first) {
		return needsHuman(first.refused);
	}
	const facts = first.facts;

	// A rework round already exists: recovering it is the only way to avoid a second
	// dispatch, so the frozen plan for exactly that round is returned verbatim.
	if (facts.reworkRound !== null) {
		if (facts.existingState === "reserved" && facts.existingPlan !== null &&
			facts.existingPlan.targetRound === facts.reworkRound && facts.existingPlan.reviewId === input.reviewId) {
			return { kind: "existing", plan: facts.existingPlan };
		}
		return needsHuman(
			facts.existingState === "consumed"
				? "this task already spent its one correction"
				: `a rework round (${facts.reworkRound}) already exists for this task; recover it instead of correcting again`,
		);
	}
	if (facts.existingState === "consumed") {
		return needsHuman("this task already spent its one correction");
	}
	// A reservation already exists but no round was staged yet: the frozen plan is
	// returned verbatim — after revalidation, because the materials may have moved —
	// so a retry can never freeze a second plan for the same review.
	if (facts.existingState === "reserved" && facts.existingPlan !== null) {
		if (facts.existingPlan.reviewId !== input.reviewId) {
			return needsHuman("a different correction is already reserved for this task");
		}
		const usable = await validateTaskCorrection(projectRoot, owner, facts.existingPlan);
		return usable.ok
			? { kind: "existing", plan: facts.existingPlan }
			: needsHuman(`the reserved correction is no longer valid: ${usable.reason}`);
	}

	// The goal and approved outputs live in the staged manifest, which is file IO, so
	// it is read after the handle is released and re-verified against the queue digest.
	let staged: Awaited<ReturnType<typeof readStagedManifest>>;
	try {
		staged = await readStagedManifest(path.dirname(facts.base.manifestPath!));
	} catch (error) {
		return needsHuman(`the approved manifest of the reviewed round cannot be read: ${messageOf(error)}`);
	}
	if (staged.manifestSha256 !== facts.base.manifestSha256) {
		return needsHuman("the approved manifest no longer matches the digest the queue recorded");
	}
	const payload = staged.manifest.payload;
	if (payload.taskId !== input.taskId || payload.round !== facts.reviewRound || payload.requestId !== facts.base.requestId) {
		return needsHuman("the approved manifest describes a different round or request");
	}
	// Replaying an external side effect is not a quality correction; that is a new
	// human decision at the point of risk, so it is never taken automatically.
	if (payload.goal.externalActions.length > 0) {
		return needsHuman(
			"the original task approved external actions; a correction would replay them, so a new exact authorization is required",
		);
	}
	const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
	if ((await realpath(payload.projectRoot).catch(() => payload.projectRoot)) !== canonicalRoot) {
		return needsHuman("the approved manifest belongs to a different project root");
	}
	const plan = buildCorrectionPlan({
		taskId: input.taskId,
		reviewId: input.reviewId,
		baseRound: facts.reviewRound,
		payload,
		reviewArtifacts: facts.artifacts,
		findings: facts.findings,
		baseAuthorization: {
			requestId: facts.base.requestId,
			manifestSha256: facts.base.manifestSha256 ?? "",
			source: staged.manifest.approval.source,
			at: staged.manifest.approval.at,
			ownerSession: facts.base.ownerSession,
		},
	});

	// Re-check under the write lock: the review, the rework round and the reservation
	// must all still be exactly what the plan was built from.
	const second = inspect();
	if ("refused" in second) {
		return needsHuman(second.refused);
	}
	const confirm = second.facts;
	if (
		confirm.reworkRound !== null || confirm.existingState === "consumed" ||
		confirm.reviewRound !== facts.reviewRound || confirm.base.requestId !== facts.base.requestId ||
		confirm.existingState === "reserved"
	) {
		return needsHuman("this task's correction state changed while the plan was being frozen; re-read it and retry once");
	}
	const db = openWriteConnection(projectRoot);
	try {
		withImmediate(db, () => {
			db.run(
				`INSERT INTO task_corrections(task_id, review_id, plan_json, state, created_at, updated_at)
				 VALUES(?, ?, ?, 'reserved', ?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET review_id = excluded.review_id,
					plan_json = excluded.plan_json, state = 'reserved', created_at = excluded.created_at,
					updated_at = excluded.updated_at`,
				[input.taskId, input.reviewId, canonicalJson(plan), Date.now(), Date.now()],
			);
		});
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
	return { kind: "reserved", plan };
}

/** Parses a frozen plan; a corrupt plan is refused rather than half-used. */
function parseCorrectionPlan(raw: string): CorrectionPlan | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") {
			return null;
		}
		const plan = parsed as CorrectionPlan;
		return plan.version === 1 && typeof plan.requestId === "string" ? plan : null;
	} catch {
		return null;
	}
}

/**
 * Builds the frozen plan from the reviewed round and its findings.
 *
 * The next round repeats the original goal exactly: same objective, constraints,
 * acceptance criteria and external actions. Only the context gains the defect
 * findings, and the inputs gain the reviewed outputs, so a correction works from
 * frozen materials instead of arbitrary feedback.
 */
function buildCorrectionPlan(input: {
	taskId: string;
	reviewId: string;
	baseRound: number;
	payload: TaskManifestPayload;
	reviewArtifacts: Array<{ path: string; sha256: string }>;
	findings: TaskReviewFinding[];
	baseAuthorization: CorrectionPlan["baseAuthorization"];
}): CorrectionPlan {
	const failedCriteria = input.findings.filter((finding) => finding.status === "failed");
	const goal = input.payload.goal;
	const context = [
		goal.context,
		"The previous round did not meet these acceptance criteria. Correct exactly these defects; keep the objective, constraints and outputs otherwise unchanged:",
		...failedCriteria.map((finding) => `- ${finding.criterion}: ${finding.note}`),
	]
		.filter((line) => line.trim().length > 0)
		.join("\n");
	const inputs = [
		...input.payload.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
		...input.reviewArtifacts,
	];
	return {
		version: 1,
		taskId: input.taskId,
		reviewId: input.reviewId,
		baseRound: input.baseRound,
		targetRound: input.baseRound + 1,
		// Deterministic, so a retry cannot create a second round for the same review.
		requestId: uuid5(`omp-wb-bridge/correction/${input.taskId}/${input.reviewId}`),
		request: {
			goal: {
				objective: goal.objective,
				context,
				constraints: [...goal.constraints],
				acceptance: [...goal.acceptance],
				externalActions: [...goal.externalActions],
			},
			expectedOutputs: [...input.payload.expectedOutputs],
			taskId: input.taskId,
		},
		inputs,
		baseAuthorization: input.baseAuthorization,
		failedCriteria,
	};
}

/** Returns an unused reservation; a consumed one is never refunded. */
export async function releaseTaskCorrection(
	projectRoot: string,
	owner: OwnerIdentity,
	input: { taskId: string; reviewId: string },
): Promise<{ kind: "released" | "refused"; reason?: string }> {
	const db = openWriteConnection(projectRoot);
	try {
		if (!isOwnerActive(db, owner)) {
			return { kind: "refused", reason: "owner_not_active" };
		}
		const row = db
			.query("SELECT review_id, state FROM task_corrections WHERE task_id = ?")
			.get(input.taskId) as { review_id: string; state: string } | null;
		if (row === null || row.review_id !== input.reviewId) {
			return { kind: "refused", reason: "no_such_reservation" };
		}
		if (row.state === "consumed") {
			return { kind: "refused", reason: "already_consumed" };
		}
		if (row.state === "released") {
			return { kind: "released" };
		}
		const rework = db
			.query("SELECT 1 FROM rounds WHERE task_id = ? AND purpose = 'rework' LIMIT 1")
			.get(input.taskId);
		if (rework !== null) {
			return { kind: "refused", reason: "rework_round_exists" };
		}
		db.run(
			"UPDATE task_corrections SET state = 'released', updated_at = ? WHERE task_id = ? AND review_id = ? AND state = 'reserved'",
			[Date.now(), input.taskId, input.reviewId],
		);
		return { kind: "released" };
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
}

/** Why a frozen correction plan may not be staged or sent right now. */
export type CorrectionValidation =
	| { ok: true }
	| { ok: false; reason: string };

/**
 * Re-validates a frozen correction plan against current evidence.
 *
 * Called twice on purpose: before staging and again immediately before the send
 * fence (including a queued resume), because the materials or the authorization can
 * change in between. A plan whose reviewed bytes, base approval or reservation are
 * no longer exactly what it froze is refused — never silently re-staged.
 */
export async function validateTaskCorrection(
	projectRoot: string,
	owner: OwnerIdentity,
	plan: CorrectionPlan,
): Promise<CorrectionValidation> {
	const db = openWriteConnection(projectRoot);
	let state: string | null;
	let storedPlan: string | null;
	let baseManifestSha: string | null;
	let baseOwnerSession: string | null;
	try {
		if (!isOwnerActive(db, owner)) {
			return { ok: false, reason: "the calling OMP session is not an active registration" };
		}
		const correction = db
			.query("SELECT plan_json, state FROM task_corrections WHERE task_id = ? AND review_id = ?")
			.get(plan.taskId, plan.reviewId) as { plan_json: string; state: string } | null;
		state = correction?.state ?? null;
		storedPlan = correction?.plan_json ?? null;
		const base = db
			.query(
				`SELECT manifest_sha256, owner_session FROM rounds WHERE task_id = ? AND round = ?`,
			)
			.get(plan.taskId, plan.baseRound) as { manifest_sha256: string | null; owner_session: string | null } | null;
		baseManifestSha = base?.manifest_sha256 ?? null;
		baseOwnerSession = base?.owner_session ?? null;
	} finally {
		closeQueueConnection(projectRoot, "write");
	}
	if (state !== "reserved") {
		return { ok: false, reason: `the correction reservation is ${state ?? "missing"}, not reserved` };
	}
	if (storedPlan === null || canonicalJson(parseCorrectionPlan(storedPlan)) !== canonicalJson(plan)) {
		return { ok: false, reason: "the frozen plan no longer matches the reservation" };
	}
	if (baseOwnerSession !== owner.sessionId) {
		return { ok: false, reason: "only the originating OMP session may continue this correction" };
	}
	if (baseManifestSha === null || baseManifestSha !== plan.baseAuthorization.manifestSha256) {
		return { ok: false, reason: "the original approval this correction continues has changed" };
	}

	// Current bytes of every frozen input, including the reviewed outputs.
	const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
	for (const entry of plan.inputs) {
		const absolute = path.join(canonicalRoot, ...entry.path.split("/"));
		const real = await realpath(absolute).catch(() => null);
		if (real === null) {
			return { ok: false, reason: `frozen input ${entry.path} is no longer present` };
		}
		const rel = path.relative(canonicalRoot, real);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			return { ok: false, reason: `frozen input ${entry.path} resolves outside the project` };
		}
		if ((await computeFileSha256(real)) !== entry.sha256) {
			return { ok: false, reason: `frozen input ${entry.path} changed since the review was recorded` };
		}
	}
	return { ok: true };
}
