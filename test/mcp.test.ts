/**
 * The MCP surface is read-only.
 *
 * Occupancy, claiming and publication are queue lifecycle operations; an MCP write
 * tool here would be a second authority deciding the same scopes, which is exactly
 * the dual-writer defect this release removes. These tests pin the remaining half:
 * one read-only tool, a real refusal for a foreign project, and a `--global` launch
 * that derives the caller's project or refuses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { migrateProjectToQueue } from "../src/migration";
import { enableProject } from "../src/queue";
import { WB_ERROR_CODE } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const allocatedRoots: string[] = [];
const openTransports: StdioClientTransport[] = [];

async function createProjectRoot(): Promise<string> {
	const canonical = await createFixtureRoot("mcp-test-suite-");
	allocatedRoots.push(canonical);
	await migrateProjectToQueue(canonical).catch(() => undefined);
	await enableProject(canonical);
	return canonical;
}

async function startClient(projectRoot: string): Promise<{ client: Client; transport: StdioClientTransport }> {
	const mcpScript = path.resolve("./src/mcp.ts");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [mcpScript, "--project", projectRoot],
	});
	openTransports.push(transport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(transport);
	return { client, transport };
}

/** The text of one MCP tool result, for tests that parse the payload. */
function contentText(result: unknown): string {
	const blocks = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
	const first = blocks.find((block) => block.type === "text");
	return first?.text ?? "";
}

afterEach(async () => {
	while (openTransports.length > 0) {
		const transport = openTransports.pop();
		if (transport !== undefined) {
			await transport.close().catch(() => undefined);
		}
	}
	while (allocatedRoots.length > 0) {
		const target = allocatedRoots.pop();
		if (target !== undefined) {
			// This suite enables the project, so the parent process holds its SQLite
			// handles: close them or Windows refuses the delete.
			await releaseProjectFixture(target);
		}
	}
});

describe("MCP server surface", () => {
	it("exposes exactly one read-only tool", async () => {
		const root = await createProjectRoot();
		const { client } = await startClient(root);
		const tools = (await client.listTools()).tools;

		// No claim/publish/release: those are queue lifecycle operations, and a second
		// authority deciding the same scopes is what this release removes.
		expect(tools.map((tool) => tool.name)).toEqual(["project_context"]);
		expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
	});

	it("starts from a working directory outside the repository", async () => {
		const root = await createProjectRoot();
		const elsewhere = await createFixtureRoot("mcp-cwd-");
		allocatedRoots.push(elsewhere);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [path.resolve("./src/mcp.ts"), "--project", root],
			cwd: elsewhere,
		});
		openTransports.push(transport);
		const client = new Client({ name: "cwd-test-client", version: "1.0.0" });
		await client.connect(transport);
		try {
			const tools = await client.listTools();
			// The server started and reported its tool: the version lookup and the
			// project resolution both worked without a repository cwd.
			expect(tools.tools.map((tool) => tool.name)).toContain("project_context");
		} finally {
			await transport.close().catch(() => undefined);
		}
	}, 30_000);

	it("refuses a call naming a different project than the server's", async () => {
		const root = await createProjectRoot();
		const otherRoot = await createProjectRoot();
		const { client } = await startClient(root);

		const result = await client.callTool({ name: "project_context", arguments: { projectRoot: otherRoot } });
		expect(result.isError).toBe(true);
		const parsed = JSON.parse(contentText(result)) as { error?: { code?: string } };
		expect(parsed.error?.code).toBe(WB_ERROR_CODE.bindingInvalid);
	});

	it("reads this project's context without creating or claiming anything", async () => {
		const root = await createProjectRoot();
		const { client } = await startClient(root);

		const result = await client.callTool({ name: "project_context", arguments: { projectRoot: root } });
		const parsed = JSON.parse(contentText(result)) as {
			entries: unknown[];
			projectAccess?: { enabled?: boolean };
		};
		// An empty but enabled project is a real answer, not an error.
		expect(Array.isArray(parsed.entries)).toBeTrue();
		expect(parsed.entries).toHaveLength(0);
		expect(parsed.projectAccess?.enabled).toBe(true);
	});
});

describe("--global derives the project or refuses", () => {
	/**
	 * One MCP entry can be registered once for every project, so it cannot name a root
	 * at launch. Derivation is the point — and refusal is the safety property: a guessed
	 * root is indistinguishable from a wrong one.
	 */
	it("refuses when no host-injected project directory is present", async () => {
		const env = { ...process.env };
		delete env["CODEBUDDY_PROJECT_DIR"];
		delete env["CLAUDE_PROJECT_DIR"];
		// A shell's PWD is not a host injection: trusting it would bind to whatever
		// directory the terminal happened to be in.
		env["PWD"] = "/tmp";

		const proc = Bun.spawn([process.execPath, path.resolve("./src/mcp.ts"), "--global"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain("Cannot derive the project for --global");
		expect(stderr).toContain("--project");
	});

	it("refuses to be told both a project and --global", async () => {
		const proc = Bun.spawn(
			[process.execPath, path.resolve("./src/mcp.ts"), "--global", "--project", process.cwd()],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain("Refusing both --project and --global");
	});

	/**
	 * The success path, not just the refusals: a verified caller's cwd must actually
	 * become the project. The worker is simulated — a wrapper writes its own registry
	 * record and then starts the server as its child, so the server's ppid is a real pid
	 * with a matching record.
	 */
	it("derives the project from a verified caller", async () => {
		const root = await createProjectRoot();
		const home = await createFixtureRoot("mcp-global-home-");
		allocatedRoots.push(home);
		const sessionsDir = path.join(home, ".workbuddy", "sessions");
		await mkdir(sessionsDir, { recursive: true });

		const worker = path.join(home, "fake-worker.ts");
		await writeFile(
			worker,
			[
				`const sessions = ${JSON.stringify(sessionsDir)};`,
				`await Bun.write(sessions + "/" + process.pid + ".json", JSON.stringify({`,
				`	pid: process.pid, sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",`,
				`	kind: "interactive", version: "1.2.3", cwd: ${JSON.stringify(root)},`,
				`}));`,
				`const child = Bun.spawn([process.execPath, ${JSON.stringify(path.resolve("./src/mcp.ts"))}, "--global"], {`,
				`	env: { ...process.env, USERPROFILE: ${JSON.stringify(home)}, HOME: ${JSON.stringify(home)}, CODEBUDDY_PROJECT_DIR: ${JSON.stringify(root)} },`,
				`	stdin: "inherit", stdout: "inherit", stderr: "inherit",`,
				`});`,
				`await child.exited;`,
			].join("\n"),
			"utf-8",
		);

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [worker],
			env: {
				...process.env,
				USERPROFILE: home,
				HOME: home,
				CODEBUDDY_PROJECT_DIR: root,
			} as Record<string, string>,
		});
		openTransports.push(transport);
		const client = new Client({ name: "test-global", version: "1.0.0" });
		await client.connect(transport);

		// The tool checks the caller's root against the server's startup project, so
		// passing the fixture only works if derivation agreed with it.
		const listed = await client.callTool({ name: "project_context", arguments: { projectRoot: root } });
		const parsed = JSON.parse(contentText(listed)) as { entries: unknown[] };
		expect(Array.isArray(parsed.entries)).toBeTrue();
	}, 30_000);
});
