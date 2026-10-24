/**
 * Subdirectory session behaviour at the tool boundary.
 *
 * The resolver has its own suite; this one proves the *entry point* uses it.
 * The user-visible requirement: a session that sits in `<root>/src/feature`
 * belongs to the project authorized at `<root>`, so its tasks, scopes and
 * artifacts are the same project's — not a second, empty project that demands
 * its own binding.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import { closeQueueConnection, enableProject, readProjectAccess } from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { WB_ERROR_CODE, type DesktopCallbacks, type DesktopSession, type PromptOutcome } from "../src/types";
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

/** Collects a terminal turn without touching any real worker. */
const terminalCallbacks: Array<{ callbacks: DesktopCallbacks }> = [];

function stubSession(): DesktopSession {
	return {
		binding: { version: 1, projectRoot: "", sessionId: SESSION_ID, workbuddyVersion: "1.2.3" },
		async prompt(_prompt: string, callbacks: DesktopCallbacks): Promise<PromptOutcome> {
			terminalCallbacks.push({ callbacks });
			return { stopReason: "end_turn" };
		},
		async respondToPermission(): Promise<void> {
			// No permission dialogs are raised by the stub.
		},
		async cancel(): Promise<void> {
			// Nothing is running.
		},
		async close(): Promise<void> {
			// Nothing to release.
		},
	} as unknown as DesktopSession;
}

function makeApi(projectRoot: string) {
	const tools = new Map<string, RegisteredTool>();

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
	});	/** Messages this activation handed to the host, in order. */
	const sent: Array<{
		customType: unknown;
		content: unknown;
		display: unknown;
		options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
	}> = [];
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
		discover: async () => [],
		connect: async () => stubSession(),
	};
	return { api, overrides, tools };
}

/** A context whose cwd is `dir`; the session id is a real host-provided one. */
function makeContext(dir: string): ExtensionContext {
	return {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionId: () => "omp-subdirectory-session" },
		ui: {
			notify: () => undefined,
			select: async () => undefined,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

/** Writes the binding the way setup does, then enables the project. */
async function prepareProject(root: string): Promise<void> {
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
}

describe("subdirectory session shares the authorized project", () => {
	it("accepts a task from a subdirectory when the binding belongs to the root", async () => {
		const root = await createFixtureRoot("wb-subdir-");
		roots.push(root);
		await prepareProject(root);
		const nested = path.join(root, "src", "feature");
		await mkdir(nested, { recursive: true });
		await writeFile(path.join(root, "input.txt"), "hello", "utf-8");

		const { api, overrides, tools } = makeApi(root);
		activate(api, overrides);
		const taskTool = tools.get("wb_task");
		expect(taskTool).toBeDefined();

		const result = await taskTool!.execute(
			"call-subdir",
			{
				goal: { objective: "write the report", acceptance: ["report exists"] },
				inputFiles: ["input.txt"],
				expectedOutputs: ["report.md"],
			},
			undefined,
			undefined,
			makeContext(nested),
		);

		// The binding was found at the root, so the request is not refused as
		// "unbound" merely because the session's cwd is deeper.
		const details = result.details as { error?: { code?: string }; projectRoot?: string } | undefined;
		expect(details?.error?.code).not.toBe(WB_ERROR_CODE.bindingInvalid);

		// And project state stayed in exactly one place: the authorized root.
		expect(await readProjectAccess(root)).toMatchObject({ enabled: true, migrated: true });
		const rootState = await readFile(path.join(root, ".wb-bridge", "state.sqlite")).catch(() => null);
		expect(rootState).not.toBeNull();
		await expect(Bun.file(path.join(nested, ".wb-bridge", "state.sqlite")).exists()).resolves.toBeFalse();
	});

	it("refuses when a nearer nested project makes the owner ambiguous", async () => {
		const root = await createFixtureRoot("wb-subdir-nested-");
		roots.push(root);
		await prepareProject(root);
		const nestedProject = path.join(root, "vendor", "sibling");
		await mkdir(nestedProject, { recursive: true });
		await prepareProject(nestedProject);

		const { api, overrides, tools } = makeApi(root);
		activate(api, overrides);
		const result = await tools.get("wb_task")!.execute(
			"call-ambiguous",
			{ goal: { objective: "should not run", acceptance: ["x"] } },
			undefined,
			undefined,
			makeContext(nestedProject),
		);

		expect(result.isError).toBe(true);
		const details = result.details as { error?: { code?: string; message?: string } } | undefined;
		expect(details?.error?.code).toBe(WB_ERROR_CODE.bindingInvalid);
		// The refusal names the ambiguity instead of pretending nothing is set up.
		expect(details?.error?.message).toContain("confirm which project");
	});
});
