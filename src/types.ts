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
}

/** Lifecycle state of one delegated task. */
export type TaskStatus =
	| "running"
	| "awaiting_approval"
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
	/** Set when the terminal state could not be committed to disk. */
	storageError: TaskError | null;
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
	status: "verified" | "busy" | "auth_required" | "mismatch" | "unhealthy" | "unknown";
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
export type TaskStatusV3 =
	| "queued"
	| "running"
	| "awaiting_approval"
	| "awaiting_help"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

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
	| "native_state_unknown";

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
	/** New UUID per session switch; fencing compares generations, not names. */
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
