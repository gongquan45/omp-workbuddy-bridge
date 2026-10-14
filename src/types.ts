/**
 * Shared contracts for the OMP → WorkBuddy bridge.
 *
 * Every module in this extension agrees on these shapes, so they live in one
 * place rather than being restated per module.
 */

/** Stable identity of the WorkBuddy session a project delegates to. */
export interface Binding {
	/** Schema revision of this record. */
	version: 1;
	/** Absolute realpath of the project this binding belongs to. */
	projectRoot: string;
	/** WorkBuddy session UUID owned by the dedicated delegation session. */
	sessionId: string;
	/** WorkBuddy version observed when the binding was created. */
	workbuddyVersion: string;
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
	status: TaskStatus;
	summary: string;
	artifacts: string[];
	error: TaskError | null;
	progress: string;
	awaitingApproval: boolean;
	ownedByCurrentProcess: boolean;
	/** Set when the terminal state could not be committed to disk. */
	storageError: TaskError | null;
}

/** Durable record of one delegated task. */
export interface TaskReceipt {
	version: 1;
	taskId: string;
	sessionId: string;
	projectRoot: string;
	status: TaskStatus;
	/** The instruction sent to WorkBuddy for this task. */
	prompt: string;
	/** Project-relative paths snapshotted into the task's `inputs/` directory. */
	inputFiles: string[];
	/** `outputs/`-relative filenames WorkBuddy is expected to produce. */
	expectedOutputs: string[];
	/** WorkBuddy's accumulated reply text. */
	summary: string;
	/** Absolute paths of files collected from the task's `outputs/` directory. */
	artifacts: string[];
	error: TaskError | null;
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
} as const;

/** Builds a {@link TaskError} without restating the shape at each call site. */
export function taskError(code: string, message: string): TaskError {
	return { code, message };
}
