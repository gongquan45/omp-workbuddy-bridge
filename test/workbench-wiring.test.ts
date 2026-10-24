/**
 * The workbench is actually reachable through the real entry point.
 *
 * Rendering is covered by `workbench.test.ts`; what remains is that pressing `/wb`
 * with no arguments opens it and that its component can be driven by input. This
 * case uses the host's real `ctx.ui.custom` contract shape (a factory returning a
 * component with `render`/`handleInput`) so a change to either side fails here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import activate, { type BridgeOverrides } from "../src/index";
import { closeQueueConnection, enableProject } from "../src/queue";
import { migrateProjectToQueue } from "../src/migration";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const SESSION_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
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
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** One captured component, so the test can render and drive it. */
interface CapturedComponent {
	render: (width: number) => readonly string[];
	handleInput?: (data: string) => void;
}

function makeApi(projectRoot: string) {
	const commands = new Map<string, RegisteredCommand>();
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
		registerTool: () => undefined,
		registerCommand: (name: string, options: RegisteredCommand) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	const overrides: BridgeOverrides = {
		workbuddyHomeDir: path.join(projectRoot, ".test-home"),
		discover: async () => [],
	};
	return { api, overrides, commands };
}

describe("workbench entry point", () => {
	it("hands a renderable component to the host and turns pages on input", async () => {
		const root = await createFixtureRoot("wb-workbench-");
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

		const { api, overrides, commands } = makeApi(root);
		activate(api, overrides);

		let captured: CapturedComponent | null = null;
		let finished = false;
		const notifications: string[] = [];
		const ctx = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "omp-workbench-session" },
			ui: {
				notify: (message: string) => notifications.push(message),
				select: async () => undefined,
				confirm: async () => true,
				setStatus: () => undefined,
				custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: null) => void) => unknown) => {
					const component = factory({}, {}, {}, () => {
						finished = true;
					});
					captured = component as CapturedComponent;
					return null;
				},
			},
		} as unknown as ExtensionContext as ExtensionCommandContext;

		await commands.get("wb")!.handler("", ctx);

		expect(captured).not.toBeNull();
		// The first page renders rows the host can draw, at the width it asks for.
		const first = captured!.render(80);
		expect(first.length).toBeGreaterThan(0);
		expect(first.join("\n")).toContain("[tasks]");
		for (const row of first) {
			expect(row.length).toBeLessThanOrEqual(80);
		}

		// Tab advances the page; the component re-renders from the same snapshot.
		captured!.handleInput?.("\t");
		const second = captured!.render(80).join("\n");
		expect(second).toContain("[sessions]");

		// A second tab reaches diagnostics; the removed help platform has no page
		// to turn to, so three tabs return to tasks.
		captured!.handleInput?.("\t");
		const third = captured!.render(80).join("\n");
		expect(third).toContain("[diagnostics]");
		captured!.handleInput?.("\t");
		const wrapped = captured!.render(80).join("\n");
		expect(wrapped).toContain("[tasks]");

		// Escape closes it, which is what the host's `done` callback means.
		captured!.handleInput?.("\u001b");
		expect(finished).toBeTrue();
	}, 30_000);
});
