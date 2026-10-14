/**
 * Approval-path tests for the OMP entry point.
 *
 * These drive the real `activate()` registration against a stand-in WorkBuddy
 * session supplied through the entry point's own dependency seam, then exercise
 * the permission request that session raises. Every case asserts the same
 * invariant: WorkBuddy is only ever told "allow" when a human explicitly
 * approved that one request.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import activate, { type BridgeOverrides } from "../src/index";
import type { DesktopCallbacks, DesktopSession, PromptOutcome, TaskReceipt } from "../src/types";
import { WB_ERROR_CODE } from "../src/types";

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/**
 * The project root the tools resolve their cwd against.
 *
 * It has to be a real directory: the tools that report a project refuse to
 * guess when the root cannot be resolved, exactly as they must in production.
 */
let PROJECT_ROOT = "";
const allocatedRoots: string[] = [];

afterEach(async () => {
	while (allocatedRoots.length > 0) {
		const target = allocatedRoots.pop();
		if (target !== undefined) {
			await rm(target, { recursive: true, force: true }).catch(() => undefined);
		}
	}
});

/** The stand-in session one test opened, with the callbacks the entry point passed. */
interface CapturedSession {
	binding: { sessionId: string };
	callbacks: DesktopCallbacks;
	session: DesktopSession;
}

/** Stand-in for the module's error class, matching its public shape. */
class MockWbTaskError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WbTaskError";
		this.code = code;
	}
}

/** Drives the entry point against in-memory collaborators. */
class Harness {
	readonly tools = new Map<string, RegisteredTool>();
	readonly captured: CapturedSession[] = [];
	readonly written = new Map<string, TaskReceipt>();
	readonly released: string[] = [];
	artifacts: string[] = [];
	missingOutputs: string[] = [];
	outcome: PromptOutcome = { stopReason: "end_turn" };
	/** Set to reject the next connect with this error. */
	connectFailure: Error | undefined;
	/** Bound project root; a different cwd is then refused. */
	bindingRoot = PROJECT_ROOT;
	/**
	 * Fails the next `writeTask` whose receipt is already terminal.
	 *
	 * Per-stage injection is what lets a test prove that a receipt write failure
	 * stops the release, while the initial `running` write still succeeds.
	 */
	failTerminalWrite = false;
	/** Fails every `releaseTask` call. */
	failRelease = false;
	/** Rejects every artifact scan, as an unreadable outputs directory would. */
	failCollect = false;
	/** Records the order of committed lifecycle stages. */
	readonly events: string[] = [];
	/** Number of `session/prompt` calls, so a replay would be visible. */
	promptCalls = 0;
	cancelCalls = 0;
	closeCalls = 0;
	/** Stored task rows the index reports, as a real project directory would. */
	readonly storedIndex: Array<{ taskId: string; sessionId: string; status: TaskReceipt["status"]; updatedAt: number }> = [];
	/** Unreadable stored records the index reports alongside the readable ones. */
	readonly storedWarnings: Array<{ taskId: string; error: { code: string; message: string } }> = [];
	/** Overrides the binding `wb_doctor` and the tools read; null means "no binding". */
	readBindingResult: { version: 1; projectRoot: string; sessionId: string; workbuddyVersion: string } | null = {
		version: 1,
		projectRoot: PROJECT_ROOT,
		sessionId: SESSION_ID,
		workbuddyVersion: "1.2.3",
	};
	/** The lock `wb_doctor` reads, or null for a free slot. */
	lockResult: { ownerPid: number; taskId: string } | null = null;
	/** Set to make the lock read fail, as a corrupt lock file would. */
	lockFailure: Error | undefined;
	/** Workers `wb_doctor` reports, replacing the real GET-only inspection. */
	inspectResult: Array<{ endpoint: string; status: string; workbuddyVersion: string | null }> = [];
	/** Number of times the real-time worker inspection was invoked. */
	inspectCalls = 0;
	/** Number of times the persisted index was consulted. */
	tasksIndexCalls = 0;
	/** Number of binding writes, so a read-only tool cannot be mistaken for a writer. */
	writtenBindingCalls = 0;
	/**
	 * How long a cancellation waits for the turn to end in tests.
	 *
	 * Short by default so a test that holds a turn open does not spend the real
	 * production budget on every case. Tests that assert the wait itself raise it.
	 */
	cancelSettleMs = 20;
	/** Holds the next artifact scan open so a cancellation can land during it. */
	private collectGate: { promise: Promise<void>; resolve(): void } | undefined;
	/** Holds the turn open so updates can be delivered before it resolves. */
	private turnGate:
		| { promise: Promise<PromptOutcome>; resolve(value: PromptOutcome): void; reject(error: Error): void }
		| undefined;
	private shutdown: (() => Promise<void>) | undefined;

	/**
	 * Holds the next turn open until {@link releaseTurn} or {@link failTurn}.
	 *
	 * A real turn streams its updates before `session/prompt` resolves, so tests
	 * that assert on accumulated text must not let the turn finish first.
	 */
	holdTurn(): void {
		let resolve!: (value: PromptOutcome) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<PromptOutcome>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		// A rejected turn is observed by the entry point, not by the harness.
		promise.catch(() => undefined);
		this.turnGate = { promise, resolve, reject };
	}

	releaseTurn(value?: PromptOutcome): void {
		const gate = this.turnGate;
		this.turnGate = undefined;
		gate?.resolve(value ?? this.outcome);
	}

	/** Ends the held turn by breaking the stream, as a dropped connection would. */
	failTurn(error: Error): void {
		const gate = this.turnGate;
		this.turnGate = undefined;
		gate?.reject(error);
	}

	/** Holds the next artifact scan open, so a cancellation can arrive during it. */
	holdCollect(): void {
		let resolve!: () => void;
		const promise = new Promise<void>((resolvePromise) => {
			resolve = resolvePromise;
		});
		this.collectGate = { promise, resolve };
	}

	/** Releases a held artifact scan, optionally with artifacts to report. */
	finishCollect(artifacts: string[] = []): void {
		const gate = this.collectGate;
		this.collectGate = undefined;
		if (gate === undefined) {
			return;
		}
		this.artifacts = artifacts;
		gate.resolve();
	}

	/** Registers the tools and returns the API the tests drive. */
	start(): ExtensionAPI {
		const overrides: BridgeOverrides = {
			discover: async () => [
				{
					endpoint: "http://127.0.0.1:1234",
					binding: { version: 1, projectRoot: this.bindingRoot, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
					busy: false,
				},
			],
			connect: async (binding, callbacks) => {
				if (this.connectFailure !== undefined) {
					throw this.connectFailure;
				}
				const session: DesktopSession = {
					prompt: async () => {
						this.promptCalls += 1;
						const gate = this.turnGate;
						return gate === undefined ? this.outcome : await gate.promise;
					},
					cancel: async () => {
						this.cancelCalls += 1;
					},
					close: async () => {
						this.closeCalls += 1;
					},
				};
				this.captured.push({ binding, callbacks, session });
				return session;
			},
			prepareTask: async (binding, request) => {
				const receipt: TaskReceipt = {
					version: 1,
					taskId: request.taskId ?? TASK_ID,
					sessionId: binding.sessionId,
					projectRoot: binding.projectRoot,
					status: "running",
					prompt: request.prompt,
					inputFiles: request.inputFiles ?? [],
					expectedOutputs: request.expectedOutputs ?? [],
					summary: "",
					artifacts: [],
					error: null,
				};
				this.written.set(receipt.taskId, { ...receipt });
				return {
					receipt,
					briefPath: `${binding.projectRoot}/.wb-bridge/tasks/${receipt.taskId}/brief.md`,
					outputsDir: `${binding.projectRoot}/.wb-bridge/tasks/${receipt.taskId}/outputs`,
				};
			},
			readBinding: async () =>
				this.readBindingResult === null
					? null
					: {
							version: 1 as const,
							projectRoot: this.bindingRoot,
							sessionId: SESSION_ID,
							workbuddyVersion: "1.2.3",
						},
			writeBinding: async () => {
				this.writtenBindingCalls += 1;
			},
			readTask: async (_projectRoot, taskId) => {
				const receipt = this.written.get(taskId);
				if (receipt === undefined) {
					throw new MockWbTaskError("WB_TASK_NOT_FOUND", `no task ${taskId}`);
				}
				return { ...receipt };
			},
			readTaskIndex: async () => {
				this.tasksIndexCalls += 1;
				return {
					entries: [...this.storedIndex],
					warnings: [...this.storedWarnings],
				};
			},
			readTaskLock: async () => {
				if (this.lockFailure !== undefined) {
					throw this.lockFailure;
				}
				return this.lockResult;
			},
			inspectWorkers: async () => {
				this.inspectCalls += 1;
				return this.inspectResult.map((worker) => ({
					endpoint: worker.endpoint,
					status: worker.status as "verified" | "busy" | "auth_required" | "mismatch" | "unhealthy" | "unknown",
					workbuddyVersion: worker.workbuddyVersion,
				}));
			},
			writeTask: async (receipt) => {
				const isTerminal =
					receipt.status === "completed" ||
					receipt.status === "cancelled" ||
					receipt.status === "failed" ||
					receipt.status === "interrupted";
				if (isTerminal) {
					this.events.push(`write:${receipt.status}`);
					if (this.failTerminalWrite) {
						this.failTerminalWrite = false;
						throw new Error("simulated disk failure");
					}
				}
				this.written.set(receipt.taskId, { ...receipt });
				// In a real project the receipt *is* the row the index reports, so a
				// committed write is visible to a later listing.
				const row = this.storedIndex.find((entry) => entry.taskId === receipt.taskId);
				if (row === undefined) {
					this.storedIndex.push({
						taskId: receipt.taskId,
						sessionId: receipt.sessionId,
						status: receipt.status,
						updatedAt: Date.now(),
					});
				} else {
					row.status = receipt.status;
					row.sessionId = receipt.sessionId;
					row.updatedAt = Date.now();
				}
			},
			collectArtifacts: async () => {
				this.events.push("collect");
				if (this.failCollect) {
					throw new Error("simulated scan failure");
				}
				const gate = this.collectGate;
				if (gate !== undefined) {
					await gate.promise;
				}
				return { artifacts: this.artifacts, missingOutputs: this.missingOutputs };
			},
			releaseTask: async (_projectRoot, taskId) => {
				this.events.push("release");
				if (this.failRelease) {
					throw new Error("simulated lock release failure");
				}
				this.released.push(taskId);
			},
			// A real cancellation holds the connection for seconds; tests that hold a
			// turn open would spend that budget on every case, so it is shortened
			// here and the real budget is covered by the default itself.
			cancelSettleMs: this.cancelSettleMs,
		};

		const chain = { describe: () => chain, optional: () => chain };
		const api = {
			zod: {
				object: (shape: unknown) => shape,
				string: () => chain,
				number: () => chain,
				array: () => chain,
			},
			logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") {
					this.shutdown = handler;
				}
			},
			registerCommand: () => undefined,
			registerTool: (tool: RegisteredTool) => {
				this.tools.set(tool.name, tool);
			},
		};
		const extensionApi = api as unknown as ExtensionAPI;
		activate(extensionApi, overrides);
		return extensionApi;
	}

	async shutdownExtension(): Promise<void> {
		await this.shutdown?.();
	}

	/** Invokes a registered tool with the arguments the tests care about. */
	async call(name: string, params: unknown, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		const tool = this.tools.get(name);
		if (tool === undefined) {
			throw new Error(`tool ${name} was not registered`);
		}
		return await tool.execute("tool-call", params as never, undefined, undefined, ctx);
	}

	lastSession(): CapturedSession {
		const session = this.captured.at(-1);
		if (session === undefined) {
			throw new Error("no session was opened");
		}
		return session;
	}

	/**
	 * Waits until a receipt reaches the expected status.
	 *
	 * The receipt is written before the task's lock is released, so this waits for
	 * both: the terminal record and the freed slot.
	 */
	async waitForStatus(taskId: string, status: TaskReceipt["status"]): Promise<TaskReceipt | undefined> {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const receipt = this.written.get(taskId);
			if (receipt?.status === status && this.released.includes(taskId)) {
				return receipt;
			}
			await Promise.resolve();
		}
		return this.written.get(taskId);
	}
}

/** The subset of a registered tool these tests invoke. */
interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

/** UI harness that records offered choices and answers the next dialog. */
interface UiHarness {
	ctx: ExtensionContext;
	choices: string[];
	statuses: Array<string | undefined>;
	/** Signals passed to each dialog, so abort wiring can be asserted. */
	dialogSignals: AbortSignal[];
	/**
	 * Makes the next dialog return the set answer even after its signal aborts.
	 *
	 * A real selection can lose the race against the abort, so this models the
	 * case where a decision is already being returned when the task stops.
	 */
	answerDespiteAbort: boolean;
	setAnswer(answer: string | undefined): void;
	/** Keeps the dialog open until released, so in-flight state can be observed. */
	hold(open: boolean): void;
	/**
	 * Resolves exactly one parked dialog and leaves the others waiting.
	 *
	 * Real dialogs answer independently, so a test where one decision must land
	 * while another is still open uses this instead of {@link hold}.
	 */
	releaseNext(): void;
	clearStatuses(): void;
}

function makeContext(options: { hasUI?: boolean; cwd?: string } = {}): UiHarness {
	const choices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const dialogSignals: AbortSignal[] = [];
	let answer: string | undefined;
	let held = false;
	let answerDespiteAbort = false;
	// One resolver per parked dialog, so releases are per-dialog.
	const parked: Array<() => void> = [];
	const ui = {
		select: async (
			_title: string,
			offered: string[],
			dialogOptions?: { signal?: AbortSignal },
		): Promise<string | undefined> => {
			choices.push(...offered);
			// Each dialog parks on its own resolver, so several can be open at once
			// and be released independently.
			let release!: () => void;
			const parkedPromise = new Promise<void>((resolve) => {
				release = resolve;
			});
			if (held) {
				parked.push(release);
			}
			if (dialogOptions?.signal !== undefined) {
				dialogSignals.push(dialogOptions.signal);
				if (dialogOptions.signal.aborted && !answerDespiteAbort) {
					return undefined;
				}
				const aborted = new Promise<string | undefined>((resolve) => {
					dialogOptions.signal?.addEventListener(
						"abort",
						() => resolve(answerDespiteAbort ? answer : undefined),
						{ once: true },
					);
				});
				if (held) {
					return await Promise.race([
						parkedPromise.then(() => answer),
						aborted,
					]);
				}
				return await Promise.race([Promise.resolve(answer), aborted]);
			}
			if (held) {
				await parkedPromise;
			}
			return answer;
		},
		confirm: async () => true,
		notify: () => undefined,
		setStatus: (_key: string, text: string | undefined) => {
			statuses.push(text);
		},
	};
	const ctx = { cwd: options.cwd ?? PROJECT_ROOT, hasUI: options.hasUI ?? true, ui };
	return {
		ctx: ctx as unknown as ExtensionContext,
		choices,
		statuses,
		dialogSignals,
		get answerDespiteAbort() {
			return answerDespiteAbort;
		},
		set answerDespiteAbort(value: boolean) {
			answerDespiteAbort = value;
		},
		setAnswer: (value) => {
			answer = value;
		},
		hold: (open) => {
			held = open;
			if (!open) {
				// Releasing the hold frees every dialog that is currently parked.
				for (const release of parked.splice(0)) {
					release();
				}
			}
		},
		releaseNext: () => {
			parked.shift()?.();
		},
		clearStatuses: () => {
			statuses.length = 0;
		},
	};
}

/** One WorkBuddy permission request, in the shape the worker emits. */
function interruptionRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sessionId: SESSION_ID,
		interruptionId: "ir-1",
		toolCallId: "call-1",
		toolName: "Bash",
		toolTitle: "Bash",
		reason: "The command writes outside the task outputs directory.",
		toolInput: { command: "rm -rf build" },
		options: ["allow", "deny"],
		...overrides,
	};
}

/** Reads a taskId out of a tool result without assuming its shape. */
function taskIdOf(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details;
	if (details !== null && typeof details === "object" && "taskId" in details && typeof details.taskId === "string") {
		return details.taskId;
	}
	return undefined;
}

/** Reads the error code out of a failed tool result. */
function errorCodeOf(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details;
	if (details !== null && typeof details === "object" && "error" in details) {
		const error = details.error;
		if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
			return error.code;
		}
	}
	return undefined;
}

/**
 * Narrows a tool result's details to the task view the tools publish.
 *
 * The tools are registered with an untyped parameters shape in this harness, so
 * the details arrive as `unknown`; every field the tests read is checked here
 * once rather than cast at each assertion.
 */
interface ResultView {
	status: string;
	summary: string;
	progress: string;
	error: { code: string; message: string } | null;
	storageError: { code: string; message: string } | null;
	awaitingApproval: boolean;
	ownedByCurrentProcess: boolean;
	artifacts: string[];
	taskId: string;
}

function detailsOf(result: AgentToolResult<unknown>): ResultView {
	const details = result.details;
	if (details === null || typeof details !== "object") {
		throw new Error("tool result has no details object");
	}
	const readError = (value: unknown): { code: string; message: string } | null => {
		if (value === null || value === undefined) {
			return null;
		}
		if (typeof value === "object" && "code" in value && "message" in value) {
			return { code: String(value.code), message: String(value.message) };
		}
		throw new Error("error field is neither null nor an error object");
	};
	const record = details as Record<string, unknown>;
	return {
		taskId: typeof record.taskId === "string" ? record.taskId : "",
		status: typeof record.status === "string" ? record.status : "",
		summary: typeof record.summary === "string" ? record.summary : "",
		progress: typeof record.progress === "string" ? record.progress : "",
		error: readError(record.error),
		storageError: readError(record.storageError),
		awaitingApproval: record.awaitingApproval === true,
		ownedByCurrentProcess: record.ownedByCurrentProcess === true,
		artifacts: Array.isArray(record.artifacts)
			? record.artifacts.filter((entry): entry is string => typeof entry === "string")
			: [],
	};
}

/** Reads the first text block of a tool result. */
function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text : "";
}

/**
 * Polls a task's view until the checker is satisfied, and fails loudly if it
 * never is rather than leaving an undefined result behind for later assertions.
 */
async function pollUntil(
	h: UiHarness,
	taskId: string,
	check: (view: ResultView) => boolean,
	attempts = 200,
): Promise<ResultView> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const view = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		if (check(view)) {
			return view;
		}
		await Promise.resolve();
	}
	throw new Error(`condition was never satisfied for task ${taskId}`);
}

/**
 * Narrows a `wb_tasks` result's details to the listing shape.
 *
 * Like {@link detailsOf}, the fields are checked once here instead of being cast
 * at each assertion.
 */
interface TasksListDetails {
	projectRoot: string;
	tasks: Array<{
		taskId: string;
		sessionId: string;
		status: string;
		updatedAt: number;
		ownedByCurrentProcess: boolean;
		storageError: { code: string; message: string } | null;
	}>;
	total: number;
	offset: number;
	limit: number;
	nextOffset: number | null;
	warnings: Array<{ taskId: string; error: { code: string; message: string } }>;
}

function tasksDetailsOf(result: AgentToolResult<unknown>): TasksListDetails {
	const details = result.details;
	if (details === null || typeof details !== "object") {
		throw new Error("wb_tasks result has no details object");
	}
	const record = details as Record<string, unknown>;
	const readError = (value: unknown): { code: string; message: string } | null => {
		if (value === null || value === undefined) {
			return null;
		}
		if (typeof value === "object" && "code" in value && "message" in value) {
			return { code: String(value.code), message: String(value.message) };
		}
		throw new Error("error field is neither null nor an error object");
	};
	const tasks = Array.isArray(record.tasks)
		? record.tasks.map((entry) => {
				if (entry === null || typeof entry !== "object") {
					throw new Error("task row is not an object");
				}
				const row = entry as Record<string, unknown>;
				return {
					taskId: String(row.taskId),
					sessionId: String(row.sessionId),
					status: String(row.status),
					updatedAt: Number(row.updatedAt),
					ownedByCurrentProcess: row.ownedByCurrentProcess === true,
					storageError: readError(row.storageError),
				};
			})
		: [];
	const warnings = Array.isArray(record.warnings)
		? record.warnings.map((entry) => {
				if (entry === null || typeof entry !== "object") {
					throw new Error("warning row is not an object");
				}
				const row = entry as Record<string, unknown>;
				return { taskId: String(row.taskId), error: readError(row.error) ?? { code: "", message: "" } };
			})
		: [];
	return {
		projectRoot: typeof record.projectRoot === "string" ? record.projectRoot : "",
		tasks,
		total: typeof record.total === "number" ? record.total : 0,
		offset: typeof record.offset === "number" ? record.offset : 0,
		limit: typeof record.limit === "number" ? record.limit : 0,
		nextOffset: typeof record.nextOffset === "number" ? record.nextOffset : null,
		warnings,
	};
}

/**
 * Narrows a `wb_doctor` result's details to the diagnosis shape.
 *
 * Like the other helpers, every field is checked once here rather than cast at
 * each assertion.
 */
interface DoctorDetails {
	projectRoot: string;
	binding: { sessionId: string; workbuddyVersion: string } | null;
	lock: {
		ownerPid: number;
		taskId: string;
		ownerAlive: boolean;
		ownedByCurrentProcess: boolean;
	} | null;
	workers: Array<{ endpoint: string; status: string; workbuddyVersion: string | null }>;
	issues: Array<{ severity: string; code: string | null; message: string; nextAction: string }>;
	protocolVerified: boolean;
}

function doctorDetailsOf(result: AgentToolResult<unknown>): DoctorDetails {
	const details = result.details;
	if (details === null || typeof details !== "object") {
		throw new Error("wb_doctor result has no details object");
	}
	const record = details as Record<string, unknown>;
	const readBinding = record.binding;
	const readLock = record.lock;
	const issues = Array.isArray(record.issues)
		? record.issues.map((entry) => {
				if (entry === null || typeof entry !== "object") {
					throw new Error("issue is not an object");
				}
				const issue = entry as Record<string, unknown>;
				return {
					severity: String(issue.severity),
					code: typeof issue.code === "string" ? issue.code : null,
					message: String(issue.message),
					nextAction: String(issue.nextAction),
				};
			})
		: [];
	const workers = Array.isArray(record.workers)
		? record.workers.map((entry) => {
				if (entry === null || typeof entry !== "object") {
					throw new Error("worker is not an object");
				}
				const worker = entry as Record<string, unknown>;
				return {
					endpoint: String(worker.endpoint),
					status: String(worker.status),
					workbuddyVersion:
						typeof worker.workbuddyVersion === "string" ? worker.workbuddyVersion : null,
				};
			})
		: [];
	return {
		projectRoot: typeof record.projectRoot === "string" ? record.projectRoot : "",
		binding:
			readBinding === null || typeof readBinding !== "object"
				? null
				: {
						sessionId: String((readBinding as Record<string, unknown>).sessionId),
						workbuddyVersion: String((readBinding as Record<string, unknown>).workbuddyVersion),
					},
		lock:
			readLock === null || typeof readLock !== "object"
				? null
				: {
						ownerPid: Number((readLock as Record<string, unknown>).ownerPid),
						taskId: String((readLock as Record<string, unknown>).taskId),
						ownerAlive: (readLock as Record<string, unknown>).ownerAlive === true,
						ownedByCurrentProcess:
							(readLock as Record<string, unknown>).ownedByCurrentProcess === true,
					},
		workers,
		issues,
		protocolVerified: record.protocolVerified === true,
	};
}

let harness: Harness;

beforeEach(async () => {
	const raw = await mkdtemp(path.join(os.tmpdir(), "wb-approval-test-"));
	PROJECT_ROOT = await realpath(raw);
	allocatedRoots.push(PROJECT_ROOT);
	harness = new Harness();
	// A real WorkBuddy turn stays open while it works and streams its updates, so
	// the default fixture turn is held open too. Tests that assert on the turn's
	// result release it explicitly.
	harness.holdTurn();
});

describe("approval - no grant without an explicit human decision", () => {
	it("denies when the user dismisses the dialog", async () => {
		const h = makeContext();
		h.setAnswer(undefined);
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
		expect(h.choices).toEqual(["Deny", "Approve once"]);
	});

	it("denies in a session without UI, without prompting at all", async () => {
		const h = makeContext({ hasUI: false });
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
		expect(h.choices).toEqual([]);
	});

	it("denies when the explicit selection is Deny", async () => {
		const h = makeContext();
		h.setAnswer("Deny");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
	});

	it("grants allow once when the user explicitly approves", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "allow" });
	});

	it("never offers a standing allowance", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		await harness.lastSession().callbacks.onRequest("codebuddy.ai/interruptionRequest", interruptionRequest());
		expect(h.choices).not.toContain("Approve always");
		expect(h.choices).not.toContain("Allow for session");
		// The only affirmative answer on offer is the one-time approval.
		expect(h.choices.filter((choice) => choice !== "Deny")).toEqual(["Approve once"]);
	});

	it("refuses a request that offers no allow option", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ options: ["deny"] }),
		);
		expect(answer).not.toEqual(expect.objectContaining({ decision: "allow" }));
	});

	it("refuses a nested allowAll-only request without offering an approval", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ options: ["allowAll", "deny"] }),
		);
		expect(answer).not.toEqual(expect.objectContaining({ decision: "allowAll" }));
		expect(h.choices).toEqual([]);
	});

	it("leaves an unknown request shape unanswered instead of guessing", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		for (const unknownForm of [
			{ kind: "oauth", url: "https://example.test/authorize" },
			{ questions: [{ id: "token", type: "file" }] },
			"please approve",
			null,
			{ toolCallId: "call-9" },
		]) {
			const answer = await harness.lastSession().callbacks.onRequest(
				"codebuddy.ai/interruptionRequest",
				unknownForm,
			);
			if (answer !== undefined) {
				expect(answer).not.toEqual(expect.objectContaining({ decision: "allow" }));
			}
		}
		expect(h.choices).toEqual([]);
	});

	it("leaves a request for an unrelated method unanswered", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest("fs/read_text_file", {
			path: "/etc/passwd",
		});
		expect(answer).toBeUndefined();
	});

	it("answers the standard ACP permission shape with an offered option id", async () => {
		const h = makeContext();
		h.setAnswer("Deny");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		// The standard shape offers typed options and expects an option id back,
		// not a decision word.
		const answer = await harness.lastSession().callbacks.onRequest("session/request_permission", {
			sessionId: SESSION_ID,
			toolCall: { toolCallId: "call-std-1", title: "Bash", rawInput: { command: "rm -rf build" } },
			options: [
				{ optionId: "deny-once", name: "Deny", kind: "reject_once" },
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
			],
		});
		expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "deny-once" } });
	});

	it("selects the one-time grant for the standard shape on explicit approval", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest("session/request_permission", {
			sessionId: SESSION_ID,
			toolCall: { toolCallId: "call-std-2", title: "Bash" },
			options: [
				{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "always", name: "Always allow", kind: "allow_always" },
			],
		});
		// The standing grant is offered by the agent but never selected.
		expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
	});

	it("never selects a standing grant offered in the standard shape", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const answer = await harness.lastSession().callbacks.onRequest("session/request_permission", {
				sessionId: SESSION_ID,
				toolCall: { toolCallId: `call-std-${attempt}`, title: "Bash" },
				options: [
					{ optionId: "always", name: "Always allow", kind: "allow_always" },
					{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
				],
			});
			// With no one-time option available, approval cannot be granted at all.
			expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
		}
	});

	it("leaves a standard permission request with no refusal option unanswered", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const answer = await harness.lastSession().callbacks.onRequest("session/request_permission", {
			sessionId: SESSION_ID,
			toolCall: { toolCallId: "call-std-3", title: "Bash" },
			options: [{ optionId: "allow-only", name: "Allow", kind: "allow_once" }],
		});
		// Nothing can be truthfully refused, so no answer is invented.
		expect(answer).toBeUndefined();
	});

	it("asks only once for a repeated request and reuses the decision", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const first = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		const second = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(first).toEqual(second);
		expect(first).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "allow" });
		// One dialog for both deliveries of the same request id.
		expect(h.choices).toEqual(["Deny", "Approve once"]);
	});

	it("carries a denial forward for a repeat of the same request id", async () => {
		const h = makeContext();
		h.setAnswer("Deny");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const first = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		h.setAnswer("Approve once");
		const second = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		expect(first).toEqual(second);
		expect(second).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
	});

	it("treats a distinct request id as a fresh decision", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const session = harness.lastSession();
		await session.callbacks.onRequest("codebuddy.ai/interruptionRequest", interruptionRequest());
		await session.callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ interruptionId: "ir-2", toolCallId: "call-2" }),
		);
		// Two distinct requests are two distinct prompts.
		expect(h.choices).toEqual(["Deny", "Approve once", "Deny", "Approve once"]);
	});

	it("refuses a request that arrives after cancellation without consulting the user", async () => {
		const h = makeContext();
		h.setAnswer("Approve once");
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			return;
		}

		await harness.call("wb_cancel", { taskId }, h.ctx);
		const answer = await harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		// A task that already ended still owes the worker an explicit refusal,
		// so its interruption service is released rather than left waiting.
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
		// The user is not troubled for a task that is already over.
		expect(h.choices).toEqual([]);
	});

	it("reports awaiting approval only while the decision is outstanding", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Deny");
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		h.clearStatuses();

		const pending = harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		// The footer reports the wait while it lasts, and the task's own view
		// reports it as awaiting approval rather than merely running.
		const during = await pollUntil(h, taskId, (candidate) => candidate.awaitingApproval);
		expect(during.status).toBe("awaiting_approval");
		h.hold(false);
		await pending;

		const after = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(after.awaitingApproval).toBe(false);
		expect(after.status).toBe("running");
		// The footer never claims an approval is pending once it is decided.
		expect(h.statuses.some((text) => text?.includes("awaiting approval"))).toBe(true);
		expect(h.statuses.at(-1)?.includes("awaiting approval")).toBe(false);
	});
});

describe("approval - terminal states and receipts", () => {
	it("keeps a partial reply when the stream dies mid-turn", async () => {
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const session = harness.lastSession();
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial findings" } },
		});
		harness.failTurn(new Error("socket closed"));

		const receipt = await harness.waitForStatus(TASK_ID, "interrupted");
		expect(receipt?.error?.code).toBe(WB_ERROR_CODE.interrupted);
		expect(receipt?.summary).toBe("partial findings");
		expect(harness.released).toContain(TASK_ID);
	});

	it("reports a missing expected output as a failure and keeps the artifacts", async () => {
		harness.missingOutputs = ["report.md"];
		harness.artifacts = ["/project/.wb-bridge/tasks/t/outputs/notes.md"];
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "make a report" }, h.ctx);
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(TASK_ID, "failed");
		expect(receipt?.error?.code).toBe(WB_ERROR_CODE.outputMissing);
		expect(receipt?.error?.message).toContain("report.md");
		expect(receipt?.artifacts).toEqual(harness.artifacts);
	});

	it("completes with the reply text and collected artifacts", async () => {
		harness.artifacts = ["/project/.wb-bridge/tasks/t/outputs/report.md"];
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const session = harness.lastSession();
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done: " } },
		});
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "report written" } },
		});
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(TASK_ID, "completed");
		expect(receipt?.summary).toBe("done: report written");
		expect(receipt?.artifacts).toEqual(harness.artifacts);
		expect(receipt?.error).toBeNull();
		expect(harness.released).toContain(TASK_ID);
	});

	it("does not retain reasoning chunks in the task summary", async () => {
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const session = harness.lastSession();
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" } },
		});
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "visible answer" } },
		});
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(TASK_ID, "completed");
		expect(receipt?.summary).toBe("visible answer");
	});

	it("reports a non-end_turn stop reason as a failure", async () => {
		harness.outcome = { stopReason: "refusal" };
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(TASK_ID, "failed");
		expect(receipt?.error?.code).toBe(WB_ERROR_CODE.taskFailed);
		expect(receipt?.error?.message).toContain("refusal");
	});

	it("reports an error message from WorkBuddy as a failure", async () => {
		harness.outcome = { stopReason: "end_turn", errorMessage: "quota exhausted" };
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(TASK_ID, "failed");
		expect(receipt?.error?.message).toBe("quota exhausted");
	});

	it("records a failed task when the session cannot be opened", async () => {
		harness.connectFailure = new Error("WB_SESSION_NOT_RUNNING: no worker for that session");
		const h = makeContext();
		harness.start();
		const result = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		expect(result.isError).toBe(true);
		// Nothing was delivered, so the task must not be left looking alive.
		const receipt = harness.written.get(TASK_ID);
		expect(receipt?.status).toBe("failed");
		expect(harness.released).toContain(TASK_ID);
	});

	it("leaves a late success from overwriting a cancellation", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			return;
		}

		await harness.call("wb_cancel", { taskId }, h.ctx);
		expect(harness.written.get(taskId)?.status).toBe("cancelled");

		// The turn finishes successfully after the cancellation.
		harness.releaseTurn({ stopReason: "end_turn" });
		await harness.waitForStatus(taskId, "cancelled");
		expect(harness.written.get(taskId)?.status).toBe("cancelled");
		expect(harness.written.get(taskId)?.error).toBeNull();
	});

	it("keeps files already produced when a task is cancelled", async () => {
		harness.artifacts = ["/project/.wb-bridge/tasks/t/outputs/partial.md"];
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		expect(taskId).toBeDefined();
		if (taskId === undefined) {
			return;
		}

		const cancel = await harness.call("wb_cancel", { taskId }, h.ctx);
		expect(cancel.isError).toBe(false);
		// A cancelled run still hands back whatever WorkBuddy had produced.
		expect(textOf(cancel)).toContain("partial.md");
		expect(harness.written.get(taskId)?.artifacts).toEqual(harness.artifacts);
		expect(harness.written.get(taskId)?.error).toBeNull();
	});

	it("cancels an unfinished task on session shutdown", async () => {
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "long one" }, h.ctx);

		await harness.shutdownExtension();
		const receipt = harness.written.get(TASK_ID);
		expect(receipt?.status).toBe("cancelled");
		expect(receipt?.error?.code).toBe(WB_ERROR_CODE.interrupted);
		expect(harness.released).toContain(TASK_ID);
	});

	it("reports a terminal task from an earlier session without touching its session", async () => {
		const h = makeContext();
		harness.start();
		// Seed a receipt as if a previous OMP session had finished it.
		harness.written.set(TASK_ID, {
			version: 1,
			taskId: TASK_ID,
			sessionId: SESSION_ID,
			projectRoot: PROJECT_ROOT,
			status: "completed",
			prompt: "earlier work",
			inputFiles: [],
			expectedOutputs: [],
			summary: "earlier reply",
			artifacts: ["/project/.wb-bridge/tasks/t/outputs/report.md"],
			error: null,
		});

		const status = await harness.call("wb_status", { taskId: TASK_ID, waitMs: 0 }, h.ctx);
		expect(status.isError).toBe(false);
		expect(textOf(status)).toContain("earlier reply");
		expect(textOf(status)).toContain("report.md");

		// Cancelling it is a no-op rather than an attempt to reach a dead session.
		const cancel = await harness.call("wb_cancel", { taskId: TASK_ID }, h.ctx);
		expect(cancel.isError).toBe(false);
		expect(harness.captured.length).toBe(0);
	});

	it("refuses to cancel a task that is still running outside this process", async () => {
		const h = makeContext();
		harness.start();
		harness.written.set(TASK_ID, {
			version: 1,
			taskId: TASK_ID,
			sessionId: SESSION_ID,
			projectRoot: PROJECT_ROOT,
			status: "running",
			prompt: "someone else's work",
			inputFiles: [],
			expectedOutputs: [],
			summary: "",
			artifacts: [],
			error: null,
		});

		const cancel = await harness.call("wb_cancel", { taskId: TASK_ID }, h.ctx);
		expect(cancel.isError).toBe(true);
		expect(errorCodeOf(cancel)).toBe(WB_ERROR_CODE.busy);
	});

	it("refuses to run a task from an unbound project folder", async () => {
		const h = makeContext({ cwd: "C:/other-project" });
		harness.start();
		const result = await harness.call("wb_task", { prompt: "x" }, h.ctx);

		expect(result.isError).toBe(true);
		expect(errorCodeOf(result)).toBe(WB_ERROR_CODE.bindingInvalid);
	});

	it("reports an unknown task id from wb_status as not found", async () => {
		const h = makeContext();
		harness.start();
		const result = await harness.call("wb_status", { taskId: "99999999-0000-4000-8000-000000000000" }, h.ctx);
		expect(result.isError).toBe(true);
		expect(errorCodeOf(result)).toBe(WB_ERROR_CODE.taskNotFound);
	});
});

describe("terminal commit ordering and storage failures", () => {
	it("commits the terminal receipt before releasing the lock on success", async () => {
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		harness.releaseTurn();
		await harness.waitForStatus(TASK_ID, "completed");

		const terminalWrite = harness.events.indexOf("write:completed");
		const release = harness.events.indexOf("release");
		expect(terminalWrite).toBeGreaterThanOrEqual(0);
		expect(release).toBeGreaterThan(terminalWrite);
	});

	it("keeps the lock and reports the worker outcome when the terminal write fails", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		const beforeWrite = harness.written.get(taskId);
		harness.failTerminalWrite = true;
		harness.releaseTurn();

		// Wait for the commit to fail, not for a release that must never happen.
		const view = await pollUntil(h, taskId, (candidate) => candidate.storageError !== null);

		// The worker's real outcome is preserved, and the storage failure is
		// reported alongside it rather than replacing it.
		expect(view.status).toBe("completed");
		expect(view.error).toBeNull();
		expect(view.storageError?.code).toBe(WB_ERROR_CODE.storageError);
		// The lock was never released, and the old receipt is untouched on disk.
		expect(harness.released).toEqual([]);
		expect(harness.events).not.toContain("release");
		expect(harness.written.get(taskId)).toEqual(beforeWrite);
		// Closing the owned connection is still correct even when the write failed.
		expect(harness.closeCalls).toBe(1);
	});

	it("keeps the committed receipt and reports the failure when the release fails", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.failRelease = true;
		harness.releaseTurn();

		const view = await pollUntil(h, taskId, (candidate) => candidate.storageError !== null);
		expect(view.status).toBe("completed");
		expect(view.storageError?.code).toBe(WB_ERROR_CODE.storageError);
		// The receipt did reach disk before the release was attempted.
		expect(harness.written.get(taskId)?.status).toBe("completed");
		expect(harness.released).toEqual([]);
	});

	it("does not write, cancel or close twice when a late success follows a cancellation", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		await harness.call("wb_cancel", { taskId }, h.ctx);
		const cancelCallsAfterCancel = harness.cancelCalls;
		const closeCallsAfterCancel = harness.closeCalls;
		const writesAfterCancel = harness.events.filter((event) => event.startsWith("write:")).length;

		// The turn finishes successfully after the cancellation.
		harness.releaseTurn({ stopReason: "end_turn" });
		await harness.waitForStatus(taskId, "cancelled");
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await Promise.resolve();
		}

		expect(harness.written.get(taskId)?.status).toBe("cancelled");
		expect(harness.cancelCalls).toBe(cancelCallsAfterCancel);
		expect(harness.closeCalls).toBe(closeCallsAfterCancel);
		expect(harness.events.filter((event) => event.startsWith("write:")).length).toBe(writesAfterCancel);
		expect(harness.promptCalls).toBe(1);
	});

	it("does not re-prepare or re-prompt when a second cancellation arrives", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		await harness.call("wb_cancel", { taskId }, h.ctx);
		const cancels = harness.cancelCalls;
		const second = await harness.call("wb_cancel", { taskId }, h.ctx);

		expect(second.isError).toBe(false);
		expect(detailsOf(second).status).toBe("cancelled");
		expect(harness.cancelCalls).toBe(cancels);
		expect(harness.promptCalls).toBe(1);
	});

	it("reports a failed artifact scan as a task failure without skipping the commit", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "make a report" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.failCollect = true;
		harness.releaseTurn();

		const receipt = await harness.waitForStatus(taskId, "failed");
		expect(receipt?.error?.code).toBe(WB_ERROR_CODE.taskFailed);
		// The failure still went through the whole commit sequence.
		expect(harness.events.indexOf("release")).toBeGreaterThan(harness.events.indexOf("write:failed"));
	});

	it("does not let a cancellation's outcome be overwritten by a late artifact scan", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		// The scan hangs, so the cancellation lands while the turn is still waiting
		// on it. The scan stays parked until the test releases it, so the cancel is
		// started without awaiting it and the scan is released afterwards.
		harness.holdCollect();
		harness.releaseTurn({ stopReason: "end_turn" });
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await Promise.resolve();
		}
		const cancelPromise = harness.call("wb_cancel", { taskId }, h.ctx);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await Promise.resolve();
		}
		harness.finishCollect(["late.md"]);
		const cancel = await cancelPromise;
		expect(detailsOf(cancel).status).toBe("cancelled");

		await harness.waitForStatus(taskId, "cancelled");
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await Promise.resolve();
		}
		// The scan that finished last could not turn the cancellation into a
		// completion, and the cancelled snapshot keeps its own artifacts.
		expect(harness.written.get(taskId)?.status).toBe("cancelled");
		expect(harness.written.get(taskId)?.artifacts).toEqual(["late.md"]);
	});

	it("shows live progress and approval state, and clears approval after a denial", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Deny");
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		const session = harness.lastSession();
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } },
		});
		await session.callbacks.onUpdate({
			sessionId: SESSION_ID,
			update: { sessionUpdate: "tool_call", title: "Writing report.md" },
		});

		const live = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(live.summary).toBe("working on it");
		expect(live.progress).toBe("Writing report.md");
		expect(live.awaitingApproval).toBe(false);
		expect(live.ownedByCurrentProcess).toBe(true);

		const pending = session.callbacks.onRequest("codebuddy.ai/interruptionRequest", interruptionRequest());
		const during = await pollUntil(h, taskId, (candidate) => candidate.awaitingApproval);
		expect(during.status).toBe("awaiting_approval");
		h.hold(false);
		await pending;

		const after = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(after.awaitingApproval).toBe(false);
		expect(after.status).toBe("running");
	});

	it("denies a late approval when the dialog ends because the task was cancelled", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Approve once");
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		const pending = harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		// The cancellation aborts the task while the human is still deciding.
		await harness.call("wb_cancel", { taskId }, h.ctx);
		h.hold(false);

		const answer = await pending;
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
	});

	it("denies an approval that is returned after the task already stopped", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Approve once");
		// The human's selection is already on its way back when the task stops, so
		// the dialog answers "Approve once" instead of ending as a dismissal.
		h.answerDespiteAbort = true;
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		const pending = harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		for (let attempt = 0; attempt < 50 && h.dialogSignals.length === 0; attempt += 1) {
			await Promise.resolve();
		}
		await harness.call("wb_cancel", { taskId }, h.ctx);
		h.hold(false);

		// The decision is re-checked against the task's real state, so a late
		// "Approve once" never authorizes a step whose task is already over.
		const answer = await pending;
		expect(answer).toEqual({ sessionId: SESSION_ID, toolCallId: "call-1", decision: "deny" });
		// A dialog that closed after the task ended must not resurrect the waiting
		// flag: the task is cancelled, not waiting for anything.
		const view = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(view.awaitingApproval).toBe(false);
		expect(view.status).toBe("cancelled");
	});

	it("keeps reporting awaiting approval until the last of two dialogs closes", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Deny");
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		const session = harness.lastSession();

		// Two distinct requests are outstanding at once; both dialogs are held.
		const first = session.callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ interruptionId: "ir-A", toolCallId: "call-A" }),
		);
		const second = session.callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ interruptionId: "ir-B", toolCallId: "call-B" }),
		);
		await pollUntil(h, taskId, (view) => view.awaitingApproval);
		expect((await pollUntil(h, taskId, (view) => view.awaitingApproval)).awaitingApproval).toBe(true);

		// The first dialog closes while the second is still open: the task is still
		// waiting for a human, so the flag must stay set.
		h.releaseNext();
		await first;
		const midView = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(midView.awaitingApproval).toBe(true);

		h.releaseNext();
		await second;
		const settledView = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(settledView.awaitingApproval).toBe(false);
		expect(settledView.status).toBe("running");
	});

	it("drops the waiting flag the moment the commit begins, with both dialogs still open", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Approve once");
		h.answerDespiteAbort = true;
		harness.start();
		const started = await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		const session = harness.lastSession();

		// Two dialogs are open and a human is still deciding on both.
		const first = session.callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ interruptionId: "ir-A", toolCallId: "call-A" }),
		);
		const second = session.callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest({ interruptionId: "ir-B", toolCallId: "call-B" }),
		);
		await pollUntil(h, taskId, (view) => view.awaitingApproval);

		// The cancellation begins a terminal commit while both dialogs are still
		// parked. The waiting flag has to drop at that moment: the task is over, so
		// it is not waiting for a decision even though dialogs are open.
		const cancelling = harness.call("wb_cancel", { taskId }, h.ctx);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const during = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
			if (during.status === "cancelled") {
				expect(during.awaitingApproval).toBe(false);
				break;
			}
			await Promise.resolve();
		}
		await cancelling;

		// Both dialogs then answer "Approve once", too late to mean anything.
		h.releaseNext();
		h.releaseNext();
		const answers = await Promise.all([first, second]);
		for (const answer of answers) {
			expect(answer).toEqual(expect.objectContaining({ decision: "deny" }));
		}

		const after = detailsOf(await harness.call("wb_status", { taskId, waitMs: 0 }, h.ctx));
		expect(after.status).toBe("cancelled");
		expect(after.awaitingApproval).toBe(false);
	});

	it("passes the task signal to the approval dialog so it ends with the task", async () => {
		const h = makeContext();
		h.hold(true);
		h.setAnswer("Approve once");
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);

		const pending = harness.lastSession().callbacks.onRequest(
			"codebuddy.ai/interruptionRequest",
			interruptionRequest(),
		);
		for (let attempt = 0; attempt < 50 && h.dialogSignals.length === 0; attempt += 1) {
			await Promise.resolve();
		}
		// The dialog is given the task's own signal, so aborting the task releases it.
		expect(h.dialogSignals.length).toBe(1);
		expect(h.dialogSignals[0]?.aborted).toBe(false);
		h.hold(false);
		await pending;
	});

	it("reports an expired task's terminal state immediately without waiting", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.failTerminalWrite = true;
		await harness.call("wb_cancel", { taskId }, h.ctx);

		// The turn is still held open, so a wait would time out; the storage
		// failure must be visible regardless.
		const status = await harness.call("wb_status", { taskId, waitMs: 30_000 }, h.ctx);
		expect(detailsOf(status).storageError).not.toBeNull();
	});

	it("does not re-commit a retained task when the session shuts down", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.failTerminalWrite = true;
		await harness.call("wb_cancel", { taskId }, h.ctx);
		const cancels = harness.cancelCalls;
		const writes = harness.events.filter((event) => event.startsWith("write:")).length;

		// Shutdown must observe the already-decided outcome, not overwrite it with
		// its own interruption or cancel the worker a second time.
		await harness.shutdownExtension();

		expect(harness.cancelCalls).toBe(cancels);
		expect(harness.events.filter((event) => event.startsWith("write:")).length).toBe(writes);
		expect(harness.written.get(taskId)?.status).not.toBe("interrupted");
		expect(harness.promptCalls).toBe(1);
	});
});

describe("wb_tasks history listing", () => {
	/** Seeds one stored row the index will report. */
	function seed(
		list: Array<{ taskId: string; sessionId: string; status: TaskReceipt["status"]; updatedAt: number }>,
		taskId: string,
		status: TaskReceipt["status"],
		updatedAt: number,
	): void {
		list.push({ taskId, sessionId: SESSION_ID, status, updatedAt });
	}

	it("pages newest first with a task-id tie-break and reports nextOffset", async () => {
		const h = makeContext();
		harness.start();
		// Two rows share a timestamp, so the task id has to decide the order.
		seed(harness.storedIndex, "bbbbbbbb-0000-4000-8000-000000000001", "completed", 5000);
		seed(harness.storedIndex, "aaaaaaaa-0000-4000-8000-000000000002", "completed", 5000);
		seed(harness.storedIndex, "cccccccc-0000-4000-8000-000000000003", "failed", 9000);

		const first = await harness.call("wb_tasks", { limit: 2 }, h.ctx);
		const firstDetails = tasksDetailsOf(first);
		expect(first.isError).toBe(false);
		expect(firstDetails.total).toBe(3);
		expect(firstDetails.tasks.map((task) => task.taskId)).toEqual([
			"cccccccc-0000-4000-8000-000000000003",
			"aaaaaaaa-0000-4000-8000-000000000002",
		]);
		expect(firstDetails.nextOffset).toBe(2);

		const second = await harness.call("wb_tasks", { limit: 2, offset: 2 }, h.ctx);
		const secondDetails = tasksDetailsOf(second);
		expect(secondDetails.tasks.map((task) => task.taskId)).toEqual(["bbbbbbbb-0000-4000-8000-000000000001"]);
		expect(secondDetails.nextOffset).toBeNull();
	});

	it("filters by status before paging and returns an empty page past the end", async () => {
		const h = makeContext();
		harness.start();
		seed(harness.storedIndex, "aaaaaaaa-0000-4000-8000-000000000001", "completed", 1000);
		seed(harness.storedIndex, "bbbbbbbb-0000-4000-8000-000000000002", "failed", 2000);
		seed(harness.storedIndex, "cccccccc-0000-4000-8000-000000000003", "failed", 3000);

		const filtered = await harness.call("wb_tasks", { status: "failed" }, h.ctx);
		const details = tasksDetailsOf(filtered);
		expect(details.total).toBe(2);
		expect(details.tasks.map((task) => task.taskId)).toEqual([
			"cccccccc-0000-4000-8000-000000000003",
			"bbbbbbbb-0000-4000-8000-000000000002",
		]);

		const beyond = await harness.call("wb_tasks", { status: "failed", offset: 10 }, h.ctx);
		const beyondDetails = tasksDetailsOf(beyond);
		expect(beyond.isError).toBe(false);
		expect(beyondDetails.tasks).toEqual([]);
		expect(beyondDetails.nextOffset).toBeNull();
	});

	it("rejects malformed paging and status parameters", async () => {
		const h = makeContext();
		harness.start();
		for (const params of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ offset: -1 },
			{ offset: 0.5 },
			{ status: "sideways" },
		]) {
			const result = await harness.call("wb_tasks", params, h.ctx);
			expect(result.isError).toBe(true);
			expect(errorCodeOf(result)).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});

	it("reports unreadable stored records without hiding the readable ones", async () => {
		const h = makeContext();
		harness.start();
		seed(harness.storedIndex, "aaaaaaaa-0000-4000-8000-000000000001", "completed", 1000);
		harness.storedWarnings.push({
			taskId: "dddddddd-0000-4000-8000-000000000004",
			error: { code: WB_ERROR_CODE.taskStateInvalid, message: "receipt is corrupt" },
		});

		const result = await harness.call("wb_tasks", {}, h.ctx);
		const details = tasksDetailsOf(result);
		// A damaged record is reported but never counted as a listed task.
		expect(result.isError).toBe(false);
		expect(details.total).toBe(1);
		expect(details.warnings.length).toBe(1);
		expect(textOf(result)).toContain("dddddddd-0000-4000-8000-000000000004");
	});

	it("overlays this process's live task state and storage failure on the stored row", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		// The stored snapshot still says running; the live view is authoritative.
		seed(harness.storedIndex, taskId, "running", 1000);
		harness.failTerminalWrite = true;
		await harness.call("wb_cancel", { taskId }, h.ctx);
		await pollUntil(h, taskId, (view) => view.storageError !== null);

		const result = await harness.call("wb_tasks", {}, h.ctx);
		const details = tasksDetailsOf(result);
		expect(details.tasks.length).toBe(1);
		const row = details.tasks[0];
		expect(row?.status).toBe("cancelled");
		expect(row?.ownedByCurrentProcess).toBe(true);
		expect(row?.storageError?.code).toBe(WB_ERROR_CODE.storageError);

		// The stored row still says running because the terminal write failed, so
		// filtering has to use the live state rather than the stale snapshot.
		const cancelled = await harness.call("wb_tasks", { status: "cancelled" }, h.ctx);
		expect(tasksDetailsOf(cancelled).tasks.length).toBe(1);
		const running = await harness.call("wb_tasks", { status: "running" }, h.ctx);
		expect(tasksDetailsOf(running).tasks).toEqual([]);
	});

	it("filters on the live state rather than the stored snapshot", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		seed(harness.storedIndex, taskId, "running", 1000);
		await harness.call("wb_cancel", { taskId }, h.ctx);
		await harness.waitForStatus(taskId, "cancelled");

		const cancelled = await harness.call("wb_tasks", { status: "cancelled" }, h.ctx);
		expect(tasksDetailsOf(cancelled).tasks.length).toBe(1);
		// The stale "running" row must not claim a task that is really finished.
		const running = await harness.call("wb_tasks", { status: "running" }, h.ctx);
		expect(tasksDetailsOf(running).tasks).toEqual([]);
	});
});

describe("wb_doctor read-only diagnosis", () => {
	it("reports a missing binding and still reports the local lock", async () => {
		const h = makeContext();
		harness.bindingRoot = "";
		harness.readBindingResult = null;
		harness.lockResult = {
			ownerPid: process.pid,
			taskId: "99999999-0000-4000-8000-000000000009",
		};
		harness.start();

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(result.isError).toBe(true);
		expect(details.binding).toBeNull();
		// A missing binding must not hide a lock that is genuinely held.
		expect(details.lock?.taskId).toBe("99999999-0000-4000-8000-000000000009");
		expect(details.issues.some((issue) => issue.code === WB_ERROR_CODE.bindingInvalid)).toBe(true);
		// The worker is never probed without a binding to compare against.
		expect(harness.inspectCalls).toBe(0);
		expect(details.protocolVerified).toBe(false);
	});

	it("reports a live lock as busy and a dead owner's lock as interrupted", async () => {
		const h = makeContext();
		harness.start();

		// A lock owned by this process is genuinely alive.
		harness.lockResult = { ownerPid: process.pid, taskId: "11111111-0000-4000-8000-000000000001" };
		const busy = doctorDetailsOf(await harness.call("wb_doctor", {}, h.ctx));
		expect(busy.lock?.ownerAlive).toBe(true);
		expect(busy.lock?.ownedByCurrentProcess).toBe(false);
		expect(busy.issues.some((issue) => issue.code === WB_ERROR_CODE.busy)).toBe(true);

		// A real exited process gives a pid that is provably gone.
		const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		const deadPid = shortProcess.pid;
		await shortProcess.exited;
		harness.lockResult = { ownerPid: deadPid, taskId: "22222222-0000-4000-8000-000000000002" };
		const reaped = doctorDetailsOf(await harness.call("wb_doctor", {}, h.ctx));
		expect(reaped.lock?.ownerAlive).toBe(false);
		const interrupted = reaped.issues.find((issue) => issue.code === WB_ERROR_CODE.interrupted);
		expect(interrupted).toBeDefined();
		// The recovery advice is the safe one: a normal delegation reclaims it.
		expect(interrupted?.nextAction).toContain("Do not delete the lock by hand");
		expect(harness.released).toEqual([]);
	});

	it("reports an unreadable lock as an error and keeps it", async () => {
		const h = makeContext();
		harness.start();
		harness.lockFailure = new MockWbTaskError(WB_ERROR_CODE.taskStateInvalid, "lock is corrupt");
		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(result.isError).toBe(true);
		expect(details.lock).toBeNull();
		expect(details.issues.some((issue) => issue.code === WB_ERROR_CODE.taskStateInvalid)).toBe(true);
		// Diagnosis never removes the lock it could not read.
		expect(harness.released).toEqual([]);
	});

	it("reports each worker state with the matching severity", async () => {
		const h = makeContext();
		harness.start();
		harness.inspectResult = [
			{ endpoint: "http://127.0.0.1:1001", status: "verified", workbuddyVersion: "5.8.2" },
			{ endpoint: "http://127.0.0.1:1002", status: "busy", workbuddyVersion: "5.8.2" },
			{ endpoint: "http://127.0.0.1:1003", status: "auth_required", workbuddyVersion: null },
			{ endpoint: "http://127.0.0.1:1004", status: "mismatch", workbuddyVersion: "5.8.2" },
			{ endpoint: "http://127.0.0.1:1005", status: "unhealthy", workbuddyVersion: "5.8.2" },
			{ endpoint: "http://127.0.0.1:1006", status: "unknown", workbuddyVersion: null },
		];

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(details.workers.length).toBe(6);
		// A verified worker produces no issue; every other state produces one with
		// the severity that state deserves.
		const codes = details.issues.map((issue) => `${issue.severity}:${issue.code ?? "none"}`);
		expect(codes).not.toContain("error:undefined");
		expect(codes).toContain(`warning:${WB_ERROR_CODE.busy}`);
		expect(codes).toContain(`warning:${WB_ERROR_CODE.authRequired}`);
		expect(codes).toContain(`error:${WB_ERROR_CODE.bindingInvalid}`);
		expect(codes).toContain(`error:${WB_ERROR_CODE.taskFailed}`);
		expect(codes).toContain("warning:none");
		// Only errors make the diagnosis itself a failure.
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not checked here");
	});

	it("is not an error when only warnings are found, and never claims ACP works", async () => {
		const h = makeContext();
		harness.start();
		harness.inspectResult = [
			{ endpoint: "http://127.0.0.1:2001", status: "verified", workbuddyVersion: "5.8.2" },
		];

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(result.isError).toBe(false);
		expect(details.issues).toEqual([]);
		expect(details.protocolVerified).toBe(false);
		// Even with no issues, the text must not imply compatibility was verified.
		expect(textOf(result)).toContain("cannot prove ACP works");
	});

	it("summarises unidentified endpoints once instead of one warning per socket", async () => {
		const h = makeContext();
		harness.start();
		// A machine with many WorkBuddy sockets usually has one real worker and a
		// crowd of unrelated services; the report must stay readable.
		harness.inspectResult = [
			{ endpoint: "http://127.0.0.1:3001", status: "auth_required", workbuddyVersion: null },
			...Array.from({ length: 12 }, (_unused, index) => ({
				endpoint: `http://127.0.0.1:${4000 + index}`,
				status: "unknown",
				workbuddyVersion: null,
			})),
		];

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(details.workers.length).toBe(13);
		// Exactly two findings: the real refusal, and one summary of the rest.
		expect(details.issues.length).toBe(2);
		expect(details.issues.some((issue) => issue.code === WB_ERROR_CODE.authRequired)).toBe(true);
		const summary = details.issues.find((issue) => issue.code === null);
		expect(summary?.message).toContain("12 of 13");
		expect(result.isError).toBe(false);
	});

	it("warns when no worker is found without asserting the worker is stopped", async () => {
		const h = makeContext();
		harness.start();
		harness.inspectResult = [];

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(result.isError).toBe(false);
		expect(details.workers).toEqual([]);
		const warning = details.issues[0];
		expect(warning?.severity).toBe("warning");
		expect(warning?.code).toBeNull();
		expect(warning?.message).toContain("No running worker");
		// An empty inspection cannot distinguish "stopped" from "not found".
		expect(warning?.nextAction).toContain("cannot prove the worker is stopped");
	});

	it("surfaces this process's own storage failure for the project", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.failTerminalWrite = true;
		await harness.call("wb_cancel", { taskId }, h.ctx);
		await pollUntil(h, taskId, (view) => view.storageError !== null);

		const result = await harness.call("wb_doctor", {}, h.ctx);
		const details = doctorDetailsOf(result);
		expect(result.isError).toBe(true);
		expect(details.issues.some((issue) => issue.code === WB_ERROR_CODE.storageError)).toBe(true);
	});

	it("leaves the binding, lock and receipts byte-identical", async () => {
		const h = makeContext();
		harness.start();
		harness.written.set("33333333-0000-4000-8000-000000000003", {
			version: 1,
			taskId: "33333333-0000-4000-8000-000000000003",
			sessionId: SESSION_ID,
			projectRoot: PROJECT_ROOT,
			status: "completed",
			prompt: "done earlier",
			inputFiles: [],
			expectedOutputs: [],
			summary: "ok",
			artifacts: [],
			error: null,
		});

		const before = JSON.stringify([...harness.written.entries()]);
		const releasedBefore = [...harness.released];
		const writesBefore = harness.events.filter((event) => event.startsWith("write:")).length;
		await harness.call("wb_doctor", {}, h.ctx);

		expect(JSON.stringify([...harness.written.entries()])).toBe(before);
		expect(harness.released).toEqual(releasedBefore);
		expect(harness.events.filter((event) => event.startsWith("write:")).length).toBe(writesBefore);
		expect(harness.writtenBindingCalls).toBe(0);
	});
});

describe("footer accuracy and status waits", () => {
	it("reports a storage failure instead of leaving the task looking running", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		h.clearStatuses();
		harness.failTerminalWrite = true;
		await harness.call("wb_cancel", { taskId }, h.ctx);
		await pollUntil(h, taskId, (view) => view.storageError !== null);

		// The footer must not keep claiming the task is running after its commit
		// failed; the last thing it published has to be the storage problem.
		expect(h.statuses.some((text) => text?.includes("storage errors"))).toBe(true);
		const last = h.statuses.at(-1);
		expect(last?.includes("storage errors")).toBe(true);
		expect(last?.includes("running")).toBe(false);
	});

	it("clears the footer once a task is only mid-commit", async () => {
		const h = makeContext();
		harness.start();
		await harness.call("wb_task", { prompt: "do the thing" }, h.ctx);
		h.clearStatuses();
		harness.releaseTurn();

		// A terminal state chosen but not yet committed is not running work.
		await harness.waitForStatus(TASK_ID, "completed");
		expect(h.statuses.some((text) => text === undefined)).toBe(true);
	});

	it("waits for the budget when a running task has not changed", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		// The turn is held open and nothing commits, so the call must use its
		// whole budget rather than returning at once.
		const before = Date.now();
		await harness.call("wb_status", { taskId, waitMs: 250 }, h.ctx);
		const elapsed = Date.now() - before;
		expect(elapsed).toBeGreaterThanOrEqual(200);
	});

	it("returns as soon as the task commits, before the budget expires", async () => {
		const h = makeContext();
		harness.start();
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		const before = Date.now();
		const pending = harness.call("wb_status", { taskId, waitMs: 30_000 }, h.ctx);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await Promise.resolve();
		}
		await harness.call("wb_cancel", { taskId }, h.ctx);
		const result = await pending;
		const elapsed = Date.now() - before;

		expect(detailsOf(result).status).toBe("cancelled");
		// The commit released the waiter, so the 30s budget was not spent.
		expect(elapsed).toBeLessThan(5_000);
	});
});

describe("read-only tools refuse an unresolvable project root", () => {
	it("fails wb_tasks and wb_doctor as storage errors instead of guessing a directory", async () => {
		const h = makeContext({ cwd: path.join(PROJECT_ROOT, "does-not-exist") });
		harness.start();

		const tasks = await harness.call("wb_tasks", {}, h.ctx);
		expect(tasks.isError).toBe(true);
		expect(errorCodeOf(tasks)).toBe(WB_ERROR_CODE.storageError);
		// The index is never consulted for a directory that does not exist.
		expect(harness.tasksIndexCalls).toBe(0);

		const doctor = await harness.call("wb_doctor", {}, h.ctx);
		expect(doctor.isError).toBe(true);
		expect(errorCodeOf(doctor)).toBe(WB_ERROR_CODE.storageError);
		// No worker is probed for a root that could not be resolved.
		expect(harness.inspectCalls).toBe(0);
	});
});

describe("cancellation waits for the worker's turn to end", () => {
	it("keeps the connection open until the turn reports its outcome", async () => {
		const h = makeContext();
		harness.start();
		harness.cancelSettleMs = 5_000;
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		// The cancel is issued while the turn is still running, which is exactly the
		// case that used to close the connection before the worker could wind down.
		const cancelling = harness.call("wb_cancel", { taskId }, h.ctx);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await Promise.resolve();
		}
		// The connection must still be open: the worker has not answered yet.
		expect(harness.closeCalls).toBe(0);

		// The worker reports the turn's end, which releases the wait.
		harness.releaseTurn({ stopReason: "cancelled" });
		const cancelled = await cancelling;

		expect(detailsOf(cancelled).status).toBe("cancelled");
		expect(harness.closeCalls).toBe(1);
	});

	it("releases the connection when the worker never reports the turn ending", async () => {
		const h = makeContext();
		harness.start();
		harness.cancelSettleMs = 30;
		const started = await harness.call("wb_task", { prompt: "long one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}

		// The turn is held open and never answers, so the bounded wait is what ends
		// the hold. Without the bound this call would never return.
		const before = Date.now();
		const cancelled = await harness.call("wb_cancel", { taskId }, h.ctx);
		const elapsed = Date.now() - before;

		expect(detailsOf(cancelled).status).toBe("cancelled");
		expect(elapsed).toBeGreaterThanOrEqual(20);
		expect(harness.closeCalls).toBe(1);
	});

	it("does not wait when the turn already ended before the cancellation", async () => {
		const h = makeContext();
		harness.start();
		harness.cancelSettleMs = 5_000;
		const started = await harness.call("wb_task", { prompt: "quick one" }, h.ctx);
		const taskId = taskIdOf(started);
		if (taskId === undefined) {
			throw new Error("no taskId");
		}
		harness.releaseTurn();
		await harness.waitForStatus(taskId, "completed");

		// A cancellation of an already-finished task joins the committed outcome and
		// must not spend the settle budget on it.
		const before = Date.now();
		const after = await harness.call("wb_cancel", { taskId }, h.ctx);
		expect(Date.now() - before).toBeLessThan(1_000);
		expect(detailsOf(after).status).toBe("completed");
	});
});
