/**
 * Read-only collaboration history and the scope algebra.
 *
 * The live file-store writer (`claimWork`/`publishWork`/`releaseWork` and its
 * metadata lock) is gone: a second writer beside the queue is what let two
 * authorities disagree about who holds a path. What remains here is what the
 * queue itself still needs — the published record shape, the reader the workbench
 * projects, and the scope rules both sides share.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { pathsOverlap, readAllWorkRecords, readWorkRecord } from "../src/collaboration";
import { delegatedWorkId } from "../src/tasks";
import { scopesConflict } from "../src/scope";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

const allocatedRoots: string[] = [];

async function createProjectRoot(): Promise<string> {
	const canonical = await createFixtureRoot("wb-collab-test-");
	allocatedRoots.push(canonical);
	return canonical;
}

afterEach(async () => {
	while (allocatedRoots.length > 0) {
		const target = allocatedRoots.pop();
		if (target !== undefined) {
			await removeFixtureRoot(target);
		}
	}
});

describe("pathsOverlap utility", () => {
	it("detects exact matches, parent-child, and child-parent relationships", () => {
		expect(pathsOverlap("src/app.ts", "src/app.ts")).toBe(true);
		expect(pathsOverlap("src", "src/components/Button.tsx")).toBe(true);
		expect(pathsOverlap("src/components/Button.tsx", "src")).toBe(true);
		expect(pathsOverlap("src/app.ts", "src/auth.ts")).toBe(false);
		expect(pathsOverlap("docs", "src")).toBe(false);
	});
});

describe("historical work records", () => {
	it("reads a published waiting record without rejecting it", async () => {
		const root = await createProjectRoot();
		// The queue publishes a waiting record for every enqueued round; reading it
		// back through the same validator must not fail, or migration and the
		// workbench would silently drop those rows.
		const record = {
			version: 1 as const,
			workId: delegatedWorkId("11111111-1111-4111-8111-111111111111", 1),
			projectRoot: root,
			owner: "omp" as const,
			source: "delegated" as const,
			taskId: "11111111-1111-4111-8111-111111111111",
			round: 1,
			nativeRef: null,
			title: "Queued round",
			scope: { readPaths: ["input.txt"], writePaths: [".wb-bridge/tasks/x/rounds/1/outputs"] },
			state: "waiting" as const,
			phase: "queued",
			milestone: "",
			blocker: "",
			updatedAt: new Date().toISOString(),
			revision: 1,
			artifacts: [],
			remoteResults: [],
			reviews: [],
		};
		const collabDir = path.join(root, ".wb-bridge", "collaboration");
		await mkdir(collabDir, { recursive: true });
		await writeFile(path.join(collabDir, `${record.workId}.json`), JSON.stringify(record, null, 2), "utf-8");

		const read = await readWorkRecord(root, record.workId);
		expect(read?.state).toBe("waiting");
		expect((await readAllWorkRecords(root)).some((candidate) => candidate.workId === record.workId)).toBe(true);
	});

	it("reports nothing for a project with no historical records", async () => {
		const root = await createProjectRoot();
		expect(await readAllWorkRecords(root)).toEqual([]);
		expect(await readWorkRecord(root, delegatedWorkId("22222222-2222-4222-8222-222222222222", 1))).toBeNull();
	});
});

describe("scopesConflict domain rules", () => {
	const empty = { readPaths: [], writePaths: [] };

	it("treats write/write and write/read overlap as conflicting", () => {
		expect(scopesConflict({ readPaths: [], writePaths: ["src/a.ts"] }, { readPaths: [], writePaths: ["src/a.ts"] })).toBeTrue();
		expect(scopesConflict({ readPaths: [], writePaths: ["src/a.ts"] }, { readPaths: ["src"], writePaths: [] })).toBeTrue();
	});

	it("treats read/write overlap as conflicting but read/read as free", () => {
		expect(scopesConflict({ readPaths: ["src/a.ts"], writePaths: [] }, { readPaths: [], writePaths: ["src"] })).toBeTrue();
		expect(scopesConflict({ readPaths: ["src/a.ts"], writePaths: [] }, { readPaths: ["src/a.ts"], writePaths: [] })).toBeFalse();
	});

	it("treats disjoint scopes as free", () => {
		expect(scopesConflict({ readPaths: [], writePaths: ["out/a"] }, { readPaths: [], writePaths: ["out/b"] })).toBeFalse();
		expect(scopesConflict({ readPaths: [], writePaths: ["out/a"] }, empty)).toBeFalse();
	});

	it("fails closed when a stored path cannot be normalized", () => {
		// A poisoned row (absolute, or traversal) must block rather than license
		// concurrent writers: it is data written by an earlier version, so silence
		// here would turn a corrupt record into an authorization bypass.
		expect(scopesConflict({ readPaths: [], writePaths: ["out/a"] }, { readPaths: [], writePaths: ["C:/abs"] })).toBeTrue();
		expect(scopesConflict({ readPaths: [], writePaths: ["out/a"] }, { readPaths: ["../escape"], writePaths: [] })).toBeTrue();
	});

	it("fails closed when a proposed path cannot be normalized", () => {
		expect(scopesConflict({ readPaths: [], writePaths: ["../escape"] }, { readPaths: [], writePaths: ["out/a"] })).toBeTrue();
	});

	it("normalizes separators before comparing", () => {
		// Same logical path written two ways must conflict, not slip through.
		expect(scopesConflict({ readPaths: [], writePaths: ["out/a.ts"] }, { readPaths: [], writePaths: ["out\\a.ts"] })).toBeTrue();
	});

	it("treats case-differing paths as the same file on win32", () => {
		// Windows resolves Out/A.ts and out/a.ts to one file, so two scopes that
		// differ only in case must conflict. On POSIX the same pair is genuinely
		// two distinct files and must not conflict.
		if (process.platform === "win32") {
			expect(pathsOverlap("Out/A.ts", "out/a.ts")).toBeTrue();
			expect(pathsOverlap("Out", "out/a.ts")).toBeTrue();
			expect(
				scopesConflict({ readPaths: [], writePaths: ["Out/A.ts"] }, { readPaths: [], writePaths: ["out/a.ts"] }),
			).toBeTrue();
		} else {
			expect(pathsOverlap("Out/A.ts", "out/a.ts")).toBeFalse();
		}
	});
});
