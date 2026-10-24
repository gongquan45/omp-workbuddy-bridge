import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import activate, { type BridgeOverrides } from "../src/index";
import { closeQueueConnection, readProjectAccess } from "../src/queue";
import { WbTaskError } from "../src/tasks";
import { WB_ERROR_CODE, type Binding, type DesktopSession } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

let testDirs: string[] = [];

beforeEach(() => {
	testDirs = [];
});

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
	for (const dir of testDirs) {
		closeQueueConnection(dir);
		closeQueueConnection(dir, "read");
		await removeFixtureRoot(dir);
	}
	testDirs = [];
});

async function createProjectRoot(): Promise<string> {
	const dir = await createFixtureRoot("wb-auth-test-");
	testDirs.push(dir);
	return dir;
}

function makeMockApi(overrides: BridgeOverrides = {}) {
	const commands = new Map<string, RegisteredCommand>();
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
	});	const chain = {
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
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_shutdown") {
				shutdown = handler;
			}
		},
		registerCommand: (name: string, command: unknown) => {
			if (typeof command === "object" && command !== null && "handler" in command) {
				commands.set(name, command as RegisteredCommand);
			}
		},
		registerTool: (tool: unknown) => {
			if (typeof tool === "object" && tool !== null && "name" in tool) {
				tools.set((tool as RegisteredTool).name, tool as RegisteredTool);
			}
		},
	} as unknown as ExtensionAPI;

	activate(api, overrides);
	return { commands, tools };
}

function makeMockContext(cwd: string, options: { confirmed?: boolean } = {}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	// Records every selection prompt so a test can prove the candidate list was
	// actually presented, not silently skipped.
	const selections: Array<{ prompt: string; choices: string[] }> = [];
	// Records every confirmation, so a test can prove the enrollment question
	// was really asked.
	const confirmations: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		// A real host always provides the session id: the queue's owner identity
		// is derived from it, so a delegation cannot be dispatched without one.
		sessionManager: { getSessionId: () => "omp-integration-auth" },
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			select: async (prompt: string, choices: string[]) => {
				selections.push({ prompt, choices });
				// The MCP confirmation keeps its original answer; only the session
				// picker is steerable, so a test cannot accidentally accept a bind.
				if (prompt.includes("Apply MCP configuration")) {
					return "Apply MCP configuration";
				}
				return choices[0];
			},
			confirm: async (prompt: string) => {
				confirmations.push(prompt);
				// The MCP configuration keeps its original answer; the enrollment
				// consent is the one a test steers.
				if (prompt.includes("Apply MCP configuration")) {
					return true;
				}
				return options.confirmed ?? true;
			},
			setStatus: () => undefined,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, selections, confirmations };
}

describe("authorization gate & setup integration", () => {
	it("1. a fresh mkdtemp project with no binding, run through setup, ends with readProjectAccess { enabled: true, migrated: true }", async () => {
		const projectRoot = await createProjectRoot();
		const sessionId = "11111111-2222-4333-8444-555555555555";

		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => [
				{
					endpoint: "http://127.0.0.1:1234",
					binding: {
						version: 1,
						projectRoot,
						sessionId,
						workbuddyVersion: "5.8.2",
					},
					busy: false,
				},
			],
		});

		const { ctx, notifications } = makeMockContext(projectRoot);
		const wbCmd = commands.get("wb");
		expect(wbCmd).toBeDefined();

		await wbCmd!.handler("setup", ctx as unknown as ExtensionCommandContext);

		expect(
			notifications.some((n) => n.type === "info" && n.message.includes("Successfully configured MCP")),
		).toBe(true);

		const access = await readProjectAccess(projectRoot);
		expect(access).not.toBeNull();
		expect(access!.enabled).toBe(true);
		expect(access!.migrated).toBe(true);
	});

	it("2. after setup, wb_task is no longer refused with WB_MIGRATION_REQUIRED", async () => {
		const projectRoot = await createProjectRoot();
		const sessionId = "22222222-3333-4444-8555-666666666666";

		const { commands, tools } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => [
				{
					endpoint: "http://127.0.0.1:1234",
					binding: {
						version: 1,
						projectRoot,
						sessionId,
						workbuddyVersion: "5.8.2",
					},
					cwd: projectRoot,
					busy: false,
				},
			],
			// The project is enrolled and enabled, so this call really dispatches.
			// A worker stub answers it instead of the real desktop, so the case
			// stays about the authorization gate and not about a live worker.
			connect: async (binding) =>
				({
					binding,
					prompt: async () => ({ stopReason: "end_turn" }),
					respondToPermission: async () => undefined,
					cancel: async () => undefined,
					close: async () => undefined,
				}) as unknown as DesktopSession,
		});

		const { ctx } = makeMockContext(projectRoot);
		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		const taskTool = tools.get("wb_task");
		expect(taskTool).toBeDefined();

		const result = await taskTool!.execute(
			"call-1",
			{
				goal: {
					objective: "test task",
					acceptance: ["verified"],
				},
			},
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);

		// wb_task might fail because there is no real worker running, but it must NOT refuse with WB_MIGRATION_REQUIRED
		const resultJson = JSON.stringify(result);
		expect(resultJson.includes(WB_ERROR_CODE.migrationRequired)).toBe(false);
	});

	it("3. with the bunExe lookup returning null, setup writes NOTHING and does not report success", async () => {
		const projectRoot = await createProjectRoot();

		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			whichBun: () => null,
		});

		const { ctx, notifications } = makeMockContext(projectRoot);
		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		expect(
			notifications.some(
				(n) => n.type === "error" && n.message.includes("Bun executable not found on PATH"),
			),
		).toBe(true);
		expect(
			notifications.some((n) => n.message.includes("Successfully configured MCP")),
		).toBe(false);

		// Assert that no config file was written
		const ompMcpPath = path.join(projectRoot, ".omp", "mcp.json");
		expect(existsSync(ompMcpPath)).toBe(false);
	});

	it("4. when migration throws WB_MIGRATION_REQUIRED, user sees that message and project_enabled_at is still absent", async () => {
		const projectRoot = await createProjectRoot();
		const migrationMessage =
			"Old bridge process 4242 still holds task 999; finish or exit the old bridge work, then retry. The WorkBuddy desktop session is untouched.";

		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			// Setup probes sessions before migrating; without this the test reads the
			// real user home and the Windows socket fallback, which no unit test may
			// touch. An empty roster is also the honest fixture for a fresh project.
			discover: async () => [],
			migrateProject: async () => {
				throw new WbTaskError(WB_ERROR_CODE.migrationRequired, migrationMessage);
			},
		});

		const { ctx, notifications } = makeMockContext(projectRoot);
		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		expect(
			notifications.some((n) => n.type === "error" && n.message === migrationMessage),
		).toBe(true);
		expect(
			notifications.some((n) => n.message.includes("Successfully configured MCP")),
		).toBe(false);

		const access = await readProjectAccess(projectRoot);
		expect(access === null || access.enabled === false).toBe(true);
	});

	it("5. read-only surfaces create no .wb-bridge/ directory when called on a project that has none", async () => {
		const projectRoot = await createProjectRoot();
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		expect(existsSync(bridgeDir)).toBe(false);

		const { commands, tools } = makeMockApi({ workbuddyHomeDir: path.join(projectRoot, ".test-home") });
		const { ctx } = makeMockContext(projectRoot);

		// Call /wb status
		await commands.get("wb")!.handler("status", ctx as unknown as ExtensionCommandContext);
		expect(existsSync(bridgeDir)).toBe(false);

		// Call wb_status tool
		const statusTool = tools.get("wb_status");
		expect(statusTool).toBeDefined();
		await statusTool!.execute(
			"call-status",
			{ taskId: "11111111-2222-4333-8444-555555555555", waitMs: 0 },
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);
		expect(existsSync(bridgeDir)).toBe(false);

		// Call wb_doctor tool
		const doctorTool = tools.get("wb_doctor");
		expect(doctorTool).toBeDefined();
		await doctorTool!.execute(
			"call-doctor",
			{},
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);
		expect(existsSync(bridgeDir)).toBe(false);
	});
});

describe("enable path: empty pool and explicit session choice", () => {
	it("6. enables a project with no discoverable session at all (empty pool)", async () => {
		const projectRoot = await createProjectRoot();
		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => [],
		});
		const { ctx, notifications } = makeMockContext(projectRoot);

		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		expect(notifications.some((n) => n.type === "info" && n.message.includes("Successfully configured MCP"))).toBe(true);
		const access = await readProjectAccess(projectRoot);
		expect(access).not.toBeNull();
		// An empty pool is a legitimate state: the user simply has not opened a
		// WorkBuddy conversation yet. Without this the project could never be
		// enabled and every wb_task would be refused.
		expect(access!.enabled).toBe(true);
		expect(access!.migrated).toBe(true);
		expect(existsSync(path.join(projectRoot, ".wb-bridge", "binding.json"))).toBe(false);
	});

	it("7. a declined enrollment writes no binding but still enables the project", async () => {
		const projectRoot = await createProjectRoot();
		const written: string[] = [];
		const ids = ["33333333-4444-4555-8666-777777777777", "44444444-5555-4666-8777-888888888888"];
		const candidates = ids.map((id) => ({
			endpoint: "http://127.0.0.1:1234",
			binding: { version: 1 as const, projectRoot, sessionId: id, workbuddyVersion: "5.8.2" },
			busy: false,
		}));
		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => candidates,
			writeBinding: async (binding) => {
				written.push(binding.sessionId);
			},
		});
		const { ctx, confirmations } = makeMockContext(projectRoot, { confirmed: false });

		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		// The question really was asked: an empty `confirmations` would mean the
		// code skipped the decision entirely, which is a different bug from a
		// decline.
		expect(confirmations.some((prompt) => prompt.includes("Enroll this project's WorkBuddy sessions"))).toBe(true);
		expect(written).toHaveLength(0);
		const access = await readProjectAccess(projectRoot);
		expect(access!.enabled).toBe(true);
		expect(access!.migrated).toBe(true);
	});

	it("8. consenting to the enrollment binds every verified session of the project", async () => {
		const projectRoot = await createProjectRoot();
		const written: Binding[] = [];
		const ids = ["55555555-6666-4777-8888-999999999999", "66666666-7777-4888-8999-aaaaaaaaaaaa"] as const;
		const candidates = ids.map((id) => ({
			endpoint: "http://127.0.0.1:1234",
			binding: { version: 1 as const, projectRoot, sessionId: id, workbuddyVersion: "5.8.2" },
			busy: false,
		}));
		const { commands } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => candidates,
			writeBinding: async (binding) => {
				written.push(binding);
			},
		});
		const { ctx } = makeMockContext(projectRoot, { confirmed: true });

		await commands.get("wb")!.handler("setup", ctx as unknown as ExtensionCommandContext);

		// The enrollment is project-wide: both verified sessions are recorded, and
		// the project keeps the consent so a restart enrolls later sessions
		// without asking again.
		expect(written).toHaveLength(1);
		const roster = written[0]!.sessions ?? [];
		expect(roster.map((member) => member.sessionId).sort()).toEqual([...ids].sort());
		expect(written[0]!.autoBindProjectSessions).toBe(true);
	});
});

describe("enable gate at the task entry", () => {
	it("refuses dispatch when a binding exists but the project is not enabled", async () => {
		const projectRoot = await createProjectRoot();
		const sessionId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

		// A binding on disk with no database: exactly the state a v2 user is in
		// after upgrading. The entry gate must refuse, not fall through to the
		// legacy dispatch path.
		await mkdir(path.join(projectRoot, ".wb-bridge"), { recursive: true });
		await writeFile(
			path.join(projectRoot, ".wb-bridge", "binding.json"),
			JSON.stringify({ version: 1, projectRoot, sessionId, workbuddyVersion: "5.8.2" }),
			"utf-8",
		);

		const { tools } = makeMockApi({
			workbuddyHomeDir: path.join(projectRoot, ".test-home"),
			discover: async () => [],
		});
		const { ctx } = makeMockContext(projectRoot);

		const taskTool = tools.get("wb_task");
		expect(taskTool).toBeDefined();
		const result = await taskTool!.execute(
			"call-gate",
			{ goal: { objective: "should be refused", acceptance: ["x"] } },
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);

		expect(result.isError).toBe(true);
		const details = result.details as { error?: { code?: string } } | undefined;
		expect(details?.error?.code).toBe(WB_ERROR_CODE.migrationRequired);
		// The refusal names the command that actually enables a project.
		expect(JSON.stringify(result)).toContain("/wb setup");
	});
});
