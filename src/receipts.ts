/**
 * Receipt persistence and repair.
 *
 * The queue decides *what* happened and whether resources may be released; this
 * module is the only place that turns that decision into receipt bytes and asks the
 * queue to confirm them. Both paths — the normal terminal commit and recovery after
 * a failed receipt write — go through {@link commitDurableRound}, so the digest
 * fence, the first-outcome rule and the release rule cannot drift apart.
 */
import crypto from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
	closeQueueConnection,
	isOwnerActive,
	openProjectQueue,
	openReadConnection,
	openWriteConnection,
	sameRecoverySubject,
	verifyOperatorRecovery,
} from "./queue";
import {
	canonicalJson,
	parseRoundReceiptJson,
	readStagedManifest,
	resolveRoundPaths,
	writeRoundReceipt,
} from "./tasks";
import {
	WB_ERROR_CODE,
	type DurableCommitInput,
	type DurableCommitResult,
	type OperatorRecoveryAuthorization,
	type OwnerDeathProof,
	type OwnerIdentity,
	type RecoveryConsent,
	type RecoverySubject,
	type StagedTask,
	type TaskError,
	type TaskManifestPayload,
	type TaskReceiptV3,
	type TaskRoundV3,
} from "./types";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The outcome the queue recorded first, as read back from the round row. */
export interface StoredOutcome {
	status: "completed" | "failed" | "cancelled" | "interrupted";
	error: TaskError | null;
	summary: string;
	artifacts: TaskRoundV3["artifacts"];
}

/** One round's immutable evidence, snapshotted while the handle is still open. */
export interface RepairSubject {
	round: number;
	requestId: string;
	manifestPath: string;
	manifestSha256: string;
	/** True only when the prompt provably never left, so a commit may release. */
	notSent: boolean;
	/**
	 * The concrete WorkBuddy session this round was selected to run on.
	 *
	 * It is read from the queue's own row rather than from the approved manifest:
	 * a round authorized against the project's pool names no session in its
	 * manifest, and the session the queue actually selected is the one the
	 * receipt has to name.
	 */
	selectedSession: string | null;
}

/** Input to {@link repairRoundReceipt}; the business outcome is never supplied. */
export interface RepairRoundInput {
	taskId: string;
	/** Exact round; when omitted the newest repairable round is chosen. */
	round?: number;
	/** Ephemeral cancellation of an originating-session repair. */
	signal?: AbortSignal;
}

/**
 * What one operator recovery found, before anybody was asked anything.
 *
 * It carries the frozen subject the human will be shown, the original owner
 * unchanged, the proof that the original owner is gone, and the evidence the
 * receipt will be rebuilt from. It is a snapshot: reading it changes nothing.
 */
export interface OperatorRecoveryTarget {
	kind: "target";
	round: number;
	/** The original owner of the round, exactly as the queue recorded it. */
	originalOwner: OwnerIdentity;
	/** The fresh proof that the original owner's process is gone. */
	deathProof: OwnerDeathProof;
	/** The exact subject the human's consent must cover. */
	subject: RecoverySubject;
	/** The recorded first business outcome, as the queue holds it. */
	outcome: StoredOutcome;
	/** The evidence the receipt is rebuilt from. */
	evidence: RepairSubject;
}

/** What one operator-recovery lookup found. */
export type OperatorRecoveryLookup =
	| OperatorRecoveryTarget
	| { kind: "refused"; round: number | null; reason: string };

/** What one repair did. */
export type RepairRoundOutcome =
	| {
			kind: "repaired";
			taskId: string;
			round: number;
			receiptSha256: string;
			/** True when the commit released the round; false while quarantined. */
			released: boolean;
	  }
	| { kind: "refused"; taskId: string; round: number | null; reason: string };

/** A failed receipt must never replace the business result already recorded. */
function recordCommitFailureById(projectRoot: string, taskId: string, round: number, reason: string): void {
	const queue = openProjectQueue(projectRoot, { mode: "write" });
	if (queue === null) {
		return;
	}
	try {
		queue.commitFailed({
			taskId,
			round,
			errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }),
			now: Date.now(),
		});
	} finally {
		queue.close();
	}
}

/**
 * Commits one finished round to the queue: first outcome, commit fence, receipt
 * proof, resource release.
 *
 * Order is the whole point. The outcome is recorded first, because the first
 * observed terminal state wins and a later cancellation must join it rather than
 * replace it. The receipt's digest is then verified against the row's revision
 * fence. Only a confirmed commit releases the round's resources.
 */
export async function commitDurableRound(input: DurableCommitInput): Promise<DurableCommitResult> {
	if (input.signal?.aborted) {
		return { committed: false, reason: "The recovery operation was cancelled" };
	}
	// Every queue scope in this function is synchronous and closed before the
	// next one opens. A cached connection is not a lease: it is shared by every
	// handle of the project, so holding one across an `await` — or closing one
	// while a sibling task of the same project is inside its own scope — takes
	// the connection away from that task mid-commit.
	//
	// The shape is therefore always: open, read or write synchronously, close,
	// then await. Two delegations in one project commit concurrently, and each
	// of them owns its own scope.
	let queue;
	try {
		queue = openProjectQueue(input.projectRoot, { mode: "write" });
	} catch (err: unknown) {
		return { committed: false, reason: messageOf(err) };
	}
	if (queue === null) {
		return {
			committed: false,
			reason: `Project state is not available for ${input.projectRoot}; the receipt was written but not confirmed`,
		};
	}
	try {
		const terminal = queue.beginTerminal({
			taskId: input.taskId,
			round: input.round,
			outcome: {
				status: input.status,
				errorJson: input.error === null ? null : JSON.stringify(input.error),
				outcomeJson: JSON.stringify({ status: input.status, error: input.error }),
			},
			now: Date.now(),
		});
		if (terminal.kind === "unchanged" && terminal.status !== input.status) {
			// The queue already holds a different terminal state; the receipt must
			// describe that one, so this commit is abandoned rather than overwriting it.
			return {
				committed: false,
				reason: `The queue recorded ${terminal.status} for this round before ${input.status} was committed`,
			};
		}
	} finally {
		// The first scope ends before the file read: the receipt is read back
		// from disk, and nothing may hold the project's connection across that
		// await.
		queue.close();
		queue = null;
	}
	// Read the receipt back before committing: the digest must describe the bytes
	// that are actually on disk, not the ones the writer meant to write. Otherwise
	// the fence would certify an intention.
	const receiptPath = resolveRoundPaths(input.projectRoot, input.taskId, input.round, "round").receiptPath;
	let onDisk: string;
	try {
		onDisk = await readFile(receiptPath, "utf-8");
	} catch (err: unknown) {
		if (input.signal?.aborted) {
			return { committed: false, reason: "The recovery operation was cancelled" };
		}
		const reason = `The receipt at ${receiptPath} could not be read back: ${messageOf(err)}`;
		// Nothing is on disk to certify, so nothing may be released — but the round
		// records the failure instead of idling as `pending`.
		recordCommitFailureById(input.projectRoot, input.taskId, input.round, reason);
		return { committed: false, reason };
	}
	if (input.signal?.aborted) {
		return { committed: false, reason: "The recovery operation was cancelled" };
	}
	// A fresh facade for the confirmation scope. The first one is closed, so
	// this is a new handle rather than a resumed one.
	try {
		queue = openProjectQueue(input.projectRoot, { mode: "write" });
	} catch (err: unknown) {
		return { committed: false, reason: messageOf(err) };
	}
	if (queue === null) {
		return { committed: false, reason: "The project queue is unavailable after receipt verification" };
	}
	try {
		const onDiskDigest = crypto.createHash("sha256").update(onDisk, "utf-8").digest("hex");
		if (onDiskDigest !== input.receiptSha256) {
			const reason = `The receipt at ${receiptPath} does not match the committed bytes (on disk ${onDiskDigest}, expected ${input.receiptSha256})`;
			// Record the failure where the round lives: a refusal that leaves the row
			// looking merely pending would hide a missing or corrupted receipt behind a
			// state that reads as "still working".
			queue.commitFailed({
				taskId: input.taskId,
				round: input.round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }),
				now: Date.now(),
			});
			return { committed: false, reason };
		}
		let receipt: TaskReceiptV3;
		try {
			receipt = parseRoundReceiptJson(onDisk, receiptPath);
		} catch (error) {
			const reason = `The receipt cannot be validated: ${messageOf(error)}`;
			queue.commitFailed({
				taskId: input.taskId, round: input.round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }), now: Date.now(),
			});
			return { committed: false, reason };
		}
		const row = queue.inspect({ taskId: input.taskId }).tasks.find((candidate) => Number(candidate["round"]) === input.round);
		const recordedRound = receipt.rounds[0];
		if (
			row === undefined || receipt.taskId !== input.taskId || receipt.projectRoot !== input.projectRoot ||
			receipt.rounds.length !== 1 || recordedRound?.number !== input.round ||
			recordedRound.requestId !== input.requestId || recordedRound.status !== input.status ||
			canonicalJson(recordedRound.error) !== canonicalJson(input.error)
		) {
			const reason = "The receipt does not describe this round's first business result";
			queue.commitFailed({
				taskId: input.taskId, round: input.round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }), now: Date.now(),
			});
			return { committed: false, reason };
		}
		const resultRevision = Number(row["revision"]);
		// The authorization is the commit's own gate, enforced inside the queue's
		// transaction. An ordinary terminal commit is authorized by the round's own
		// owner row and needs no extra grant; a recovery of somebody else's round
		// carries its own explicit authorization, which the queue verifies in the
		// same transaction that commits the receipt.
		const confirmed = queue.confirmReceipt({
			taskId: input.taskId,
			round: input.round,
			receiptSha256: input.receiptSha256,
			commitToken: { requestId: input.requestId, resultRevision },
			authorization: input.authorization,
			now: Date.now(),
		});
		if (confirmed.kind !== "committed") {
			// An authorization refusal is not a storage failure. The round's own
			// recorded failure is evidence and stays as it is; overwriting it with
			// "the operator's grant was refused" would replace the reason the round
			// needs recovery in the first place.
			if (input.authorization === undefined) {
				queue.commitFailed({
					taskId: input.taskId,
					round: input.round,
					errorJson: JSON.stringify({
						code: WB_ERROR_CODE.storageError,
						message: confirmed.reason ?? "the receipt could not be confirmed",
					}),
					now: Date.now(),
				});
			}
			return { committed: false, reason: confirmed.reason ?? "the receipt could not be confirmed" };
		}
		return { committed: true, reason: null };
	} finally {
		// The confirmation scope ends here, before anything else is awaited.
		queue?.close();
	}
}

/** Parses the recorded outcome strictly: an unknown shape is refused, never guessed. */
function parseStoredOutcome(raw: unknown): StoredOutcome | null {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (value === null || typeof value !== "object") {
		return null;
	}
	const record = value as Record<string, unknown>;
	const status = record["status"];
	if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "interrupted") {
		return null;
	}
	const rawError = record["error"];
	const parsedError: TaskError | null =
		rawError !== null && typeof rawError === "object" &&
		typeof (rawError as Record<string, unknown>)["code"] === "string" &&
		typeof (rawError as Record<string, unknown>)["message"] === "string"
			? {
					code: (rawError as Record<string, unknown>)["code"] as string,
					message: (rawError as Record<string, unknown>)["message"] as string,
				}
			: null;
	const artifacts = Array.isArray(record["artifacts"]) ? (record["artifacts"] as TaskRoundV3["artifacts"]) : [];
	return {
		status,
		error: parsedError,
		summary: typeof record["summary"] === "string" ? record["summary"] : "",
		artifacts,
	};
}

/** Reads a repair target without holding a cached handle across any await. */
function readRepairSubject(projectRoot: string, owner: OwnerIdentity, input: RepairRoundInput):
	| { kind: "subject"; subject: RepairSubject; outcome: StoredOutcome }
	| { kind: "refused"; round: number | null; reason: string } {
	const queue = openProjectQueue(projectRoot, { mode: "write" });
	if (queue === null) {
		return { kind: "refused", round: input.round ?? null, reason: "project state is unavailable" };
	}
	try {
		const rows = queue.inspect({ taskId: input.taskId }).tasks.filter(
			(row) => input.round === undefined || Number(row["round"]) === input.round,
		);
		const row = rows[rows.length - 1];
		if (row === undefined) {
			return { kind: "refused", round: input.round ?? null, reason: "no such round for this task" };
		}
		const round = Number(row["round"]);
		if (row["outcome_json"] === null) {
			return { kind: "refused", round, reason: "this round has no recorded first outcome to rebuild" };
		}
		if (row["commit_state"] === "committed") {
			return { kind: "refused", round, reason: "the receipt for this round is already committed" };
		}
		if (row["owner_session"] !== owner.sessionId) {
			return { kind: "refused", round, reason: "only the originating OMP session may repair this receipt" };
		}
		if (!isOwnerActive(openWriteConnection(projectRoot), owner)) {
			return { kind: "refused", round, reason: "the originating OMP identity is not an active registration" };
		}
		const outcome = parseStoredOutcome(row["outcome_json"]);
		if (outcome === null) {
			return { kind: "refused", round, reason: "the recorded first outcome is unreadable" };
		}
		const manifestPath = row["manifest_path"];
		const manifestSha256 = row["manifest_sha256"];
		const requestId = row["request_id"];
		if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string" || typeof requestId !== "string") {
			return { kind: "refused", round, reason: "the approved manifest references are missing" };
		}
		return {
			kind: "subject",
			outcome,
			subject: {
				round,
				requestId,
				manifestPath,
				manifestSha256,
				notSent: row["dispatch_state"] === "not_sent",
				// The session the queue selected is the round's real target. For a
				// pool round it is the only place that target exists: the approved
				// manifest names the policy, not the session.
				selectedSession:
					typeof row["selected_session"] === "string" && row["selected_session"].length > 0
						? row["selected_session"]
						: null,
			},
		};
	} finally {
		queue.close();
	}
}

/**
 * Reads a recovery target for an operator who is *not* the original owner.
 *
 * The difference from {@link readRepairSubject} is the authorization, not the
 * evidence: the same frozen facts are read, but the original owner may be a
 * different identity, and that identity has to be provably gone before a
 * different human may act on its round.
 *
 * Nothing is written here. The caller freezes the subject, asks the human,
 * and the queue verifies everything again inside the commit transaction.
 */
export function readOperatorRecoveryTarget(
	projectRoot: string,
	operator: OwnerIdentity,
	input: RepairRoundInput,
): OperatorRecoveryLookup {
	const queue = openProjectQueue(projectRoot, { mode: "read" });
	if (queue === null) {
		return { kind: "refused", round: input.round ?? null, reason: "project state is unavailable" };
	}
	try {
		// The operator must be a live registration of this project: an operator
		// that cannot be identified is not one.
		const db = openReadConnection(projectRoot);
		if (db === null || !isOwnerActive(db, operator)) {
			return { kind: "refused", round: input.round ?? null, reason: "the recovering operator is not an active registration" };
		}
		const rows = queue.inspect({ taskId: input.taskId }).tasks.filter(
			(row) => input.round === undefined || Number(row["round"]) === input.round,
		);
		const row = rows[rows.length - 1];
		if (row === undefined) {
			return { kind: "refused", round: input.round ?? null, reason: "no such round for this task" };
		}
		const round = Number(row["round"]);
		if (row["outcome_json"] === null) {
			return { kind: "refused", round, reason: "this round has no recorded first outcome to rebuild" };
		}
		if (row["commit_state"] === "committed") {
			return { kind: "refused", round, reason: "the receipt for this round is already committed" };
		}
		const ownerSession = row["owner_session"];
		const ownerGeneration = row["owner_generation"];
		const executorInstance = row["executor_instance"];
		if (
			typeof ownerSession !== "string" || ownerSession.length === 0 ||
			typeof ownerGeneration !== "string" || ownerGeneration.length === 0 ||
			typeof executorInstance !== "string" || executorInstance.length === 0
		) {
			return { kind: "refused", round, reason: "this round has no recorded original owner" };
		}
		// The operator may not be the original owner: that is the ordinary path
		// and it needs no recovery grant.
		if (ownerSession === operator.sessionId && ownerGeneration === operator.generation) {
			return { kind: "refused", round, reason: "the recovering operator is the original owner of this round" };
		}
		const originalOwner: OwnerIdentity = {
			sessionId: ownerSession,
			generation: ownerGeneration,
			instanceId: executorInstance,
			processId: 0,
		};
		// The death proof is taken fresh, from the OS, right now. A database row
		// that says "inactive" is a declaration; only the OS can prove the
		// process is gone.
		const death = queue.proveOwnerDead(
			{ sessionId: ownerSession, generation: ownerGeneration, instanceId: executorInstance },
			Date.now(),
		);
		if (!death.ok) {
			return { kind: "refused", round, reason: `the original owner is not provably gone: ${death.reason}` };
		}
		// The subject is frozen from the queue's own rows, in the same scope.
		const subject = queue.recoverySubject(input.taskId, round);
		if (subject === null) {
			return { kind: "refused", round, reason: "this round has no recorded first outcome to rebuild" };
		}
		const outcome = parseStoredOutcome(row["outcome_json"]);
		if (outcome === null) {
			return { kind: "refused", round, reason: "the recorded first outcome is unreadable" };
		}
		const manifestPath = row["manifest_path"];
		const manifestSha256 = row["manifest_sha256"];
		const requestId = row["request_id"];
		if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string" || typeof requestId !== "string") {
			return { kind: "refused", round, reason: "the approved manifest references are missing" };
		}
		return {
			kind: "target",
			round,
			originalOwner: { ...originalOwner, processId: death.proof.processId },
			deathProof: death.proof,
			subject,
			outcome,
			evidence: {
				round,
				requestId,
				manifestPath,
				manifestSha256,
				notSent: row["dispatch_state"] === "not_sent",
				selectedSession:
					typeof row["selected_session"] === "string" && row["selected_session"].length > 0
						? row["selected_session"]
						: null,
			},
		};
	} finally {
		queue.close();
	}
}

/**
 * Rebuilds (or reuses) the receipt bytes for one round from frozen evidence.
 *
 * The receipt is a pure function of the approved manifest and the recorded
 * first outcome. It never contains the recovering operator: the receipt
 * describes the *execution*, and the execution belonged to the original owner.
 * Who performed the recovery is recorded in the queue's own audit column, in
 * the same transaction that commits the receipt.
 *
 * An existing receipt is reused only when it describes exactly this evidence.
 * A substituted receipt — one that names another owner, another session, other
 * approved material or a different outcome — is refused rather than blessed.
 */
async function rebuildRoundReceipt(input: {
	projectRoot: string;
	taskId: string;
	/** The evidence the receipt is rebuilt from. */
	subject: RepairSubject;
	outcome: StoredOutcome;
	writeReceipt: typeof writeRoundReceipt;
	signal?: AbortSignal;
}): Promise<{ kind: "built"; sha256: string; payload: TaskManifestPayload } | { kind: "refused" | "write_failed"; reason: string }> {
	const { projectRoot, taskId, subject, outcome, signal } = input;
	if (signal?.aborted) {
		return { kind: "refused", reason: "The recovery operation was cancelled" };
	}
	let staged: StagedTask;
	try {
		staged = await readStagedManifest(path.dirname(subject.manifestPath));
	} catch (error) {
		return { kind: "refused", reason: `the approved manifest cannot be read: ${messageOf(error)}` };
	}
	if (signal?.aborted) {
		return { kind: "refused", reason: "The recovery operation was cancelled" };
	}
	let payload: TaskManifestPayload;
	try {
		// The queue's digest is the one the human approved; a manifest that hashes to
		// itself but not to that value is a substituted payload, not a repair target.
		if (staged.manifestSha256 !== subject.manifestSha256) {
			return { kind: "refused", reason: "the staged manifest does not match the digest the queue approved" };
		}
		payload = staged.manifest.payload;
		if (payload.taskId !== taskId || payload.round !== subject.round || payload.requestId !== subject.requestId) {
			return { kind: "refused", reason: "the manifest describes a different round or request" };
		}
		if ((await canonicalRootOf(payload.projectRoot)) !== (await canonicalRootOf(projectRoot))) {
			return { kind: "refused", reason: "the manifest was approved for a different project root" };
		}
		if (payload.targetPolicy.kind === "session" && payload.targetPolicy.sessionId.length === 0) {
			return { kind: "refused", reason: "the approved manifest has no fixed execution target" };
		}
	} catch (error) {
		return { kind: "refused", reason: `the approved manifest cannot be validated: ${messageOf(error)}` };
	}
	if (signal?.aborted) {
		return { kind: "refused", reason: "The recovery operation was cancelled" };
	}

	// The receipt names the session the round actually ran on. A round that was
	// authorized against the project's pool has no session in its manifest, and
	// the queue's selection is the only evidence of the one it used. A round that
	// never selected one — it never reached a claim — has no session to name and
	// is refused rather than given an invented one.
	const targetSession = subject.selectedSession;
	if (targetSession === null) {
		return { kind: "refused", reason: "this round has no recorded WorkBuddy session to describe" };
	}

	const paths = resolveRoundPaths(projectRoot, taskId, subject.round, "round");
	// A receipt may already exist: the write succeeded and only the commit failed, or
	// a previous attempt left one behind. Reusing it is the only safe option — a
	// second write would rewrite history — but only if it describes this round's
	// recorded result *and* the same frozen evidence; anything else is a refusal,
	// not something to overwrite.
	const existing = await readFile(paths.receiptPath, "utf-8").catch(() => null);
	if (signal?.aborted) {
		return { kind: "refused", reason: "The recovery operation was cancelled" };
	}
	if (existing !== null) {
		let parsed: TaskReceiptV3;
		try {
			parsed = parseRoundReceiptJson(existing, paths.receiptPath);
		} catch (error) {
			return { kind: "refused", reason: `the existing receipt cannot be validated: ${messageOf(error)}` };
		}
		const round = parsed.rounds[0];
		if (
			parsed.taskId !== taskId || parsed.projectRoot !== projectRoot || parsed.rounds.length !== 1 ||
			round?.number !== subject.round || round.requestId !== payload.requestId ||
			round.status !== outcome.status || canonicalJson(round.error) !== canonicalJson(outcome.error) ||
			round.summary !== outcome.summary || canonicalJson(round.artifacts) !== canonicalJson(outcome.artifacts)
		) {
			return { kind: "refused", reason: "the existing receipt does not describe the recorded result" };
		}
		// The reused receipt must also describe the same execution: the same
		// original owner, the same WorkBuddy session and the same approved
		// material. Without these checks a foreign recovery could bless a
		// receipt that somebody else had written for a different round.
		const originalOwner = payload.owner;
		const receiptOwner = round.owner;
		if (
			receiptOwner === null ||
			receiptOwner.sessionId !== originalOwner.sessionId ||
			receiptOwner.generation !== originalOwner.generation ||
			receiptOwner.instanceId !== originalOwner.instanceId ||
			receiptOwner.processId !== originalOwner.processId
		) {
			return { kind: "refused", reason: "the existing receipt names a different original owner" };
		}
		if (parsed.sessionId !== targetSession || round.targetPolicy.kind !== "session" || round.targetPolicy.sessionId !== targetSession) {
			return { kind: "refused", reason: "the existing receipt names a different WorkBuddy session" };
		}
		if (round.manifestSha256 !== staged.manifestSha256) {
			return { kind: "refused", reason: "the existing receipt names a different approved manifest" };
		}
		if (
			canonicalJson(round.goal) !== canonicalJson(payload.goal) ||
			canonicalJson(round.inputFiles) !== canonicalJson(payload.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))) ||
			canonicalJson(round.expectedOutputs) !== canonicalJson(payload.expectedOutputs) ||
			round.snapshotRoot !== staged.snapshotRoot ||
			canonicalJson(round.consent) !== canonicalJson({ source: staged.manifest.approval.source, at: staged.manifest.approval.at })
		) {
			return { kind: "refused", reason: "the existing receipt names different approved material" };
		}
		return {
			kind: "built",
			sha256: crypto.createHash("sha256").update(existing, "utf-8").digest("hex"),
			payload,
		};
	}
	const receipt: TaskReceiptV3 = {
		version: 3,
		taskId,
		sessionId: targetSession,
		projectRoot,
		rounds: [
			{
				number: subject.round,
				layout: "round",
				goal: payload.goal,
				inputFiles: payload.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
				expectedOutputs: payload.expectedOutputs,
				status: outcome.status,
				summary: outcome.summary,
				error: outcome.error,
				artifacts: outcome.artifacts,
				recordKind: "approved",
				requestId: payload.requestId,
				// The receipt describes the execution that happened, so it names
				// the session the round actually ran on. The pool the round was
				// authorized against stays in the staged manifest, whose digest
				// the queue already fenced on.
				targetPolicy: { kind: "session", sessionId: targetSession },
				snapshotRoot: staged.snapshotRoot,
				// The owner stays the original one: a recovery repairs the record
				// of an execution somebody else owned, it does not reassign it.
				owner: payload.owner,
				manifestSha256: staged.manifestSha256,
				commitToken: null,
				turns: [],
				consent: { source: staged.manifest.approval.source, at: staged.manifest.approval.at },
			},
		],
	};
	try {
		const written = await input.writeReceipt(projectRoot, taskId, subject.round, "round", receipt);
		if (signal?.aborted) {
			return { kind: "refused", reason: "The recovery operation was cancelled" };
		}
		return { kind: "built", sha256: written.sha256, payload };
	} catch (error) {
		if (signal?.aborted) {
			return { kind: "refused", reason: "The recovery operation was cancelled" };
		}
		return { kind: "write_failed", reason: `the receipt could not be written: ${messageOf(error)}` };
	}
}

/**
 * Rebuilds a failed round receipt from evidence the queue already holds.
 *
 * This is recovery, not a second execution: no prompt is built, sent or replayed.
 * The status, error, summary and artifact references come from the recorded first
 * outcome; the goal, inputs and approval come from the immutable staged manifest
 * whose digest the queue recorded. Nothing here may invent a value.
 *
 * A round that may have been sent stays quarantined: `confirmReceipt` re-applies
 * the hold in the same transaction, so a local result never claims the remote
 * execution stopped. Only a recorded human observation releases it.
 *
 * This is the *original owner's* path. A different operator recovers through
 * {@link repairRoundReceiptAsOperator}, which additionally requires a human's
 * one-shot consent for the exact subject.
 */
export async function repairRoundReceipt(
	projectRoot: string,
	owner: OwnerIdentity,
	input: RepairRoundInput,
	writeReceipt: typeof writeRoundReceipt = writeRoundReceipt,
): Promise<RepairRoundOutcome> {
	const refuse = (round: number | null, reason: string): RepairRoundOutcome => ({
		kind: "refused",
		taskId: input.taskId,
		round,
		reason,
	});

	const subjectResult = readRepairSubject(projectRoot, owner, input);
	if (subjectResult.kind === "refused") {
		return refuse(subjectResult.round, subjectResult.reason);
	}
	const { subject, outcome } = subjectResult;

	const built = await rebuildRoundReceipt({ projectRoot, taskId: input.taskId, subject, outcome, writeReceipt, signal: input.signal });
	if (built.kind !== "built") {
		// A refusal is not a storage failure: the round keeps the failure it
		// already recorded, because that failure is the evidence a repair works
		// from. Only a failed write is recorded as a new failure.
		if (built.kind === "write_failed") {
			recordCommitFailureById(projectRoot, input.taskId, subject.round, built.reason);
		}
		return refuse(subject.round, built.reason);
	}

	const committed = await commitDurableRound({
		projectRoot,
		taskId: input.taskId,
		round: subject.round,
		requestId: built.payload.requestId,
		status: outcome.status,
		error: outcome.error,
		receiptSha256: built.sha256,
		authorization: { kind: "owner", owner },
		signal: input.signal,
	});
	if (!committed.committed) {
		return refuse(subject.round, committed.reason ?? "the repaired receipt could not be confirmed");
	}
	// A round that may have been sent keeps its quarantine after a local commit.
	return {
		kind: "repaired",
		taskId: input.taskId,
		round: subject.round,
		receiptSha256: built.sha256,
		released: subject.notSent,
	};
}

/**
 * Rebuilds a dead owner's round receipt for a *different* operator.
 *
 * The operator's consent is the authorization, and it names the exact subject
 * it was given for. The queue re-verifies that subject inside the commit
 * transaction, so a round that changed after the human answered invalidates
 * the consent instead of being silently adopted.
 *
 * Nothing about the round's execution changes: the original owner, the
 * approved manifest, the recorded first outcome and the session affinity are
 * all preserved. Only the receipt is rebuilt, and the operator's act is
 * recorded in the queue's own audit column.
 */
export async function repairRoundReceiptAsOperator(
	projectRoot: string,
	operator: OwnerIdentity,
	target: OperatorRecoveryTarget,
	consent: RecoveryConsent,
	options: { writeReceipt?: typeof writeRoundReceipt; signal?: AbortSignal } = {},
): Promise<RepairRoundOutcome> {
	const refuse = (round: number | null, reason: string): RepairRoundOutcome => ({
		kind: "refused",
		taskId: target.subject.taskId,
		round,
		reason,
	});
	// The consent must name the subject it was given for. It is checked here
	// as well as inside the transaction, so an obviously mismatched consent
	// never reaches the queue at all.
	if (options.signal?.aborted || consent.confirmed !== true || !sameRecoverySubject(consent.subject, target.subject)) {
		return refuse(target.round, "the operator's confirmation does not cover this exact round");
	}

	// The authorization is verified *before* a single byte is written. A
	// receipt file on disk for a recovery that was refused would be evidence of
	// an act that never happened. The commit transaction verifies the same
	// facts again, because this preflight can be raced.
	const authorization: OperatorRecoveryAuthorization = {
		kind: "operator_recovery",
		operator,
		originalOwner: target.originalOwner,
		deathProof: target.deathProof,
		subject: target.subject,
		consent,
		requestedAt: Date.parse(consent.at),
	};
	let preflight;
	{
		const db = openReadConnection(projectRoot);
		if (db === null) return refuse(target.round, "project state is unavailable");
		try {
			preflight = verifyOperatorRecovery(
				db,
				target.subject.taskId,
				target.round,
				authorization,
				Date.now(),
			);
		} finally {
			closeQueueConnection(projectRoot, "read");
		}
	}
	if (!preflight.ok) {
		return refuse(target.round, preflight.reason);
	}

	const built = await rebuildRoundReceipt({
		projectRoot,
		taskId: target.subject.taskId,
		subject: target.evidence,
		outcome: target.outcome,
		writeReceipt: options.writeReceipt ?? writeRoundReceipt,
		signal: options.signal,
	});
	if (built.kind !== "built") {
		// A refusal is not a storage failure: the round keeps the failure it
		// already recorded, because that failure is the evidence a repair works
		// from. Only a failed write is recorded as a new failure.
		if (built.kind === "write_failed") {
			recordCommitFailureById(projectRoot, target.subject.taskId, target.round, built.reason);
		}
		return refuse(target.round, built.reason);
	}

	const committed = await commitDurableRound({
		projectRoot,
		taskId: target.subject.taskId,
		round: target.round,
		requestId: built.payload.requestId,
		status: target.outcome.status,
		error: target.outcome.error,
		receiptSha256: built.sha256,
		signal: options.signal,
		authorization: { kind: "operator_recovery", recovery: authorization },
	});
	if (!committed.committed) {
		return refuse(target.round, committed.reason ?? "the recovered receipt could not be confirmed");
	}
	// A round that may have been sent keeps its quarantine after a local commit:
	// the receipt proves what the round decided, not that the worker stopped.
	return {
		kind: "repaired",
		taskId: target.subject.taskId,
		round: target.round,
		receiptSha256: built.sha256,
		released: target.evidence.notSent,
	};
}

/** Compares roots by realpath so a symlinked project is still the same project. */
async function canonicalRootOf(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		return root;
	}
}

