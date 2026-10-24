/**
 * The real dispatch path produces the diagnostics the log exists for.
 *
 * Two properties are asserted, and the second matters more than the first: the
 * events are actually emitted by production code (not only by tests calling
 * `logEvent`), and a log that cannot be written never changes a task's outcome.
 * A diagnostics side channel that can fail a delegation is worse than no log.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import { closeQueueConnection, enableProject } from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { flushBridgeLogs, logDirectory, readBridgeLogs } from "../src/logging";
import type { DesktopSession, PromptOutcome } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const SESSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			// A dispatched task commits asynchronously; closing the connection before that
			// settles would fight the commit for the same file. Let the event loop drain
			// first, then close, then release.
			await Bun.sleep(50);
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

/** A session that completes its turn immediately. */
const immediateSession = (projectRoot: string): DesktopSession =>
	({
		binding: { version: 1, projectRoot, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
		prompt: async (): Promise<PromptOutcome> => ({ stopReason: "end_turn" }),
		respondToPermission: async () => undefined,
		cancel: async () => undefined,
		close: async () => undefined,
	}) as unknown as DesktopSession;

function makeApi(projectRoot: string, session: DesktopSession) {
	const tools = new Map<string, RegisteredTool>();
	const sent: unknown[] = [];
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
		on: () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
	} as unknown as ExtensionAPI;
	const overrides: BridgeOverrides = {
		workbuddyHomeDir: path.join(projectRoot, ".test-home"),
		foregroundWaitMs: 0,
		discover: async () => [{
			binding: { version: 1, projectRoot, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
			busy: false,
			cwd: projectRoot,
			endpoint: "http://127.0.0.1:0",
		}],
		connect: async () => session,
	};
	return { api, overrides, tools, sent };
}

function makeContext(dir: string): ExtensionContext {
	return {
		cwd: dir,
		hasUI: true,
		sessionManager: { getSessionId: () => "omp-logging-session" },
		ui: {
			notify: () => undefined,
			confirm: async () => true,
			select: async (_title: string, choices: string[]) =>
				choices.includes("Submit this round") ? "Submit this round" : choices[0],
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

/** Prepares an enabled, bound project. */
async function preparedProject(): Promise<string> {
	const root = await createFixtureRoot("wb-logging-dispatch-");
	roots.push(root);
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({ version: 1, projectRoot: root, sessionId: SESSION_ID, workbuddyVersion: "1.2.3" }),
		"utf-8",
	);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	return root;
}

function taskIdOf(result: AgentToolResult<unknown>): string {
	const details = result.details;
	if (typeof details !== "object" || details === null || !("taskId" in details) || typeof details.taskId !== "string") {
		throw new Error("The delegation did not return a task ID");
	}
	return details.taskId;
}

async function settledEvents(root: string, taskId: string): Promise<string[]> {
	await flushBridgeLogs(root);
	return (await readBridgeLogs(root, { limit: 50 }))
		.filter((record) => record.taskId === taskId)
		.map((record) => record.event);
}


describe("dispatch diagnostics preserve privacy and task outcomes", () => {
	it("records the committed outcome of a real delegation", async () => {
		const root = await preparedProject();
		const { api, overrides, tools } = makeApi(root, immediateSession(root));
		activate(api, overrides);
		const result = await tools.get("wb_task")!.execute(
			"call-log",
			{ goal: { objective: "write the report", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const taskId = taskIdOf(result);
		const terminal = await tools.get("wb_status")!.execute(
			"call-wait",
			{ taskId, waitMs: 5_000 },
			undefined,
			undefined,
			makeContext(root),
		);
		expect(terminal.details).toMatchObject({ status: "completed", commitState: "committed" });
		const events = await settledEvents(root, taskId);
		expect(events).toContain("dispatch.settled");
		const records = await readBridgeLogs(root, { limit: 50 });
		const settled = records.find((record) => record.event === "dispatch.settled" && record.taskId === taskId);
		expect(settled?.reasonCode).toBe("completed");
		expect(events).toContain("queue.enqueued");
		expect(events).toContain("queue.claimed");
		expect(events).toContain("dispatch.armed");
	}, 30_000);


	it("records only whitelisted fields, so no prompt or path can leak into the log", async () => {
		const root = await preparedProject();
		const { api, overrides, tools } = makeApi(root, immediateSession(root));
		activate(api, overrides);

		const result = await tools.get("wb_task")!.execute(
			"call-fields",
			{ goal: { objective: "a secret objective that must not be logged", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const taskId = taskIdOf(result);
		const terminal = await tools.get("wb_status")!.execute("call-wait", { taskId, waitMs: 5_000 }, undefined, undefined, makeContext(root));
		expect(terminal.details).toMatchObject({ status: "completed", commitState: "committed" });
		await flushBridgeLogs(root);

		const records = await readBridgeLogs(root, { limit: 50 });
		const allowed: Readonly<Record<string, true>> = {
			time: true,
			level: true,
			event: true,
			taskId: true,
			round: true,
			requestId: true,
			sessionId: true,
			ownerPid: true,
			attemptId: true,
			revision: true,
			reasonCode: true,
			errorCode: true,
			durationMs: true,
			count: true,
		};
		for (const record of records) {
			for (const key of Object.keys(record)) {
				expect(allowed[key]).toBeTrue();
			}
		}
		expect(JSON.stringify(records)).not.toContain(JSON.stringify(root).slice(1, -1));
		// And the objective never reaches the log by any route.
		expect(JSON.stringify(records)).not.toContain("secret objective");
	}, 30_000);

	it("keeps the task result intact when the log cannot be written", async () => {
		const root = await preparedProject();
		// Make the log directory unwritable by putting a file where it belongs; the
		// logger reports itself unavailable rather than throwing into the caller.
		await writeFile(logDirectory(root), "not a directory", "utf-8");
		const { api, overrides, tools } = makeApi(root, immediateSession(root));
		activate(api, overrides);

		const result = await tools.get("wb_task")!.execute(
			"call-unwritable-log",
			{ goal: { objective: "still works", acceptance: ["done"] } },
			undefined,
			undefined,
			makeContext(root),
		);
		const taskId = taskIdOf(result);
		expect(result.isError ?? false).toBeFalse();
		const terminal = await tools.get("wb_status")!.execute("call-wait", { taskId, waitMs: 5_000 }, undefined, undefined, makeContext(root));
		expect(terminal.details).toMatchObject({ status: "completed", commitState: "committed" });
	}, 30_000);
});
