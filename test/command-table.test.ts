/**
 * The command table and the dispatcher must agree.
 *
 * The table exists so a command's existence, usage and completion come from one
 * place instead of a string chain plus a hand-maintained help message. That only
 * holds if every entry is actually routed and every routed name is an entry —
 * the two assertions below.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import { completionChoices, parseCommand, usageListing, usageOf, WB_COMMANDS } from "../src/command-spec";
import { closeQueueConnection, enableProject } from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await releaseProjectFixture(root);
		}
	}
});

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** Registers the extension against a fixture project and returns its commands. */
async function registeredCommands(): Promise<{
	commands: Map<string, RegisteredCommand>;
	notifications: Array<{ message: string; type?: string }>;
	root: string;
}> {
	const root = await createFixtureRoot("wb-commands-");
	roots.push(root);
	await migrateProjectToQueue(root);
	await enableProject(root);
	await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
	await writeFile(
		path.join(root, ".wb-bridge", "binding.json"),
		JSON.stringify({ version: 1, projectRoot: root, sessionId: "66666666-7777-4888-8999-aaaaaaaaaaaa", workbuddyVersion: "1.2.3" }),
		"utf-8",
	);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");

	const commands = new Map<string, RegisteredCommand>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const api = {
		zod: { string: () => chain(), number: () => chain(), boolean: () => chain(), array: () => chain(), enum: () => chain(), object: () => chain() },
		logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
		on: () => undefined,
		registerTool: () => undefined,
		registerCommand: (name: string, options: RegisteredCommand) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	function chain(): Record<string, () => unknown> {
		const self: Record<string, () => unknown> = {
			describe: () => self,
			strict: () => self,
			optional: () => self,
		};
		return self;
	}
	const overrides: BridgeOverrides = {
		workbuddyHomeDir: path.join(root, ".test-home"),
		discover: async () => [],
	};
	activate(api, overrides);
	void notifications;
	return { commands, notifications, root };
}

/** A command context that records notifications instead of printing them. */
function makeCommandContext(root: string, notifications: Array<{ message: string }>): ExtensionCommandContext {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId: () => "omp-command-session" },
		ui: {
			notify: (message: string) => {
				notifications.push({ message });
			},
			select: async () => undefined,
			confirm: async () => false,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext as ExtensionCommandContext;
}

describe("command table", () => {
	it("routes every registered command without calling it unknown or unimplemented", async () => {
		const { commands, notifications, root } = await registeredCommands();
		const wb = commands.get("wb");
		expect(wb).toBeDefined();

		// Every table entry must be runnable in this build. The only failure a
		// registered command may still print is a legitimate domain refusal (no
		// binding, no queue, headless interaction required), never a dispatch
		// gap: "unknown", "no handler" and "not available" all mean the table
		// and the dispatcher disagree, which is what this test forbids.
		for (const spec of WB_COMMANDS) {
			notifications.length = 0;
			await wb!.handler(spec.name, makeCommandContext(root, notifications));
			const firstLine = (notifications[notifications.length - 1]?.message ?? "").split("\n")[0] ?? "";
			expect(firstLine).not.toContain("Unknown /wb subcommand");
			expect(firstLine).not.toContain("has no handler in this build");
			expect(firstLine).not.toContain("not available in this build");
		}
	}, 30_000);

	it("produces real output for the commands it registers", async () => {
		const { commands, notifications, root } = await registeredCommands();
		const wb = commands.get("wb")!;
		const run = async (args: string): Promise<string> => {
			notifications.length = 0;
			await wb!.handler(args, makeCommandContext(root, notifications));
			return notifications.map((entry) => entry.message).join("\n");
		};

		// Routing alone would let a command notify an error and still pass. Each of these
		// names what the command is for in its own words.
		expect(await run("tasks")).toContain("Tasks in");
		// Headless: the cancellation list is printed and nothing is guessed.
		expect(await run("cancel")).toMatch(/Nothing in this process is running|needs an interactive OMP session/);
		// A diagnosis reports the areas it covers, read-only.
		const diagnosed = await run("doctor");
		expect(diagnosed.toLowerCase()).toContain("binding");
		// The reference lists what exists, and nothing more.
		const usage = await run("usage");
		for (const spec of WB_COMMANDS.filter((candidate) => candidate.name.length > 0)) {
			expect(usage).toContain(spec.name);
		}
	}, 30_000);

	it("opens the workbench for a bare /wb, printing every page when there is no UI", async () => {
		const { commands, notifications, root } = await registeredCommands();
		const wb = commands.get("wb")!;

		await wb.handler("", makeCommandContext(root, notifications));
		const text = notifications.at(-1)?.message ?? "";
		// The workbench is the entry point a bare /wb implies, and headless use still
		// gets the same facts rather than silence.
		expect(text).toContain("— tasks —");
		expect(text).toContain("— sessions —");
		expect(text).toContain("— diagnostics —");
		// The removed help platform must not render a page that no longer exists.
		expect(text).not.toContain("— help —");
		// A registered command must not answer "unknown" for the bare form.
		expect(text).not.toContain("Unknown /wb subcommand");
	}, 30_000);

	it("lists an unknown subcommand with the available entry points", async () => {
		const { commands, notifications, root } = await registeredCommands();
		const wb = commands.get("wb")!;

		await wb.handler("definitely-not-a-command", makeCommandContext(root, notifications));
		const message = notifications.at(-1)?.message ?? "";
		expect(message).toContain('Unknown /wb subcommand: "definitely-not-a-command"');
		// The same reference the table produces, so the suggestion cannot drift.
		expect(message).toContain(usageOf(WB_COMMANDS.find((spec) => spec.name === "status")!));
	});

	it("reports a removed command as unknown rather than recognized-but-unavailable", async () => {
		const { commands, notifications, root } = await registeredCommands();
		const wb = commands.get("wb")!;

		// The work-package platform is gone, not parked: `prepare` must now be an
		// unknown subcommand pointing at the real entry points, never a promise
		// that it might come back in a later build.
		await wb.handler("prepare pkg.json", makeCommandContext(root, notifications));
		const message = notifications.at(-1)?.message ?? "";
		expect(message).toContain('Unknown /wb subcommand: "prepare"');
		expect(message).not.toContain("not available in this build");
	}, 30_000);

	it("derives help text from the table, and only from the table", () => {
		const listing = usageListing();
		for (const spec of WB_COMMANDS) {
			if (spec.name === "") {
				continue;
			}
			expect(listing).toContain(spec.summary);
		}
		// A removed platform must not survive in the reference.
		expect(listing).not.toContain("package");
		expect(listing).not.toContain("not available in this build");
	});

	it("completes only registered subcommands", () => {
		// Every registered name is offered; a removed one is not.
		expect(completionChoices("")).toEqual(
			expect.arrayContaining(WB_COMMANDS.filter((spec) => spec.name.length > 0).map((spec) => spec.name)),
		);
		expect(completionChoices("pre")).toEqual([]);
		expect(completionChoices("rep")).toContain("repair");
		expect(completionChoices("re")).toEqual(expect.arrayContaining(["release", "repair", "results"]));

		expect(completionChoices("sta")).toContain("status");
	});

	it("parses flags and positional arguments, and tolerates a bare invocation", () => {
		const bare = parseCommand("");
		// A bare /wb opens the workbench; it is the empty-named entry, not a special
		// case in the handler.
		expect(bare.spec?.name).toBe("");
		expect(bare.usage).toBe("/wb");

		const withArg = parseCommand("background 11111111-1111-4111-8111-111111111111");
		expect(withArg.subcommand).toBe("background");
		expect(withArg.positional).toEqual(["11111111-1111-4111-8111-111111111111"]);

		// A flag with no value records an empty string so the handler can refuse it
		// rather than silently treating it as absent.
		const dangling = parseCommand("results --task");
		expect(dangling.flags["task"]).toBe("");

		expect(parseCommand("nope").spec).toBeNull();
	});
});
