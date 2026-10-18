import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { computeFileSha256 } from "../src/tasks";
import { migrateProjectToQueue } from "../src/migration";
import { enableProject } from "../src/queue";
import { WB_ERROR_CODE } from "../src/types";

const allocatedRoots: string[] = [];
const openTransports: StdioClientTransport[] = [];

async function createProjectRoot(): Promise<string> {
	const raw = await mkdtemp(path.join(os.tmpdir(), "mcp-test-suite-"));
	const canonical = await realpath(raw);
	allocatedRoots.push(canonical);
	// The MCP server refuses mutating tools on a project that is not enabled, so
	// the fixture has to be in the same state a real /wb setup leaves behind.
	await migrateProjectToQueue(canonical).catch(() => undefined);
	await enableProject(canonical);
	return canonical;
}

async function startClient(projectRoot: string, agent: "omp" | "workbuddy"): Promise<{ client: Client; transport: StdioClientTransport }> {
	const mcpScript = path.resolve("./src/mcp.ts");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [mcpScript, "--project", projectRoot, "--agent", agent],
	});
	openTransports.push(transport);
	const client = new Client({ name: `test-client-${agent}`, version: "1.0.0" });
	await client.connect(transport);
	return { client, transport };
}

afterEach(async () => {
	while (openTransports.length > 0) {
		const t = openTransports.pop();
		if (t !== undefined) {
			await t.close().catch(() => undefined);
		}
	}
	while (allocatedRoots.length > 0) {
		const target = allocatedRoots.pop();
		if (target !== undefined) {
			await rm(target, { recursive: true, force: true }).catch(() => undefined);
		}
	}
});

describe("MCP server tool discovery and argument validation", () => {
	it("exposes the exact three tools with proper annotations", async () => {
		const root = await createProjectRoot();
		const { client } = await startClient(root, "omp");

		const toolsList = await client.listTools();
		const toolNames = toolsList.tools.map((t) => t.name);
		toolNames.sort();
		expect(toolNames).toEqual(["project_context", "work_claim", "work_publish"]);

		const contextTool = toolsList.tools.find((t) => t.name === "project_context");
		expect(contextTool?.annotations?.readOnlyHint).toBe(true);

		const claimTool = toolsList.tools.find((t) => t.name === "work_claim");
		expect(claimTool?.annotations?.readOnlyHint).toBeUndefined();
	});

	it("refuses calls with wrong projectRoot parameter", async () => {
		const root = await createProjectRoot();
		const otherRoot = await createProjectRoot();
		const { client } = await startClient(root, "omp");

		const result = await client.callTool({
			name: "project_context",
			arguments: { projectRoot: otherRoot },
		});

		expect(result.isError).toBe(true);
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type === "text") {
			const parsed = JSON.parse(content.text) as { error?: { code?: string } };
			expect(parsed.error?.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}
	});
});

describe("dual-client MCP interaction on shared project", () => {
	it("enables OMP and WorkBuddy to claim scopes, exchange deliverables, and review", async () => {
		const root = await createProjectRoot();
		const { client: ompClient } = await startClient(root, "omp");
		const { client: wbClient } = await startClient(root, "workbuddy");

		// 1. OMP claims business scope for code
		const ompClaimResult = await ompClient.callTool({
			name: "work_claim",
			arguments: {
				projectRoot: root,
				title: "Implement API router",
				scope: {
					readPaths: [],
					writePaths: ["src/routes"],
				},
			},
		});

		expect(ompClaimResult.isError).toBeFalsy();
		const ompClaimContent = ompClaimResult.content[0];
		expect(ompClaimContent?.type).toBe("text");
		const ompClaim = JSON.parse((ompClaimContent as { text: string }).text) as { record: { workId: string; revision: number; owner: string } };
		expect(ompClaim.record.owner).toBe("omp");
		const workIdOmp = ompClaim.record.workId;

		// 2. WorkBuddy queries project context and observes OMP's active work
		const contextResult = await wbClient.callTool({
			name: "project_context",
			arguments: { projectRoot: root },
		});
		const contextContent = contextResult.content[0];
		expect(contextContent?.type).toBe("text");
		const contextData = JSON.parse((contextContent as { text: string }).text) as { entries: Array<{ workId: string; owner: string; title: string }> };
		expect(contextData.entries.length).toBe(1);
		expect(contextData.entries[0]?.workId).toBe(workIdOmp);
		expect(contextData.entries[0]?.owner).toBe("omp");

		// 3. WorkBuddy attempts to claim write scope overlapping with OMP's scope -> rejected
		const conflictResult = await wbClient.callTool({
			name: "work_claim",
			arguments: {
				projectRoot: root,
				title: "Design overlapping documentation",
				scope: {
					readPaths: ["src/routes/api.ts"],
					writePaths: [],
				},
			},
		});
		// Since OMP declared writePaths: ["src/routes"], WorkBuddy trying to read a child path inside an active unreleased write scope conflicts!
		expect(conflictResult.isError).toBe(true);

		// 4. WorkBuddy claims independent native work
		const wbClaimResult = await wbClient.callTool({
			name: "work_claim",
			arguments: {
				projectRoot: root,
				title: "Create Presentation Deck",
				scope: {
					readPaths: [],
					writePaths: [],
				},
			},
		});
		expect(wbClaimResult.isError).toBeFalsy();
		const wbClaim = JSON.parse((wbClaimResult.content[0] as { text: string }).text) as { record: { workId: string; revision: number; owner: string }; outputsDir: string };
		expect(wbClaim.record.owner).toBe("workbuddy");
		const workIdWb = wbClaim.record.workId;

		// WorkBuddy writes a deliverable file to its outputsDir
		const deliverablePath = path.join(wbClaim.outputsDir, "presentation.pptx");
		await writeFile(deliverablePath, "real pptx binary simulation", "utf-8");
		const fileHash = await computeFileSha256(deliverablePath);

		// 5. WorkBuddy publishes the deliverable
		const publishResult = await wbClient.callTool({
			name: "work_publish",
			arguments: {
				projectRoot: root,
				workId: workIdWb,
				expectedRevision: 1,
				files: [
					{
						path: "presentation.pptx",
						role: "final",
					},
				],
				progress: {
					state: "active",
					phase: "completed_deck",
					milestone: "slide deck rendered",
					blocker: "",
				},
			},
		});
		expect(publishResult.isError).toBeFalsy();

		// 6. OMP inspects work details and publishes review
		const detailResult = await ompClient.callTool({
			name: "project_context",
			arguments: { projectRoot: root, workId: workIdWb },
		});
		expect(detailResult.isError).toBeFalsy();
		const detail = JSON.parse((detailResult.content[0] as { text: string }).text) as { detail?: { artifacts: Array<{ path: string; sha256: string }> } };
		expect(detail.detail?.artifacts.length).toBe(1);
		expect(detail.detail?.artifacts[0]?.sha256).toBe(fileHash);

		// OMP appends review
		const reviewResult = await ompClient.callTool({
			name: "work_publish",
			arguments: {
				projectRoot: root,
				workId: workIdWb,
				expectedRevision: 2,
				review: {
					round: null,
					artifacts: [{ path: path.resolve(deliverablePath), sha256: fileHash }],
					verdict: "accepted",
					note: "Deck totals verified successfully",
				},
				release: false,
			},
		});
		expect(reviewResult.isError).toBeFalsy();
		const reviewedData = JSON.parse((reviewResult.content[0] as { text: string }).text) as { reviews: Array<{ verdict: string; reviewer: string }> };
		expect(reviewedData.reviews.length).toBe(1);
		expect(reviewedData.reviews[0]?.verdict).toBe("accepted");
		expect(reviewedData.reviews[0]?.reviewer).toBe("omp");
	});
});
