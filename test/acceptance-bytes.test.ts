/**
 * Acceptance follows the bytes (N02).
 *
 * The observed defect was that a review kept being treated as accepted after the
 * file was rewritten, so a consumer could report "approved" for content nobody
 * had ever seen. History is immutable; effectiveness is computed against the
 * current file. These tests build the historical record directly, because that is
 * what the reader consumes: the live writer is the queue, and the file store is
 * read-only history.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { effectiveAcceptance, readWorkRecord } from "../src/collaboration";
import { computeFileSha256, delegatedWorkId } from "../src/tasks";
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

const TASK = "22222222-2222-4222-8222-222222222222";
const WORK = delegatedWorkId(TASK, 1);
const RELATIVE = `.wb-bridge/tasks/${TASK}/rounds/1/outputs/report.md`;

async function project(): Promise<string> {
	const root = await createFixtureRoot("wb-n02-");
	roots.push(root);
	return root;
}

/** One historical opinion, exactly as a reader must interpret it later. */
interface HistoricalReview {
	path: string;
	sha256: string;
	at: string;
}

/** Writes the deliverable and the stored record that quotes the reviewed bytes. */
async function writeHistory(root: string, content: string, reviews: HistoricalReview[]): Promise<void> {
	const absolute = path.join(root, ...RELATIVE.split("/"));
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf-8");
	const digest = await computeFileSha256(absolute);

	const record: WorkRecord = {
		version: 1,
		workId: WORK,
		projectRoot: root,
		owner: "omp",
		source: "delegated",
		taskId: TASK,
		round: 1,
		nativeRef: null,
		title: "write the report",
		scope: { readPaths: [], writePaths: [`.wb-bridge/tasks/${TASK}/rounds/1/outputs`] },
		state: "released",
		phase: "delivered",
		milestone: "",
		blocker: "",
		updatedAt: new Date().toISOString(),
		revision: 2,
		artifacts: [
			{
				kind: "file",
				path: RELATIVE,
				sha256: digest,
				bytes: Buffer.byteLength(content, "utf-8"),
				role: "final",
				provenance: "native",
				importedFrom: null,
			},
		],
		remoteResults: [],
		reviews: reviews.map((review, index) => ({
			reviewer: "omp" as const,
			round: 1,
			artifacts: [{ path: review.path, sha256: review.sha256 }],
			verdict: "accepted" as const,
			note: `review ${index + 1}`,
			at: review.at,
		})),
	};
	const collabDir = path.join(root, ".wb-bridge", "collaboration");
	await mkdir(collabDir, { recursive: true });
	await writeFile(path.join(collabDir, `${WORK}.json`), JSON.stringify(record, null, 2), "utf-8");
}

/** Appends an acceptance of exactly the bytes that are on disk right now. */
async function accept(root: string, reviewPath = RELATIVE): Promise<void> {
	const current = await Bun.file(path.join(root, ...RELATIVE.split("/"))).text();
	const record = (await readWorkRecord(root, WORK))!;
	await writeHistory(root, current, [
		...record.reviews.map((review) => ({
			path: review.artifacts[0]!.path,
			sha256: review.artifacts[0]!.sha256,
			at: review.at,
		})),
		{
			path: reviewPath,
			sha256: await computeFileSha256(path.join(root, ...RELATIVE.split("/"))),
			at: new Date(Date.now() + record.reviews.length + 1).toISOString(),
		},
	]);
}

describe("accepted bytes versus current bytes", () => {
	it("treats an acceptance as effective while the file is unchanged", async () => {
		const root = await project();
		await writeHistory(root, "READY", []);
		await accept(root);

		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeTrue();
		expect(acceptance.reason).toBeNull();
	});

	it("stops applying an acceptance once the file is rewritten, keeping the history", async () => {
		const root = await project();
		await writeHistory(root, "READY", []);
		await accept(root);

		// The deliverable is edited after it was approved.
		await writeFile(path.join(root, ...RELATIVE.split("/")), "READY but different", "utf-8");

		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeFalse();
		expect(acceptance.reason).toBe("artifact_changed");
		// The historical opinion is still on the record: nothing was rewritten.
		expect(record.reviews.filter((review) => review.verdict === "accepted")).toHaveLength(1);
	});

	it("reports a deleted deliverable as missing rather than as accepted", async () => {
		const root = await project();
		await writeHistory(root, "READY", []);
		await accept(root);
		await rm(path.join(root, ...RELATIVE.split("/")));

		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeFalse();
		expect(acceptance.reason).toBe("artifact_missing");
	});

	it("accepts the new bytes once they are reviewed again", async () => {
		const root = await project();
		await writeHistory(root, "DRAFT", []);
		await accept(root);
		await writeFile(path.join(root, ...RELATIVE.split("/")), "READY", "utf-8");

		// The rewritten file invalidated the first opinion.
		const stale = await effectiveAcceptance(root, (await readWorkRecord(root, WORK))!, RELATIVE);
		expect(stale.reason).toBe("artifact_changed");

		// Re-review the new bytes: the earlier opinion is kept, and the newest
		// acceptance describes the file that is actually there.
		await accept(root);
		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeTrue();
		expect(record.reviews.filter((review) => review.verdict === "accepted")).toHaveLength(2);
	});

	it("reports no acceptance for a file that was never reviewed", async () => {
		const root = await project();
		await writeHistory(root, "READY", []);

		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeFalse();
		// No acceptance existed, so nothing was invalidated.
		expect(acceptance.reason).toBeNull();
	});
});

describe("reviewer verification uses real paths", () => {
	it("resolves an absolute artifact path inside the project", async () => {
		const root = await project();
		await writeHistory(root, "READY", []);
		// A consumer that opened the file by absolute path may review it that way.
		await accept(root, path.join(root, ...RELATIVE.split("/")));

		const record = (await readWorkRecord(root, WORK))!;
		const acceptance = await effectiveAcceptance(root, record, RELATIVE);
		expect(acceptance.accepted).toBeTrue();
	});
});
