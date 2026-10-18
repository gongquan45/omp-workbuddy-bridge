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
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { connect, discover, inspectWorkers, type DesktopSession } from "./desktop-client";
import { atomicWriteFile } from "./storage";
import { enableProject, readProjectAccess, type ProjectAccess } from "./queue";
import { migrateProjectToQueue } from "./migration";
import {
	collectArtifacts,
	computeFileSha256,
	currentRound,
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
	claimWork,
	publishWork,
	readAllWorkRecords,
	readWorkRecord,
	releaseWork,
	withCollaborationLock,
	writeWorkRecord,
	type ScopeDefinition,
} from "./collaboration";
import {
	type Binding,
	type DesktopCallbacks,
	type DesktopCandidate,
	type DesktopSessionUpdate,
	type FileArtifact,
	type PreparedTask,
	type RoundConfirmation,
	type StoredTaskSummary,
	type TaskError,
	type TaskGoal,
	type TaskListWarning,
	type TaskLock,
	type TaskReceipt,
	type TaskRequest,
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
type WbTaskParams = TaskRequest;

interface FrozenDraft {
	requestId: string;
	projectRoot: string;
	sessionId: string;
	previousRound: number;
	taskId?: string;
	goal: TaskGoal;
	inputFiles: Array<{ path: string; sha256: string }>;
	expectedOutputs: string[];
	rawRequest: TaskRequest;
	createdAt: string;
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
	prepareTask?: (
		binding: Binding,
		request: TaskRequest,
		confirmation: RoundConfirmation,
	) => Promise<PreparedTask>;
	readBinding?: (projectRoot: string) => Promise<Binding | null>;
	writeBinding?: (binding: Binding) => Promise<void>;
	readTask?: (projectRoot: string, taskId: string) => Promise<TaskReceipt>;
	writeTask?: (receipt: TaskReceipt) => Promise<void>;
	collectArtifacts?: (receipt: TaskReceipt) => Promise<{ artifacts: FileArtifact[]; missingOutputs: string[] }>;
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
	migrateProject?: (projectRoot: string) => Promise<string>;
	readProjectAccess?: (projectRoot: string) => Promise<ProjectAccess | null>;
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
	turnConfirmedEnd?: boolean;
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
	const realMigrateProject = overrides.migrateProject ?? migrateProjectToQueue;
	const realReadProjectAccess = overrides.readProjectAccess ?? readProjectAccess;
	const realEnableProject = overrides.enableProject ?? enableProject;
	const realWhichBun =
		overrides.whichBun ??
		((cmd: string) => (typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which(cmd) : null));

	let currentDraft: FrozenDraft | null = null;

	const setStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		const mine = [...tasks.values()];
		if (mine.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
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

	pi.on("session_switch", async () => {
		currentDraft = null;
	});

	let lastGoalSync: { id: string; status: string; objective: string } | null = null;

	pi.on("goal_updated", async (event: unknown) => {
		try {
			if (typeof event !== "object" || event === null || !("goal" in event)) {
				return;
			}
			const rawGoal = (event as { goal: unknown }).goal;
			if (typeof rawGoal !== "object" || rawGoal === null) {
				return;
			}
			const goal = rawGoal as { id: string; status: string; objective: string };
			if (
				lastGoalSync &&
				lastGoalSync.id === goal.id &&
				lastGoalSync.status === goal.status &&
				lastGoalSync.objective === goal.objective
			) {
				return;
			}
			lastGoalSync = { id: goal.id, status: goal.status, objective: goal.objective };

			const projectRoot = await realpath(process.cwd()).catch(() => process.cwd());
			const sm = (pi as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
			const sessionId = sm?.getSessionId?.() ?? "omp-session";
			const nativeRef = { sessionId, goalId: goal.id };

			if (goal.status === "complete" || goal.status === "dropped") {
				const records = await readAllWorkRecords(projectRoot);
				const existing = records.find(
					(r) => r.nativeRef?.sessionId === sessionId && r.nativeRef?.goalId === goal.id && r.state !== "released"
				);
				if (existing) {
					await releaseWork(projectRoot, existing.workId);
				}
			} else {
				const records = await readAllWorkRecords(projectRoot);
				const existing = records.find(
					(r) => r.nativeRef?.sessionId === sessionId && r.nativeRef?.goalId === goal.id && r.state !== "released"
				);
				if (existing) {
					const state = goal.status === "paused" || goal.status === "budget-limited" ? "blocked" : "active";
					await publishWork(projectRoot, "omp", {
						workId: existing.workId,
						expectedRevision: existing.revision,
						progress: {
							state,
							phase: "goal_updated",
							milestone: goal.objective.slice(0, 240),
							blocker: goal.status === "paused" || goal.status === "budget-limited" ? goal.status : "",
						},
					});
				} else {
					await claimWork(projectRoot, "omp", {
						title: goal.objective.slice(0, 160),
						scope: { readPaths: [], writePaths: [] },
						nativeRef,
					});
				}
			}
		} catch {
			// Best effort: progress sync must never break the agent loop.
		}
	});

	pi.on("tool_result", async (event: unknown) => {
		try {
			if (typeof event !== "object" || event === null) {
				return;
			}
			const ev = event as { toolName?: unknown; isError?: unknown; input?: unknown };
			if (ev.toolName !== "todo" || ev.isError === true) {
				return;
			}
			const input = ev.input as Record<string, unknown> | undefined;
			if (!input || typeof input.op !== "string") {
				return;
			}
			const op = input.op;
			const taskText = typeof input.task === "string" ? input.task : "";
			const phaseText = typeof input.phase === "string" ? input.phase : "todo";

			const projectRoot = await realpath(process.cwd()).catch(() => process.cwd());
			const sm = (pi as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
			const sessionId = sm?.getSessionId?.() ?? "omp-session";

			const records = await readAllWorkRecords(projectRoot);
			const existing = records.find(
				(r) => r.owner === "omp" && r.nativeRef?.sessionId === sessionId && r.state !== "released"
			);
			if (existing) {
				await publishWork(projectRoot, "omp", {
					workId: existing.workId,
					expectedRevision: existing.revision,
					progress: {
						state: existing.state === "blocked" ? "blocked" : "active",
						phase: phaseText.slice(0, 160),
						milestone: `${op}: ${taskText}`.slice(0, 240),
						blocker: typeof input.reason === "string" ? input.reason.slice(0, 240) : "",
					},
				});
			}
		} catch {
			// Best effort
		}
	});

	pi.on("resources_discover", async () => {
		const extDir = path.dirname(__dirname);
		return {
			skillPaths: [
				path.join(extDir, "skills", "omp-wb-collaboration"),
				path.join(extDir, "skills", "workbuddy-delegate"),
			],
		};
	});
	pi.registerCommand("wb", {
		description: "WorkBuddy bridge management: init, bind, status, send, release, setup",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] ?? "";
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
				if (!currentDraft || currentDraft.requestId !== targetId || currentDraft.projectRoot !== projectRoot) {
					ctx.ui.notify(`No matching draft found for requestId "${targetId}" in this project.`, "warning");
					return;
				}
				const draft = currentDraft;
				currentDraft = null;

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

				const confirmation: RoundConfirmation = {
					source: "user_command",
					at: new Date().toISOString(),
					sessionId: draft.sessionId,
					previousRound: draft.previousRound,
					inputs: draft.inputFiles,
				};
				const binding = {
					version: 1 as const,
					projectRoot: draft.projectRoot,
					sessionId: draft.sessionId,
					workbuddyVersion: "5.8.2",
				};
				const result = await runConfirmedTask(ctx, binding, draft.rawRequest, confirmation, undefined);
				if (result.isError) {
					const firstContent = result.content[0];
					const errText = firstContent && "text" in firstContent && typeof firstContent.text === "string" ? firstContent.text : "error";
					ctx.ui.notify(`Task submission failed: ${errText}`, "error");
				} else {
					ctx.ui.notify(`Task submitted to WorkBuddy: ${draft.taskId ?? "new task"}`, "info");
				}
				return;
			}
			if (subcommand === "release") {
				const targetWorkId = parts[1] ?? "";
				if (!targetWorkId) {
					ctx.ui.notify("Usage: /wb release <workId>", "warning");
					return;
				}
				const projectRoot = await realpath(ctx.cwd).catch(() => ctx.cwd);
				if (tasks.has(targetWorkId)) {
					ctx.ui.notify(`Cannot release scope for task ${targetWorkId} currently active in this process`, "error");
					return;
				}
				try {
					const existingRec = await readWorkRecord(projectRoot, targetWorkId);
					if (existingRec === null) {
						const histReceipt = await realReadTask(projectRoot, targetWorkId).catch(() => null);
						if (histReceipt) {
							const histRound = currentRound(histReceipt);
							await publishWork(projectRoot, "omp", {
								workId: targetWorkId,
								expectedRevision: null,
								review: {
									round: histRound.number,
									artifacts: [],
									verdict: "unverified",
									note: "Historic task scope released by human command",
								},
								release: true,
							});
							ctx.ui.notify(`Released historic scope for ${targetWorkId}.`, "info");
							return;
						}
						ctx.ui.notify(`Work record ${targetWorkId} does not exist.`, "warning");
						return;
					}
					await releaseWork(projectRoot, targetWorkId);
					ctx.ui.notify(`Released collaboration scope for ${targetWorkId}.`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to release scope: ${messageOf(err)}`, "error");
				}
				return;
			}
			if (subcommand === "setup") {
				await runSetup(ctx);
				return;
			}
			ctx.ui.notify(`Unknown /wb subcommand: ${subcommand}. Use /wb init, /wb bind, /wb status, /wb send, /wb release, or /wb setup.`, "warning");
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
	});
	const taskParamsSchema = typeof taskParamsObj.strict === "function" ? taskParamsObj.strict() : taskParamsObj;

	pi.registerTool({
		name: "wb_task",
		label: "WorkBuddy Task",
		description:
			"Delegate one self-contained task (research, office documents, design) to the project's dedicated WorkBuddy desktop session. Returns immediately with a taskId; poll it with wb_status. Declare deliverables in expectedOutputs.",
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

		// A waiter that has been parked since before this commit can only see a
		// still-null `finalization`, so it is released here and re-reads the state.
		task.markCommitted();

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

				try {
					await realWriteTask(snapshot);
				} catch (err: unknown) {
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					reportStorageFailure(pi, task, "receipt write");
					return;
				}

				try {
					const isCleanEnd = status === "completed" || (task.turnConfirmedEnd === true && !options.cancelWorker);
					if (isCleanEnd) {
						await releaseWork(task.receipt.projectRoot, task.taskId).catch(() => null);
					} else {
						await withCollaborationLock(task.receipt.projectRoot, async () => {
							const existingRec = await readWorkRecord(task.receipt.projectRoot, task.taskId);
							// Only a record that already occupies scope may become
							// blocked: promoting a `waiting` record here would mint an
							// occupancy the round never held.
							if (
								existingRec &&
								(existingRec.state === "active" || existingRec.state === "blocked")
							) {
								existingRec.state = "blocked";
								existingRec.blocker = status;
								existingRec.updatedAt = new Date().toISOString();
								existingRec.revision += 1;
								await writeWorkRecord(existingRec);
							}
						}).catch(() => null);
					}
				} catch (err: unknown) {
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					reportStorageFailure(pi, task, "scope update");
					return;
				}

				try {
					await realReleaseTask(task.receipt.projectRoot, task.taskId);
				} catch (err: unknown) {
					task.storageError = taskError(WB_ERROR_CODE.storageError, messageOf(err));
					reportStorageFailure(pi, task, "lock release");
					return;
				}

				tasks.delete(task.taskId);
			} catch (err: unknown) {
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
		const resolved = await requireBinding(ctx);
		if ("failure" in resolved) {
			lines.push(`No binding for ${projectRoot}. Run /wb bind.`);
			lines.push("Queue: not enabled yet (run /wb init to create and import project state)");
		} else {
			const { binding, access } = resolved;
			lines.push(`Bound session: ${binding.sessionId} (WorkBuddy ${binding.workbuddyVersion})`);
			lines.push(
				access.enabled
					? "Queue: enabled"
					: "Queue: not enabled yet (run /wb init to create and import project state)",
			);
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
						.map((task) => `${task.taskId} (${currentRound(task.receipt).status})`)
						.join(", ")}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	/**
	 * Resolves the project's binding, refusing to work from an unbound folder.
	 * Binding and queue-access are two distinct facts; stage 4 will make `enabled` mandatory.
	 */
	async function requireBinding(
		ctx: ExtensionContext,
	): Promise<{ binding: Binding; projectRoot: string; access: ProjectAccess } | { failure: AgentToolResult<unknown> }> {
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
		const access = (await realReadProjectAccess(projectRoot)) ?? {
			projectRoot,
			enabled: false,
			migrated: false,
		};
		return { binding, projectRoot, access };
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
		if (params.taskId !== undefined) {
			let existingReceipt: TaskReceipt;
			try {
				existingReceipt = await realReadTask(projectRoot, params.taskId);
			} catch (error) {
				return failureResult(messageOf(error), codeOf(error));
			}
			const current = currentRound(existingReceipt);
			if (current.status === "running" || current.status === "awaiting_approval") {
				return failureResult(
					`Task ${params.taskId} is currently ${current.status}; supplementary work requires a terminal state`,
					WB_ERROR_CODE.busy,
				);
			}
			previousRound = existingReceipt.rounds.length;
		}

		// Validate and snapshot inputs
		const snapshottedInputs: Array<{ path: string; sha256: string }> = [];
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
					snapshottedInputs.push({ path: normalized, sha256: fileHash });
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

		const requestId = crypto.randomUUID();
		const draft: FrozenDraft = {
			requestId,
			projectRoot,
			sessionId: binding.sessionId,
			previousRound,
			taskId: params.taskId,
			goal,
			inputFiles: snapshottedInputs,
			expectedOutputs: validatedOutputs,
			rawRequest: { ...params, goal },
			createdAt: new Date().toISOString(),
		};
		currentDraft = draft;

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

		if (signal?.aborted || currentDraft?.requestId !== requestId || currentDraft?.projectRoot !== projectRoot) {
			currentDraft = null;
			return {
				content: [{ type: "text", text: "Delegation cancelled." }],
				details: { decision: "cancelled" },
				isError: false,
			};
		}

		if (targetChoice === "Keep in OMP") {
			currentDraft = null;
			return {
				content: [{ type: "text", text: "Task kept in OMP; not delegated to WorkBuddy." }],
				details: { decision: "keep_in_omp" },
				isError: false,
			};
		}

		if (targetChoice !== "Submit this round") {
			currentDraft = null;
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
				currentDraft?.requestId !== requestId ||
				extChoice !== "Approve these exact actions once"
			) {
				currentDraft = null;
				return failureResult(
					"External actions not approved by human; round will not be submitted",
					WB_ERROR_CODE.approvalUnsupported,
				);
			}
		}

		const confirmation: RoundConfirmation = {
			source: "host_dialog",
			at: new Date().toISOString(),
			sessionId: binding.sessionId,
			previousRound: draft.previousRound,
			inputs: draft.inputFiles,
		};
		currentDraft = null;

		return await runConfirmedTask(ctx, binding, draft.rawRequest, confirmation, signal);
	}

	async function runConfirmedTask(
		ctx: ExtensionContext,
		binding: Binding,
		request: TaskRequest,
		confirmation: RoundConfirmation,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<unknown>> {
		let prepared: PreparedTask;
		try {
			prepared = await realPrepareTask(binding, request, confirmation);
		} catch (error) {
			return failureResult(messageOf(error), codeOf(error));
		}
		const { receipt } = prepared;

		const abort = new AbortController();
		if (signal?.aborted === true) {
			abort.abort();
		} else {
			signal?.addEventListener("abort", () => abort.abort(), { once: true });
		}

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
			storageError: null,
			summary: "",
			progress: "",
			approvalDecisions: new Map(),
			pendingApprovals: new Set(),
			awaitingApproval: false,
		};
		tasks.set(receipt.taskId, task);
		setStatus(ctx);

		// Register scope via collaboration store
		const currentR = currentRound(receipt);
		const relOutputs = path.relative(binding.projectRoot, prepared.outputsDir).split(path.sep).join("/");
		const scopeDefinition: ScopeDefinition = {
			readPaths: currentR.inputFiles.map((i) => i.path),
			writePaths: [relOutputs],
		};

		try {
			await claimWork(binding.projectRoot, "workbuddy", {
				workId: receipt.taskId,
				taskId: receipt.taskId,
				round: prepared.round,
				title: currentR.goal.objective,
				scope: scopeDefinition,
			});
		} catch (scopeErr) {
			await finalizeTask(
				task,
				"failed",
				taskError(
					scopeErr instanceof WbTaskError ? scopeErr.code : WB_ERROR_CODE.scopeConflict,
					messageOf(scopeErr),
				),
			);
			return taskResult(toTaskView(task.receipt, task));
		}

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
			task.markTurnEnded();
			await finalizeTask(task, "failed", taskError(codeOf(error), messageOf(error)));
			return taskResult(toTaskView(task.receipt, task));
		}

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
		let promptText: string;
		try {
			promptText = await readFile(prepared.briefPath, "utf-8");
		} catch {
			promptText = request.goal.objective;
		}
		task.settled = runTurn(task, promptText);
		return {
			content: [
				{
					type: "text",
					text: [
						`Delegated to WorkBuddy as task ${receipt.taskId} (round ${prepared.round}).`,
						`Poll with wb_status({ taskId: "${receipt.taskId}" }).`,
						`WorkBuddy writes deliverables to ${prepared.outputsDir}.`,
					].join("\n"),
				},
			],
			details: {
				taskId: receipt.taskId,
				round: prepared.round,
				status: currentR.status,
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
			task.markTurnEnded();
			await finalizeTask(
				task,
				"interrupted",
				taskError(WB_ERROR_CODE.interrupted, messageOf(error)),
				{ collectArtifacts: true },
			);
			return;
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

		task.turnConfirmedEnd = true;

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
	async function updateMcpConfigFile(
		configPath: string,
		serviceName: string,
		newEntry: { command: string; args: string[] },
		projectRoot: string,
		selectHandler?: (message: string, choices: string[]) => Promise<string | undefined>,
	): Promise<{ success: boolean; error?: string }> {
		let rawContent: string | null = null;
		let isMissing = false;

		try {
			rawContent = await readFile(configPath, "utf-8");
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				isMissing = true;
			} else {
				return {
					success: false,
					error: `Cannot read MCP config at ${configPath}: ${messageOf(err)}`,
				};
			}
		}

		let configObj: Record<string, unknown> = {};

		if (isMissing) {
			configObj = { mcpServers: {} };
		} else {
			try {
				const parsed: unknown = JSON.parse(rawContent!);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					return {
						success: false,
						error: `Malformed MCP config at ${configPath}: root must be a JSON object`,
					};
				}
				configObj = parsed as Record<string, unknown>;
			} catch (err) {
				return {
					success: false,
					error: `Invalid JSON in MCP config at ${configPath}: ${messageOf(err)}`,
				};
			}
		}

		let mcpServers: Record<string, unknown>;
		if ("mcpServers" in configObj) {
			if (
				typeof configObj.mcpServers !== "object" ||
				configObj.mcpServers === null ||
				Array.isArray(configObj.mcpServers)
			) {
				return {
					success: false,
					error: `Malformed MCP config at ${configPath}: "mcpServers" must be an object`,
				};
			}
			mcpServers = configObj.mcpServers as Record<string, unknown>;
		} else {
			mcpServers = {};
			configObj.mcpServers = mcpServers;
		}

		if (serviceName in mcpServers) {
			const existing = mcpServers[serviceName];
			if (typeof existing !== "object" || existing === null) {
				return {
					success: false,
					error: `Conflicting non-object "${serviceName}" entry in ${configPath}`,
				};
			}
			const existingObj = existing as { command?: unknown; args?: unknown };
			if (!Array.isArray(existingObj.args)) {
				return {
					success: false,
					error: `Conflicting "${serviceName}" entry in ${configPath}: args must be an array`,
				};
			}
			const argsArray = existingObj.args.map(String);
			const targetEntrypoint = newEntry.args[0]!;
			const hasEntrypoint = argsArray.some((arg) => path.resolve(arg) === path.resolve(targetEntrypoint));
			const hasProjectFlag = argsArray.includes("--project");
			const hasAgentFlag = argsArray.includes("--agent");
			if (!hasEntrypoint || !hasProjectFlag || !hasAgentFlag) {
				return {
					success: false,
					error: `Conflicting "${serviceName}" in ${configPath} does not match this bridge installation; refusing to overwrite foreign entry`,
				};
			}

			const projIndex = argsArray.indexOf("--project");
			const currentBoundProj = projIndex !== -1 ? argsArray[projIndex + 1] : undefined;
			if (currentBoundProj && currentBoundProj !== projectRoot) {
				if (!selectHandler) {
					return {
						success: false,
						error: `Global entry in ${configPath} is bound to another project (${currentBoundProj}); cannot rebind without interactive UI`,
					};
				}
				const replaceChoice = await selectHandler(
					`Global MCP entry in ${configPath} is bound to ${currentBoundProj}.\nReplace binding with ${projectRoot}?`,
					["Replace with current project", "Cancel"],
				);
				if (replaceChoice !== "Replace with current project") {
					return {
						success: false,
						error: `Rebinding cancelled by user for ${configPath}`,
					};
				}
			}
		}

		mcpServers[serviceName] = newEntry;

		if (!isMissing) {
			try {
				const checkContent = await readFile(configPath, "utf-8");
				if (checkContent !== rawContent) {
					return {
						success: false,
						error: `Concurrent modification detected on ${configPath}; refusing to overwrite`,
					};
				}
			} catch (err) {
				return {
					success: false,
					error: `Failed to re-read ${configPath} prior to write: ${messageOf(err)}`,
				};
			}
		}

		await atomicWriteFile(path.dirname(configPath), configPath, JSON.stringify(configObj, null, 2));
		return { success: true };
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

		const ompMcpPath = path.join(projectRoot, ".omp", "mcp.json");
		const homeDir = overrides.workbuddyHomeDir ?? (process.env.USERPROFILE || process.env.HOME || os.homedir());
		const wbMcpPath = path.join(homeDir, ".workbuddy", "mcp.json");

		const ompEntry = {
			command: bunExe,
			args: [mcpEntrypoint, "--project", projectRoot, "--agent", "omp"],
		};
		const wbEntry = {
			command: bunExe,
			args: [mcpEntrypoint, "--project", projectRoot, "--agent", "workbuddy"],
		};

		const previewLines = [
			`Project: ${projectRoot}`,
			`MCP Entrypoint: ${mcpEntrypoint}`,
			`Bun: ${bunExe}`,
			`Target 1 (OMP project config): ${ompMcpPath}`,
			`Target 2 (WorkBuddy global config): ${wbMcpPath}`,
			`Service Name: omp-wb-bridge`,
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
		const ompUpdate = await updateMcpConfigFile(ompMcpPath, "omp-wb-bridge", ompEntry, projectRoot);
		if (!ompUpdate.success) {
			configFailures.push(`OMP MCP config: ${ompUpdate.error}`);
		}

		const wbUpdate = await updateMcpConfigFile(
			wbMcpPath,
			"omp-wb-bridge",
			wbEntry,
			projectRoot,
			(msg, choices) => ctx.ui.select(msg, choices),
		);
		if (!wbUpdate.success) {
			configFailures.push(`WorkBuddy MCP config: ${wbUpdate.error}`);
		}
		try {
			const skillSrc = path.join(repoRoot, "skills", "omp-wb-collaboration", "SKILL.md");
			const skillDest = path.join(projectRoot, ".workbuddy", "skills", "omp-wb-collaboration", "SKILL.md");
			await mkdir(path.dirname(skillDest), { recursive: true });
			await copyFile(skillSrc, skillDest);
		} catch (error) {
			// A missing collaboration skill degrades the workflow but must not stop
			// the project from being enabled; report it with the other config gaps.
			configFailures.push(`Collaboration skill: ${messageOf(error)}`);
		}
		// Enable entry point: binding check, migration, access verification
		let binding = await realReadBinding(projectRoot).catch(() => null);
		if (binding === null) {
			let candidates: DesktopCandidate[] = [];
			try {
				candidates = await realDiscover(projectRoot, new AbortController().signal);
			} catch {
				// Discovery failure / no desktop: no candidate session
			}
			// A session is bound only by an explicit human choice: a project may
			// have several WorkBuddy sessions, and picking the first silently would
			// pin it to a session nobody selected. Cancelling keeps the project
			// unbound, which is a legitimate state — it still gets enabled below.
			if (candidates.length > 0) {
				const labels = candidates.map(describeCandidate);
				const picked = await ctx.ui.select("Bind this project to a WorkBuddy session", labels);
				const index = picked === undefined ? -1 : labels.indexOf(picked);
				const chosen = index >= 0 ? candidates[index] : undefined;
				if (chosen !== undefined) {
					binding = {
						version: 1,
						projectRoot,
						sessionId: chosen.binding.sessionId,
						workbuddyVersion: chosen.binding.workbuddyVersion,
					};
					await realWriteBinding(binding);
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
			const currentR = currentRound(receipt);
			if (currentR.status === "running" || currentR.status === "awaiting_approval") {
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
	const current = currentRound(receipt);
	const awaitingApproval = live ? task.awaitingApproval : current.status === "awaiting_approval";
	const isTerm = receiptIsTerminal(receipt);
	const status: TaskStatus = !isTerm && awaitingApproval ? "awaiting_approval" : current.status;
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
		storageError: live ? task.storageError : null,
	};
}

/** Formats a task view as a tool result. */
function taskResult(view: TaskView): AgentToolResult<TaskView> {
	const lines = [
		`Task ${view.taskId}: ${view.status} (round ${view.round})`,
		view.sessionId === "" ? undefined : `WorkBuddy session: ${view.sessionId}`,
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
