#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
	claimWork,
	getProjectContext,
	publishWork,
	type ProjectContextQuery,
} from "./collaboration";
import { readTaskIndex, WbTaskError } from "./tasks";
import { type WorkRecord, WB_ERROR_CODE } from "./types";

interface ParsedArgs {
	projectRoot: string;
	agent: "omp" | "workbuddy";
}

function parseCliArgs(rawArgs: string[]): ParsedArgs {
	let projectRoot = "";
	let agent: "omp" | "workbuddy" | "" = "";

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--project" && i + 1 < rawArgs.length) {
			projectRoot = rawArgs[i + 1]!;
			i++;
		} else if (arg === "--agent" && i + 1 < rawArgs.length) {
			const val = rawArgs[i + 1]!;
			if (val === "omp" || val === "workbuddy") {
				agent = val;
			}
			i++;
		}
	}

	if (!projectRoot || !agent) {
		process.stderr.write("Usage: bun src/mcp.ts --project <canonical-project-root> --agent <omp|workbuddy>\n");
		process.exit(1);
	}

	return { projectRoot, agent };
}

async function main(): Promise<void> {
	const cli = parseCliArgs(process.argv.slice(2));

	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(cli.projectRoot);
	} catch (err) {
		process.stderr.write(`Failed to resolve canonical project root "${cli.projectRoot}": ${String(err)}\n`);
		process.exit(1);
	}

	const server = new McpServer({
		name: "omp-wb-bridge",
		version: "2.0.0",
	});

	// Tool 1: project_context
	server.registerTool(
		"project_context",
		{
			description:
				"Query project collaboration records, scope allocations, deliverables, and review opinions across OMP and WorkBuddy.",
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

				const query: ProjectContextQuery = {
					workId: args.workId,
					paths: args.paths,
					includeClosed: args.includeClosed,
					offset: args.offset,
					limit: args.limit,
				};

				const result = await getProjectContext(canonicalRoot, query);

				// If index query without workId, project historic tasks from readTaskIndex if not already in records
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
						// Ignore index read failures
					}
				}

				const serialized = JSON.stringify(result);
				return {
					content: [{ type: "text", text: serialized }],
					structuredContent: result as unknown as Record<string, unknown>,
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

	// Tool 2: work_claim
	server.registerTool(
		"work_claim",
		{
			description:
				"Claim or update business file scope for a collaborative work item before starting or continuing execution.",
			inputSchema: z
				.object({
					projectRoot: z.string().describe("Canonical root directory of the project"),
					workId: z.string().optional().describe("Work item UUID if updating existing claim; omit to create new work item"),
					expectedRevision: z.number().int().positive().optional().describe("Expected revision number for optimistic concurrency when updating"),
					title: z.string().describe("Short title of the planned work (max 160 characters)"),
					scope: z
						.object({
							readPaths: z.array(z.string()).describe("Project-relative file paths or directory prefixes to read"),
							writePaths: z.array(z.string()).describe("Project-relative file paths or directory prefixes to modify. For WorkBuddy, pass empty array (automatically assigned outputsDir)"),
						})
						.strict(),
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

				const claimResult = await claimWork(canonicalRoot, cli.agent, {
					workId: args.workId,
					expectedRevision: args.expectedRevision,
					title: args.title,
					scope: args.scope,
				});

				const serialized = JSON.stringify(claimResult);
				return {
					content: [{ type: "text", text: serialized }],
					structuredContent: claimResult as unknown as Record<string, unknown>,
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

	// Tool 3: work_publish
	server.registerTool(
		"work_publish",
		{
			description:
				"Publish progress checkpoints, deliverables, remote results, review verdicts, or release business scope.",
			inputSchema: z
				.object({
					projectRoot: z.string().describe("Canonical root directory of the project"),
					workId: z.string().describe("UUID of the work item"),
					expectedRevision: z.number().int().positive().nullable().describe("Current revision for optimistic concurrency, or null for initial review of historic records"),
					progress: z
						.object({
							state: z.enum(["active", "blocked"]).describe("State of execution"),
							phase: z.string().describe("Current execution phase (max 160 characters)"),
							milestone: z.string().describe("Latest completed milestone (max 240 characters)"),
							blocker: z.string().describe("Current blocker description if blocked (max 240 characters)"),
						})
						.strict()
						.optional(),
					files: z
						.array(
							z
								.object({
									path: z.string().describe("Relative path within outputs (WorkBuddy) or relative to project root (OMP)"),
									role: z.enum(["final", "supporting"]).describe("Deliverable role"),
									importFrom: z.string().optional().describe("For WorkBuddy: project-relative path of existing project file to import into outputs"),
								})
								.strict(),
						)
						.optional(),
					remoteResults: z
						.array(
							z
								.object({
									kind: z.enum(["publish", "deploy", "cloud_write", "schedule"]),
									target: z.string(),
									evidence: z.string(),
								})
								.strict(),
						)
						.optional(),
					review: z
						.object({
							round: z.number().int().positive().nullable().describe("Task round being reviewed"),
							artifacts: z
								.array(
									z
										.object({
											path: z.string(),
											sha256: z.string(),
										})
										.strict(),
								)
								.describe("List of exact artifacts and their verified SHA-256 hashes"),
							verdict: z.enum(["accepted", "changes_requested", "unverified"]).describe("Review opinion"),
							note: z.string().describe("Review feedback or verification note (max 240 characters)"),
						})
						.strict()
						.optional(),
					release: z.boolean().optional().default(false).describe("Release business scope on completion"),
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

				const published: WorkRecord = await publishWork(canonicalRoot, cli.agent, {
					workId: args.workId,
					expectedRevision: args.expectedRevision,
					progress: args.progress,
					files: args.files,
					remoteResults: args.remoteResults?.map((rr) => ({
						kind: rr.kind,
						target: rr.target,
						evidence: rr.evidence,
						verification: "reported" as const,
					})),
					review: args.review,
					release: args.release,
				});

				const serialized = JSON.stringify(published);
				return {
					content: [{ type: "text", text: serialized }],
					structuredContent: published as unknown as Record<string, unknown>,
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
