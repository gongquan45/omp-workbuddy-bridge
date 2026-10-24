/**
 * Queue advance and supplemental dispatch, driven through the real tools.
 *
 * These are the two behaviours that only a probe had ever verified: a round queued
 * because its session was busy is delivered once the session frees, and a second
 * dispatch carrying a `taskId` runs as the next round. Both live in closures inside
 * `activate`, so they cannot be called directly — the only honest test drives
 * `wb_task`/`wb_status` and then reads the queue rows the production code wrote.
 *
 * Every assertion is on the queue, never on the tool's own report: `wb_status`
 * derives `commitState` from process-local state, so its opinion is not evidence
 * that a commit landed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import {
	closeQueueConnection,
	enableProject,
	openProjectQueue,
	openReadConnection,
	readRoundResources,
} from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { WB_ERROR_CODE, type DesktopSession, type PromptOutcome } from "../src/types";
import { WbTaskError } from "../src/tasks";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const SESSION_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
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
			closeQueueConnection(root);
			closeQueueConnection(root, "read");
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
 * A session whose first turn can be held open.
 *
 * A busy session is what queues a later round, so the test has to keep one turn in
 * flight at a chosen moment rather than racing a timer.
 */
class GateSession {
	readonly prompts: string[] = [];
	/** Turns that have started but not finished. */
	private readonly releasers: Array<() => void> = [];
	private readonly starters: Array<() => void> = [];
	private hold = true;

	async prompt(prompt: string): Promise<PromptOutcome> {
		this.prompts.push(prompt);
		const started = this.starters.shift();
		started?.();
		if (this.hold) {
			await new Promise<void>((resolve) => this.releasers.push(resolve));
		}
		return { stopReason: "end_turn" };
	}

	/** Resolves the next time a prompt reaches the worker. */
	nextPrompt(): Promise<void> {
		return new Promise<void>((resolve) => this.starters.push(resolve));
	}

	/** Ends the oldest held turn. */
	finishOne(): void {
		this.releasers.shift()?.();
	}

	/** Lets every later turn finish on its own. */
	stopHolding(): void {
		this.hold = false;
		this.finishOne();
	}

	async respondToPermission(): Promise<void> {
		// No permission dialogs are raised by this stub.
	}

	async cancel(): Promise<void> {
		// Cancellation is not the subject here.
	}

	async close(): Promise<void> {
		// The stub owns no resources.
	}
}

/** One message the fixture's host handed to the conversation. */
interface SentMessage {
	customType: unknown;
	content: unknown;
	display: unknown;
	options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}

function makeApi(projectRoot: string, session: GateSession) {
	const tools = new Map<string, RegisteredTool>();
	/** Messages this activation handed to the host, in order. */
	const sent: SentMessage[] = [];
	/**
	 * The activation's shutdown handler, captured so the test can shut the
	 * activation down before its project's files are removed.
	 *
	 * A real host fires this when the session ends, and the activation's own
	 * background work — publishing a result fact, delivering a result, advancing
	 * the queue — is finished by it. A test that skips it would remove the
	 * project's files while that work was still running.
	 */
	let shutdown: (() => Promise<void>) | null = null;
	// The activation registers its shutdown handler on this object, so the
	// teardown can wait for the activation's background work before the
	// project's files are removed. The handler is read at shutdown time, so it
	// does not matter that the activation registers it after this point.
	activations.push(async () => {
		await shutdown?.();
	});
	const chain = { describe: () => chain, strict: () => chain, optional: () => chain };
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
		// The host hands a committed result to the conversation as a follow-up
		// message. The fixture records it, exactly as the real host would, so a
		// delivery that cannot happen is visible instead of silent.
		sendMessage: (message: Record<string, unknown>, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
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
		// no session at all no longer models a delegation that can run: the
		// queue hands a task to an *enrolled* session, so an empty roster would
		// leave every task waiting for a session that does not exist.
		discover: async () => [
			{
				endpoint: "http://127.0.0.1:18001",
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
	return { api, overrides, tools, sent };
}

function makeContext(dir: string): ExtensionContext {
	return {
		cwd: dir,
		hasUI: true,
		sessionManager: { getSessionId: () => "omp-advance-session" },
		ui: {
			notify: () => undefined,
			confirm: async () => true,
			select: async (_title: string, choices: string[]) =>
				choices.includes("Submit this round") ? "Submit this round" : choices[0],
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

async function preparedProject(sessionIds: string[] = [SESSION_ID]): Promise<string> {
	const root = await createFixtureRoot("wb-advance-");
	roots.push(root);
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({
			version: 2,
			projectRoot: root,
			sessionId: sessionIds[0],
			workbuddyVersion: "1.2.3",
			autoBindProjectSessions: true,
			sessions: sessionIds.map((sessionId) => ({ sessionId, workbuddyVersion: "1.2.3" })),
		}),
		"utf-8",
	);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	return root;
}

function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	return (result.details ?? {}) as Record<string, unknown>;
}

/** Every round row in the project, oldest first. */
function rows(root: string): Array<Record<string, unknown>> {
	const db = openReadConnection(root);
	if (db === null) {
		return [];
	}
	try {
		return db.query("SELECT * FROM rounds ORDER BY enqueued_at ASC").all() as Array<Record<string, unknown>>;
	} finally {
		closeQueueConnection(root, "read");
	}
}

/** Resources gating one round, or null when the queue cannot be read. */
function resources(root: string, taskId: string, round: number) {
	const db = openReadConnection(root);
	if (db === null) {
		return null;
	}
	try {
		return readRoundResources(db, taskId, round);
	} finally {
		closeQueueConnection(root, "read");
	}
}

/** Polls until `predicate` holds, without guessing how long anything takes. */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("task-isolated WorkBuddy session pool", () => {
	it("runs unrelated tasks in distinct project sessions without mixing their prompts", async () => {
		const root = await preparedProject();
		const secondSessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([[SESSION_ID, firstWorker], [secondSessionId, secondWorker]]);
		const { api, overrides, tools } = makeApi(root, firstWorker);
		const candidates = [...workers.keys()].map((sessionId, index) => ({
			endpoint: `http://127.0.0.1:${18001 + index}`,
			binding: { version: 1 as const, projectRoot: root, sessionId, workbuddyVersion: "1.2.3" },
			busy: false,
		}));
		await writeFile(
			path.join(root, ".wb-bridge", "binding.json"),
			JSON.stringify({
				version: 2,
				projectRoot: root,
				sessionId: SESSION_ID,
				workbuddyVersion: "1.2.3",
				sessions: candidates.map(({ binding }) => ({ sessionId: binding.sessionId })),
			}),
			"utf-8",
		);
		const connected: string[] = [];
		activate(api, {
			...overrides,
			foregroundWaitMs: 0,
			discover: async () => candidates,
			connect: async (binding) => {
				const worker = workers.get(binding.sessionId);
				if (worker === undefined) throw new Error(`Unexpected target ${binding.sessionId}`);
				connected.push(binding.sessionId);
				return {
					binding,
					prompt: (prompt: string) => worker.prompt(prompt),
					respondToPermission: () => worker.respondToPermission(),
					cancel: () => worker.cancel(),
					close: () => worker.close(),
				} as unknown as DesktopSession;
			},
		});
		try {
			const first = await tools.get("wb_task")!.execute(
				"first-independent-task",
				{ goal: { objective: "Analyze sales report", acceptance: ["Complete the requested report"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			await until(() => firstWorker.prompts.length === 1, "the first isolated task");
			const second = await tools.get("wb_task")!.execute(
				"second-independent-task",
				{ goal: { objective: "Draft outreach report", acceptance: ["Complete the requested report"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(first)["status"]).toBe("running");
			expect(detailsOf(second)["status"]).toBe("running");
			await until(() => secondWorker.prompts.length === 1, "the second independent task");
			expect(new Set(connected)).toEqual(new Set([SESSION_ID, secondSessionId]));
			expect(firstWorker.prompts).toHaveLength(1);
			expect(secondWorker.prompts).toHaveLength(1);
			expect(firstWorker.prompts[0]).toContain("Analyze sales report");
			expect(secondWorker.prompts[0]).toContain("Draft outreach report");
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await until(() => rows(root).every((row) => row["commit_state"] === "committed"), "isolated task cleanup");
		}
	}, 15_000);
});

describe("a queued round advances when its session frees", () => {
	it("keeps a native busy target unsent and dispatches automatically when it becomes free", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		let busy = true;
		const targets: string[] = [];
		activate(api, {
			...overrides,
			foregroundWaitMs: 0,
			connect: async (...args) => {
				targets.push(args[0].sessionId);
				if (busy) {
					throw new WbTaskError(WB_ERROR_CODE.busy, "The desktop owns this session");
				}
				return overrides.connect!(...args);
			},
		});
		try {
			const result = await tools.get("wb_task")!.execute("native-busy", {
				goal: { objective: "Prepare a project note", context: "", constraints: [], acceptance: ["Complete the note"], externalActions: [] },
				expectedOutputs: [],
			}, undefined, undefined, makeContext(root));
			const details = detailsOf(result);
			expect(details["status"]).toBe("queued");
			expect(session.prompts).toEqual([]);
			expect(rows(root)[0]?.["dispatch_state"]).toBe("not_sent");
			expect(rows(root)[0]?.["outcome_json"]).toBeNull();

			busy = false;
			await until(() => session.prompts.length === 1, "automatic dispatch without a status query");
			expect(new Set(targets)).toEqual(new Set([SESSION_ID]));
			session.stopHolding();
			await until(() => rows(root)[0]?.["commit_state"] === "committed", "the resumed round's receipt");
			expect(rows(root)[0]?.["status"]).toBe("completed");
			expect(session.prompts.length).toBe(1);
		} finally {
			busy = false;
			session.stopHolding();
		}
	}, 15_000);

	it("yields to ordinary user input without cancelling work or changing foreground delivery", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		let onInput: ((event: { type: "input"; text: string; source: "interactive" }, ctx: ExtensionContext) => unknown) | undefined;
		const registering = {
			...api,
			on: (name: string, handler: typeof onInput) => {
				if (name === "input") onInput = handler;
			},
		} as unknown as ExtensionAPI;
		activate(registering, { ...overrides, foregroundWaitMs: 10_000 });
		const ctx = makeContext(root);
		const started = session.nextPrompt();
		const submitted = tools.get("wb_task")!.execute("ordinary-input", {
			goal: { objective: "Keep preparing the note", acceptance: ["Complete the note"] },
		}, undefined, undefined, ctx);
		let returned: AgentToolResult<unknown> | undefined;
		void submitted.then((result) => { returned = result; });
		try {
			await started;
			await onInput?.({ type: "input", text: "Continue this other discussion", source: "interactive" }, ctx);
			await until(() => returned !== undefined, "ordinary input ending only the foreground wait");
			expect(detailsOf(returned!)["waitingInterrupted"]).toBe(true);
			expect(rows(root)[0]?.["delivery_mode"]).toBe("foreground");
			expect(rows(root)[0]?.["dispatch_state"]).toBe("possibly_sent");
			expect(rows(root)[0]?.["outcome_json"]).toBeNull();
			session.stopHolding();
			await until(() => rows(root)[0]?.["commit_state"] === "committed", "the unchanged worker finishing");
			expect(rows(root)[0]?.["status"]).toBe("completed");
			expect(session.prompts.length).toBe(1);
		} finally {
			session.stopHolding();
			await submitted;
		}
	}, 15_000);

	it("lets a second originating OMP session release its own verified stopped round", async () => {
		const root = await preparedProject([SESSION_ID, "88888888-9999-4aaa-8bbb-cccccccccccc"]);
		const session = new GateSession();
		session.stopHolding();
		// The second origin needs a session of its own: a finished conversation
		// is never reused for an unrelated task, so the first origin's session is
		// not available to the second one.
		const secondSessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
		const { api, overrides, tools } = makeApi(root, session);
		let loseConnection = false;
		activate(api, {
			...overrides, foregroundWaitMs: 0,
			discover: async () => [
				{
					endpoint: "http://127.0.0.1:18001",
					binding: { version: 1 as const, projectRoot: root, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
					cwd: root,
					busy: false,
				},
				{
					endpoint: "http://127.0.0.1:18002",
					binding: { version: 1 as const, projectRoot: root, sessionId: secondSessionId, workbuddyVersion: "1.2.3" },
					cwd: root,
					busy: false,
				},
			],
			connect: async (binding, callbacks, signal) => {
				const connected = await overrides.connect!(binding, callbacks, signal);
				if (loseConnection) connected.prompt = async () => { throw new Error("Connection lost after send"); };
				return connected;
			},
		});
		const request = { goal: { objective: "Prepare the note", acceptance: ["Complete the note"] } };
		await tools.get("wb_task")!.execute("first-origin", request, undefined, undefined, makeContext(root));
		await until(() => rows(root)[0]?.["commit_state"] === "committed", "the first origin finishing");
		loseConnection = true;
		const second = {
			...makeContext(root),
			sessionManager: { getSessionId: () => "omp-second-session" },
		} as unknown as ExtensionContext;
		await tools.get("wb_task")!.execute("second-origin", request, undefined, undefined, second);
		await until(() => rows(root)[1]?.["commit_state"] === "committed", "the second origin's interrupted result");
		const row = rows(root)[1]!;
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			const verification = {
				source: "host_dialog" as const, at: new Date().toISOString(), evidence: "Human checked the exact stopped session",
			};
			const releasing = {
				sessionId: "omp-second-session", generation: String(row["owner_generation"]),
				instanceId: String(row["executor_instance"]), processId: process.pid,
			};
			const swapped = queue.releaseQuarantine({
				taskId: String(row["task_id"]), round: Number(row["round"]), sessionId: secondSessionId,
				authorization: {
					kind: "owner_release",
					owner: { ...releasing, generation: String(rows(root)[0]?.["owner_generation"]) },
					verification,
				},
				now: Date.now(),
			});
			expect(swapped.kind).toBe("refused");
			expect(queue.holds().length).toBe(1);
			const released = queue.releaseQuarantine({
				taskId: String(row["task_id"]), round: Number(row["round"]), sessionId: secondSessionId,
				authorization: { kind: "owner_release", owner: releasing, verification },
				now: Date.now(),
			});
			expect(released.kind).toBe("released");
			expect(queue.holds()).toEqual([]);
			expect(rows(root)[1]?.["status"]).toBe("interrupted");
		} finally {
			queue.close();
		}
	}, 15_000);

	it("does not reuse a finished conversation for an unrelated task", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));

		const firstStarted = session.nextPrompt();
		const first = await call("wb_task", { goal: { objective: "hold the session", acceptance: ["done"] } });
		await firstStarted;
		const firstId = detailsOf(first)["taskId"] as string;
		expect(firstId).toBeString();

		// The session is taken, so this round must queue rather than double-book it.
		const second = await call("wb_task", { goal: { objective: "wait for the session", acceptance: ["done"] } });
		const secondDetails = detailsOf(second);
		expect(secondDetails["status"]).toBe("queued");
		const secondId = secondDetails["taskId"] as string;

		// Exactly one row per round, both queued or beyond, none committed yet.
		expect(rows(root)).toHaveLength(2);
		expect(rows(root).every((row) => row["commit_state"] !== "committed")).toBeTrue();

		// Free the session: the commit that releases it is what should advance the queue.
		session.stopHolding();
		await until(
			() => rows(root).some((row) => row["commit_state"] === "committed"),
			"the first round to commit",
		);

		// The finished conversation is not handed to the unrelated second task:
		// its context already carries the first task's work, and a second,
		// unrelated job in the same conversation would inherit it. The round stays
		// queued, waiting for another WorkBuddy session of this project.
		await until(
			() => {
				const row = rows(root).find((entry) => entry["task_id"] === secondId);
				return row !== undefined && row["status"] === "queued";
			},
			"the second round to stay queued",
		);
		const decided = rows(root).find((entry) => entry["task_id"] === secondId);
		// It stays unassigned: no session was free for it.
		expect(String(decided?.["selected_session"] ?? "")).toBe("");

		// One send per round that was actually dispatched: the reused session saw
		// exactly the first task's prompt.
		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toContain("hold the session");
	}, 15_000);

	/**
	 * A `changes_requested` review must actually produce the task's one correction:
	 * a second round of the same task, sent through the same fence, with the review's
	 * reservation consumed by the arm rather than by a second bookkeeping path.
	 */
	it("starts the task's one correction from a changes_requested review", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });
		const ctx = makeContext(root);
		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, ctx);

		const started = session.nextPrompt();
		const dispatched = await call("wb_task", {
			goal: { objective: "write the summary", acceptance: ["totals are correct"] },
		});
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await started;
		session.stopHolding();
		await until(() => rows(root)[0]?.["commit_state"] === "committed", "the first round to commit");

		const review = await call("wb_review", {
			taskId,
			verdict: "changes_requested",
			findings: [
				{ criterion: "totals are correct", status: "failed", note: "the January total was wrong", evidence: ["read the table"] },
			],
			artifacts: [],
		});
		// The review is accepted and the correction it authorized is already the next
		// round of the same task, dispatched through the same fence.
		const correctionView = detailsOf(review);
		expect(correctionView["taskId"]).toBe(taskId);
		expect(correctionView["round"]).toBe(2);
		expect(correctionView["status"]).toBe("running");

		// The correction is the same task's next round, and it really gets sent.
		await until(() => session.prompts.length === 2, "the correction round to be prompted");
		await until(() => rows(root).some((row) => Number(row["round"]) === 2), "the correction row to exist");
		const correction = rows(root).find((row) => Number(row["round"]) === 2)!;
		expect(correction["purpose"]).toBe("rework");
		expect(correction["task_id"]).toBe(taskId);

		const db = openReadConnection(root);
		let correctionState: string | null;
		try {
			const row = db!.query("SELECT state FROM task_corrections WHERE task_id = ?").get(taskId) as { state: string } | null;
			correctionState = row?.state ?? null;
		} finally {
			closeQueueConnection(root, "read");
		}
		// Arming is what spends the one allowance.
		expect(correctionState).toBe("consumed");

		await until(() => rows(root).every((row) => row["commit_state"] === "committed"), "both rounds to commit");
		expect(session.prompts).toHaveLength(2);
	}, 30_000);

	it("closes the result notification when the round is reviewed", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });
		const ctx = makeContext(root);
		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, ctx);

		const started = session.nextPrompt();
		const dispatched = await call("wb_task", {
			goal: { objective: "write the note", acceptance: ["note exists"] },
		});
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await started;
		session.stopHolding();
		await until(() => rows(root)[0]?.["commit_state"] === "committed", "the round to commit");

		// The committed result is a durable fact, so it is waiting to be consumed.
		const db = openReadConnection(root)!;
		let pendingBefore = 0;
		try {
			pendingBefore = (db.query("SELECT COUNT(*) AS n FROM outbox WHERE acknowledged_at IS NULL").get() as { n: number }).n;
		} finally {
			closeQueueConnection(root, "read");
		}
		expect(pendingBefore).toBe(1);

		const review = await call("wb_review", {
			taskId,
			verdict: "accepted",
			findings: [{ criterion: "note exists", status: "passed", note: "the file is there", evidence: ["listed outputs"] }],
			artifacts: [],
		});
		expect(detailsOf(review)["reviewId"]).toBeString();

		// A review is the evidence that this conversation consumed the notification.
		const after = openReadConnection(root)!;
		let pendingAfter: number;
		let acknowledged: number;
		try {
			pendingAfter = (after.query("SELECT COUNT(*) AS n FROM outbox WHERE acknowledged_at IS NULL").get() as { n: number }).n;
			acknowledged = (after.query("SELECT COUNT(*) AS n FROM outbox WHERE acknowledged_at IS NOT NULL").get() as { n: number }).n;
		} finally {
			closeQueueConnection(root, "read");
		}
		expect(pendingAfter).toBe(0);
		expect(acknowledged).toBe(1);
	}, 30_000);

	it("does not show another OMP session's result through /wb results", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const notices: string[] = [];
		const registering = {
			...api,
			registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands.set(name, spec);
			},
		} as unknown as ExtensionAPI;
		activate(registering, { ...overrides, foregroundWaitMs: 0 });

		// Dispatch from one OMP session.
		const ownerCtx = makeContext(root);
		const started = session.nextPrompt();
		const dispatched = await tools.get("wb_task")!.execute(
			"call-owned",
			{ goal: { objective: "write the note", acceptance: ["done"] } },
			undefined,
			undefined,
			ownerCtx,
		);
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await started;
		session.stopHolding();
		await until(() => rows(root)[0]?.["commit_state"] === "committed", "the round to commit");

		// A different OMP conversation asks for that task's details.
		const otherCtx = {
			...makeContext(root),
			sessionManager: { getSessionId: () => "omp-other-session" },
			ui: {
				notify: (message: string) => { notices.push(message); },
				confirm: async () => true,
				select: async (_title: string, choices: string[]) => choices[0],
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext;
		notices.length = 0;
		await commands.get("wb")!.handler(`results ${taskId}`, otherCtx);
		expect(notices.join("\n")).toContain("different OMP session");
		// And its own inbox is empty: the fact belongs to the other conversation.
		notices.length = 0;
		await commands.get("wb")!.handler("results", otherCtx);
		expect(notices.join("\n")).toContain("No unconsumed results");
	}, 30_000);

	it("refuses to dispatch a queued round the user cancelled", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));

		const firstStarted = session.nextPrompt();
		await call("wb_task", { goal: { objective: "hold the session", acceptance: ["done"] } });
		await firstStarted;

		const second = await call("wb_task", { goal: { objective: "cancel me before I run", acceptance: ["done"] } });
		const secondId = detailsOf(second)["taskId"] as string;
		expect(detailsOf(second)["status"]).toBe("queued");

		// A queued round has no receipt yet, so cancelling it must go through the queue.
		const cancelled = await call("wb_cancel", { taskId: secondId });
		expect(cancelled.isError ?? false).toBeFalse();
		const cancelledRow = rows(root).find((row) => row["task_id"] === secondId)!;
		expect(cancelledRow["status"]).toBe("cancelled");
		expect(cancelledRow["cancel_requested"]).toBe(1);

		// Freeing the session must not deliver cancelled work; the count is the proof.
		const promptCount = session.prompts.length;
		session.stopHolding();
		await until(
			() => rows(root).every((row) => row["commit_state"] === "committed"),
			"the live round to commit",
		);
		await Bun.sleep(50);
		expect(session.prompts).toHaveLength(promptCount);
		expect(rows(root).find((row) => row["task_id"] === secondId)!["status"]).toBe("cancelled");
	}, 30_000);
});

describe("supplemental dispatch", () => {
	it("runs a second round on the same task without touching the first", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		session.stopHolding();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));

		const first = await call("wb_task", { goal: { objective: "round one", acceptance: ["done"] } });
		const taskId = detailsOf(first)["taskId"] as string;
		await until(() => rows(root).some((row) => row["commit_state"] === "committed"), "round 1 to commit");
		const firstRow = rows(root).find((row) => row["round"] === 1)!;

		const second = await call("wb_task", {
			taskId,
			goal: { objective: "round two", acceptance: ["done"] },
		});
		expect(second.isError ?? false).toBeFalse();
		expect(detailsOf(second)["round"]).toBe(2);

		await until(
			() => rows(root).filter((row) => row["commit_state"] === "committed").length === 2,
			"round 2 to commit",
		);

		const committed = rows(root);
		expect(committed.map((row) => row["round"])).toEqual([1, 2]);
		expect(committed.every((row) => row["status"] === "completed")).toBeTrue();
		// Round 1 is history now: a supplemental round must not rewrite it.
		expect(committed.find((row) => row["round"] === 1)).toEqual(firstRow);

		// A third round is what catches round arithmetic derived from the array length:
		// a per-round receipt holds one entry, so `rounds.length` yields 2 forever and the
		// next round collides with an existing row instead of advancing to 3.
		const secondRow = rows(root).find((row) => row["round"] === 2)!;
		const third = await call("wb_task", {
			taskId,
			goal: { objective: "round three", acceptance: ["done"] },
		});
		expect(third.isError ?? false).toBeFalse();
		expect(detailsOf(third)["round"]).toBe(3);
		await until(
			() => rows(root).filter((row) => row["commit_state"] === "committed").length === 3,
			"round 3 to commit",
		);

		const all = rows(root);
		expect(all.map((row) => row["round"])).toEqual([1, 2, 3]);
		expect(all.every((row) => row["status"] === "completed")).toBeTrue();
		// Neither earlier round may be rewritten by the newest one.
		expect(all.find((row) => row["round"] === 1)).toEqual(firstRow);
		expect(all.find((row) => row["round"] === 2)).toEqual(secondRow);
		expect(session.prompts).toHaveLength(3);
	});

	/**
	 * A clean exit must retire this activation's owner row. Leaving it `active` with a
	 * dead pid is not survivable on Windows, where pids are reused quickly: the next
	 * process would read that generation as alive and never recover its holds. "Provably
	 * dead" has to be a declaration, not an inference from a recycled pid.
	 */
	it("retires its owner generation on shutdown", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		session.stopHolding();
		const { api, overrides, tools } = makeApi(root, session);
		const handlers = new Map<string, () => Promise<void>>();
		const registering = {
			...api,
			on: (name: string, handler: () => Promise<void>) => {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI;
		activate(registering, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));
		await call("wb_task", { goal: { objective: "register an owner", acceptance: ["done"] } });
		await until(() => rows(root).some((row) => row["commit_state"] === "committed"), "the round to commit");

		const states = () => {
			const db = openReadConnection(root);
			if (db === null) {
				return [];
			}
			try {
				return db.query("SELECT state FROM owners").all() as Array<{ state: string }>;
			} finally {
				closeQueueConnection(root, "read");
			}
		};
		expect(states().some((owner) => owner.state === "active")).toBeTrue();

		await handlers.get("session_shutdown")?.();

		// Every generation this activation registered is now inactive, so the next process
		// can prove it gone without trusting a pid.
		expect(states().filter((owner) => owner.state === "active")).toEqual([]);
	});
	/**
	 * A stage whose bytes no longer match the approved digest is not retryable: every
	 * resume would re-read the same bytes and fail identically, leaving a permanent
	 * `queued` row with the real problem recorded nowhere. It has to end as a storage
	 * failure — and it must not be sent.
	 */
	it("fails a queued round whose staged payload was replaced, without sending it", async () => {
		const root = await preparedProject([SESSION_ID, "88888888-9999-4aaa-8bbb-cccccccccccc"]);
		const session = new GateSession();
		// The queued round needs a session of its own to be claimed: a finished
		// conversation is never reused for an unrelated task, so the first
		// task's session is not available to the second one.
		const secondSessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
		const { api, overrides, tools } = makeApi(root, session);
		// The second session starts occupied, so the round waits. It is freed
		// after the tamper, which is what makes the queue claim the round and
		// resume it against the replaced bytes.
		let secondSessionBusy = true;
		activate(api, {
			...overrides, foregroundWaitMs: 0,
			discover: async () => [
				{
					endpoint: "http://127.0.0.1:18001",
					binding: { version: 1 as const, projectRoot: root, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
					cwd: root,
					busy: false,
				},
				{
					endpoint: "http://127.0.0.1:18002",
					binding: { version: 1 as const, projectRoot: root, sessionId: secondSessionId, workbuddyVersion: "1.2.3" },
					cwd: root,
					busy: secondSessionBusy,
				},
			],
		});

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));

		const held = session.nextPrompt();
		await call("wb_task", { goal: { objective: "hold the session", acceptance: ["done"] } });
		await held;
		const queued = await call("wb_task", { goal: { objective: "tamper target", acceptance: ["done"] } });
		const queuedId = detailsOf(queued)["taskId"] as string;
		expect(detailsOf(queued)["status"]).toBe("queued");

		// Replace the staged payload while leaving its own approval digest untouched: only a
		// comparison against the queue's recorded digest can catch this.
		const db = openReadConnection(root)!;
		const manifestPath = (
			db.query("SELECT manifest_path FROM rounds WHERE task_id = ?").get(queuedId) as { manifest_path: string }
		).manifest_path;
		closeQueueConnection(root, "read");
		const record = JSON.parse(await Bun.file(manifestPath).text()) as { payload: { goal: { objective: string } } };
		record.payload.goal.objective = "a different objective";
		await Bun.write(manifestPath, JSON.stringify(record, null, 2));

		const promptsBefore = session.prompts.length;
		session.stopHolding();
		// The second session frees, so the queue claims the round and resumes it
		// against the replaced bytes. The digest check is what refuses it.
		secondSessionBusy = false;
		await until(
			() => rows(root).some((row) => row["task_id"] === queuedId && row["commit_state"] === "failed"),
			"the tampered round to fail",
		);
		// The row is the evidence, not a guessed delay.

		const row = rows(root).find((entry) => entry["task_id"] === queuedId)!;
		expect(row["status"]).toBe("failed");
		expect(row["phase"]).toBe("recovery_required");
		// The decisive part: it was never sent, so it cannot be retried into a second send.
		expect(session.prompts).toHaveLength(promptsBefore);
	}, 30_000);
	/**
	 * A delegated round is visible through the collaboration context too, not only through
	 * `wb_tasks`: dispatch no longer claims a file collaboration record for a queue-backed
	 * round, so a listing built from files alone reports a project doing work as idle.
	 *
	 * The merge happens before the filters, so `includeClosed` and paging apply to both
	 * sources alike — a released round is filtered out of the default listing exactly as a
	 * released file record is.
	 */
	it("lists a queue-backed delegation in the project context while it holds scope", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, makeContext(root));

		const held = session.nextPrompt();
		const dispatched = await call("wb_task", { goal: { objective: "context visible", acceptance: ["done"] } });
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await held;

		// A second queued round is what makes paging observable: with one record a `limit: 1`
		// assertion passes whether or not the listing pages at all. It comes from the queue,
		// because the file writer is no longer a second source of active work.
		const second = await call("wb_task", { goal: { objective: "context paging", acceptance: ["done"] } });
		expect(detailsOf(second)["status"]).toBe("queued");

		const { getProjectContext } = await import("../src/collaboration");
		const live = await getProjectContext(root, {});
		const entry = live.entries.find((candidate) => candidate.title === "context visible");
		expect(entry).toBeDefined();
		expect(entry!.owner).toBe("omp");
		expect(entry!.state).toBe("active");

		const limited = await getProjectContext(root, { limit: 1 });
		expect(limited.entries).toHaveLength(1);
		expect(limited.total).toBeGreaterThanOrEqual(2);
		expect(limited.nextOffset).toBe(1);

		// The detail half resolves the same id: a round's own workId must not 404.
		const { delegatedWorkId } = await import("../src/tasks");
		const detail = await getProjectContext(root, { workId: delegatedWorkId(taskId, 1) });
		expect(detail.detail?.record.title).toBe("context visible");

		// Once the first round releases its scope, the default listing no longer reports it.
		session.stopHolding();
		await until(() => rows(root).some((row) => row["commit_state"] === "committed"), "the round to commit");
		const after = await getProjectContext(root, {});
		expect(after.entries.some((candidate) => candidate.title === "context visible")).toBeFalse();

		// The second round is still queued; cancel it so no scheduler wake-up outlives the
		// fixture (a live timer opening the database races the fixture's cleanup).
		await call("wb_cancel", { taskId: detailsOf(second)["taskId"] });
		await until(
			() => rows(root).every((row) => row["commit_state"] === "committed"),
			"the queued round's cancellation to commit",
		);
	}, 30_000);
	/**
	 * The command surface must reuse the tool rather than re-derive its wording: a
	 * command with its own formatting is a second answer that drifts. It also must not
	 * guess which task to stop — cancelling "the only one running" is how the wrong task
	 * gets cancelled.
	 */
	it("runs /wb tasks and /wb cancel through the same implementation as the tools", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const notices: string[] = [];
		const registering = {
			...api,
			registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands.set(name, spec);
			},
		} as unknown as ExtensionAPI;
		activate(registering, { ...overrides, foregroundWaitMs: 0 });

		const ctx = makeContext(root) as ExtensionContext & { ui: { notify: (message: string, level: string) => void } };
		(ctx.ui as { notify: (message: string) => void }).notify = (message: string) => {
			notices.push(message);
		};
		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, ctx);

		const held = session.nextPrompt();
		const dispatched = await call("wb_task", { goal: { objective: "command surface", acceptance: ["done"] } });
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await held;

		const wb = commands.get("wb")!;
		notices.length = 0;
		await wb.handler("tasks", ctx);
		// The listing is the tool's text, which names the project and the match count.
		expect(notices.join("\n")).toContain("matching");

		notices.length = 0;
		await wb.handler(`cancel ${taskId}`, ctx);
		expect(notices.join("\n")).toContain("cancelled");
		const row = rows(root).find((entry) => entry["task_id"] === taskId)!;
		expect(row["status"]).toBe("cancelled");

		// The worker is told to stop, but the notification is one-way: the turn
		// ends when the worker ends it. Releasing it here is what lets the
		// connection close and the fixture be cleaned up.
		session.stopHolding();
		await until(
			() => rows(root).every((entry) => entry["commit_state"] === "committed"),
			"the cancelled round to commit",
		);

		// With nothing left in this process it must refuse to act rather than pick one.
		notices.length = 0;
		await wb.handler("cancel", ctx);
		expect(notices.join("\n")).toContain("Nothing in this process is running");
	}, 30_000);
	/**
	 * A headless OMP session has no dialog to answer. Cancel must list the candidates and
	 * stop: calling `select` there throws, and choosing for the user is the guess the
	 * command exists to avoid.
	 */
	it("lists cancellable tasks instead of prompting when there is no UI", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const notices: string[] = [];
		let selectCalls = 0;
		const registering = {
			...api,
			registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands.set(name, spec);
			},
		} as unknown as ExtensionAPI;
		activate(registering, { ...overrides, foregroundWaitMs: 0 });

		// Dispatch through the interactive context (the round confirmation needs an answer);
		// cancellation runs headless, which is the case under test.
		const dispatchCtx = makeContext(root);
		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, dispatchCtx);

		const held = session.nextPrompt();
		const dispatched = await call("wb_task", { goal: { objective: "headless cancel", acceptance: ["done"] } });
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await held;

		const headlessCtx = {
			cwd: root,
			hasUI: false,
			sessionManager: { getSessionId: () => "omp-advance-session" },
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
				select: async () => {
					selectCalls += 1;
					return undefined;
				},
				confirm: async () => false,
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext;

		notices.length = 0;
		await commands.get("wb")!.handler("cancel", headlessCtx);

		// No dialog was attempted, the refusal explains itself, and the id is listed so the
		// caller can act with the explicit form.
		expect(selectCalls).toBe(0);
		const text = notices.join("\n");
		expect(text).toContain("needs an interactive OMP session");
		expect(text).toContain(taskId);

		// The round is still in flight: releasing the worker lets the connection
		// close, so the fixture can be removed without racing a live handle.
		session.stopHolding();
		await until(
			() => rows(root).every((entry) => entry["commit_state"] === "committed"),
			"the held round to commit",
		);
	}, 30_000);
	/**
	 * The workbench pages must show what the process can prove, and must open instantly.
	 * Rendering used to wait on a network roster probe, which stalled a project with no
	 * worker — a page render is not the place to discover that an endpoint is unreachable.
	 */
	it("fills the workbench pages from local facts without probing the network", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		session.stopHolding();
		const { api, overrides, tools } = makeApi(root, session);
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const notices: string[] = [];
		const registering = {
			...api,
			registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands.set(name, spec);
			},
		} as unknown as ExtensionAPI;
		activate(registering, {
			...overrides,
			foregroundWaitMs: 0,
		});

		// Dispatch needs the interactive context: the round confirmation is a dialog.
		const dispatchCtx = makeContext(root);
		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, dispatchCtx);
		const dispatched = await call("wb_task", { goal: { objective: "workbench facts", acceptance: ["done"] } });
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await until(() => rows(root).some((row) => row["commit_state"] === "committed"), "the round to commit");

		// The workbench itself renders headless, which is the path under test.
		const ctx = {
			cwd: root,
			hasUI: false,
			sessionManager: { getSessionId: () => "omp-advance-session" },
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
				select: async () => undefined,
				confirm: async () => true,
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext;

		await commands.get("wb")!.handler("", ctx);
		const text = notices.join("\n");

		// Four pages, the dispatched task reaching the tasks page, the bound session on the
		// sessions page, and a project-state fact on diagnostics. No timers and no probe
		// counters: the claim is about what is rendered, not how fast a shared machine is.
		expect(text).toContain("— tasks —");
		// The page abbreviates ids, so assert the prefix it actually renders.
		expect(text).toContain(taskId.slice(0, 8));
		expect(text).toContain("— sessions —");
		expect(text).toContain("WorkBuddy");
		expect(text).toContain("— diagnostics —");
		expect(text).toContain("enabled, queue readable");
	}, 30_000);
	/**
	 * The status line is one short phrase; a task's own progress belongs in a widget row.
	 * The row must also disappear when nothing is running — a finished task's line would
	 * otherwise sit above the editor forever — and a host without `setWidget` must not
	 * break the state update that triggers it.
	 */
	it("keeps one widget row per running task, and clears it when none are", async () => {
		const root = await preparedProject();
		const session = new GateSession();
		const { api, overrides, tools } = makeApi(root, session);
		const widgets: Array<[string, unknown]> = [];
		// Built inline rather than patched onto `makeContext`'s result: the task captures the
		// context it was dispatched with, so the recorder has to be part of that object.
		const ctx = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "omp-advance-session" },
			ui: {
				notify: () => undefined,
				confirm: async () => true,
				select: async (_title: string, choices: string[]) =>
					choices.includes("Submit this round") ? "Submit this round" : choices[0],
				setStatus: () => undefined,
				setWidget: (key: string, content: unknown) => {
					widgets.push([key, content]);
				},
			},
		} as unknown as ExtensionContext;
		activate(api, { ...overrides, foregroundWaitMs: 0 });

		const call = (name: string, params: unknown) =>
			tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, ctx);

		const held = session.nextPrompt();
		const dispatched = await call("wb_task", { goal: { objective: "widget row", acceptance: ["done"] } });
		const taskId = detailsOf(dispatched)["taskId"] as string;
		await held;

		const running = widgets.at(-1);
		expect(running?.[0]).toBe("workbuddy-progress");
		const widgetRows = running?.[1] as string[];
		expect(Array.isArray(widgetRows)).toBeTrue();
		expect(widgetRows[0]).toContain(taskId.slice(0, 8));
		expect(widgetRows[0]).toContain("r1");

		// Finishing the turn clears the row rather than leaving a stale progress line. The
		// clear must appear *after* the row was set: an earlier `undefined` (from the empty
		// state before dispatch) would otherwise satisfy a naive "last value" check.
		const setIndex = widgets.findIndex(([, content]) => Array.isArray(content));
		expect(setIndex).toBeGreaterThanOrEqual(0);
		session.stopHolding();
		await until(() => rows(root).some((row) => row["commit_state"] === "committed"), "the round to commit");
		await until(() => widgets.at(-1)?.[1] === undefined, "the widget to clear");
		expect(widgets.length).toBeGreaterThan(setIndex + 1);
		expect(widgets.slice(setIndex + 1).some(([, content]) => content === undefined)).toBeTrue();
	}, 30_000);
});
