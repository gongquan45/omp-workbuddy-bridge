import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import type { Binding, TaskReceipt, TaskStatus, RoundConfirmation } from "../src/types";
import { WB_ERROR_CODE } from "../src/types";
import {
	collectArtifacts,
	computeFileSha256,
	currentRound,
	isPidAlive,
	prepareTask,
	readBinding,
	readTask,
	readTaskIndex,
	readTaskLock,
	releaseTask,
	WbTaskError,
	writeBinding,
	writeTask,
} from "../src/tasks";

async function runPrepare(
	binding: Binding,
	options: {
		prompt: string;
		inputFiles?: string[];
		expectedOutputs?: string[];
		taskId?: string;
		acceptance?: string[];
		previousRound?: number;
		inputs?: Array<{ path: string; sha256: string }>;
	}
) {
	let confirmedInputs = options.inputs;
	if (confirmedInputs === undefined) {
		confirmedInputs = [];
		if (options.inputFiles) {
			for (const rel of options.inputFiles) {
				const abs = path.resolve(binding.projectRoot, rel);
				try {
					confirmedInputs.push({ path: rel.split(path.sep).join("/"), sha256: await computeFileSha256(abs) });
				} catch {
					confirmedInputs.push({ path: rel.split(path.sep).join("/"), sha256: "fake-hash" });
				}
			}
		}
	}
	let previousRound = options.previousRound;
	if (previousRound === undefined) {
		if (options.taskId) {
			try {
				const existing = await readTask(binding.projectRoot, options.taskId);
				previousRound = existing.rounds.length;
			} catch {
				previousRound = 0;
			}
		} else {
			previousRound = 0;
		}
	}
	const confirmation: RoundConfirmation = {
		source: "host_dialog",
		at: new Date().toISOString(),
		sessionId: binding.sessionId,
		previousRound,
		inputs: confirmedInputs,
	};
	return await prepareTask(
		binding,
		{
			goal: {
				objective: options.prompt,
				context: "",
				constraints: [],
				acceptance: options.acceptance ?? ["Acceptance satisfied"],
				externalActions: [],
			},
			inputFiles: options.inputFiles,
			expectedOutputs: options.expectedOutputs,
			taskId: options.taskId,
		},
		confirmation
	);
}

/** Tracks temporary directories allocated during test runs for guaranteed cleanup. */
const allocatedTempDirs: string[] = [];

afterEach(async () => {
	while (allocatedTempDirs.length > 0) {
		const targetDir = allocatedTempDirs.pop();
		if (targetDir !== undefined) {
			try {
				await rm(targetDir, { recursive: true, force: true });
			} catch {
				// Suppress cleanup errors to avoid masking test assertions.
			}
		}
	}
});

/**
 * Creates an isolated temporary directory resolved to its canonical realpath.
 * Canonical resolution avoids Windows 8.3 short names and casing discrepancies.
 */
async function createProjectRoot(): Promise<string> {
	const raw = await mkdtemp(path.join(os.tmpdir(), "wb-tasks-test-"));
	const canonical = await realpath(raw);
	allocatedTempDirs.push(canonical);
	return canonical;
}

/**
 * Probes the operating system environment to check if unprivileged symlink creation
 * is permitted. Windows typically restricts symlinks unless Developer Mode is active.
 */
let isSymlinkPermitted = false;
try {
	const probeDir = await mkdtemp(path.join(os.tmpdir(), "wb-symlink-probe-"));
	allocatedTempDirs.push(probeDir);
	const targetPath = path.join(probeDir, "probe-target.txt");
	const linkPath = path.join(probeDir, "probe-link.txt");
	await writeFile(targetPath, "probe");
	try {
		await symlink(targetPath, linkPath);
		isSymlinkPermitted = true;
	} catch {
		isSymlinkPermitted = false;
	}
} catch {
	isSymlinkPermitted = false;
}

const symlinkTest = isSymlinkPermitted ? it : it.skip;

/**
 * Probes for directory links, which Windows permits without Developer Mode via
 * junctions even when file symlinks are refused. Tests that only need to point a
 * directory somewhere else use this guard instead.
 */
let isDirectoryLinkPermitted = false;
try {
	const probeDir = await mkdtemp(path.join(os.tmpdir(), "wb-dirlink-probe-"));
	allocatedTempDirs.push(probeDir);
	const targetPath = path.join(probeDir, "probe-target-dir");
	const linkPath = path.join(probeDir, "probe-link-dir");
	await mkdir(targetPath, { recursive: true });
	try {
		await symlink(targetPath, linkPath, "junction");
		isDirectoryLinkPermitted = true;
	} catch {
		isDirectoryLinkPermitted = false;
	}
} catch {
	isDirectoryLinkPermitted = false;
}

const directoryLinkTest = isDirectoryLinkPermitted ? it : it.skip;

describe("binding operations", () => {
	it("returns null when binding.json does not exist", async () => {
		const projectRoot = await createProjectRoot();
		const result = await readBinding(projectRoot);
		expect(result).toBeNull();
	});

	it("atomically writes binding and round-trips without leaving temp files", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};

		await writeBinding(binding);

		// Verify no temporary files remain in .wb-bridge/
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		const entries = await readdir(bridgeDir);
		expect(entries).toEqual(["binding.json"]);

		const retrieved = await readBinding(projectRoot);
		expect(retrieved).toEqual(binding);
	});

	it("throws WB_BINDING_INVALID on malformed binding files", async () => {
		const projectRoot = await createProjectRoot();
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });

		// Non-JSON content
		await writeFile(path.join(bridgeDir, "binding.json"), "invalid json content", "utf-8");
		let caughtError: unknown = null;
		try {
			await readBinding(projectRoot);
		} catch (err: unknown) {
			caughtError = err;
		}
		expect(caughtError instanceof WbTaskError).toBe(true);
		if (caughtError instanceof WbTaskError) {
			expect(caughtError.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}

		// Wrong schema version: v1 and v2 are both supported now, so the
		// unsupported case has to be a version this build never wrote.
		await writeFile(
			path.join(bridgeDir, "binding.json"),
			JSON.stringify({
				version: 3,
				projectRoot,
				sessionId: crypto.randomUUID(),
				workbuddyVersion: "5.8.2",
			}),
			"utf-8"
		);
		caughtError = null;
		try {
			await readBinding(projectRoot);
		} catch (err: unknown) {
			caughtError = err;
		}
		expect(caughtError instanceof WbTaskError).toBe(true);
		if (caughtError instanceof WbTaskError) {
			expect(caughtError.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}

		// Empty sessionId string
		await writeFile(
			path.join(bridgeDir, "binding.json"),
			JSON.stringify({
				version: 1,
				projectRoot,
				sessionId: "   ",
				workbuddyVersion: "5.8.2",
			}),
			"utf-8"
		);
		caughtError = null;
		try {
			await readBinding(projectRoot);
		} catch (err: unknown) {
			caughtError = err;
		}
		expect(caughtError instanceof WbTaskError).toBe(true);
		if (caughtError instanceof WbTaskError) {
			expect(caughtError.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}
	});
});

describe("prepareTask setup and brief contents", () => {
	it("creates complete directory layout with brief, inputs, outputs, and receipt", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const result = await runPrepare(binding, {
			prompt: "Inspect sales data and generate visual report",
		});

		// Returned paths must be absolute
		expect(path.isAbsolute(result.briefPath)).toBe(true);
		expect(path.isAbsolute(result.outputsDir)).toBe(true);

		const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", result.receipt.taskId);
		const round1Dir = path.join(taskDir, "rounds", "1");
		const roundEntries = await readdir(round1Dir);
		roundEntries.sort();
		expect(roundEntries).toEqual(["brief.md", "inputs", "outputs"]);

		await releaseTask(projectRoot, result.receipt.taskId);
	});

	it("succeeds for pure consultation tasks with empty inputs and outputs", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const result = await runPrepare(binding, {
			prompt: "Compare SQLite and DuckDB for embedded analytics",
		});

		const current = currentRound(result.receipt);
		expect(current.status).toBe("running");
		expect(current.inputFiles).toEqual([]);
		expect(current.expectedOutputs).toEqual([]);
		expect(current.error).toBeNull();
		await releaseTask(projectRoot, result.receipt.taskId);
	});
});

describe("inputFiles validation and snapshotting", () => {
	it("copies nested relative paths preserving structure and records normalized forward slashes", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// Create nested project source file
		const nestedDir = path.join(projectRoot, "src", "data");
		await mkdir(nestedDir, { recursive: true });
		const sourceFile = path.join(nestedDir, "metrics.csv");
		await writeFile(sourceFile, "metric,value\ncpu,42", "utf-8");

		const result = await runPrepare(binding, {
			prompt: "Summarize metrics",
			inputFiles: [path.join("src", "data", "metrics.csv")],
		});

		const current = currentRound(result.receipt);
		expect(current.inputFiles.map((i) => i.path)).toEqual(["src/data/metrics.csv"]);

		const snapshotPath = path.join(
			projectRoot,
			".wb-bridge",
			"tasks",
			result.receipt.taskId,
			"rounds",
			"1",
			"inputs",
			"src",
			"data",
			"metrics.csv"
		);
		const snapshotContent = await readFile(snapshotPath, "utf-8");
		expect(snapshotContent).toBe("metric,value\ncpu,42");

		await releaseTask(projectRoot, result.receipt.taskId);
	});

	it("rejects absolute paths, traversal, external files, directories, and missing files", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// Create a directory inside project
		await mkdir(path.join(projectRoot, "some-dir"), { recursive: true });

		// Create a real file outside project
		const outsideDir = await createProjectRoot();
		const outsideFile = path.join(outsideDir, "external.txt");
		await writeFile(outsideFile, "outside", "utf-8");

		const testCases: string[] = [
			path.resolve(projectRoot, "absolute.txt"),
			"../escaped.txt",
			"sub/../../parent.txt",
			path.relative(projectRoot, outsideFile),
			"some-dir",
			"non-existent-file.txt",
		];

		for (const invalidInput of testCases) {
			let caught: unknown = null;
			try {
				await runPrepare(binding, {
					prompt: "Test invalid input rejection",
					inputFiles: [invalidInput],
				});
			} catch (err: unknown) {
				caught = err;
			}
			expect(caught instanceof WbTaskError).toBe(true);
			if (caught instanceof WbTaskError) {
				expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
			}
		}
	});

	symlinkTest("rejects an input file symlink that escapes the project", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const outsideDir = await createProjectRoot();
		const outsideFile = path.join(outsideDir, "secret.txt");
		await writeFile(outsideFile, "secret content", "utf-8");

		const linkPath = path.join(projectRoot, "symlink-to-outside.txt");
		await symlink(outsideFile, linkPath);

		let caught: unknown = null;
		try {
			await runPrepare(binding, {
				prompt: "Attempt reading outside symlink",
				inputFiles: ["symlink-to-outside.txt"],
			});
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});
});

describe("expectedOutputs validation", () => {
	it("rejects absolute paths, traversal segments, and drive letters", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const invalidOutputs = [
			path.resolve(projectRoot, "output.txt"),
			"../escaped-output.txt",
			"C:drive-output.txt",
			"D:\\absolute-drive.txt",
			"/leading-slash.txt",
		];

		for (const out of invalidOutputs) {
			let caught: unknown = null;
			try {
				await runPrepare(binding, {
					prompt: "Test invalid expected output",
					expectedOutputs: [out],
				});
			} catch (err: unknown) {
				caught = err;
			}
			expect(caught instanceof WbTaskError).toBe(true);
			if (caught instanceof WbTaskError) {
				expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
			}
		}
	});

	it("deduplicates expected output filenames while preserving order", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const result = await runPrepare(binding, {
			prompt: "Deduplication check",
			expectedOutputs: ["report.pdf", "data.json", "report.pdf", "data.json", "charts/pie.png"],
		});

		const current = currentRound(result.receipt);
		expect(current.expectedOutputs).toEqual(["report.pdf", "data.json", "charts/pie.png"]);

		await releaseTask(projectRoot, result.receipt.taskId);
	});
});

describe("exclusive task locking and dead-owner recovery", () => {
	it("allows exactly one of two concurrent prepareTask calls to acquire the lock", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const results = await Promise.allSettled([
			runPrepare(binding, { prompt: "Task branch A" }),
			runPrepare(binding, { prompt: "Task branch B" }),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);

		const rej = rejected[0];
		if (rej !== undefined && rej.status === "rejected") {
			const reason = rej.reason;
			expect(reason instanceof WbTaskError).toBe(true);
			if (reason instanceof WbTaskError) {
				expect(reason.code).toBe(WB_ERROR_CODE.busy);
			}
		}

		const ful = fulfilled[0];
		if (ful !== undefined && ful.status === "fulfilled") {
			await releaseTask(projectRoot, ful.value.receipt.taskId);
		}
	});

	it("only releases the lock when the supplied taskId matches", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const { receipt } = await runPrepare(binding, { prompt: "Release safety check" });
		const lockPath = path.join(projectRoot, ".wb-bridge", "active.lock");

		// Mismatched taskId must not delete the lock file
		await releaseTask(projectRoot, crypto.randomUUID());
		let lockExists = false;
		try {
			await stat(lockPath);
			lockExists = true;
		} catch {
			lockExists = false;
		}
		expect(lockExists).toBe(true);

		// Matching taskId releases the lock file
		await releaseTask(projectRoot, receipt.taskId);
		try {
			await stat(lockPath);
			lockExists = true;
		} catch {
			lockExists = false;
		}
		expect(lockExists).toBe(false);
	});

	it("reaps a dead-owner lock and marks the orphaned running receipt as interrupted", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// Spawn a short-lived process and wait for real process exit to obtain a guaranteed dead PID
		const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		const deadPid = shortProcess.pid;
		await shortProcess.exited;

		const orphanedTaskId = crypto.randomUUID();
		const orphanedReceipt: TaskReceipt = {
			version: 2,
			taskId: orphanedTaskId,
			sessionId: binding.sessionId,
			projectRoot,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: {
						objective: "Original interrupted work",
						context: "",
						constraints: [],
						acceptance: ["done"],
						externalActions: [],
					},
					inputFiles: [],
					expectedOutputs: [],
					status: "running",
					summary: "",
					error: null,
					artifacts: [],
					consent: { source: "host_dialog", at: new Date().toISOString() },
				},
			],
		};
		await writeTask(orphanedReceipt);

		// Manually plant the stale lock referencing the dead PID
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(
			path.join(bridgeDir, "active.lock"),
			JSON.stringify({
				ownerPid: deadPid,
				taskId: orphanedTaskId,
				acquiredAt: Date.now() - 100000,
			}),
			"utf-8"
		);

		// Prepare a new task; it should reap the stale lock and succeed
		const newResult = await runPrepare(binding, {
			prompt: "New incoming task",
		});

		expect(currentRound(newResult.receipt).status).toBe("running");

		// Inspect the orphaned task's receipt to verify interrupted transition and reason
		const updatedOrphan = await readTask(projectRoot, orphanedTaskId);
		const orphanRound = currentRound(updatedOrphan);
		expect(orphanRound.status).toBe("interrupted");
		expect(orphanRound.error).not.toBeNull();
		if (orphanRound.error !== null) {
			expect(orphanRound.error.code).toBe(WB_ERROR_CODE.interrupted);
			expect(orphanRound.error.message).toContain(String(deadPid));
		}
		// Confirm the orphaned prompt was not replayed or altered
		expect(orphanRound.goal.objective).toBe("Original interrupted work");
		await releaseTask(projectRoot, newResult.receipt.taskId);
	});

	it("fails closed with WB_TASK_STATE_INVALID on corrupted lock files", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(path.join(bridgeDir, "active.lock"), "{ broken json", "utf-8");

		let caught: unknown = null;
		try {
			await runPrepare(binding, { prompt: "Acquire against corrupted lock" });
		} catch (err: unknown) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}
		// The unreadable lock is left exactly where it was: a corrupted lock is
		// never discarded on the strength of a failed read.
		expect(await readFile(path.join(bridgeDir, "active.lock"), "utf-8")).toBe("{ broken json");
	});

	it("refuses to reap a dead-owner lock whose orphaned receipt is corrupted", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		const deadPid = shortProcess.pid;
		await shortProcess.exited;

		const orphanedTaskId = crypto.randomUUID();
		const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", orphanedTaskId);
		await mkdir(taskDir, { recursive: true });
		await writeFile(path.join(taskDir, "receipt.json"), "{ not json", "utf-8");
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		const lockPath = path.join(bridgeDir, "active.lock");
		await writeFile(
			lockPath,
			JSON.stringify({ ownerPid: deadPid, taskId: orphanedTaskId, acquiredAt: Date.now() - 1000 }),
			"utf-8"
		);

		let caught: unknown = null;
		try {
			await runPrepare(binding, { prompt: "New task against corrupt orphan" });
		} catch (err: unknown) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}
		// The lock is the only thing keeping this damaged slot from being reused,
		// so it stays until the state is repaired.
		expect(await readTaskLock(projectRoot)).toEqual({ ownerPid: deadPid, taskId: orphanedTaskId });
		expect(await readFile(lockPath, "utf-8")).toContain(String(deadPid));
	});

	it("reaps a dead-owner lock with no receipt at all", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		const deadPid = shortProcess.pid;
		await shortProcess.exited;

		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(
			path.join(bridgeDir, "active.lock"),
			JSON.stringify({ ownerPid: deadPid, taskId: crypto.randomUUID(), acquiredAt: Date.now() - 1000 }),
			"utf-8"
		);

		// Nothing is left to commit for a task that never wrote a receipt, so the
		// slot is recoverable.
		const prepared = await runPrepare(binding, { prompt: "New task after bare lock" });
		expect(currentRound(prepared.receipt).status).toBe("running");
		expect((await readTaskLock(projectRoot))?.taskId).toBe(prepared.receipt.taskId);
		await releaseTask(projectRoot, prepared.receipt.taskId);
	});

	it("keeps a lock whose owner is still alive", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const otherTaskId = crypto.randomUUID();
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(
			path.join(bridgeDir, "active.lock"),
			JSON.stringify({ ownerPid: process.pid, taskId: otherTaskId, acquiredAt: Date.now() }),
			"utf-8"
		);

		let caught: unknown = null;
		try {
			await runPrepare(binding, { prompt: "Should be blocked" });
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.busy);
			expect(caught.message).toContain(String(process.pid));
		}
	});

	it("reports liveness as unknown rather than dead for a pid it cannot signal", () => {
		// Only ESRCH proves a process is gone. Any other failure (EPERM for another
		// user's process) must read as alive so a running task is never reaped.
		expect(isPidAlive(process.pid)).toBe(true);
		// PID 0 can never be signalled to on any platform, so it exercises the
		// uncertain branch rather than the ESRCH branch.
		expect(isPidAlive(0)).toBe(true);
	});

	it("releases only its own process's lock and rejects unreadable ones", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// A lock held by another process is never released, even for the same task.
		const foreignTaskId = crypto.randomUUID();
		const bridgeDir = path.join(projectRoot, ".wb-bridge");
		const lockPath = path.join(bridgeDir, "active.lock");
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({ ownerPid: process.pid + 1, taskId: foreignTaskId, acquiredAt: Date.now() }),
			"utf-8"
		);
		await releaseTask(projectRoot, foreignTaskId);
		expect(await readTaskLock(projectRoot)).toEqual({ ownerPid: process.pid + 1, taskId: foreignTaskId });

		// A missing lock is still a plain no-op.
		await unlink(lockPath);
		await releaseTask(projectRoot, foreignTaskId);

		// A release that cannot read the lock reports the failure instead of
		// claiming success.
		await writeFile(lockPath, "{ broken json", "utf-8");
		let caught: unknown = null;
		try {
			await releaseTask(projectRoot, foreignTaskId);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}
	});

	it("reports a receipt write it could not commit as WB_STORAGE_ERROR", async () => {
		const projectRoot = await createProjectRoot();
		const taskId = crypto.randomUUID();
		const receipt: TaskReceipt = {
			version: 2,
			taskId,
			sessionId: crypto.randomUUID(),
			projectRoot,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: {
						objective: "unwritable",
						context: "",
						constraints: [],
						acceptance: ["done"],
						externalActions: [],
					},
					inputFiles: [],
					expectedOutputs: [],
					status: "completed",
					summary: "",
					artifacts: [],
					error: null,
					consent: { source: "host_dialog", at: new Date().toISOString() },
				},
			],
		};

		// A directory where the receipt file belongs makes the atomic rename fail
		// after validation has already passed.
		const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", taskId);
		await mkdir(path.join(taskDir, "receipt.json"), { recursive: true });

		let caught: unknown = null;
		try {
			await writeTask(receipt);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.storageError);
			expect(caught.message).toContain(taskId);
			expect(caught.message).toContain("receipt write");
		}
	});

	it("still reports structure problems on a receipt as state-invalid", async () => {
		const projectRoot = await createProjectRoot();
		const receipt = {
			version: 2,
			taskId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			projectRoot,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: {
						objective: "x",
						context: "",
						constraints: [],
						acceptance: ["done"],
						externalActions: [],
					},
					inputFiles: [],
					expectedOutputs: [],
					status: "sideways",
					summary: "",
					artifacts: [],
					error: null,
					consent: null,
				},
			],
		} as unknown as TaskReceipt;
		// @ts-expect-error deliberately malformed status to prove the classification
		receipt.status = "sideways";

		let caught: unknown = null;
		try {
			await writeTask(receipt);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}
	});

	directoryLinkTest("reports both stages when preparation must roll back a failed slot", async () => {
		const projectRoot = await createProjectRoot();
		const externalBridge = path.join(await createProjectRoot(), "bridge");
		await mkdir(externalBridge, { recursive: true });
		await symlink(externalBridge, path.join(projectRoot, ".wb-bridge"), "junction");

		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};

		// A finished task to supplement, whose inputs path is occupied by a file so
		// the snapshot step fails after the lock was already taken.
		const taskId = crypto.randomUUID();
		const taskDir = path.join(externalBridge, "tasks", taskId);
		await mkdir(taskDir, { recursive: true });
		await writeFile(path.join(taskDir, "rounds"), "not a directory", "utf-8");
		await writeTask({
			version: 2,
			taskId,
			sessionId: binding.sessionId,
			projectRoot,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: {
						objective: "finished work",
						context: "",
						constraints: [],
						acceptance: ["done"],
						externalActions: [],
					},
					inputFiles: [],
					expectedOutputs: [],
					status: "completed",
					summary: "done",
					artifacts: [],
					error: null,
					consent: { source: "host_dialog", at: new Date().toISOString() },
				},
			],
		});

		let caught: unknown = null;
		try {
			await runPrepare(binding, { prompt: "supplement", taskId });
		} catch (err: unknown) {
			caught = err;
		}

		// The preparation failure and the rollback failure are both reported, and
		// the rollback failure wins because it is what leaves the slot blocked.
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.storageError);
			expect(caught.message).toContain("Task preparation failed");
			expect(caught.message).toContain("rolling back");
		}
		// The lock belonging to this process is still there, because the release
		// that would have removed it could not be trusted.
		const keptLock = JSON.parse(await readFile(path.join(externalBridge, "active.lock"), "utf-8")) as {
			taskId: string;
		};
		expect(keptLock.taskId).toBe(taskId);
	});
});

describe("supplementary turns on existing tasks", () => {
	it("succeeds after terminal completion, merges inputs/outputs, and preserves existing deliverables", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// Initial input files
		await writeFile(path.join(projectRoot, "step1.txt"), "data 1", "utf-8");
		await writeFile(path.join(projectRoot, "step2.txt"), "data 2", "utf-8");

		const initial = await runPrepare(binding, {
			prompt: "First initial instruction",
			inputFiles: ["step1.txt"],
			expectedOutputs: ["initial-output.md"],
		});

		// Simulate WorkBuddy producing the initial deliverable and finishing
		const initialOutputDest = path.join(initial.outputsDir, "initial-output.md");
		await writeFile(initialOutputDest, "# Initial Deliverable Content", "utf-8");

		const current = currentRound(initial.receipt);
		current.status = "completed";
		current.summary = "First instruction completed successfully";
		current.artifacts = [
			{
				kind: "file",
				path: initialOutputDest,
				sha256: await computeFileSha256(initialOutputDest),
				bytes: 28,
				role: "final",
				provenance: "native",
				importedFrom: null,
			},
		];
		await writeTask(initial.receipt);
		await releaseTask(projectRoot, initial.receipt.taskId);

		// Launch supplementary turn on the same taskId
		const supplementary = await runPrepare(binding, {
			taskId: initial.receipt.taskId,
			prompt: "Supplementary followup instruction",
			inputFiles: ["step2.txt"],
			expectedOutputs: ["followup.pdf"],
		});

		const suppCurrent = currentRound(supplementary.receipt);
		expect(suppCurrent.goal.objective).toBe("Supplementary followup instruction");
		expect(suppCurrent.inputFiles.map((i) => i.path)).toEqual(["step2.txt"]);
		expect(suppCurrent.expectedOutputs).toEqual(["followup.pdf"]);
		expect(supplementary.round).toBe(2);
		expect(supplementary.receipt.rounds.length).toBe(2);

		// Verify existing deliverable in outputs/ was preserved
		const existingContent = await readFile(initialOutputDest, "utf-8");
		expect(existingContent).toBe("# Initial Deliverable Content");

		await releaseTask(projectRoot, supplementary.receipt.taskId);
	});

	it("rejects supplementary requests against running tasks with WB_BUSY", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const running = await runPrepare(binding, {
			prompt: "Currently running work",
		});

		let caught: unknown = null;
		try {
			await runPrepare(binding, {
				taskId: running.receipt.taskId,
				prompt: "Premature supplementary attempt",
			});
		} catch (err: unknown) {
			caught = err;
		}

		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.busy);
		}

		await releaseTask(projectRoot, running.receipt.taskId);
	});

	it("rejects unknown taskIds and non-UUID taskIds without path traversal", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		// Unknown UUID
		let caught: unknown = null;
		try {
			await runPrepare(binding, {
				taskId: crypto.randomUUID(),
				prompt: "Unknown task target",
			});
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskNotFound);
		}

		// Non-UUID string with traversal syntax
		caught = null;
		try {
			await runPrepare(binding, {
				taskId: "../../etc/passwd",
				prompt: "Traversal attempt",
			});
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.inputInvalid);
		}
	});
});

describe("collectArtifacts discovery", () => {
	it("returns absolute paths of real outputs including nested subdirectories and notes missing files", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};

		const { receipt, outputsDir } = await runPrepare(binding, {
			prompt: "Artifact collection check",
			expectedOutputs: ["summary.md", "assets/chart.png", "missing-report.pdf"],
		});

		// Create real output deliverables
		const summaryPath = path.join(outputsDir, "summary.md");
		await writeFile(summaryPath, "Summary report", "utf-8");

		const assetsDir = path.join(outputsDir, "assets");
		await mkdir(assetsDir, { recursive: true });
		const chartPath = path.join(assetsDir, "chart.png");
		await writeFile(chartPath, "fake png content", "utf-8");

		const result = await collectArtifacts(receipt);

		expect(result.artifacts.length).toBe(2);
		expect(result.artifacts.map((a) => a.path)).toContain(summaryPath);
		expect(result.artifacts.map((a) => a.path)).toContain(chartPath);
		expect(result.missingOutputs).toEqual(["missing-report.pdf"]);

		await releaseTask(projectRoot, receipt.taskId);
	});

	it("returns empty artifacts when outputs directory contains no files", async () => {
		const projectRoot = await createProjectRoot();
		const binding: Binding = {
			version: 1,
			projectRoot,
			sessionId: crypto.randomUUID(),
			workbuddyVersion: "5.8.2",
		};
		await writeBinding(binding);

		const { receipt } = await runPrepare(binding, {
			prompt: "No outputs yet",
			expectedOutputs: ["deliverable.txt"],
		});

		const result = await collectArtifacts(receipt);
		expect(result.artifacts).toEqual([]);
		expect(result.missingOutputs).toEqual(["deliverable.txt"]);

		await releaseTask(projectRoot, receipt.taskId);
	});
});

describe("readTask and writeTask persistence", () => {
	it("throws WB_TASK_NOT_FOUND when task does not exist", async () => {
		const projectRoot = await createProjectRoot();
		let caught: unknown = null;
		try {
			await readTask(projectRoot, crypto.randomUUID());
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskNotFound);
		}
	});

	it("throws WB_TASK_STATE_INVALID on corrupted JSON or invalid status", async () => {
		const projectRoot = await createProjectRoot();
		const taskId = crypto.randomUUID();
		const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", taskId);
		await mkdir(taskDir, { recursive: true });

		// Corrupted JSON
		await writeFile(path.join(taskDir, "receipt.json"), "invalid json", "utf-8");
		let caught: unknown = null;
		try {
			await readTask(projectRoot, taskId);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}

		// Unknown status value
		await writeFile(
			path.join(taskDir, "receipt.json"),
			JSON.stringify({
				version: 1,
				taskId,
				sessionId: crypto.randomUUID(),
				projectRoot,
				status: "unknown_bogus_status",
				prompt: "testing bogus status",
				inputFiles: [],
				expectedOutputs: [],
				summary: "",
				artifacts: [],
				error: null,
			}),
			"utf-8"
		);

		caught = null;
		try {
			await readTask(projectRoot, taskId);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.taskStateInvalid);
		}
	});
});

describe("readTaskIndex history listing", () => {
	/** Writes one receipt for this project and returns its task id. */
	async function seedTask(
		projectRoot: string,
		options: { status?: TaskStatus; taskId?: string; mtime?: number } = {},
	): Promise<string> {
		const taskId = options.taskId ?? crypto.randomUUID();
		const taskDir = path.join(projectRoot, ".wb-bridge", "tasks", taskId);
		await mkdir(taskDir, { recursive: true });
		await writeFile(
			path.join(taskDir, "receipt.json"),
			JSON.stringify({
				version: 1,
				taskId,
				sessionId: crypto.randomUUID(),
				projectRoot,
				status: options.status ?? "completed",
				prompt: "seeded",
				inputFiles: [],
				expectedOutputs: [],
				summary: "",
				artifacts: [],
				error: null,
			}),
			"utf-8",
		);
		if (options.mtime !== undefined) {
			const when = new Date(options.mtime);
			await utimes(path.join(taskDir, "receipt.json"), when, when);
		}
		return taskId;
	}

	it("lists stored tasks with their receipt mtime and reports the project", async () => {
		const projectRoot = await createProjectRoot();
		const older = await seedTask(projectRoot, { mtime: 1_700_000_000_000, status: "failed" });
		const newer = await seedTask(projectRoot, { mtime: 1_800_000_000_000, status: "completed" });

		const index = await readTaskIndex(projectRoot);
		expect(index.warnings).toEqual([]);
		expect(index.entries.length).toBe(2);
		const byId = new Map(index.entries.map((entry) => [entry.taskId, entry]));
		expect(byId.get(newer)?.status).toBe("completed");
		expect(byId.get(older)?.status).toBe("failed");
		expect(Math.round(byId.get(newer)?.updatedAt ?? 0)).toBe(1_800_000_000_000);
	});

	it("returns an empty index without creating anything when no tasks exist", async () => {
		const projectRoot = await createProjectRoot();
		const index = await readTaskIndex(projectRoot);
		expect(index).toEqual({ entries: [], warnings: [] });
		// The scan is read-only: it must not bring the state directory into being.
		expect(await readdir(projectRoot)).toEqual([]);
	});

	it("keeps readable tasks and warns about a corrupt, a missing and a linked record", async () => {
		const projectRoot = await createProjectRoot();
		const good = await seedTask(projectRoot);

		// A record whose JSON is truncated.
		const corrupt = crypto.randomUUID();
		const corruptDir = path.join(projectRoot, ".wb-bridge", "tasks", corrupt);
		await mkdir(corruptDir, { recursive: true });
		await writeFile(path.join(corruptDir, "receipt.json"), "{ truncated", "utf-8");

		// A UUID-named directory with no receipt at all.
		const missing = crypto.randomUUID();
		await mkdir(path.join(projectRoot, ".wb-bridge", "tasks", missing), { recursive: true });

		const index = await readTaskIndex(projectRoot);
		expect(index.entries.map((entry) => entry.taskId)).toEqual([good]);
		const warned = new Set(index.warnings.map((warning) => warning.taskId));
		expect(warned.has(corrupt)).toBe(true);
		expect(warned.has(missing)).toBe(true);
		// A warning never carries the receipt's own contents.
		for (const warning of index.warnings) {
			expect(warning.error.message).not.toContain("seeded");
		}
	});

	it("skips records that do not declare this project or this directory", async () => {
		const projectRoot = await createProjectRoot();
		const foreignRoot = await createProjectRoot();
		const okay = await seedTask(projectRoot);

		// The same id in both places, but the receipt claims a different project.
		const mismatched = await seedTask(projectRoot, { taskId: crypto.randomUUID() });
		const mismatchedPath = path.join(projectRoot, ".wb-bridge", "tasks", mismatched, "receipt.json");
		const raw = JSON.parse(await readFile(mismatchedPath, "utf-8")) as Record<string, unknown>;
		raw.projectRoot = foreignRoot;
		await writeFile(mismatchedPath, JSON.stringify(raw), "utf-8");

		// A receipt whose declared taskId disagrees with its directory name.
		const undeclared = await seedTask(projectRoot, { taskId: crypto.randomUUID() });
		const undeclaredPath = path.join(projectRoot, ".wb-bridge", "tasks", undeclared, "receipt.json");
		const rawUndeclared = JSON.parse(await readFile(undeclaredPath, "utf-8")) as Record<string, unknown>;
		rawUndeclared.taskId = crypto.randomUUID();
		await writeFile(undeclaredPath, JSON.stringify(rawUndeclared), "utf-8");

		const index = await readTaskIndex(projectRoot);
		const listed = new Set(index.entries.map((entry) => entry.taskId));
		expect(listed.has(okay)).toBe(true);
		expect(listed.has(mismatched)).toBe(false);
		expect(listed.has(undeclared)).toBe(false);
		const warned = new Set(index.warnings.map((warning) => warning.taskId));
		expect(warned.has(mismatched)).toBe(true);
		expect(warned.has(undeclared)).toBe(true);
	});

	it("ignores non-UUID entries and reports an unresolvable project root", async () => {
		const projectRoot = await createProjectRoot();
		await mkdir(path.join(projectRoot, ".wb-bridge", "tasks", "not-a-uuid"), { recursive: true });
		await mkdir(path.join(projectRoot, ".wb-bridge", "tasks", "019be0f3"), { recursive: true });

		const index = await readTaskIndex(projectRoot);
		expect(index.entries).toEqual([]);
		expect(index.warnings).toEqual([]);

		// A project root that cannot be resolved is a storage failure, not an
		// empty history, and the caller's spelling is never used as a fallback.
		const missingRoot = path.join(projectRoot, "does-not-exist");
		let caught: unknown = null;
		try {
			await readTaskIndex(missingRoot);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.storageError);
		}
	});

	directoryLinkTest("warns about a task directory that links outside the project", async () => {
		const projectRoot = await createProjectRoot();
		const external = await createProjectRoot();
		const leaked = await seedTask(external);

		// A link named like a real task points at another location's receipt; the
		// scan must report it as unreadable rather than read through it.
		await mkdir(path.join(projectRoot, ".wb-bridge", "tasks"), { recursive: true });
		await symlink(
			path.join(external, ".wb-bridge", "tasks", leaked),
			path.join(projectRoot, ".wb-bridge", "tasks", leaked),
			"junction",
		);
		const okay = await seedTask(projectRoot);

		const index = await readTaskIndex(projectRoot);
		expect(index.entries.map((entry) => entry.taskId)).toEqual([okay]);
		expect(index.warnings.map((warning) => warning.taskId)).toEqual([leaked]);
	});
});
