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
import { computeFileSha256, delegatedWorkId, WbTaskError } from "../src/tasks";
import { WB_ERROR_CODE } from "../src/types";
import { scopesConflict } from "../src/scope";

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

describe("waiting work records", () => {
	it("validates a waiting record instead of rejecting it", async () => {
		const root = await createProjectRoot();
		// The queue publishes a waiting record for every enqueued round; reading
		// it back through the same validator must not fail, or migration and the
		// workspace would silently drop those rows.
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
		expect((await readAllWorkRecords(root)).some((r) => r.workId === record.workId)).toBe(true);
	});

	it("does not let a waiting scope block another claim", async () => {
		const root = await createProjectRoot();
		// Publish a waiting record covering a path, then claim that same path:
		// waiting is a published-but-ungranted scope and never occupies.
		const waitingId = delegatedWorkId("22222222-2222-4222-8222-222222222222", 1);
		const collabDir = path.join(root, ".wb-bridge", "collaboration");
		await mkdir(collabDir, { recursive: true });
		await writeFile(
			path.join(collabDir, `${waitingId}.json`),
			JSON.stringify(
				{
					version: 1,
					workId: waitingId,
					projectRoot: root,
					owner: "omp",
					source: "delegated",
					taskId: "22222222-2222-4222-8222-222222222222",
					round: 1,
					nativeRef: null,
					title: "Queued, not granted",
					scope: { readPaths: [], writePaths: ["src/blocked-by-nothing"] },
					state: "waiting",
					phase: "queued",
					milestone: "",
					blocker: "",
					updatedAt: new Date().toISOString(),
					revision: 1,
					artifacts: [],
					remoteResults: [],
					reviews: [],
				},
				null,
				2,
			),
			"utf-8",
		);

		const claimed = await claimWork(root, "omp", {
			title: "Same path",
			scope: { readPaths: [], writePaths: ["src/blocked-by-nothing"] },
		});
		expect(claimed.record.state).toBe("active");
	});

	it("refuses to promote a waiting record to an occupying state via publish", async () => {
		const root = await createProjectRoot();
		const waitingId = delegatedWorkId("33333333-3333-4333-8333-333333333333", 1);
		const collabDir = path.join(root, ".wb-bridge", "collaboration");
		await mkdir(collabDir, { recursive: true });
		await writeFile(
			path.join(collabDir, `${waitingId}.json`),
			JSON.stringify(
				{
					version: 1,
					workId: waitingId,
					projectRoot: root,
					owner: "omp",
					source: "delegated",
					taskId: "33333333-3333-4333-8333-333333333333",
					round: 1,
					nativeRef: null,
					title: "Queued, not granted",
					scope: { readPaths: [], writePaths: ["src/granted-by-claim-only"] },
					state: "waiting",
					phase: "queued",
					milestone: "",
					blocker: "",
					updatedAt: new Date().toISOString(),
					revision: 1,
					artifacts: [],
					remoteResults: [],
					reviews: [],
				},
				null,
				2,
			),
			"utf-8",
		);

		let caught: unknown = null;
		try {
			await publishWork(root, "omp", {
				workId: waitingId,
				expectedRevision: 1,
				progress: { state: "active", phase: "running", milestone: "", blocker: "" },
			});
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
			expect(caught.message).toContain("waiting for its scope grant");
		}
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

describe("review re-verifies bytes on disk (N02)", () => {
	it("refuses an accepted review after the artifact changed on disk", async () => {
		const root = await createProjectRoot();
		const claim = await claimWork(root, "workbuddy", {
			title: "Reviewed artifact",
			scope: { readPaths: [], writePaths: [] },
		});
		// Publish one real deliverable into the round's outputs directory.
		await mkdir(claim.outputsDir, { recursive: true });
		const outPath = path.join(claim.outputsDir, "report.md");
		await writeFile(outPath, "v1\n", "utf-8");
		const published = await publishWork(root, "workbuddy", {
			workId: claim.record.workId,
			expectedRevision: 1,
			files: [{ path: "report.md", role: "final" }],
		});
		const publishedSha = published.artifacts[0]?.sha256;
		expect(publishedSha).not.toBeNull();

		// The bytes change after publication: a review quoting the old hash must be
		// refused, because the reviewer never saw this content.
		await writeFile(outPath, "v2 tampered\n", "utf-8");
		let caught: unknown = null;
		try {
			await publishWork(root, "workbuddy", {
				workId: claim.record.workId,
				expectedRevision: 2,
				review: { round: null, artifacts: [{ path: outPath, sha256: publishedSha! }], verdict: "accepted", note: "ok" },
			});
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBeTrue();
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.artifactChanged);
		}

		// A review quoting the hash that is actually on disk is accepted, proving
		// the rejection above was about the bytes and not about reviews generally.
		const currentSha = await computeFileSha256(outPath);
		const accepted = await publishWork(root, "workbuddy", {
			workId: claim.record.workId,
			expectedRevision: 2,
			review: { round: null, artifacts: [{ path: outPath, sha256: currentSha }], verdict: "accepted", note: "re-read" },
		});
		expect(accepted.reviews.length).toBe(1);
		// The accepted review makes the new bytes the record's truth; without this
		// write-back every later projection would flag a stale mismatch.
		expect(accepted.artifacts[0]?.sha256).toBe(currentSha);
	});

	it("refuses a review that names a file which does not exist", async () => {
		const root = await createProjectRoot();
		const claim = await claimWork(root, "workbuddy", {
			title: "Missing artifact",
			scope: { readPaths: [], writePaths: [] },
		});
		let caught: unknown = null;
		try {
			await publishWork(root, "workbuddy", {
				workId: claim.record.workId,
				expectedRevision: 1,
				review: {
					round: null,
					artifacts: [{ path: path.join(claim.outputsDir, "never-written.md"), sha256: "a".repeat(64) }],
					verdict: "accepted",
					note: "ok",
				},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBeTrue();
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});
});
