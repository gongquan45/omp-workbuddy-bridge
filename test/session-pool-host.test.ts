/**
 * Project-wide WorkBuddy session pool, driven through the real public tools.
 *
 * The requirement this file proves: one OMP routes *unrelated* logical tasks to
 * *separate* WorkBuddy conversations, and the project's enrollment survives a
 * restart so a session opened later joins the pool without another prompt.
 *
 * Two facts make this harder than it looks, and both are asserted here rather
 * than assumed:
 *
 *  - a finished WorkBuddy conversation is never reused for an unrelated task,
 *    because its context already carries the earlier work; and
 *  - the enrollment is a *project* fact, so it is persisted in the binding and
 *    restored by discovery, not re-asked on every start.
 *
 * Everything is asserted on the queue and the persisted binding — never on the
 * tool's own report, because a tool's report is derived from the same code
 * under test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import {
	closeQueueConnection,
	enableProject,
	openProjectQueue,
	openReadConnection,
	openWriteConnection,
} from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { WB_ERROR_CODE, type DesktopCandidate, type DesktopSession, type PromptOutcome } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const FIRST_SESSION = "11111111-2222-4333-8444-555555555555";
const SECOND_SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const THIRD_SESSION = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
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
 * A worker that keeps its turn open until the test releases it.
 *
 * Two of these are what "two conversations at once" means: each worker has its
 * own prompt log, so a test can prove that each conversation received its own
 * task and not the other's.
 */
class GateSession {
	readonly prompts: string[] = [];
	private readonly releasers: Array<() => void> = [];
	private readonly starters: Array<() => void> = [];
	private hold = true;

	async prompt(prompt: string): Promise<PromptOutcome> {
		this.prompts.push(prompt);
		this.starters.shift()?.();
		if (this.hold) {
			await new Promise<void>((resolve) => this.releasers.push(resolve));
		}
		return { stopReason: "end_turn" };
	}

	nextPrompt(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.starters.push(resolve);
		return promise;
	}

	stopHolding(): void {
		this.hold = false;
		this.releasers.shift()?.();
	}
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

/**
 * Polls until `predicate` holds, without guessing how long anything takes.
 *
 * The condition is observed, not timed: the delay between checks is only how
 * often the condition is re-read, so a slow machine costs checks rather than
 * correctness.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The binding as it is persisted on disk. */
async function readBindingFile(root: string): Promise<Record<string, unknown> | null> {
	const raw = await readFile(path.join(root, ".wb-bridge", "binding.json"), "utf-8").catch(() => null);
	return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** A candidate the discovery seam reports for one WorkBuddy session. */
function candidate(root: string, sessionId: string, port: number): DesktopCandidate {
	return {
		endpoint: `http://127.0.0.1:${port}`,
		binding: { version: 1 as const, projectRoot: root, sessionId, workbuddyVersion: "5.8.2" },
		cwd: root,
		busy: false,
	};
}

/** One message the fixture's host handed to the conversation. */
interface SentMessage {
	customType: unknown;
	content: unknown;
	display: unknown;
	options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}

/**
 * Builds an activated extension with one worker per session.
 *
 * The discovery seam is injected, which is what makes "the user opened another
 * session" expressible: the harness decides what the desktop serves.
 */
function makeApi(
	root: string,
	workers: Map<string, GateSession>,
	discovered: () => DesktopCandidate[],
) {
	const tools = new Map<string, RegisteredTool>();
	/** Messages this activation handed to the host, in order. */
	const sent: SentMessage[] = [];
	/**
	 * The activation's shutdown handler, captured so the test can shut the
	 * activation down before its project's files are removed.
	 */
	let shutdown: (() => Promise<void>) | null = null;
	/**
	 * The activation's start handler, captured so a test can start the
	 * activation the way a real host does: a session start resumes the queue.
	 */
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | null = null;
	// The teardown waits for the activation's background work through the
	// shutdown, so the project's files are never removed while a background
	// write is still in flight.
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
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: (message: string) => {
				console.error(`[warn] ${message}`);
			},
			error: (message: string) => {
				console.error(`[error] ${message}`);
			},
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			if (event === "session_shutdown") {
				shutdown = handler as unknown as () => Promise<void>;
			}
			if (event === "session_start") {
				sessionStart = handler;
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
	const connected: string[] = [];
	const overrides: BridgeOverrides = {
		workbuddyHomeDir: path.join(root, ".test-home"),
		// The foreground wait is the production budget, and these cases hold a turn
		// open on purpose: the tool call must return without waiting for the
		// worker's answer, so the test can observe the running state.
		foregroundWaitMs: 0,
		discover: async () => discovered(),
		connect: async (binding) => {
			const worker = workers.get(binding.sessionId);
			if (worker === undefined) {
				throw new Error(`Unexpected target ${binding.sessionId}`);
			}
			connected.push(binding.sessionId);
			return {
				binding,
				prompt: (prompt: string) => worker.prompt(prompt),
				respondToPermission: async () => undefined,
				cancel: async () => undefined,
				close: async () => undefined,
			} as unknown as DesktopSession;
		},
	};
	return {
		api,
		overrides,
		tools,
		connected,
		sent,
		/** Starts the activation the way a host starts a session. */
		start: async (ctx: ExtensionContext) => {
			await sessionStart?.({}, ctx);
		},
	};
}

/**
 * A context whose dialogs answer "Submit this round" without waiting.
 *
 * The approval dialog is where two parallel delegations used to collide, so the
 * harness records every dialog it was asked to present.
 */
function makeContext(dir: string, dialogs: string[] = []): ExtensionContext {
	return {
		cwd: dir,
		hasUI: true,
		sessionManager: { getSessionId: () => "omp-pool-session" },
		ui: {
			notify: () => undefined,
			confirm: async (prompt: string) => {
				dialogs.push(prompt);
				return true;
			},
			select: async (title: string, choices: string[]) => {
				dialogs.push(title);
				const submit = choices.find((choice) => choice.includes("Submit this round"));
				return submit ?? choices[0];
			},
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

/**
 * A project whose binding carries the project-wide enrollment consent.
 *
 * The consent is what the user granted at bind time; a restart has to honour it
 * without asking again.
 */
async function preparedProject(root: string, sessionIds: string[]): Promise<void> {
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({
			version: 2,
			projectRoot: root,
			sessionId: sessionIds[0],
			workbuddyVersion: "5.8.2",
			autoBindProjectSessions: true,
			sessions: sessionIds.map((sessionId) => ({ sessionId, workbuddyVersion: "5.8.2" })),
		}),
		"utf-8",
	);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
}

/**
 * The project's own meta rows, read by key.
 *
 * The upgrade must preserve the user's consent timestamps exactly, so the test
 * reads them before and after and compares the values rather than their
 * presence.
 */
function readMetaValues(root: string): Record<string, string> {
	const db = openReadConnection(root);
	if (db === null) {
		return {};
	}
	try {
		const rows = db.query("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
		return Object.fromEntries(rows.map((row) => [row.key, row.value]));
	} finally {
		closeQueueConnection(root, "read");
	}
}

/**
 * A project whose state was written by the previous build.
 *
 * The shape is the one a real user has: the project is enabled and migrated,
 * its binding is the pre-pool single-session record, and its state file still
 * declares the previous schema version. Two WorkBuddy conversations are now
 * serving the project.
 */
async function legacyProject(root: string, sessionId: string): Promise<void> {
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({ version: 1, projectRoot: root, sessionId, workbuddyVersion: "5.8.2" }),
		"utf-8",
	);
	// The state file was written by the previous build: it declares the older
	// schema version, so every write path refuses it until it is upgraded.
	// The write connection allows the mismatch on purpose: that is what the
	// upgrade path itself does.
	const db = openWriteConnection(root, { allowSchemaMismatch: true });
	try {
		db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
	} finally {
		closeQueueConnection(root);
		closeQueueConnection(root, "read");
	}
}

/** Every outbox row in the project: the result facts awaiting delivery. */
function outboxRows(root: string): Array<Record<string, unknown>> {
	const db = openReadConnection(root);
	if (db === null) {
		return [];
	}
	try {
		return db.query("SELECT * FROM outbox ORDER BY delivery_id ASC").all() as Array<Record<string, unknown>>;
	} finally {
		closeQueueConnection(root, "read");
	}
}

/**
 * Waits until every round in the project has a decided commit state.
 *
 * A delegation that was dispatched in the background still holds the project's
 * SQLite handle and its WorkBuddy connection. Tearing the fixture down while it
 * runs would delete the state it is about to commit into, which is a teardown
 * race, not a product failure.
 *
 * The project's connections are released here too: a round can be committed
 * while the task's own finalization is still closing the handle it used, and
 * the teardown would then race that close.
 */
async function settle(root: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const all = rows(root);
		if (all.length > 0 && all.every((row) => row["commit_state"] === "committed" || row["commit_state"] === "failed")) {
			break;
		}
		await Bun.sleep(25);
	}
	// The commit has settled; the handles it used are released next, so give
	// that close a moment before the fixture is removed.
	await Bun.sleep(50);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
}

describe("one OMP, several WorkBuddy conversations", () => {
	it("routes two unrelated tasks to two different sessions and keeps their prompts apart", async () => {
		const root = await createFixtureRoot("wb-pool-two-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
		]);
		const { api, overrides, tools, connected } = makeApi(root, workers, () => [
			candidate(root, FIRST_SESSION, 18101),
			candidate(root, SECOND_SESSION, 18102),
		]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		try {
			const first = await taskTool.execute(
				"first-unrelated-task",
				{ goal: { objective: "Analyze the sales report", acceptance: ["report produced"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			await until(() => firstWorker.prompts.length === 1, "the first task to reach its worker");
			const second = await taskTool.execute(
				"second-unrelated-task",
				{ goal: { objective: "Draft the outreach plan", acceptance: ["plan produced"] } },
				undefined,
				undefined,
				makeContext(root),
			);

			// Both tasks are running, in two different conversations.
			expect(detailsOf(first)["status"]).toBe("running");
			expect(detailsOf(second)["status"]).toBe("running");
			await until(() => secondWorker.prompts.length === 1, "the second task to reach its worker");

			// Each conversation received exactly its own task: no prompt crossed.
			expect(firstWorker.prompts).toHaveLength(1);
			expect(secondWorker.prompts).toHaveLength(1);
			expect(firstWorker.prompts[0]).toContain("Analyze the sales report");
			expect(secondWorker.prompts[0]).toContain("Draft the outreach plan");
			expect(firstWorker.prompts[0]).not.toContain("Draft the outreach plan");
			expect(secondWorker.prompts[0]).not.toContain("Analyze the sales report");

			// Two distinct sessions were attached to.
			expect(new Set(connected).size).toBe(2);

			// The queue records each task's own target, not one shared session.
			const recorded = rows(root);
			expect(recorded).toHaveLength(2);
			const targets = new Set(recorded.map((row) => String(row["selected_session"] ?? "")));
			expect(targets.size).toBe(2);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);

	it("keeps a finished conversation out of reach of an unrelated later task", async () => {
		const root = await createFixtureRoot("wb-pool-reuse-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
		]);
		const { api, overrides, tools, connected } = makeApi(root, workers, () => [
			candidate(root, FIRST_SESSION, 18201),
			candidate(root, SECOND_SESSION, 18202),
		]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		try {
			const first = await taskTool.execute(
				"first-task",
				{ goal: { objective: "First independent job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(first)["status"]).toBe("running");
			await until(() => firstWorker.prompts.length === 1, "the first task");
			firstWorker.stopHolding();
			await until(
				() => rows(root).some((row) => row["commit_state"] === "committed"),
				"the first task to commit",
			);

			// The second task is a different logical job, so it may not land in the
			// conversation that already carries the first one.
			const second = await taskTool.execute(
				"second-task",
				{ goal: { objective: "Second independent job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(second)["status"]).toBe("running");
			await until(() => secondWorker.prompts.length === 1, "the second task");
			expect(firstWorker.prompts).toHaveLength(1);
			expect(secondWorker.prompts).toHaveLength(1);
			expect(new Set(connected).size).toBe(2);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);

	it("queues an unrelated task with a real reason when every enrolled session has already run one", async () => {
		const root = await createFixtureRoot("wb-pool-exhausted-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION]);

		const firstWorker = new GateSession();
		const workers = new Map([[FIRST_SESSION, firstWorker]]);
		const { api, overrides, tools } = makeApi(root, workers, () => [candidate(root, FIRST_SESSION, 18301)]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		try {
			const first = await taskTool.execute(
				"first-task",
				{ goal: { objective: "First job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(first)["status"]).toBe("running");
			await until(() => firstWorker.prompts.length === 1, "the first task");
			firstWorker.stopHolding();
			await until(
				() => rows(root).some((row) => row["commit_state"] === "committed"),
				"the first task to commit",
			);

			// The only enrolled session has already run a task. The second,
			// unrelated task has nowhere to go, and the caller is told so with a
			// reason instead of the work being pushed into a used conversation.
			const second = await taskTool.execute(
				"second-task",
				{ goal: { objective: "Second job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			const details = detailsOf(second);
			expect(details["status"]).toBe("queued");
			expect(typeof details["waitReason"]).toBe("string");
			// The queued task names no session: it has not been given one.
			const queuedRows = rows(root).filter((row) => row["status"] === "queued");
			expect(queuedRows).toHaveLength(1);
			expect(String(queuedRows[0]!["selected_session"] ?? "")).toBe("");
		} finally {
			firstWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);
});

describe("a project written by the previous build", () => {
	it("upgrades its state on startup and dispatches without asking for a new binding", async () => {
		const root = await createFixtureRoot("wb-pool-legacy-");
		roots.push(root);
		// The state the previous build left behind: enabled, migrated, a
		// single-session binding, and a schema version this build refuses.
		await legacyProject(root, FIRST_SESSION);
		// The project's own timestamps are captured before the upgrade: the
		// upgrade must preserve them exactly, not restamp them.
		const before = readMetaValues(root);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
		]);
		const { api, overrides, tools } = makeApi(root, workers, () => [
			candidate(root, FIRST_SESSION, 18701),
			candidate(root, SECOND_SESSION, 18702),
		]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;
		const dialogs: string[] = [];

		try {
			// The delegation is what a restart leads to. It must work without
			// the user running a manual setup step first: the project's existing
			// consent and enabled state are enough.
			const result = await taskTool.execute(
				"first-task-after-upgrade",
				{ goal: { objective: "Work after the upgrade", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root, dialogs),
			);
			const details = detailsOf(result);
			// The refusal this replaces was WB_MIGRATION_REQUIRED: the state's
			// schema version was older than this build's, and nothing upgraded it.
			// A successful task view carries no error at all.
			expect(details["error"]).toBeNull();
			expect(details["status"]).toBe("running");
			await until(
				() => firstWorker.prompts.length === 1 || secondWorker.prompts.length === 1,
				"the task to reach a worker",
			);

			// The upgrade really happened, and the project's own facts survived it
			// unchanged: the enabled and migrated timestamps are the user's
			// original consent, not a fresh one.
			const db = openReadConnection(root);
			expect(db).not.toBeNull();
			try {
				expect(readMetaValues(root)["schema_version"]).toBe("3");
				expect(readMetaValues(root)["project_enabled_at"]).toBe(before["project_enabled_at"]);
				expect(readMetaValues(root)["migration_completed"]).toBe(before["migration_completed"]);
			} finally {
				closeQueueConnection(root, "read");
			}

			// The project's consent was carried over, so no binding question was
			// asked. The per-round submission dialog is a different thing and is
			// still expected.
			expect(dialogs.filter((prompt) => prompt.includes("Enroll this project's WorkBuddy sessions"))).toEqual(
				[],
			);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);

	it("leaves an arbitrary working directory without any project state", async () => {
		// The startup upgrade must not set up a project OMP merely happens to be
		// opened in: it runs only for a project that is already authorized and
		// already has state on disk.
		const root = await createFixtureRoot("wb-pool-untouched-");
		roots.push(root);
		const { api, overrides, tools } = makeApi(root, new Map(), () => []);
		activate(api, overrides);

		await tools.get("wb_task")!.execute(
			"no-consent-task",
			{ goal: { objective: "should not set the project up", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);

		// No state file appeared: nothing was created for a project the user
		// never bound.
		expect(existsSync(path.join(root, ".wb-bridge", "state.sqlite"))).toBe(false);
	}, 15_000);
});

describe("the enrollment survives a restart", () => {
	it("restores the enrolled roster and enrolls a session opened later, without asking again", async () => {
		const root = await createFixtureRoot("wb-pool-restart-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION]);

		const firstWorker = new GateSession();
		const laterWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, laterWorker],
		]);
		// The desktop serves one session at first; the user opens a second one
		// while OMP is not running.
		let served = [candidate(root, FIRST_SESSION, 18401)];
		const { api, overrides, tools, connected } = makeApi(root, workers, () => served);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		try {
			const first = await taskTool.execute(
				"first-task",
				{ goal: { objective: "First job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(first)["status"]).toBe("running");
			await until(() => firstWorker.prompts.length === 1, "the first task");
			firstWorker.stopHolding();
			await until(
				() => rows(root).some((row) => row["commit_state"] === "committed"),
				"the first task to commit",
			);

			// The user opens another WorkBuddy session for the same project.
			served = [
				candidate(root, FIRST_SESSION, 18401),
				candidate(root, SECOND_SESSION, 18402),
			];

			// The next delegation refreshes the roster before it stages the work,
			// so the newly opened session can take this task.
			const second = await taskTool.execute(
				"second-task",
				{ goal: { objective: "Second job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(second)["status"]).toBe("running");
			await until(() => laterWorker.prompts.length === 1, "the newly opened session to take the task");

			// The roster on disk now names both sessions: the enrollment was
			// extended without another consent prompt.
			const binding = await readBindingFile(root);
			expect(binding).not.toBeNull();
			const sessions = (binding!["sessions"] ?? []) as Array<{ sessionId: string }>;
			expect(sessions.map((entry) => entry.sessionId).sort()).toEqual(
				[FIRST_SESSION, SECOND_SESSION].sort(),
			);
			expect(binding!["autoBindProjectSessions"]).toBe(true);
		} finally {
			firstWorker.stopHolding();
			laterWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);

	it("keeps the enrollment and its roster when no worker is answering", async () => {
		const root = await createFixtureRoot("wb-pool-offline-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const workers = new Map<string, GateSession>();
		// Nothing answers: the desktop is closed.
		const { api, overrides, tools } = makeApi(root, workers, () => []);
		activate(api, overrides);

		// A read-only surface that touches the pool: the doctor. It must not
		// attach, and it must not erase the enrollment.
		const doctor = await tools.get("wb_doctor")!.execute(
			"doctor-offline",
			{},
			undefined,
			undefined,
			makeContext(root),
		);
		expect(doctor.isError).toBeFalsy();

		const binding = await readBindingFile(root);
		expect(binding).not.toBeNull();
		expect(binding!["autoBindProjectSessions"]).toBe(true);
		const sessions = (binding!["sessions"] ?? []) as Array<{ sessionId: string }>;
		// Both enrolled sessions are still enrolled: offline is not the same as
		// no longer enrolled.
		expect(sessions.map((entry) => entry.sessionId).sort()).toEqual(
			[FIRST_SESSION, SECOND_SESSION].sort(),
		);
	}, 20_000);
});

describe("an approved round survives a restart", () => {
	it("runs an approved but unclaimed round after a restart, without a second submission", async () => {
		const root = await createFixtureRoot("wb-pool-adopt-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const thirdWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
			[THIRD_SESSION, thirdWorker],
		]);
		// The desktop serves two conversations at first; the third one is opened
		// while the OMP process is not running.
		let served = [
			candidate(root, FIRST_SESSION, 18801),
			candidate(root, SECOND_SESSION, 18802),
		];
		const first = makeApi(root, workers, () => served);
		activate(first.api, first.overrides);

		let thirdTaskId = "";
		let generationBeforeRestart = "";
		let requestIdBeforeRestart = "";
		try {
			// Two tasks take the two conversations, so both are now used.
			const one = await first.tools.get("wb_task")!.execute(
				"task-one",
				{ goal: { objective: "First job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(one)["status"]).toBe("running");
			await until(() => firstWorker.prompts.length === 1, "the first task");
			firstWorker.stopHolding();
			await until(
				() => rows(root).some((row) => row["commit_state"] === "committed"),
				"the first task to commit",
			);

			const two = await first.tools.get("wb_task")!.execute(
				"task-two",
				{ goal: { objective: "Second job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(two)["status"]).toBe("running");
			await until(() => secondWorker.prompts.length === 1, "the second task");
			secondWorker.stopHolding();
			await until(
				() => rows(root).filter((row) => row["commit_state"] === "committed").length === 2,
				"the second task to commit",
			);

			// The third task is approved, but every enrolled session has already
			// carried a task, so it waits. It is approved and unsent: the human
			// said yes, and no prompt has left.
			const three = await first.tools.get("wb_task")!.execute(
				"task-three",
				{ goal: { objective: "Third job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(three)["status"]).toBe("queued");
			thirdTaskId = String(detailsOf(three)["taskId"]);
			const queued = rows(root).find((row) => row["task_id"] === thirdTaskId)!;
			expect(queued["status"]).toBe("queued");
			expect(queued["dispatch_state"]).toBe("not_sent");
			expect(queued["attempt_id"]).toBeNull();
			// The identity of the approved round, captured before the restart:
			// the successor must adopt THIS round, not create another one.
			generationBeforeRestart = String(queued["owner_generation"]);
			requestIdBeforeRestart = String(queued["request_id"]);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			thirdWorker.stopHolding();
		}

		// The activation ends, exactly as a host ends a session. The approved
		// round stays in the queue: it was never sent, so nothing is lost.
		const stopFirst = activations.pop();
		await stopFirst?.();

		// The user opens a third WorkBuddy session for this project.
		served = [
			candidate(root, FIRST_SESSION, 18801),
			candidate(root, SECOND_SESSION, 18802),
			candidate(root, THIRD_SESSION, 18803),
		];

		// A new activation for the SAME OMP session, with a new generation — the
		// successor of the one that approved the round. The host starts it the
		// way it starts any session: with a session start, which resumes the
		// queue.
		const second = makeApi(root, workers, () => served);
		activate(second.api, second.overrides);

		try {
			await second.start(makeContext(root));
			// The approved round runs on its own, without a second submission and
			// without a rebind: the successor adopts it and the newly opened
			// session takes it.
			await until(
				() => thirdWorker.prompts.length === 1,
				"the adopted round to reach the newly opened session",
			);
			expect(thirdWorker.prompts[0]).toContain("Third job");

			// The round is the ORIGINAL one: adopted, not copied. There is no
			// second round for the same task.
			const taskRows = rows(root).filter((row) => row["task_id"] === thirdTaskId);
			expect(taskRows).toHaveLength(1);
			expect(taskRows[0]!["selected_session"]).toBe(THIRD_SESSION);
			expect(taskRows[0]!["dispatch_state"]).not.toBe("not_sent");
			// It now runs under the successor's generation: the activation that
			// adopted it, not the one that approved it.
			expect(taskRows[0]!["owner_generation"]).not.toBe(generationBeforeRestart);
			// And it is the same task, still one row, still the round the human
			// approved.
			expect(taskRows[0]!["round"]).toBe(1);
			expect(taskRows[0]!["request_id"]).toBe(requestIdBeforeRestart);

			// The adopted round's result is DELIVERED, not merely committed. The
			// result fact is published under the identity that ran the round, so
			// the outbox holds a row for the adopted request and the host
			// receives the follow-up message.
			await until(
				() => second.sent.some((message) => String(message.content ?? "").includes(thirdTaskId)),
				"the adopted round's result to reach the host",
			);
			const outbox = outboxRows(root);
			const adopted = outbox.find((row) => row["request_id"] === requestIdBeforeRestart);
			expect(adopted).toBeDefined();
			expect(adopted!["kind"]).toBe("result");
			// It belongs to the OMP session that owns the work, and to the
			// generation that actually ran it.
			expect(adopted!["owner_session"]).toBe("omp-pool-session");
			expect(adopted!["owner_generation"]).not.toBe(generationBeforeRestart);
		} finally {
			thirdWorker.stopHolding();
			await settle(root);
		}
	}, 45_000);
});

describe("a task stays on its own conversation", () => {
	it("keeps a supplement on the session its task already owns", async () => {
		const root = await createFixtureRoot("wb-pool-supplement-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
		]);
		const { api, overrides, tools } = makeApi(root, workers, () => [
			candidate(root, FIRST_SESSION, 18501),
			candidate(root, SECOND_SESSION, 18502),
		]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		try {
			const first = await taskTool.execute(
				"first-task",
				{ goal: { objective: "Original job", acceptance: ["done"] } },
				undefined,
				undefined,
				makeContext(root),
			);
			const taskId = String(detailsOf(first)["taskId"]);
			expect(detailsOf(first)["status"]).toBe("running");
			await until(() => firstWorker.prompts.length === 1, "the first task");
			firstWorker.stopHolding();
			await until(
				() => rows(root).some((row) => row["commit_state"] === "committed"),
				"the first task to commit",
			);

			// The supplement continues the same logical task, so it continues in
			// the same conversation — even though another session is free.
			const supplement = await taskTool.execute(
				"supplement-task",
				{
					taskId,
					goal: { objective: "More work on the same job", acceptance: ["done"] },
				},
				undefined,
				undefined,
				makeContext(root),
			);
			expect(detailsOf(supplement)["status"]).toBe("running");
			await until(
				() => secondWorker.prompts.length === 1 || firstWorker.prompts.length === 2,
				"the supplement to reach a worker",
			);
			expect(firstWorker.prompts).toHaveLength(2);
			expect(secondWorker.prompts).toHaveLength(0);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);
});

describe("two parallel delegations do not cancel each other", () => {
	it("keeps both confirmation drafts alive until each one is answered", async () => {
		const root = await createFixtureRoot("wb-pool-drafts-");
		roots.push(root);
		await preparedProject(root, [FIRST_SESSION, SECOND_SESSION]);

		const firstWorker = new GateSession();
		const secondWorker = new GateSession();
		const workers = new Map([
			[FIRST_SESSION, firstWorker],
			[SECOND_SESSION, secondWorker],
		]);
		const { api, overrides, tools } = makeApi(root, workers, () => [
			candidate(root, FIRST_SESSION, 18601),
			candidate(root, SECOND_SESSION, 18602),
		]);
		activate(api, overrides);
		const taskTool = tools.get("wb_task")!;

		// The first dialog is held open while the second delegation starts: the
		// single-slot draft would have made the first answer report a
		// cancellation nobody asked for.
		const { promise: firstDialog, resolve: releaseFirst } = Promise.withResolvers<void>();
		let dialogCount = 0;
		const context = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "omp-pool-session" },
			ui: {
				notify: () => undefined,
				confirm: async () => true,
				select: async (title: string, choices: string[]) => {
					dialogCount += 1;
					if (dialogCount === 1) {
						await firstDialog;
					}
					const submit = choices.find((choice) => choice.includes("Submit this round"));
					return submit ?? choices[0];
				},
				setStatus: () => undefined,
			},
		} as unknown as ExtensionContext;

		try {
			const firstPromise = taskTool.execute(
				"first-parallel-task",
				{ goal: { objective: "Parallel job one", acceptance: ["done"] } },
				undefined,
				undefined,
				context,
			);
			await until(() => dialogCount === 1, "the first confirmation dialog");
			const secondPromise = taskTool.execute(
				"second-parallel-task",
				{ goal: { objective: "Parallel job two", acceptance: ["done"] } },
				undefined,
				undefined,
				context,
			);
			// The second delegation reaches its own dialog while the first one is
			// still open: the drafts did not collide.
			await until(() => dialogCount === 2, "the second confirmation dialog");
			releaseFirst();

			const [first, second] = await Promise.all([firstPromise, secondPromise]);
			expect(detailsOf(first)["status"]).toBe("running");
			expect(detailsOf(second)["status"]).toBe("running");
			await until(
				() => firstWorker.prompts.length === 1 && secondWorker.prompts.length === 1,
				"both parallel tasks to reach their workers",
			);
			// Which conversation each task lands in is the queue's decision, and
			// two dialogs that are answered in either order may claim in either
			// order. What must hold is that the two tasks landed in *different*
			// conversations and that each conversation received its own task.
			const firstPrompt = firstWorker.prompts[0] ?? "";
			const secondPrompt = secondWorker.prompts[0] ?? "";
			const firstJob = firstPrompt.includes("Parallel job one") ? "one" : secondPrompt.includes("Parallel job one") ? "one" : "none";
			const secondJob = firstPrompt.includes("Parallel job two") ? "two" : secondPrompt.includes("Parallel job two") ? "two" : "none";
			expect(firstJob).toBe("one");
			expect(secondJob).toBe("two");
			// Neither conversation received both tasks.
			expect(firstWorker.prompts).toHaveLength(1);
			expect(secondWorker.prompts).toHaveLength(1);
		} finally {
			firstWorker.stopHolding();
			secondWorker.stopHolding();
			await settle(root);
		}
	}, 30_000);
});
