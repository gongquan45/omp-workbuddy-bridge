/**
 * Receipt location and durability.
 *
 * Two failures matter more than any other here: a reader and a writer disagreeing
 * about where a receipt lives (so a committed task looks missing), and a receipt
 * that appears written but has no bytes on disk (so a commit is confirmed without
 * evidence). Both are asserted against real files.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	readCurrentRoundReceipt,
	readTask,
	readTaskIndex,
	resolveRoundPaths,
	statusIsInFlight,
	writeRoundReceipt,
} from "../src/tasks";
import { WB_ERROR_CODE } from "../src/types";
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

async function project(): Promise<string> {
	const root = await createFixtureRoot("wb-receipt-");
	roots.push(root);
	return root;
}

/** A minimal receipt body with the given round count and status. */
function receiptBody(root: string, options: { rounds: number; status: string; version?: 2 | 3 }): Record<string, unknown> {
	const rounds = Array.from({ length: options.rounds }, (_, index) => ({
		number: index + 1,
		layout: "round",
		goal: { objective: "work", context: "", constraints: [], acceptance: ["ok"], externalActions: [] },
		inputFiles: [],
		expectedOutputs: [],
		status: options.status,
		summary: "",
		error: null,
		artifacts: [],
		recordKind: "approved",
		requestId: `22222222-2222-4222-8222-22222222222${index}`,
		targetPolicy: { kind: "session", sessionId: "33333333-3333-4333-8333-333333333333" },
		// A v3 round must declare its snapshot root: an empty one would make later
		// path joins resolve against the process cwd.
		snapshotRoot: path.join(root, ".wb-bridge", "tasks", TASK, "rounds", String(index + 1)),
		owner: null,
		manifestSha256: null,
		commitToken: null,
		turns: [],
		consent: null,
	}));
	return {
		version: options.version ?? 3,
		taskId: TASK,
		sessionId: "omp-session-1",
		projectRoot: root,
		rounds,
	};
}

describe("durable round receipts", () => {
	it("writes the receipt where the resolver says, with a digest that matches the bytes", async () => {
		const root = await project();
		const body = receiptBody(root, { rounds: 1, status: "completed" });

		const written = await writeRoundReceipt(root, TASK, 1, "round", body);

		const expected = resolveRoundPaths(await realpath(root), TASK, 1, "round").receiptPath;
		expect(written.receiptPath).toBe(expected);

		const onDisk = await readFile(expected, "utf-8");
		expect(written.sha256).toBe(createHash("sha256").update(onDisk, "utf-8").digest("hex"));
		expect(written.bytes).toBe(Buffer.byteLength(onDisk, "utf-8"));
		// No temporary files are left behind by the atomic write.
		const files = await readdir(path.dirname(expected));
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("keeps a v3 round receipt readable through the single-task and index readers", async () => {
		const root = await project();
		await writeRoundReceipt(root, TASK, 1, "round", receiptBody(root, { rounds: 1, status: "completed" }));

		// Both surfaces must find the same file a writer just committed.
		const receipt = await readCurrentRoundReceipt(root, TASK);
		expect(receipt.taskId).toBe(TASK);
		const index = await readTaskIndex(root);
		expect(index.entries.map((entry) => entry.taskId)).toEqual([TASK]);
		expect(index.warnings).toEqual([]);
	});

	it("reports the newest round when a task has several round receipts", async () => {
		const root = await project();
		// Round 1 completed, round 2 in progress: the current round is the newer one.
		await writeRoundReceipt(root, TASK, 1, "round", receiptBody(root, { rounds: 1, status: "completed" }));
		await writeRoundReceipt(root, TASK, 2, "round", receiptBody(root, { rounds: 2, status: "running" }));

		const current = await readCurrentRoundReceipt(root, TASK);
		expect(current.rounds).toHaveLength(2);
		expect(current.rounds.at(-1)?.status).toBe("running");

		const index = await readTaskIndex(root);
		expect(index.entries).toHaveLength(1);
		expect(index.entries[0]?.round).toBe(2);
		expect(index.entries[0]?.status).toBe("running");
	});

	it("does not report a round-2 task as missing when only the round receipt exists", async () => {
		const root = await project();
		// The v2 layout has no rounds/ directory at all; a task whose receipt lives
		// under rounds/ must not be mistaken for a corrupt v2 task.
		await writeRoundReceipt(root, TASK, 1, "round", receiptBody(root, { rounds: 1, status: "completed" }));
		const rootReceipt = path.join(root, ".wb-bridge", "tasks", TASK, "receipt.json");
		await expect(readFile(rootReceipt, "utf-8")).rejects.toThrow();

		const index = await readTaskIndex(root);
		expect(index.warnings).toEqual([]);
		expect(index.entries.map((entry) => entry.taskId)).toEqual([TASK]);
	});

	it("reports a queued v3 round as queued, not as completed", async () => {
		const root = await project();
		// The state a task is in immediately after submission and before any session
		// claims it: it must be visible, and it must not look delivered.
		await writeRoundReceipt(root, TASK, 1, "round", receiptBody(root, { rounds: 1, status: "queued" }));

		const detail = await readCurrentRoundReceipt(root, TASK);
		expect(detail.rounds[0]?.status).toBe("queued");

		const index = await readTaskIndex(root);
		expect(index.warnings).toEqual([]);
		expect(index.entries[0]?.status).toBe("queued");
		// Not terminal: a queued task still occupies its slot and cannot be
		// supplemented or reported as a finished delivery.
		expect(statusIsInFlight("queued")).toBeTrue();
		expect(statusIsInFlight("awaiting_help")).toBeTrue();
		expect(statusIsInFlight("completed")).toBeFalse();
	});

	it("refuses a v3 round that omits its snapshot root", async () => {
		const root = await project();
		const body = receiptBody(root, { rounds: 1, status: "completed" });
		const round = (body.rounds as Array<Record<string, unknown>>)[0]!;
		delete round.snapshotRoot;
		await writeRoundReceipt(root, TASK, 1, "round", body);

		// An empty snapshot root would resolve against the process cwd later, so the
		// record is rejected as malformed instead of being accepted with a default.
		await expect(readCurrentRoundReceipt(root, TASK)).rejects.toMatchObject({
			code: WB_ERROR_CODE.taskStateInvalid,
		});
		const index = await readTaskIndex(root);
		expect(index.entries).toEqual([]);
		expect(index.warnings.length).toBe(1);
	});

	it("still reads a v2 task-root receipt", async () => {
		const root = await project();
		const taskDir = path.join(root, ".wb-bridge", "tasks", TASK);
		await mkdir(taskDir, { recursive: true });
		// A v2 receipt: version 2, one legacy round, stored at the task root.
		const legacyBody = receiptBody(root, { rounds: 1, status: "completed", version: 2 });
		const legacyRound = (legacyBody.rounds as Array<Record<string, unknown>>)[0]!;
		legacyRound.layout = "legacy";
		await writeFile(
			path.join(taskDir, "receipt.json"),
			JSON.stringify({ ...legacyBody, version: 2, rounds: [{ ...legacyRound }] }, null, 2),
			"utf-8",
		);

		const receipt = await readCurrentRoundReceipt(root, TASK);
		expect(receipt.version).toBe(2);
		expect((await readTask(root, TASK)).taskId).toBe(TASK);
		const index = await readTaskIndex(root);
		expect(index.entries.map((entry) => entry.taskId)).toEqual([TASK]);
	});

	it("refuses a receipt whose round directory escapes the task through a link", async () => {
		const root = await project();
		const outside = await createFixtureRoot("wb-receipt-outside-");
		roots.push(outside);
		const taskDir = path.join(root, ".wb-bridge", "tasks", TASK);
		await mkdir(path.join(taskDir, "rounds", "1"), { recursive: true });
		await writeFile(path.join(outside, "receipt.json"), JSON.stringify(receiptBody(root, { rounds: 1, status: "completed" })), "utf-8");

		// Point round 1's receipt at a file outside the project.
		const { symlink } = await import("node:fs/promises");
		let linked = false;
		try {
			await symlink(path.join(outside, "receipt.json"), path.join(taskDir, "rounds", "1", "receipt.json"));
			linked = true;
		} catch {
			linked = false;
		}
		if (!linked) {
			return;
		}

		// The index refuses a receipt that resolves outside the project root, rather
		// than listing another location's file as this task's result.
		const index = await readTaskIndex(root);
		expect(index.entries).toEqual([]);
		expect(index.warnings.length).toBe(1);
		expect(JSON.stringify(index.warnings[0])).toContain("outside the project root");
	});

	it("raises a storage error rather than a state error when the target is unwritable", async () => {
		const root = await project();
		await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
		// A file where the tasks directory should be: mkdir must fail, and that is a
		// filesystem failure, not a corrupt receipt.
		await writeFile(path.join(root, ".wb-bridge", "tasks"), "not a directory", "utf-8");

		await expect(
			writeRoundReceipt(root, TASK, 1, "round", receiptBody(root, { rounds: 1, status: "completed" })),
		).rejects.toMatchObject({ code: WB_ERROR_CODE.storageError });
	});
});
