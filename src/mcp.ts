#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { getProjectContext, type ProjectContextQuery } from "./collaboration";
import { readProjectAccess, type ProjectAccess } from "./queue";
import { resolveWorkBuddyCaller } from "./session-pool";
import { readTaskIndex, WbTaskError } from "./tasks";
import { WB_ERROR_CODE } from "./types";

/**
 * The version of the package this file belongs to.
 *
 * Resolved from `package.json` next to the source so a release directory reports
 * its own version, never the version of whatever checkout happened to be imported.
 */
async function packageVersion(): Promise<string> {
	// Resolved from this module rather than from the process cwd: OMP and WorkBuddy
	// each start the MCP server from their own working directory, so a cwd-relative
	// path would find the package only when launched from the repository root.
	const manifestPath = path.resolve(import.meta.dir, "..", "package.json");
	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf-8");
	} catch (err: unknown) {
		throw new Error(
			`Cannot read ${manifestPath} to report the server version: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
		throw new Error(`${manifestPath} has no version field`);
	}
	return parsed.version;
}

interface ParsedArgs {
	projectRoot: string;
	/**
	 * True when the project must be derived from the calling worker.
	 *
	 * One MCP entry registered once for every project cannot name a root at launch, so
	 * `--global` defers the answer to the call. It never means "no project": derivation
	 * still fails closed, because filing one project's work under another's is the worst
	 * outcome this server could produce.
	 */
	global: boolean;
}

function parseCliArgs(rawArgs: string[]): ParsedArgs {
	let projectRoot = "";
	let global = false;

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--project" && i + 1 < rawArgs.length) {
			projectRoot = rawArgs[i + 1]!;
			i++;
		} else if (arg === "--global") {
			global = true;
		} else if (arg === "--agent" && i + 1 < rawArgs.length) {
			// Accepted and ignored so configurations written before the tool surface
			// became read-only still start. No tool is gated on the role any more.
			i++;
		}
	}

	if (!projectRoot && !global) {
		process.stderr.write(
			"Usage: bun src/mcp.ts --project <canonical-project-root>\n" +
				"       bun src/mcp.ts --global   (derive the project from the verified calling worker)\n",
		);
		process.exit(1);
	}
	if (projectRoot && global) {
		// Both means the caller is unsure which one wins. Refusing is cheaper than
		// silently preferring one and filing work under a project they did not mean.
		process.stderr.write("Refusing both --project and --global: state the project or ask for derivation, not both.\n");
		process.exit(1);
	}

	return { projectRoot, global };
}

/**
 * Derives the project root from the worker that launched this server.
 *
 * Only a verified caller yields a root. Everything else — no parent worker, a stale
 * record, a directory the worker does not actually work in — is reported to the caller
 * as a refusal, because a guessed root is indistinguishable from a wrong one.
 */
async function deriveGlobalProjectRoot(): Promise<string> {
	// Only the variables the *host* injects. `PWD` is set by any shell, so trusting it
	// would let a server started from a terminal bind to whatever directory that
	// terminal happened to be in — the exact guess `resolveWorkBuddyCaller` refuses to
	// make. No injected directory means no derivation.
	const injected = process.env["CODEBUDDY_PROJECT_DIR"] ?? process.env["CLAUDE_PROJECT_DIR"] ?? null;
	const caller = await resolveWorkBuddyCaller({ injectedCwd: injected });
	if (caller.kind !== "verified") {
		process.stderr.write(
			`Cannot derive the project for --global: ${caller.reason}. ` +
				"Pass --project <canonical-project-root> instead, or start this server from the bound project.\n",
		);
		process.exit(1);
	}
	return caller.cwd;
}

async function main(): Promise<void> {
	const cli = parseCliArgs(process.argv.slice(2));

	const declaredRoot = cli.global ? await deriveGlobalProjectRoot() : cli.projectRoot;
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(declaredRoot);
	} catch (err) {
		process.stderr.write(`Failed to resolve canonical project root "${declaredRoot}": ${String(err)}\n`);
		process.exit(1);
	}

	// A read-only view of the project's authorization. It is reported to the caller
	// but never consulted for permission: this server has no mutating tool.
	let projectAccess: ProjectAccess | null = null;
	try {
		projectAccess = await readProjectAccess(canonicalRoot);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new WbTaskError(WB_ERROR_CODE.storageError, message);
	}

	// Read from the package rather than restated: the version a client sees must be
	// the version actually loaded, and two literals drift the first time one changes.
	const server = new McpServer({
		name: "omp-wb-bridge",
		version: await packageVersion(),
	});

	// The only tool. Occupancy, claiming and publication are queue lifecycle
	// operations; an MCP write surface here would be a second authority deciding
	// the same scopes.
	server.registerTool(
		"project_context",
		{
			description:
				"Read-only project context: current queue-backed work, scope allocations, deliverables, review opinions, and historical records. Never claims or publishes.",
			annotations: { readOnlyHint: true },
			inputSchema: z
				.object({
					projectRoot: z.string().describe("Canonical root directory of the project"),
					workId: z.string().optional().describe("Optional UUID of a specific work item to inspect details"),
					paths: z.array(z.string()).optional().describe("Filter work items whose scopes overlap with these project-relative paths"),
					includeClosed: z.boolean().optional().default(false).describe("Include released/closed work items"),
					offset: z.number().int().nonnegative().optional().default(0).describe("Pagination offset"),
					limit: z.number().int().min(1).max(20).optional().default(8).describe("Pagination limit (1 to 20)"),
				})
				.strict(),
		},
		async (args) => {
			try {
				const callRoot = await realpath(args.projectRoot);
				if (callRoot !== canonicalRoot) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: {
										code: WB_ERROR_CODE.bindingInvalid,
										message: `Tool projectRoot "${args.projectRoot}" does not match server startup project "${canonicalRoot}"`,
									},
								}),
							},
						],
					};
				}

				if (projectAccess !== null && projectAccess.projectRoot !== canonicalRoot) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: {
										code: WB_ERROR_CODE.bindingInvalid,
										message: `Project database root "${projectAccess.projectRoot}" does not match server startup project "${canonicalRoot}"`,
									},
								}),
							},
						],
					};
				}

				const query: ProjectContextQuery = {
					workId: args.workId,
					paths: args.paths,
					includeClosed: args.includeClosed,
					offset: args.offset,
					limit: args.limit,
				};

				const result = await getProjectContext(canonicalRoot, query);

				// Historical task receipts predate the queue's works rows. Project them
				// into a listing so a project's older delegations do not look idle; a
				// detail lookup still resolves only real current or historical records.
				if (args.workId === undefined) {
					try {
						const taskIndex = await readTaskIndex(canonicalRoot);
						for (const entry of taskIndex.entries) {
							const alreadyPresent = result.entries.some((e) => e.workId === entry.taskId);
							if (!alreadyPresent) {
								result.entries.push({
									workId: entry.taskId,
									owner: "workbuddy",
									revision: null,
									title: "Delegated Task",
									phase: "historic",
									scope: null,
									state: entry.status === "completed" ? "released" : "blocked",
									workerStatus: entry.status,
									round: entry.round,
									milestone: "historic",
									blocker: "",
									updatedAt: new Date(entry.updatedAt).toISOString(),
									artifactCount: 0,
									warnings: [],
								});
							}
						}
						result.total = result.entries.length;
					} catch {
						// A task index that cannot be read must not hide the queue's answer.
					}
				}

				const response = {
					...result,
					projectAccess: projectAccess ?? { projectRoot: canonicalRoot, enabled: false, migrated: false },
				};
				const serialized = JSON.stringify(response);
				return {
					content: [{ type: "text", text: serialized }],
					structuredContent: response as unknown as Record<string, unknown>,
				};
			} catch (err: unknown) {
				const code = err instanceof WbTaskError ? err.code : "WB_TASK_FAILED";
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
					structuredContent: { error: { code, message } },
				};
			}
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err: unknown) => {
	process.stderr.write(`MCP server fatal error: ${String(err)}\n`);
	process.exit(1);
});
