import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
	claimWork,
	getProjectContext,
	pathsOverlap,
	publishWork,
	readAllWorkRecords,
	readWorkRecord,
	releaseWork,
	withCollaborationLock,
} from "../src/collaboration";
import { computeFileSha256, WbTaskError } from "../src/tasks";
import { WB_ERROR_CODE } from "../src/types";

const allocatedRoots: string[] = [];

async function createProjectRoot(): Promise<string> {
	const raw = await mkdtemp(path.join(os.tmpdir(), "wb-collab-test-"));
	const canonical = await realpath(raw);
	allocatedRoots.push(canonical);
	return canonical;
}

afterEach(async () => {
	while (allocatedRoots.length > 0) {
		const target = allocatedRoots.pop();
		if (target !== undefined) {
			await rm(target, { recursive: true, force: true }).catch(() => undefined);
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

describe("short metadata lock and dead-owner recovery", () => {
	it("reaps a dead-owner lock file and completes action", async () => {
		const root = await createProjectRoot();
		const bridgeDir = path.join(root, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		const lockPath = path.join(bridgeDir, "collaboration.lock");

		// Spawn a process that exits immediately to obtain a provably dead PID
		const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		const deadPid = proc.pid;
		await proc.exited;

		await writeFile(
			lockPath,
			JSON.stringify({ ownerPid: deadPid, lockId: "dead-uuid" }),
			"utf-8"
		);

		const result = await withCollaborationLock(root, async () => {
			return "lock-acquired-after-reap";
		});

		expect(result).toBe("lock-acquired-after-reap");
		// Lock is unlinked on release
		let exists = false;
		try {
			await readFile(lockPath, "utf-8");
			exists = true;
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);
	});

	it("fails closed when held by an alive process", async () => {
		const root = await createProjectRoot();
		const bridgeDir = path.join(root, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		const lockPath = path.join(bridgeDir, "collaboration.lock");

		await writeFile(
			lockPath,
			JSON.stringify({ ownerPid: process.pid, lockId: "live-uuid" }),
			"utf-8"
		);

		let caught: unknown = null;
		try {
			await withCollaborationLock(root, async () => "should-fail");
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.busy);
		}
	});
});

describe("claimWork and scope conflict validation", () => {
	it("allows disjoint write scopes across two different work items", async () => {
		const root = await createProjectRoot();

		const work1 = await claimWork(root, "omp", {
			title: "Feature A",
			scope: { readPaths: [], writePaths: ["src/featureA"] },
		});
		expect(work1.record.state).toBe("active");

		const work2 = await claimWork(root, "omp", {
			title: "Feature B",
			scope: { readPaths: [], writePaths: ["src/featureB"] },
		});
		expect(work2.record.state).toBe("active");
	});

	it("rejects overlapping write scopes with WB_SCOPE_CONFLICT", async () => {
		const root = await createProjectRoot();

		await claimWork(root, "omp", {
			title: "Core Service",
			scope: { readPaths: [], writePaths: ["src/services"] },
		});

		let caught: unknown = null;
		try {
			await claimWork(root, "omp", {
				title: "Nested Service Modification",
				scope: { readPaths: [], writePaths: ["src/services/auth.ts"] },
			});
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.scopeConflict);
			expect(caught.message).toContain("conflicts with write path");
		}
	});

	it("allows concurrent read/read on the same path", async () => {
		const root = await createProjectRoot();

		const work1 = await claimWork(root, "omp", {
			title: "Reader 1",
			scope: { readPaths: ["data/input.json"], writePaths: [] },
		});
		const work2 = await claimWork(root, "omp", {
			title: "Reader 2",
			scope: { readPaths: ["data/input.json"], writePaths: [] },
		});

		expect(work1.record.state).toBe("active");
		expect(work2.record.state).toBe("active");
	});

	it("rejects write over existing active read scope", async () => {
		const root = await createProjectRoot();

		await claimWork(root, "omp", {
			title: "Reader",
			scope: { readPaths: ["data/input.json"], writePaths: [] },
		});

		let caught: unknown = null;
		try {
			await claimWork(root, "omp", {
				title: "Writer attempting to modify read file",
				scope: { readPaths: [], writePaths: ["data/input.json"] },
			});
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.scopeConflict);
		}
	});

	it("allocates outputsDir automatically for native WorkBuddy work", async () => {
		const root = await createProjectRoot();

		const claimed = await claimWork(root, "workbuddy", {
			title: "Native document generation",
			scope: { readPaths: ["input.csv"], writePaths: [] },
		});

		expect(claimed.outputsDir).toContain(claimed.record.workId);
		expect(claimed.record.scope?.writePaths).toEqual([
			`.wb-bridge/workbuddy/${claimed.record.workId}/outputs`,
		]);
	});
});

describe("work_publish progress, revision control, and artifact review", () => {
	it("enforces CAS expectedRevision checks and increments revision", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "omp", {
			title: "Working on task",
			scope: { readPaths: [], writePaths: ["src"] },
		});

		expect(claim.record.revision).toBe(1);

		// Concurrency mismatch
		let caught: unknown = null;
		try {
			await publishWork(root, "omp", {
				workId: claim.record.workId,
				expectedRevision: 99,
				progress: {
					state: "active",
					phase: "implementation",
					milestone: "step 1",
					blocker: "",
				},
			});
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.revisionConflict);
		}

		// Valid revision update
		const updated = await publishWork(root, "omp", {
			workId: claim.record.workId,
			expectedRevision: 1,
			progress: {
				state: "active",
				phase: "implementation",
				milestone: "step 1",
				blocker: "",
			},
		});

		expect(updated.revision).toBe(2);
		expect(updated.milestone).toBe("step 1");
	});

	it("refuses to let non-owner modify progress, files, or state", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "workbuddy", {
			title: "WB Task",
			scope: { readPaths: [], writePaths: [] },
		});

		let caught: unknown = null;
		try {
			await publishWork(root, "omp", {
				workId: claim.record.workId,
				expectedRevision: 1,
				progress: {
					state: "blocked",
					phase: "interrupted",
					milestone: "",
					blocker: "OMP tried to block WB",
				},
			});
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});

	it("allows non-owner to append a review and verifies artifact hashes", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "omp", {
			title: "Implementation",
			scope: { readPaths: [], writePaths: ["src"] },
		});

		// Create a real file for artifact publication
		const srcFile = path.join(root, "src", "code.ts");
		await mkdir(path.dirname(srcFile), { recursive: true });
		await writeFile(srcFile, "export const x = 42;", "utf-8");
		const correctHash = await computeFileSha256(srcFile);

		const published = await publishWork(root, "omp", {
			workId: claim.record.workId,
			expectedRevision: 1,
			files: [
				{
					path: "src/code.ts",
					role: "final",
				},
			],
		});

		expect(published.artifacts.length).toBe(1);
		expect(published.artifacts[0]?.sha256).toBe(correctHash);

		// Review with modified hash must throw WB_ARTIFACT_CHANGED
		let hashMismatchCaught: unknown = null;
		try {
			await publishWork(root, "workbuddy", {
				workId: claim.record.workId,
				expectedRevision: 2,
				review: {
					round: null,
					artifacts: [{ path: path.resolve(srcFile), sha256: "tampered-hash" }],
					verdict: "accepted",
					note: "Tampered check",
				},
			});
		} catch (err) {
			hashMismatchCaught = err;
		}

		expect(hashMismatchCaught instanceof WbTaskError).toBe(true);
		if (hashMismatchCaught instanceof WbTaskError) {
			expect(hashMismatchCaught.code).toBe(WB_ERROR_CODE.artifactChanged);
		}

		// Review with matching hash succeeds
		const reviewed = await publishWork(root, "workbuddy", {
			workId: claim.record.workId,
			expectedRevision: 2,
			review: {
				round: null,
				artifacts: [{ path: path.resolve(srcFile), sha256: correctHash }],
				verdict: "accepted",
				note: "Code looks good",
			},
		});

		expect(reviewed.reviews.length).toBe(1);
		expect(reviewed.reviews[0]?.verdict).toBe("accepted");
		expect(reviewed.reviews[0]?.reviewer).toBe("workbuddy");
	});

	it("releases scope and prevents resurrection by late progress update", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "omp", {
			title: "Releasable work",
			scope: { readPaths: [], writePaths: ["src"] },
		});

		const released = await releaseWork(root, claim.record.workId);
		expect(released.state).toBe("released");
		expect(released.scope).toBeNull();

		// Late progress update must be rejected
		let lateCaught: unknown = null;
		try {
			await publishWork(root, "omp", {
				workId: claim.record.workId,
				expectedRevision: released.revision,
				progress: {
					state: "active",
					phase: "resurrect",
					milestone: "late",
					blocker: "",
				},
			});
		} catch (err) {
			lateCaught = err;
		}

		expect(lateCaught instanceof WbTaskError).toBe(true);
		if (lateCaught instanceof WbTaskError) {
			expect(lateCaught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});

	it("allows importFrom for WorkBuddy native deliverables and copies into outputs", async () => {
		const root = await createProjectRoot();

		// Create source file in project
		const sourceFilePath = path.join(root, "source.csv");
		await writeFile(sourceFilePath, "a,b,c", "utf-8");
		const expectedHash = await computeFileSha256(sourceFilePath);

		const claim = await claimWork(root, "workbuddy", {
			title: "Importing task",
			scope: { readPaths: [], writePaths: [] },
		});

		const published = await publishWork(root, "workbuddy", {
			workId: claim.record.workId,
			expectedRevision: 1,
			files: [
				{
					path: "imported-data.csv",
					role: "supporting",
					importFrom: "source.csv",
				},
			],
		});

		expect(published.artifacts.length).toBe(1);
		const art = published.artifacts[0]!;
		expect(art.provenance).toBe("imported");
		expect(art.importedFrom).toBe("source.csv");
		expect(art.sha256).toBe(expectedHash);

		// Target file exists in outputs
		const outputsFile = path.join(claim.outputsDir, "imported-data.csv");
		expect(await readFile(outputsFile, "utf-8")).toBe("a,b,c");
	});

	it("rejects importFrom that escapes project root", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "workbuddy", {
			title: "Escape attempt",
			scope: { readPaths: [], writePaths: [] },
		});

		let caught: unknown = null;
		try {
			await publishWork(root, "workbuddy", {
				workId: claim.record.workId,
				expectedRevision: 1,
				files: [
					{
						path: "escape.csv",
						role: "final",
						importFrom: "../outside.txt",
					},
				],
			});
		} catch (err) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});
});

describe("getProjectContext query and filtering", () => {
	it("filters active scopes and sorts blocked items first", async () => {
		const root = await createProjectRoot();

		const w1 = await claimWork(root, "omp", {
			title: "Active task 1",
			scope: { readPaths: [], writePaths: ["src/a"] },
		});

		const w2 = await claimWork(root, "omp", {
			title: "Active task 2",
			scope: { readPaths: [], writePaths: ["src/b"] },
		});

		// Block task 2
		await publishWork(root, "omp", {
			workId: w2.record.workId,
			expectedRevision: 1,
			progress: {
				state: "blocked",
				phase: "stuck",
				milestone: "none",
				blocker: "Waiting on dependency",
			},
		});

		const context = await getProjectContext(root, { limit: 10 });
		expect(context.entries.length).toBe(2);
		// Blocked task 2 must be sorted first
		expect(context.entries[0]?.workId).toBe(w2.record.workId);
		expect(context.entries[0]?.state).toBe("blocked");
		expect(context.entries[1]?.workId).toBe(w1.record.workId);
		expect(context.entries[1]?.state).toBe("active");
	});

	it("returns item detail with paged artifacts and review opinion", async () => {
		const root = await createProjectRoot();

		const claim = await claimWork(root, "omp", {
			title: "Detailed Task",
			scope: { readPaths: [], writePaths: ["src"] },
		});

		const file1 = path.join(root, "src", "out1.txt");
		await mkdir(path.dirname(file1), { recursive: true });
		await writeFile(file1, "file1", "utf-8");

		await publishWork(root, "omp", {
			workId: claim.record.workId,
			expectedRevision: 1,
			files: [{ path: "src/out1.txt", role: "final" }],
		});

		const detail = await getProjectContext(root, { workId: claim.record.workId });
		expect(detail.detail).toBeDefined();
		expect(detail.detail?.record.title).toBe("Detailed Task");
		expect(detail.detail?.artifacts.length).toBe(1);
	});
});
