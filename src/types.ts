/**
 * Shared contracts for the OMP → WorkBuddy bridge.
 *
 * Every module in this extension agrees on these shapes, so they live in one
 * place rather than being restated per module.
 */

/** One bound WorkBuddy session within a project's session pool. */
export interface BoundSession {
	sessionId: string;
	role?: string;
	title?: string;
	isDefault?: boolean;
	/**
	 * WorkBuddy version observed for this member when it was enrolled.
	 *
	 * Kept per member because a roster can hold sessions that were created by
	 * different desktop versions, and the connection identity of one member must
	 * not be described with another member's version.
	 */
	workbuddyVersion?: string;
	/**
	 * Whether this member was verified live in the last reconciliation.
	 *
	 * A member can be enrolled from the desktop catalog without being reachable:
	 * it is then known to belong to this project, but nothing proves that a live
	 * worker owns it right now, so it must never be handed new work.
	 */
	verified?: boolean;
}

/** Stable identity of the WorkBuddy session a project delegates to. */
export interface Binding {
	/** Schema revision of this record. */
	version: 1 | 2;
	/** Absolute realpath of the project this binding belongs to. */
	projectRoot: string;
	/** WorkBuddy session UUID owned by the dedicated delegation session. */
	sessionId: string;
	/** WorkBuddy version observed when the binding was created. */
	workbuddyVersion: string;
	/** Session pool roster for multi-session support. */
	sessions?: BoundSession[];
	/**
	 * Whether the user consented to enrolling every verified session of this
	 * project automatically.
	 *
	 * The consent is project-wide and persistent: once given, a restart may
	 * re-enroll sessions opened later without asking again. It never authorizes
	 * a session belonging to another project.
	 */
	autoBindProjectSessions?: boolean;
}

/**
 * Lifecycle state of one delegated task.
 *
 * `queued` and `awaiting_help` exist because a task can be admitted before any
 * session runs it, and can be blocked on an OMP answer. Every consumer that
 * branches on status must therefore decide what those mean for it — notably that
 * neither is terminal, so a queued task is never reported as delivered.
 */
export type TaskStatus =
	| "queued"
	| "running"
	| "awaiting_approval"
	| "awaiting_help"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

/** Machine-readable failure recorded on a task receipt. */
export interface TaskError {
	code: string;
	message: string;
}

/**
 * The signed-in single-task lock as read back from disk.
 *
 * Only the fields the bridge reasons about are part of this contract; the
 * on-disk record keeps its own `acquiredAt` timestamp, which nothing depends on.
 */
export interface TaskLock {
	ownerPid: number;
	taskId: string;
}

/** One persisted task as listed by the history index, without its prompt or reply. */
export interface StoredTaskSummary {
	taskId: string;
	sessionId: string;
	round: number;
	status: TaskStatus;
	/** `receipt.json` modification time in milliseconds. */
	updatedAt: number;
}

/** A stored task that could not be read, reported without hiding the readable ones. */
export interface TaskListWarning {
	taskId: string;
	error: TaskError;
}

/**
 * Public view of one delegated task.
 *
 * Deliberately narrower than {@link TaskReceipt}: a view never carries the
 * prompt or the input snapshot list to a tool caller.
 */
export interface TaskView {
	taskId: string;
	sessionId: string;
	round: number;
	status: TaskStatus;
	summary: string;
	artifacts: FileArtifact[];
	error: TaskError | null;
	progress: string;
	awaitingApproval: boolean;
	ownedByCurrentProcess: boolean;
	/**
	 * Whether the terminal state has been durably committed.
	 *
	 * Separate from `status` because "the worker finished" and "the result is
	 * provably on disk" are different facts: a completed round whose receipt could
	 * not be written must not be presented as deliverable.
	 */
	commitState: "pending" | "committed" | "failed";
	/** True only for a `completed` round whose commit is `committed`. */
	readyForReview: boolean;
	/** Set when the terminal state could not be durably committed to disk. */
	storageError: TaskError | null;
	/**
	 * Why the task is waiting; `null` when it is executing or terminal.
	 *
	 * The reason is derived from queue state, never guessed from availability.
	 */
	waitReason: WaitReason | null;
	/**
	 * Queue/hold record ids backing `waitReason`.
	 *
	 * For a pool wait these are the WorkBuddy session ids that block the
	 * round; for a scope conflict it is the occupying work id.
	 */
	blockerIds: string[];
	/**
	 * The per-session facts behind a pool wait.
	 *
	 * Empty for every other kind of wait: only a pool decides among
	 * sessions, so only a pool has sessions to report.
	 */
	sessionBlockers: SessionBlocker[];
}

/** A single planned external action in a task goal. */
export interface ExternalAction {
	kind: "publish" | "deploy" | "cloud_write" | "schedule";
	target: string;
	operation: string;
	parameters: string;
}

/** Specification of the intent and boundaries for a task round. */
export interface TaskGoal {
	objective: string;
	context: string;
	constraints: string[];
	acceptance: string[];
	externalActions: ExternalAction[];
}

/** Snapshot of one input file provided for a round. */
export interface InputSnapshot {
	path: string;
	sha256: string | null;
}

/** Deliverable file produced or imported by a task round. */
export interface FileArtifact {
	kind: "file";
	path: string;
	sha256: string | null;
	bytes: number | null;
	role: "final" | "supporting";
	provenance: "native" | "imported" | "legacy_unverified";
	importedFrom: string | null;
}

/** One sequential round of interaction within a delegated task. */
export interface TaskRound {
	number: number;
	layout: "legacy" | "round";
	goal: TaskGoal;
	inputFiles: InputSnapshot[];
	expectedOutputs: string[];
	status: TaskStatus;
	summary: string;
	error: TaskError | null;
	artifacts: FileArtifact[];
	consent: {
		source: "host_dialog" | "user_command";
		at: string;
	} | null;
}

/** Durable record of one delegated task across all its execution rounds. */
export interface TaskReceipt {
	version: 2;
	taskId: string;
	sessionId: string;
	projectRoot: string;
	rounds: TaskRound[];
}

/** Caller-facing request to start or supplement a delegated task. */
export interface TaskRequest {
	goal: TaskGoal;
	inputFiles?: string[];
	expectedOutputs?: string[];
	taskId?: string;
	/**
	 * The model's claim that the user's own message asked for WorkBuddy.
	 *
	 * Only the tool's caller sees the conversation, so this is a declaration, not
	 * something the tool can verify — the plugin receives parameters, never the
	 * user's words. It is treated as advisory: true means "ask before choosing a
	 * route for an overlapping deliverable", absent means "the model's own idea, so
	 * delegate without a routing question". Both failure modes are mild (an extra
	 * prompt, or a delegation the user wanted anyway), which is why an unverified
	 * flag is acceptable here where an unverified approval would not be.
	 */
	requestedByUser?: boolean;
}

/** Explicit human confirmation authorizing a task round to execute. */
export interface RoundConfirmation {
	source: "host_dialog" | "user_command";
	at: string;
	sessionId: string;
	previousRound: number;
	inputs: { path: string; sha256: string }[];
}

/** Result of preparing a task round on disk. */
export interface PreparedTask {
	receipt: TaskReceipt;
	round: number;
	briefPath: string;
	outputsDir: string;
}

/** Self-reported remote external action outcome. */
export interface RemoteResult {
	kind: "publish" | "deploy" | "cloud_write" | "schedule";
	target: string;
	evidence: string;
	verification: "reported";
}

/** Structured review opinion by either OMP or WorkBuddy. */
export interface WorkReview {
	reviewer: "omp" | "workbuddy";
	round: number | null;
	artifacts: { path: string; sha256: string }[];
	verdict: "accepted" | "changes_requested" | "unverified";
	note: string;
	at: string;
}

/** Durable record of a collaboration unit between OMP and WorkBuddy. */
export interface WorkRecord {
	version: 1;
	workId: string;
	projectRoot: string;
	owner: "omp" | "workbuddy";
	source: "native" | "delegated";
	taskId: string | null;
	round: number | null;
	nativeRef: { sessionId: string; goalId: string | null } | null;
	title: string;
	scope: { readPaths: string[]; writePaths: string[] } | null;
	/**
	 * `waiting` is a published but not-yet-granted scope: visible in lists, never
	 * blocking. Only `active` and `blocked` participate in occupancy checks.
	 */
	state: "waiting" | "active" | "blocked" | "released";
	phase: string;
	milestone: string;
	blocker: string;
	updatedAt: string;
	revision: number;
	artifacts: FileArtifact[];
	remoteResults: RemoteResult[];
	reviews: WorkReview[];
}

/** Handlers a desktop session uses to surface agent activity and requests. */
export interface DesktopCallbacks {
	/** Delivers a `session/update` notification for the bound session. */
	onUpdate(params: DesktopSessionUpdate): Promise<void>;
	/**
	 * Answers an agent-initiated request.
	 *
	 * Returning `undefined` tells the caller the request is unsupported, which
	 * must fail closed rather than fabricate an answer.
	 */
	onRequest(method: string, params: unknown): Promise<unknown>;
}

/**
 * Parameters of a `session/update` notification.
 *
 * WorkBuddy emits `sessionUpdate: "session_info_update"` frames carrying
 * permission requests in `_meta`, so `_meta` is part of the contract.
 */
export interface DesktopSessionUpdate {
	sessionId: string;
	update: {
		sessionUpdate: string;
		[key: string]: unknown;
	};
	_meta?: Record<string, unknown> | null;
}

/** A verified WorkBuddy worker that could serve a project. */
export interface DesktopCandidate {
	/** Worker origin, e.g. `http://127.0.0.1:9523`. */
	endpoint: string;
	/** Session identity recovered from the worker's own state. */
	binding: Binding;
	/** True when another client currently holds the session's writer. */
	busy: boolean;
	/**
	 * The working directory the worker itself reports, when known.
	 *
	 * `binding.projectRoot` names the project the candidate was discovered
	 * *for*, which is this project for every candidate of one discovery run. The
	 * worker's own directory is what proves which project the session actually
	 * serves, so it is the field a pool must compare.
	 */
	cwd?: string;
}

/** What a read-only inspection of one worker's auxiliary HTTP surface found. */
export interface WorkerInspection {
	endpoint: string;
	/**
	 * Identity and health as reported by the worker's GET-only endpoints.
	 *
	 * `verified` means those endpoints agree about the bound session, this project
	 * and a healthy worker. It says nothing about ACP compatibility, which is only
	 * proven when a real delegation connects.
	 */
	status: "verified" | "busy" | "auth_required" | "mismatch" | "unhealthy" | "unknown" | "unreachable";
	workbuddyVersion: string | null;
}

/** Outcome of one prompt turn. */
export interface PromptOutcome {
	stopReason: string;
	errorMessage?: string;
}

/**
 * A live attachment to one WorkBuddy session.
 *
 * Implemented by the desktop client; declared here so consumers (and tests) can
 * depend on the contract without reaching into the transport module.
 */
export interface DesktopSession {
	/**
	 * Sends one turn and resolves when it finishes.
	 *
	 * Rejects with `WB_INTERRUPTED` if the stream dies before the turn ends; the
	 * turn is never silently retried.
	 */
	prompt(text: string): Promise<PromptOutcome>;
	/** Cancels the in-flight turn of this session only. */
	cancel(): Promise<void>;
	/** Releases this client's connection. Never stops the worker or its session. */
	close(): Promise<void>;
}

/** Lifecycle errors this extension reports to callers. */
export const WB_ERROR_CODE = {
	/** Another client or task owns the session or the project's task slot. */
	busy: "WB_BUSY",
	/** The worker refused the request as unauthenticated. */
	authRequired: "WB_AUTH_REQUIRED",
	/** No live worker matches the bound session. */
	sessionNotRunning: "WB_SESSION_NOT_RUNNING",
	/** The worker does not satisfy the ACP contract this extension needs. */
	protocolUnsupported: "WB_PROTOCOL_UNSUPPORTED",
	/** The stored binding is missing or malformed. */
	bindingInvalid: "WB_BINDING_INVALID",
	/** Task state on disk is missing or malformed. */
	taskStateInvalid: "WB_TASK_STATE_INVALID",
	/**
	 * Durable state could not be read or committed.
	 *
	 * Distinct from `taskStateInvalid`, which means the bytes on disk are
	 * present but wrong: this code means the filesystem operation itself failed,
	 * so nothing about the stored state can be trusted.
	 */
	storageError: "WB_STORAGE_ERROR",
	/** The requested task does not exist in this project. */
	taskNotFound: "WB_TASK_NOT_FOUND",
	/** A supplied path or filename is not acceptable. */
	inputInvalid: "WB_INPUT_INVALID",
	/** The session's stream ended before the turn finished. */
	interrupted: "WB_INTERRUPTED",
	/** Expected output files were not produced. */
	outputMissing: "WB_OUTPUT_MISSING",
	/** WorkBuddy reported a failure for the turn. */
	taskFailed: "WB_TASK_FAILED",
	/** The request needs an approval this client cannot faithfully obtain. */
	approvalUnsupported: "WB_APPROVAL_UNSUPPORTED",
	/** Explicit human consent is required before execution. */
	consentRequired: "WB_CONSENT_REQUIRED",
	/** A declared read or write scope conflicts with another active work record. */
	scopeConflict: "WB_SCOPE_CONFLICT",
	/** Target record was modified concurrently or expected revision did not match. */
	revisionConflict: "WB_REVISION_CONFLICT",
	/** An artifact's content hash changed since inspection or publication. */
	artifactChanged: "WB_ARTIFACT_CHANGED",
	/** Every queue arbitration retry lost to a concurrent writer's transaction. */
	queueBusy: "WB_QUEUE_BUSY",
	/** Old file-based state must be migrated before this project can dispatch. */
	migrationRequired: "WB_MIGRATION_REQUIRED",
	/** The OMP owner that holds a record is no longer the live generation. */
	ownerUnavailable: "WB_OWNER_UNAVAILABLE",
	/** A managed file could not be put into its intended state. */
	integrationIncomplete: "WB_INTEGRATION_INCOMPLETE",
} as const;

/** Builds a {@link TaskError} without restating the shape at each call site. */
export function taskError(code: string, message: string): TaskError {
	return { code, message };
}

/**
 * Extension error signaling operational or validation failures.
 * Callers branch on the machine-readable `code` property matching `WB_ERROR_CODE`.
 */
export class WbTaskError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WbTaskError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// v3 contracts (Stage 1–3 of the v2.1.0 rollout).
//
// The v2 runtime keeps the original names; stage 4 swaps these over and drops
// the suffix in one cutover.
// ---------------------------------------------------------------------------

/** Lifecycle state of one delegated task under the persistent-queue model. */
/** The queue model shares the task-status vocabulary; kept as an alias. */
export type TaskStatusV3 = TaskStatus;

/**
 * Why one enrolled WorkBuddy session cannot take a task right now.
 *
 * These are the *per-session* facts behind a pool wait. They are distinct from
 * the wait reason itself: the reason is the single sentence a user acts on,
 * while these say which session is busy, which one is not answering, and which
 * one is already spoken for.
 */
export type SessionBlockerReason =
	/** The session is running another task. */
	| "session_busy"
	/** The session is offline, or nothing proves a live worker owns it. */
	| "session_unavailable"
	/** The session already carried another task's work, so it is not clean. */
	| "already_used_by_other_task"
	/** The session's ownership of this project was disproved. */
	| "ownership_conflict"
	/** The session's native state is unknown, so it may not be reused. */
	| "native_state_unknown";

/** One session that blocks a queued round, and why. */
export interface SessionBlocker {
	sessionId: string;
	reason: SessionBlockerReason;
}

/**
 * Why a pool round is waiting; the host shows this to the user verbatim.
 *
 * The reasons name the *kind* of wait, so the advice that follows is the
 * action that actually unblocks it. A mixed pool of busy and offline sessions
 * is one wait with one action, and is named as such instead of being
 * misreported as a pool that has been used up.
 */
export type PoolWaitReason =
	/**
	 * The project has no enrolled WorkBuddy session at all.
	 *
	 * The remedy is to open one; nothing about the pool's capacity is known
	 * yet, so this says exactly that and claims nothing more.
	 */
	| "no_enrolled_session"
	/**
	 * Every enrolled session has already carried a task.
	 *
	 * A finished conversation is never reused for an unrelated one, so the
	 * remedy is to open another session for this project.
	 */
	| "no_unused_session"
	/** Every eligible session is busy right now. */
	| "all_sessions_busy"
	/** Every eligible session is offline or its state is unknown. */
	| "sessions_unavailable"
	/**
	 * Some sessions are busy and others are not answering.
	 *
	 * This is a transient wait: the round runs as soon as one of them frees
	 * up, and no new session is needed.
	 */
	| "sessions_busy_or_unavailable"
	/** Every eligible session's ownership of this project was disproved. */
	| "ownership_conflict"
	/** Every eligible session's native state is unknown. */
	| "native_state_unknown";

/**
 * Why a task is waiting, derivable from queue state rather than guessed.
 *
 * `programming_help` covers both an open help request and a confirmed
 * continuation that has not resumed the parent work yet.
 */
export type WaitReason =
	| "session_busy"
	| "scope_conflict"
	| "session_unavailable"
	| "owner_unavailable"
	| "programming_help"
	| "native_state_unknown"
	| PoolWaitReason;

/**
 * Where a round may execute.
 *
 * A user-picked session — and every supplemental round — pins one WorkBuddy
 * session; a pool confirmation delegates the choice to dispatch and lets
 * later-verified sessions join the work.
 */
export type TargetPolicy =
	| { kind: "session"; sessionId: string }
	| { kind: "workspace_pool"; role: string | null };

/** Immutable identity of one bridge activation inside one OMP session. */
export interface OwnerIdentity {
	/** OMP session id from `ctx.sessionManager.getSessionId()`. */
	sessionId: string;
	/** Fresh UUID for this activation's ownership of one stable OMP session. */
	generation: string;
	processId: number;
	/** UUID generated once per activation instance. */
	instanceId: string;
}

/** Fine-grained lifecycle phase; terminal status lives in {@link TaskStatusV3}. */
export type TaskPhase =
	| "queued"
	| "preparing"
	| "running"
	| "awaiting_approval"
	| "awaiting_help"
	| "committing"
	| "terminal"
	| "recovery_required";

/** Whether the two-phase terminal commit has landed for the current round. */
export type CommitState = "pending" | "committed" | "failed";

/** Current acceptance standing; historical reviews are kept separately. */
export type ReviewState = "pending" | "accepted" | "changes_requested" | "unverified";

/** How the user wants to receive progress: blocking the tool call or not. */
export type DeliveryMode = "foreground" | "background";

/** One armed prompt attempt recorded on a round. */
export interface TurnAttemptV3 {
	attemptId: string;
	kind: "primary" | "help_resume";
	/** SHA-256 of the exact prompt bytes; arm before send, never rewritten. */
	promptSha256: string;
	/** ISO timestamp of the confirmation that armed this attempt. */
	consentAt: string;
	stopReason: string | null;
}

/** Fence that ties a written receipt to the terminal DB commit. */
export interface CommitTokenV3 {
	requestId: string;
	resultRevision: number;
}

/**
 * One round of a v3 receipt.
 *
 * `turns` records only attempts that were actually armed; a cancellation
 * between approval and send legitimately leaves `[]`. `legacy` rounds keep
 * unknown evidence as `null`/`[]` — never a fabricated approval.
 */
export interface TaskRoundV3 {
	number: number;
	layout: "legacy" | "round";
	goal: TaskGoal;
	inputFiles: InputSnapshot[];
	expectedOutputs: string[];
	status: TaskStatusV3;
	summary: string;
	error: TaskError | null;
	artifacts: FileArtifact[];
	recordKind: "approved" | "legacy";
	requestId: string;
	targetPolicy: TargetPolicy;
	/** Root of the frozen input snapshot: the directory containing `inputs/`. */
	snapshotRoot: string;
	owner: OwnerIdentity | null;
	manifestSha256: string | null;
	commitToken: CommitTokenV3 | null;
	turns: TurnAttemptV3[];
	consent: {
		source: "host_dialog" | "user_command";
		at: string;
	} | null;
}

/**
 * Durable record of one delegated task under the queue model.
 *
 * Receipts stay ordinary files; the database row carries the same evidence and
 * the migration parser is the only writer of `legacy` rounds.
 */
export interface TaskReceiptV3 {
	version: 3;
	taskId: string;
	/** Owning OMP session id, or `null` for legacy/imported rounds. */
	sessionId: string | null;
	projectRoot: string;
	rounds: TaskRoundV3[];
}

/** Explicit human confirmation authorizing a round under the queue model. */
export interface RoundConfirmationV3 {
	source: "host_dialog" | "user_command";
	at: string;
	/** Supersedes the v2 single `sessionId`: pool confirmations are allowed. */
	targetPolicy: TargetPolicy;
	/** Unique request this confirmation belongs to; staging keys off it. */
	requestId: string;
	/**
	 * SHA-256 of the manifest payload the human confirmed, computed by
	 * `buildTaskManifestPayload` + `hashManifestPayload` before the dialog so
	 * `stageTask` can verify the staged copies against exactly that digest.
	 */
	manifestSha256: string;
	owner: OwnerIdentity;
	previousRound: number;
	inputs: { path: string; sha256: string }[];
	/** User-selected delivery preference for this round; runtime may change it. */
	deliveryMode: DeliveryMode;
}

/**
 * Public view of one delegated task under the queue model.
 *
 * Terminal status, the commit pipeline and the current effective review are
 * three different facts and are never folded into one field.
 */
export interface TaskViewV3 {
	taskId: string;
	/** Owning OMP session id when known; legacy/imported rounds are `null`. */
	sessionId: string | null;
	round: number;
	status: TaskStatusV3;
	phase: TaskPhase;
	summary: string;
	artifacts: FileArtifact[];
	error: TaskError | null;
	progress: string;
	awaitingApproval: boolean;
	ownedByCurrentProcess: boolean;
	/** Why the task is waiting; `null` when it is executing or terminal. */
	waitReason: WaitReason | null;
	/** Queue/hold record ids backing `waitReason`. */
	blockerIds: string[];
	/** The per-session facts behind a pool wait; empty for every other wait. */
	sessionBlockers: SessionBlocker[];
	requestId: string;
	commitState: CommitState;
	reviewState: ReviewState;
	/** Why the current files no longer match the accepted review, if so. */
	reviewInvalidationReason: "artifact_changed" | "artifact_missing" | null;
	/** True only for `completed` rounds whose commit is `committed`. */
	readyForReview: boolean;
	/** Set when the terminal state could not be committed to disk. */
	storageError: TaskError | null;
}

/** One frozen input file inside a manifest payload. */
export interface ManifestInput {
	/** Original project-relative path of the source file. */
	path: string;
	/** Snapshot path relative to the stage root (never absolute, never hashed). */
	snapshotPath: string;
	bytes: number;
	sha256: string;
}

/** The digest-bearing half of a stage manifest; this object alone is hashed. */
export interface TaskManifestPayload {
	version: 1;
	projectRoot: string;
	requestId: string;
	taskId: string;
	round: number;
	owner: OwnerIdentity;
	goal: TaskGoal;
	targetPolicy: TargetPolicy;
	expectedOutputs: string[];
	/** Sorted by canonical relative path; the sort order is part of the digest. */
	inputs: ManifestInput[];
	deliveryMode: DeliveryMode;
}

/** Who approved the payload; excluded from the payload digest itself. */
export interface ManifestApproval {
	source: "host_dialog" | "user_command";
	at: string;
	payloadSha256: string;
}

/** Result of staging one frozen input snapshot for a round. */
export interface StagedTask {
	/** Directory containing `inputs/`; recorded on the round, never hashed. */
	snapshotRoot: string;
	/** Absolute path to `manifest.json` inside the stage. */
	manifestPath: string;
	/** SHA-256 of the canonical manifest payload, equal to the confirmed value. */
	manifestSha256: string;
	manifest: {
		payload: TaskManifestPayload;
		approval: ManifestApproval;
	};
}

/** Where a recorded authorization came from; never supplied by a model. */
export type AuthorizationSource = "host_dialog" | "user_command";

// ---------------------------------------------------------------------------
// Criterion-level review and one-task correction (G06)
// ---------------------------------------------------------------------------

/** One acceptance criterion's verdict, as the reviewing OMP actually observed it. */
export interface TaskReviewFinding {
	criterion: string;
	status: "passed" | "failed" | "blocked";
	/** What was observed, in the reviewer's words. Never empty. */
	note: string;
	/** Concrete evidence references (a command, a diff, a file digest). */
	evidence: string[];
}

/** One immutable review of one round's artifact byte set. */
export interface TaskReviewRecord {
	reviewId: string;
	taskId: string;
	round: number;
	findings: TaskReviewFinding[];
	verdict: "accepted" | "changes_requested" | "unverified";
	artifacts: Array<{ path: string; sha256: string }>;
	reviewer: OwnerIdentity;
	reviewedAt: number;
}

/** The standing of the newest review against the bytes that are on disk now. */
export interface EffectiveTaskReview {
	review: TaskReviewRecord;
	/**
	 * True only when the verdict still describes the current bytes: every reviewed
	 * artifact is present and unchanged.
	 */
	effective: boolean;
	invalidation: "artifact_changed" | "artifact_missing" | null;
}

/** The frozen plan for a task's one automatic correction. */
export interface CorrectionPlan {
	version: 1;
	taskId: string;
	reviewId: string;
	/** Round the review judged; the correction is the next round of the same task. */
	baseRound: number;
	targetRound: number;
	/** Deterministic per (task, review), so a retry cannot create a second round. */
	requestId: string;
	/** Carries the original goal with the defect context appended; nothing else moves. */
	request: TaskRequest;
	/** Frozen bytes the correction must work from, project-relative with digests. */
	inputs: { path: string; sha256: string }[];
	/** The approval the correction continues, recorded so it can be revalidated. */
	baseAuthorization: { requestId: string; manifestSha256: string; source: string; at: string; ownerSession: string };
	failedCriteria: TaskReviewFinding[];
}

/** Result of reserving (or refusing) a task's one correction. */
export type CorrectionReservation =
	| { kind: "reserved"; plan: CorrectionPlan }
	| { kind: "existing"; plan: CorrectionPlan }
	| { kind: "needs_human"; reason: string };

/** Stable identifiers are UUIDs so they survive restarts and cross-process use. */
export type PackageId = string;
export type TaskId = string;
export type RequestId = string;
export type AttemptId = string;
export type ContinuationId = string;
/**
 * The exact subject one operator recovery act is about.
 *
 * Every field is a fact that identifies *one* round and nothing else: the
 * round's own identity, the attempt that may have reached WorkBuddy, the
 * session it ran on, the identity that owned it, the manifest the human
 * approved and the first business outcome the queue recorded. A recovery that
 * acts on a different subject is a different act, so the subject is frozen
 * before the human is asked and compared again inside the commit.
 *
 * The subject is a snapshot, never a live view: it is read in one scope,
 * closed, and only then compared.
 */
export interface RecoverySubject {
	taskId: string;
	round: number;
	requestId: string;
	/** The armed attempt, or `null` for a round that was never sent. */
	attemptId: string | null;
	/** The WorkBuddy session the round actually ran on. */
	sessionId: string | null;
	/** The identity that owned and executed the round. */
	ownerSession: string;
	ownerGeneration: string;
	/** The executor instance of that owner generation. */
	executorInstance: string;
	/** Digest of the approved manifest the queue fenced on. */
	manifestSha256: string;
	/** Digest of the recorded first business outcome. */
	outcomeSha256: string;
	/**
	 * Digest of the confirmed receipt, when the subject names one.
	 *
	 * A release acts on a *committed* receipt, so its subject names the digest
	 * the queue already confirmed; a repair freezes before the receipt exists
	 * and names nothing.
	 */
	receiptSha256: string | null;
	/** The round's revision at the time the subject was frozen. */
	revision: number;
}

/**
 * One human's explicit, one-shot consent to a recovery act.
 *
 * The consent names the subject it was given for. A consent whose subject no
 * longer matches the round is refused inside the transaction, because a human
 * answered a question about *that* round and not about whatever the round
 * became afterwards.
 */
export interface RecoveryConsent {
	/** Exactly `true`; anything else (including a truthy non-boolean) is a refusal. */
	confirmed: true;
	/** ISO timestamp of the human's answer. */
	at: string;
	/** The subject the human was shown. */
	subject: RecoverySubject;
}

/**
 * The proof that an original execution owner is gone.
 *
 * A database row that says "inactive" is a declaration; it is not proof. The
 * owner's registered OS process must also be gone. Only both together make a
 * recovery by somebody else lawful.
 */
export interface OwnerDeathProof {
	/** The original owner's session id. */
	sessionId: string;
	generation: string;
	instanceId: string;
	/** The OS process id the owner registered. */
	processId: number;
	/** How the owner's registration ended. */
	state: "inactive" | "dead";
	/** True when the OS proved that process id no longer exists. */
	pidGone: true;
	/** When the proof was taken. */
	provedAt: number;
}

/**
 * Authorization to recover a round whose original owner is gone.
 *
 * This is the only way a *different* operator may act on a round. It carries
 * the actual operator, the immutable original owner, the exact subject, the
 * human's consent and the death proof — and the queue checks all of it inside
 * the commit transaction, so a forged or stale grant cannot commit anything.
 */
export interface OperatorRecoveryAuthorization {
	kind: "operator_recovery";
	/** The operator who is actually performing the recovery right now. */
	operator: OwnerIdentity;
	/** The original owner, unchanged by the recovery. */
	originalOwner: OwnerIdentity;
	/** Proof that the original owner's process is gone. */
	deathProof: OwnerDeathProof;
	/** The exact subject the human consented to. */
	subject: RecoverySubject;
	/** The human's one-shot consent for that subject. */
	consent: RecoveryConsent;
	/** When the operator asked the human. */
	requestedAt: number;
}

/**
 * Who is authorized to commit one round's receipt.
 *
 * The ordinary path is the round's own owner: it needs no extra grant, because
 * the round's owner row is already the authority. The recovery path is a
 * different human acting on a round whose original owner is provably gone,
 * and it carries its own explicit, one-shot authorization.
 *
 * The two are different shapes on purpose: a recovery can never be expressed
 * as "a host dialog said yes".
 */
export type ReceiptAuthorization =
	| { kind: "owner"; owner: OwnerIdentity }
	| { kind: "operator_recovery"; recovery: OperatorRecoveryAuthorization };

/**
 * Authorization to release one quarantined execution.
 *
 * Releasing is not the same act as repairing: it is the human's separate
 * observation that the remote execution really stopped. It therefore carries
 * its own end observation and its own one-shot consent, and it never accepts a
 * repaired local receipt as proof that the worker stopped.
 *
 * The two variants are different acts, not two spellings of one:
 *
 *  - `owner_release`: the round's own originating session releases its own
 *    round. Its authority is the round's owner row, exactly as it always was.
 *  - `quarantine_release`: a *different* human releases a round whose original
 *    owner is provably gone. It carries the exact subject and the one-shot
 *    consent, and the queue checks them inside the release transaction.
 */
export type QuarantineReleaseAuthorization =
	| {
			kind: "owner_release";
			/** The originating session's live identity. */
			owner: OwnerIdentity;
			/** The human's own end observation. */
			verification: { source: "host_dialog"; at: string; evidence: string };
	  }
	| {
			kind: "quarantine_release";
			/** The operator who is actually performing the release right now. */
			operator: OwnerIdentity;
			/** The original owner of the round, unchanged by the release. */
			originalOwner: OwnerIdentity;
			/** Proof that the original owner's process is gone, when it is not the operator. */
			deathProof: OwnerDeathProof | null;
			/** The exact subject the human consented to. */
			subject: RecoverySubject;
			/** The human's one-shot consent for that subject. */
			consent: RecoveryConsent;
			/**
			 * The human's explicit observation that the remote execution stopped.
			 *
			 * This is separate evidence from the receipt: a committed local receipt
			 * proves what the round *decided*, never that the worker stopped.
			 */
			endObservation: {
				source: "host_dialog";
				at: string;
				evidence: string;
			};
			/** When the operator asked the human. */
			requestedAt: number;
	  };

/** Everything one durable commit needs, independent of the host's task object. */
export interface DurableCommitInput {
	projectRoot: string;
	taskId: string;
	/** Round being committed. Supplemental rounds write and confirm their own row. */
	round: number;
	requestId: string;
	/** The round as recorded on the receipt; its status is the outcome being committed. */
	status: "completed" | "failed" | "cancelled" | "interrupted";
	error: TaskError | null;
	receiptSha256: string;
	/**
	 * Recovery authorization, rechecked inside the receipt transaction.
	 * Ordinary terminal commits use the round's existing execution authority.
	 */
	authorization?: ReceiptAuthorization;
	/** Ephemeral cancellation of a pending recovery; never persisted. */
	signal?: AbortSignal;
}

/** What one durable commit did. */
export interface DurableCommitResult {
	committed: boolean;
	/** Why it did not commit; `null` on success. */
	reason: string | null;
}
