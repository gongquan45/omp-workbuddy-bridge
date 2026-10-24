/**
 * Foreground delivery: opt-in waiting, and what a stop does *not* do.
 *
 * The distinction under test is the one a user feels: "the call stopped waiting"
 * is not "the work stopped". Every wait here is on a signal the stub session
 * exposes, so the cases are deterministic rather than timed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import { closeQueueConnection, enableProject, openWriteConnection } from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { resolveRoundPaths } from "../src/tasks";
import type { DesktopSession, PromptOutcome } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const SESSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const roots: string[] = [];
/**
 * The shutdown of every activation this file started.
 *
 * A real host ends the session, and the activation's own background work —
 * publishing a result fact, delivering a result, advancing the queue — is
 * finished by that shutdown. The fixture's files may only be removed once it
 * has run: a background write still in flight would hold the project open.
 */
const activations: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (activations.length > 0) {
		const stop = activations.pop();
		if (stop !== undefined) {
			await stop();
		}
	}
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await releaseProjectFixture(root);
		}
	}
});

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

/**
 * A session whose turn the test controls.
 *
 * `promptStarted` resolves when the prompt reached the worker, so a test can act
 * at exactly that moment instead of sleeping and hoping.
 */
class ControlledSession {
	readonly prompts: string[] = [];
	cancelCalls = 0;
	closed = false;
	/** When true the turn finishes as soon as it starts. */
	immediate = false;
	private release: (() => void) | null = null;
	private started: (() => void) | null = null;
	private readonly startedPromise: Promise<void>;
	/** Resolves once a prompt has arrived at the worker. */
	readonly promptStarted: Promise<void>;

	constructor() {
		this.startedPromise = new Promise<void>((resolve) => {
			this.started = resolve;
		});
		this.promptStarted = this.startedPromise;
	}

	async prompt(prompt: string): Promise<PromptOutcome> {
		this.prompts.push(prompt);
		this.started?.();
		this.started = null;
		if (!this.immediate) {
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
		}
		return { stopReason: "end_turn" };
	}

	/** Ends the held turn, as a real worker finishing would. */
	finish(): void {
		this.release?.();
		this.release = null;
	}

	async respondToPermission(): Promise<void> {
		// No permission dialogs are raised by this stub.
	}

	async cancel(): Promise<void> {
		this.cancelCalls += 1;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

interface SentMessage {
	customType: unknown;
	content: unknown;
	display: unknown;
	options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}

function makeApi(projectRoot: string, session: ControlledSession) {
	const tools = new Map<string, RegisteredTool>();
	/** Messages this activation handed to the host, in order. */
	const sent: SentMessage[] = [];
	/**
	 * The activation's shutdown handler, captured so the test can shut the
	 * activation down before its project's files are removed.
	 */
	let shutdown: (() => Promise<void>) | null = null;
	// The teardown waits for the activation's background work through the
	// shutdown, so the project's files are never removed while a background
	// write is still in flight.
	activations.push(async () => {
		await shutdown?.();
	});
	let attempts = 0;
	const chain = {
		describe: () => chain,
		strict: () => chain,
		optional: () => chain,
	};
	const api = {
		zod: {
			string: () => chain,
			number: () => chain,
			boolean: () => chain,
			array: () => chain,
			enum: () => chain,
			object: () => chain,
		},
		logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_shutdown") {
				shutdown = handler;
			}
		},
		registerCommand: () => undefined,
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		sendMessage: (message: Record<string, unknown>, options?: SentMessage["options"]) => {
			attempts += 1;
			sent.push({
				customType: message["customType"],
				content: message["content"],
				display: message["display"],
				options,
			});
		},
	} as unknown as ExtensionAPI;
	const overrides: BridgeOverrides = {
		workbuddyHomeDir: path.join(projectRoot, ".test-home"),
		// A cancellation waits for the worker to report its turn ending. The
		// production budget is five seconds; these cases hold a turn open on
		// purpose, so the wait would be spent on every one of them.
		cancelSettleMs: 20,
		// The project's pool really contains this session. A fixture that reports
		// no session at all no longer models a delegation that can run: the queue
		// hands a task to an *enrolled* session, so an empty roster would leave
		// every task waiting for a session that does not exist.
		discover: async () => [
			{
				endpoint: "http://127.0.0.1:19001",
				binding: { version: 1 as const, projectRoot, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
				cwd: projectRoot,
				busy: false,
			},
		],
		connect: async () =>
			({
				binding: { version: 1, projectRoot, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
				prompt: (prompt: string) => session.prompt(prompt),
				respondToPermission: () => session.respondToPermission(),
				cancel: () => session.cancel(),
				close: () => session.close(),
			}) as unknown as DesktopSession,
	};
	return { api, overrides, tools, sent, sendAttempts: attempts };
}

/**
 * A context with UI, answering the round confirmation with "submit".
 *
 * A headless context deliberately stops at `needs_confirmation` and never
 * dispatches, so foreground delivery can only be observed through a UI that
 * actually confirms the round.
 */
function makeContext(dir: string): ExtensionContext {
	return {
		cwd: dir,
		hasUI: true,
		sessionManager: { getSessionId: () => "omp-foreground-session" },
		ui: {
			notify: () => undefined,
			confirm: async () => true,
			select: async (_title: string, choices: string[]) =>
				choices.includes("Submit this round") ? "Submit this round" : choices[0],
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

/** Prepares an enabled, bound project and returns its canonical root. */
async function preparedProject(): Promise<string> {
	const root = await createFixtureRoot("wb-foreground-");
	roots.push(root);
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({
			version: 2,
			projectRoot: root,
			sessionId: SESSION_ID,
			workbuddyVersion: "1.2.3",
			autoBindProjectSessions: true,
			sessions: [{ sessionId: SESSION_ID, workbuddyVersion: "1.2.3" }],
		}),
		"utf-8",
	);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	return root;
}

/** Polls until `predicate` holds, without guessing how long anything takes. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Details of one result, without asserting on its prose. */
function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	return (result.details ?? {}) as Record<string, unknown>;
}

describe("a waiter is released by the commit, not by dispatch", () => {
	it("does not report committed while the turn is still running", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools } = makeApi(root, session);
		// A long budget: if the wait were released by dispatch this would return at
		// once with a pending state instead of expiring.
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const result = await tools.get("wb_task")!.execute(
			"call-not-committed",
			{ goal: { objective: "still working", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const details = detailsOf(result);
		// The prompt is in flight, so nothing is committed and nothing is reviewable.
		expect(session.prompts).toHaveLength(1);
		expect(details.commitState).not.toBe("committed");
		expect(details.readyForReview).toBeFalse();
	}, 30_000);
});

describe("foreground delivery waits for the durable commit", () => {
	it("returns collected artifacts once the commit lands", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 5_000 });

		const pending = tools.get("wb_task")!.execute(
			"call-foreground",
			{ goal: { objective: "write the report", acceptance: ["report exists"] }, expectedOutputs: ["report.md"] },
			undefined,
			undefined,
			makeContext(root),
		);

		// Act exactly when the prompt reaches the worker: write the deliverable where
		// collection expects it, then let the turn finish.
		await session.promptStarted;
		const outputs = resolveRoundPaths(root, await pendingTaskId(root), 1, "round").outputsDir;
		await mkdir(outputs, { recursive: true });
		await writeFile(path.join(outputs, "report.md"), "READY", "utf-8");
		session.finish();

		const result = await pending;
		const details = detailsOf(result);
		expect(details.waitingInterrupted).toBeFalse();
		expect(details.commitState).toBe("committed");
		expect(details.readyForReview).toBeTrue();
		expect((details.artifactPaths as string[]).length).toBeGreaterThan(0);
		expect(session.prompts).toHaveLength(1);
	}, 30_000);

	it("reports an expired wait without failing or cancelling the task", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools } = makeApi(root, session);
		// Zero budget: the wait gives up immediately, which is deterministic.
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const result = await tools.get("wb_task")!.execute(
			"call-timeout",
			{ goal: { objective: "long task", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const details = detailsOf(result);
		expect(details.waitingInterrupted).toBeTrue();
		// Not an error: a stopped wait is a normal outcome, and `isError` is absent
		// rather than false on a successful tool result.
		expect(result.isError ?? false).toBeFalse();
		expect(details.taskId).toBeString();
		// Nothing was cancelled or closed: the task is still in flight.
		expect(session.cancelCalls).toBe(0);
		expect(session.closed).toBeFalse();
		// The text must not send the model into a polling loop: the result arrives on
		// its own, and wb_status is for a specific question.
		const text = (result.content[0] as { text?: string }).text ?? "";
		expect(text).toContain("follow-up message");
		expect(text).toContain("nothing to poll");
	}, 30_000);

	it("waits by default, so a fast turn returns committed artifacts without opting in", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		session.immediate = true;
		const { api, overrides, tools } = makeApi(root, session);
		// No `foregroundWaitMs`: the shipped default window applies.
		activate(api, overrides);
		const result = await tools.get("wb_task")!.execute(
			"call-default",
			{ goal: { objective: "finish immediately", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const details = (result.details ?? {}) as Record<string, unknown>;
		expect(details["waitingInterrupted"]).toBe(false);
		expect(details["status"]).toBe("completed");
		expect(details["commitState"]).toBe("committed");
	}, 30_000);

	it("sends the committed result back as a host follow-up after the wait ended", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools, sent } = makeApi(root, session);
		// A tiny window: the wait gives up, then the turn finishes and the result is owed.
		activate(api, { ...overrides, foregroundWaitMs: 50 });

		const pending = tools.get("wb_task")!.execute(
			"call-followup",
			{ goal: { objective: "write the note", acceptance: ["note exists"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		await session.promptStarted;
		await pending;
		// Nothing is sent merely because the call returned.
		expect(sent).toHaveLength(0);

		session.finish();
		await waitFor(() => sent.length > 0, "the follow-up message");
		const message = sent[0]!;
		// A real host follow-up that starts its own turn, not a silent transcript row.
		expect(message.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
		expect(message.display).toBe(true);
		expect(String(message.content)).toContain("WorkBuddy result for task");
		expect(String(message.content)).toContain("not a receipt or acceptance");
		// The worker was asked once; a follow-up is a report, never a resend.
		expect(session.prompts).toHaveLength(1);
	}, 30_000);

	it("still reports the final result after an explicit background choice", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools, sent } = makeApi(root, session);
		let commands: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		const commandApi = {
			...(api as unknown as Record<string, unknown>),
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands = spec;
			},
		} as unknown as ExtensionAPI;
		activate(commandApi, { ...overrides, foregroundWaitMs: 0 });
		const ctx = makeContext(root);

		const pending = tools.get("wb_task")!.execute(
			"call-background",
			{ goal: { objective: "background work", acceptance: ["done"] } },
			undefined,
			undefined,
			ctx,
		);
		await session.promptStarted;
		const taskId = detailsOf(await pending).taskId as string;

		// The human explicitly chooses background delivery through the command surface.
		await commands!.handler(`background ${taskId}`, ctx);
		const db = openWriteConnection(root);
		let mode: string | null;
		try {
			const row = db.query("SELECT delivery_mode FROM rounds WHERE task_id = ? AND round = 1").get(taskId) as
				| { delivery_mode: string }
				| null;
			mode = row?.delivery_mode ?? null;
		} finally {
			closeQueueConnection(root, "write");
		}
		expect(mode).toBe("background");

		// The result still arrives, exactly once, as a host follow-up.
		session.finish();
		await waitFor(() => sent.length > 0, "the background report");
		await Bun.sleep(100);
		expect(sent).toHaveLength(1);
		expect(String(sent[0]!.content)).toContain("WorkBuddy result for task");
		expect(session.prompts).toHaveLength(1);
	}, 30_000);

	it("reports a result that was never delivered before this OMP session started", async () => {
		const root = await preparedProject();
		// A host that cannot inject a follow-up: the send throws, so the row keeps a
		// claim from a generation that dies with this activation — the shape a crash
		// leaves behind, without any fabrication.
		const deadSession = new ControlledSession();
		const offline = makeApi(root, deadSession);
		let offlineAttempts = 0;
		const offlineApi = {
			...(offline.api as unknown as Record<string, unknown>),
			sendMessage: () => {
				offlineAttempts += 1;
				throw new Error("host could not inject the follow-up");
			},
		} as unknown as ExtensionAPI;
		activate(offlineApi, { ...offline.overrides, foregroundWaitMs: 0 });
		const pending = offline.tools.get("wb_task")!.execute(
			"call-restart",
			{ goal: { objective: "survive a restart", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		await deadSession.promptStarted;
		const view = detailsOf(await pending);
		expect(view.waitingInterrupted).toBeTrue();
		deadSession.finish();
		await waitFor(() => offlineAttempts > 0, "the failed send attempt");

		// The previous activation is gone: this is what a clean shutdown records, and
		// what lets a later generation own the same session's pending rows. (Two
		// activations inside one process genuinely share a pid, so without this the
		// old generation is — correctly — still considered live.)
		const retiring = openWriteConnection(root);
		try {
			retiring.run("UPDATE owners SET state = 'inactive' WHERE session_id = ?", ["omp-foreground-session"]);
		} finally {
			closeQueueConnection(root, "write");
		}

		// The new activation is a different generation of the same stable session.
		const restarted = makeApi(root, new ControlledSession());
		let restartStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
		const restartApi = {
			...(restarted.api as unknown as Record<string, unknown>),
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (name === "session_start") {
					restartStart = handler;
				}
			},
		} as unknown as ExtensionAPI;
		activate(restartApi, { ...restarted.overrides, foregroundWaitMs: 0 });
		expect(restartStart).toBeDefined();
		await restartStart!({ type: "session_start" }, makeContext(root));

		expect(restarted.sent.length).toBeGreaterThan(0);
		expect(String(restarted.sent[0]!.content)).toContain("WorkBuddy result for task");
	}, 30_000);

	it("does not follow up when the wait returned the result in band", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools, sent } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 5_000 });

		const pending = tools.get("wb_task")!.execute(
			"call-inband",
			{ goal: { objective: "finish fast", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		await session.promptStarted;
		session.finish();
		const details = detailsOf(await pending);
		expect(details.waitingInterrupted).toBeFalse();

		// Give the terminal path room to (not) send anything.
		await Bun.sleep(100);
		expect(sent).toHaveLength(0);
	}, 30_000);

	it("does not cancel the worker when the caller's wait is aborted", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 10_000 });

		const controller = new AbortController();
		const pending = tools.get("wb_task")!.execute(
			"call-abort",
			{ goal: { objective: "steerable task", acceptance: ["done"] } },
			controller.signal,
			undefined,
			makeContext(root),
		);
		// Abort only once the prompt is provably in flight.
		await session.promptStarted;
		controller.abort();

		const result = await pending;
		expect(detailsOf(result).waitingInterrupted).toBeTrue();
		// The user steering the conversation never reaches WorkBuddy.
		expect(session.cancelCalls).toBe(0);
		expect(session.closed).toBeFalse();
		expect(session.prompts).toHaveLength(1);
	}, 30_000);

	it("returns a completed task with its commit state on a fast turn", async () => {
		const root = await preparedProject();
		const session = new ControlledSession();
		session.immediate = true;
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 5_000 });

		const result = await tools.get("wb_task")!.execute(
			"call-fast",
			{ goal: { objective: "quick task", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		// Exactly one prompt reached the worker for this submission.
		expect(session.prompts).toHaveLength(1);
		expect(detailsOf(result).commitState).toBe("committed");
		expect(detailsOf(result).waitingInterrupted).toBeFalse();
	}, 30_000);
});

/**
 * The task id of the round this submission created.
 *
 * A submission is one round in the project, so the queue index names it; reading
 * it from there keeps the test independent of the result promise's timing.
 */
async function pendingTaskId(root: string): Promise<string> {
	const { openReadConnection, closeQueueConnection } = await import("../src/queue");
	const db = openReadConnection(root);
	if (db === null) {
		throw new Error("no queue is available for the submission");
	}
	try {
		const row = db.query("SELECT task_id FROM rounds ORDER BY enqueued_at ASC LIMIT 1").get() as
			| { task_id: string }
			| null;
		if (row === null) {
			throw new Error("no task was created by the submission");
		}
		return row.task_id;
	} finally {
		closeQueueConnection(root, "read");
	}
}
