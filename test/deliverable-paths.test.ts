/**
 * Deliverable path consistency (N01): the same task must name one directory.
 *
 * The original defect was a detail view that reported
 * `.wb-bridge/workbuddy/<taskId>/outputs` for a delegated task whose files were
 * really in `.wb-bridge/tasks/<taskId>/rounds/<n>/outputs`. Everything downstream
 * — the list, the detail, the receipt, the file a reviewer opens — inherited that
 * disagreement. These tests assert the agreement instead, against the historical
 * record shape the reader still serves.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { getProjectContext } from "../src/collaboration";
import { resolveRoundPaths, writeRoundReceipt } from "../src/tasks";
import type { WorkRecord } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await removeFixtureRoot(root);
		}
	}
});

const TASK = "11111111-1111-4111-8111-111111111111";
const WORK = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

async function project(): Promise<string> {
	const root = await createFixtureRoot("wb-n01-");
	roots.push(root);
	return root;
}

/** Writes one historical record, which is what the reader projects. */
async function record(root: string, overrides: Partial<WorkRecord> = {}): Promise<void> {
	const body: WorkRecord = {
		version: 1,
		workId: WORK,
		projectRoot: root,
		owner: "omp",
		source: "delegated",
		taskId: TASK,
		round: 1,
		nativeRef: null,
		title: "write the report",
		scope: { readPaths: [], writePaths: [] },
		state: "released",
		phase: "delivered",
		milestone: "",
		blocker: "",
		updatedAt: new Date().toISOString(),
		revision: 1,
		artifacts: [],
		remoteResults: [],
		reviews: [],
		...overrides,
	};
	const collabDir = path.join(root, ".wb-bridge", "collaboration");
	await mkdir(collabDir, { recursive: true });
	await writeFile(path.join(collabDir, `${body.workId}.json`), JSON.stringify(body, null, 2), "utf-8");
}

/** A v3 receipt body for one delegated round. */
function receiptBody(root: string, round: number, taskId = TASK, layout: "round" | "legacy" = "round"): Record<string, unknown> {
	return {
		version: 3,
		taskId,
		sessionId: "omp-session-1",
		projectRoot: root,
		rounds: [
			{
				number: round,
				layout,
				goal: { objective: "write the report", context: "", constraints: [], acceptance: ["READY"], externalActions: [] },
				inputFiles: [],
				expectedOutputs: ["report.md"],
				status: "completed",
				summary: "",
				error: null,
				artifacts: [],
				recordKind: "approved",
				requestId: "44444444-4444-4444-8444-444444444444",
				targetPolicy: { kind: "session", sessionId: SESSION },
				snapshotRoot: resolveRoundPaths(root, taskId, round, layout).roundDir,
				owner: null,
				manifestSha256: null,
				commitToken: null,
				turns: [],
				consent: null,
			},
		],
	};
}

describe("delegated deliverables resolve to one directory", () => {
	it("reports the round outputs directory for a delegated work record", async () => {
		const root = await project();
		const canonical = await realpath(root);
		const paths = resolveRoundPaths(canonical, TASK, 1, "round");
		await mkdir(paths.outputsDir, { recursive: true });
		await writeFile(path.join(paths.outputsDir, "report.md"), "READY", "utf-8");
		await writeRoundReceipt(canonical, TASK, 1, "round", receiptBody(canonical, 1));
		await record(canonical);

		const detail = await getProjectContext(canonical, { workId: WORK });
		expect(detail.detail).not.toBeNull();
		// The reported directory is where the receipt says the file is, and it is there.
		expect(detail.detail?.outputsDir).toBe(paths.outputsDir);
		expect(await Bun.file(path.join(detail.detail!.outputsDir!, "report.md")).text()).toBe("READY");
	});

	it("uses the round layout for a record whose receipt does not exist yet", async () => {
		const root = await project();
		const canonical = await realpath(root);

		// A record is created at enqueue, before any receipt is written. The path is
		// still derivable, and it is the round layout the task will be written with.
		await record(canonical, { round: 3, state: "waiting" });
		const detail = await getProjectContext(canonical, { workId: WORK });
		expect(detail.detail?.outputsDir).toBe(resolveRoundPaths(canonical, TASK, 3, "round").outputsDir);
	});

	it("uses the legacy layout for a migrated task whose receipt says so", async () => {
		const root = await project();
		const canonical = await realpath(root);
		const taskId = "99999999-9999-4999-8999-999999999999";
		const legacyPaths = resolveRoundPaths(canonical, taskId, 1, "legacy");
		await mkdir(legacyPaths.outputsDir, { recursive: true });
		await writeFile(path.join(legacyPaths.outputsDir, "legacy.txt"), "OLD", "utf-8");
		await writeRoundReceipt(canonical, taskId, 1, "legacy", {
			...receiptBody(canonical, 1, taskId, "legacy"),
			rounds: [
				{
					...(receiptBody(canonical, 1, taskId, "legacy").rounds as Array<Record<string, unknown>>)[0]!,
					recordKind: "legacy",
				},
			],
		});
		await record(canonical, { taskId, round: 1 });

		const detail = await getProjectContext(canonical, { workId: WORK });
		// The migrated task's outputs live beside the receipt, not under rounds/1.
		expect(detail.detail?.outputsDir).toBe(legacyPaths.outputsDir);
		expect(await Bun.file(path.join(detail.detail!.outputsDir!, "legacy.txt")).text()).toBe("OLD");
	});

	it("does not claim the project root is a delegated task's outputs", async () => {
		const root = await project();
		const canonical = await realpath(root);
		await record(canonical, { round: 2 });

		const detail = await getProjectContext(canonical, { workId: WORK });
		// `canonicalRoot` used to be reported here; it looks authoritative and is not
		// an outputs directory at all.
		expect(detail.detail?.outputsDir).not.toBe(canonical);
		expect(detail.detail?.outputsDir).toBe(resolveRoundPaths(canonical, TASK, 2, "round").outputsDir);
	});

	it("reports no outputs directory for a record whose parent is unknown", async () => {
		const root = await project();
		const canonical = await realpath(root);

		// A record with neither a delegated parent nor native ownership: there is no
		// directory to name, and inventing one is how the original defect started.
		await record(canonical, { taskId: null, round: null, source: "native" });

		const detail = await getProjectContext(canonical, { workId: WORK });
		expect(detail.detail?.outputsDir).toBeNull();
	});

	it("keeps native work in its own outputs root, not a delegated round", async () => {
		const root = await project();
		const canonical = await realpath(root);

		// Native WorkBuddy work has no task and no round.
		await record(canonical, { owner: "workbuddy", source: "native", taskId: null, round: null });

		const detail = await getProjectContext(canonical, { workId: WORK });
		expect(detail.detail?.outputsDir).toBe(
			path.join(canonical, ".wb-bridge", "workbuddy", WORK, "outputs"),
		);
	});
});
