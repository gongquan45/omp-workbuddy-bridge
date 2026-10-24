/**
 * Delivery: the one path from a durable queue fact to an OMP notification.
 *
 * Three facts are deliberately kept apart, because collapsing them is how a
 * bridge starts reporting work it never delivered:
 *
 *  - *published*: the fact is durable in the queue outbox and survives a restart;
 *  - *sent*: the injected host channel resolved for this OMP session;
 *  - *received*: the OMP actually consumed the notification, which only an
 *    explicit acknowledgement records. Sending is never treated as receiving,
 *    and a receipt is never treated as acceptance.
 *
 * The module is event-driven on purpose. It owns no lifecycle machine, timer or
 * polling loop: the host calls `flushDelivery` after a durable transition, when
 * a status call needs pending follow-ups, or after a restart of the same OMP
 * session. All state lives in the existing queue outbox; the stable
 * `(requestId, kind, revision)` identity makes duplicate publishes and
 * concurrent flushes harmless.
 *
 * Connection discipline: every async entry point takes the project root, never
 * a caller-cached Database. The process-wide write connection is cached by the
 * queue, and holding that handle across an `await` lets another operation
 * close or replace it underneath us. So each phase re-opens what it needs,
 * does strictly synchronous work, and closes before the next `await`.
 *
 * Recipient rule: a round keeps the session that originated it, but delivery
 * always reaches the OMP session the host reports *now*. Those only diverge
 * for a same-session generation switch, which is the lawful successor case.
 * Another OMP session is a different user-facing conversation, never a
 * successor, and is refused everywhere.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
	ackOutbox,
	canonicalProjectRoot,
	claimOutbox,
	closeQueueConnection,
	enqueueOutbox,
	isOwnerActive,
	openReadConnection,
	openWriteConnection,
	outboxDeliveryId,
	readRound,
	withImmediate,
} from "./queue";
import { computeFileSha256, resolveRoundPaths } from "./tasks";
import { WB_ERROR_CODE, type DeliveryMode, type FileArtifact, type OwnerIdentity, type TaskReceiptV3 } from "./types";

/** The kind of durable fact a notification describes. */
export type DeliveryKind = "result" | "recovery";

/**
 * A result fact is the *first* terminal outcome of one request, so there is
 * exactly one per round. A constant revision is what makes publishing after the
 * outcome and again after the receipt commit deduplicate instead of waking the
 * OMP twice.
 */
export const RESULT_FACT_REVISION = 1;

/** Host-created human evidence; the model cannot supply either source. */
export interface DeliveryConsent {
	source: "host_dialog" | "user_command";
	/** ISO timestamp of the human decision. */
	at: string;
}

/** The persisted delivery preference of one round. */
export interface DeliveryPolicy {
	mode: DeliveryMode;
	/** Evidence that chose background; `null` for foreground or when missing. */
	backgroundConsent: DeliveryConsent | null;
	/**
	 * True only for `background` with recorded host-created human consent.
	 * An unauthorized background row is reported, never silently promoted.
	 */
	backgroundAuthorized: boolean;
}

/** Why the delivery module refused an operation. */
export type DeliveryRefusal =
	| "round_not_found"
	| "foreign_session"
	| "live_foreign_generation"
	| "owner_not_active"
	| "terminal_round"
	| "revision_conflict"
	| "background_requires_consent"
	| "outcome_missing"
	| "commit_pending"
	| "invalid_revision"
	| "delivery_not_found"
	| "evidence_required";

function isConsent(value: unknown): value is DeliveryConsent {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		(record["source"] === "host_dialog" || record["source"] === "user_command") &&
		typeof record["at"] === "string" &&
		Number.isFinite(Date.parse(record["at"]))
	);
}

function parseConsent(raw: unknown): DeliveryConsent | null {
	if (typeof raw !== "string" || raw.trim() === "") {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isConsent(parsed) ? { source: parsed.source, at: parsed.at } : null;
	} catch {
		return null;
	}
}

function policyFromRound(row: Record<string, unknown>): DeliveryPolicy {
	const mode = row["delivery_mode"] === "background" ? "background" : "foreground";
	const consent = mode === "background" ? parseConsent(row["delivery_consent_json"]) : null;
	return {
		mode,
		backgroundConsent: consent,
		backgroundAuthorized: mode === "background" && consent !== null,
	};
}

/**
 * Reads one round's persisted delivery preference.
 *
 * Synchronous and read-only; the caller may keep its own connection lifecycle.
 */
export function readDeliveryPolicy(db: Database, taskId: string, round: number): DeliveryPolicy | null {
	const row = readRound(db, taskId, round);
	return row === null ? null : policyFromRound(row);
}

/** True when a generation is still marked active for a session. */
function generationIsActive(db: Database, sessionId: string, generation: string): boolean {
	const row = db
		.query("SELECT state FROM owners WHERE session_id = ? AND generation = ?")
		.get(sessionId, generation) as { state: string } | null;
	return row?.state === "active";
}

/** Outcome of an explicit delivery-mode change. */
export type SetDeliveryModeOutcome =
	| { kind: "updated" | "unchanged"; policy: DeliveryPolicy }
	| { kind: "refused"; reason: DeliveryRefusal; policy: DeliveryPolicy | null };

/**
 * Changes how this round reports its result.
 *
 * Background is never inferred: it needs explicit host-created human consent,
 * and both the mode and that evidence are persisted. A terminal round is
 * refused because rewriting its delivery history after the fact would make the
 * record disagree with what the user actually chose while it ran.
 */
export function setDeliveryMode(
	db: Database,
	input: {
		owner: OwnerIdentity;
		taskId: string;
		round: number;
		mode: DeliveryMode;
		consent?: DeliveryConsent | null;
		now?: number;
	},
): SetDeliveryModeOutcome {
	const now = input.now ?? Date.now();
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null) {
			return { kind: "refused" as const, reason: "round_not_found" as const, policy: null };
		}
		const policy = policyFromRound(row);
		if (row["owner_session"] !== input.owner.sessionId) {
			return { kind: "refused" as const, reason: "foreign_session" as const, policy };
		}
		if (row["outcome_json"] !== null) {
			return { kind: "refused" as const, reason: "terminal_round" as const, policy };
		}
		if (input.mode === "background" && !isConsent(input.consent)) {
			return { kind: "refused" as const, reason: "background_requires_consent" as const, policy };
		}
		const consentJson = input.mode === "background" && isConsent(input.consent) ? JSON.stringify(input.consent) : null;
		const unchanged =
			policy.mode === input.mode &&
			(policy.mode === "foreground" || policy.backgroundConsent?.at === input.consent?.at);
		if (unchanged) {
			return { kind: "unchanged" as const, policy };
		}
		const updated = db.run(
			`UPDATE rounds SET delivery_mode = ?, delivery_consent_json = ?,
				revision = revision + 1, updated_at = ?
			 WHERE task_id = ? AND round = ? AND owner_session = ?
			   AND outcome_json IS NULL AND revision = ?`,
			[input.mode, consentJson, now, input.taskId, input.round, input.owner.sessionId, Number(row["revision"])],
		);
		if (updated.changes !== 1) {
			return { kind: "refused" as const, reason: "revision_conflict" as const, policy };
		}
		const after = readRound(db, input.taskId, input.round);
		return {
			kind: "updated" as const,
			policy: after === null ? policy : policyFromRound(after),
		};
	});
}

/** Input to {@link publishDelivery}. */
export interface PublishDeliveryInput {
	owner: OwnerIdentity;
	taskId: string;
	round: number;
	kind: DeliveryKind;
	/**
	 * Fact revision within `(requestId, kind)`.
	 *
	 * `result` always uses {@link RESULT_FACT_REVISION}: a round has exactly one
	 * first terminal outcome, so any other value would create a second fact.
	 * Help and recovery revisions come from their own durable row.
	 */
	revision: number;
	now?: number;
}

/** Outcome of publishing one durable notification fact. */
export type PublishDeliveryOutcome =
	| { kind: "created" | "existing"; deliveryId: string }
	| { kind: "refused"; reason: DeliveryRefusal };

/**
 * Enqueues one notification for the OMP session that originated the round.
 *
 * The recipient is never taken from the caller: it is the round's recorded
 * `owner_session`. A successor generation may rebind a stale row only when it
 * is the *same OMP session* and the previous generation is provably inactive.
 * Another OMP session is a different user-facing conversation, not a successor,
 * and is refused.
 *
 * Synchronous on purpose: the caller must close its connection before its next
 * `await` (see the module header).
 */
export function publishDelivery(db: Database, input: PublishDeliveryInput): PublishDeliveryOutcome {
	if (!Number.isInteger(input.revision) || input.revision < 1) {
		return { kind: "refused", reason: "invalid_revision" };
	}
	if (input.kind === "result" && input.revision !== RESULT_FACT_REVISION) {
		return { kind: "refused", reason: "invalid_revision" };
	}
	const row = readRound(db, input.taskId, input.round);
	if (row === null) {
		return { kind: "refused", reason: "round_not_found" };
	}
	const requestId = row["request_id"];
	if (typeof requestId !== "string" || requestId === "") {
		return { kind: "refused", reason: "round_not_found" };
	}
	const recordedSession = row["owner_session"];
	if (typeof recordedSession !== "string" || recordedSession !== input.owner.sessionId) {
		return { kind: "refused", reason: "foreign_session" };
	}
	const recordedGeneration = row["owner_generation"];
	if (typeof recordedGeneration === "string" && recordedGeneration !== input.owner.generation) {
		if (generationIsActive(db, input.owner.sessionId, recordedGeneration)) {
			// Two live generations of one session disagree about which one follows
			// up. Guessing would give both the same duty.
			return { kind: "refused", reason: "live_foreign_generation" };
		}
		// The previous generation is provably gone: this is its legal successor in
		// the same session.
	}
	if (input.kind === "result" && row["outcome_json"] === null) {
		// A result notification without a first outcome would either invent one or
		// wake the OMP for nothing.
		return { kind: "refused", reason: "outcome_missing" };
	}

	const enqueued = enqueueOutbox(db, {
		requestId,
		kind: input.kind,
		revision: input.revision,
		owner: input.owner,
	});
	if (enqueued.kind === "created") {
		return enqueued;
	}

	// A duplicate publish is where a stale generation can hide. Re-read the row
	// and hand it to this generation only under the same-session/inactive rule.
	return withImmediate(db, () => {
		const existing = db
			.query("SELECT owner_session, owner_generation FROM outbox WHERE delivery_id = ?")
			.get(enqueued.deliveryId) as { owner_session: string; owner_generation: string } | null;
		if (existing === null) {
			return { kind: "existing" as const, deliveryId: enqueued.deliveryId };
		}
		if (existing.owner_session !== input.owner.sessionId) {
			return { kind: "refused" as const, reason: "foreign_session" as const };
		}
		if (existing.owner_generation === input.owner.generation) {
			return { kind: "existing" as const, deliveryId: enqueued.deliveryId };
		}
		if (generationIsActive(db, input.owner.sessionId, existing.owner_generation)) {
			return { kind: "refused" as const, reason: "live_foreign_generation" as const };
		}
		db.run(
			`UPDATE outbox SET owner_generation = ?
			 WHERE delivery_id = ? AND owner_session = ? AND owner_generation = ?`,
			[input.owner.generation, enqueued.deliveryId, input.owner.sessionId, existing.owner_generation],
		);
		return { kind: "existing" as const, deliveryId: enqueued.deliveryId };
	});
}

/** One message the host is asked to deliver to its OMP session. */
export interface DeliveryMessage {
	deliveryId: string;
	requestId: string;
	kind: DeliveryKind;
	revision: number;
	taskId: string;
	round: number;
	/** The exact text to follow up with; it never contains conversation or secrets. */
	text: string;
}

/** Injected host adapter: follow-up plus a turn trigger, in the real host. */
export type DeliverySendMessage = (message: DeliveryMessage) => Promise<void>;

/** One failed send; the row stays claimable for a later retry. */
export interface DeliverySendFailure {
	deliveryId: string;
	reason: string;
}

/** What one flush did. */
export interface FlushDeliveryOutcome {
	sent: number;
	/** Already sent (awaiting receive) or not ready yet; never resent. */
	skipped: number;
	failed: number;
	sentIds: string[];
	failures: DeliverySendFailure[];
}

/** One result artifact as it exists on disk right now. */
export interface DeliveryArtifactState {
	path: string;
	sha256: string | null;
	bytes: number | null;
	role: FileArtifact["role"];
	/**
	 * `verified` means the bytes on disk match the proven receipt. `changed`
	 * and `missing` are reported instead of hidden; `unverified` means the
	 * receipt itself carried no digest to check.
	 */
	state: "verified" | "changed" | "missing" | "unverified";
}

/** Truthful projection of one round as seen through the queue. */
export interface DeliveryResultReport {
	state: "running" | "awaiting_commit" | "committed" | "storage_failure";
	taskId: string;
	round: number;
	requestId: string;
	outcome: { status: "completed" | "failed" | "cancelled" | "interrupted"; errorJson: string | null } | null;
	commit: "pending" | "committed" | "failed";
	/** Set only when the receipt bytes were digest-fenced and parsed. */
	receipt: { path: string; sha256: string } | null;
	/** Empty unless the receipt was proven; never fabricated from intent. */
	artifacts: DeliveryArtifactState[];
	summary: string;
	storageError: { code: string; message: string } | null;
	dispatchState: "not_sent" | "possibly_sent" | "ended";
	phase: string;
	notification: { deliveryId: string | null; sent: boolean; received: boolean };
}

const OUTCOME_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	cancelled: true,
	interrupted: true,
};

function parseStoredError(raw: unknown): { code: string; message: string } | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	if (typeof raw !== "string") {
		return { code: WB_ERROR_CODE.storageError, message: "unreadable stored storage error" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			const code = typeof record["code"] === "string" ? record["code"] : WB_ERROR_CODE.storageError;
			const message =
				typeof record["message"] === "string" ? record["message"] : "stored storage error carried no message";
			return { code, message };
		}
	} catch {
		// Fall through to the raw text, which is still the best available evidence.
	}
	return { code: WB_ERROR_CODE.storageError, message: raw };
}

function safeOutcome(
	raw: unknown,
): { status: "completed" | "failed" | "cancelled" | "interrupted"; errorJson: string | null } | null {
	if (typeof raw !== "string") {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return null;
		}
		const status = (parsed as Record<string, unknown>)["status"];
		if (typeof status !== "string" || OUTCOME_STATUSES[status] !== true) {
			return null;
		}
		const error = (parsed as Record<string, unknown>)["error"];
		return {
			status: status as "completed" | "failed" | "cancelled" | "interrupted",
			errorJson: error === null || error === undefined ? null : JSON.stringify(error),
		};
	} catch {
		return null;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the round's first outcome and, only when the receipt is proven, its
 * current artifact references.
 *
 * A committed row whose receipt is missing, corrupt or belongs to a different
 * request is a storage failure: the known business outcome is preserved, but
 * no artifact is reported because none was proven. The same is true for a
 * failed commit, even if a receipt file happens to exist.
 *
 * Async and root-based: the database snapshot is taken synchronously and the
 * read connection closed before any file work, so no cached handle survives an
 * `await` (see the module header).
 */
export async function readDeliveryResult(
	projectRoot: string,
	taskId: string,
	round: number,
): Promise<DeliveryResultReport | null> {
	const db = openReadConnection(projectRoot);
	if (db === null) {
		return null;
	}
	let snapshot: ResultSnapshot | null;
	try {
		snapshot = snapshotDeliveryResult(db, taskId, round);
	} finally {
		closeQueueConnection(projectRoot, "read");
	}
	return snapshot === null ? null : await finishDeliveryResult(projectRoot, snapshot);
}

/** Everything the queue knows about one round, read in one synchronous pass. */
interface ResultSnapshot {
	taskId: string;
	round: number;
	requestId: string;
	outcome: { status: "completed" | "failed" | "cancelled" | "interrupted"; errorJson: string | null } | null;
	/** True when a stored outcome exists but could not be parsed. */
	outcomeUnreadable: boolean;
	commit: "pending" | "committed" | "failed";
	dispatchState: "not_sent" | "possibly_sent" | "ended";
	phase: string;
	notification: { deliveryId: string | null; sent: boolean; received: boolean };
	storageError: { code: string; message: string } | null;
	/** The digest the commit recorded for the receipt; null when absent. */
	receiptSha256: string | null;
}

/**
 * Projects one round row plus its result-notification fact into a snapshot.
 *
 * Synchronous by design: callers close their connection before any `await`
 * and hand the snapshot to the async finisher.
 */
function snapshotDeliveryResult(db: Database, taskId: string, round: number): ResultSnapshot | null {
	const row = readRound(db, taskId, round);
	if (row === null) {
		return null;
	}
	const requestId = typeof row["request_id"] === "string" ? row["request_id"] : "";
	const commit = row["commit_state"] === "committed" || row["commit_state"] === "failed" ? row["commit_state"] : "pending";
	const dispatchState =
		row["dispatch_state"] === "possibly_sent" || row["dispatch_state"] === "ended"
			? row["dispatch_state"]
			: "not_sent";
	const notificationRow = db
		.query(
			`SELECT delivery_id, notified_generation, acknowledged_at FROM outbox
			 WHERE request_id = ? AND kind = 'result'
			 ORDER BY revision DESC, delivery_id ASC LIMIT 1`,
		)
		.get(requestId) as
		| { delivery_id: string; notified_generation: string | null; acknowledged_at: number | null }
		| null;
	return {
		taskId,
		round,
		requestId,
		outcome: safeOutcome(row["outcome_json"]),
		outcomeUnreadable: row["outcome_json"] !== null && safeOutcome(row["outcome_json"]) === null,
		commit,
		dispatchState,
		phase: typeof row["phase"] === "string" ? row["phase"] : "",
		notification: {
			deliveryId: notificationRow?.delivery_id ?? null,
			sent: notificationRow?.notified_generation !== null && notificationRow?.notified_generation !== undefined,
			received: notificationRow?.acknowledged_at !== null && notificationRow?.acknowledged_at !== undefined,
		},
		storageError: parseStoredError(row["storage_error_json"]),
		receiptSha256: typeof row["receipt_sha256"] === "string" ? row["receipt_sha256"] : null,
	};
}

/**
 * Turns a snapshot into the truthful report, doing file work only for a
 * committed outcome. Holds no database connection.
 */
async function finishDeliveryResult(projectRoot: string, snapshot: ResultSnapshot): Promise<DeliveryResultReport> {
	const base = {
		taskId: snapshot.taskId,
		round: snapshot.round,
		requestId: snapshot.requestId,
		outcome: snapshot.outcome,
		commit: snapshot.commit,
		dispatchState: snapshot.dispatchState,
		phase: snapshot.phase,
		notification: snapshot.notification,
	} as const;
	if (snapshot.commit === "failed") {
		return {
			...base,
			state: "storage_failure",
			receipt: null,
			artifacts: [],
			summary: "",
			storageError:
				snapshot.storageError ?? {
					code: WB_ERROR_CODE.storageError,
					message: "the round recorded a failed commit without a storage error",
				},
		};
	}
	if (snapshot.outcome === null) {
		return {
			...base,
			state: "running",
			receipt: null,
			artifacts: [],
			summary: "",
			storageError: snapshot.outcomeUnreadable
				? { code: WB_ERROR_CODE.taskStateInvalid, message: "the stored first outcome is unreadable" }
				: null,
		};
	}
	if (snapshot.commit === "pending") {
		return {
			...base,
			state: "awaiting_commit",
			receipt: null,
			artifacts: [],
			summary: "",
			storageError: snapshot.storageError,
		};
	}
	const proven = await verifyCommittedReceipt(projectRoot, snapshot);
	// The proof's own failure must survive: spreading it and then overwriting
	// `storageError` with the row's (usually null) value would report a
	// `storage_failure` state with no reason at all.
	return { ...base, ...proven, storageError: proven.storageError ?? snapshot.storageError };
}

/** The file-verified half of a committed report; failures are storage errors. */
interface ProvenResult {
	state: "committed" | "storage_failure";
	receipt: { path: string; sha256: string } | null;
	artifacts: DeliveryArtifactState[];
	summary: string;
	storageError: { code: string; message: string } | null;
}

async function verifyCommittedReceipt(projectRoot: string, snapshot: ResultSnapshot): Promise<ProvenResult> {
	const unproven = (message: string): ProvenResult => ({
		state: "storage_failure",
		receipt: null,
		artifacts: [],
		summary: "",
		storageError: { code: WB_ERROR_CODE.storageError, message },
	});
	if (snapshot.receiptSha256 === null) {
		return unproven("the round is committed without a recorded receipt digest");
	}
	let receiptPath: string;
	try {
		receiptPath = resolveRoundPaths(projectRoot, snapshot.taskId, snapshot.round, "round").receiptPath;
	} catch (error) {
		return unproven(describeError(error));
	}
	let content: string;
	try {
		content = await readFile(receiptPath, "utf-8");
	} catch (error) {
		return unproven(`the committed receipt at ${receiptPath} could not be read: ${describeError(error)}`);
	}
	const onDiskDigest = createHash("sha256").update(content, "utf-8").digest("hex");
	if (onDiskDigest !== snapshot.receiptSha256) {
		return unproven("the receipt bytes no longer match the digest recorded for this commit");
	}
	let receipt: TaskReceiptV3;
	try {
		receipt = JSON.parse(content) as TaskReceiptV3;
	} catch (error) {
		return unproven(`the committed receipt is not valid JSON: ${describeError(error)}`);
	}
	const receiptRound = Array.isArray(receipt.rounds)
		? receipt.rounds.find((candidate) => candidate.number === snapshot.round)
		: undefined;
	if (
		receipt.version !== 3 ||
		receipt.taskId !== snapshot.taskId ||
		receiptRound === undefined ||
		receiptRound.requestId !== snapshot.requestId ||
		receiptRound.status !== snapshot.outcome?.status
	) {
		return unproven("the committed receipt does not describe this task, round, request and first outcome");
	}
	const artifacts: DeliveryArtifactState[] = [];
	for (const artifact of Array.isArray(receiptRound.artifacts) ? receiptRound.artifacts : []) {
		artifacts.push(await verifyArtifact(projectRoot, artifact));
	}
	return {
		state: "committed",
		receipt: { path: receiptPath, sha256: snapshot.receiptSha256 },
		artifacts,
		summary: typeof receiptRound.summary === "string" ? receiptRound.summary : "",
		storageError: null,
	};
}

async function verifyArtifact(projectRoot: string, artifact: FileArtifact): Promise<DeliveryArtifactState> {
	const absolute = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(projectRoot, artifact.path);
	let bytes: number;
	try {
		const info = await lstat(absolute);
		if (!info.isFile()) {
			// A link or directory where a file was recorded is not the artifact the
			// receipt describes; following it would accept substituted bytes.
			return { path: absolute, sha256: null, bytes: null, role: artifact.role, state: "missing" };
		}
		bytes = info.size;
	} catch {
		return { path: absolute, sha256: null, bytes: null, role: artifact.role, state: "missing" };
	}
	if (typeof artifact.sha256 !== "string" || artifact.sha256 === "") {
		return { path: absolute, sha256: null, bytes, role: artifact.role, state: "unverified" };
	}
	let current: string;
	try {
		current = await computeFileSha256(absolute);
	} catch {
		return { path: absolute, sha256: artifact.sha256, bytes, role: artifact.role, state: "missing" };
	}
	return {
		path: absolute,
		sha256: current,
		bytes,
		role: artifact.role,
		state: current === artifact.sha256 ? "verified" : "changed",
	};
}

/** Renders the notification for one durable fact. Exported for tests and host previews. */
export function renderDeliveryMessage(input: {
	kind: DeliveryKind;
	taskId: string;
	round: number;
	requestId: string;
	revision: number;
	report?: DeliveryResultReport;
	recovery?: { phase: string; dispatchState: string; storageError: { code: string; message: string } | null };
}): string {
	const subject = `task ${input.taskId} round ${input.round}`;
	if (input.kind === "recovery" || input.report === undefined) {
		const recovery = input.recovery;
		return [
			`${subject} needs recovery (phase ${recovery?.phase ?? "unknown"}, dispatch ${recovery?.dispatchState ?? "unknown"}).`,
			recovery?.storageError === null || recovery?.storageError === undefined
				? "No storage error is recorded; verify the live state before acting."
				: `Storage error: ${recovery.storageError.code}: ${recovery.storageError.message}`,
			"Do not resend a possibly-sent execution or release quarantined resources. Inspect the real task and evidence first, then use the explicit recovery path.",
		].join("\n");
	}

	const report = input.report;
	const lines: string[] = [];
	const outcome = report.outcome?.status ?? "unknown";
	const proven = report.receipt !== null;
	if (report.state === "storage_failure") {
		lines.push(`WorkBuddy result for ${subject}: ${outcome}; the receipt could not be proven.`);
	} else if (proven) {
		lines.push(`WorkBuddy result for ${subject}: ${outcome} (receipt committed and verified).`);
	} else {
		lines.push(
			`WorkBuddy result for ${subject}: ${outcome} (committed in the queue; the receipt bytes were not re-verified for this notification).`,
		);
	}
	if (report.summary !== "") {
		lines.push(`Reported summary: ${report.summary}`);
	}
	if (report.storageError !== null) {
		lines.push(
			`Storage error: ${report.storageError.code}: ${report.storageError.message}`,
			"The first business outcome is preserved. Do not resend the WorkBuddy work, and do not accept artifacts from this round until the receipt is repaired.",
		);
	}
	if (report.dispatchState === "possibly_sent") {
		lines.push(
			"The remote execution end is unresolved (possibly_sent); a committed local result is not proof that the remote session stopped. Keep the quarantine/recovery state.",
		);
	}
	if (report.artifacts.length > 0) {
		lines.push(
			"Open, run or compare these current files yourself before accepting anything; WorkBuddy's report is not acceptance:",
			...report.artifacts.map(
				(artifact) =>
					`- ${artifact.path} [${artifact.state}]${artifact.sha256 === null ? "" : ` sha256 ${artifact.sha256}`}`,
			),
		);
		const suspect = report.artifacts.filter((artifact) => artifact.state !== "verified");
		if (suspect.length > 0) {
			lines.push(
				"Artifacts marked changed, missing or unverified were not proven against the receipt; do not present them as delivered.",
			);
		}
	} else if (proven) {
		lines.push("The proven receipt lists no artifacts; verify whether the work was expected to produce files.");
	}
	lines.push(
		`This is a notification, not a receipt or acceptance. Inspect with wb_status({ taskId: "${input.taskId}", waitMs: 0 }) and report the actual verdict for this round.`,
	);
	return lines.join("\n");
}

/** A pure answer to "what does ending this wait mean?"; it never changes state. */
export interface WaitResolution {
	/** The persisted mode; ending a wait never flips it. */
	mode: DeliveryMode;
	/** A later durable result still has to reach this OMP session. */
	followupRequired: boolean;
	/** Report through the background path instead of holding the current turn. */
	backgroundReport: boolean;
	/** Stopping a wait is never a cancellation of WorkBuddy execution. */
	cancelsExecution: false;
}

/**
 * Maps a wait ending to delivery policy without writing anything.
 *
 * Expired and steered waits stay foreground: the work continues, and the
 * eventual result is delivered as a follow-up. Only a persisted, authorized
 * background choice changes how that follow-up is reported.
 */
export function resolveWaitEnd(policy: DeliveryPolicy, reason: "settled" | "expired" | "steered" | "aborted"): WaitResolution {
	const background = policy.mode === "background" && policy.backgroundAuthorized;
	return {
		mode: policy.mode,
		followupRequired: reason !== "settled",
		backgroundReport: background,
		cancelsExecution: false,
	};
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * One in-process flight per project root, session and generation.
 *
 * The outbox claim is already a database CAS, but two concurrent flushes in the
 * same process can claim the same row sequentially (a retry is intentionally
 * allowed). Sharing the flight is what keeps that retry from producing two
 * host callbacks before the first one resolves.
 */
const inFlight = new Map<string, Promise<FlushDeliveryOutcome>>();

/**
 * Sends pending notifications for exactly one OMP session and generation.
 *
 * A row is marked sent only after the host channel resolves, and a resolved
 * channel is the only thing that marks it. A rejection leaves the claim in
 * place, so the same generation can retry; it never resends WorkBuddy work.
 *
 * The `owner` must be the *current* host-session identity, freshly derived on
 * each call: a durable round keeps the session that originated it, but the
 * message must reach the conversation the host reports now. The claim and the
 * post-send CAS each run on a freshly opened connection that is closed before
 * the next `await`, so no cached handle crosses a send.
 */
export function flushDelivery(
	input: {
		projectRoot: string;
		owner: OwnerIdentity;
		sendMessage: DeliverySendMessage;
		limit?: number;
	},
): Promise<FlushDeliveryOutcome> {
	const key = `${canonicalProjectRoot(input.projectRoot)}\u0000${input.owner.sessionId}\u0000${input.owner.generation}`;
	const existing = inFlight.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const flight = runFlush(input).finally(() => {
		if (inFlight.get(key) === flight) {
			inFlight.delete(key);
		}
	});
	inFlight.set(key, flight);
	return flight;
}

async function runFlush(input: {
	projectRoot: string;
	owner: OwnerIdentity;
	sendMessage: DeliverySendMessage;
	limit?: number;
}): Promise<FlushDeliveryOutcome> {
	// Phase 1: claim rows and snapshot everything needed to render, strictly
	// synchronous on one connection that is closed before any await.
	const db = openWriteConnection(input.projectRoot);
	let batch: ClaimedBatch;
	try {
		batch = claimAndSnapshot(db, input.owner, input.limit ?? 20);
	} finally {
		closeQueueConnection(input.projectRoot, "write");
	}
	const outcome: FlushDeliveryOutcome = {
		sent: 0,
		skipped: batch.skipped,
		failed: batch.failed.length,
		sentIds: [],
		failures: [...batch.failed],
	};

	for (const claim of batch.toSend) {
		// Phase 2: finish the report with file verification (no database handle
		// is held across it), then render and send.
		const report =
			claim.subject.snapshot === null ? null : await finishDeliveryResult(input.projectRoot, claim.subject.snapshot);
		const message: DeliveryMessage = {
			deliveryId: claim.deliveryId,
			requestId: claim.requestId,
			kind: claim.kind,
			revision: claim.revision,
			taskId: claim.subject.taskId,
			round: claim.subject.round,
			text: renderDeliveryMessage({
				kind: claim.kind,
				taskId: claim.subject.taskId,
				round: claim.subject.round,
				requestId: claim.requestId,
				revision: claim.revision,
				report: report ?? undefined,
				recovery: claim.subject.recovery ?? undefined,
			}),
		};
		try {
			await input.sendMessage(message);
		} catch (error) {
			// The row keeps its claim: the same generation may retry. It is never
			// acknowledged or marked sent, and no WorkBuddy work is resent.
			outcome.failed += 1;
			outcome.failures.push({ deliveryId: claim.deliveryId, reason: describeError(error) });
			continue;
		}

		// Phase 3: reopen synchronously and CAS the sent marker, then close.
		const writeDb = openWriteConnection(input.projectRoot);
		let marked: boolean;
		try {
			marked =
				writeDb
					.run(
						`UPDATE outbox SET notified_generation = ?, claimed_generation = ?
						 WHERE delivery_id = ? AND owner_session = ?
						   AND acknowledged_at IS NULL AND notified_generation IS NULL`,
						[
							input.owner.generation,
							input.owner.generation,
							claim.deliveryId,
							input.owner.sessionId,
						],
					)
					.changes === 1;
		} finally {
			closeQueueConnection(input.projectRoot, "write");
		}
		if (marked) {
			outcome.sent += 1;
			outcome.sentIds.push(claim.deliveryId);
		} else {
			// Another flush won the sent write after our callback resolved. The fact
			// was delivered once; this call must not claim a second sending.
			outcome.skipped += 1;
		}
	}
	return outcome;
}

/** One claimed row projected into everything the send phase needs. */
interface SendableClaim {
	deliveryId: string;
	requestId: string;
	kind: DeliveryKind;
	revision: number;
	subject: ResolvedSubject;
}

/** Dispositions decided up front, so the send phase holds no database. */
interface ClaimedBatch {
	toSend: SendableClaim[];
	skipped: number;
	failed: DeliverySendFailure[];
}

/**
 * Claims the session's pending rows and snapshots their subjects.
 *
 * A result row still awaiting its commit is skipped rather than sent: sending
 * would report a commit state that is still changing and could never notify the
 * committed/failed outcome under the same stable fact id. Dispositions are
 * decided here so the render phase needs no database at all.
 */
function claimAndSnapshot(db: Database, owner: OwnerIdentity, limit: number): ClaimedBatch {
	const claims = claimOutbox(db, owner, limit);
	const batch: ClaimedBatch = { toSend: [], skipped: 0, failed: [] };
	for (const claim of claims) {
		const row = db
			.query(
				`SELECT owner_session, notified_generation, acknowledged_at
				 FROM outbox WHERE delivery_id = ?`,
			)
			.get(claim.deliveryId) as
			| { owner_session: string; notified_generation: string | null; acknowledged_at: number | null }
			| null;
		if (row === null || row.acknowledged_at !== null) {
			// Claimed in one transaction, gone or consumed by the next read: nothing
			// to send and nothing to repair; a concurrent consumer owns the row.
			batch.skipped += 1;
			continue;
		}
		if (row.owner_session !== owner.sessionId) {
			// Defensive: the claim query already filters by session.
			batch.skipped += 1;
			continue;
		}
		if (row.notified_generation !== null) {
			// Sent to this same OMP session already. A restart or a repeated flush
			// must not wake the user twice; the row stays pending for an explicit ack.
			batch.skipped += 1;
			continue;
		}
		const subject = resolveSubject(db, claim.kind, claim.requestId);
		if (subject === null) {
			// The durable fact points at no projectable subject. Reported as a
			// failure, not a skip, so the row stays visible and retryable.
			batch.failed.push({
				deliveryId: claim.deliveryId,
				reason: "no durable round or help request matches this notification",
			});
			continue;
		}
		if (subject.snapshot !== null && subject.snapshot.commit === "pending" && subject.snapshot.outcome !== null) {
			batch.skipped += 1;
			continue;
		}
		batch.toSend.push({ ...claim, subject });
	}
	return batch;
}

interface ResolvedSubject {
	taskId: string;
	round: number;
	/** The queue snapshot for `result` facts; file verification runs in the send phase. */
	snapshot: ResultSnapshot | null;
	recovery: { phase: string; dispatchState: string; storageError: { code: string; message: string } | null } | null;
}

/**
 * Projects one claimed fact onto its durable subject, synchronously.
 *
 * A committed receipt is deliberately *not* proven here: that needs file IO,
 * which runs in the send phase after this connection is closed, so the sent
 * message carries the verified view without any handle crossing an await.
 */
function resolveSubject(db: Database, kind: DeliveryKind, requestId: string): ResolvedSubject | null {
	const round = db.query("SELECT * FROM rounds WHERE request_id = ?").get(requestId) as Record<string, unknown> | null;
	if (round === null) {
		return null;
	}
	const taskId = typeof round["task_id"] === "string" ? round["task_id"] : null;
	const roundNumber = Number(round["round"]);
	if (taskId === null || !Number.isInteger(roundNumber)) {
		return null;
	}
	if (kind === "result") {
		return {
			taskId,
			round: roundNumber,
			snapshot: snapshotDeliveryResult(db, taskId, roundNumber),
			recovery: null,
		};
	}
	return {
		taskId,
		round: roundNumber,
		snapshot: null,
		recovery: {
			phase: typeof round["phase"] === "string" ? round["phase"] : "unknown",
			dispatchState: typeof round["dispatch_state"] === "string" ? round["dispatch_state"] : "unknown",
			storageError: parseStoredError(round["storage_error_json"]),
		},
	};
}

/**
 * Acknowledges a result fact that the host returned in-band, without any async
 * send or fake claim.
 *
 * Foreground `wb_task` returns the committed result directly in the tool
 * result; the host then reviews it. There is no async notification to consume,
 * and manufacturing a `sent` marker or a claim would falsify the outbox. This
 * path exists so that review can still close the loop honestly.
 *
 * Guard rails, all required:
 *  - the round must exist and belong to this OMP session (the originating
 *    session is the in-band recipient; a foreign session cannot have received
 *    an in-band result it never saw);
 *  - the current host session must equal the round's `owner_session`, and the
 *    caller's owner identity must be registered and active — the same rule
 *    `isOwnerActive` enforces elsewhere;
 *  - the round must have a first terminal outcome and a settled commit, so an
 *    in-flight round can never be marked received;
 *  - the evidence must be an explicit `host_review` with a non-empty reference
 *    to the review that actually happened.
 *
 * A plain async send remains unacknowledged by this path: without a review
 * reference it is refused. Idempotent for an already-acknowledged fact.
 */
export function acknowledgeReviewedResult(
	db: Database,
	input: {
		owner: OwnerIdentity;
		taskId: string;
		round: number;
		evidence: { at: number; reference: string };
	},
): { kind: "acked" | "refused"; reason?: DeliveryRefusal } {
	if (
		input.evidence === undefined ||
		typeof input.evidence.reference !== "string" ||
		input.evidence.reference.trim().length === 0 ||
		!Number.isFinite(input.evidence.at)
	) {
		return { kind: "refused", reason: "evidence_required" };
	}
	if (!isOwnerActive(db, input.owner)) {
		return { kind: "refused", reason: "owner_not_active" };
	}
	return withImmediate(db, () => {
		const row = readRound(db, input.taskId, input.round);
		if (row === null || typeof row["request_id"] !== "string" || row["request_id"] === "") {
			return { kind: "refused" as const, reason: "round_not_found" as const };
		}
		if (row["owner_session"] !== input.owner.sessionId) {
			return { kind: "refused" as const, reason: "foreign_session" as const };
		}
		if (row["outcome_json"] === null) {
			return { kind: "refused" as const, reason: "outcome_missing" as const };
		}
		if (row["commit_state"] === "pending") {
			return { kind: "refused" as const, reason: "commit_pending" as const };
		}
		const deliveryId = outboxDeliveryId(row["request_id"] as string, "result", RESULT_FACT_REVISION);
		const existing = db
			.query(`SELECT owner_session, acknowledged_at FROM outbox WHERE delivery_id = ?`)
			.get(deliveryId) as { owner_session: string; acknowledged_at: number | null } | null;
		if (existing === null) {
			return { kind: "refused" as const, reason: "delivery_not_found" as const };
		}
		if (existing.owner_session !== input.owner.sessionId) {
			return { kind: "refused" as const, reason: "foreign_session" as const };
		}
		if (existing.acknowledged_at !== null) {
			return { kind: "acked" as const };
		}
		const updated = db.run(
			`UPDATE outbox SET acknowledged_at = ?
			 WHERE delivery_id = ? AND owner_session = ? AND acknowledged_at IS NULL`,
			[input.evidence.at, deliveryId, input.owner.sessionId],
		);
		return updated.changes === 1
			? { kind: "acked" as const }
			: { kind: "refused" as const, reason: "revision_conflict" as const };
	});
}

/** One unacknowledged notification as a host inbox can display it. */
export interface DeliveryInboxItem {
	deliveryId: string;
	requestId: string;
	kind: DeliveryKind;
	revision: number;
	taskId: string | null;
	round: number | null;
	/** The host callback resolved for this OMP session. */
	sent: boolean;
	/** An explicit acknowledgement was recorded; delivered work may still need review. */
	received: boolean;
}

/**
 * Lists the OMP session's unacknowledged notifications without claiming them.
 *
 * This is the restart-safe inbox: a result sent before a crash stays visible as
 * pending review even though it is deliberately not auto-sent again. A foreign
 * OMP session sees nothing, because a different conversation is not a successor.
 */
export function listDeliveryInbox(db: Database, owner: OwnerIdentity, limit = 20): DeliveryInboxItem[] {
	const rows = db
		.query(
			`SELECT delivery_id, request_id, kind, revision, notified_generation, acknowledged_at
			 FROM outbox
			 WHERE owner_session = ? AND acknowledged_at IS NULL
			 ORDER BY revision ASC, delivery_id ASC LIMIT ?`,
		)
		.all(owner.sessionId, Math.max(1, Math.min(limit, 200))) as Array<{
		delivery_id: string;
		request_id: string;
		kind: DeliveryKind;
		revision: number;
		notified_generation: string | null;
		acknowledged_at: number | null;
	}>;
	return rows.map((row) => {
		// Every notification now names a delegated round: the help fact it used to
		// describe was removed with the help protocol it belonged to.
		const roundRow = db
			.query("SELECT task_id, round FROM rounds WHERE request_id = ?")
			.get(row.request_id) as { task_id: string; round: number } | null;
		const taskId = roundRow?.task_id ?? null;
		const round = roundRow?.round ?? null;
		return {
			deliveryId: row.delivery_id,
			requestId: row.request_id,
			kind: row.kind,
			revision: row.revision,
			taskId,
			round,
			sent: row.notified_generation !== null,
			received: row.acknowledged_at !== null,
		};
	});
}
