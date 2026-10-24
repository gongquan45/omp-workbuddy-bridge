/**
 * OMP entry point for the WorkBuddy bridge.
 *
 * Registers one command (`/wb`) and three tools (`wb_task`, `wb_status`,
 * `wb_cancel`). Delegation attaches to an existing dedicated WorkBuddy desktop
 * session, so the real desktop agent — with its native skills, plugins and
 * permissions — does the work, and the project gets back the reply plus the
 * actual files.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { connect, discover, inspectWorkers, type DesktopSession } from "./desktop-client";
import { atomicWriteFile } from "./storage";
import {
	enableProject,
	inspectProjectMarker,
	openProjectQueue,
	closeQueueConnection,
	openWriteConnection,
	openReadConnection,
	registerOwner,
	withImmediate,
	readProjectAccess,
	type ProjectAccess,
	type AbandonedRound,
	type QueueSnapshot,
	type TaskWaitState,
} from "./queue";
import {
	listBoundSessions,
	reconcileProjectBinding,
	bindingForSession,
	readProjectSessionCatalog,
	workBuddyHomeDir,
} from "./session-pool";
import {
	resolveProjectContext,
	type ProjectResolution,
	type ProjectResolutionOptions,
} from "./project-context";
import { commandDescription, completionChoices, parseCommand, usageListing } from "./command-spec";
import { applyIntegration, planIntegration, setupTargets } from "./integration";
import { readStagedManifest, writeRoundReceipt } from "./tasks";
import {
	commitDurableRound,
	readOperatorRecoveryTarget,
	repairRoundReceipt,
	repairRoundReceiptAsOperator,
} from "./receipts";
import {
	acknowledgeReviewedResult,
	flushDelivery,
	listDeliveryInbox,
	readDeliveryPolicy,
	publishDelivery,
	readDeliveryResult,
	resolveWaitEnd,
	setDeliveryMode,
	RESULT_FACT_REVISION,
	type DeliveryInboxItem,
	type DeliveryMessage,
} from "./delivery";
import {
	reserveTaskCorrection,
	submitTaskReview,
	validateTaskCorrection,
} from "./delegation";
import {
	nextPage,
	previousPage,
	renderWorkbench,
	withCounts,
	WORKBENCH_PAGES,
	type WorkbenchPage,
} from "./workbench";
import { logEvent } from "./logging";
import { migrateProjectToQueue } from "./migration";
import {
	buildConfirmationDigest,
	buildTaskManifestPayload,
	collectArtifacts,
	computeFileSha256,
	currentRound,
	hashManifestPayload,
	isPidAlive,
	renderTaskPrompt,
	readBinding,
	readTask,
	readTaskIndex,
	readTaskLock,
	resolveRoundPaths,
	stageTask,
	statusIsInFlight,
	toTaskReceiptView,
	WbTaskError,
	writeBinding,
} from "./tasks";
import { readAllWorkRecords } from "./collaboration";
import {
	type Binding,
	type DesktopCallbacks,
	type DesktopCandidate,
	type DesktopSessionUpdate,
	type FileArtifact,
	type RoundConfirmationV3,
	type SessionBlocker,
	type StoredTaskSummary,
	type TaskError,
	type TaskGoal,
	type TaskListWarning,
	type TaskLock,
	type OwnerIdentity,
	type OwnerDeathProof,
	type QuarantineReleaseAuthorization,
	type RecoveryConsent,
	type RecoverySubject,
	type StagedTask,
	type TaskReceipt,
	type TaskReceiptV3,
	type TaskRequest,
	type TaskStatus,
	type TargetPolicy,
	type TaskView,
	type WorkerInspection,
	WB_ERROR_CODE,
	taskError,
} from "./types";

/** Status key so concurrent tasks do not fight over the footer. */
const STATUS_KEY = "workbuddy";
/** Widget key for the per-task progress row; the status line keeps the summary. */
const WIDGET_KEY = "workbuddy-progress";

/**
 * Budget for `/wb doctor`'s worker probe.
 *
 * A command is interactive: reporting "the worker did not answer in time" is useful,
 * waiting indefinitely is not. The tool keeps using the caller's signal instead.
 */
const DOCTOR_PROBE_MS = 2500;

/** Default `wb_status` poll window, in milliseconds. */
const DEFAULT_WAIT_MS = 1_000;

/** Upper bound a caller may request from `wb_status`. */
const MAX_WAIT_MS = 30_000;

/**
 * Deliverable extensions OMP can also produce with its own skills.
 *
 * When a delegation targets one of these, "send it to WorkBuddy" is a choice
 * rather than a necessity, so the user is asked instead of the model deciding.
 * Formats outside this set (`.pptx` templates WorkBuddy owns, Tencent-product
 * artifacts) stay unambiguous and are delegated without a prompt.
 */
const WORKBUDDY_OVERLAPPING_OUTPUTS = /\.(?:docx?|pdf|md|markdown|csv|xlsx?)$/i;

const WB_WORKFLOW_OPTION = "Send it to WorkBuddy";
const LOCAL_WORKFLOW_OPTION = "Keep it in this session";

/**
 * A foreground observation window, not a deadline for the worker. Input, steer
 * or expiry ends only this wait; durable foreground delivery stays selected.
 */
const FOREGROUND_WAIT_MS = 30_000;

/**
 * How long a cancellation keeps its connection open so the worker can finish
 * the cancelled turn.
 *
 * `session/cancel` is a one-way notification, so the reply never confirms that
 * the worker actually wound the turn down. Closing the connection at that
 * moment leaves the worker's session believing a turn is still in flight, and
 * every later prompt then queues behind it forever. Waiting a bounded moment
 * for the turn's own terminal event avoids that, and the bound keeps a wedged
 * worker from holding the cancellation open indefinitely.
 */
const CANCEL_SETTLE_MS = 5_000;

/** Longest tool-input rendering shown in an approval prompt. */
const APPROVAL_INPUT_LIMIT = 400;

/**
 * Name under which the desktop client forwards permission requests.
 *
 * WorkBuddy's own form is an `interruption_request` session update carrying
 * `_meta["codebuddy.ai/interruptionRequest"]`; the standard ACP request shape is
 * forwarded under its own method name. Both arrive here.
 */
const INTERRUPTION_METHOD = "codebuddy.ai/interruptionRequest";

/** WorkBuddy's own decision words, as verified against the worker. */
const DECISION_ALLOW = "allow";
const DECISION_DENY = "deny";


interface FrozenDraft {
	requestId: string;
	projectRoot: string;
	/**
	 * The authorized target policy of this draft.
	 *
	 * A new task is authorized against the project's whole pool, so the policy is
	 * `workspace_pool`; the concrete WorkBuddy session is chosen by the queue at
	 * claim time and is never fixed here. A supplement keeps the concrete session
	 * its task is pinned to.
	 */
	targetPolicy: TargetPolicy;
	previousRound: number;
	taskId?: string;
	/** The id this draft's digest was computed for; dispatch must reuse it. */
	taskIdForRound: string;
	goal: TaskGoal;
	inputFiles: Array<{ path: string; sha256: string; bytes: number }>;
	expectedOutputs: string[];
	/** Digest of the exact payload the dialog is asking a human to approve. */
	manifestSha256: string;
	rawRequest: TaskRequest;
	createdAt: string;
	/**
	 * The OMP identity that staged this draft.
	 *
	 * A confirmation belongs to the conversation that asked for it: a draft staged
	 * by another OMP session (or by an earlier generation of this one) must not be
	 * submitted from here.
	 */
	owner: OwnerIdentity;
}

/**
 * How long a shutdown waits for the background work a commit handed off to.
 *
 * The work is finished before the activation returns, so the project's files
 * may be released. The bound is a backstop: a follow-up that waits for the
 * worker's turn to end must not keep the shutdown open forever.
 */
const SHUTDOWN_BACKGROUND_WAIT_MS = 2_000;

/** Parameters accepted by the `wb_status` tool. */
interface WbStatusParams {
	taskId: string;
	waitMs?: number;
}


/**
 * The text of a tool result, for surfaces that speak in messages rather than JSON.
 *
 * A command that re-derived its own wording from `details` would be a second answer to
 * the same question; reusing the tool's text keeps them identical by construction.
 */
function resultText(result: AgentToolResult<unknown>): string {
	const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;
	const text = blocks.find((block) => block.type === "text" && typeof block.text === "string")?.text;
	if (text !== undefined) {
		return text;
	}
	const details = result.details;
	return details === undefined ? "" : JSON.stringify(details, null, 2);
}

/** Parameters accepted by the `wb_cancel` tool. */
interface WbCancelParams {
	taskId: string;
}

/** Parameters accepted by the `wb_review` tool. */
interface WbReviewParams {
	taskId: string;
	round?: number;
	verdict: "accepted" | "changes_requested" | "unverified";
	findings: Array<{ criterion: string; status: "passed" | "failed" | "blocked"; note: string; evidence: string[] }>;
	artifacts: Array<{ path: string; sha256: string }>;
}

/** Parameters accepted by the `wb_tasks` tool. */
interface WbTasksParams {
	status?: string;
	limit?: number;
	offset?: number;
}

/** Default page size for `wb_tasks`. */
const DEFAULT_TASK_PAGE = 20;

/** Largest page `wb_tasks` will return in one call. */
const MAX_TASK_PAGE = 100;

/** Every state a receipt may be in, for validating `wb_tasks` input. */
const TASK_STATUSES: readonly string[] = [
	"running",
	"awaiting_approval",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
];

/** One finding from `wb_doctor`, with the action that resolves it. */
interface DiagnosticIssue {
	severity: "warning" | "error";
	code: string | null;
	message: string;
	nextAction: string;
}

/**
 * Collaborators the entry point uses, so tests can substitute them without
 * patching modules globally.
 *
 * Production code passes nothing and gets the real implementations.
 */
export interface BridgeOverrides {
	discover?: (projectRoot: string, signal: AbortSignal) => Promise<DesktopCandidate[]>;
	/**
	 * Overrides the WorkBuddy global config directory.
	 *
	 * Setup writes ; tests must never touch the real
	 * user home, so they inject a project-local directory instead.
	 */
	workbuddyHomeDir?: string;
	connect?: (
		binding: Binding,
		callbacks: DesktopCallbacks,
		signal: AbortSignal,
	) => Promise<DesktopSession>;
	readBinding?: (projectRoot: string) => Promise<Binding | null>;
	writeBinding?: (binding: Binding) => Promise<void>;
	readTask?: (projectRoot: string, taskId: string) => Promise<TaskReceipt>;
	collectArtifacts?: (receipt: TaskReceipt) => Promise<{ artifacts: FileArtifact[]; missingOutputs: string[] }>;
	readTaskIndex?: (
		projectRoot: string,
	) => Promise<{ entries: StoredTaskSummary[]; warnings: TaskListWarning[] }>;
	readTaskLock?: (projectRoot: string) => Promise<TaskLock | null>;
	inspectWorkers?: (binding: Binding, signal: AbortSignal) => Promise<WorkerInspection[]>;
	/**
	 * Overrides how long a cancellation keeps its connection open for the worker
	 * to finish winding the turn down.
	 *
	 * Exposed for tests, which cannot spend the real budget on every case.
	 */
	cancelSettleMs?: number;
	/**
	 * Overrides how long one `wb_task` call waits for the durable commit.
	 *
	 * Exposed for tests, which must not spend the real foreground budget on every
	 * case that holds a turn open.
	 */
	foregroundWaitMs?: number;
	/**
	 * Overrides staging.
	 *
	 * Dispatch stages before it does anything durable, so a host-level test that
	 * needs a controllable receipt or a fabricated brief injects here rather than
	 * standing up real files.
	 */
	stageTask?: (
		root: string,
		confirmation: RoundConfirmationV3,
		request: TaskRequest,
		taskId: string,
		round: number,
	) => Promise<StagedTask>;
	writeRoundReceipt?: (
		projectRoot: string,
		taskId: string,
		round: number,
		layout: "legacy" | "round",
		receipt: unknown,
	) => Promise<{ receiptPath: string; sha256: string; bytes: number }>;
	migrateProject?: (projectRoot: string) => Promise<string>;
	readProjectAccess?: (projectRoot: string) => Promise<ProjectAccess | null>;
	/**
	 * Overrides project-context resolution.
	 *
	 * The resolver itself is real code with its own suite; this seam exists for
	 * host-level tests that must express a binding relationship without laying
	 * down real project state (and without loosening the resolver's contract).
	 */
	resolveProjectContext?: (cwd: string, options: ProjectResolutionOptions) => Promise<ProjectResolution>;
	enableProject?: (projectRoot: string) => Promise<string> | string;
	whichBun?: (command: string) => string | null;
}

/** A task this OMP process currently owns and is tracking. */
interface ActiveTask {
	taskId: string;
	receipt: TaskReceipt;
	/** Null until the session is attached; a failed attach never gets this far. */
	session: DesktopSession | null;
	abort: AbortController;
	/**
	 * Context captured when the task started.
	 *
	 * The turn outlives the tool call that began it, so later updates and
	 * approvals must publish through the context that was live at the start.
	 */
	ctx: ExtensionContext;
	/** Resolves when the turn reaches a terminal state. */
	settled: Promise<void>;
	/**
	 * The single in-flight terminal commit, if one has started.
	 *
	 * Every terminal path joins this instead of writing its own receipt, so the
	 * first observed terminal state wins and later successes or failures cannot
	 * rewrite it, re-cancel, re-release or re-close anything.
	 */
	finalization: Promise<void> | null;
	/**
	 * Resolves the moment a terminal commit begins.
	 *
	 * A waiter that started before the commit exists cannot see `finalization`
	 * yet, so it watches this instead of racing an already-resolved placeholder.
	 * It never rejects, so a failed commit cannot surface as an unhandled error.
	 */
	committed: Promise<void>;
	/** Resolves {@link committed}; called once, when the commit settles. */
	markCommitted: () => void;
	/** The commit attempt has settled; a terminal in-memory status alone is not proof. */
	commitSettled: boolean;
	/**
	 * Resolves when the prompt turn's outcome is known.
	 *
	 * `session/cancel` is a one-way notification: the reply never confirms that
	 * the worker wound the turn down, and closing the connection before it does
	 * leaves the worker believing a turn is still in flight — every later prompt
	 * then queues behind it forever. This signal is what a cancellation waits on
	 * (briefly) before releasing the connection, and it deliberately does not
	 * depend on `settled`: a turn that ends by cancellation must be able to
	 * signal this while `settled` is still waiting for the commit to finish.
	 */
	turnEnded: Promise<void>;
	/** Resolves {@link turnEnded}; called once, when the turn's outcome is known. */
	markTurnEnded: () => void;
	/**
	 * Set when the terminal state could not be committed to disk.
	 *
	 * The task is kept in the map so this stays visible; it is never shown as
	 * still running and is never auto-retried.
	 */
	storageError: TaskError | null;
	/** Accumulated `agent_message_chunk` text. */
	summary: string;
	/** Most recent progress note from a tool call. */
	progress: string;
	/** Decisions already taken, keyed by request id, so a repeat is not re-asked. */
	approvalDecisions: Map<string, "approved" | "denied">;
	/**
	 * Request ids whose dialog is open right now.
	 *
	 * Kept as a set because two requests can be outstanding at once: a dialog that
	 * closes may only clear the waiting state once no other dialog is still open.
	 */
	readonly pendingApprovals: Set<string>;
	/** True while at least one approval dialog is waiting for a human. */
	awaitingApproval: boolean;

	/**
	 * Durable facts the terminal commit needs but a receipt does not carry.
	 *
	 * A v3 round receipt must name the round's own request id and its snapshot root;
	 * the receipt shape has no place to derive either, so they are captured at
	 * dispatch where they are known and only read at commit. The execution identity
	 * is the attempt the queue armed, and it is the only identity end evidence may
	 * be recorded under: a task does not get to name its own attempt.
	 */
	durable: {
		requestId: string;
		snapshotRoot: string;
		manifestSha256: string;
		attemptId: string;
		/** The WorkBuddy session the claim selected, not merely the bound one. */
		sessionId: string;
		/**
		 * The OMP identity whose approval this round carries.
		 *
		 * It is frozen in the staged manifest — the human approved the round
		 * under this identity, and the manifest's digest is the fence on that
		 * approval. It is NOT who executed the round: a round approved before a
		 * restart is adopted and run by the successor, and the approval still
		 * belongs to the activation that asked for it.
		 */
		owner: OwnerIdentity;
		/**
		 * The OMP identity that is executing this round right now.
		 *
		 * The result fact is published under this identity, because the queue
		 * records the round against the generation that actually ran it. The
		 * approval owner and the executor are the same identity in the ordinary
		 * case; they differ only when a successor adopted an approved round.
		 */
		executor: OwnerIdentity;
	};
	/**
	 * How this round's result reaches the user.
	 *
	 * `inBand` is true while the dispatching call is still waiting for the commit;
	 * once that wait ends (expired, steered, aborted) the result must be delivered
	 * through the outbox instead of silently disappearing.
	 */
	delivery: {
		waitEnded: "settled" | "expired" | "steered" | "aborted" | null;
		inBand: boolean;
	};
}

/** One permission request, with this client's answer shape already resolved. */
interface Interruption {
	requestId: string;
	toolCallId: string;
	toolName: string;
	reason: string;
	toolInput: unknown;
	/** WorkBuddy decision words offered for this request. */
	options: string[];
	/**
	 * The option id to answer with when refusing.
	 *
	 * Present only for the standard ACP `session/request_permission` shape, whose
	 * reply is an option id rather than a decision word.
	 */
	rejectOptionId?: string;
	/** The option id to answer with on explicit approval, for the standard shape. */
	allowOptionId?: string;
	/** Builds the truthful answer for the given decision. */
	reply(approved: boolean): unknown;
}

export default function activate(pi: ExtensionAPI, overrides: BridgeOverrides = {}): void {
	// Tasks are per OMP process: a task whose owner exits is reported as
	// interrupted rather than silently adopted by the next session.
	const tasks = new Map<string, ActiveTask>();

	/**
	 * Whether any task of this process still holds a project.
	 *
	 * The queue's connection is cached per project and mode, so it is shared by
	 * every task of that project. Closing it while a sibling task is still
	 * committing would take that task's writes with it, which is how two
	 * concurrent delegations in one project lose one another's commit.
	 */
	/**
	 * Separate registrations for stable OMP sessions in this activation. Reusing
	 * one generation across a switch collides on owners(instance_id,generation)
	 * and leaves the new session registered under the previous session's name.
	 * Existing owners stay active while their already-sent work winds down.
	 */
	const instanceId = crypto.randomUUID();
	/** Every stable session registered by this activation, including sessions switched away from. */
	const ownerProjects = new Map<string, Set<string>>();
	const sessionOwners = new Map<string, OwnerIdentity>();
	const queueWakeups = new Map<string, NodeJS.Timeout>();
	const foregroundWaiters = new Map<string, Set<() => void>>();
	let shuttingDown = false;
	const queueOwnerFor = (ctx: ExtensionContext): OwnerIdentity => {
		const sessionId = ctx.sessionManager.getSessionId();
		let owner = sessionOwners.get(sessionId);
		if (owner === undefined) {
			owner = { sessionId, generation: crypto.randomUUID(), processId: process.pid, instanceId };
			sessionOwners.set(sessionId, owner);
		}
		return owner;
	};
	const rememberOwner = (projectRoot: string, owner: OwnerIdentity): void => {
		let sessions = ownerProjects.get(projectRoot);
		if (sessions === undefined) {
			sessions = new Set();
			ownerProjects.set(projectRoot, sessions);
		}
		sessions.add(owner.sessionId);
	};
	const realDiscover = overrides.discover ?? discover;
	const realConnect = overrides.connect ?? connect;
	const realStageTask = overrides.stageTask ?? stageTask;
	const realReadBinding = overrides.readBinding ?? readBinding;
	const realWriteBinding = overrides.writeBinding ?? writeBinding;
	const realReadTask = overrides.readTask ?? readTask;
	const realWriteRoundReceipt = overrides.writeRoundReceipt ?? writeRoundReceipt;
	const realReadStagedManifest = readStagedManifest;
	const realCollectArtifacts = overrides.collectArtifacts ?? collectArtifacts;
	const realReadTaskIndex = overrides.readTaskIndex ?? readTaskIndex;
	const realReadTaskLock = overrides.readTaskLock ?? readTaskLock;
	const realInspectWorkers = overrides.inspectWorkers ?? inspectWorkers;
	const cancelSettleMs = overrides.cancelSettleMs ?? CANCEL_SETTLE_MS;
	const foregroundWaitMs = overrides.foregroundWaitMs ?? FOREGROUND_WAIT_MS;
	const realMigrateProject = overrides.migrateProject ?? migrateProjectToQueue;
	const realReadProjectAccess = overrides.readProjectAccess ?? readProjectAccess;
	const realResolveProjectContext = overrides.resolveProjectContext ?? resolveProjectContext;
	const realEnableProject = overrides.enableProject ?? enableProject;
	const realWhichBun =
		overrides.whichBun ??
		((cmd: string) => (typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which(cmd) : null));

	/**
	 * Pending approval drafts, keyed by their own request id.
	 *
	 * A single slot made two independent delegations fight: the second one
	 * overwrote the first, and the first dialog then found no draft and reported a
	 * cancellation that nobody asked for. Keying by request id lets parallel
	 * confirmations coexist; each one still checks its own origin, project and
	 * generation before it acts.
	 */
	const pendingDrafts = new Map<string, FrozenDraft>();

	/**
	 * The activation-local abort signal for pending recovery operations.
	 *
	 * A recovery asks a human a question and waits. If the conversation is
	 * switched away or the session shuts down while that question is open, the
	 * answer must not count: the operator identity of that conversation may
	 * already have been retired, and a late "yes" would otherwise authorize a
	 * recovery on behalf of a session that is no longer there.
	 *
	 * The database cannot prevent this on its own — an activation's owner rows
	 * stay active while its tasks wind down — so the signal is the guard.
	 */
	let recoveryAbort = new AbortController();

	/**
	 * In-flight project pool refreshes, keyed by canonical project root.
	 *
	 * Discovery is an ACP handshake, so it must not run unthrottled on every queue
	 * tick or once per parallel tool call. One refresh per project at a time is the
	 * whole bound: a second caller waits for the first instead of starting a second
	 * handshake against the same workers.
	 */
	const poolRefreshes = new Map<string, Promise<void>>();

	/**
	 * When each project pool was last refreshed, by canonical project root.
	 *
	 * A refresh is an ACP identity handshake against every worker, so it is
	 * bounded: at most one refresh per project per interval, and never two at
	 * once. A caller that needs the freshest roster asks for a forced refresh,
	 * which still shares an in-flight refresh rather than starting a second one.
	 */
	const poolRefreshAt = new Map<string, number>();

	/**
	 * The shortest interval between two *automatic* pool refreshes of one project.
	 *
	 * A scheduler tick must never turn into a handshake storm: the queue's
	 * advance loop runs on a timer, and each refresh is an ACP identity
	 * handshake against every worker the project serves.
	 *
	 * The bound is short enough that a session the user freed or opened while
	 * work was waiting is picked up while that work is still waiting — a
	 * queued round that could run is not left waiting for a whole scheduler
	 * interval — and long enough that the timer cannot hammer the workers.
	 * Concurrent refreshes still share one handshake, so the real bound is the
	 * handshake itself.
	 *
	 * A refresh the user asked for — by starting a delegation — is not
	 * throttled by this interval: the user may have opened a session seconds
	 * ago, and that session is exactly what the waiting task needs.
	 */
	const POOL_REFRESH_INTERVAL_MS = 2_000;

	/**
	 * Refreshes the project's enrolled WorkBuddy pool.
	 *
	 * Enrollment is verification, not dispatch: the verified same-project sessions
	 * are merged into the project's binding roster and recorded in the queue's
	 * session roster, so a task that was waiting for a free session can be
	 * satisfied by a session the user opened after the fact.
	 *
	 * Three properties matter here and each has a reason:
	 *
	 *  - it only runs for a project that already carries the auto-enrollment
	 *    consent, so a project the user never opted in is never enrolled;
	 *  - it never prompts, cancels or creates a session — it is a read of what
	 *    the desktop already serves;
	 *  - it never erases a binding: a project whose workers are all offline keeps
	 *    its roster, because the sessions are still enrolled, merely unreachable.
	 *
	 * One refresh per project runs at a time. Discovery performs an ACP identity
	 * handshake, so an unthrottled refresh on every scheduler tick — or once per
	 * parallel tool call — would hammer the same workers.
	 */
	async function refreshProjectPool(projectRoot: string, options: { force?: boolean } = {}): Promise<void> {
		if (shuttingDown) {
			// The activation is ending. Nothing may open the project again: a
			// refresh after the shutdown would take a handle on a project whose
			// files are about to be released.
			return;
		}
		let existing: Binding | null;
		try {
			existing = await realReadBinding(projectRoot);
		} catch {
			return;
		}
		if (existing === null) {
			// No binding means no consent. Enrollment is never inferred.
			return;
		}
		if (existing.autoBindProjectSessions !== true) {
			// A binding that names one session and carries no project-wide consent is
			// the pre-pool record. It is still a valid human decision — this project
			// was bound to WorkBuddy — so it is migrated rather than re-asked: the
			// project's existing consent covers the sessions it now serves, and
			// asking again would make a restart a prompt the user never sees
			// coming.
			//
			// A binding that names no session at all has no consent to migrate.
			if (typeof existing.sessionId !== "string" || existing.sessionId.length === 0) {
				return;
			}
		}
		const key = projectRoot.toLowerCase();
		if (options.force !== true) {
			// Only an automatic refresh is throttled. A refresh the user asked
			// for — by delegating a task — is not: the session they opened a
			// moment ago is exactly what the waiting task needs, and refusing to
			// look would strand it.
			const last = poolRefreshAt.get(key);
			if (last !== undefined && Date.now() - last < POOL_REFRESH_INTERVAL_MS) {
				return;
			}
		}
		const inFlight = poolRefreshes.get(key);
		if (inFlight !== undefined) {
			await inFlight;
			return;
		}
		const refresh = (async () => {
			let candidates: DesktopCandidate[] = [];
			try {
				candidates = await realDiscover(projectRoot, new AbortController().signal);
			} catch (error) {
				pi.logger.warn(
					`The WorkBuddy session pool for ${projectRoot} could not be refreshed: ${messageOf(error)}`,
				);
				return;
			}
			let merged: Binding;
			try {
				// The desktop catalog records the project's *existing* sessions,
				// including the ones no live worker is serving right now. They are
				// enrolled so the project keeps them across restarts, but they are
				// not verified: nothing proves a live worker owns them, so the queue
				// must not hand them new work.
				const catalog = await readProjectSessionCatalog(
					projectRoot,
					overrides.workbuddyHomeDir ?? workBuddyHomeDir(),
					seedSessionIdOf(existing),
				);
				if (catalog.failure !== null && catalog.failure !== "catalog_missing") {
					// The catalog is the desktop application's own file. A missing one
					// is ordinary — the app may not be installed — but an unreadable or
					// unexpected one is worth saying out loud, because the project then
					// keeps only the sessions live discovery proved. A seed the catalog
					// does not know is different again: the project's account scope
					// could not be established, so no catalog session was enrolled and
					// the scope was deliberately not widened to other accounts.
					pi.logger.warn(
						`The WorkBuddy session catalog for ${projectRoot} could not be read: ${catalog.failure}${
							catalog.detail === null ? "" : ` (${catalog.detail})`
						}`,
					);
				}
				merged = await reconcileProjectBinding(existing, candidates, catalog.sessions);
			} catch (error) {
				// A binding that cannot be reconciled is refused, not repaired by
				// guesswork: the roster stays as it was recorded.
				pi.logger.warn(
					`The WorkBuddy session pool for ${projectRoot} was not reconciled: ${messageOf(error)}`,
				);
				return;
			}
			if (JSON.stringify(merged) !== JSON.stringify(existing)) {
				try {
					await realWriteBinding(merged);
				} catch (error) {
					pi.logger.warn(
						`The WorkBuddy session pool for ${projectRoot} could not be persisted: ${messageOf(error)}`,
					);
					return;
				}
			}
			syncPoolRoster(projectRoot, merged, candidates);
		})();
		poolRefreshes.set(key, refresh);
		try {
			await refresh;
		} finally {
			poolRefreshes.delete(key);
			poolRefreshAt.set(key, Date.now());
		}
	}

	/**
	 * The session whose catalog row establishes the project's account scope.
	 *
	 * The desktop catalog records which account each conversation belongs to, so
	 * the project's conversations can only be told apart from other people's by
	 * starting from a session this project already owns. The primary session is
	 * that seed; when the binding has none, any enrolled member serves.
	 */
	function seedSessionIdOf(binding: Binding): string | null {
		if (typeof binding.sessionId === "string" && binding.sessionId.length > 0) {
			return binding.sessionId;
		}
		const roster = listBoundSessions(binding);
		return roster.length === 0 ? null : roster[0]!.sessionId;
	}

	/**
	 * Records the enrolled roster in the queue's session table.
	 *
	 * The queue is the only place that may decide which session a task runs on,
	 * so the roster it arbitrates over has to be the one the binding records. A
	 * member the discovery did not see is reported as offline rather than dropped:
	 * the session is still enrolled, it simply is not answering right now.
	 *
	 * A member the binding itself marks as unverified — a session the desktop
	 * catalog records but no live worker has confirmed — is reported offline even
	 * if a candidate happens to carry the same UUID: until a worker proves it
	 * owns that conversation, the queue must not hand it new work.
	 */
	function syncPoolRoster(
		projectRoot: string,
		binding: Binding,
		candidates: readonly DesktopCandidate[],
	): void {
		const bySession = new Map(candidates.map((candidate) => [candidate.binding.sessionId, candidate]));
		const observations = listBoundSessions(binding).map((member) => {
			const candidate = bySession.get(member.sessionId);
			// Verification is a fact about *now*: only a live worker that
			// discovery just proved owns this conversation may take new work. A
			// member that is merely known — enrolled from the desktop catalog, or
			// carried over from an earlier roster — is reported offline and
			// unverified, whatever the roster happened to say about it.
			const verified = candidate !== undefined && member.verified !== false;
			const availability = !verified
				? ("offline" as const)
				: candidate.busy
					? ("busy" as const)
					: ("idle" as const);
			return {
				sessionId: member.sessionId,
				workbuddyVersion: member.workbuddyVersion ?? binding.workbuddyVersion,
				availability,
				// The queue is the authority on eligibility, so it is told which
				// members a live worker actually proved. A member that is only
				// known — enrolled from the desktop catalog, or carried over from
				// an earlier roster — must never receive new work.
				verified,
				role: member.role,
				title: member.title,
			};
		});
		if (observations.length === 0) {
			return;
		}
		// The roster is recorded in the project's own state, so the state has to
		// exist: opening a write handle would create it when it is gone, and a
		// refresh must never resurrect a project that no longer exists.
		if (!projectStateExists(projectRoot)) {
			return;
		}
		let queue;
		try {
			queue = openProjectQueue(projectRoot, { mode: "write" });
		} catch {
			return;
		}
		if (queue === null) {
			return;
		}
		try {
			queue.syncProjectSessions(observations, Date.now());
		} catch (error) {
			pi.logger.warn(
				`The WorkBuddy session roster for ${projectRoot} could not be recorded: ${messageOf(error)}`,
			);
		} finally {
			queue.close();
		}
	}

	/**
	 * Brings an already-authorized project's state up to this build's shape.
	 *
	 * The guard is the whole point of this function. The migration creates a
	 * state file when the project has none, so it may only run for a project
	 * that is *already* set up: one whose state exists on disk and whose
	 * binding records the user's decision to delegate to WorkBuddy. An
	 * arbitrary working directory OMP happens to be opened in must not gain a
	 * state file, and a project whose state was removed must stay removed.
	 *
	 * A project whose state is newer than this build is refused, not migrated
	 * backwards: its shape is not one this build understands.
	 */
	async function upgradeProjectStateIfAuthorized(projectRoot: string): Promise<void> {
		if (!projectStateExists(projectRoot)) {
			// No state on disk: there is nothing to upgrade, and creating one
			// here would set up a project nobody asked for.
			return;
		}
		const binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			// Without a binding there is no consent, so the project is not one
			// this build may set up on its own.
			return;
		}
		try {
			await realMigrateProject(projectRoot);
		} catch (error) {
			// A refused upgrade is reported and nothing else is attempted: the
			// project stays exactly as it was, and the user is told why.
			pi.logger.warn(
				`The WorkBuddy project state for ${projectRoot} was not upgraded: ${messageOf(error)}`,
			);
		}
	}

	/**
	 * Whether a project still has its persisted state.
	 *
	 * A write handle creates the state file when it is missing, so a background
	 * refresh must check first: a timer must never resurrect a project that was
	 * removed.
	 */
	function projectStateExists(projectRoot: string): boolean {
		try {
			const db = openReadConnection(projectRoot);
			if (db === null) {
				return false;
			}
			closeQueueConnection(projectRoot, "read");
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * The WorkBuddy session a task is pinned to, from the queue's durable record.
	 *
	 * A rework or a supplement continues on the session the task already ran on,
	 * and that fact outlives the round that selected it: it is stored by the queue
	 * rather than derived from the current binding, so a restart or a rebind does
	 * not move the work to a different conversation.
	 */
	function taskSessionOf(projectRoot: string, taskId: string): string | null {
		let queue;
		try {
			queue = openProjectQueue(projectRoot, { mode: "read" });
		} catch {
			return null;
		}
		if (queue === null) {
			return null;
		}
		try {
			return queue.taskSession(taskId);
		} catch {
			return null;
		} finally {
			queue.close();
		}
	}

	const setStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		const mine = [...tasks.values()].filter(
			(task) => task.durable.owner.sessionId === ctx.sessionManager.getSessionId(),
		);
		// The status line is one short phrase; the progress row is where a task's own
		// progress belongs. Both are best-effort surfaces: a host without `setWidget` keeps
		// working, it just shows less.
		const setWidget = (lines: string[] | undefined): void => {
			if (typeof ctx.ui.setWidget !== "function") {
				return;
			}
			try {
				// Above the editor: a row below it is pushed out of view while the reply
				// streams, which is exactly when a progress row is worth having.
				ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
			} catch {
				// A widget that cannot render must never fail the state update that caused it.
			}
		};
		if (mine.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			setWidget(undefined);
			return;
		}
		const blocked = mine.filter((task) => task.storageError !== null).length;
		const active = mine.filter(
			(task) => task.storageError === null && task.finalization === null && !receiptIsTerminal(task.receipt),
		);
		const parts: string[] = [];
		if (active.length > 0) {
			const phase = active.some((task) => task.awaitingApproval) ? "awaiting approval" : "running";
			parts.push(`${phase} (${active.length})`);
		}
		if (blocked > 0) {
			parts.push(`storage errors (${blocked})`);
		}
		if (parts.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			setWidget(undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `WorkBuddy: ${parts.join(", ")}`);
		// One line per undecided task, each naming its round and last progress. Kept short:
		// a row that wraps stops being glanceable.
		setWidget(
			active.map((task) => {
				const round = currentRound(task.receipt);
				const progress = task.progress.trim().split("\n")[0] ?? "";
				const label = task.awaitingApproval ? "awaiting approval" : round.status;
				return `${task.taskId.slice(0, 8)} r${round.number} ${label}${progress === "" ? "" : ` — ${progress.slice(0, 60)}`}`;
			}),
		);
	};

	// A desktop-held writer has no completion callback in this process. Recheck
	// only our already-approved, proven-unsent queue; this never retries a prompt.
	function scheduleQueueAdvance(ctx: ExtensionContext, projectRoot: string): void {
		const origin = ctx.sessionManager.getSessionId();
		const key = `${projectRoot}\0${origin}`;
		if (shuttingDown || queueWakeups.has(key)) {
			return;
		}
		const timer = setTimeout(() => {
			queueWakeups.delete(key);
			if (shuttingDown || ctx.sessionManager.getSessionId() !== origin) {
				return;
			}
			void advanceQueuedRounds(ctx).catch((error) => {
				pi.logger.warn(`Queued WorkBuddy dispatch could not advance: ${messageOf(error)}`);
			}).finally(() => {
				if (shuttingDown || ctx.sessionManager.getSessionId() !== origin) {
					return;
				}
				let pending = false;
				try {
					const db = openReadConnection(projectRoot);
					if (db !== null) {
						try {
							pending = db.query(
								`SELECT 1 FROM rounds WHERE owner_session = ? AND status = 'queued'
								 AND phase = 'queued' AND dispatch_state = 'not_sent' AND outcome_json IS NULL LIMIT 1`,
							).get(origin) !== null;
						} finally {
							closeQueueConnection(projectRoot, "read");
						}
					}
				} catch (error) {
					pi.logger.warn(`Queued WorkBuddy state could not be read: ${messageOf(error)}`);
				}
				if (pending) {
					scheduleQueueAdvance(ctx, projectRoot);
				}
			});
		}, 1_000);
		timer.unref();
		queueWakeups.set(key, timer);
	}

	/**
	 * Whether a project has a round this session may end up dispatching.
	 *
	 * The check is read-only and it runs *before* any write handle is opened:
	 * opening one would create the project's state file if it is gone, and a
	 * background timer must never resurrect a project that no longer exists.
	 *
	 * The lookup is by OMP session only, not by generation. A round approved
	 * but never claimed still carries the generation of the activation that
	 * staged it, and it is `adoptUnsentRounds` that repoints it at the
	 * successor — the very next step of this advance. Filtering on the
	 * *current* generation here would therefore hide exactly the work this
	 * function exists to find, and a round approved before a restart would
	 * never run again.
	 *
	 * This is a read-only preflight, and it deliberately says less than it
	 * decides: it finds work that *might* be dispatchable. The write that
	 * follows is the authority — `adoptUnsentRounds` adopts only a round whose
	 * previous owner is provably gone, and the claim that follows it still
	 * requires this session and this generation. No authorization is widened
	 * by looking for a predecessor's work here.
	 */
	function hasDispatchableRound(projectRoot: string, owner: OwnerIdentity): boolean {
		try {
			const db = openReadConnection(projectRoot);
			if (db === null) {
				return false;
			}
			try {
				return (
					db.query(
						`SELECT 1 FROM rounds WHERE owner_session = ?
						 AND status = 'queued' AND phase = 'queued'
						 AND dispatch_state = 'not_sent' AND outcome_json IS NULL LIMIT 1`,
					).get(owner.sessionId) !== null
				);
			} finally {
				closeQueueConnection(projectRoot, "read");
			}
		} catch {
			return false;
		}
	}

	/**
	 * The background follow-up work this activation started.
	 *
	 * A terminal commit hands off to work that is not the commit itself: the
	 * result fact is published, the pending results are delivered, and the
	 * queue is advanced so a waiting round can run. All of that touches the
	 * project's state, so it has to be finished before the project's files may
	 * be released — a shutdown that returned while one of them was still
	 * running would leave a handle on the project behind it.
	 *
	 * The set is small and its members are short-lived; a completed one is
	 * removed at once.
	 */
	const backgroundWork = new Set<Promise<unknown>>();

	/**
	 * Starts background work and keeps it joinable.
	 *
	 * The work is not awaited by its caller — that is the point of it being
	 * background — but it is tracked, so a shutdown can wait for it.
	 */
	function trackBackgroundWork(work: Promise<unknown>): void {
		const tracked = work.catch(() => undefined);
		backgroundWork.add(tracked);
		void tracked.finally(() => {
			backgroundWork.delete(tracked);
		});
	}

	async function waitForForeground(task: ActiveTask, signal: AbortSignal | undefined): Promise<NonNullable<ActiveTask["delivery"]["waitEnded"]>> {
		if (signal?.aborted === true) {
			return "aborted";
		}
		if (foregroundWaitMs <= 0) {
			return "expired";
		}
		const origin = task.durable.owner.sessionId;
		const end = Promise.withResolvers<NonNullable<ActiveTask["delivery"]["waitEnded"]>>();
		const steer = (): void => end.resolve("steered");
		const abortWait = (): void => end.resolve("aborted");
		let waiters = foregroundWaiters.get(origin);
		if (waiters === undefined) {
			waiters = new Set();
			foregroundWaiters.set(origin, waiters);
		}
		waiters.add(steer);
		signal?.addEventListener("abort", abortWait, { once: true });
		const timer = setTimeout(() => end.resolve("expired"), foregroundWaitMs);
		try {
			return await Promise.race([task.committed.then(() => "settled" as const), end.promise]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortWait);
			waiters.delete(steer);
			if (waiters.size === 0) {
				foregroundWaiters.delete(origin);
			}
		}
	}

	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") {
			for (const endWait of foregroundWaiters.get(ctx.sessionManager.getSessionId()) ?? []) {
				endWait();
			}
		}
		return {};
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		// A recovery that is waiting for a human answer must not receive one
		// after the session is gone: the operator identity it would act for is
		// being retired right now.
		recoveryAbort.abort();
		for (const timer of queueWakeups.values()) {
			clearTimeout(timer);
		}
		queueWakeups.clear();
		const mine = [...tasks.values()];
		// The tasks that were in flight when the shutdown began. Their own
		// contexts are captured here, because a task that commits during the
		// shutdown leaves the map and its result would otherwise be delivered
		// by nobody.
		const inFlight = [...mine];
		await Promise.all(
			mine.map(async (task) => {
				// A task that already committed its terminal state is only waited on;
				// shutdown must not write a second state or re-cancel its worker.
				await finalizeTask(task, "cancelled", taskError(WB_ERROR_CODE.interrupted, "OMP session shut down"), {
					cancelWorker: true,
					collectArtifacts: true,
				});
			}),
		);
		// Tasks whose commit failed stay in the map: clearing it would hide the
		// storage failure the caller still has to see.
		//
		// The background work the commits handed off to — publishing the result
		// fact, delivering the result, advancing the queue — is finished before
		// this activation returns. It reads and writes the project's state, and a
		// shutdown that returned while it was still running would leave a handle
		// on the project behind it.
		//
		// The wait is bounded: a follow-up that waits for the worker's turn to
		// end must not keep the shutdown open forever. The tasks above were
		// cancelled first, so their turns end; the bound is only a backstop for
		// work that is waiting on something else entirely.
		const { promise: backgroundDone, resolve: backgroundSettled } = Promise.withResolvers<void>();
		const backgroundTimer = setTimeout(backgroundSettled, SHUTDOWN_BACKGROUND_WAIT_MS);
		backgroundTimer.unref();
		await Promise.race([Promise.all([...backgroundWork]), backgroundDone]);
		clearTimeout(backgroundTimer);
		// The result of a task whose commit landed during the shutdown is
		// delivered here. The per-task follow-up waits for the worker's turn,
		// which the cancellation above ends, but a worker that never reports its
		// turn ending would leave the result undelivered. The durable outbox
		// still holds it, so the next session of this conversation delivers it
		// either way; this is the immediate attempt.
		for (const task of inFlight) {
			try {
				// The outbox row was published under the executor's identity, so
				// the delivery claims it under the same one.
				await deliverPendingResults(task.ctx, task.receipt.projectRoot, task.durable.executor);
			} catch {
				// A result that cannot be delivered stays pending.
			}
		}
		//
		// Retire this activation's owner rows. Without it, a clean exit leaves
		// `state='active'` with a pid the OS is free to reuse, so the next process reads
		// that generation as alive and never recovers its holds — "provably dead" has to
		// be a declaration, not an inference from a recycled pid.
		for (const [projectRoot, sessions] of ownerProjects) {
			try {
				const queue = openProjectQueue(projectRoot, { mode: "write" });
				if (queue === null) {
					continue;
				}
				try {
					for (const sessionId of sessions) {
						const owner = sessionOwners.get(sessionId);
						if (owner !== undefined) {
							queue.retireOwner(owner);
						}
					}
				} finally {
					queue.close();
				}
			} catch {
				// Best effort: a shutdown that cannot retire its owner must not fail the exit.
			}
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		// A draft belongs to the conversation that staged it. Switching away ends
		// every pending confirmation of this conversation, and the drafts are
		// dropped so a later answer cannot submit them.
		pendingDrafts.clear();
		// The same holds for a pending recovery question: it was asked by the
		// conversation that is being left, so its answer must not survive.
		recoveryAbort.abort();
		recoveryAbort = new AbortController();
		for (const waiters of foregroundWaiters.values()) {
			for (const endWait of waiters) {
				endWait();
			}
		}
		for (const timer of queueWakeups.values()) {
			clearTimeout(timer);
		}
		queueWakeups.clear();
		await resumeOriginQueue(ctx);
	});
	pi.on("session_start", async (_event, ctx) => {
		await resumeOriginQueue(ctx);
	});

	async function resumeOriginQueue(ctx: ExtensionContext): Promise<void> {
		let projectRoot: string | null = null;
		try {
			projectRoot = (await locateProject(ctx)).projectRoot;
		} catch (error) {
			pi.logger.warn(`The project could not be resolved on session start: ${messageOf(error)}`);
		}
		if (projectRoot === null) {
			return;
		}
		const root = projectRoot;
		// The project's own state is brought up to this build's shape before
		// anything reads or writes it. A project that was set up by an earlier
		// build still declares the older schema version, and every write path
		// refuses that — so without this, a restart could not dispatch anything
		// and the user's only remedy would be a manual setup step.
		//
		// The migration is production's own, and it is safe: it backs the file
		// up first, runs in one transaction, preserves the enabled and migrated
		// timestamps, and never prompts, never creates or attaches a WorkBuddy
		// session and never sends a prompt.
		//
		// It runs only for a project that is already authorized *and* already has
		// state on disk. An arbitrary working directory must not gain a state
		// file, and a project whose state was removed must not be resurrected.
		await upgradeProjectStateIfAuthorized(root);
		// The project's enrolled sessions are restored before any work is
		// dispatched: a session the user opened after the last run has to be able
		// to satisfy a task that is already waiting. The refresh is enrollment
		// verification only — it never prompts, never cancels and never creates a
		// WorkBuddy session — and it is skipped entirely for a project that has
		// not opted into project-wide enrollment.
		try {
			await refreshProjectPool(root);
		} catch (error) {
			pi.logger.warn(`The WorkBuddy session pool for ${root} could not be restored: ${messageOf(error)}`);
		}
		// A result committed before a restart was never acknowledged, so it is still
		// pending: reporting it here is what makes an offline result recoverable
		// without a manual status call and without resending any work.
		try {
			const owner = queueOwnerFor(ctx);
			const registering = openProjectQueue(root, { mode: "write" });
			if (registering !== null) {
				try {
					registering.registerOwner(owner, Date.now());
				} finally {
					registering.close();
				}
			}
			rememberOwner(root, owner);
			await deliverPendingResults(ctx, root, owner);
		} catch (error) {
			pi.logger.warn(`Pending WorkBuddy results could not be delivered: ${messageOf(error)}`);
		}
		try {
			await advanceQueuedRounds(ctx);
			scheduleQueueAdvance(ctx, root);
		} catch (error) {
			pi.logger.warn(`The originating WorkBuddy queue could not resume: ${messageOf(error)}`);
		}
	}

	// Only the delegation workflow ships with the package. The collaboration
	// skill drove a second, file-store work protocol that bypassed the queue's
	// single write authority; it is removed rather than left discoverable.
	pi.on("resources_discover", async () => {
		const extDir = path.dirname(__dirname);
		return {
			skillPaths: [path.join(extDir, "skills", "workbuddy-delegate")],
		};
	});
	pi.registerCommand("wb", {
		description: commandDescription(),
		getArgumentCompletions: (argumentPrefix: string) =>
			completionChoices(argumentPrefix).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseCommand(args);
			const spec = parsed.spec;
			// One table decides what exists, what it is called and how it is used; this
			// switch only binds those names to handlers.
			if (spec === null) {
				ctx.ui.notify(`Unknown /wb subcommand: "${parsed.subcommand}".\n\n${usageListing()}`, "warning");
				return;
			}
			const parts = [parsed.subcommand, ...parsed.positional];
			const subcommand = parsed.subcommand;
			if (spec.name === "usage") {
				ctx.ui.notify(usageListing(), "info");
				return;
			}
			if (spec.name === "") {
				// A bare /wb opens the workbench. Without a UI the same facts are printed,
				// so headless use still gets an answer instead of nothing happening.
				await runWorkbench(ctx);
				return;
			}
			if (subcommand === "init") {
				const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
				try {
					await realMigrateProject(projectRoot);
				} catch (error) {
					if (error instanceof WbTaskError) {
						ctx.ui.notify(`${error.code}: ${error.message}`, "error");
						return;
					}
					ctx.ui.notify(`Failed to enable project state: ${messageOf(error)}`, "error");
					return;
				}
				// Migration alone does not enable a project that had no binding to
				// import. Assert the real state rather than announcing success: an
				// "enabled" message on a still-disabled project sends the user
				// straight into WB_MIGRATION_REQUIRED on their first delegation.
				let access = await realReadProjectAccess(projectRoot).catch(() => null);
				if (access !== null && access.migrated && !access.enabled) {
					try {
						await realEnableProject(projectRoot);
						access = await realReadProjectAccess(projectRoot).catch(() => null);
					} catch (error) {
						ctx.ui.notify(`Could not enable project state: ${messageOf(error)}`, "error");
						return;
					}
				}
				if (access === null || !access.enabled || !access.migrated) {
					const missing = access === null
						? "database inaccessible"
						: [!access.migrated ? "migration incomplete" : null, !access.enabled ? "project not enabled" : null]
								.filter((part): part is string => part !== null)
								.join(", ");
					ctx.ui.notify(
						`Project state was not enabled for ${projectRoot}: ${missing}. Next step: run /wb setup.`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Project state enabled at ${projectRoot}`, "info");
				return;
			}
			if (subcommand === "bind") {
				await runBind(ctx);
				return;
			}
			if (subcommand === "" || subcommand === "status") {
				await runStatus(ctx);
				return;
			}
			if (subcommand === "send") {
				const targetId = parts[1] ?? "";
				if (!targetId) {
					ctx.ui.notify("Usage: /wb send <requestId>", "warning");
					return;
				}
				const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
				const draft = pendingDrafts.get(targetId);
				if (draft === undefined || draft.projectRoot !== projectRoot) {
					ctx.ui.notify(`No matching draft found for requestId "${targetId}" in this project.`, "warning");
					return;
				}
				pendingDrafts.delete(targetId);

				if (draft.goal.externalActions.length > 0 && ctx.hasUI) {
					const actionDetails = draft.goal.externalActions
						.map((a) => `- [${a.kind}] target: ${a.target}, operation: ${a.operation}, parameters: ${a.parameters}`)
						.join("\n");
					const extChoices = ["Approve these exact actions once", "Do not run external actions"];
					const extChoice = await ctx.ui.select(
						`Authorizing external side-effects for this round:\n${actionDetails}`,
						extChoices,
					);
					if (extChoice !== "Approve these exact actions once") {
						ctx.ui.notify("External actions not approved; round cancelled.", "warning");
						return;
					}
				}

				const confirmation: RoundConfirmationV3 = {
					source: "user_command",
					at: new Date().toISOString(),
					targetPolicy: draft.targetPolicy,
					requestId: draft.requestId,
					manifestSha256: draft.manifestSha256,
					owner: draft.owner,
					previousRound: draft.previousRound,
					inputs: draft.inputFiles.map((input) => ({ path: input.path, sha256: input.sha256 })),
					deliveryMode: "foreground",
				};
				// The version comes from the stored binding, never from a literal: a
				// project bound to a different WorkBuddy build would otherwise record a
				// version nobody observed, and that value travels into the receipt.
				const storedBinding = await realReadBinding(draft.projectRoot).catch(() => null);
				if (storedBinding === null) {
					ctx.ui.notify(
						`No WorkBuddy binding for ${draft.projectRoot}. Run /wb bind first.`,
						"error",
					);
					return;
				}
				const result = await runConfirmedTask(
					ctx,
					storedBinding,
					draft.rawRequest,
					confirmation,
					undefined,
					draft.taskIdForRound,
				);
				if (result.isError) {
					const firstContent = result.content[0];
					const errText = firstContent && "text" in firstContent && typeof firstContent.text === "string" ? firstContent.text : "error";
					ctx.ui.notify(`Task submission failed: ${errText}`, "error");
				} else {
					ctx.ui.notify(`Task submitted to WorkBuddy: ${draft.taskId ?? "new task"}`, "info");
				}
				return;
			}
			if (spec.name === "doctor") {
				// Same function the tool runs, so a diagnosis cannot differ by surface — but a
				// command runs in an interactive session, where an unbounded worker probe would
				// stall the interface. The tool passes the caller's signal; a command has to
				// supply its own bound and report a timeout as a fact rather than hang.
				const diagnosed = await runDoctor(ctx, AbortSignal.timeout(DOCTOR_PROBE_MS));
				ctx.ui.notify(resultText(diagnosed), (diagnosed.isError ?? false) ? "error" : "info");
				return;
			}
			if (subcommand === "tasks") {
				// Same implementation as the tool: a command that formatted its own listing
				// would be a second answer to the same question, and the two would drift.
				const target = parts[1];
				const listed = await runTasks(ctx, {});
				ctx.ui.notify(resultText(listed), (listed.isError ?? false) ? "error" : "info");
				if (target !== undefined && target.length > 0) {
					const detail = await runStatusTool(ctx, undefined, { taskId: target });
					ctx.ui.notify(resultText(detail), (detail.isError ?? false) ? "error" : "info");
				}
				return;
			}
			if (subcommand === "cancel") {
				await runCancelCommand(ctx, parts.slice(1));
				return;
			}
			if (subcommand === "release") {
				const recoverySignal = recoveryAbort.signal;
				if (recoverySignal.aborted) return;
				if (!ctx.hasUI || typeof ctx.ui.input !== "function") {
					ctx.ui.notify("Recovery requires an interactive human verification of the exact stopped execution.", "error");
					return;
				}
				const located = await locateProject(ctx);
				if (recoverySignal.aborted) return;
				if (located.projectRoot === null) {
					ctx.ui.notify(located.reason ?? "No verified project root.", "error");
					return;
				}
				const projectRoot = located.projectRoot;
				// The operator registers *before* any dialog, never after: a
				// registration made after an await would resurrect an identity
				// that a session switch or a shutdown already retired.
				const operator = queueOwnerFor(ctx);
				{
					const registering = openProjectQueue(projectRoot, { mode: "write" });
					if (registering === null) {
						ctx.ui.notify("No project queue is available.", "error");
						return;
					}
					try {
						registering.registerOwner(operator, Date.now());
					} finally {
						registering.close();
					}
				}
				rememberOwner(projectRoot, operator);
				// The quarantined holds are read in their own scope: a cached
				// connection is not a lease and must not be held across the
				// dialogs below.
				let holds: Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }>;
				{
					const queue = openProjectQueue(projectRoot, { mode: "write" });
					if (queue === null) {
						ctx.ui.notify("No project queue is available.", "error");
						return;
					}
					try {
						const targetId = parts[1];
						holds = queue.holds().filter((hold) =>
							hold.kind === "quarantine" && hold.taskId !== null && hold.round !== null &&
							(targetId === undefined || hold.taskId === targetId));
					} finally {
						queue.close();
					}
				}
				try {
					const labels = holds.map((hold) => `${hold.taskId} / round ${hold.round} / WB ${hold.sessionId}`);
					const picked = await ctx.ui.select("Select the quarantined execution you verified has stopped", labels, { signal: recoverySignal });
					if (recoverySignal.aborted) return;
					const hold = holds[labels.indexOf(picked ?? "")];
					if (hold?.taskId == null || hold.round === null) {
						ctx.ui.notify("Nothing released. Active executions and session-only IDs cannot be unlocked.", "info");
						return;
					}
					const evidence = await ctx.ui.input("How did you verify this WorkBuddy turn has stopped?", undefined, { signal: recoverySignal });
					if (recoverySignal.aborted) return;
					if (evidence === undefined || evidence.trim() === "") {
						ctx.ui.notify("Nothing released: an actual end observation is required.", "warning");
						return;
					}
					// The subject is frozen before the confirmation dialog: the
					// human answers about *this* round, and the queue checks the
					// subject again inside the release transaction.
					const subject = readReleaseSubject(projectRoot, operator, hold.taskId, hold.round, hold.sessionId);
					if (subject === null) {
						ctx.ui.notify("Nothing released: this round has no recorded result to describe.", "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Release this verified stopped execution?",
						[
							`Project: ${projectRoot}`,
							`Task: ${hold.taskId}`,
							`Round: ${hold.round}`,
							`WB session: ${hold.sessionId}`,
							`Original owner: ${subject.ownerSession} / ${subject.ownerGeneration}`,
							`Request: ${subject.requestId}`,
							`Attempt: ${subject.attemptId ?? "(never sent)"}`,
							`Receipt digest: ${subject.receiptSha256 ?? "(none committed)"}`,
							`End evidence: ${evidence}`,
							"No prompt will be resent.",
						].join("\n"),
						{ signal: recoverySignal },
					);
					if (confirmed !== true) {
						return;
					}
					if (recoverySignal.aborted) {
						ctx.ui.notify("Nothing released: this session changed while the confirmation was open.", "warning");
						return;
					}
					// The release itself is a fresh scope: it runs after the
					// dialogs, and it verifies that the exact hold still exists.
					const queue = openProjectQueue(projectRoot, { mode: "write" });
					if (queue === null) {
						ctx.ui.notify("No project queue is available.", "error");
						return;
					}
					try {
						// The operator was registered before the dialogs. It is
						// deliberately NOT registered again here: a registration
						// made after an await would resurrect an identity that a
						// session switch or a shutdown already retired.
						// The originating session releases its own round through the
						// ordinary path; a different operator releases it only with
						// the explicit, one-shot grant.
						const authorization: QuarantineReleaseAuthorization =
							subject.ownerSession === operator.sessionId
								? {
										kind: "owner_release",
										owner: operator,
										verification: {
											source: "host_dialog",
											at: new Date().toISOString(),
											evidence,
										},
									}
								: {
										kind: "quarantine_release",
										operator,
										originalOwner: {
											sessionId: subject.ownerSession,
											generation: subject.ownerGeneration,
											instanceId: subject.executorInstance,
											processId: subject.ownerProcessId,
										},
										deathProof: subject.deathProof,
										subject,
										consent: {
											confirmed: true,
											at: new Date().toISOString(),
											subject,
										},
										endObservation: {
											source: "host_dialog",
											at: new Date().toISOString(),
											evidence,
										},
										requestedAt: Date.now(),
									};
						const released = queue.releaseQuarantine({
							taskId: hold.taskId,
							round: hold.round,
							sessionId: hold.sessionId,
							authorization,
							now: Date.now(),
						});
						ctx.ui.notify(released.kind === "released"
							? "Verified stopped execution released; its business outcome is unchanged."
							: `Nothing released: ${released.kind === "refused" ? released.reason : "the exact hold no longer exists"}.`,
							released.kind === "released" ? "info" : "warning");
					} finally {
						queue.close();
					}
				} catch (error) {
					ctx.ui.notify(`Recovery failed: ${messageOf(error)}`, "error");
				}
				trackBackgroundWork(advanceQueuedRounds(ctx));
				return;
			}
			if (subcommand === "setup") {
				await runSetup(ctx);
				return;
			}
			if (subcommand === "repair") {
				await runRepairCommand(ctx, parts[1]);
				return;
			}
			if (subcommand === "background") {
				await runBackgroundCommand(ctx, parts[1]);
				return;
			}
			if (subcommand === "results") {
				await runResultsCommand(ctx, parts[1]);
				return;
			}
			// Every registered command is dispatched above; reaching this point means the
			// table and the switch disagree, which is a defect rather than a user error.
			ctx.ui.notify(`/wb ${subcommand} is registered but has no dispatcher.\n\n${usageListing()}`, "error");
		},
	});

	const goalSchemaObj = pi.zod.object({
		objective: pi.zod.string().describe("The objective and professional intent"),
		context: pi.zod.string().optional().describe("Background context for the task"),
		constraints: pi.zod.array(pi.zod.string()).optional().describe("Execution constraints and boundaries"),
		acceptance: pi.zod.array(pi.zod.string()).describe("Specific acceptance criteria (at least one required)"),
		externalActions: pi.zod
			.array(
				pi.zod.object({
					kind: typeof pi.zod.enum === "function" ? pi.zod.enum(["publish", "deploy", "cloud_write", "schedule"]) : pi.zod.string(),
					target: pi.zod.string().describe("Target system or resource"),
					operation: pi.zod.string().describe("Operation name"),
					parameters: pi.zod.string().describe("Critical operation parameters"),
				})
			)
			.optional()
			.describe("Planned external actions requiring separate human confirmation"),
	});
	const taskGoalSchema = typeof goalSchemaObj.strict === "function" ? goalSchemaObj.strict() : goalSchemaObj;
	const describedGoal = typeof taskGoalSchema.describe === "function" ? taskGoalSchema.describe("Task objective, context, constraints, acceptance, and external actions") : taskGoalSchema;

	const taskParamsObj = pi.zod.object({
		goal: describedGoal,
		inputFiles: pi.zod
			.array(pi.zod.string())
			.optional()
			.describe("Project-relative paths of real files to snapshot into the task's inputs directory"),
		expectedOutputs: pi.zod
			.array(pi.zod.string())
			.optional()
			.describe("Filenames WorkBuddy must produce in the task's outputs directory, e.g. report.md"),
		taskId: pi.zod
			.string()
			.optional()
			.describe("Existing finished task to supplement with more work on the same session"),
		requestedByUser: pi.zod
			.boolean()
			.optional()
			.describe(
				"True when the user's own message asked for WorkBuddy or a WorkBuddy-owned product; omit when the delegation is your own suggestion",
			),
	});
	const taskParamsSchema = typeof taskParamsObj.strict === "function" ? taskParamsObj.strict() : taskParamsObj;

	pi.registerTool({
		name: "wb_task",
		label: "WorkBuddy Task",
		description: [
			"You are the OMP-side agent; WorkBuddy is a separate desktop specialist application that runs the work in its own session. Calling this tool hands the task to that specialist.",
			"Delegate one self-contained task (research, office documents such as .docx or .pptx, design) when it should be produced by WorkBuddy rather than in this process. The user saying \"use WorkBuddy\" or naming a product WorkBuddy owns is the usual reason to reach for it.",
			"Waits for the task's durable commit and then returns the collected artifacts for you to open and verify; if the wait expires it reports waitingInterrupted while the work continues.",
			"Declare deliverables in expectedOutputs so a missing file is reported instead of silently passing.",
			"When the user asks for WorkBuddy by name, or for a deliverable WorkBuddy owns, call this tool with requestedByUser set rather than producing the output yourself: the routing decision is theirs, not yours.",
			"requestedByUser records whether the user's own message asked for WorkBuddy; leave it unset when the delegation is your own suggestion. Only when it is set does the tool ask the user which workflow to use for an overlapping deliverable (.docx, .pdf, .md, .csv, .xlsx). A \"keep it in this session\" answer returns without a task, so do the work yourself then; a dismissed prompt returns \"undecided\" and nothing was delegated, so ask the user before retrying.",
		].join(" "),
		parameters: taskParamsSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await runTask(ctx, signal, params as unknown as TaskRequest);
		},
	});

	pi.registerTool({
		name: "wb_status",
		label: "WorkBuddy Status",
		description:
			"Read a delegated task's status, summary and artifact paths. Optionally waits briefly for a state change instead of returning immediately.",
		parameters: pi.zod.object({
			taskId: pi.zod.string().describe("The taskId returned by wb_task"),
			waitMs: pi.zod
				.number()
				.optional()
				.describe(`Milliseconds to wait for a state change, 0-${MAX_WAIT_MS} (default ${DEFAULT_WAIT_MS})`),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await runStatusTool(ctx, signal, params as WbStatusParams);
		},
	});

	pi.registerTool({
		name: "wb_cancel",
		label: "WorkBuddy Cancel",
		description:
			"Cancel one delegated task owned by this OMP process. Never touches the WorkBuddy process, its dedicated session, or other sessions.",
		parameters: pi.zod.object({
			taskId: pi.zod.string().describe("The taskId returned by wb_task"),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await runCancel(ctx, signal, params as WbCancelParams);
		},
	});

	pi.registerTool({
		name: "wb_tasks",
		label: "WorkBuddy Tasks",
		description: [
			"List this project's persisted WorkBuddy tasks, newest first, with optional status filtering and paging.",
			"Read-only: it lists the stored index and never repairs, re-runs or cancels anything.",
			"Pages are not snapshotted, so a task updated by another process between calls can change which page it appears on.",
		].join(" "),
		parameters: pi.zod.object({
			status: pi.zod
				.string()
				.optional()
				.describe("Only list tasks in this state: running, awaiting_approval, completed, failed, cancelled, interrupted"),
			limit: pi.zod.number().optional().describe(`Page size, 1-${MAX_TASK_PAGE} (default ${DEFAULT_TASK_PAGE})`),
			offset: pi.zod.number().optional().describe("Number of matching tasks to skip (default 0)"),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			return await runTasks(ctx, params as WbTasksParams);
		},
	});

	pi.registerTool({
		name: "wb_doctor",
		label: "WorkBuddy Doctor",
		description: [
			"Read-only diagnosis of this project's WorkBuddy setup: binding, task lock and the bound worker's health.",
			"Nothing is created, repaired, attached to or approved, and no ACP connection is made.",
			"ACP compatibility is not verified here; it is proven when a real delegation connects.",
		].join(" "),
		parameters: pi.zod.object({}),
		execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
			return await runDoctor(ctx, signal);
		},
	});

	/**
	 * `wb_review`: the reviewing OMP records its own criterion verdict.
	 *
	 * Acceptance is never inferred from the worker's reply. The tool re-hashes the
	 * named artifacts and requires exactly the round's original criteria, so a review
	 * always describes bytes that exist and criteria the human declared. One correction
	 * per task follows from a changes_requested verdict; the correction is a normal
	 * next round of the same task with the original materials frozen.
	 */
	pi.registerTool({
		name: "wb_review",
		label: "WorkBuddy Review",
		description: [
			"Record your own criterion-level verdict on a completed delegated round after actually opening or running its deliverables.",
			"Never accept from the worker's own report: name the files you inspected with their current sha256.",
			"A changes_requested verdict automatically starts the task's single correction, continuing the original goal and materials; an accepted one requires every declared output to exist.",
		].join(" "),
		parameters: pi.zod.object({
			taskId: pi.zod.string().describe("Task id whose round you reviewed"),
			round: pi.zod.number().optional().describe("Round reviewed; defaults to the task's newest round"),
			verdict: pi.zod
				.string()
				.describe("accepted when every criterion passed, changes_requested when a criterion failed, unverified when you could not judge"),
			findings: pi.zod
				.array(
					pi.zod.object({
						criterion: pi.zod.string().describe("The original acceptance criterion, verbatim"),
						status: pi.zod.string().describe("passed, failed, or blocked"),
						note: pi.zod.string().describe("What you observed, in your own words"),
						evidence: pi.zod.array(pi.zod.string()).describe("Commands, diffs or digests you actually used"),
					}),
				)
				.describe("One finding per original acceptance criterion"),
			artifacts: pi.zod
				.array(
					pi.zod.object({
						path: pi.zod.string().describe("Deliverable path inside the round outputs directory"),
						sha256: pi.zod.string().describe("Digest of the bytes you inspected"),
					}),
				)
				.describe("Deliverables you inspected, with their digests"),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await runReview(ctx, signal, params as unknown as WbReviewParams);
		},
	});

	/**
	 * Records the round's durable result fact, once.
	 *
	 * The queue is the record and the outbox is the notification; this only asks for
	 * the fact under the round's own stable identity. A refusal is logged rather than
	 * thrown: the business result is already committed, and a notification problem must
	 * never turn a proven outcome into a failure.
	 */
	function publishResultFact(task: ActiveTask): void {
		const round = currentRound(task.receipt);
		const db = openWriteConnection(task.receipt.projectRoot);
		try {
			const published = publishDelivery(db, {
				// The result fact is published by the identity that RAN the round.
				// The queue recorded the round against the executor's generation —
				// for an adopted round that is the successor, not the activation
				// whose approval it carries. Publishing under the approval owner
				// would look like a second live generation of one session.
				owner: task.durable.executor,
				taskId: task.taskId,
				round: round.number,
				kind: "result",
				revision: RESULT_FACT_REVISION,
			});
			if (published.kind === "refused") {
				pi.logger.warn(`The WorkBuddy result fact was not published: ${published.reason}`, {
					taskId: task.taskId,
				});
			}
		} catch (error) {
			pi.logger.warn(`The WorkBuddy result fact could not be published: ${messageOf(error)}`, {
				taskId: task.taskId,
			});
		} finally {
			closeQueueConnection(task.receipt.projectRoot, "write");
		}
	}

	/**
	 * Sends one rendered message into this OMP session as a real follow-up.
	 *
	 * `nextTurn` keeps it out of the editable pending box and `triggerTurn` schedules
	 * the model to consume it as its own turn. The host returns `void`, so this can
	 * only report that the message was accepted for delivery — consumption is a
	 * separate fact, recorded by {@link acknowledgeReviewedResult} after a review.
	 */
	function hostSendMessage(ctx: ExtensionContext, sessionId: string): (message: DeliveryMessage) => Promise<void> {
		return async (message) => {
			// A message addressed to another OMP conversation must never be injected
			// into this one; the outbox already filters by session, and this is the
			// second, cheaper guard at the point of injection.
			if (ctx.sessionManager.getSessionId() !== sessionId) {
				throw new WbTaskError(
					WB_ERROR_CODE.busy,
					"The WorkBuddy result belongs to a different OMP session",
				);
			}
			pi.sendMessage(
				{
					customType: "workbuddy-result",
					content: message.text,
					display: true,
					details: {
						deliveryId: message.deliveryId,
						taskId: message.taskId,
						round: message.round,
						kind: message.kind,
					},
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
		};
	}

	/**
	 * Flushes this conversation's pending result facts.
	 *
	 * The row is what survives a restart: an unacknowledged result stays pending, so
	 * the next session's flush reports it without resending any WorkBuddy work. One
	 * flush per session and generation is enforced inside `flushDelivery`.
	 */
	async function deliverPendingResults(
		ctx: ExtensionContext,
		projectRoot: string,
		owner: OwnerIdentity,
	): Promise<void> {
		const origin = ctx.sessionManager.getSessionId();
		if (origin !== owner.sessionId) {
			// A different OMP conversation is not a successor to this result.
			return;
		}
		const flushed = await flushDelivery({
			projectRoot,
			owner,
			sendMessage: hostSendMessage(ctx, origin),
		});
		if (flushed.failed > 0) {
			pi.logger.warn(
				`Some WorkBuddy results could not be delivered: ${flushed.failures.map((failure) => failure.reason).join("; ")}`,
			);
		}
	}

	/**
	 * Commits a task's one terminal state and finishes its lifecycle.
	 *
	 * Single-flight by construction: the first caller chooses the terminal state
	 * and performs the commit, and any later caller — a late success, a second
	 * cancellation, shutdown — joins the same promise instead of writing again.
	 * That keeps the worker's launch order intact: the terminal receipt is
	 * durable before the lock is released, and a failed write never releases it.
	 */
	function finalizeTask(
		task: ActiveTask,
		status: TaskStatus,
		error: TaskError | null,
		options: { cancelWorker?: boolean; collectArtifacts?: boolean } = {},
	): Promise<void> {
		const existing = task.finalization;
		if (existing !== null) {
			// A terminal state is already chosen; every later path only observes it.
			return existing;
		}

		// Waiters watch `finalization`, which is assigned synchronously below, so
		// `committed` can be released at the *end* of the commit — when the receipt is
		// provably on disk. Releasing it here would make "the durable commit
		// happened" true before anything was written, which is exactly the
		// claim-before-evidence failure this pipeline exists to remove.
		// Everything below runs with no `await` in between, so the state observed
		// here is the state the commit works from.
		const current = currentRound(task.receipt);
		current.status = status;
		current.error = error;
		current.summary = task.summary.trim();
		task.awaitingApproval = false;
		task.pendingApprovals.clear();
		setStatus(task.ctx);

		const finalization = (async () => {
			// The whole commit is guarded so this promise never rejects: it is
			// awaited by the turn, by tool calls and by shutdown, and an escaping
			// rejection would surface as an unhandled error rather than a result.
			try {
				// Persist the first business result before cancellation settling, artifact
				// scans or receipt IO. A failed receipt must not erase a known result
				// when this process exits, and the queue is the only authority that can
				// later repair the receipt without resending the prompt.
				recordFirstOutcome(task);

				if (options.cancelWorker === true) {
					const session = task.session;
					if (session !== null) {
						// A notification that fails cannot resurrect the task: the caller
						// already decided it is over.
						await session.cancel().catch((err: unknown) => {
							pi.logger.warn(`WorkBuddy cancel notification failed: ${messageOf(err)}`, {
								taskId: task.taskId,
							});
						});
						// `session/cancel` is one-way, so holding the connection open for
						// a bounded moment is the only way the worker can finish winding
						// the turn down and record its end. Closing immediately instead
						// leaves that session believing a turn is still running, and every
						// later prompt then queues behind it indefinitely. The bound keeps
						// a wedged worker from holding the cancellation open.
						const settled = await settlesWithin(task.turnEnded, cancelSettleMs);
						if (!settled) {
							pi.logger.warn(
								`WorkBuddy did not report the cancelled turn ending within ${cancelSettleMs}ms; releasing the connection anyway`,
								{ taskId: task.taskId },
							);
						}
					}
					task.abort.abort();
				}

				if (options.collectArtifacts === true) {
					const collected = await realCollectArtifacts(task.receipt).catch(() => null);
					if (collected !== null) {
						const currentR = currentRound(task.receipt);
						currentR.artifacts = collected.artifacts;
					}
				}

				const snapshot: TaskReceipt = {
					...task.receipt,
					rounds: task.receipt.rounds.map((r) => ({
						...r,
						inputFiles: [...r.inputFiles],
						expectedOutputs: [...r.expectedOutputs],
						artifacts: [...r.artifacts],
					})),
				};

				// Exactly one record owns a round's terminal state: the v3 receipt written
				// through the queue. The legacy v2 writer and the file-store lock are gone
				// from the live path; historical receipts remain readable through
				// `readTask`, and migration imports them.
				try {
					const written = await realWriteRoundReceipt(
						task.receipt.projectRoot,
						task.taskId,
						currentRound(task.receipt).number,
						"round",
						buildRoundReceipt(task, snapshot, status, error),
					);
					// A written receipt is not a confirmed commit: the queue must verify the
					// digest it was given and only then release the round's resources. A
					// mismatch or a failed transaction leaves the resources held, because an
					// unproven write is not evidence that the directory is free.
					const confirmed = await confirmDurableCommit(task, written.sha256);
					if (!confirmed) {
						return;
					}
				} catch (err: unknown) {
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					// The queue has to learn that this round's durable record failed.
					// Leaving the row `pending` with its hold and scope still held is the
					// N03 shape inverted: nothing exists on disk, nothing says why, and a
					// later reader cannot tell this from work still in progress.
					recordCommitFailure(task, messageOf(err));
					reportStorageFailure(pi, task, "v3 receipt write");
					return;
				}

				// Scope release is owned by the queue: `confirmReceipt` releases the
				// round's `works` row in the same transaction that proves the receipt,
				// and keeps it when the write is unproven. No second authority exists.

				if (task.storageError === null) {
					// Publish the durable result fact before the task leaves the map:
					// the fact is what a follow-up or `/wb results` reads, and a result
					// nobody can find is not delivered. Publication is idempotent, so a
					// second terminal path cannot create a second row.
					publishResultFact(task);
					tasks.delete(task.taskId);
					// The queue is advanced so a waiting round can run. It is
					// background work, but it touches the project's state, so it is
					// tracked: a shutdown must not return while it is still running.
					trackBackgroundWork(advanceQueuedRounds(task.ctx));
				}
			} catch (err: unknown) {
				task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
				reportStorageFailure(pi, task, "terminal commit");
			} finally {
				// The commit attempt has concluded, so the outcome is now observable.
				// Logging is a side channel: it must never change the result, hence the
				// swallow — an unwritable log is a diagnostic gap, not a task failure.
				const settledRound = currentRound(task.receipt);
				const storageError = task.storageError;
				// Awaited, unlike a progress record: this is the terminal evidence, and a
				// caller that reads the log right after a task ends must see it. The chain
				// cannot reject, so awaiting it cannot change the outcome.
				await logEvent(
					task.receipt.projectRoot,
					"dispatch.settled",
					{
						taskId: task.taskId,
						round: settledRound.number,
						// `requestId` is deliberately absent: the legacy receipt shape does
						// not carry one, and filling it with the session id would report a
						// correlation that does not exist.
						reasonCode: settledRound.status,
						errorCode: storageError?.code ?? settledRound.error?.code,
						ownerPid: process.pid,
					},
					storageError !== null ? "error" : "info",
				).catch(() => undefined);
				if (storageError !== null) {
					// The worker's outcome is preserved; what failed is the durable record.
					await logEvent(
						task.receipt.projectRoot,
						"commit.failed",
						{
							taskId: task.taskId,
							round: settledRound.number,
							errorCode: storageError.code,
							reasonCode: "receipt_uncommitted",
							ownerPid: process.pid,
						},
						"error",
					).catch(() => undefined);
				}
				// The footer is refreshed on every outcome: a retained task must read as
				// a storage problem, never as still running.
				setStatus(task.ctx);
			}
		})().finally(async () => {
			// The commit has finished (successfully or not): release any waiter now, so
			// it re-reads a state that is either durably committed or visibly failed.
			task.commitSettled = true;
			task.markCommitted();
			// The round's queue handle is only needed until the commit concludes.
			// Closing it here keeps a long-lived OMP process from accumulating one open
			// SQLite handle per task (and lets a fixture delete its project directory).
			//
			// The commit has already settled, so no facade of this task is live
			// any more. A sibling task of the same project may still be inside its
			// own scope, and its writes are what the cache is for: the next scope
			// opens a fresh handle, so this close costs nothing but a re-open.
			closeQueueConnection(task.receipt.projectRoot);
			closeQueueConnection(task.receipt.projectRoot, "read");
			task.abort.abort();
			const session = task.session;
			if (session !== null) {
				await session.close().catch((err: unknown) => {
					pi.logger.warn(`WorkBuddy session close failed: ${messageOf(err)}`, {
						taskId: task.taskId,
					});
				});
			}
		});

		task.finalization = finalization;
		return finalization;
	}

	/**
	 * `/wb bind`: enrolls this project's verified WorkBuddy sessions.
	 *
	 * The consent this records is project-wide: every verified same-project
	 * session is enrolled, and later sessions the user opens join the same roster
	 * without another prompt. That is what makes one OMP able to route unrelated
	 * tasks to separate WorkBuddy conversations, so the human is asked once —
	 * here — and the enrollment itself is not re-confirmed per session.
	 *
	 * The choice that remains is the project's own: a session that serves a
	 * different project is never enrolled, and the roster is written only after
	 * the project root itself is proven.
	 */
	async function runBind(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Binding needs an interactive OMP session.", "error");
			return;
		}
		const located = await locateProject(ctx);
		const projectRoot = located.projectRoot ?? located.actualCwd;
		let candidates: DesktopCandidate[];
		try {
			candidates = await realDiscover(projectRoot, new AbortController().signal);
		} catch (error) {
			ctx.ui.notify(`Could not look for WorkBuddy sessions: ${messageOf(error)}`, "error");
			return;
		}
		if (candidates.length === 0) {
			ctx.ui.notify(
				[
					`No verified WorkBuddy session is serving ${projectRoot}.`,
					"In the WorkBuddy desktop app: open this exact folder as the workspace, create (or open) the session reserved for OMP delegation,",
					'send it "仅确认当前工作目录，不修改文件，等待后续任务", then run /wb bind again.',
				].join("\n"),
				"warning",
			);
			return;
		}

		const previous = await realReadBinding(projectRoot).catch(() => null);
		// The consent is project-wide, so the human is asked one question: may this
		// project enroll every verified session that serves it? Asking per session
		// would be the old fixed-target model, and it would make a later session
		// need a second prompt.
		const confirmed = await ctx.ui.confirm(
			"Enroll this project's WorkBuddy sessions?",
			[
				`Project: ${projectRoot}`,
				`Verified sessions serving this project: ${candidates.length}`,
				"Every one of them may take its own delegated task.",
				"Sessions opened later for this project join the same roster without another prompt.",
				"Foreign projects' sessions are never enrolled.",
			].join("\n"),
		);
		if (!confirmed) {
			ctx.ui.notify("Binding unchanged.", "info");
			return;
		}
		// The default session is the one this project already used, so a rebind
		// does not silently move the project's existing conversation.
		const candidate =
			candidates.find((entry) => entry.binding.sessionId === previous?.sessionId) ?? candidates[0]!;
		if (previous !== null && previous.sessionId !== candidate.binding.sessionId) {
			const queue = openProjectQueue(projectRoot, { mode: "read" });
			if (queue === null) {
				ctx.ui.notify("Cannot verify pending work; the enrolled roster is unchanged.", "error");
				return;
			}
			try {
				if (queue.holds().length > 0 || readAllQueuedRounds(queue).some((row) =>
					row["status"] === "queued" || row["phase"] === "preparing" || row["dispatch_state"] === "possibly_sent")) {
					ctx.ui.notify("The enrolled roster cannot change while work is queued, active or quarantined. Resolve that work first.", "warning");
					return;
				}
			} finally {
				queue.close();
			}
		}

		// A binding that cannot be attached to is worse than none, so the exact
		// session is exercised before the record is written.
		if (candidate.binding.workbuddyVersion === "") {
			ctx.ui.notify(
				"Cannot verify the WorkBuddy version for this session; refusing to write an unverifiable binding.",
				"error",
			);
			return;
		}
		let session: DesktopSession | undefined;
		try {
			session = await realConnect(
				candidate.binding,
				{ onUpdate: async () => undefined, onRequest: async () => undefined },
				new AbortController().signal,
			);
		} catch (error) {
			ctx.ui.notify(`Could not attach to ${candidate.binding.sessionId}: ${messageOf(error)}`, "error");
			return;
		} finally {
			await session?.close().catch(() => undefined);
		}

		// The roster is the merged one: every verified same-project session joins
		// the enrollment, and the session the human picked stays the project's
		// default target. A session serving another project is excluded by the
		// reconciler, not by this call site. The desktop catalog adds the
		// project's existing sessions that no live worker is serving right now:
		// they are enrolled, but marked unverified until a worker proves it owns
		// them.
		let merged: Binding;
		try {
			const catalog = await readProjectSessionCatalog(
				projectRoot,
				overrides.workbuddyHomeDir ?? workBuddyHomeDir(),
				candidate.binding.sessionId,
			);
			merged = await reconcileProjectBinding(
				{
					version: 1,
					projectRoot,
					sessionId: candidate.binding.sessionId,
					workbuddyVersion: candidate.binding.workbuddyVersion,
				},
				candidates,
				catalog.sessions,
			);
		} catch (error) {
			ctx.ui.notify(`Could not enroll this project's WorkBuddy sessions: ${messageOf(error)}`, "error");
			return;
		}
		await realWriteBinding(merged);
		syncPoolRoster(projectRoot, merged, candidates);
		const enrolled = listBoundSessions(merged);
		const verifiedCount = enrolled.filter((member) => member.verified !== false).length;
		ctx.ui.notify(
			[
				`Enrolled ${projectRoot} with ${enrolled.length} WorkBuddy session(s) (${verifiedCount} verified live).`,
				`Default session: ${merged.sessionId} (${candidate.endpoint}).`,
				"Every verified session serving this project can now take its own task; sessions opened later join the same roster without another prompt.",
			].join("\n"),
			"info",
		);
	}

	/**
	 * Opens the workbench, or prints the same facts when there is no UI.
	 *
	 * The snapshot comes from the surfaces that already own each fact — the
	 * resolver, the queue projection and this process's live tasks — so the pages
	 * cannot disagree with the tools.
	 */
	async function runWorkbench(ctx: ExtensionCommandContext): Promise<void> {
		const located = await locateProject(ctx);
		const projectRoot = located.projectRoot;
		let queueSnapshot: QueueSnapshot | null = null;
		// The wait reason of every queued round, read from the queue's own facts.
		// Keyed by task and round, so a page never shows one round's reason on
		// another's row.
		const queueWaitStates = new Map<string, TaskWaitState>();
		if (projectRoot !== null) {
			try {
				const queue = openProjectQueue(projectRoot, { mode: "read" });
				// The sessions page reports each member's real availability, and the
				// tasks page reports each queued round's real wait reason. Both come
				// from the queue's own rows, so they are requested here rather than
				// guessed from the binding record.
				queueSnapshot = queue === null ? null : queue.inspect({ include: { sessions: true } });
				if (queue !== null) {
					for (const row of readAllQueuedRounds(queue)) {
						if (String(row["status"] ?? "") !== "queued") {
							continue;
						}
						const taskId = String(row["task_id"]);
						const round = Number(row["round"] ?? 1);
						queueWaitStates.set(`${taskId}/${round}`, queue.waitState(taskId, round));
					}
				}
				queue?.close();
			} catch {
				// A project whose state cannot be read still opens the workbench: the
				// diagnostics page is exactly where that belongs.
				queueSnapshot = null;
			}
		}

		// This process's live tasks, before anything that projects them.
		const live = [...tasks.values()];

		// Sessions come from what this process can prove locally: listing a worker must never
		// become an attach.
		const sessionRows: Array<{
			sessionId: string;
			title: string;
			participation: string;
			availability: string;
			reason: string | null;
			source: string;
		}> = [];
		if (projectRoot !== null) {
			// The roster page states what this process can prove locally: every session
			// enrolled for this project and this process's own connections. Probing
			// endpoints is not a render-time activity — a page must open instantly in a
			// project with no worker, and an unreachable socket is a diagnosis for
			// `/wb doctor`, not a reason to stall the interface.
			const bound = await realReadBinding(projectRoot).catch(() => null);
			if (bound !== null) {
				// The enrolled roster is the project's real capacity: a project may have
				// several WorkBuddy conversations, and showing only the default one would
				// hide the sessions a waiting task can actually use.
				//
				// The availability comes from the queue's own roster rows, which are
				// the facts the claim arbitrates over. Guessing "idle" for every
				// enrolled member would tell a user that a busy or offline session is
				// free — the one mistake a page about a stuck task must not make.
				const roster = new Map(
					(queueSnapshot?.sessions ?? []).map((row) => [String(row["session_id"]), row]),
				);
				for (const member of listBoundSessions(bound)) {
					const attached = live.some(
						(task) => task.session !== null && toTaskView(task.receipt, task).sessionId === member.sessionId,
					);
					const recorded = roster.get(member.sessionId);
					const availability =
						attached
							? "busy"
							: typeof recorded?.["availability"] === "string"
								? (recorded["availability"] as string)
								: "unknown";
					sessionRows.push({
						sessionId: member.sessionId,
						title: member.title ?? `WorkBuddy ${member.workbuddyVersion ?? bound.workbuddyVersion}`,
						participation: attached
							? "connected"
							: recorded === undefined
								? "bound"
								: (recorded["identity"] === "verified" ? "bound" : "pending_verification"),
						availability,
						reason:
							recorded === undefined
								? null
								: recorded["ownership_conflict"] === 1
									? "ownership_conflict"
									: availability === "idle" && recorded["identity"] !== "verified"
										? "session_unavailable"
										: availability === "idle"
											? null
											: availability,
						source: bound.autoBindProjectSessions === true ? "enrolled roster" : "binding record",
					});
				}
			}
			for (const task of live) {
				const sessionId = task.session === null ? null : toTaskView(task.receipt, task).sessionId;
				if (sessionId === null || sessionRows.some((row) => row.sessionId === sessionId)) {
					continue;
				}
				sessionRows.push({
					sessionId,
					title: "attached by this process",
					participation: "connected",
					availability: "busy",
					reason: null,
					source: "live task",
				});
			}
		}

		const rows = (queueSnapshot?.tasks ?? []).map((row) => {
			const view = live.find((task) => task.taskId === String(row["task_id"]));
			const projected = view === undefined ? null : toTaskView(view.receipt, view);
			const taskId = String(row["task_id"]);
			const round = Number(row["round"] ?? 1);
			// The wait reason is the queue's own answer, not a guess from the
			// phase: "queued" says the round has not started, but not *why* it
			// has not started, and the why is what a stuck user needs.
			const queued = String(row["status"] ?? "") === "queued";
			const wait = queued ? queueWaitStates.get(`${taskId}/${round}`) ?? null : null;
			return {
				taskId,
				round,
				status: String(row["status"] ?? "unknown"),
				waitReason: wait?.reason ?? null,
				owner: typeof row["owner_session"] === "string" ? row["owner_session"] : null,
				executor: typeof row["selected_session"] === "string" ? row["selected_session"] : null,
				reviewState: String(row["review_state"] ?? "pending"),
				artifacts: projected === null ? [] : projected.artifacts.map((artifact) => artifact.path),
				sessionBlockers: wait?.sessionBlockers ?? [],
			};
		});

		// Live tasks not yet visible in the queue projection (the legacy path writes
		// receipts, not rounds) are still shown, so the page never hides work in flight.
		for (const task of live) {
			if (rows.some((row) => row.taskId === task.taskId)) {
				continue;
			}
			const view = toTaskView(task.receipt, task);
			rows.push({
				taskId: view.taskId,
				round: view.round,
				status: view.status,
				waitReason: null,
				owner: null,
				executor: task.session === null ? null : view.sessionId,
				reviewState: view.commitState,
				artifacts: view.artifacts.map((artifact) => artifact.path),
				sessionBlockers: [],
			});
		}

		const snapshot = withCounts({
			tasks: rows,
			sessions: sessionRows,
			diagnostics: {
				// These are the facts a user checks first when nothing happens: is the bridge
				// installed, is the project registered, is anything actually running. Reporting
				// `null` for all three made the page look un-implemented.
				// Installation is not proven here: the release directory and managed config are
				// what `/wb doctor` inspects. Reporting a queue fact under an "installed" label
				// would answer a question the page never asked.
				install: null,
				projectState:
					projectRoot === null
						? null
						: queueSnapshot === null
							? "authorized, but no project queue"
							: "enabled, queue readable",
				active: `${tasks.size} task(s) in this process, ${sessionRows.filter((row) => row.availability === "idle").length} idle worker(s)`,
				projectRoot,
				issues:
					projectRoot === null
						? [
								{
									severity: "error",
									message: located.reason ?? `No authorized project covers ${located.actualCwd}.`,
									nextAction: "Run /wb setup in this project to authorize it.",
								},
							]
						: // The issues list stays local: `runDoctor` probes the worker, and a page
							// render must not wait on the network. `/wb doctor` is where that runs.
							[],
			},
		});

		if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
			const text = WORKBENCH_PAGES.flatMap((page) => [`— ${page} —`, ...renderWorkbench(snapshot, page, 100), ""]).join(
				"\n",
			);
			ctx.ui.notify(text, "info");
			return;
		}

		// The component keeps the page in its own state and re-renders on input; the
		// snapshot is captured once so a page turn cannot show a half-updated view.
		let page: WorkbenchPage = "tasks";
		await ctx.ui.custom<null>((_tui, _theme, _keybindings, done) => {
			const component = {
				render: (width: number) => renderWorkbench(snapshot, page, width),
				handleInput: (data: string) => {
					if (data === "\t" || data === "l" || data === "\u001b[C") {
						page = nextPage(page);
						return;
					}
					if (data === "h" || data === "\u001b[D") {
						page = previousPage(page);
						return;
					}
					if (data === "\u001b" || data === "q") {
						done(null);
					}
				},
				invalidate: () => undefined,
			};
			return component;
		});
	}

	async function runStatus(ctx: ExtensionCommandContext): Promise<void> {
		// The command reports on the same project the tools act on. When no root can
		// be proven, the report says so instead of describing the raw directory.
		const located = await locateProject(ctx);
		const projectRoot = located.projectRoot;
		const lines: string[] = [];
		if (projectRoot === null) {
			ctx.ui.notify(
				`${located.reason ?? `No authorized project covers ${located.actualCwd}.`}\nRun /wb setup in this project to authorize it.`,
				"info",
			);
			return;
		}
		const resolved = await requireBinding(ctx);
		if ("failure" in resolved) {
			lines.push(`No binding for ${projectRoot}. Run /wb bind.`);
			lines.push("Queue: not enabled yet (run /wb init to create and import project state)");
		} else {
			const { binding, access } = resolved;
			const roster = listBoundSessions(binding);
			// The status reports the pool the project actually has, not one pinned
			// uuid: a project may enroll several WorkBuddy conversations, and the
			// number of them is the project's real delegation capacity.
			lines.push(
				binding.autoBindProjectSessions === true
					? `Enrolled WorkBuddy sessions: ${roster.length} (default ${binding.sessionId}, WorkBuddy ${binding.workbuddyVersion})`
					: `Bound session: ${binding.sessionId} (WorkBuddy ${binding.workbuddyVersion})`,
			);
			if (roster.length > 1) {
				lines.push(`Session roster: ${roster.map((member) => member.sessionId).join(", ")}`);
			}
			lines.push(
				access.enabled
					? "Queue: enabled"
					: "Queue: not enabled yet (run /wb init to create and import project state)",
			);
			try {
				const candidates = await realDiscover(projectRoot, new AbortController().signal);
				const bySession = new Map(
					candidates.map((entry) => [entry.binding.sessionId, entry] as const),
				);
				const running = roster.filter((member) => bySession.has(member.sessionId));
				const offline = roster.filter((member) => !bySession.has(member.sessionId));
				lines.push(
					`Workers: ${running.length} of ${roster.length} enrolled session(s) answering` +
						(running.length === 0
							? "."
							: ` (${running
									.map((member) => {
										const match = bySession.get(member.sessionId);
										return `${member.sessionId}: ${match?.busy === true ? "busy" : "idle"}`;
									})
									.join(", ")}).`),
				);
				if (offline.length > 0) {
					// An offline session is still enrolled: it is simply not answering
					// right now, and it must not be dropped from the roster.
					lines.push(`Offline (still enrolled): ${offline.map((member) => member.sessionId).join(", ")}`);
				}
			} catch (error) {
				lines.push(`Worker: probe failed (${messageOf(error)}).`);
			}
		}
		const mine = [...tasks.values()].filter(
			(task) => task.durable.owner.sessionId === ctx.sessionManager.getSessionId() &&
				task.receipt.projectRoot === projectRoot,
		);
		lines.push(
			mine.length === 0
				? "Active tasks in this OMP session: none."
				: `Active tasks in this OMP session: ${mine
						.map(
							(task) =>
								`${task.taskId} (${currentRound(task.receipt).status}, session ${
									toTaskView(task.receipt, task).sessionId
								})`,
						)
						.join(", ")}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	/**
	 * Resolves the project's binding, refusing to work from an unbound folder.
	 * Binding and queue-access are two distinct facts; stage 4 will make `enabled` mandatory.
	 */
	/** Projects this activation has already swept for abandoned rounds. */
	const reconciled = new Set<string>();

	/**
	 * Recovers rounds left by a dead owner, once per project per activation.
	 *
	 * Best effort on purpose: recovery is a repair of someone else's crash, so it must
	 * never be the reason a live call fails. Only provably dead owners are touched.
	 */
	async function reconcileProject(projectRoot: string): Promise<void> {
		if (reconciled.has(projectRoot)) {
			return;
		}
		reconciled.add(projectRoot);
		let recovered: AbandonedRound[];
		try {
			const queue = openProjectQueue(projectRoot, { mode: "write" });
			if (queue === null) {
				return;
			}
			try {
				// The recovery sweep is synchronous: it only reads the queue's
				// own rows and marks them. Nothing may hold the project's
				// connection across the log writes below.
				recovered = queue.reconcileAbandonedRounds({ now: Date.now() });
			} finally {
				queue.close();
			}
		} catch {
			// A project whose queue cannot be opened has nothing to reconcile, and a failed
			// repair must not block the call that triggered it.
			return;
		}
		for (const round of recovered) {
			await logEvent(projectRoot, "recovery.required", {
				taskId: round.taskId,
				round: round.round,
				reasonCode: round.action,
				ownerPid: process.pid,
			}).catch(() => undefined);
		}
	}

	async function requireBinding(
		ctx: ExtensionContext,
	): Promise<
		| { binding: Binding; projectRoot: string; actualCwd: string; relativeCwd: string; access: ProjectAccess }
		| { failure: AgentToolResult<unknown> }
	> {
		let resolution: ProjectResolution;
		try {
			resolution = await realResolveProjectContext(ctx.cwd, {
				classify: inspectProjectMarker,
			});
		} catch (error) {
			return { failure: failureResult(messageOf(error), codeOf(error)) };
		}
		if (resolution.authorization === "unauthorized") {
			return {
				failure: failureResult(
					resolution.reason ?? `No authorized WorkBuddy project covers ${resolution.actualCwd}. Run /wb setup.`,
					WB_ERROR_CODE.bindingInvalid,
				),
			};
		}
		if (resolution.authorization === "pending_verification" || resolution.projectRoot === null) {
			return {
				failure: failureResult(
					resolution.reason ?? "Project ownership is ambiguous; confirm the project for this session.",
					WB_ERROR_CODE.bindingInvalid,
				),
			};
		}
		const projectRoot = resolution.projectRoot;
		let binding: Binding | null;
		try {
			binding = await realReadBinding(projectRoot);
		} catch (error) {
			return { failure: failureResult(messageOf(error), codeOf(error)) };
		}
		if (binding === null) {
			return {
				failure: failureResult(
 					`No WorkBuddy binding for ${projectRoot}. Run /wb bind first.`,
					WB_ERROR_CODE.bindingInvalid,
				),
			};
		}
		if (binding.projectRoot !== projectRoot) {
			return {
				failure: failureResult(
					`The binding belongs to ${binding.projectRoot}, not ${projectRoot}. Bind this project separately.`,
					WB_ERROR_CODE.bindingInvalid,
				),
			};
		}
		// The project's own state is brought up to this build's shape before it is
		// read or written. A project set up by an earlier build still declares
		// the older schema version, and every write path refuses that — so
		// without this, a restart could not dispatch anything and the user's
		// only remedy would be a manual setup step.
		//
		// The upgrade is production's own and it is safe: it backs the file up
		// first, runs in one transaction, preserves the enabled and migrated
		// timestamps, and never prompts, never creates or attaches a WorkBuddy
		// session and never sends a prompt. It runs only for a project that is
		// already authorized *and* already has state on disk, so an arbitrary
		// working directory gains nothing and a project whose state was removed
		// stays removed.
		await upgradeProjectStateIfAuthorized(projectRoot);
		const access = (await realReadProjectAccess(projectRoot)) ?? {
			projectRoot,
			enabled: false,
			migrated: false,
		};
		// A round abandoned by a dead owner keeps the WorkBuddy session hold forever,
		// because rollback only runs in the process that took the claim. Reconciling here
		// — the one place every write path passes through — makes the sweep happen before
		// the caller can be told the session is busy.
		await reconcileProject(projectRoot);
		return {
			binding,
			projectRoot,
			actualCwd: resolution.actualCwd,
			relativeCwd: resolution.relativeCwd,
			access,
		};
	}

	/**
	 * Locates the project root for a read-only surface.
	 *
	 * Read-only commands (`status`, `tasks`, `doctor`, `/wb status`) must answer
	 * about the *same* project the write path would use, otherwise one session
	 * reports "not found" for a task that another entry point just created. They
	 * must also still work on a project that is not authorized yet — diagnosing
	 * that state is the point of `doctor` — so this returns whatever the resolver
	 * could prove and lets the caller decide what a missing root means.
	 */
	async function locateProject(
		ctx: ExtensionContext,
	): Promise<ProjectResolution> {
		return realResolveProjectContext(ctx.cwd, { classify: inspectProjectMarker });
	}


	/**
	 * Asks which side should produce a deliverable both sides can produce.
	 *
	 * OMP ships skills for several of the same deliverables WorkBuddy owns (`.docx`,
	 * `.pdf`), so "the user asked for a Word report" no longer implies "delegate".
	 * A model that silently decides either way takes a decision that belongs to the
	 * user: delegating spends a WorkBuddy session and its quota, doing it locally
	 * gives up WorkBuddy's office pipeline. Asking once, before the task is staged,
	 * keeps that choice explicit — and costs nothing when the answer is "not here".
	 *
	 * `undecided` is its own outcome, not a local choice: a dismissed dialog says
	 * nothing about where the work should happen, and reporting it as "do it
	 * locally" would act on a question the human never answered.
	 */
	async function askWorkflowForOverlap(
		ctx: ExtensionContext,
		expectedOutputs: readonly string[],
	): Promise<{ outcome: "workbuddy" | "local" | "undecided"; overlapping: string[] } | null> {
		if (!ctx.hasUI) {
			return null;
		}
		const overlapping = expectedOutputs.filter((path) => WORKBUDDY_OVERLAPPING_OUTPUTS.test(path));
		if (overlapping.length === 0) {
			return null;
		}
		const choice = await ctx.ui.select(
			[
				`This deliverable can also be produced here (${overlapping.join(", ")}).`,
				"WorkBuddy performs it in its desktop session; OMP can build it with its own skills.",
				"Where should this run?",
			].join(" "),
			[WB_WORKFLOW_OPTION, LOCAL_WORKFLOW_OPTION],
		);
		if (choice === WB_WORKFLOW_OPTION) {
			return { outcome: "workbuddy", overlapping };
		}
		if (choice === LOCAL_WORKFLOW_OPTION) {
			return { outcome: "local", overlapping };
		}
		return { outcome: "undecided", overlapping };
	}

	async function runTask(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		params: TaskRequest,
	): Promise<AgentToolResult<unknown>> {
		const resolved = await requireBinding(ctx);
		if ("failure" in resolved) {
			return resolved.failure;
		}
		const { projectRoot, access } = resolved;
		// The binding is re-read after the pool refresh below, so the roster this
		// dispatch uses is the one that was just verified.
		let { binding } = resolved;
		// A binding alone does not authorize dispatch: the project must also be
		// enabled. Refusing here (rather than deep inside the queue) is what makes
		// an un-migrated or un-enabled project fail on its first delegation instead
		// of silently running on the legacy file-based path.
		if (!access.enabled || !access.migrated) {
			const missing = !access.migrated ? "project state has not been migrated" : "project is not enabled";
			return failureResult(
				`${missing} for ${projectRoot}. Run /wb setup to migrate and enable it.`,
				WB_ERROR_CODE.migrationRequired,
			);
		}
		// The enrolled roster is refreshed before the work is staged, so a session
		// the user opened since the last run can take this task. This refresh is
		// forced: the user may have opened a session seconds ago, and that
		// session is exactly what the waiting task needs. Concurrent refreshes
		// still share one handshake, so a burst of parallel delegations performs
		// one discovery rather than one per call.
		await refreshProjectPool(projectRoot, { force: true });
		const refreshedBinding = await realReadBinding(projectRoot).catch(() => null);
		if (refreshedBinding !== null && refreshedBinding.projectRoot === projectRoot) {
			binding = refreshedBinding;
		}

		if (typeof params.goal !== "object" || params.goal === null) {
			return failureResult("Task goal must be an object", WB_ERROR_CODE.inputInvalid);
		}
		if (typeof params.goal.objective !== "string" || params.goal.objective.trim().length === 0) {
			return failureResult("Task objective must be a non-empty string", WB_ERROR_CODE.inputInvalid);
		}
		if (
			!Array.isArray(params.goal.acceptance) ||
			params.goal.acceptance.length === 0 ||
			params.goal.acceptance.some((a) => typeof a !== "string" || a.trim().length === 0)
		) {
			return failureResult("Task goal must have at least one non-empty acceptance criterion", WB_ERROR_CODE.inputInvalid);
		}

		let previousRound = 0;
		/**
		 * The concrete WorkBuddy session this round is pinned to, when it is pinned.
		 *
		 * A supplement continues the same logical task, so it continues on the
		 * session that task already ran on. That session is read from the queue's
		 * durable record, not from the current binding: the binding names the
		 * project's sessions, and a rebind must not move work that is already
		 * under way.
		 */
		let pinnedSessionId: string | null = null;
		if (params.taskId !== undefined) {
			let existingReceipt: TaskReceipt;
			try {
				existingReceipt = await realReadTask(projectRoot, params.taskId);
			} catch (error) {
				return failureResult(messageOf(error), codeOf(error));
			}
			const current = currentRound(existingReceipt);
			if (statusIsInFlight(current.status)) {
				return failureResult(
					`Task ${params.taskId} is currently ${current.status}; supplementary work requires a terminal state`,
					WB_ERROR_CODE.busy,
				);
			}
			const queue = openProjectQueue(projectRoot, { mode: "read" });
			if (queue === null) {
				return failureResult("The original task authority is unavailable.", WB_ERROR_CODE.storageError);
			}
			try {
				const row = queue.inspect({ taskId: params.taskId }).tasks.find(
					(candidate) => Number(candidate["round"]) === current.number,
				);
				if (
					row === undefined || row["owner_session"] !== ctx.sessionManager.getSessionId() ||
					row["commit_state"] !== "committed" || row["dispatch_state"] !== "ended"
				) {
					return failureResult(
						"Supplementary work requires this OMP's committed, ended task.",
						WB_ERROR_CODE.taskStateInvalid,
					);
				}
				// The durable affinity is the authority on which session the task owns.
				// A receipt that names a different session than the queue recorded is
				// refused rather than reconciled by guesswork.
				pinnedSessionId = queue.taskSession(params.taskId) ?? existingReceipt.sessionId;
				if (pinnedSessionId !== existingReceipt.sessionId) {
					return failureResult(
						`Task ${params.taskId} recorded session ${existingReceipt.sessionId}, but the queue recorded ${pinnedSessionId}; the task's target is ambiguous.`,
						WB_ERROR_CODE.taskStateInvalid,
					);
				}
			} finally {
				queue.close();
			}
			// `readTask` resolves only the newest round's receipt, so its `rounds.length`
			// is 1 for every single-round v3 file: using it as the previous round would
			// compute round 2 again for a task already on round 3, re-enqueueing work that
			// exists. The round number itself is what the next round continues from.
			previousRound = current.number;
		}

		// Validate and snapshot inputs
		const snapshottedInputs: Array<{ path: string; sha256: string; bytes: number }> = [];
		if (params.inputFiles && params.inputFiles.length > 0) {
			const seen = new Set<string>();
			for (const rawInput of params.inputFiles) {
				if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
					return failureResult("Input file path must be a non-empty string", WB_ERROR_CODE.inputInvalid);
				}
				if (
					path.isAbsolute(rawInput) ||
					rawInput.startsWith("/") ||
					rawInput.startsWith("\\") ||
					/^[a-zA-Z]:/.test(rawInput)
				) {
					return failureResult(`Input file path must be relative: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				if (rawInput.split(/[/\\]/).some((s) => s === "..")) {
					return failureResult(`Input file path contains '..' traversal: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				const resolvedInput = path.resolve(projectRoot, rawInput);
				let st;
				try {
					st = await stat(resolvedInput);
				} catch {
					return failureResult(`Input file does not exist: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				if (!st.isFile()) {
					return failureResult(`Input file is not a regular file: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				let targetReal: string;
				try {
					targetReal = await realpath(resolvedInput);
				} catch {
					return failureResult(`Input file realpath resolution failed: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				const relFromRoot = path.relative(projectRoot, targetReal);
				if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relFromRoot === "") {
					return failureResult(`Input file resolves outside project root: "${rawInput}"`, WB_ERROR_CODE.inputInvalid);
				}
				const normalized = path.normalize(rawInput).split(path.sep).join("/");
				if (!seen.has(normalized)) {
					seen.add(normalized);
					const fileHash = await computeFileSha256(targetReal);
					// The byte count is part of the manifest payload, so it is captured with
					// the hash rather than re-stat-ed at a different moment later.
					snapshottedInputs.push({ path: normalized, sha256: fileHash, bytes: st.size });
				}
			}
		}

		// Validate expectedOutputs
		const validatedOutputs: string[] = [];
		if (params.expectedOutputs && params.expectedOutputs.length > 0) {
			const seenOut = new Set<string>();
			for (const rawOut of params.expectedOutputs) {
				if (typeof rawOut !== "string" || rawOut.trim().length === 0) {
					return failureResult("Expected output path must be a non-empty string", WB_ERROR_CODE.inputInvalid);
				}
				if (
					path.isAbsolute(rawOut) ||
					rawOut.startsWith("/") ||
					rawOut.startsWith("\\") ||
					/^[a-zA-Z]:/.test(rawOut)
				) {
					return failureResult(`Expected output path must be relative: "${rawOut}"`, WB_ERROR_CODE.inputInvalid);
				}
				if (rawOut.split(/[/\\]/).some((s) => s === "..")) {
					return failureResult(`Expected output path contains '..' traversal: "${rawOut}"`, WB_ERROR_CODE.inputInvalid);
				}
				const normalized = path.normalize(rawOut).split(path.sep).join("/");
				if (!seenOut.has(normalized)) {
					seenOut.add(normalized);
					validatedOutputs.push(normalized);
				}
			}
		}

		const goal: TaskGoal = {
			objective: params.goal.objective,
			context: params.goal.context ?? "",
			constraints: params.goal.constraints ?? [],
			acceptance: params.goal.acceptance,
			externalActions: params.goal.externalActions ?? [],
		};

		// A deliverable OMP can also build is a choice, not a necessity — but only
		// when the user actually asked for WorkBuddy. `requestedByUser` is the
		// model's own claim (the plugin never sees the conversation), and it is used
		// only to decide whether to ask: if the model is delegating on its own
		// initiative there is no user preference to arbitrate, so the round proceeds.
		// Asking here — after validation, before anything is staged or enqueued —
		// means a "keep it local" answer leaves no task, no lock and no round behind.
		// The answer itself is not written into the brief: it is routing metadata,
		// and WorkBuddy reads `goal.constraints` as instructions for its own work.
		const workflow =
			params.requestedByUser === true ? await askWorkflowForOverlap(ctx, validatedOutputs) : null;
		if (workflow !== null && workflow.outcome === "local") {
			return {
				content: [
					{
						type: "text",
						text: `The user chose to keep ${workflow.overlapping.join(", ")} in this session; complete it here and do not delegate it to WorkBuddy.`,
					},
				],
				details: { workflow: "local" },
			};
		}
		if (workflow !== null && workflow.outcome === "undecided") {
			// Nothing was chosen, so nothing may proceed. Telling the model "local"
			// here would be inventing an answer; it is told to ask again instead.
			return {
				content: [
					{
						type: "text",
						text: `The workflow question for ${workflow.overlapping.join(", ")} was dismissed and nothing was delegated. Ask the user which side should produce it before retrying.`,
					},
				],
				details: { workflow: "undecided" },
			};
		}

		const requestId = crypto.randomUUID();
		const draftTaskId = params.taskId ?? crypto.randomUUID();
		// A new task is authorized against the project's whole pool: the concrete
		// WorkBuddy session is chosen by the queue when the round is claimed, so two
		// unrelated tasks can land in two different conversations. A supplement is
		// pinned to the session its task already owns.
		const draftTargetPolicy: TargetPolicy =
			pinnedSessionId === null
				? { kind: "workspace_pool", role: null }
				: { kind: "session", sessionId: pinnedSessionId };
		// The digest of the exact material the dialog is about to describe, built by the
		// same function staging uses, so the two cannot disagree about what was approved.

		const draftOwner = queueOwnerFor(ctx);
		const draftManifestSha256 = buildConfirmationDigest({
			projectRoot,
			requestId,
			taskId: draftTaskId,
			round: previousRound + 1,
			owner: draftOwner,
			goal,
			targetPolicy: draftTargetPolicy,
			expectedOutputs: validatedOutputs,
			inputs: snapshottedInputs,
			deliveryMode: "foreground",
		});
		const draft: FrozenDraft = {
			requestId,
			projectRoot,
			targetPolicy: draftTargetPolicy,
			previousRound,
			taskId: params.taskId,
			taskIdForRound: draftTaskId,
			goal,
			inputFiles: snapshottedInputs,
			expectedOutputs: validatedOutputs,
			manifestSha256: draftManifestSha256,
			rawRequest: { ...params, goal },
			createdAt: new Date().toISOString(),
			owner: draftOwner,
		};
		// The draft lives under its own request id, so a second, unrelated
		// delegation cannot cancel this one.
		pendingDrafts.set(requestId, draft);

		/**
		 * Whether this draft may still be acted on.
		 *
		 * The draft must still exist, still belong to this project, and still
		 * belong to the OMP identity that staged it. A dialog that answers after
		 * its draft was resolved — or after the conversation was switched — must
		 * not submit anything.
		 */
		const draftIsLive = (): boolean => {
			const current = pendingDrafts.get(requestId);
			return (
				current !== undefined &&
				current.projectRoot === projectRoot &&
				current.owner.sessionId === draftOwner.sessionId &&
				current.owner.generation === draftOwner.generation
			);
		};
		/** Resolves this draft, so a later answer cannot act on it. */
		const resolveDraft = (): void => {
			if (pendingDrafts.get(requestId) === draft) {
				pendingDrafts.delete(requestId);
			}
		};

		if (!ctx.hasUI) {
			return {
				content: [
					{
						type: "text",
						text: `Human confirmation required before submitting to WorkBuddy.\nRequestId: ${requestId}\nRun /wb send ${requestId} in OMP to confirm and submit this round.`,
					},
				],
				details: {
					decision: "needs_confirmation",
					requestId,
					goal: draft.goal,
					inputFiles: draft.inputFiles.map((i) => i.path),
					expectedOutputs: draft.expectedOutputs,
				},
				isError: true,
			};
		}

		const promptDetails = [
			`Objective: ${draft.goal.objective}`,
			draft.goal.context ? `Context: ${draft.goal.context}` : undefined,
			draft.goal.constraints.length > 0 ? `Constraints: ${draft.goal.constraints.join("; ")}` : undefined,
			`Acceptance: ${draft.goal.acceptance.join("; ")}`,
			draft.inputFiles.length > 0 ? `Inputs: ${draft.inputFiles.map((i) => i.path).join(", ")}` : undefined,
			draft.expectedOutputs.length > 0 ? `Expected Outputs: ${draft.expectedOutputs.join(", ")}` : undefined,
			draft.goal.externalActions.length > 0
				? `External Actions: ${draft.goal.externalActions.map((a) => `[${a.kind}] ${a.target} (${a.operation})`).join(", ")}`
				: undefined,
		]
			.filter((l): l is string => l !== undefined)
			.join("\n");

		const targetChoices = ["Submit this round", "Keep in OMP", "Cancel"];
		const targetChoice = await ctx.ui.select(
			`Confirm WorkBuddy delegation round:\n${promptDetails}`,
			targetChoices,
			signal ? { signal } : undefined,
		);

		if (signal?.aborted || !draftIsLive()) {
			resolveDraft();
			return {
				content: [{ type: "text", text: "Delegation cancelled." }],
				details: { decision: "cancelled" },
				isError: false,
			};
		}

		if (targetChoice === "Keep in OMP") {
			resolveDraft();
			return {
				content: [{ type: "text", text: "Task kept in OMP; not delegated to WorkBuddy." }],
				details: { decision: "keep_in_omp" },
				isError: false,
			};
		}

		if (targetChoice !== "Submit this round") {
			resolveDraft();
			return {
				content: [{ type: "text", text: "Delegation cancelled by user." }],
				details: { decision: "cancelled" },
				isError: false,
			};
		}

		if (draft.goal.externalActions.length > 0) {
			const actionDetails = draft.goal.externalActions
				.map((a) => `- [${a.kind}] target: ${a.target}, operation: ${a.operation}, parameters: ${a.parameters}`)
				.join("\n");
			const extChoices = ["Approve these exact actions once", "Do not run external actions"];
			const extChoice = await ctx.ui.select(
				`Authorizing external side-effects for this round:\n${actionDetails}`,
				extChoices,
				signal ? { signal } : undefined,
			);

			if (
				signal?.aborted ||
				!draftIsLive() ||
				extChoice !== "Approve these exact actions once"
			) {
				resolveDraft();
				return failureResult(
					"External actions not approved by human; round will not be submitted",
					WB_ERROR_CODE.approvalUnsupported,
				);
			}
		}

		const confirmation: RoundConfirmationV3 = {
			source: "host_dialog",
			at: new Date().toISOString(),
			targetPolicy: draft.targetPolicy,
			requestId: draft.requestId,
			manifestSha256: draft.manifestSha256,
			owner: draft.owner,
			previousRound: draft.previousRound,
			inputs: draft.inputFiles.map((input) => ({ path: input.path, sha256: input.sha256 })),
			deliveryMode: "foreground",
		};
		resolveDraft();

		return await runConfirmedTask(ctx, binding, draft.rawRequest, confirmation, signal, draft.taskIdForRound);
	}

	/**
	 * The advice a queued pool round carries.
	 *
	 * Each pool reason calls for the action that actually unblocks it, so each
	 * one says which it is. Only exhaustion — every enrolled session has
	 * already carried a task — needs a new conversation; a busy or unreachable
	 * session is a wait that resolves itself, and telling the user to open
	 * another session there would send them to fix nothing.
	 */
	function poolWaitAdvice(reason: string): string {
		switch (reason) {
			case "no_enrolled_session":
				return "This project has no enrolled WorkBuddy session yet. Open a WorkBuddy session for this project and it will be enrolled automatically.";
			case "no_unused_session":
				return "Every WorkBuddy session enrolled for this project has already carried a task, and a finished conversation is never reused for an unrelated one. Open another WorkBuddy session on this project and it will be enrolled automatically.";
			case "all_sessions_busy":
				return "Every eligible WorkBuddy session is busy right now. It will run as soon as one frees up.";
			case "sessions_unavailable":
				return "No eligible WorkBuddy session is currently available for this round. Check the required role and each session's live availability, and open a session for this project if none of them fits.";
			case "sessions_busy_or_unavailable":
				return "The eligible WorkBuddy sessions are blocked for different reasons. Inspect the listed per-session blockers to see which one is busy, unavailable or already carrying other work; this round runs when one of them becomes eligible.";
			case "ownership_conflict":
				return "At least one eligible WorkBuddy session has an ownership conflict, so it may not take work from this project. Inspect the listed blockers for the session-by-session facts, and re-bind this project to a session that is actually running here.";
			case "native_state_unknown":
				return "The state of every eligible WorkBuddy session is unknown, so none of them may take work safely. Verify which session is really running this project; if a round there already has a recorded result, repair its receipt and then release it explicitly once you have observed that the execution ended.";
			case "scope_conflict":
				return "The task's files overlap with work already running in this project. It will run when that work finishes.";
			default:
				return "It will run when a WorkBuddy session is free; check with wb_status.";
		}
	}

	/**
	 * Names the sessions that block a pool wait, each with its own cause.
	 *
	 * The reason says *what kind* of wait this is; this says *which
	 * conversation* to look at. A pool of one busy and one offline session is
	 * two different problems for the user, and "the pool is waiting" names
	 * neither.
	 */
	function describeSessionBlockers(blockers: readonly SessionBlocker[]): string {
		if (blockers.length === 0) {
			return "";
		}
		const named = blockers.map((blocker) => `${blocker.sessionId} (${blocker.reason})`);
		return `Blocked by ${named.length === 1 ? "session" : "sessions"} ${named.join(", ")}.`;
	}

	/**
	 * Resumes rounds this process left queued.
	 *
	 * A round is queued when its session was busy or its scope conflicted, and the
	 * dispatch that enqueued it is gone by then: the tool call returned and the queue
	 * handle closed. Without this, "it will run when the session is free" would be a
	 * promise nothing keeps. Resumption reads the staged manifest back so the send
	 * carries the authorized payload, then claims, arms and sends exactly like
	 * dispatch — one send per attempt, because `armPrompt` is the single gate.
	 *
	 * Called after a terminal commit releases a session, and from `wb_status` so a
	 * caller waiting on a queued task can also nudge it forward.
	 */
	async function advanceQueuedRounds(ctx: ExtensionContext): Promise<void> {
		if (shuttingDown) {
			// The activation is ending. Nothing may open the project again: a
			// background advance after the shutdown would take a handle on a
			// project whose files are about to be released.
			return;
		}
		const resolved = await realResolveProjectContext(ctx.cwd, { classify: inspectProjectMarker }).catch(
			() => null,
		);
		const projectRoot = resolved?.projectRoot ?? null;
		if (projectRoot === null) {
			return;
		}
		// A queued round waits for a free WorkBuddy session. A session the user
		// opened after the round was queued can satisfy it, so the roster is
		// refreshed before the claim decides. The refresh is bounded and shared,
		// so this cannot turn the scheduler into a handshake loop.
		await refreshProjectPool(projectRoot);
		const owner = queueOwnerFor(ctx);
		// The read-only check comes first: opening a write handle would create
		// the project's state file when it is gone, and a background timer must
		// never resurrect a project that no longer exists.
		if (!hasDispatchableRound(projectRoot, owner)) {
			return;
		}
		if (shuttingDown) {
			// The activation ended while this advance was starting. Nothing may
			// open the project now: the shutdown is about to release it.
			return;
		}
		const queue = openProjectQueue(projectRoot, { mode: "write" });
		if (queue === null) {
			return;
		}
		let candidates: Array<Record<string, unknown>>;
		let claim: ReturnType<typeof queue.claim>;
		try {
			queue.registerOwner(owner, Date.now());
			rememberOwner(projectRoot, owner);
			queue.adoptUnsentRounds({ owner, now: Date.now() });
			// Peek before claiming: `claim` mutates, and a round already tracked in this
			// process is being delivered, not waiting.
			candidates = readAllQueuedRounds(queue).filter(
				(row) =>
					row["status"] === "queued" &&
					row["owner_session"] === owner.sessionId &&
					row["owner_generation"] === owner.generation &&
					!tasks.has(String(row["task_id"])),
			);
			if (candidates.length === 0) {
				return;
			}
			claim = queue.claim(owner, Date.now());
		} catch {
			return;
		} finally {
			queue.close();
		}
		if (claim.kind !== "claimed") {
			return;
		}
		const row = candidates.find(
			(candidate) =>
				String(candidate["task_id"]) === claim.taskId && Number(candidate["round"]) === claim.round,
		);
		if (row === undefined) {
			// The claim already took the attempt and the session hold, so returning here
			// without undoing it would wedge that WorkBuddy session for every later round.
			// The row is re-read from the queue rather than from the stale peek: claiming is
			// what makes it visible, and the peek cannot be trusted to have seen it.
			rollbackResumeClaim(projectRoot, claim.taskId, claim.round, claim.attemptId, "claimed row was not in the peek");
			return;
		}
		await resumeClaimedRound(ctx, owner, projectRoot, claim, row);
	}

	/**
	 * Sends one already-claimed round.
	 *
	 * Everything the send needs comes from the staged manifest and the queue row, not
	 * from the dispatch that enqueued it: that call has returned, and holding its
	 * state would make a queue that only advances while its creator waits.
	 */
	async function resumeClaimedRound(
		ctx: ExtensionContext,
		owner: OwnerIdentity,
		projectRoot: string,
		claim: { taskId: string; round: number; attemptId: string; sessionId: string },
		row: Record<string, unknown>,
	): Promise<void> {
		const taskId = claim.taskId;
		const round = claim.round;
		let staged: StagedTask;
		try {
			// The row records where the manifest is, not where the stage directory is:
			// deriving the stage from the manifest's own location keeps one path in the
			// record instead of two that could disagree.
			const manifestPath = String(row["manifest_path"]);
			staged = await realReadStagedManifest(path.dirname(manifestPath));
			// The queue's copy of the digest is what the human's confirmation was fenced
			// on. Re-reading the manifest proves its own internal consistency, which a
			// fully consistent but different payload would also satisfy; comparing against
			// the row is what proves this is the payload that was approved.
			const queuedDigest = row["manifest_sha256"];
			if (typeof queuedDigest !== "string" || queuedDigest !== staged.manifestSha256) {
				throw new WbTaskError(
					WB_ERROR_CODE.taskStateInvalid,
					`Staged manifest at ${manifestPath} does not match the digest enqueued for this round`,
				);
			}
		} catch (error) {
			// Two different failures, two different answers. A transient read error (an
			// unreadable stage, a busy volume) is retryable, so the claim is rolled back and
			// the round waits. A digest that does not match the one the human approved is
			// not retryable: resuming it again would fail identically forever, leaving a
			// permanent `queued` row with the real problem recorded nowhere. That case is
			// terminal and is recorded as a storage failure.
			const reason = messageOf(error);
			if (isUnrecoverableStageError(error)) {
				recordCommitFailureById(projectRoot, taskId, round, reason);
				return;
			}
			rollbackResumeClaim(projectRoot, taskId, round, claim.attemptId, reason);
			return;
		}
		const payload = staged.manifest.payload;
		const paths = resolveRoundPaths(projectRoot, taskId, round, "round");
		const binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			rollbackResumeClaim(projectRoot, taskId, round, claim.attemptId, "The bound session is no longer readable");
			return;
		}
		// The claim selected the concrete session this round runs on, and the
		// approved policy has to permit it. A pool round may run on any enrolled
		// session the claim chose; a pinned round may only run on the one it named.
		let selectedBinding: Binding;
		try {
			if (payload.targetPolicy.kind === "session") {
				if (payload.targetPolicy.sessionId !== claim.sessionId) {
					rollbackResumeClaim(projectRoot, taskId, round, claim.attemptId, "The pinned execution target changed; verify the binding");
					return;
				}
				selectedBinding = bindingForSession(binding, claim.sessionId);
			} else {
				selectedBinding = bindingForSession(binding, claim.sessionId);
			}
		} catch (error) {
			rollbackResumeClaim(projectRoot, taskId, round, claim.attemptId, messageOf(error));
			return;
		}
		const request: TaskRequest = { goal: payload.goal, expectedOutputs: payload.expectedOutputs, inputFiles: [] };
		const confirmation: RoundConfirmationV3 = {
			source: staged.manifest.approval.source,
			at: staged.manifest.approval.at,
			targetPolicy: payload.targetPolicy,
			requestId: payload.requestId,
			manifestSha256: staged.manifestSha256,
			owner,
			previousRound: round - 1,
			inputs: payload.inputs.map((input) => ({ path: input.path, sha256: input.sha256 })),
			deliveryMode: payload.deliveryMode,
		};
		const receipt = toTaskReceiptView(
			buildReceiptForStage({
				projectRoot,
				taskId,
				sessionId: selectedBinding.sessionId,
				round,
				request,
				confirmation,
				staged,
				outputsDir: paths.outputsDir,
			}),
		);
		await launchRound(ctx, selectedBinding, request, confirmation, undefined, receipt,
			{ round, briefPath: paths.briefPath, outputsDir: paths.outputsDir }, staged, claim);
	}

	async function runConfirmedTask(
		ctx: ExtensionContext,
		binding: Binding,
		request: TaskRequest,
		confirmation: RoundConfirmationV3,
		signal: AbortSignal | undefined,
		requestedTaskId: string | undefined,
		correction?: { correctionReviewId: string },
	): Promise<AgentToolResult<unknown>> {
		const projectRoot = binding.projectRoot;
		const taskId = requestedTaskId ?? crypto.randomUUID();
		const round = confirmation.previousRound + 1;

		// Stage: freeze the inputs, re-derive the digest and refuse if the bytes moved
		// since the human confirmed them. Staging is the only producer of the digest
		// that both the queue row and the durable receipt carry.
		let staged: StagedTask;
		try {
			staged = await realStageTask(projectRoot, confirmation, request, taskId, round);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}

		const paths = resolveRoundPaths(projectRoot, taskId, round, "round");

		// Write the brief the prompt is built from. Staging deliberately does not do
		// this (it freezes inputs and the manifest only), and a prompt that fell back
		// to the objective alone would ask WorkBuddy to work from less than the round
		// actually carries.
		const briefContent = renderTaskPrompt(request.goal, {
			taskId,
			round,
			inputsDir: path.join(staged.snapshotRoot, "inputs"),
			outputsDir: paths.outputsDir,
			inputFiles: staged.manifest.payload.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
			expectedOutputs: staged.manifest.payload.expectedOutputs,
		});
		await mkdir(paths.roundDir, { recursive: true });
		await writeFile(paths.briefPath, briefContent, "utf-8");
		const owner = confirmation.owner;
		// The rest of the pipeline reads the v2 view; the v3 record is what gets written,
		// and the adapter is the one place that reconciles the two shapes.
		//
		// The receipt names the session the round actually runs on, which for a pool
		// round is only known once the queue has claimed it. The receipt is therefore
		// built after the claim, from the session the claim selected.
		let receipt: TaskReceipt | null = null;

		// Register the round in the queue, then arbitrate for the session. The row is
		// what every durable transition acts on; a prompt sent for a round the queue
		// does not know about could never be committed.
		const queue = openProjectQueue(projectRoot, { mode: "write" });
		if (queue === null) {
			return failureResult(
				`Project state is not available for ${projectRoot}; run /wb setup before delegating.`,
				WB_ERROR_CODE.migrationRequired,
			);
		}
		let attemptId: string;
		let selectedSession: string;
		try {
			// The queue's own handle is the one this registration writes through: opening a
			// second connection here would be a parallel writer, and closing it would tear
			// down the handle `enqueue`/`claim` are about to use.
			queue.registerOwner(owner, Date.now());
			rememberOwner(projectRoot, owner);
			queue.enqueue({
				taskId,
				round,
				requestId: confirmation.requestId,
				manifestSha256: staged.manifestSha256,
				manifestPath: staged.manifestPath,
				snapshotRoot: staged.snapshotRoot,
				expectedPreviousRound: confirmation.previousRound === 0 ? null : confirmation.previousRound,
				readPaths: confirmation.inputs.map((input) => input.path),
				writePaths: [path.relative(projectRoot, paths.outputsDir).split(path.sep).join("/")],
				targetPolicy: confirmation.targetPolicy,
				ownerSession: owner.sessionId,
				ownerGeneration: owner.generation,
				executorInstanceId: owner.instanceId,
				approval: {
					source: confirmation.source,
					at: confirmation.at,
					payloadSha256: staged.manifestSha256,
				},
				title: request.goal.objective.slice(0, 160),
				deliveryMode: confirmation.deliveryMode,
				// The correction's purpose and review are what `armPrompt` re-checks
				// before the prompt may leave; recording them at enqueue keeps that
				// fence meaningful instead of decorative.
				correctionOfReviewId: correction?.correctionReviewId,
			});
			// A round's lifecycle is otherwise only visible by reading the queue's rows
			// after the fact. Logging the transitions is what lets a stuck round be
			// reconstructed from the log alone, without replaying a database by hand.
			void logEvent(projectRoot, "queue.enqueued", {
				taskId,
				round,
				requestId: confirmation.requestId,
				ownerPid: process.pid,
			})
				.catch(() => undefined);
			const claim = queue.claim(owner, Date.now());
			if (claim.kind !== "claimed") {
				void logEvent(projectRoot, "queue.waiting", {
					taskId,
					round,
					reasonCode: claim.kind === "waiting" ? claim.reason : "queued",
					ownerPid: process.pid,
				}).catch(() => undefined);
				// Busy session or a scope conflict: the round is queued, not failed. The
				// caller learns it is waiting instead of being told a delivery happened.
				queue.close();
				scheduleQueueAdvance(ctx, projectRoot);
				return {
					content: [
						{
							type: "text",
							text:
								claim.kind === "waiting"
									? `Task ${taskId} (round ${round}) is queued: ${claim.reason}. ${poolWaitAdvice(claim.reason)} ${describeSessionBlockers(claim.sessionBlockers)}`
									: `Task ${taskId} (round ${round}) is queued.`,
						},
					],
					details: {
						taskId,
						round,
						status: "queued",
						waitReason: claim.kind === "waiting" ? claim.reason : null,
						blockerIds: claim.kind === "waiting" ? claim.blockerIds : [],
						sessionBlockers: claim.kind === "waiting" ? claim.sessionBlockers : [],
					},
				};
			}
			if (claim.taskId !== taskId || claim.round !== round) {
				const claimedRow = queue.inspect({ taskId: claim.taskId }).tasks.find(
					(row) => Number(row["round"]) === claim.round,
				);
				if (claimedRow === undefined) {
					rollbackResumeClaim(projectRoot, claim.taskId, claim.round, claim.attemptId, "Claimed round is unavailable");
				} else {
					void resumeClaimedRound(ctx, owner, projectRoot, claim, claimedRow).catch((error) => {
						pi.logger.warn(`Queued dispatch failed: ${messageOf(error)}`, { taskId: claim.taskId });
					});
				}
				queue.close();
				scheduleQueueAdvance(ctx, projectRoot);
				return {
					content: [{ type: "text", text: `Task ${taskId} (round ${round}) is queued behind earlier authorized work.` }],
					details: { taskId, round, status: "queued", waitReason: "earlier_work" },
				};
			}
			attemptId = claim.attemptId;
			selectedSession = claim.sessionId;
			void logEvent(projectRoot, "queue.claimed", {
				taskId,
				round,
				attemptId,
				sessionId: selectedSession,
				ownerPid: process.pid,
			}).catch(() => undefined);
		} catch (error) {
			queue.close();
			return failureResult(messageOf(error), codeOf(error));
		}
		// The round now owns a concrete WorkBuddy session. The connection, the
		// receipt and every view are built from that session, not from the
		// project's default one: a queued pool round may have been claimed for a
		// different conversation than the one the binding names.
		let selectedBinding: Binding;
		try {
			selectedBinding = bindingForSession(binding, selectedSession);
		} catch (error) {
			rollbackResumeClaim(projectRoot, taskId, round, attemptId, messageOf(error));
			return failureResult(messageOf(error), codeOf(error));
		}
		receipt = toTaskReceiptView(buildReceiptForStage({
			projectRoot,
			taskId,
			sessionId: selectedBinding.sessionId,
			round,
			request,
			confirmation,
			staged,
			outputsDir: paths.outputsDir,
		}));
		// Attachment and brief validation precede arming; only launchRound can
		// cross the send fence. This handle no longer owns an operation.
		queue.close();
		return await launchRound(
			ctx,
			selectedBinding,
			request,
			confirmation,
			signal,
			receipt,
			{ round, briefPath: paths.briefPath, outputsDir: paths.outputsDir },
			staged,
			{ attemptId, sessionId: selectedSession },
		);
	}

	/**
	 * Arms nothing and assumes nothing: the round is already queued, claimed and armed.
	 *
	 * This is the second half of dispatch, shared with resumption. It builds the in-
	 * memory task from the receipt the queue authorized and runs the turn, so a round
	 * that was queued on a busy session is delivered by exactly the same code as one
	 * that claimed its session immediately — there is no second send path.
	 */
	async function launchRound(
		ctx: ExtensionContext,
		binding: Binding,
		request: TaskRequest,
		confirmation: RoundConfirmationV3,
		signal: AbortSignal | undefined,
		receipt: TaskReceipt,
		prepared: { round: number; briefPath: string; outputsDir: string },
		staged: StagedTask,
		execution: { attemptId: string; sessionId: string },
	): Promise<AgentToolResult<unknown>> {
	const abort = new AbortController();

	const { promise: committed, resolve: markCommitted } = Promise.withResolvers<void>();
	const { promise: turnEnded, resolve: markTurnEnded } = Promise.withResolvers<void>();

	const task: ActiveTask = {
		taskId: receipt.taskId,
		receipt,
		session: null,
		abort,
		ctx,
		settled: Promise.resolve(),
		finalization: null,
		committed,
		markCommitted,
		turnEnded,
		markTurnEnded,
		commitSettled: false,
		storageError: null,
		summary: "",
		progress: "",
		approvalDecisions: new Map(),
		pendingApprovals: new Set(),
		awaitingApproval: false,
		// Dispatch staged this round through the queue, so its terminal commit goes
		// through the queue too: the durable record is a v3 per-round receipt and the
		// release is gated on confirming it. Setting this is what makes the queue the
		// authority for this task's state.
		durable: {
			requestId: confirmation.requestId,
			snapshotRoot: staged.snapshotRoot,
			manifestSha256: staged.manifestSha256,
			attemptId: execution.attemptId,
			sessionId: execution.sessionId,
			// The approval owner is frozen in the manifest: the human approved
			// this round under that identity, and the manifest's digest is the
			// fence on that approval.
			owner: staged.manifest.payload.owner,
			// The executor is the identity that is running the round now. It is
			// the same one in the ordinary case; it differs when a successor
			// adopted an approved round and runs it under its own generation —
			// and the result fact must be published under the identity the
			// queue recorded the round against, which is the executor's.
			executor: confirmation.owner,
		},
		delivery: { waitEnded: null, inBand: true },
	};
	tasks.set(receipt.taskId, task);
	setStatus(ctx);

	// The queue's `works` row *is* the round's scope: `enqueue` creates it and
	// `confirmReceipt` releases it, both keyed on the round. Registering a second
	// record in the collaboration store would be a competing authority under a
	// different key (task id vs derived work id), which is how a round ends up with
	// its receipt committed while scope still looks occupied.
	const currentR = currentRound(receipt);

	let session: DesktopSession;
	try {
		session = await realConnect(
			binding,
			{
				onUpdate: async (update) => {
					handleUpdate(receipt.taskId, update);
				},
				onRequest: async (method, requestParams) => await handleRequest(receipt.taskId, method, requestParams),
			},
			abort.signal,
		);
	} catch (error) {
		if (codeOf(error) === WB_ERROR_CODE.busy) {
			const queue = openProjectQueue(receipt.projectRoot, { mode: "write" });
			if (queue !== null) {
				try {
					const rolledBack = queue.rollbackClaim({
						taskId: task.taskId, round: prepared.round, attemptId: execution.attemptId,
						reason: "native_session_busy", now: Date.now(),
					});
					if (rolledBack.kind === "requeued") {
						tasks.delete(task.taskId);
						setStatus(ctx);
						scheduleQueueAdvance(ctx, receipt.projectRoot);
						return {
							content: [{ type: "text", text: `Task ${task.taskId} (round ${prepared.round}) is queued: the fixed WorkBuddy target is busy. It will resume automatically when that target is free; no prompt has been sent.` }],
							details: {
								taskId: task.taskId, round: prepared.round, status: "queued", commitState: "pending",
								waitReason: "native_session_busy", readyForReview: false,
								blockerIds: [],
								sessionBlockers: [],
							},
						};
					}
				} finally {
					queue.close();
				}
			}
		}
		// No prompt was armed: the failed attachment is proven unsent and the
		// terminal receipt can safely release this claim.
		await finalizeTask(task, "failed", taskError(codeOf(error), messageOf(error)));
		return taskResult(toTaskView(task.receipt, task));
	}

	if (task.finalization !== null || abort.signal.aborted) {
		// Still not armed; cancellation before attachment cannot have sent work.
		await session.close().catch(() => undefined);
		await finalizeTask(
			task,
			"interrupted",
			taskError(WB_ERROR_CODE.interrupted, "Task ended before its session was ready"),
		);
		return taskResult(toTaskView(task.receipt, task));
	}

	task.session = session;
	let promptText: string;
	try {
		promptText = await readFile(prepared.briefPath, "utf-8");
		const queue = openProjectQueue(receipt.projectRoot, { mode: "write" });
		if (queue === null) {
			throw new WbTaskError(WB_ERROR_CODE.storageError, "The project queue is unavailable before sending");
		}
		try {
			const armed = queue.armPrompt({
				taskId: receipt.taskId,
				round: prepared.round,
				attemptId: execution.attemptId,
				sessionId: execution.sessionId,
				promptSha256: staged.manifestSha256,
				authorization: null,
				now: Date.now(),
			});
			if (armed.kind !== "armed") {
				throw new WbTaskError(WB_ERROR_CODE.revisionConflict, `Nothing sent: ${armed.reason}`);
			}
		} finally {
			queue.close();
		}
		// The armed transition is the last durable fact before the prompt can leave, so
		// it is logged after the fence and before the send: a stuck round can then be
		// explained from the log alone.
		void logEvent(receipt.projectRoot, "dispatch.armed", {
			taskId: receipt.taskId,
			round: prepared.round,
			attemptId: execution.attemptId,
			sessionId: execution.sessionId,
			ownerPid: process.pid,
		}).catch(() => undefined);
	} catch (error) {
		await finalizeTask(task, "failed", taskError(codeOf(error), messageOf(error)));
		return taskResult(toTaskView(task.receipt, task));
	}
	// There is no await between the durable send fence and the prompt call.
	task.settled = runTurn(task, promptText);

	// Foreground delivery: `wb_task` waits for the durable commit rather than
	// returning at dispatch, so the caller receives verified artifacts instead of
	// a promise. A timeout stops *this wait* only — the delivery mode stays
	// foreground, and the host-facing abort signal is deliberately not forwarded
	// to the worker, so a user steering the conversation never cancels the work.
	const waitEnded = await waitForForeground(task, signal);
	task.delivery.waitEnded = waitEnded;
	task.delivery.inBand = waitEnded === "settled";
	const interrupted = waitEnded !== "settled";
	if (interrupted) {
		// This call is returning before the result exists, so the conversation is owed
		// one. The decision belongs here, where the outcome of this wait is known
		// without racing the commit: the report is sent once the commit lands, and the
		// wait itself still returns immediately.
		//
		// The delivery waits for the *commit*, not for the whole turn. A commit is
		// what makes a result deliverable, and it is the fact the shutdown drives:
		// the shutdown finalizes the task, which commits it, which resolves this.
		// Waiting for the turn instead would make the delivery wait on a worker
		// that may never report its turn as ended.
		//
		// It is tracked as background work, because it reads and writes the
		// project's state and the activation must not release the project while it
		// is still running.
		trackBackgroundWork(
			task.committed
				.then(async () => {
					if (task.storageError !== null) {
						// Nothing was provably committed: the storage error is the report, and
						// the recovery path owns what happens next.
						return;
					}
					if (shuttingDown) {
						// The activation is ending and the shutdown has delivered the
						// pending results itself. Nothing may open the project again
						// after that: the project is about to be released.
						return;
					}
					// The outbox row was published under the executor's identity, so
					// the delivery claims it under the same one.
					await deliverPendingResults(ctx, receipt.projectRoot, task.durable.executor);
				})
				.catch((error: unknown) => {
					pi.logger.warn(`WorkBuddy result follow-up failed: ${messageOf(error)}`, { taskId: task.taskId });
				}),
		);
	}
	const view = toTaskView(task.receipt, task);
	const artifactLines = view.artifacts
		.map((artifact) => `- ${artifact.path}${artifact.role === "final" ? "" : " (supporting)"}`)
		.join("\n");
	return {
		content: [
			{
				type: "text",
				text: interrupted
					? [
							`Delegated to WorkBuddy as task ${view.taskId} (round ${prepared.round}); this call stopped waiting while the work continues.`,
							`The committed result will arrive in this conversation as a follow-up message, so there is nothing to poll.`,
							`Use wb_status({ taskId: "${view.taskId}" }) only if you need the state now — the round is still ${view.status}.`,
							`WorkBuddy writes deliverables to ${prepared.outputsDir}.`,
						].join("\n")
					: [
							`Task ${view.taskId} (round ${prepared.round}) is ${view.status} with commit ${view.commitState}.`,
							view.artifacts.length > 0
								? `Artifacts to verify before accepting:\n${artifactLines}`
								: "No artifacts were collected; check the task's error before accepting anything.",
							view.error === null ? "" : `Error: ${view.error.code}: ${view.error.message}`,
						]
							.filter((line) => line.length > 0)
							.join("\n"),
			},
		],
		details: {
			taskId: view.taskId,
			round: prepared.round,
			status: view.status,
			commitState: view.commitState,
			artifactPaths: view.artifacts.map((artifact) => artifact.path),
			readyForReview: view.readyForReview,
			waitingInterrupted: interrupted,
			error: view.error,
			briefPath: prepared.briefPath,
			outputsDir: prepared.outputsDir,
		},
	};
	}

	async function runTurn(task: ActiveTask, prompt: string): Promise<void> {
		let outcome: { stopReason: string; errorMessage?: string };
		try {
			const session = task.session;
			if (session === null) {
				throw new WbTaskError(WB_ERROR_CODE.sessionNotRunning, "Task has no attached session");
			}
			outcome = await session.prompt(prompt);
		} catch (error) {
			await finalizeTask(
				task,
				"interrupted",
				taskError(WB_ERROR_CODE.interrupted, messageOf(error)),
				{ collectArtifacts: true },
			);
			return;
		}
		try {
			const queue = openProjectQueue(task.receipt.projectRoot, { mode: "write" });
			if (queue === null) {
				throw new WbTaskError(WB_ERROR_CODE.storageError, "Cannot record the worker's execution end");
			}
			try {
				const ended = queue.recordExecutionEnd({
					taskId: task.taskId,
					round: currentRound(task.receipt).number,
					attemptId: task.durable.attemptId,
					sessionId: task.durable.sessionId,
					now: Date.now(),
				});
				if (ended.kind !== "recorded") {
					throw new WbTaskError(WB_ERROR_CODE.storageError, "The execution end identity was refused");
				}
			} finally {
				queue.close();
			}
		} catch (error) {
			task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(error));
			reportStorageFailure(pi, task, "execution end");
		}
		task.markTurnEnded();

		if (task.finalization !== null) {
			await task.finalization;
			return;
		}
		if (outcome.errorMessage !== undefined && outcome.errorMessage !== "") {
			await finalizeTask(task, "failed", taskError(WB_ERROR_CODE.taskFailed, outcome.errorMessage));
			return;
		}
		if (outcome.stopReason === "cancelled") {
			await finalizeTask(task, "cancelled", null, { collectArtifacts: true });
			return;
		}
		if (outcome.stopReason !== "end_turn") {
			await finalizeTask(
				task,
				"failed",
				taskError(WB_ERROR_CODE.taskFailed, `WorkBuddy stopped with ${outcome.stopReason}`),
			);
			return;
		}


		const collected = await realCollectArtifacts(task.receipt).catch(() => null);
		if (collected === null) {
			await finalizeTask(
				task,
				"failed",
				taskError(WB_ERROR_CODE.taskFailed, "Deliverables could not be collected from the task outputs directory"),
			);
			return;
		}
		if (task.finalization !== null) {
			await task.finalization;
			return;
		}
		const current = currentRound(task.receipt);
		current.artifacts = collected.artifacts;
		const missingOutputs = Array.isArray(collected.missingOutputs) ? collected.missingOutputs : [];
		if (missingOutputs.length > 0) {
			await finalizeTask(
				task,
				"failed",
				taskError(
					WB_ERROR_CODE.outputMissing,
					`WorkBuddy finished but these expected outputs are missing: ${missingOutputs.join(", ")}`,
				),
			);
			return;
		}
		await finalizeTask(task, "completed", null);
	}

	async function runSetup(ctx: ExtensionCommandContext): Promise<void> {
		let projectRoot: string;
		try {
			projectRoot = await realpath(ctx.cwd);
		} catch (err) {
			ctx.ui.notify(`Cannot resolve project root: ${messageOf(err)}`, "error");
			return;
		}

		const repoRoot = path.dirname(__dirname);
		const mcpEntrypoint = path.resolve(repoRoot, "src", "mcp.ts");
		const bunExe = realWhichBun("bun");
		if (bunExe === null) {
			ctx.ui.notify("Bun executable not found on PATH. Install Bun 1.4+ before configuring MCP.", "error");
			return;
		}

		const homeDir =
			overrides.workbuddyHomeDir ?? (process.env.USERPROFILE || process.env.HOME || os.homedir());
		const targets = setupTargets({ workbuddyHomeDir: homeDir, bunExecutable: bunExe, mcpEntrypoint });

		// One preview of the whole change, computed without writing anything. A target
		// that cannot be applied says so here, before the user is asked to confirm.
		let plan;
		try {
			plan = await planIntegration(targets);
		} catch (error) {
			ctx.ui.notify(`Cannot inspect MCP configuration: ${messageOf(error)}`, "error");
			return;
		}
		const previewLines = [
			`Project: ${projectRoot}`,
			`MCP Entrypoint: ${mcpEntrypoint}`,
			`Bun: ${bunExe}`,
			...plan.targets.map(
				(target) =>
					`${target.missing ? "Create" : "Update"} ${target.filePath} → entry "${target.entryName}"${
						target.blockedReason === null ? "" : ` (BLOCKED: ${target.blockedReason})`
					}`,
			),
			plan.applicable
				? "All targets can be applied."
				: "Some targets cannot be applied; fix them first. No file will be changed.",
		];

		if (!ctx.hasUI) {
			ctx.ui.notify(previewLines.join("\n"), "info");
			return;
		}

		const choice = await ctx.ui.select(
			`Apply MCP configuration for project?\n${previewLines.join("\n")}`,
			["Apply MCP configuration", "Cancel"],
		);

		if (choice !== "Apply MCP configuration") {
			ctx.ui.notify("Setup cancelled by user.", "info");
			return;
		}

		// Configuration and project enablement are separate concerns: a config file
		// that cannot be written (a foreign entry already owns the name, a read-only
		// profile) must not stop the project from being enabled. Failures are
		// collected and reported honestly at the end.
		const configFailures: string[] = [];
		if (!plan.applicable) {
			// Refuse the whole change and say why, per target. Applying the writable
			// half would leave the project configured against files the user has to fix
			// anyway, and the blocked file must stay byte-identical.
			for (const target of plan.targets) {
				if (target.blockedReason !== null) {
					configFailures.push(`${target.filePath}: ${target.blockedReason}`);
					ctx.ui.notify(
						`Refusing to change ${target.filePath}: ${target.blockedReason}`,
						"error",
					);
				}
			}
		} else {
			const applyReport = await applyIntegration(plan);
			for (const failure of applyReport.failed) {
				configFailures.push(`${failure.filePath}: ${failure.reason}`);
			}
			for (const diverged of applyReport.diverged) {
				configFailures.push(`${diverged}: rolled back only partially; it changed during setup`);
			}
		}
		// No skill is copied into the project any more. The collaboration skill described
		// the file-store write protocol this release removed; leaving it installable would
		// document a workflow that no longer exists and cannot work.
		// Enable entry point: binding check, migration, access verification
		let binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			let candidates: DesktopCandidate[] = [];
			try {
				candidates = await realDiscover(projectRoot, new AbortController().signal);
			} catch {
				// Discovery failure / no desktop: no candidate session
			}
			// A project is enrolled only by an explicit human decision: it may have
			// several WorkBuddy sessions, and enrolling them silently would let work
			// land in a conversation the user never agreed to. Declining keeps the
			// project unbound, which is a legitimate state — it still gets enabled
			// below.
			if (candidates.length > 0) {
				const confirmed = await ctx.ui.confirm(
					"Enroll this project's WorkBuddy sessions?",
					[
						`Project: ${projectRoot}`,
						`Verified sessions serving this project: ${candidates.length}`,
						"Every one of them may take its own delegated task.",
						"Sessions opened later for this project join the same roster without another prompt.",
					].join("\n"),
				);
				if (confirmed) {
					try {
						const catalog = await readProjectSessionCatalog(
							projectRoot,
							overrides.workbuddyHomeDir ?? workBuddyHomeDir(),
							candidates[0]!.binding.sessionId,
						);
						binding = await reconcileProjectBinding(
							{
								version: 1,
								projectRoot,
								sessionId: candidates[0]!.binding.sessionId,
								workbuddyVersion: candidates[0]!.binding.workbuddyVersion,
							},
							candidates,
							catalog.sessions,
						);
					} catch (error) {
						ctx.ui.notify(
							`Could not enroll this project's WorkBuddy sessions: ${messageOf(error)}`,
							"error",
						);
						binding = null;
					}
					if (binding !== null) {
						await realWriteBinding(binding);
					}
				}
			}
		}

		try {
			await realMigrateProject(projectRoot);
		} catch (error) {
			if (error instanceof WbTaskError && error.code === WB_ERROR_CODE.migrationRequired) {
				ctx.ui.notify(error.message, "error");
				return;
			}
			if (error instanceof WbTaskError) {
				ctx.ui.notify(`${error.code}: ${error.message}`, "error");
				return;
			}
			ctx.ui.notify(`Migration failed: ${messageOf(error)}`, "error");
			return;
		}

		// Migration enables a project only when it imported a binding. An empty
		// pool is legal (a user may not have opened a WorkBuddy session yet), so
		// the enable bit is set here instead of being inferred from a binding.
		let access = await realReadProjectAccess(projectRoot).catch(() => null);
		if (access !== null && access.migrated && !access.enabled) {
			try {
				await realEnableProject(projectRoot);
				access = await realReadProjectAccess(projectRoot).catch(() => null);
			} catch (error) {
				ctx.ui.notify(`Could not enable project state: ${messageOf(error)}`, "error");
				return;
			}
		}
		if (access === null || !access.enabled || !access.migrated) {
			const missing: string[] = [];
			if (access === null) {
				missing.push("database inaccessible");
			} else {
				if (!access.migrated) missing.push("migration incomplete");
				if (!access.enabled) missing.push("project not enabled");
			}
			// `/wb bind` only writes binding.json; it never sets the enable bit, so
			// pointing at it here would send the user in a circle.
			const nextStep = !access || !access.migrated
				? "run /wb setup again or check permissions on .wb-bridge"
				: "run /wb init to enable the project, then /wb bind to choose a session";
			ctx.ui.notify(
				`Project state was not enabled for ${projectRoot}: ${missing.join(", ")}. Next step: ${nextStep}.`,
				"error",
			);
			return;
		}

		if (configFailures.length > 0) {
			// Configuration failures stay errors: a config file was left untouched
			// because it holds a foreign entry, which is something the user must
			// resolve. They no longer abort the run, so enabling still happened.
			for (const failure of configFailures) {
				ctx.ui.notify(failure, "error");
			}
			ctx.ui.notify(
				`Project enabled at ${projectRoot}, but MCP configuration is incomplete. ` +
					"Delegation works once a session is bound; fix the entries above to use the MCP tools.",
				"warning",
			);
			return;
		}
		ctx.ui.notify("Successfully configured MCP for OMP and WorkBuddy.", "info");
	}

	/** Applies one WorkBuddy session update to a task's in-memory state. */
	function handleUpdate(taskId: string, update: DesktopSessionUpdate): void {
		const task = tasks.get(taskId);
		if (task === undefined) {
			return;
		}
		// A message that arrives after the terminal state was chosen must not alter
		// the snapshot that was already committed.
		if (task.finalization !== null) {
			return;
		}
		const kind = update.update.sessionUpdate;
		if (kind === "agent_message_chunk") {
			const content = update.update.content;
			if (content !== null && typeof content === "object" && "type" in content && "text" in content) {
				if (content.type === "text" && typeof content.text === "string") {
					task.summary += content.text;
				}
			}
			return;
		}
		// Reasoning is deliberately neither retained nor surfaced.
		if (kind === "agent_thought_chunk") {
			return;
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			const title = update.update.title;
			if (typeof title === "string" && title !== "") {
				task.progress = title;
				// The widget is the only place this progress is visible, and `setStatus` is its
				// only publisher: without this the row keeps showing the first note until an
				// unrelated transition happens to refresh it. (Not covered by the suite: the
				// stub session exposes no update channel, so `handleUpdate` cannot be driven
				// from a test without inventing one.)
			}
		}
	}

	/**
	 * Answers one agent-initiated request.
	 *
	 * Only a real human decision authorizes WorkBuddy's request; every other path
	 * denies. Nothing is auto-approved, and no allow-all answer exists.
	 */
	async function handleRequest(taskId: string, method: string, params: unknown): Promise<unknown> {
		if (method !== INTERRUPTION_METHOD && method !== "session/request_permission") {
			return undefined;
		}
		// The request must be parsed before anything else, because only the parsed
		// request identifies the correlation field needed to answer it at all. The
		// method name selects the wire shape, whose replies differ.
		const interruption =
			method === "session/request_permission"
				? parseStandardPermission(params)
				: parseWorkBuddyInterruption(params);
		if (interruption === null) {
			// No correlation field, so there is no truthful answer to give. The
			// worker's own timeout is the only remaining outcome.
			return undefined;
		}

		// From here every path answers explicitly, and the answer is a refusal
		// unless a human approved this one request. Returning nothing would leave
		// the worker's interruption service waiting on a decision nobody will send.
		const task = tasks.get(taskId);
		if (task === undefined || receiptIsTerminal(task.receipt)) {
			return interruption.reply(false);
		}
		const canApprove =
			interruption.allowOptionId !== undefined || interruption.options.includes(DECISION_ALLOW);
		if (!canApprove) {
			// The agent offered no one-time grant, so the only honest answer is a
			// refusal; a standing grant is never selected.
			return interruption.reply(false);
		}

		// One decision per request id, so a re-emitted request is not asked twice.
		const decided = task.approvalDecisions.get(interruption.requestId);
		if (decided !== undefined) {
			return interruption.reply(decided === "approved");
		}
		// A terminal commit already began, so no approval can authorize anything
		// any more. The refusal is recorded so a repeat is not re-evaluated.
		if (task.finalization !== null) {
			task.approvalDecisions.set(interruption.requestId, "denied");
			return interruption.reply(false);
		}
		// A request that cannot be shown to a human, or arrives after the task was
		// stopped, is refused rather than left hanging.
		if (!task.ctx.hasUI || task.abort.signal.aborted) {
			task.approvalDecisions.set(interruption.requestId, "denied");
			return interruption.reply(false);
		}

		const ctx = task.ctx;
		task.pendingApprovals.add(interruption.requestId);
		task.awaitingApproval = true;
		setStatus(ctx);
		let approved = false;
		try {
			approved = await presentApproval(ctx, taskId, interruption, task.abort.signal);
		} finally {
			task.pendingApprovals.delete(interruption.requestId);
			// Only the last dialog to close clears the waiting state, so a second
			// outstanding request keeps the task reported as awaiting approval.
			// A dialog that closes after the task ended must never re-set the flag:
			// a decided task is not waiting for anything, and a retained task must
			// not render as awaiting approval.
			task.awaitingApproval =
				task.pendingApprovals.size > 0 &&
				task.finalization === null &&
				!receiptIsTerminal(task.receipt);
			setStatus(ctx);
		}
		// The dialog can end because the task was stopped rather than answered, so
		// the decision is re-checked before it is acted on: a late "Approve once"
		// must never authorize a step whose task is already over.
		if (task.finalization !== null || task.abort.signal.aborted) {
			approved = false;
		}
		task.approvalDecisions.set(interruption.requestId, approved ? "approved" : "denied");
		return interruption.reply(approved);
	}

	async function runStatusTool(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		params: WbStatusParams,
	): Promise<AgentToolResult<unknown>> {
		const located = await locateProject(ctx);
		if (located.projectRoot === null) {
			return failureResult(
				located.reason ?? `No authorized project covers ${located.actualCwd}.`,
				WB_ERROR_CODE.bindingInvalid,
			);
		}
		const projectRoot = located.projectRoot;
		const waitMs = Math.min(Math.max(params.waitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
		// A status query is the one moment a caller is provably waiting on this project,
		// which makes it the natural place to try advancing a queued round: the session
		// that blocked it may have been freed by another process.
		void advanceQueuedRounds(ctx).catch(() => undefined);
		const tracked = tasks.get(params.taskId);
		const task = tracked?.receipt.projectRoot === projectRoot ? tracked : undefined;
		if (task !== undefined) {
			// Waiting is only useful while the task is genuinely undecided. A
			// terminal state, or a commit that already failed, is reported at once
			// even if the turn's own promise is still pending: hiding a storage
			// failure behind a hung prompt would defeat the point of recording it.
			const undecided =
				!receiptIsTerminal(task.receipt) && task.storageError === null && task.finalization === null;
			if (waitMs > 0 && undecided) {
				// Wait for whichever happens first: the turn ending, or a terminal
				// commit beginning (a cancellation or shutdown while the turn runs).
				// Both promises are non-rejecting, so a failed commit cannot turn a
				// status query into an error.
				// Only a durable commit ends this wait; a turn that ended without a
				// committed receipt is not yet something the caller may act on.
				await waitForSettle(task.committed, waitMs, signal);
			}
			if (tasks.get(params.taskId) !== task && !receiptIsTerminal(task.receipt)) {
				const queued = queuedTaskView(projectRoot, params.taskId, queueOwnerFor(ctx));
				if (queued !== null) {
					return taskResult(queued);
				}
			}
			return taskResult(toTaskView(task.receipt, task));
		}

		// Not owned here: a finished task from an earlier OMP session is readable,
		// but a task that was still running belongs to a process that is gone.
		// The root comes from the resolver, so a subdirectory session reads the
		// same task directory the write path created. Without a resolved root there
		// is no task directory to read, and guessing one would answer about a
		// different project than the write path uses.
		const queued = queuedTaskView(projectRoot, params.taskId, queueOwnerFor(ctx));
		if (queued !== null) {
			return taskResult(queued);
		}
		let receipt: TaskReceipt;
		try {
			receipt = await realReadTask(projectRoot, params.taskId);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}
		return taskResult(toTaskView(receipt, undefined, queueCommitState(projectRoot, params.taskId)));
	}

	/**
	 * `/wb repair [taskId]`.
	 *
	 * Rebuilds a failed round's receipt from the outcome the queue already recorded
	 * and the manifest the human already approved. It never prompts WorkBuddy and
	 * never fabricates a status: a round whose result is unknown stays quarantined
	 * until a human verifies the worker through `/wb release`.
	 *
	 * The original owner repairs their own round without any dialog. A *different*
	 * operator may repair a round whose original owner is provably gone, but only
	 * after an explicit per-operation confirmation that names the exact subject.
	 * The consent is one-shot and is checked again inside the commit transaction.
	 */
	async function runRepairCommand(ctx: ExtensionContext, taskArg: string | undefined): Promise<void> {
		const recoverySignal = recoveryAbort.signal;
		if (recoverySignal.aborted) return;
		const located = await locateProject(ctx);
		if (recoverySignal.aborted) return;
		if (located.projectRoot === null) {
			ctx.ui.notify(located.reason ?? "No verified project root.", "error");
			return;
		}
		const projectRoot = located.projectRoot;
		const owner = queueOwnerFor(ctx);
		let taskId = taskArg;
		let round: number | undefined;
		if (taskId === undefined || taskId === "") {
			// Without an id, list what is actually repairable and ask. Guessing "the only
			// one" is how a recovery rewrites the wrong round.
			const queue = openProjectQueue(projectRoot, { mode: "read" });
			if (queue === null) {
				ctx.ui.notify("No project queue is available.", "error");
				return;
			}
			let labels: string[] = [];
			try {
				labels = queue.inspect({}).tasks
					.filter(
						(row) =>
							row["outcome_json"] !== null && row["commit_state"] !== "committed" &&
							row["owner_session"] === owner.sessionId,
					)
					.map((row) => `${String(row["task_id"])} — round ${String(row["round"])} — ${String(row["status"])}`);
			} finally {
				queue.close();
			}
			if (labels.length === 0) {
				ctx.ui.notify("No round of this OMP session has a known result and an uncommitted receipt.", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Pass a task id to repair:\n${labels.join("\n")}`, "warning");
				return;
			}
			const picked = await ctx.ui.select("Repair which round's receipt?", labels, { signal: recoverySignal });
			if (recoverySignal.aborted) return;
			const index = picked === undefined ? -1 : labels.indexOf(picked);
			if (index < 0) {
				ctx.ui.notify("Repair dismissed; nothing was written.", "info");
				return;
			}
			taskId = labels[index]!.slice(0, 36);
		}
		// Registration is what makes the repair's owner fence a live fact; the facade is
		// closed before the repair does its file IO. The operator registers *before*
		// any dialog: registering again after an await would resurrect an identity
		// that a session switch or a shutdown already retired.
		const registering = openProjectQueue(projectRoot, { mode: "write" });
		if (registering !== null) {
			try {
				registering.registerOwner(owner, Date.now());
			} finally {
				registering.close();
			}
		}
		rememberOwner(projectRoot, owner);
		// The original owner's own round needs no dialog: the round's owner row is
		// already the authority for it.
		const repaired = await repairRoundReceipt(projectRoot, owner, { taskId, round, signal: recoverySignal });
		if (recoverySignal.aborted) return;
		if (repaired.kind === "repaired") {
			await logEvent(projectRoot, "receipt.repaired", {
				taskId: repaired.taskId, round: repaired.round, ownerPid: process.pid,
			}).catch(() => undefined);
			ctx.ui.notify(
				repaired.released
					? `Repaired the receipt for task ${repaired.taskId} (round ${repaired.round}); its hold and scope were released. The result is unchanged.`
					: `Repaired the receipt for task ${repaired.taskId} (round ${repaired.round}). The execution stays quarantined because it may still be running; verify it stopped, then run /wb release ${repaired.taskId}.`,
				"info",
			);
			return;
		}
		// The ordinary path refused. A different operator may still recover this
		// round, but only when its original owner is provably gone and a human
		// confirms the exact subject.
		await runOperatorRecovery(ctx, projectRoot, owner, taskId, round, repaired.reason, recoverySignal);
	}

	/**
	 * The operator-recovery path of `/wb repair`.
	 *
	 * It runs only when the ordinary owner path refused. The sequence is
	 * deliberate: the subject is frozen *before* the human is asked, the human
	 * answers about that exact subject, and the consent is checked again inside
	 * the commit transaction. A round that changed in between invalidates the
	 * consent instead of being silently recovered.
	 */
	async function runOperatorRecovery(
		ctx: ExtensionContext,
		projectRoot: string,
		operator: OwnerIdentity,
		taskId: string,
		round: number | undefined,
		ordinaryReason: string,
		recoverySignal: AbortSignal,
	): Promise<void> {
		if (recoverySignal.aborted) return;
		// The target is read in its own scope and closed before anything is asked.
		// A cached facade must never be held across a dialog.
		const target = readOperatorRecoveryTarget(projectRoot, operator, { taskId, round });
		if (target.kind === "refused") {
			ctx.ui.notify(`Nothing repaired: ${target.reason}`, "warning");
			return;
		}
		if (!ctx.hasUI) {
			// A headless session cannot consent, so it refuses instead of
			// manufacturing a source.
			ctx.ui.notify(
				`Nothing repaired: recovering another session's round needs an interactive human confirmation (${ordinaryReason}).`,
				"warning",
			);
			return;
		}
		const subject = target.subject;
		const confirmed = await ctx.ui.confirm(
			`Recover the receipt of task ${subject.taskId} round ${subject.round}?`,
			[
				`Project: ${projectRoot}`,
				`Task: ${subject.taskId}`,
				`Round: ${subject.round}`,
				`Request: ${subject.requestId}`,
				`Attempt: ${subject.attemptId ?? "(never sent)"}`,
				`WorkBuddy session: ${subject.sessionId ?? "(none)"}`,
				`Original owner: ${subject.ownerSession} / ${subject.ownerGeneration}`,
				`Original owner process: ${target.deathProof.processId} (gone: ${target.deathProof.pidGone ? "yes" : "no"})`,
				`Recorded result: ${target.outcome.status}`,
				`Manifest digest: ${subject.manifestSha256}`,
				"",
				"This round belongs to another OMP session whose process is gone.",
				"The receipt is rebuilt from the recorded result; nothing is resent and no WorkBuddy session is contacted.",
			].join("\n"),
			{ signal: recoverySignal },
		);
		if (confirmed !== true) {
			ctx.ui.notify("Repair declined; nothing was written.", "info");
			return;
		}
		// A dialog that answered after a session switch or a shutdown is not a
		// consent: the activation-local signal is aborted by both, and the
		// operator's registration may already have been retired.
		if (recoverySignal.aborted) {
			ctx.ui.notify("Nothing repaired: this session changed while the confirmation was open.", "warning");
			return;
		}
		const consent: RecoveryConsent = {
			confirmed: true,
			at: new Date().toISOString(),
			subject,
		};
		const recovered = await repairRoundReceiptAsOperator(projectRoot, operator, target, consent, { signal: recoverySignal });
		if (recovered.kind === "refused") {
			ctx.ui.notify(`Nothing repaired: ${recovered.reason}`, "warning");
			return;
		}
		ctx.ui.notify(
			recovered.released
				? `Recovered the receipt for task ${recovered.taskId} (round ${recovered.round}); its hold and scope were released. The result and the original owner are unchanged.`
				: `Recovered the receipt for task ${recovered.taskId} (round ${recovered.round}). The execution stays quarantined because it may still be running; verify it stopped, then run /wb release ${recovered.taskId}.`,
			"info",
		);
	}

	/**
	 * `/wb background <taskId>`.
	 *
	 * Background delivery is a per-round choice with recorded human consent, not an
	 * inference from a slow worker. A headless session cannot consent, so it refuses
	 * instead of manufacturing a source.
	 */
	async function runBackgroundCommand(ctx: ExtensionContext, taskId: string | undefined): Promise<void> {
		if (taskId === undefined || taskId === "") {
			ctx.ui.notify("Usage: /wb background <task>", "warning");
			return;
		}
		const located = await locateProject(ctx);
		if (located.projectRoot === null) {
			ctx.ui.notify(located.reason ?? "No verified project root.", "error");
			return;
		}
		const projectRoot = located.projectRoot;
		const tracked = tasks.get(taskId);
		if (tracked !== undefined && tracked.delivery.waitEnded === null) {
			// The round is in this foreground wait right now; switching the persisted mode
			// would make the running call disagree with what the record will say.
			ctx.ui.notify("This task is in its foreground wait; run /wb background again after it returns or is steered.", "warning");
			return;
		}
		const round = tracked === undefined ? null : currentRound(tracked.receipt).number;
		// The round is read in its own scope: a cached connection is not a lease
		// and must not be held across the confirmation dialog below.
		let target: number;
		{
			const queue = openProjectQueue(projectRoot, { mode: "write" });
			if (queue === null) {
				ctx.ui.notify("No project queue is available.", "error");
				return;
			}
			try {
				const owner = queueOwnerFor(ctx);
				queue.registerOwner(owner, Date.now());
				rememberOwner(projectRoot, owner);
				const rows = queue.inspect({ taskId }).tasks;
				const row = round === null ? rows[rows.length - 1] : rows.find((entry) => Number(entry["round"]) === round);
				if (row === undefined) {
					ctx.ui.notify(`Task ${taskId} has no round in this project.`, "warning");
					return;
				}
				target = Number(row["round"]);
			} finally {
				queue.close();
			}
		}
		try {
			if (!ctx.hasUI) {
				ctx.ui.notify("Background delivery needs an interactive human confirmation of this task.", "error");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Report this task's result in the background?",
				`Task: ${taskId}
Round: ${target}
The tool call will return before the result arrives; the result is delivered as a follow-up message in this OMP session.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Background delivery not enabled.", "info");
				return;
			}
			const outcome = setDeliveryMode(openWriteConnection(projectRoot), {
				owner: queueOwnerFor(ctx),
				taskId,
				round: target,
				mode: "background",
				consent: { source: "host_dialog", at: new Date().toISOString() },
			});
			ctx.ui.notify(
				outcome.kind === "refused"
					? `Background delivery refused: ${outcome.reason}.`
					: `Task ${taskId} (round ${target}) will report its result in the background.`,
				outcome.kind === "refused" ? "warning" : "info",
			);
		} catch (error) {
			ctx.ui.notify(`Could not change delivery: ${messageOf(error)}`, "error");
		}
	}

	/**
	 * `wb_review`'s implementation: record the verdict, then optionally start the one
	 * correction it may authorize.
	 *
	 * The correction is a normal next round of the *same* task: it reuses the original
	 * goal and materials, is claimed and armed through the same fence, and cannot
	 * replay an external action the original human approved once.
	 */
	async function runReview(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		params: WbReviewParams,
	): Promise<AgentToolResult<unknown>> {
		const located = await locateProject(ctx);
		if (located.projectRoot === null) {
			return failureResult(
				located.reason ?? `No authorized project covers ${located.actualCwd}.`,
				WB_ERROR_CODE.bindingInvalid,
			);
		}
		const projectRoot = located.projectRoot;
		const owner = queueOwnerFor(ctx);
		const registering = openProjectQueue(projectRoot, { mode: "write" });
		if (registering === null) {
			return failureResult("Project state is not available; run /wb setup before reviewing.", WB_ERROR_CODE.migrationRequired);
		}
		try {
			registering.registerOwner(owner, Date.now());
		} finally {
			registering.close();
		}
		rememberOwner(projectRoot, owner);
		const round =
			params.round ??
			(await (async (): Promise<number | null> => {
				const reader = openProjectQueue(projectRoot, { mode: "read" });
				if (reader === null) {
					return null;
				}
				try {
					const rows = reader.inspect({ taskId: params.taskId }).tasks;
					return rows.length === 0 ? null : Number(rows[rows.length - 1]!["round"]);
				} finally {
					reader.close();
				}
			})());
		if (round === null) {
			return failureResult(`Task ${params.taskId} has no round in this project.`, WB_ERROR_CODE.taskNotFound);
		}
		const submitted = await submitTaskReview(projectRoot, owner, {
			taskId: params.taskId,
			round,
			findings: params.findings,
			verdict: params.verdict,
			artifacts: params.artifacts,
		});
		if (submitted.kind === "refused") {
			return failureResult(`Review refused: ${submitted.reason}`, WB_ERROR_CODE.taskStateInvalid);
		}
		const review = submitted.review;

		// The review is what closes the loop on a delivered result: it is the only
		// evidence that this conversation actually consumed the notification. An
		// in-band result has no async send to acknowledge, so this path is how the
		// inbox stops reporting it as unconsumed.
		const ackDb = openWriteConnection(projectRoot);
		try {
			const acked = acknowledgeReviewedResult(ackDb, {
				owner,
				taskId: review.taskId,
				round: review.round,
				evidence: { at: Date.now(), reference: `wb_review ${review.reviewId}` },
			});
			if (acked.kind === "refused") {
				pi.logger.warn(`The result for ${review.taskId} round ${review.round} was not acknowledged: ${acked.reason}`);
			}
		} catch (error) {
			pi.logger.warn(`The result acknowledgement failed: ${messageOf(error)}`);
		} finally {
			closeQueueConnection(projectRoot, "write");
		}

		if (params.verdict !== "changes_requested") {
			return {
				content: [
					{
						type: "text",
						text: [
							`Recorded ${review.verdict} for task ${review.taskId} round ${review.round} (review ${review.reviewId}).`,
							"Acceptance covers exactly the bytes you named; a later rewrite invalidates it.",
						].join("\n"),
					},
				],
				details: { taskId: review.taskId, round: review.round, reviewId: review.reviewId, verdict: review.verdict },
			};
		}

		const reserved = await reserveTaskCorrection(projectRoot, owner, {
			taskId: params.taskId,
			reviewId: review.reviewId,
		});
		if (reserved.kind === "needs_human") {
			return {
				content: [
					{
						type: "text",
						text: [
							`Recorded ${review.verdict} for task ${review.taskId} round ${review.round} (review ${review.reviewId}).`,
							`No correction was started: ${reserved.reason}.`,
							"Resolve it in OMP: the correction needs a new human decision, not another automatic round.",
						].join("\n"),
					},
				],
				details: { taskId: review.taskId, round: review.round, reviewId: review.reviewId, verdict: review.verdict, correction: null },
			};
		}
		const plan = reserved.plan;
		const usable = await validateTaskCorrection(projectRoot, owner, plan);
		if (!usable.ok) {
			return {
				content: [
					{
						type: "text",
						text: `Recorded ${review.verdict}, but the correction cannot start: ${usable.reason}. The materials or authorization changed; review the current round again.`,
					},
				],
				details: { taskId: review.taskId, round: review.round, reviewId: review.reviewId, verdict: review.verdict, correction: plan },
				isError: true,
			};
		}

		// Recover the deterministic round if it already exists: a retry must not stage a
		// second one for the same review.
		const existing = tasks.get(plan.taskId);
		if (existing !== undefined && existing.delivery.waitEnded === null) {
			return {
				content: [
					{
						type: "text",
						text: `This task's correction is already in flight as round ${plan.targetRound}; no second round was staged.`,
					},
				],
				details: { taskId: plan.taskId, round: plan.targetRound, reviewId: review.reviewId, correction: plan },
			};
		}
		const binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			return failureResult(`No WorkBuddy binding for ${projectRoot}. Run /wb bind first.`, WB_ERROR_CODE.bindingInvalid);
		}
		// A correction continues the *same* logical task, so it continues on the
		// session that task already owns. The session comes from the queue's durable
		// record, not from the project's current default: a rebind or a second
		// enrolled session must not move a correction into a different
		// conversation, because the correction's whole point is the original
		// materials and the original context.
		const pinnedSessionId = taskSessionOf(projectRoot, plan.taskId);
		if (pinnedSessionId === null) {
			return failureResult(
				`Task ${plan.taskId} has no recorded WorkBuddy session, so its correction cannot be pinned to one.`,
				WB_ERROR_CODE.taskStateInvalid,
			);
		}
		let pinnedBinding: Binding;
		try {
			pinnedBinding = bindingForSession(binding, pinnedSessionId);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}
		// The confirmed digest is computed from the frozen materials, so staging can
		// refuse if any of them moved between validation and the freeze.
		let inputs: Array<{ path: string; sha256: string; bytes: number }>;
		let manifestSha256: string;
		try {
			inputs = [];
			for (const entry of plan.inputs) {
				const absolute = path.join(projectRoot, ...entry.path.split("/"));
				const info = await stat(absolute);
				if (!info.isFile()) {
					throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, `Frozen input ${entry.path} is not a regular file`);
				}
				inputs.push({ path: entry.path, sha256: entry.sha256, bytes: info.size });
			}
			manifestSha256 = buildConfirmationDigest({
				projectRoot,
				requestId: plan.requestId,
				taskId: plan.taskId,
				round: plan.targetRound,
				owner,
				goal: plan.request.goal,
				targetPolicy: { kind: "session", sessionId: pinnedBinding.sessionId },
				expectedOutputs: plan.request.expectedOutputs ?? [],
				inputs,
				deliveryMode: "foreground",
			});
		} catch (error) {
			return failureResult(
				`The correction's frozen materials could not be read: ${messageOf(error)}`,
				codeOf(error),
			);
		}
		const confirmation: RoundConfirmationV3 = {
			source: "host_dialog",
			at: new Date().toISOString(),
			targetPolicy: { kind: "session", sessionId: pinnedBinding.sessionId },
			requestId: plan.requestId,
			manifestSha256,
			owner,
			previousRound: plan.baseRound,
			inputs: plan.inputs.map((entry: { path: string; sha256: string }) => ({ path: entry.path, sha256: entry.sha256 })),
			deliveryMode: "foreground",
		};
		return await runConfirmedTask(ctx, pinnedBinding, plan.request, confirmation, signal, plan.taskId, {
			correctionReviewId: plan.reviewId,
		});
	}

	/** `/wb results [taskId]`: this session's unconsumed results, verified on read. */
	async function runResultsCommand(ctx: ExtensionContext, taskId: string | undefined): Promise<void> {
		const located = await locateProject(ctx);
		if (located.projectRoot === null) {
			ctx.ui.notify(located.reason ?? "No verified project root.", "error");
			return;
		}
		const projectRoot = located.projectRoot;
		const owner = queueOwnerFor(ctx);
		if (taskId !== undefined && taskId !== "") {
			const queue = openProjectQueue(projectRoot, { mode: "read" });
			if (queue === null) {
				ctx.ui.notify("No project queue is available.", "error");
				return;
			}
			let round: number | null = null;
			let ownedByThisSession = false;
			try {
				const rows = queue.inspect({ taskId }).tasks;
				const newest = rows[rows.length - 1];
				round = newest === undefined ? null : Number(newest["round"]);
				// `/wb results` is "this conversation's unconsumed results": another OMP
				// session's task is not this conversation's to read back, and showing it
				// would imply a delivery that never happened here.
				ownedByThisSession = newest?.["owner_session"] === owner.sessionId;
			} finally {
				queue.close();
			}
			if (round === null) {
				ctx.ui.notify(`Task ${taskId} has no round in this project.`, "warning");
				return;
			}
			if (!ownedByThisSession) {
				ctx.ui.notify(
					`Task ${taskId} was delegated by a different OMP session; its result is delivered there, not here.`,
					"warning",
				);
				return;
			}
			const report = await readDeliveryResult(projectRoot, taskId, round);
			if (report === null) {
				ctx.ui.notify(`Task ${taskId} round ${round} has no recorded result yet.`, "info");
				return;
			}
			const lines = [
				`Task ${report.taskId} round ${report.round}: ${report.outcome?.status ?? "no outcome"} (${report.state}, commit ${report.commit}).`,
				report.summary === "" ? "" : `Summary: ${report.summary}`,
				report.receipt === null ? "No proven receipt: nothing here is delivered evidence." : `Receipt: ${report.receipt.path}`,
				report.storageError === null ? "" : `Storage error: ${report.storageError.code}: ${report.storageError.message}`,
				...(report.artifacts.length === 0
					? ["No artifacts were proven against the receipt."]
					: [
							"Artifacts (current bytes):",
							...report.artifacts.map(
								(artifact) => `- ${artifact.path} [${artifact.state}]${artifact.sha256 === null ? "" : ` sha256 ${artifact.sha256}`}`,
							),
						]),
				report.notification.sent ? "An async notification was sent." : "No async notification was sent for this result.",
				report.notification.received ? "This session acknowledged receiving it." : "This session has not acknowledged it yet.",
			];
			ctx.ui.notify(lines.filter((line) => line.length > 0).join("\n"), "info");
			return;
		}
		const queue = openProjectQueue(projectRoot, { mode: "read" });
		if (queue === null) {
			ctx.ui.notify("No project queue is available.", "error");
			return;
		}
		// The cached handle is not a lease: close it before doing anything else, then
		// read the inbox through a fresh one and release that too.
		queue.close();
		let inbox: DeliveryInboxItem[] = [];
		const reader = openReadConnection(projectRoot);
		if (reader !== null) {
			try {
				inbox = listDeliveryInbox(reader, owner);
			} finally {
				closeQueueConnection(projectRoot, "read");
			}
		}
		if (inbox.length === 0) {
			ctx.ui.notify("No unconsumed results for this OMP session.", "info");
			return;
		}
		ctx.ui.notify(
			[
				"Unconsumed results in this OMP session:",
				...inbox.map(
					(item) =>
						`- ${item.taskId ?? item.requestId} round ${item.round ?? "?"} (${item.kind}, revision ${item.revision}) ${item.sent ? "sent" : "not sent"}; pass the task id to /wb results for details`,
				),
			].join("\n"),
			"info",
		);
	}

	/**
	 * `/wb cancel [taskId]`.
	 *
	 * With an id it delegates to the tool, so the command and the tool cannot disagree
	 * about who may stop what. Without one it offers this process's own tasks and refuses
	 * to guess: cancelling by "the only one running" is how the wrong task gets stopped.
	 */
	async function runCancelCommand(ctx: ExtensionContext, args: string[]): Promise<void> {
		const explicit = args.find((arg) => arg.length > 0 && !arg.startsWith("-"));
		if (explicit !== undefined) {
			const result = await runCancel(ctx, undefined, { taskId: explicit });
			ctx.ui.notify(resultText(result), (result.isError ?? false) ? "error" : "info");
			return;
		}
		// This process's own tasks in this project; a task from elsewhere is not ours to stop.
		const located = await locateProject(ctx);
		const mine = [...tasks.values()].filter(
			(task) => task.durable.owner.sessionId === ctx.sessionManager.getSessionId() &&
				located.projectRoot !== null && task.receipt.projectRoot === located.projectRoot,
		);
		const stoppable = mine.filter((task) => task.finalization === null);
		if (stoppable.length === 0) {
			ctx.ui.notify("Nothing in this process is running. Pass a task id from wb_tasks to cancel another.", "info");
			return;
		}
		const labels = stoppable.map(
			(task) => `${task.taskId} — round ${currentRound(task.receipt).number} — ${currentRound(task.receipt).status}`,
		);
		// A headless session has no dialog to answer. Listing the candidates and stopping is
		// the only honest outcome: picking one for the user would be the guess this command
		// exists to avoid.
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`Cancelling needs an interactive OMP session, or an explicit id.\n${labels.join("\n")}`,
				"error",
			);
			return;
		}
		const choice = await ctx.ui.select("Cancel which task?", labels);
		const chosen = choice === undefined ? undefined : labels.indexOf(choice);
		if (chosen === undefined || chosen < 0 || chosen >= stoppable.length) {
			ctx.ui.notify("Cancellation dismissed; nothing was stopped.", "info");
			return;
		}
		const result = await runCancel(ctx, undefined, { taskId: stoppable[chosen]!.taskId });
		ctx.ui.notify(resultText(result), (result.isError ?? false) ? "error" : "info");
	}

	async function runCancel(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		params: WbCancelParams,
	): Promise<AgentToolResult<unknown>> {
		const task = tasks.get(params.taskId);
		if (task === undefined) {
			// Distinguish "already finished here" from "never ours": the former is a
			// harmless no-op, the latter must not be touched across processes.
			const cancelLocated = await locateProject(ctx);
			if (cancelLocated.projectRoot === null) {
				return failureResult(
					cancelLocated.reason ?? `No authorized project covers ${cancelLocated.actualCwd}.`,
					WB_ERROR_CODE.bindingInvalid,
				);
			}
			const projectRoot = cancelLocated.projectRoot;
			// A queued round has no receipt on disk yet — its durable record is written at
			// the terminal commit — so reading the receipt first would report "not found"
			// for work that is very much alive and later gets dispatched. The queue is
			// asked before the receipt for exactly that reason.
			const queued = await cancelQueuedRound(projectRoot, params.taskId, queueOwnerFor(ctx), realWriteRoundReceipt);
			if (queued !== null) {
				return queued;
			}
			let receipt: TaskReceipt;
			try {
				receipt = await realReadTask(projectRoot, params.taskId);
			} catch (error) {
				return failureResult(messageOf(error), codeOf(error));
			}
			const currentR = currentRound(receipt);
			if (statusIsInFlight(currentR.status)) {
				return failureResult(
					`Task ${params.taskId} is still running but is not owned by this OMP process. Refusing to cancel it.`,
					WB_ERROR_CODE.busy,
				);
			}
			return taskResult(toTaskView(receipt, undefined, queueCommitState(projectRoot, params.taskId)));
		}
		if (task.durable.owner.sessionId !== ctx.sessionManager.getSessionId()) {
			return failureResult("This task belongs to a different originating OMP session.", WB_ERROR_CODE.busy);
		}

		// The cancellation is recorded before the worker is told, so a turn that
		// ends during the notification still reports a cancellation. A commit that
		// already started owns the outcome and is only waited on.
		await finalizeTask(task, "cancelled", null, {
			cancelWorker: signal?.aborted !== true,
			collectArtifacts: true,
		});
		return taskResult(toTaskView(task.receipt, task));
	}

	/**
	 * Reports this project's WorkBuddy readiness without changing anything.
	 *
	 * Three areas are covered: the binding, the task lock, and — only when a
	 * binding exists — the bound worker's GET-only health. The lock and the
	 * binding are always reported, so a missing binding never hides a stuck lock.
	 */
	async function runDoctor(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<unknown>> {
		// The diagnosis is about one specific canonical project. A root that cannot
		// be resolved is reported as a storage problem rather than guessed at, so
		// the report can never describe a different directory than the caller's.
		// A diagnostic must also work on a project that is unauthorized or
		// ambiguous: reporting that state is exactly what the user needs.
		let resolution: ProjectResolution;
		try {
			resolution = await locateProject(ctx);
		} catch (err: unknown) {
			return failureResult(
				`Cannot diagnose ${ctx.cwd}: the project root could not be resolved (${messageOf(err)})`,
				WB_ERROR_CODE.storageError,
			);
		}
		// Without an authorized root there is no project to inspect. The report
		// says so as a finding and stops describing project-scoped state; falling
		// back to the raw cwd would diagnose a directory the write path never uses.
		const projectRoot = resolution.projectRoot;
		const issues: DiagnosticIssue[] = [];
		if (projectRoot === null) {
			issues.push({
				severity: "error",
				code: WB_ERROR_CODE.bindingInvalid,
				message: resolution.reason ?? `No authorized project covers ${resolution.actualCwd}.`,
				nextAction: "Run /wb setup in this project to authorize it, then run /wb doctor again.",
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`WorkBuddy diagnosis for ${resolution.actualCwd}:`,
							`Issues:\n- [error] ${WB_ERROR_CODE.bindingInvalid}: ${issues[0]!.message} → ${issues[0]!.nextAction}`,
						].join("\n"),
					},
				],
				isError: true,
				details: {
					projectRoot: resolution.actualCwd,
					binding: null,
					lock: null,
					workers: [],
					issues,
					protocolVerified: false,
				},
			};
		}

		// 1. Binding. A missing or foreign binding is what the user must fix first.
		let binding: Binding | null = null;
		try {
			const stored = await realReadBinding(projectRoot);
			if (stored === null) {
				issues.push({
					severity: "error",
					code: WB_ERROR_CODE.bindingInvalid,
					message: `No WorkBuddy binding for ${projectRoot}.`,
					nextAction:
						"Open this exact folder as the workspace in WorkBuddy, create (or open) the session reserved for OMP delegation, then run /wb bind here and pick it.",
				});
			} else if (stored.projectRoot !== projectRoot) {
				issues.push({
					severity: "error",
					code: WB_ERROR_CODE.bindingInvalid,
					message: `The stored binding belongs to ${stored.projectRoot}, not ${projectRoot}.`,
					nextAction: "Run /wb bind in this project to bind it to its own dedicated session.",
				});
			} else {
				binding = stored;
			}
		} catch (error) {
			issues.push({
				severity: "error",
				code: codeOf(error),
				message: `The stored binding could not be read: ${messageOf(error)}`,
				nextAction: "Fix or remove the unreadable binding record, then run /wb bind again.",
			});
		}

		// 2. Task lock. Read-only: an existing lock is reported, never removed.
		let lockReport: (TaskLock & { ownerAlive: boolean; ownedByCurrentProcess: boolean }) | null = null;
		try {
			const lock = await realReadTaskLock(projectRoot);
			if (lock !== null) {
				const ownerAlive = isPidAlive(lock.ownerPid);
				const ownedHere =
					ownerAlive &&
					lock.ownerPid === process.pid &&
					tasks.get(lock.taskId)?.receipt.projectRoot === projectRoot;
				lockReport = { ...lock, ownerAlive, ownedByCurrentProcess: ownedHere };
				if (ownerAlive) {
					issues.push({
						severity: "warning",
						code: WB_ERROR_CODE.busy,
						message: `Task ${lock.taskId} holds the single-task lock under live process ${lock.ownerPid}.`,
						nextAction: ownedHere
							? "This OMP process owns that task; use wb_status or wb_cancel on it."
							: "Wait for that process to finish. Only then can another delegation start here.",
					});
				} else {
					issues.push({
						severity: "warning",
						code: WB_ERROR_CODE.interrupted,
						message: `Task ${lock.taskId} left a lock behind; its owner process ${lock.ownerPid} is gone.`,
						nextAction:
							"Start a normal delegation: the next wb_task safely marks that orphan interrupted and reclaims the slot. Do not delete the lock by hand.",
					});
				}
			}
		} catch (error) {
			// The lock is deliberately left exactly as it is, because it may be the
			// only record of a task that still has to be accounted for.
			issues.push({
				severity: "error",
				code: codeOf(error),
				message: `The task lock could not be read and was left untouched: ${messageOf(error)}`,
				nextAction: "Inspect .wb-bridge/active.lock and repair it, then run wb_doctor again.",
			});
		}

		// 3. Queue holds. A queue-backed round holds its WorkBuddy session and scope until
		// its receipt is confirmed, so a leaked hold — not `active.lock`, which the queue
		// path never writes — is what actually blocks the next delegation. Reporting only
		// the lock would make a wedged session look free.
		let holdsReport: Array<{ sessionId: string; taskId: string | null; round: number | null; kind: string }> = [];
		try {
			const queue = openProjectQueue(projectRoot, { mode: "read" });
			if (queue !== null) {
				try {
					holdsReport = queue.holds();
					for (const hold of holdsReport) {
						if (hold.kind === "quarantine") {
							// The recovery is possible from *this* session too, not
							// only from the session that owned the round. The truth is
							// that a human operator may recover the receipt once the
							// original owner's process is provably gone; the original
							// session is not the only possible path.
							const subject = hold.taskId !== null && hold.round !== null
								? queue.recoverySubject(hold.taskId, hold.round)
								: null;
							issues.push({
								severity: "warning",
								code: WB_ERROR_CODE.interrupted,
								message:
									hold.taskId === null
										? `WorkBuddy session ${hold.sessionId} is quarantined.`
										: `Task ${hold.taskId} (round ${hold.round ?? "?"}) quarantined WorkBuddy session ${hold.sessionId} after its owner died.`,
								nextAction: subject === null
									? "No recorded first outcome is available to authorize recovery. Inspect this project's state; do not replay or unlock an unknown execution."
									: subject.receiptSha256 === null
										? `Repair the receipt with /wb repair ${hold.taskId}; the originating session may do this, or a human operator once the original owner's process is provably gone. Then verify that the WorkBuddy turn stopped and run /wb release ${hold.taskId}.`
										: `Verify that the WorkBuddy turn stopped, then run /wb release ${hold.taskId} to clear the quarantine. The receipt is already committed; do not repair it again.`,
							});
							continue;
						}
						if (hold.kind !== "execution") {
							continue;
						}
						const owner = hold.taskId === null ? undefined : tasks.get(hold.taskId);
						const live = owner !== undefined && owner.storageError === null;
						issues.push({
							// A hold this process owns is normal work in progress, so it is a
							// warning only when no live task claims it; either way it is reported,
							// because a hold nobody owns is what blocks the next delegation.
							severity: "warning",
							code: live ? WB_ERROR_CODE.busy : WB_ERROR_CODE.interrupted,
							message:
								hold.taskId === null
									? `WorkBuddy session ${hold.sessionId} holds an execution slot.`
									: `Task ${hold.taskId} (round ${hold.round ?? "?"}) holds WorkBuddy session ${hold.sessionId}.`,
							nextAction: live
								? "This OMP process owns that round; use wb_status or wb_cancel on it."
								: "If its owner is gone, the next write in this project reconciles the hold automatically. Do not clear the queue by hand.",
						});
					}
				} finally {
					queue.close();
				}
			}
		} catch (error) {
			issues.push({
				severity: "error",
				code: codeOf(error),
				message: `The queue's resource rows could not be read: ${messageOf(error)}`,
				nextAction: "Repair the project queue file, then run wb_doctor again.",
			});
		}

		// 3. This process's own uncommitted state.
		for (const task of tasks.values()) {
			if (task.receipt.projectRoot === projectRoot && task.storageError !== null) {
				issues.push({
					severity: "error",
					code: WB_ERROR_CODE.storageError,
					message: `Task ${task.taskId} could not commit its terminal state: ${task.storageError.message}`,
					nextAction:
						"Fix the storage problem (permissions, free space, read-only volume), then exit and restart OMP so the next delegation can reclaim the slot safely.",
				});
			}
		}

		// 4. Worker inspection. Only runs for a usable binding, and never attaches.
		let workers: WorkerInspection[] = [];
		if (binding !== null) {
			try {
				workers = await realInspectWorkers(binding, signal ?? new AbortController().signal);
			} catch (error) {
				issues.push({
					severity: "warning",
					code: null,
					message: `The bound worker could not be inspected: ${messageOf(error)}`,
					nextAction: "Check that the WorkBuddy desktop app is running, then run wb_doctor again.",
				});
			}
			for (const worker of workers) {
				switch (worker.status) {
					case "verified":
						break;
					case "busy":
						issues.push({
							severity: "warning",
							code: WB_ERROR_CODE.busy,
							message: `Worker ${worker.endpoint} reports an occupied writer for the bound session.`,
							nextAction: "Idle that session in the WorkBuddy desktop app, then delegate again.",
						});
						break;
					case "auth_required":
						issues.push({
							severity: "warning",
							code: WB_ERROR_CODE.authRequired,
							message: `Worker ${worker.endpoint} refused the read-only probes; ACP was not checked.`,
							nextAction: "Check the session's authorization in the WorkBuddy desktop app.",
						});
						break;
					case "mismatch":
						issues.push({
							severity: "error",
							code: WB_ERROR_CODE.bindingInvalid,
							message: `Worker ${worker.endpoint} is serving a different project or session than the binding.`,
							nextAction: "Run /wb bind here to bind this project to its own dedicated session.",
						});
						break;
					case "unhealthy":
						issues.push({
							severity: "error",
							code: WB_ERROR_CODE.taskFailed,
							message: `Worker ${worker.endpoint} reports an unhealthy status.`,
							nextAction: "Restart the WorkBuddy desktop app for that session, then run wb_doctor again.",
						});
						break;
					// An `unknown` socket is handled by the summary below, so it is
					// deliberately not reported individually here.
					case "unknown":
						break;
					case "unreachable":
						// The record outlived the process: the endpoint comes from a log or
						// registry entry and nothing answers on that port now. Saying so
						// prevents the user from restarting a healthy desktop for a stale
						// record, and prevents "reopen the session" advice when the session
						// is simply gone.
						issues.push({
							severity: "warning",
							code: null,
							message: `Worker ${worker.endpoint} no longer answers: the recorded endpoint outlived its process.`,
							nextAction:
								"Open this project in the WorkBuddy desktop app and run /wb bind again to record the session that is actually running.",
						});
						break;
				}
			}
			// The endpoints that could not be identified are summarised once: listing
			// each unrelated socket separately would bury the real finding.
			const unidentified = workers.filter((worker) => worker.status === "unknown");
			if (unidentified.length > 0) {
				issues.push({
					severity: "warning",
					code: null,
					message:
						unidentified.length === workers.length
							? `None of the ${workers.length} listening endpoint(s) answered enough to identify them.`
							: `${unidentified.length} of ${workers.length} listening endpoint(s) answered nothing identifiable.`,
					nextAction:
						"Confirm the WorkBuddy desktop app is running with this project's dedicated session open, then delegate a real task: this check cannot prove the worker is stopped or incompatible.",
				});
			}
			if (workers.length === 0) {
				issues.push({
					severity: "warning",
					code: null,
					message: "No running worker was found for the bound session.",
					nextAction:
						"Open this project in the WorkBuddy desktop app with its dedicated session, then delegate again. This check cannot prove the worker is stopped.",
				});
			}
		}

		const failed = issues.some((issue) => issue.severity === "error");
		const enrolled = binding === null ? [] : listBoundSessions(binding);
		const poolPolicy =
			binding === null
				? "none"
				: binding.autoBindProjectSessions === true
					? `project-wide enrollment (${enrolled.length} session(s))`
					: "single fixed session";
		// The per-task targets are read from the queue's own rows: a task's target
		// is the session that was actually selected for it, not the project's
		// default. Reporting the default for every task would misdescribe a pool
		// that really did route work to different conversations.
		const taskTargets: Array<{ taskId: string; round: number; sessionId: string | null; status: string }> = [];
		// Every enrolled session's real availability, and every queued round's
		// real wait reason. A diagnosis that cannot say which session is busy
		// sends the user to restart the desktop app instead of to the one
		// conversation that is actually busy.
		const sessionAvailability: Array<{ sessionId: string; availability: string; reason: string | null }> = [];
		const queuedWaits: Array<{
			taskId: string;
			round: number;
			reason: string;
			sessionBlockers: Array<{ sessionId: string; reason: string }>;
		}> = [];
		try {
			const reader = openProjectQueue(projectRoot, { mode: "read" });
			if (reader !== null) {
				try {
					for (const row of readAllQueuedRounds(reader)) {
						const taskId = String(row["task_id"]);
						const round = Number(row["round"] ?? 1);
						taskTargets.push({
							taskId,
							round,
							sessionId: typeof row["selected_session"] === "string" ? row["selected_session"] : null,
							status: String(row["status"] ?? "unknown"),
						});
						if (String(row["status"] ?? "") === "queued") {
							const wait = reader.waitState(taskId, round);
							if (wait.reason !== null) {
								queuedWaits.push({
									taskId,
									round,
									reason: wait.reason,
									sessionBlockers: wait.sessionBlockers,
								});
							}
						}
					}
					for (const row of reader.inspect({ include: { sessions: true } }).sessions) {
						sessionAvailability.push({
							sessionId: String(row["session_id"]),
							availability: String(row["availability"] ?? "unknown"),
							reason:
								row["ownership_conflict"] === 1
									? "ownership_conflict"
									: row["identity"] === "verified"
										? null
										: "session_unavailable",
						});
					}
				} finally {
					reader.close();
				}
			}
		} catch {
			// The queue is unreadable: the diagnosis reports the binding facts it
			// has and says nothing about targets it cannot read.
		}
		const lines = [
			`WorkBuddy diagnosis for ${projectRoot}:`,
			binding === null
				? "Binding: none or unusable."
				: `Binding: session ${binding.sessionId} (WorkBuddy ${binding.workbuddyVersion}).`,
			`Pool policy: ${poolPolicy}.`,
			enrolled.length > 1
				? `Enrolled sessions: ${enrolled.map((member) => member.sessionId).join(", ")}.`
				: null,
			sessionAvailability.length === 0
				? null
				: `Session availability: ${sessionAvailability
						.map(
							(session) =>
								`${session.sessionId}: ${session.availability}${
									session.reason === null ? "" : ` (${session.reason})`
								}`,
						)
						.join(", ")}.`,
			queuedWaits.length === 0
				? null
				: `Queued rounds: ${queuedWaits
						.map(
							(wait) =>
								`${wait.taskId} r${wait.round} waiting (${wait.reason})${
									wait.sessionBlockers.length === 0
										? ""
										: ` — ${wait.sessionBlockers
												.map((blocker) => `${blocker.sessionId}: ${blocker.reason}`)
												.join(", ")}`
								}`,
						)
						.join("; ")}.`,
			taskTargets.length === 0
				? null
				: `Task targets: ${taskTargets
						.map(
							(target) =>
								`${target.taskId} r${target.round} -> ${
									target.sessionId ?? "unassigned"
								} (${target.status})`,
						)
						.join(", ")}.`,
			lockReport === null
				? "Task lock: free."
				: `Task lock: task ${lockReport.taskId} held by PID ${lockReport.ownerPid} (${
						lockReport.ownerAlive ? "alive" : "gone"
					}${lockReport.ownedByCurrentProcess ? ", this process" : ""}).`,
			`Workers inspected: ${workers.length}${
				workers.length === 0
					? ""
					: ` (${workers.map((worker) => `${worker.endpoint}: ${worker.status}`).join(", ")})`
			}.`,
			// Stated unconditionally: this mode cannot prove ACP compatibility, and a
			// green result must never be read as a working delegation.
			"ACP compatibility: not checked here — it is only proven when a real delegation connects.",
			issues.length === 0
				? "No local problems found. The checks that ran cannot prove ACP works."
				: `Issues:\n${issues
						.map((issue) => `- [${issue.severity}] ${issue.code ?? "no code"}: ${issue.message} → ${issue.nextAction}`)
						.join("\n")}`,
		].filter((line): line is string => line !== null);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			isError: failed,
			details: {
				projectRoot,
				binding:
					binding === null
						? null
						: { sessionId: binding.sessionId, workbuddyVersion: binding.workbuddyVersion },
				pool: {
					policy: poolPolicy,
					autoBindProjectSessions: binding?.autoBindProjectSessions === true,
					sessions: enrolled.map((member) => ({
						sessionId: member.sessionId,
						workbuddyVersion: member.workbuddyVersion ?? binding?.workbuddyVersion ?? "",
					})),
				},
				sessionAvailability,
				queuedWaits,
				taskTargets,
				lock: lockReport,
				workers,
				issues,
				// Always false: this tool never proves the ACP contract.
				protocolVerified: false,
			},
		};
	}

	/**
	 * Lists this project's persisted tasks.
	 *
	 * The stored index is the source of truth; tasks this process still owns are
	 * overlaid on top of it so their live state and any storage failure are
	 * visible. Nothing is written, reconnected or cleaned up here.
	 */
	async function runTasks(ctx: ExtensionContext, params: WbTasksParams): Promise<AgentToolResult<unknown>> {
		const limit = params.limit ?? DEFAULT_TASK_PAGE;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE) {
			return failureResult(
				`limit must be an integer between 1 and ${MAX_TASK_PAGE}, got ${String(params.limit)}`,
				WB_ERROR_CODE.inputInvalid,
			);
		}
		const offset = params.offset ?? 0;
		if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
			return failureResult(
				`offset must be a non-negative integer, got ${String(params.offset)}`,
				WB_ERROR_CODE.inputInvalid,
			);
		}
		if (params.status !== undefined && !TASK_STATUSES.includes(params.status)) {
			return failureResult(
				`status must be one of ${TASK_STATUSES.join(", ")}, got "${String(params.status)}"`,
				WB_ERROR_CODE.inputInvalid,
			);
		}

		// The listing is about one specific canonical project. A root that cannot be
		// resolved is reported as a storage problem rather than guessed at, so the
		// rows can never describe a different directory than the caller's.
		let locatedForList: ProjectResolution;
		try {
			locatedForList = await locateProject(ctx);
		} catch (err: unknown) {
			return failureResult(
				`Cannot list tasks for ${ctx.cwd}: the project root could not be resolved (${messageOf(err)})`,
				WB_ERROR_CODE.storageError,
			);
		}
		if (locatedForList.projectRoot === null) {
			return failureResult(
				locatedForList.reason ?? `No authorized project covers ${locatedForList.actualCwd}.`,
				WB_ERROR_CODE.bindingInvalid,
			);
		}
		const projectRoot = locatedForList.projectRoot;
		let index: { entries: StoredTaskSummary[]; warnings: TaskListWarning[] };
		try {
			index = await realReadTaskIndex(projectRoot);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}

		// The queue is the authority on dispatched rounds; the receipt index only
		// knows about pre-queue history. Listing from the index alone would hide every
		// task this build dispatched, because their receipts live under
		// `tasks/<id>/rounds/<n>/` rather than at `tasks/<id>/receipt.json`.
		let listed: StoredTaskSummary[] = [...index.entries];
		// A project that has not been migrated has no queue to read, which is the
		// pre-queue case the receipt index already covers.
		const queue = openProjectQueue(projectRoot, { mode: "read" });
		if (queue !== null) {
			try {
				const fromQueue = summariseQueueRounds(readAllQueuedRounds(queue));
				// A queue row for a task supersedes the legacy entry for the same task: the
				// queue carries the round and its committed terminal state, and two rows for
				// one task would double-count it.
				const queuedIds = new Set(fromQueue.map((entry) => entry.taskId));
				listed = [...fromQueue, ...index.entries.filter((entry) => !queuedIds.has(entry.taskId))];
			} catch (error) {
				return failureResult(messageOf(error), codeOf(error));
			} finally {
				queue.close();
			}
		}

		// Only this project's live tasks are merged in; other projects' tasks in
		// this process are never reported as belonging here.
		const rows: Array<
			StoredTaskSummary & { ownedByCurrentProcess: boolean; storageError: TaskError | null }
		> = [];
		for (const entry of listed) {
			const live = tasks.get(entry.taskId);
			const mine = live !== undefined && live.receipt.projectRoot === projectRoot;
			rows.push({
				taskId: entry.taskId,
				sessionId: mine ? live.receipt.sessionId : entry.sessionId,
				round: mine ? toTaskView(live.receipt, live).round : entry.round,
				status: mine ? toTaskView(live.receipt, live).status : entry.status,
				updatedAt: entry.updatedAt,
				ownedByCurrentProcess: mine,
				storageError: mine ? live.storageError : null,
			});
		}

		const filtered =
			params.status === undefined ? rows : rows.filter((row) => row.status === params.status);
		// Newest first, with the task id as a stable tie-break so a shared
		// timestamp still yields a deterministic order.
		filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));

		const page = filtered.slice(offset, offset + limit);
		const nextOffset = offset + page.length < filtered.length ? offset + page.length : null;

		const lines = [
			`Tasks in ${projectRoot}: ${filtered.length} matching${
				params.status === undefined ? "" : ` status=${params.status}`
			}, showing ${page.length} from offset ${offset}.`,
			...page.map(
				(row) =>
					`- ${row.taskId}: ${row.status} (updated ${new Date(row.updatedAt).toISOString()})${
						row.ownedByCurrentProcess ? " [this process]" : ""
					}${row.storageError === null ? "" : ` — storage error: ${row.storageError.message}`}`,
			),
		];
		if (nextOffset !== null) {
			lines.push(`Next page: wb_tasks with offset ${nextOffset}.`);
		}
		if (index.warnings.length > 0) {
			// The list is still usable, but the caller has to know it is incomplete.
			lines.push(
				`${index.warnings.length} stored task record(s) could not be read and are not listed: ${index.warnings
					.map((warning) => `${warning.taskId} (${warning.error.code})`)
					.join(", ")}.`,
			);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			// A successful listing states this explicitly, because a listing with
			// failed tasks or unreadable records is still a successful query.
			isError: false,
			details: {
				projectRoot,
				tasks: page,
				total: filtered.length,
				offset,
				limit,
				nextOffset,
				warnings: index.warnings,
			},
		};
	}

	/**
	 * Presents one approval request.
	 *
	 * `select` is used rather than a yes/no confirmation so the only affirmative
	 * choice is an explicit one-time approval; dismissing the dialog denies. The
	 * task's abort signal is passed through so a stopped task cannot leave a
	 * dialog waiting for a decision that no longer means anything.
	 */
	async function presentApproval(
		ctx: ExtensionContext,
		taskId: string,
		interruption: Interruption,
		signal: AbortSignal,
	): Promise<boolean> {
		const body = [
			`Task: ${taskId}`,
			`Tool: ${interruption.toolName}`,
			summarizeToolInput(interruption.toolInput),
			interruption.reason,
			"Approving lets WorkBuddy perform exactly this one step.",
		]
			.filter((line) => line !== "")
			.join("\n");
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(`WorkBuddy requests permission\n\n${body}`, ["Deny", "Approve once"], {
				signal,
			});
		} catch {
			// An aborted or failed dialog is never an approval.
			return false;
		}
		return choice === "Approve once";
	}
}

/**
 * Parses the standard ACP `session/request_permission` request.
 *
 * Its reply is a `RequestPermissionOutcome` selecting one of the offered
 * option ids, so the refusal and one-time grant options are resolved up front.
 * A request offering no refusal option is unanswerable and is left alone.
 */
function parseStandardPermission(params: unknown): Interruption | null {
	if (params === null || typeof params !== "object") {
		return null;
	}
	if (!("toolCall" in params) || params.toolCall === null || typeof params.toolCall !== "object") {
		return null;
	}
	const toolCall = params.toolCall;
	const toolCallId = "toolCallId" in toolCall && typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
	if (toolCallId === "") {
		return null;
	}

	// Only a one-time grant is ever offered: a standing permission would outlive
	// the human decision that authorized it.
	let allowOptionId: string | undefined;
	let rejectOptionId: string | undefined;
	const offered = "options" in params && Array.isArray(params.options) ? params.options : [];
	for (const option of offered) {
		if (option === null || typeof option !== "object" || !("optionId" in option)) {
			continue;
		}
		const optionId = typeof option.optionId === "string" ? option.optionId : "";
		if (optionId === "") {
			continue;
		}
		const kind = "kind" in option && typeof option.kind === "string" ? option.kind : "";
		if (kind === "allow_once") {
			allowOptionId ??= optionId;
		} else if (kind === "reject_once" || kind === "reject_always") {
			rejectOptionId ??= optionId;
		}
	}
	if (rejectOptionId === undefined) {
		return null;
	}

	const title = "title" in toolCall && typeof toolCall.title === "string" ? toolCall.title : "";
	return {
		requestId: toolCallId,
		toolCallId,
		toolName: title === "" ? "unknown" : title,
		reason: title,
		toolInput: "rawInput" in toolCall ? toolCall.rawInput : undefined,
		options: [],
		rejectOptionId,
		allowOptionId,
		reply: (approved: boolean) => ({
			outcome: {
				outcome: "selected",
				optionId: approved && allowOptionId !== undefined ? allowOptionId : rejectOptionId,
			},
		}),
	};
}

/** Parses WorkBuddy's own interruption request, which is nested under `_meta`. */
function parseWorkBuddyInterruption(params: unknown): Interruption | null {
	if (params === null || typeof params !== "object") {
		return null;
	}
	let payload: unknown = params;
	if ("_meta" in params) {
		const meta = params._meta;
		if (meta !== null && typeof meta === "object" && "codebuddy.ai/interruptionRequest" in meta) {
			payload = meta["codebuddy.ai/interruptionRequest"];
		}
	}
	if (payload === null || typeof payload !== "object") {
		return null;
	}
	const toolCallId = "toolCallId" in payload && typeof payload.toolCallId === "string" ? payload.toolCallId : "";
	const interruptionId =
		"interruptionId" in payload && typeof payload.interruptionId === "string" ? payload.interruptionId : "";
	const requestId = interruptionId === "" ? toolCallId : interruptionId;
	if (requestId === "") {
		return null;
	}
	const sessionId = "sessionId" in payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
	const options =
		"options" in payload && Array.isArray(payload.options)
			? payload.options.filter((option): option is string => typeof option === "string")
			: [];
	return {
		requestId,
		toolCallId,
		toolName: "toolName" in payload && typeof payload.toolName === "string" ? payload.toolName : "unknown",
		reason:
			"reason" in payload && typeof payload.reason === "string"
				? payload.reason
				: "toolTitle" in payload && typeof payload.toolTitle === "string"
					? payload.toolTitle
					: "",
		toolInput: "toolInput" in payload ? payload.toolInput : undefined,
		options,
		// The only affirmative answer this client ever gives is a single decision
		// for this one tool call; no allow-all form is emitted.
		reply: (approved: boolean) => ({
			sessionId,
			toolCallId,
			decision: approved ? DECISION_ALLOW : DECISION_DENY,
		}),
	};
}

/** Renders a tool input as one line so the approval shows the real target. */
function summarizeToolInput(input: unknown): string {
	if (input === null || input === undefined) {
		return "";
	}
	if (typeof input === "string") {
		return input.length > APPROVAL_INPUT_LIMIT ? `${input.slice(0, APPROVAL_INPUT_LIMIT)}…` : input;
	}
	let text: string;
	try {
		text = JSON.stringify(input);
	} catch {
		return "";
	}
	return text.length > APPROVAL_INPUT_LIMIT ? `${text.slice(0, APPROVAL_INPUT_LIMIT)}…` : text;
}

function receiptIsTerminal(receipt: TaskReceipt): boolean {
	const current = currentRound(receipt);
	return (
		current.status === "completed" ||
		current.status === "cancelled" ||
		current.status === "failed" ||
		current.status === "interrupted"
	);
}

/**
 * Reports that a task's durable state could not be committed.
 *
 * Only the task id, the failing stage and the error are recorded — never the
 * prompt, the artifact contents or any credential.
 */
function reportStorageFailure(pi: ExtensionAPI, task: ActiveTask, stage: string): void {
	const message = `WorkBuddy task ${task.taskId} could not commit its terminal state during ${stage}: ${
		task.storageError?.message ?? "unknown failure"
	}`;
	pi.logger.error(message, { taskId: task.taskId, stage });
	if (task.ctx.hasUI) {
		task.ctx.ui.notify(message, "error");
	}
}

/**
 * Builds the v3 round receipt for a finished round.
 *
 * Every decision-bearing field comes from a real fact captured at dispatch or from
 * the round itself — never a default. The parser is strict about exactly these
 * fields, so an invented value produces a receipt that cannot be read back, which
 * is the failure mode this shape is designed to make loud.
 */
function buildRoundReceipt(
	task: ActiveTask,
	snapshot: TaskReceipt,
	status: TaskStatus,
	error: TaskError | null,
): TaskReceiptV3 {
	const round = currentRound(snapshot);
	const durable = task.durable;
	return {
		version: 3,
		taskId: snapshot.taskId,
		sessionId: snapshot.sessionId,
		projectRoot: snapshot.projectRoot,
		rounds: [
			{
				number: round.number,
				layout: round.layout,
				goal: round.goal,
				inputFiles: round.inputFiles,
				expectedOutputs: round.expectedOutputs,
				status,
				summary: round.summary,
				error,
				artifacts: round.artifacts,
				recordKind: "approved",
				requestId: durable.requestId,
				targetPolicy: { kind: "session", sessionId: snapshot.sessionId },
				snapshotRoot: durable.snapshotRoot,
				owner: durable.owner,
				manifestSha256: durable.manifestSha256,
				// The transaction fence belongs to the queue revision, not a
				// guessed revision embedded in the file being certified.
				commitToken: null,
				turns: [],
				consent: round.consent,
			},
		],
	};
}



/**
 * Reduces queue round rows to one summary per task.
 *
 * A task can have several rounds, and the listing speaks per task: the newest
 * round describes it, because that is the state a reader acts on. `updated_at` is
 * a millisecond epoch in the queue and an ISO string on the surface, so it is
 * converted here rather than at every call site.
 */
function summariseQueueRounds(rows: Array<Record<string, unknown>>): StoredTaskSummary[] {
	const newest = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		const taskId = String(row["task_id"]);
		const round = Number(row["round"]);
		const previous = newest.get(taskId);
		if (previous === undefined || round > Number(previous["round"])) {
			newest.set(taskId, row);
		}
	}
	return [...newest.values()].map((row) => ({
		taskId: String(row["task_id"]),
		sessionId: String(row["selected_session"] ?? row["owner_session"] ?? ""),
		round: Number(row["round"]),
		status: queueStatusToTaskStatus(String(row["status"]), String(row["commit_state"] ?? "pending")),
		updatedAt: Number(row["updated_at"] ?? 0),
	}));
}

/**
 * Maps a queue round to the status the task surface reports.
 *
 * The queue distinguishes "the worker stopped" from "the receipt is committed";
 * a reader asking about a task cares whether its result is safe to read, so a
 * terminal outcome whose commit has not been confirmed is still `running` from
 * this surface's point of view — it is not delivered, and not failed either.
 */
function queueStatusToTaskStatus(status: string, commitState: string): StoredTaskSummary["status"] {
	if (status === "queued") {
		return "queued";
	}
	if (status === "running" || status === "awaiting_approval" || status === "awaiting_help") {
		return "running";
	}
	// A round whose receipt write failed is decided, not in flight: reporting `running`
	// would hide a storage failure behind a status that promises progress.
	if (commitState === "failed") {
		return "failed";
	}
	if (commitState !== "committed") {
		return "running";
	}
	if (status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted") {
		return status;
	}
	return "running";
}

/**
 * True when a resume failure cannot be fixed by trying again.
 *
 * The distinction decides whether the round returns to the queue or is failed. A digest
 * mismatch means the staged bytes are no longer the ones the confirmation was fenced on
 * — retrying re-reads the same bytes and fails the same way, so the round has to stop
 * and say so. Everything else (a missing stage, an I/O error) may be transient.
 */
function isUnrecoverableStageError(error: unknown): boolean {
	if (!(error instanceof WbTaskError)) {
		return false;
	}
	const message = error.message;
	return message.includes("does not match its recorded digest") || message.includes("does not match the digest enqueued");
}

/**
 * Cancels a round this process is not running, when the queue still owns it.
 *
 * Cancellation has to win over a round that has not been sent yet: `claim` skips
 * rows with `cancel_requested`, so recording the request here is what stops
 * `advanceQueuedRounds` from delivering work the user already cancelled. A round that
 * may have been sent is left to the owning process, because only that process holds
 * the connection the worker must be told on.
 */
async function cancelQueuedRound(
	projectRoot: string,
	taskId: string,
	owner: OwnerIdentity,
	writeReceipt: NonNullable<BridgeOverrides["writeRoundReceipt"]>,
): Promise<AgentToolResult<unknown> | null> {
	let queue;
	try {
		queue = openProjectQueue(projectRoot, { mode: "write" });
	} catch {
		return null;
	}
	if (queue === null) {
		return null;
	}
	try {
		const rows = queue.inspect({ taskId }).tasks;
		const row = rows.find((candidate) => candidate["commit_state"] !== "committed");
		if (row === undefined) {
			return null;
		}
		if (row["owner_session"] !== owner.sessionId || row["owner_generation"] !== owner.generation) {
			return failureResult("Only the originating active OMP owner may cancel this queued task.", WB_ERROR_CODE.busy);
		}
		const round = Number(row["round"]);
		if (row["dispatch_state"] !== "not_sent") {
			// Another process armed this round; the worker may hold the prompt, so the
			// cancellation belongs to whoever owns that connection.
			return failureResult(
				`Task ${taskId} (round ${round}) has already been sent by another OMP process. Cancel it there.`,
				WB_ERROR_CODE.busy,
			);
		}
		if (row["outcome_json"] !== null) {
			return failureResult("This task already has a first result; repair its receipt instead of cancelling it again.", WB_ERROR_CODE.storageError);
		}
		// Persist the decision first. A receipt or manifest failure keeps that
		// cancellation and its resources visible; it never permits a send.
		queue.requestCancel({
			taskId,
			round,
			now: Date.now(),
			reason: "Cancelled by the user before the round ran",
		});
		// The cancellation scope ends before the receipt is read back: the
		// project's connection must not be held across that await.
		queue.close();
		queue = null;
		try {
			const staged = await readStagedManifest(path.dirname(String(row["manifest_path"])));
			if (staged.manifestSha256 !== row["manifest_sha256"]) {
				throw new WbTaskError(WB_ERROR_CODE.storageError, "The cancellation manifest no longer matches its approved bytes");
			}
			const payload = staged.manifest.payload;
			// A queued round that never reached a claim has no session of its own:
			// the pool chooses one only when the round runs. The receipt therefore
			// names the session the task was *assigned* to — the queue's durable
			// affinity, which exists as soon as the round was claimed and survives
			// its release — and falls back to the project's own default session
			// for a round that was never claimed at all. No session is invented:
			// every value here is a session the project actually enrolled.
			const selected = typeof row["selected_session"] === "string" ? row["selected_session"] : "";
			const affinity = pinnedSessionOf(projectRoot, taskId);
			const targetSession =
				payload.targetPolicy.kind === "session"
					? payload.targetPolicy.sessionId
					: selected !== ""
						? selected
						: affinity ?? (await defaultEnrolledSession(projectRoot));
			if (targetSession === null) {
				throw new WbTaskError(
					WB_ERROR_CODE.taskStateInvalid,
					"This queued round has no enrolled WorkBuddy session to describe; repair its receipt explicitly",
				);
			}
			const receipt = buildReceiptForStage({
				projectRoot, taskId, round, sessionId: targetSession,
				request: { goal: payload.goal, inputFiles: [], expectedOutputs: payload.expectedOutputs },
				confirmation: {
					source: staged.manifest.approval.source, at: staged.manifest.approval.at,
					targetPolicy: payload.targetPolicy, requestId: payload.requestId,
					manifestSha256: staged.manifestSha256, owner: payload.owner, previousRound: round - 1,
					inputs: payload.inputs, deliveryMode: payload.deliveryMode,
				},
				staged, outputsDir: resolveRoundPaths(projectRoot, taskId, round, "round").outputsDir,
			});
			const cancelledRound = receipt.rounds[0]!;
			cancelledRound.status = "cancelled";
			cancelledRound.summary = "Cancelled before any prompt was sent";
			const written = await writeReceipt(projectRoot, taskId, round, "round", receipt);
			const committed = await commitDurableRound({
				projectRoot, taskId, round, requestId: payload.requestId,
				status: "cancelled", error: null, receiptSha256: written.sha256,
			});
			if (!committed.committed) {
				throw new WbTaskError(WB_ERROR_CODE.storageError, committed.reason ?? "The cancellation receipt was not committed");
			}
		} catch (error) {
			recordCommitFailureById(projectRoot, taskId, round, messageOf(error));
			return failureResult(`Cancellation preserved, receipt repair required: ${messageOf(error)}`, WB_ERROR_CODE.storageError);
		}
		await logEvent(projectRoot, "cancel.requested", {
			taskId,
			round,
			reasonCode: "queued_round",
			ownerPid: process.pid,
		}).catch(() => undefined);
		return {
			content: [
				{
					type: "text",
					text: `Task ${taskId} (round ${round}) was cancelled before it ran. It will not be dispatched.`,
				},
			],
			details: { taskId, round, status: "cancelled", commitState: "committed", readyForReview: false },
		};
	} finally {
		queue?.close();
	}
}

/**
 * Returns a claimed round to the queue, recording why on the round.
 *
 * The reason is kept on the round for diagnostics while the claim itself is undone:
 * a requeued round that silently returned would hide a recurring transient error.
 */
function rollbackResumeClaim(
	projectRoot: string,
	taskId: string,
	round: number,
	attemptId: string,
	reason: string,
): void {
	try {
		const queue = openProjectQueue(projectRoot, { mode: "write" });
		if (queue === null) {
			return;
		}
		try {
			queue.rollbackClaim({ taskId, round, attemptId, reason, now: Date.now() });
		} finally {
			queue.close();
		}
	} catch {
		// Best effort: the caller's error is the one that matters, and a rollback that
		// cannot be recorded must not replace it.
	}
}

/**
 * Records a failed commit for a round this process is not tracking.
 *
 * Resumption has no `ActiveTask`: the dispatch that enqueued the round has returned.
 * The queue row is still the place the failure belongs, so a resumed round that
 * cannot be sent is marked `failed`/`recovery_required` rather than left `pending`
 * where it would read as work still in progress.
 */
function recordCommitFailureById(projectRoot: string, taskId: string, round: number, reason: string): void {
	try {
		const queue = openProjectQueue(projectRoot, { mode: "write" });
		if (queue === null) {
			return;
		}
		try {
			// `commitFailed` records that the record could not be written; without a
			// terminal outcome the row keeps `status = 'queued'` and every reader would
			// report a round that can never run as merely waiting. The outcome is decided
			// first so the two fields agree.
			const now = Date.now();
			queue.beginTerminal({
				taskId,
				round,
				outcome: {
					status: "failed",
					errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }),
					outcomeJson: JSON.stringify({
						status: "failed",
						error: { code: WB_ERROR_CODE.storageError, message: reason },
					}),
				},
				now,
			});
			queue.commitFailed({
				taskId,
				round,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }),
				now,
			});
		} finally {
			queue.close();
		}
	} catch {
		// The caller already has the error; a queue that cannot record it must not
		// replace it with a write failure.
	}
}

function recordFirstOutcome(task: ActiveTask): void {
	const round = currentRound(task.receipt);
	const status = round.status;
	if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "interrupted") {
		throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "Only a terminal business result can be recorded");
	}
	const queue = openProjectQueue(task.receipt.projectRoot, { mode: "write" });
	if (queue === null) {
		throw new WbTaskError(WB_ERROR_CODE.storageError, "Project queue is unavailable while recording the first result");
	}
	try {
		const result = queue.beginTerminal({
			taskId: task.taskId,
			round: round.number,
			outcome: {
				status,
				errorJson: round.error === null ? null : JSON.stringify(round.error),
				outcomeJson: JSON.stringify({ status, error: round.error, summary: round.summary, artifacts: round.artifacts }),
			},
			now: Date.now(),
		});
		if (result.status !== status) {
			throw new WbTaskError(
				WB_ERROR_CODE.taskStateInvalid,
				`The queue already recorded ${result.status}; refusing to write a conflicting ${status} receipt`,
			);
		}
	} finally {
		queue.close();
	}
}

/**
 * Records that this round's durable commit failed, without releasing anything.
 *
 * Called when the receipt cannot be written at all: the queue row must read
 * `failed`/`recovery_required` so recovery and diagnostics see the truth, while the
 * hold and scope stay in place because an unproven write is not evidence that the
 * resources are free.
 */
function recordCommitFailure(task: ActiveTask, reason: string): void {
	try {
		const queue = openProjectQueue(task.receipt.projectRoot, { mode: "write" });
		if (queue === null) {
			return;
		}
		try {
			queue.commitFailed({
				taskId: task.taskId,
				round: currentRound(task.receipt).number,
				errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: reason }),
				now: Date.now(),
			});
		} finally {
			queue.close();
		}
	} catch {
		// Best effort: the failure is already visible through `task.storageError`, and a
		// queue that cannot record it must not replace the original error.
	}
}

/**
 * Confirms a durable commit in the queue, or records why it could not be.
 *
 * Split out so the terminal path reads as one sentence: write the receipt, confirm
 * it, then release. Returns false when the caller must not proceed to release.
 */
async function confirmDurableCommit(task: ActiveTask, receiptSha256: string): Promise<boolean> {
	const durable = task.durable;
	const round = currentRound(task.receipt);
	const result = await commitDurableRound({
		projectRoot: task.receipt.projectRoot,
		taskId: task.taskId,
		round: round.number,
		requestId: durable.requestId,
		status: round.status as "completed" | "failed" | "cancelled" | "interrupted",
		error: round.error,
		receiptSha256,
	});
	if (!result.committed) {
		task.storageError = taskError(WB_ERROR_CODE.storageError, result.reason ?? "the receipt could not be confirmed");
		return false;
	}
	return true;
}

/**
 * Builds the round receipt from what staging actually produced.
 *
 * Every field comes from a real value: the payload staging froze (which carries the
 * task, round, goal and input snapshots), the confirmation the human gave, and the
 * resolved round directory. Nothing here is defaulted, because the v3 parser is
 * strict about these fields precisely so a receipt cannot describe a round that was
 * never staged.
 */
function buildReceiptForStage(input: {
	projectRoot: string;
	taskId: string;
	sessionId: string;
	round: number;
	request: TaskRequest;
	confirmation: RoundConfirmationV3;
	staged: StagedTask;
	outputsDir: string;
}): TaskReceiptV3 {
	const payload = input.staged.manifest.payload;
	return {
		version: 3,
		taskId: input.taskId,
		sessionId: input.sessionId,
		projectRoot: input.projectRoot,
		rounds: [
			{
				number: input.round,
				layout: "round",
				goal: payload.goal,
				inputFiles: payload.inputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
				expectedOutputs: payload.expectedOutputs,
				status: "running",
				summary: "",
				error: null,
				artifacts: [],
				recordKind: "approved",
				requestId: input.confirmation.requestId,
				targetPolicy: payload.targetPolicy,
				snapshotRoot: input.staged.snapshotRoot,
				owner: payload.owner,
				manifestSha256: input.staged.manifestSha256,
				commitToken: null,
				turns: [],
				consent: { source: input.confirmation.source, at: input.confirmation.at },
			},
		],
	};
}

/** Builds a tool result that reports failure to the model. */
function failureResult(message: string, code: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `${code}: ${message}` }],
		details: { error: { code, message } },
		isError: true,
	};
}

/** Reads the `WB_*` code from an error, falling back to a generic failure code. */
function codeOf(error: unknown): string {
	if (error instanceof WbTaskError) {
		return error.code;
	}
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		if (error.code.startsWith("WB_")) {
			return error.code;
		}
	}
	return "WB_TASK_FAILED";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Formats one candidate for display in a selection list. */
function describeCandidate(candidate: DesktopCandidate): string {
	return `${candidate.binding.sessionId} — ${candidate.binding.projectRoot} — ${candidate.endpoint} — ${
		candidate.busy ? "busy" : "idle"
	}`;
}

/**
 * Every round row the queue holds, read in pages.
 *
 * `inspect` caps at 200 rows and orders by `enqueued_at`, so a single call silently
 * truncates a long project to its oldest rounds: a listing would then hide the newest
 * task and a claim peek would not see the round it is about to claim. Paging keeps the
 * caller's view complete, and the hard page bound keeps a pathological project from
 * pinning the event loop.
 */
function readAllQueuedRounds(queue: ReturnType<typeof openProjectQueue>): Array<Record<string, unknown>> {
	if (queue === null) {
		return [];
	}
	const pageSize = 200;
	const all: Array<Record<string, unknown>> = [];
	for (let page = 0; page < 50; page += 1) {
		const rows = queue.inspect({ limit: pageSize, offset: page * pageSize }).tasks;
		all.push(...rows);
		if (rows.length < pageSize) {
			return all;
		}
	}
	return all;
}

/**
 * The queue's own answer for a task's commit state, when the queue knows the task.
 *
 * Reading a task back from disk cannot prove a queue-backed commit: the receipt is
 * written before the queue confirms it. Returning `undefined` means the queue has
 * nothing to say (pre-queue history), and the caller keeps its default.
 */
function queueCommitState(projectRoot: string, taskId: string): TaskView["commitState"] | undefined {
	try {
		const queue = openProjectQueue(projectRoot, { mode: "read" });
		if (queue === null) {
			return undefined;
		}
		try {
			const rows = queue.inspect({ taskId }).tasks;
			const newest = rows.reduce<Record<string, unknown> | null>(
				(current, row) => (current === null || Number(row["round"]) > Number(current["round"]) ? row : current),
				null,
			);
			if (newest === null) {
				return undefined;
			}
			const state = String(newest["commit_state"]);
			return state === "committed" ? "committed" : state === "failed" ? "failed" : "pending";
		} finally {
			queue.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * Projects a receipt (optionally with this process's live task) onto the public
 * task view.
 *
 * The view is deliberately narrower than the receipt so that the prompt and the
 * input snapshot list can never leak into tool details. Field-by-field copying
 * is what enforces that; spreading the receipt would not.
 */
function toTaskView(
	receipt: TaskReceipt,
	task?: ActiveTask,
	/** Proven commit state for a task read back from disk, where no live promise exists. */
	diskCommitState?: TaskView["commitState"],
): TaskView {
	const live = task !== undefined;
	const current = currentRound(receipt);
	const awaitingApproval = live ? task.awaitingApproval : current.status === "awaiting_approval";
	const isTerm = receiptIsTerminal(receipt);
	const status: TaskStatus = !isTerm && awaitingApproval ? "awaiting_approval" : current.status;
	// Only a live task can prove its commit landed: it holds the promise the durable
	// commit resolves. A task read back from disk is a *receipt*, and a receipt exists
	// only because something was written — but for a queue-backed round the receipt is
	// written before the queue confirms it, so "a receipt file exists" is not proof.
	// Reporting `committed` for every read-back would therefore tell a caller that work
	// is safe to act on when its commit never landed.
	const commitState: TaskView["commitState"] = live
		? task.storageError !== null
			? "failed"
			: isTerm && task.commitSettled
				? "committed"
				: "pending"
		: (diskCommitState ?? "pending");
	return {
		taskId: receipt.taskId,
		sessionId: receipt.sessionId,
		round: current.number,
		status,
		summary: live ? task.summary.trim() : current.summary,
		artifacts: [...current.artifacts],
		error: current.error,
		progress: live ? task.progress : "",
		awaitingApproval,
		ownedByCurrentProcess: live,
		commitState,
		readyForReview: status === "completed" && commitState === "committed",
		storageError: live ? task.storageError : null,
		// A live task is running or terminal, so it is never waiting: the queue
		// is the only authority on a wait, and it is read where a wait exists.
		waitReason: null,
		blockerIds: [],
		sessionBlockers: [],
	};
}

/**
 * The exact subject of one quarantine release.
 *
 * It is the queue's own frozen view of the round: the original owner, the
 * attempt, the committed receipt digest and the revision. The human is asked
 * about *this*, and the release transaction checks that the round still is
 * this.
 */
interface ReleaseSubject extends RecoverySubject {
	/** The original owner's registered process id. */
	ownerProcessId: number;
	/**
	 * The proof that the original owner is gone, or `null` when the operator
	 * is that owner's own live successor.
	 */
	deathProof: OwnerDeathProof | null;
}

/**
 * Freezes the subject of a quarantine release.
 *
 * Read in its own scope and closed before any dialog: a cached facade must
 * never be held across a human question. The death proof is taken fresh, so a
 * release by a different operator only proceeds while the original owner is
 * provably gone.
 */
function readReleaseSubject(
	projectRoot: string,
	operator: OwnerIdentity,
	taskId: string,
	round: number,
	sessionId: string,
): ReleaseSubject | null {
	const queue = openProjectQueue(projectRoot, { mode: "read" });
	if (queue === null) {
		return null;
	}
	try {
		const row = queue.inspect({ taskId }).tasks.find((candidate) => Number(candidate["round"]) === round);
		if (row === undefined) {
			return null;
		}
		const subject = queue.recoverySubject(taskId, round);
		if (subject === null) {
			return null;
		}
		if (subject.sessionId !== sessionId) {
			// The hold names a session the round did not run on: this is not
			// the round the operator is being asked about.
			return null;
		}
		const receiptSha256 = row["receipt_sha256"];
		if (typeof receiptSha256 !== "string" || receiptSha256.length === 0) {
			// A release needs a committed, digest-confirmed receipt.
			return null;
		}
		// The subject names the committed receipt digest: the release is about
		// the receipt that is on disk, not about a round in general.
		const frozen: RecoverySubject = { ...subject, receiptSha256 };
		// The original owner may be released for by a different operator only
		// while that owner is provably gone. The comparison is by *session*: a
		// later generation of the same originating session is its legal
		// successor and releases its own round through the ordinary path.
		let deathProof: OwnerDeathProof | null = null;
		const sameOwner = subject.ownerSession === operator.sessionId;
		if (!sameOwner) {
			const death = queue.proveOwnerDead(
				{ sessionId: subject.ownerSession, generation: subject.ownerGeneration, instanceId: subject.executorInstance },
				Date.now(),
			);
			if (!death.ok) {
				return null;
			}
			deathProof = death.proof;
		}
		return {
			...frozen,
			ownerProcessId: deathProof?.processId ?? 0,
			deathProof,
		};
	} finally {
		queue.close();
	}
}

/** A queued round exists before its terminal receipt; the queue is its source. */
function queuedTaskView(projectRoot: string, taskId: string, owner: OwnerIdentity): TaskView | null {
	const queue = openProjectQueue(projectRoot, { mode: "read" });
	if (queue === null) {
		return null;
	}
	try {
		const row = queue.inspect({ taskId }).tasks.find((candidate) => candidate["status"] === "queued");
		if (row === undefined || row["dispatch_state"] !== "not_sent" || row["outcome_json"] !== null) {
			return null;
		}
		const target: unknown = JSON.parse(String(row["target_policy_json"]));
		if (target === null || typeof target !== "object") {
			throw new WbTaskError(WB_ERROR_CODE.taskStateInvalid, "The queued task has no verified target policy");
		}
		// A queued round has no session yet unless the queue already selected one:
		// a pool round names the pool, and the concrete session is chosen when the
		// round is claimed. Reporting the project's default session here would
		// claim a target the round does not have.
		const selected = typeof row["selected_session"] === "string" ? row["selected_session"] : "";
		const targetRecord = target as Record<string, unknown>;
		const sessionId =
			selected !== ""
				? selected
				: targetRecord["kind"] === "session" && typeof targetRecord["sessionId"] === "string"
					? targetRecord["sessionId"]
					: "";
		const round = Number(row["round"]);
		// The wait is read from the queue's own facts, so the status a caller
		// reads names the same reason the claim recorded and the same sessions
		// that block it. It is derived, never stored: a stored reason would be a
		// second truth that could disagree with the roster.
		const wait = queue.waitState(taskId, round);
		return {
			taskId, sessionId, round, status: "queued",
			summary: "", artifacts: [], error: null,
			progress:
				wait.reason === null
					? sessionId === ""
						? "Queued; a WorkBuddy session will be chosen from this project's enrolled pool"
						: "Queued; no prompt has been sent"
					: `Queued; waiting because ${wait.reason}`,
			awaitingApproval: false,
			ownedByCurrentProcess: row["owner_session"] === owner.sessionId && row["owner_generation"] === owner.generation,
			commitState: "pending", readyForReview: false, storageError: null,
			waitReason: wait.reason,
			blockerIds: wait.blockerIds,
			sessionBlockers: wait.sessionBlockers,
		};
	} finally {
		queue.close();
	}
}

/**
 * The session a project's roster names as its default, or null.
 *
 * A round that was cancelled before it ever ran has no session of its own, and
 * its receipt still has to name one. The project's default enrolled session is
 * the honest answer: it is a session this project actually enrolled, and the
 * round was authorized to run against the roster it belongs to.
 */
async function defaultEnrolledSession(projectRoot: string): Promise<string | null> {
	const binding = await readBinding(projectRoot).catch(() => null);
	if (binding === null) {
		return null;
	}
	const roster = listBoundSessions(binding);
	if (roster.length === 0) {
		return null;
	}
	return roster[0]!.sessionId;
}

/**
 * The WorkBuddy session a task is pinned to, read from the queue's own record.
 *
 * The durable affinity is the authority on which conversation a task belongs
 * to: it is written when the round is claimed and survives a rollback, a
 * terminal release and a restart.
 */
function pinnedSessionOf(projectRoot: string, taskId: string): string | null {
	try {
		const queue = openProjectQueue(projectRoot, { mode: "read" });
		if (queue === null) {
			return null;
		}
		try {
			return queue.taskSession(taskId);
		} finally {
			queue.close();
		}
	} catch {
		return null;
	}
}

/** Formats a task view as a tool result. */
function taskResult(view: TaskView): AgentToolResult<TaskView> {
	const lines = [
		`Task ${view.taskId}: ${view.status} (round ${view.round})`,
		view.sessionId === "" ? undefined : `WorkBuddy session: ${view.sessionId}`,
		view.waitReason === null ? undefined : `Waiting: ${view.waitReason}`,
		// The sessions that block a pool wait are named, so a caller can act on
		// the one that matters instead of guessing which conversation is stuck.
		view.sessionBlockers.length === 0
			? undefined
			: `Blocked by: ${view.sessionBlockers
					.map((blocker) => `${blocker.sessionId} (${blocker.reason})`)
					.join(", ")}`,
		view.blockerIds.length === 0 || view.sessionBlockers.length > 0
			? undefined
			: `Blocked by: ${view.blockerIds.join(", ")}`,
		view.progress === "" ? undefined : `Progress: ${view.progress}`,
		view.error === null ? undefined : `Error: ${view.error.code} — ${view.error.message}`,
		view.storageError === null
			? undefined
			: `Storage error: ${view.storageError.code} — ${view.storageError.message}`,
		view.summary.trim() === "" ? undefined : `\n${view.summary.trim()}`,
		view.artifacts.length === 0
			? undefined
			: `\nArtifacts:\n${view.artifacts.map((a) => `- ${a.path} (${a.role}${a.sha256 ? `, sha256: ${a.sha256.slice(0, 8)}...` : ""})`).join("\n")}`,
	];
	return {
		content: [{ type: "text", text: lines.filter((line): line is string => line !== undefined).join("\n") }],
		details: view,
		isError: view.status === "failed" || view.status === "interrupted" || view.storageError !== null,
	};
}

/**
 * Waits for a signal to resolve, giving up after a bounded budget.
 *
 * @returns True when the signal resolved in time, false when the budget ran out.
 *   Never rejects, so a failed wait cannot mask the operation it supports.
 */
async function settlesWithin(signal: Promise<void>, budgetMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const budget = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), budgetMs);
	});
	try {
		return await Promise.race([signal.then(() => true), budget]);
	} finally {
		clearTimeout(timer);
	}
}

/** Waits for a task to settle, or for the caller's budget to run out. */
async function waitForSettle(settled: Promise<void>, waitMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted === true) {
		return;
	}
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const budget = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, waitMs);
	});
	const aborted = new Promise<void>((resolve) => {
		onAbort = resolve;
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([settled, budget, aborted]);
	} finally {
		clearTimeout(timer);
		// The listener is removed on every outcome: a status call that returns
		// early must not leave a listener attached to a long-lived session signal.
		if (onAbort !== undefined) {
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
