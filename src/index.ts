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
import { realpath } from "node:fs/promises";
import { connect, discover, inspectWorkers, type DesktopSession } from "./desktop-client";
import {
	collectArtifacts,
	isPidAlive,
	prepareTask,
	readBinding,
	readTask,
	readTaskIndex,
	readTaskLock,
	releaseTask,
	WbTaskError,
	writeBinding,
	writeTask,
} from "./tasks";
import {
	type Binding,
	type DesktopCallbacks,
	type DesktopCandidate,
	type DesktopSessionUpdate,
	type TaskError,
	type TaskReceipt,
	type StoredTaskSummary,
	type TaskListWarning,
	type TaskLock,
	type TaskStatus,
	type TaskView,
	type WorkerInspection,
	WB_ERROR_CODE,
	taskError,
} from "./types";

/** Status key so concurrent tasks do not fight over the footer. */
const STATUS_KEY = "workbuddy";

/** Default `wb_status` poll window, in milliseconds. */
const DEFAULT_WAIT_MS = 1_000;

/** Upper bound a caller may request from `wb_status`. */
const MAX_WAIT_MS = 30_000;

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

/** Parameters accepted by the `wb_task` tool. */
interface WbTaskParams {
	prompt: string;
	inputFiles?: string[];
	expectedOutputs?: string[];
	taskId?: string;
}

/** Parameters accepted by the `wb_status` tool. */
interface WbStatusParams {
	taskId: string;
	waitMs?: number;
}

/** Parameters accepted by the `wb_cancel` tool. */
interface WbCancelParams {
	taskId: string;
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
	connect?: (
		binding: Binding,
		callbacks: DesktopCallbacks,
		signal: AbortSignal,
	) => Promise<DesktopSession>;
	prepareTask?: (
		binding: Binding,
		request: { prompt: string; inputFiles?: string[]; expectedOutputs?: string[]; taskId?: string },
	) => Promise<{ receipt: TaskReceipt; briefPath: string; outputsDir: string }>;
	readBinding?: (projectRoot: string) => Promise<Binding | null>;
	writeBinding?: (binding: Binding) => Promise<void>;
	readTask?: (projectRoot: string, taskId: string) => Promise<TaskReceipt>;
	writeTask?: (receipt: TaskReceipt) => Promise<void>;
	collectArtifacts?: (receipt: TaskReceipt) => Promise<{ artifacts: string[]; missingOutputs: string[] }>;
	releaseTask?: (projectRoot: string, taskId: string) => Promise<void>;
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
	const realDiscover = overrides.discover ?? discover;
	const realConnect = overrides.connect ?? connect;
	const realPrepareTask = overrides.prepareTask ?? prepareTask;
	const realReadBinding = overrides.readBinding ?? readBinding;
	const realWriteBinding = overrides.writeBinding ?? writeBinding;
	const realReadTask = overrides.readTask ?? readTask;
	const realWriteTask = overrides.writeTask ?? writeTask;
	const realCollectArtifacts = overrides.collectArtifacts ?? collectArtifacts;
	const realReleaseTask = overrides.releaseTask ?? releaseTask;
	const realReadTaskIndex = overrides.readTaskIndex ?? readTaskIndex;
	const realReadTaskLock = overrides.readTaskLock ?? readTaskLock;
	const realInspectWorkers = overrides.inspectWorkers ?? inspectWorkers;
	const cancelSettleMs = overrides.cancelSettleMs ?? CANCEL_SETTLE_MS;

	const setStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		const mine = [...tasks.values()];
		if (mine.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		// A task is only "running" while it genuinely is: a terminal state already
		// chosen (a commit in flight) is not work, and a retained task whose commit
		// failed is reported as a storage problem instead.
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
			// Nothing is running here; a task in the map is mid-commit.
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `WorkBuddy: ${parts.join(", ")}`);
	};

	pi.on("session_shutdown", async () => {
		const mine = [...tasks.values()];
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
	});

	pi.registerCommand("wb", {
		description: "Bind this project to a WorkBuddy desktop session, or show binding status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim().split(/\s+/)[0] ?? "";
			if (subcommand === "bind") {
				await runBind(ctx);
				return;
			}
			if (subcommand === "" || subcommand === "status") {
				await runStatus(ctx);
				return;
			}
			ctx.ui.notify(`Unknown /wb subcommand: ${subcommand}. Use /wb bind or /wb status.`, "warning");
		},
	});

	pi.registerTool({
		name: "wb_task",
		label: "WorkBuddy Task",
		description:
			"Delegate one self-contained task (research, office documents, design) to the project's dedicated WorkBuddy desktop session. Returns immediately with a taskId; poll it with wb_status. Declare deliverables in expectedOutputs.",
		parameters: pi.zod.object({
			prompt: pi.zod.string().describe("The instruction for WorkBuddy, stating the objective concretely"),
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
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await runTask(ctx, signal, params as WbTaskParams);
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
		status: TaskReceipt["status"],
		error: TaskReceipt["error"],
		options: { cancelWorker?: boolean; collectArtifacts?: boolean } = {},
	): Promise<void> {
		const existing = task.finalization;
		if (existing !== null) {
			// A terminal state is already chosen; every later path only observes it.
			return existing;
		}

		// A waiter that has been parked since before this commit can only see a
		// still-null `finalization`, so it is released here and re-reads the state.
		task.markCommitted();

		// Everything below runs with no `await` in between, so the state observed
		// here is the state the commit works from.
		task.receipt.status = status;
		task.receipt.error = error;
		task.receipt.summary = task.summary.trim();
		task.awaitingApproval = false;
		// Dialogs may still be open; they are told to end and cannot re-set the flag.
		task.pendingApprovals.clear();
		setStatus(task.ctx);

		const finalization = (async () => {
			// The whole commit is guarded so this promise never rejects: it is
			// awaited by the turn, by tool calls and by shutdown, and an escaping
			// rejection would surface as an unhandled error rather than a result.
			try {
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
					// Whatever WorkBuddy already wrote stays with the task; a failed scan
					// keeps the previous list rather than discarding real files.
					const collected = await realCollectArtifacts(task.receipt).catch(() => null);
					if (collected !== null) {
						task.receipt.artifacts = collected.artifacts;
					}
				}

				// A shallow snapshot is what gets committed, so the bytes on disk are
				// exactly the state decided here rather than whatever the receipt looks
				// like by the time the write lands.
				const snapshot: TaskReceipt = { ...task.receipt, artifacts: [...task.receipt.artifacts] };

				try {
					await realWriteTask(snapshot);
				} catch (err: unknown) {
					// Nothing was committed, so the lock stays: releasing it would let the
					// next task start beside a receipt that still looks alive.
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					reportStorageFailure(pi, task, "receipt write");
					return;
				}

				try {
					await realReleaseTask(task.receipt.projectRoot, task.taskId);
				} catch (err: unknown) {
					// The terminal receipt is durable; only the slot is still held.
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					reportStorageFailure(pi, task, "lock release");
					return;
				}

				tasks.delete(task.taskId);
			} catch (err: unknown) {
				// Reaching here means the commit itself failed unexpectedly; the task
				// stays in the map with the failure recorded rather than vanishing.
				task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
				reportStorageFailure(pi, task, "terminal commit");
			} finally {
				// The footer is refreshed on every outcome: a retained task must read as
				// a storage problem, never as still running.
				setStatus(task.ctx);
			}
		})().finally(async () => {
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

	async function runBind(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Binding needs an interactive OMP session.", "error");
			return;
		}
		const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
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
		const labels = candidates.map(describeCandidate);
		const picked = await ctx.ui.select("Bind this project to a WorkBuddy session", labels);
		if (picked === undefined) {
			ctx.ui.notify("Binding unchanged.", "info");
			return;
		}
		const candidate = candidates[labels.indexOf(picked)];
		if (candidate === undefined) {
			ctx.ui.notify("Binding unchanged: the selection did not match a session.", "warning");
			return;
		}
		if (previous !== null && previous.sessionId === candidate.binding.sessionId) {
			ctx.ui.notify(`Already bound to ${previous.sessionId}.`, "info");
			return;
		}
		if (previous !== null) {
			const confirmed = await ctx.ui.confirm(
				"Replace the existing binding?",
				`Old session: ${previous.sessionId}\nNew session: ${candidate.binding.sessionId}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Binding unchanged.", "info");
				return;
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

		await realWriteBinding({
			version: 1,
			projectRoot,
			sessionId: candidate.binding.sessionId,
			workbuddyVersion: candidate.binding.workbuddyVersion,
		});
		ctx.ui.notify(
			`Bound ${projectRoot} to WorkBuddy session ${candidate.binding.sessionId} (${candidate.endpoint}).`,
			"info",
		);
	}

	async function runStatus(ctx: ExtensionCommandContext): Promise<void> {
		const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
		const lines: string[] = [];
		const binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			lines.push(`No binding for ${projectRoot}. Run /wb bind.`);
		} else {
			lines.push(`Bound session: ${binding.sessionId} (WorkBuddy ${binding.workbuddyVersion})`);
			try {
				const candidates = await realDiscover(projectRoot, new AbortController().signal);
				const match = candidates.find((entry) => entry.binding.sessionId === binding.sessionId);
				lines.push(
					match === undefined
						? "Worker: not running for this session."
						: `Worker: ${match.endpoint} (${match.busy ? "busy" : "idle"})`,
				);
			} catch (error) {
				lines.push(`Worker: probe failed (${messageOf(error)}).`);
			}
		}
		const mine = [...tasks.values()];
		lines.push(
			mine.length === 0
				? "Active tasks in this OMP session: none."
				: `Active tasks in this OMP session: ${mine
						.map((task) => `${task.taskId} (${task.receipt.status})`)
						.join(", ")}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	/** Resolves the project's binding, refusing to work from an unbound folder. */
	async function requireBinding(
		ctx: ExtensionContext,
	): Promise<{ binding: Binding; projectRoot: string } | { failure: AgentToolResult<unknown> }> {
		const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
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
		return { binding, projectRoot };
	}

	async function runTask(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		params: WbTaskParams,
	): Promise<AgentToolResult<unknown>> {
		const resolved = await requireBinding(ctx);
		if ("failure" in resolved) {
			return resolved.failure;
		}
		const { binding, projectRoot } = resolved;

		let prepared;
		try {
			prepared = await realPrepareTask(binding, params);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}
		const { receipt } = prepared;

		// The turn outlives this tool call, so its lifetime follows the session;
		// the caller's own signal still stops it.
		const abort = new AbortController();
		if (signal?.aborted === true) {
			abort.abort();
		} else {
			signal?.addEventListener("abort", () => abort.abort(), { once: true });
		}

		// The commit signal exists from construction so a waiter that parks before
		// any terminal state is chosen is still released, and it never rejects.
		let markCommitted!: () => void;
		const committed = new Promise<void>((resolve) => {
			markCommitted = resolve;
		});

		// The turn-ended signal also exists from construction: a cancellation that
		// lands before the turn even starts still needs something to wait on.
		let markTurnEnded!: () => void;
		const turnEnded = new Promise<void>((resolve) => {
			markTurnEnded = resolve;
		});

		// The task is tracked from before its connection exists, so an update that
		// arrives during the handshake, a cancellation and a shutdown all find it.
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
			storageError: null,
			summary: "",
			progress: "",
			approvalDecisions: new Map(),
			pendingApprovals: new Set(),
			awaitingApproval: false,
		};
		tasks.set(receipt.taskId, task);
		setStatus(ctx);

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
			// No turn ever started, so nothing can be waited on: a cancellation must
			// release the connection immediately rather than spend the settle budget.
			task.markTurnEnded();
			// Nothing was delivered, so the task must not be left looking alive. The
			// view carries the taskId so the caller can still find the failed task,
			// and it reports its own failure semantics (a cancellation that raced
			// the handshake stays a cancellation, not a failure).
			await finalizeTask(task, "failed", taskError(codeOf(error), messageOf(error)));
			return taskResult(toTaskView(task.receipt, task));
		}

		// A cancellation or shutdown may have finished while the handshake was in
		// flight; the late connection is then closed without ever sending a prompt.
		if (task.finalization !== null || abort.signal.aborted) {
			task.markTurnEnded();
			await session.close().catch(() => undefined);
			await finalizeTask(
				task,
				"interrupted",
				taskError(WB_ERROR_CODE.interrupted, "Task ended before its session was ready"),
			);
			return taskResult(toTaskView(task.receipt, task));
		}
		task.session = session;
		task.settled = runTurn(task, prepared.briefPath);

		return {
			content: [
				{
					type: "text",
					text: [
						`Delegated to WorkBuddy as task ${receipt.taskId}.`,
						`Poll with wb_status({ taskId: "${receipt.taskId}" }).`,
						`WorkBuddy writes deliverables to ${prepared.outputsDir}.`,
					].join("\n"),
				},
			],
			details: {
				taskId: receipt.taskId,
				status: receipt.status,
				briefPath: prepared.briefPath,
				outputsDir: prepared.outputsDir,
			},
		};
	}

	/** Drives one turn to its terminal state. */
	async function runTurn(task: ActiveTask, prompt: string): Promise<void> {
		let outcome: { stopReason: string; errorMessage?: string };
		try {
			const session = task.session;
			if (session === null) {
				throw new WbTaskError(WB_ERROR_CODE.sessionNotRunning, "Task has no attached session");
			}
			outcome = await session.prompt(prompt);
		} catch (error) {
			// The turn is over (its stream died), so a cancellation waiting on it can
			// release the connection. Marked before the commit: the commit may await
			// other work, and the wait exists to let the worker finish, not to wait
			// for our own bookkeeping.
			task.markTurnEnded();
			// A stream that dies mid-turn leaves WorkBuddy's real work intact, so the
			// partial reply and any files already written are kept. A commit that
			// already started wins: this only waits for it.
			await finalizeTask(
				task,
				"interrupted",
				taskError(WB_ERROR_CODE.interrupted, messageOf(error)),
				{ collectArtifacts: true },
			);
			return;
		}
		// The prompt call returned, so the worker reported the turn's outcome.
		task.markTurnEnded();

		if (task.finalization !== null) {
			// A cancellation, second terminal path or shutdown already chose the
			// outcome; the turn is only observed from here on.
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

		// The deliverables are scanned before success is claimed, because a missing
		// expected output is a failure even when the turn ended cleanly.
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
			// The scan is async, so a cancellation may have landed meanwhile; it owns
			// the outcome and the artifacts it snapshotted.
			await task.finalization;
			return;
		}
		task.receipt.artifacts = collected.artifacts;
		if (collected.missingOutputs.length > 0) {
			await finalizeTask(
				task,
				"failed",
				taskError(
					WB_ERROR_CODE.outputMissing,
					`WorkBuddy finished but these expected outputs are missing: ${collected.missingOutputs.join(", ")}`,
				),
			);
			return;
		}
		await finalizeTask(task, "completed", null);
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
		const waitMs = Math.min(Math.max(params.waitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
		const task = tasks.get(params.taskId);
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
				await waitForSettle(Promise.race([task.settled, task.committed]), waitMs, signal);
			}
			return taskResult(toTaskView(task.receipt, task));
		}

		// Not owned here: a finished task from an earlier OMP session is readable,
		// but a task that was still running belongs to a process that is gone.
		const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
		let receipt: TaskReceipt;
		try {
			receipt = await realReadTask(projectRoot, params.taskId);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}
		return taskResult(toTaskView(receipt));
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
			const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
			let receipt: TaskReceipt;
			try {
				receipt = await realReadTask(projectRoot, params.taskId);
			} catch (error) {
				return failureResult(messageOf(error), codeOf(error));
			}
			if (receipt.status === "running" || receipt.status === "awaiting_approval") {
				return failureResult(
					`Task ${params.taskId} is still running but is not owned by this OMP process. Refusing to cancel it.`,
					WB_ERROR_CODE.busy,
				);
			}
			return taskResult(toTaskView(receipt));
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
		let projectRoot: string;
		try {
			projectRoot = await realpath(ctx.cwd);
		} catch (err: unknown) {
			return failureResult(
				`Cannot diagnose ${ctx.cwd}: the project root could not be resolved (${messageOf(err)})`,
				WB_ERROR_CODE.storageError,
			);
		}
		const issues: DiagnosticIssue[] = [];

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
		const lines = [
			`WorkBuddy diagnosis for ${projectRoot}:`,
			binding === null
				? "Binding: none or unusable."
				: `Binding: session ${binding.sessionId} (WorkBuddy ${binding.workbuddyVersion}).`,
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
		];

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			isError: failed,
			details: {
				projectRoot,
				binding:
					binding === null
						? null
						: { sessionId: binding.sessionId, workbuddyVersion: binding.workbuddyVersion },
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
		let projectRoot: string;
		try {
			projectRoot = await realpath(ctx.cwd);
		} catch (err: unknown) {
			return failureResult(
				`Cannot list tasks for ${ctx.cwd}: the project root could not be resolved (${messageOf(err)})`,
				WB_ERROR_CODE.storageError,
			);
		}
		let index: { entries: StoredTaskSummary[]; warnings: TaskListWarning[] };
		try {
			index = await realReadTaskIndex(projectRoot);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}

		// Only this project's live tasks are merged in; other projects' tasks in
		// this process are never reported as belonging here.
		const rows: Array<
			StoredTaskSummary & { ownedByCurrentProcess: boolean; storageError: TaskError | null }
		> = [];
		for (const entry of index.entries) {
			const live = tasks.get(entry.taskId);
			const mine = live !== undefined && live.receipt.projectRoot === projectRoot;
			rows.push({
				taskId: entry.taskId,
				sessionId: mine ? live.receipt.sessionId : entry.sessionId,
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

/** True when a receipt has already reached a state that must not be rewritten. */
function receiptIsTerminal(receipt: TaskReceipt): boolean {
	return (
		receipt.status === "completed" ||
		receipt.status === "cancelled" ||
		receipt.status === "failed" ||
		receipt.status === "interrupted"
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
 * Projects a receipt (optionally with this process's live task) onto the public
 * task view.
 *
 * The view is deliberately narrower than the receipt so that the prompt and the
 * input snapshot list can never leak into tool details. Field-by-field copying
 * is what enforces that; spreading the receipt would not.
 */
function toTaskView(receipt: TaskReceipt, task?: ActiveTask): TaskView {
	const live = task !== undefined;
	const awaitingApproval = live ? task.awaitingApproval : receipt.status === "awaiting_approval";
	// A live task that is waiting for a human is reported in the same
	// `awaiting_approval` state the receipt format already uses, so callers do not
	// need a second field to tell "working" from "blocked on a decision". A
	// terminal state always wins: a decided task is not waiting for anything.
	const status: TaskStatus =
		!receiptIsTerminal(receipt) && awaitingApproval ? "awaiting_approval" : receipt.status;
	return {
		taskId: receipt.taskId,
		sessionId: receipt.sessionId,
		status,
		summary: live ? task.summary.trim() : receipt.summary,
		artifacts: [...receipt.artifacts],
		error: receipt.error,
		progress: live ? task.progress : "",
		// Only the live view can say whether somebody is being asked right now; a
		// stored snapshot only records that the task was waiting when it was written.
		awaitingApproval,
		ownedByCurrentProcess: live,
		storageError: live ? task.storageError : null,
	};
}

/** Formats a task view as a tool result. */
function taskResult(view: TaskView): AgentToolResult<TaskView> {
	const lines = [
		`Task ${view.taskId}: ${view.status}`,
		view.sessionId === "" ? undefined : `WorkBuddy session: ${view.sessionId}`,
		view.progress === "" ? undefined : `Progress: ${view.progress}`,
		view.error === null ? undefined : `Error: ${view.error.code} — ${view.error.message}`,
		view.storageError === null
			? undefined
			: `Storage error: ${view.storageError.code} — ${view.storageError.message}`,
		view.summary.trim() === "" ? undefined : `\n${view.summary.trim()}`,
		view.artifacts.length === 0
			? undefined
			: `\nArtifacts:\n${view.artifacts.map((artifact) => `- ${artifact}`).join("\n")}`,
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
