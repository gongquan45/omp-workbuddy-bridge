/**
 * Receipt repair (V04) driven through the real queue and the real files.
 *
 * The observable defect this protects: a round finishes, its first business result
 * is recorded, and the receipt write fails. Without a repair path the only choices
 * left are resending work whose outcome is already known, or leaving the round
 * looking like it is still running. Repair rebuilds the receipt from the evidence
 * the queue already holds and never sends anything.
 *
 * A possibly-sent round stays quarantined after the local commit: a repaired local
 * receipt is not proof that the remote execution stopped.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	closeQueueConnection,
	enableProject,
	openProjectQueue,
	readRound,
	readRoundResources,
	type RecoveryAudit,
} from "../src/queue";
import activate from "../src/index";
import { readOperatorRecoveryTarget, repairRoundReceipt, repairRoundReceiptAsOperator } from "../src/receipts";
import { buildConfirmationDigest, parseRoundReceiptJson, resolveRoundPaths, stageTask, writeRoundReceipt } from "../src/tasks";
import { WB_ERROR_CODE, type OwnerIdentity, type TaskGoal } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];
const TASK = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REQUEST = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const WB = "cccccccc-3333-4333-8333-cccccccccccc";

/**
 * The shutdown of every activation this file started.
 *
 * A real host ends the session, and the activation's own background work —
 * publishing a result fact, delivering a result, advancing the queue — is
 * finished by that shutdown. The fixture's files may only be removed once it
 * has run: a background write still in flight would hold the project open.
 */
const activations: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (activations.length > 0) {
		const stop = activations.pop();
		if (stop !== undefined) {
			await stop();
		}
	}
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			closeQueueConnection(root);
			closeQueueConnection(root, "read");
			await releaseProjectFixture(root);
		}
	}
});

function owner(): OwnerIdentity {
	return { sessionId: "omp-repair", generation: "gen-repair", processId: process.pid, instanceId: "instance-repair" };
}

/**
 * One enabled project with one claimed, staged round, optionally already sent.
 *
 * `ownerIdentity` stages the round under a different owner, so a fixture can
 * hand back a round whose owner is already gone. The default stays this
 * process's live owner.
 */
async function queuedRound(options: { armed?: boolean; ownerIdentity?: OwnerIdentity } = {}): Promise<string> {
	const root = await createFixtureRoot("wb-repair-");
	roots.push(root);
	await enableProject(root);

	// The round belongs to the identity that created it. A recovery fixture
	// stages that identity as one that has already died.
	const roundOwner = options.ownerIdentity ?? owner();
	const goal: TaskGoal = { objective: "prepare the note", context: "", constraints: [], acceptance: ["note exists"], externalActions: [] };
	const target = { kind: "session" as const, sessionId: WB };
	const confirmation = {
		source: "host_dialog" as const,
		at: new Date().toISOString(),
		targetPolicy: target,
		requestId: REQUEST,
		manifestSha256: buildConfirmationDigest({
			projectRoot: root,
			requestId: REQUEST,
			taskId: TASK,
			round: 1,
			owner: roundOwner,
			goal,
			targetPolicy: target,
			expectedOutputs: [],
			inputs: [],
			deliveryMode: "foreground",
		}),
		owner: roundOwner,
		previousRound: 0,
		inputs: [],
		deliveryMode: "foreground" as const,
	};
	const staged = await stageTask(root, confirmation, { goal, inputFiles: [], expectedOutputs: [] }, TASK, 1);

	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		queue.registerOwner(roundOwner, Date.now());
		queue.enqueue({
			taskId: TASK,
			round: 1,
			requestId: REQUEST,
			manifestSha256: staged.manifestSha256,
			manifestPath: staged.manifestPath,
			snapshotRoot: staged.snapshotRoot,
			expectedPreviousRound: null,
			readPaths: [],
			writePaths: [".wb-bridge/tasks"],
			targetPolicy: target,
			ownerSession: roundOwner.sessionId,
			ownerGeneration: roundOwner.generation,
			executorInstanceId: roundOwner.instanceId,
			approval: { source: confirmation.source, at: confirmation.at, payloadSha256: staged.manifestSha256 },
			title: "prepare the note",
			deliveryMode: "foreground",
		});
		const claim = queue.claim(roundOwner, Date.now());
		expect(claim.kind).toBe("claimed");
		if (options.armed === true && claim.kind === "claimed") {
			expect(
				queue.armPrompt({
					taskId: TASK,
					round: 1,
					attemptId: claim.attemptId,
					sessionId: WB,
					promptSha256: staged.manifestSha256,
					authorization: null,
					now: Date.now(),
				}).kind,
			).toBe("armed");
		}
	} finally {
		queue.close();
		closeQueueConnection(root);
	}
	return root;
}

/** Records the first result exactly as a failed terminal write would leave it. */
function recordUncommittableResult(root: string, status: "completed" | "failed" | "interrupted"): void {
	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		queue.beginTerminal({
			taskId: TASK,
			round: 1,
			outcome: {
				status,
				errorJson: status === "failed" ? JSON.stringify({ code: WB_ERROR_CODE.taskFailed, message: "worker stopped" }) : null,
				outcomeJson: JSON.stringify({
					status,
					error: status === "failed" ? { code: WB_ERROR_CODE.taskFailed, message: "worker stopped" } : null,
					summary: "the note is drafted",
					artifacts: [],
				}),
			},
			now: Date.now(),
		});
		queue.commitFailed({
			taskId: TASK,
			round: 1,
			errorJson: JSON.stringify({ code: WB_ERROR_CODE.storageError, message: "simulated disk failure" }),
			now: Date.now(),
		});
	} finally {
		queue.close();
	}
}

async function orphanedRound(): Promise<{ root: string; originalOwner: OwnerIdentity }> {
	const shortProcess = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
	await shortProcess.exited;
	const originalOwner: OwnerIdentity = {
		sessionId: "omp-original",
		generation: "gen-original",
		processId: shortProcess.pid,
		instanceId: "instance-original",
	};
	const root = await queuedRound({ armed: true, ownerIdentity: originalOwner });
	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		queue.reconcileAbandonedRounds({ now: Date.now() });
	} finally {
		queue.close();
	}
	return { root, originalOwner };
}

function recoveryRound(root: string): Record<string, unknown> {
	const queue = openProjectQueue(root, { mode: "read" })!;
	try {
		return queue.inspect({ taskId: TASK }).tasks[0]!;
	} finally {
		queue.close();
	}
}

async function expectRecoveryRefused(root: string): Promise<void> {
	const row = recoveryRound(root);
	expect(row["commit_state"]).toBe("failed");
	expect(row["phase"]).toBe("recovery_required");
	expect(row["dispatch_state"]).toBe("possibly_sent");
	expect(row["receipt_sha256"]).toBeNull();
	const queue = openProjectQueue(root, { mode: "read" })!;
	try {
		expect(queue.holds()).toEqual([{ sessionId: WB, taskId: TASK, round: 1, kind: "quarantine" }]);
	} finally {
		queue.close();
	}
	await expect(readFile(resolveRoundPaths(root, TASK, 1, "round").receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("repairing a failed receipt", () => {
	it("rebuilds the receipt from the recorded result and releases an unsent round", async () => {
		const root = await queuedRound();
		recordUncommittableResult(root, "completed");

		const repaired = await repairRoundReceipt(root, owner(), { taskId: TASK });
		expect(repaired.kind).toBe("repaired");
		if (repaired.kind !== "repaired") {
			return;
		}
		expect(repaired.released).toBeTrue();

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["status"]).toBe("completed");
			expect(row["commit_state"]).toBe("committed");
			expect(row["receipt_sha256"]).toBe(repaired.receiptSha256);
			// The business result is exactly the one that was already recorded.
			const outcome = JSON.parse(String(row["outcome_json"])) as { summary?: string };
			expect(outcome.summary).toBe("the note is drafted");
			// An unsent round released its hold; nothing else may stay blocked.
			expect(queue.holds()).toEqual([]);
		} finally {
			queue.close();
		}

		// The receipt on disk is the one the queue recorded, and it carries the
		// approved goal and approval rather than a synthesized one.
		const paths = resolveRoundPaths(root, TASK, 1, "round");
		const receipt = JSON.parse(await readFile(paths.receiptPath, "utf-8")) as {
			rounds: Array<{ status: string; goal: { objective: string } }>;
		};
		expect(receipt.rounds[0]!.status).toBe("completed");
		expect(receipt.rounds[0]!.goal.objective).toBe("prepare the note");
	});

	it("keeps a possibly-sent round quarantined after committing the local result", async () => {
		const root = await queuedRound({ armed: true });
		recordUncommittableResult(root, "failed");

		const repaired = await repairRoundReceipt(root, owner(), { taskId: TASK });
		expect(repaired.kind).toBe("repaired");
		if (repaired.kind !== "repaired") {
			return;
		}
		// The local receipt is committed, but the remote turn may still be running.
		expect(repaired.released).toBeFalse();

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["commit_state"]).toBe("committed");
			expect(row["phase"]).toBe("recovery_required");
			expect(row["status"]).toBe("failed");
			const holds = queue.holds();
			expect(holds).toHaveLength(1);
			expect(holds[0]!.kind).toBe("quarantine");
		} finally {
			queue.close();
		}
	});

	it("refuses an existing receipt that does not describe the recorded result", async () => {
		const root = await queuedRound();
		recordUncommittableResult(root, "completed");
		// The failed attempt may still have left a partial file behind.
		const paths = resolveRoundPaths(root, TASK, 1, "round");
		await mkdir(paths.roundDir, { recursive: true });
		await writeFile(paths.receiptPath, "{}\n", "utf-8");

		const repaired = await repairRoundReceipt(root, owner(), { taskId: TASK });
		expect(repaired.kind).toBe("refused");
		// The existing bytes are history, not something to overwrite.
		expect(await readFile(paths.receiptPath, "utf-8")).toBe("{}\n");
	});

	it("refuses a foreign originating session and an unregistered generation", async () => {
		const root = await queuedRound();
		recordUncommittableResult(root, "completed");

		const foreign = await repairRoundReceipt(root, { ...owner(), sessionId: "omp-someone-else" }, { taskId: TASK });
		expect(foreign.kind).toBe("refused");

		const stale = await repairRoundReceipt(root, { ...owner(), generation: "gen-never-registered" }, { taskId: TASK });
		expect(stale.kind).toBe("refused");

		// Neither refusal wrote anything.
		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(queue.inspect({ taskId: TASK }).tasks[0]!["commit_state"]).toBe("failed");
		} finally {
			queue.close();
		}
	});

	it("refuses a round whose recorded result is missing rather than inventing one", async () => {
		const root = await queuedRound();
		const repaired = await repairRoundReceipt(root, owner(), { taskId: TASK });
		expect(repaired.kind).toBe("refused");
		if (repaired.kind === "refused") {
			expect(repaired.reason).toContain("first outcome");
		}
	});

	it("does not rewrite a receipt that a normal commit already confirmed", async () => {
		const root = await queuedRound();
		const paths = resolveRoundPaths(root, TASK, 1, "round");
		const canonicalRoot = await realpath(root);
		const written = await writeRoundReceipt(root, TASK, 1, "round", {
			version: 3,
			taskId: TASK,
			sessionId: owner().sessionId,
			projectRoot: canonicalRoot,
			rounds: [
				{
					number: 1,
					layout: "round",
					goal: { objective: "prepare the note", context: "", constraints: [], acceptance: ["note exists"], externalActions: [] },
					inputFiles: [],
					expectedOutputs: [],
					status: "completed",
					summary: "",
					error: null,
					artifacts: [],
					recordKind: "approved",
					requestId: REQUEST,
					targetPolicy: { kind: "session", sessionId: WB },
					snapshotRoot: paths.roundDir,
					owner: owner(),
					manifestSha256: String(openProjectQueue(root, { mode: "read" })!.inspect({ taskId: TASK }).tasks[0]!["manifest_sha256"]),
					commitToken: null,
					turns: [],
					consent: { source: "host_dialog", at: new Date().toISOString() },
				},
			],
		});
		const receiptBefore = await readFile(paths.receiptPath, "utf-8");

		// Commit normally, then ask to repair it.
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.beginTerminal({
				taskId: TASK, round: 1,
				outcome: { status: "completed", errorJson: null, outcomeJson: JSON.stringify({ status: "completed", error: null, summary: "", artifacts: [] }) },
				now: Date.now(),
			});
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(
				queue.confirmReceipt({
					taskId: TASK, round: 1, receiptSha256: written.sha256,
					commitToken: { requestId: REQUEST, resultRevision: Number(row["revision"]) },
					now: Date.now(),
				}).kind,
			).toBe("committed");
		} finally {
			queue.close();
		}

		const repaired = await repairRoundReceipt(root, owner(), { taskId: TASK });
		expect(repaired.kind).toBe("refused");
		expect(await readFile(paths.receiptPath, "utf-8")).toBe(receiptBefore);
	});
	it("refuses a substituted receipt even when its status matches the recorded result", async () => {
		const root = await queuedRound();
		recordUncommittableResult(root, "completed");
		await repairRoundReceipt(root, owner(), { taskId: TASK }, async (...args) => {
			await writeRoundReceipt(...args);
			throw new Error("Controlled failure after writing the receipt");
		});
		const paths = resolveRoundPaths(root, TASK, 1, "round");
		const substituted = parseRoundReceiptJson(await readFile(paths.receiptPath, "utf-8"), paths.receiptPath);
		substituted.rounds[0]!.summary = "A result the worker never recorded";
		await writeRoundReceipt(root, TASK, 1, "round", substituted);
		const before = await readFile(paths.receiptPath, "utf-8");

		expect((await repairRoundReceipt(root, owner(), { taskId: TASK })).kind).toBe("refused");
		const row = recoveryRound(root);
		expect(row["commit_state"]).toBe("failed");
		expect(row["receipt_sha256"]).toBeNull();
		expect(JSON.parse(String(row["outcome_json"])).summary).toBe("the note is drafted");
		expect(await readFile(paths.receiptPath, "utf-8")).toBe(before);
	});

	it("does not commit when recovery is cancelled during receipt IO", async () => {
		const { root } = await orphanedRound();
		const operator = { ...owner(), sessionId: "omp-io-operator" };
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.registerOwner(operator, Date.now());
		} finally {
			queue.close();
		}
		const target = readOperatorRecoveryTarget(root, operator, { taskId: TASK });
		expect(target.kind).toBe("target");
		if (target.kind !== "target") throw new Error("The dead owner's round must be recoverable");
		const controller = new AbortController();
		const before = recoveryRound(root);
		const repaired = await repairRoundReceiptAsOperator(
			root, operator, target,
			{ confirmed: true, at: new Date().toISOString(), subject: target.subject },
			{
				signal: controller.signal,
				writeReceipt: async (...args) => {
					const written = await writeRoundReceipt(...args);
					controller.abort();
					return written;
				},
			},
		);
		expect(repaired.kind).toBe("refused");
		const after = recoveryRound(root);
		expect(after["commit_state"]).toBe("failed");
		expect(after["receipt_sha256"]).toBeNull();
		expect(after["receipt_recovery_json"]).toBeNull();
		expect(after["outcome_json"]).toBe(before["outcome_json"]);
		const reader = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(reader.holds()).toEqual([{ sessionId: WB, taskId: TASK, round: 1, kind: "quarantine" }]);
		} finally {
			reader.close();
		}
	});

});

describe("the /wb repair command", () => {
	/**
	 * The command surface must reach the same repair path as the module, not a second
	 * implementation: a human typing `/wb repair <task>` is the ordinary recovery
	 * entry, and it must neither prompt WorkBuddy nor invent an outcome.
	 */
	it("repairs a failed round through the registered command without sending a prompt", async () => {
		const root = await queuedRound();
		recordUncommittableResult(root, "completed");

		const host = commandHost(root, owner().sessionId);
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(host.counters.connects).toBe(0);

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(queue.inspect({ taskId: TASK }).tasks[0]!["commit_state"]).toBe("committed");
		} finally {
			queue.close();
		}
	});

	it("repairs an orphaned round from a different session only after human operator confirmation", async () => {
		const { root, originalOwner: deadOwner } = await orphanedRound();
		const before = recoveryRound(root);
		const recordedOutcome = String(before["outcome_json"]);
		const manifestSha256 = String(before["manifest_sha256"]);
		expect(JSON.parse(recordedOutcome).status).toBe("interrupted");

		const host = commandHost(root, "omp-operator", async () => true);
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);

		const queue = openProjectQueue(root, { mode: "read" })!;
		try {
			const row = queue.inspect({ taskId: TASK }).tasks[0]!;
			expect(row["commit_state"]).toBe("committed");
			expect(row["status"]).toBe("interrupted");
			expect(row["outcome_json"]).toBe(recordedOutcome);
			expect(row["owner_session"]).toBe(deadOwner.sessionId);
			expect(row["owner_generation"]).toBe(deadOwner.generation);
			expect(row["executor_instance"]).toBe(deadOwner.instanceId);
			expect(row["manifest_sha256"]).toBe(manifestSha256);
			const audit: RecoveryAudit = JSON.parse(String(row["receipt_recovery_json"]));
			expect(audit.operator.sessionId).toBe("omp-operator");
			expect(audit.originalOwner).toEqual(deadOwner);
			expect(audit.deathProof.processId).toBe(deadOwner.processId);
			expect(audit.deathProof.pidGone).toBeTrue();
			// A local receipt cannot prove that the remote execution stopped.
			expect(row["phase"]).toBe("recovery_required");
			expect(row["dispatch_state"]).toBe("possibly_sent");
			expect(queue.holds()).toEqual([{ sessionId: WB, taskId: TASK, round: 1, kind: "quarantine" }]);
		} finally {
			queue.close();
		}

		const paths = resolveRoundPaths(root, TASK, 1, "round");
		const receipt = parseRoundReceiptJson(await readFile(paths.receiptPath, "utf-8"), paths.receiptPath);
		expect(receipt.rounds[0]!.status).toBe("interrupted");
		expect(receipt.rounds[0]!.owner).toEqual(deadOwner);
		expect(host.counters.connects).toBe(0);
		expect(host.dialogs.some((dialog) => dialog.kind === "confirm")).toBeTrue();
		expect(host.dialogs.some((dialog) => `${dialog.title}\n${dialog.text}`.includes(TASK))).toBeTrue();

		const repairedReceiptSha256 = recoveryRound(root)["receipt_sha256"];
		const releaseHost = commandHost(root, "omp-release-operator");
		await releaseHost.commands.get("wb")!.handler(`release ${TASK}`, releaseHost.ctx);
		const released = recoveryRound(root);
		expect(released["commit_state"]).toBe("committed");
		expect(released["dispatch_state"]).toBe("ended");
		expect(released["outcome_json"]).toBe(recordedOutcome);
		expect(released["owner_session"]).toBe(deadOwner.sessionId);
		expect(released["receipt_sha256"]).toBe(repairedReceiptSha256);
		const releaseAudit = JSON.parse(String(released["execution_end_json"]));
		expect(releaseAudit.operator.sessionId).toBe("omp-release-operator");
		expect(releaseAudit.originalOwner).toEqual(deadOwner);
		expect(releaseAudit.subject.receiptSha256).toBe(repairedReceiptSha256);
		const reader = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(reader.holds()).toEqual([]);
		} finally {
			reader.close();
		}
		expect(releaseHost.counters.connects).toBe(0);
		expect(releaseHost.dialogs.some((dialog) => dialog.kind === "input")).toBeTrue();
		expect(releaseHost.dialogs.some((dialog) => dialog.kind === "confirm")).toBeTrue();
	});

	it("keeps an orphan quarantined when its operator declines recovery", async () => {
		const { root } = await orphanedRound();
		const host = commandHost(root, "omp-operator", async () => false);
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(host.dialogs.some((dialog) => dialog.kind === "confirm")).toBeTrue();
		await expectRecoveryRefused(root);
		expect(host.counters.connects).toBe(0);
	});

	it("cannot grant operator recovery without an interactive human", async () => {
		const { root } = await orphanedRound();
		const host = commandHost(root, "omp-operator", undefined, { hasUI: false });
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(host.dialogs).toEqual([]);
		await expectRecoveryRefused(root);
	});

	it("does not treat an inactive registration as proof that its process died", async () => {
		const root = await queuedRound({ armed: true });
		const queue = openProjectQueue(root, { mode: "write" })!;
		try {
			queue.retireOwner(owner());
			queue.reconcileAbandonedRounds({ now: Date.now() });
		} finally {
			queue.close();
		}
		const host = commandHost(root, "omp-operator");
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(host.dialogs).toEqual([]);
		await expectRecoveryRefused(root);
	});

	for (const transition of ["switch", "shutdown"] as const) {
		it(`refuses an approval returned after the operator session's ${transition}`, async () => {
			const { root } = await orphanedRound();
			const shown = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<boolean>();
			const host = commandHost(root, "omp-operator", async () => {
				shown.resolve();
				return answer.promise;
			});
			const repair = host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
			await shown.promise;
			if (transition === "switch") {
				await host.switchSession("omp-another-conversation");
			} else {
				await host.shutdown();
			}
			answer.resolve(true);
			await repair;
			await expectRecoveryRefused(root);
			expect(host.counters.connects).toBe(0);
		});
	}

	it("allows a fresh recovery in the conversation entered after a session switch", async () => {
		const { root } = await orphanedRound();
		const host = commandHost(root, "omp-before-switch");
		await host.switchSession("omp-after-switch");
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		const row = recoveryRound(root);
		expect(row["commit_state"]).toBe("committed");
		const audit: RecoveryAudit = JSON.parse(String(row["receipt_recovery_json"]));
		expect(audit.operator.sessionId).toBe("omp-after-switch");
		expect(row["dispatch_state"]).toBe("possibly_sent");
		expect(host.counters.connects).toBe(0);
	});

	it("refuses consent if a live successor resumes the original OMP session", async () => {
		const { root, originalOwner } = await orphanedRound();
		const host = commandHost(root, "omp-operator", async () => {
			const queue = openProjectQueue(root, { mode: "write" })!;
			try {
				queue.registerOwner({
					...originalOwner, generation: "successor-generation",
					instanceId: "successor-instance", processId: process.pid,
				}, Date.now());
			} finally {
				queue.close();
			}
			return true;
		});
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		await expectRecoveryRefused(root);
	});

	it("cannot release a quarantined round before its receipt is committed", async () => {
		const { root } = await orphanedRound();
		const host = commandHost(root, "omp-operator");
		await host.commands.get("wb")!.handler(`release ${TASK}`, host.ctx);
		await expectRecoveryRefused(root);
		expect(host.counters.connects).toBe(0);
	});

	it("does not carry repair consent over to quarantine release", async () => {
		const { root } = await orphanedRound();
		let confirmations = 0;
		const host = commandHost(root, "omp-operator", async () => ++confirmations === 1);
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(recoveryRound(root)["commit_state"]).toBe("committed");
		await host.commands.get("wb")!.handler(`release ${TASK}`, host.ctx);
		expect(confirmations).toBe(2);
		expect(recoveryRound(root)["dispatch_state"]).toBe("possibly_sent");
		const reader = openProjectQueue(root, { mode: "read" })!;
		try {
			expect(reader.holds()).toEqual([{ sessionId: WB, taskId: TASK, round: 1, kind: "quarantine" }]);
		} finally {
			reader.close();
		}
	});

	it("requires a separate end observation even after repair was approved", async () => {
		const { root } = await orphanedRound();
		const host = commandHost(root, "omp-operator", undefined, { input: async () => undefined });
		await host.commands.get("wb")!.handler(`repair ${TASK}`, host.ctx);
		expect(recoveryRound(root)["commit_state"]).toBe("committed");
		const confirmations = host.dialogs.filter((dialog) => dialog.kind === "confirm").length;
		await host.commands.get("wb")!.handler(`release ${TASK}`, host.ctx);
		expect(host.dialogs.filter((dialog) => dialog.kind === "confirm").length).toBe(confirmations);
		expect(recoveryRound(root)["dispatch_state"]).toBe("possibly_sent");
	});

	it("does not overwrite another operator's committed recovery after a stale dialog", async () => {
		const { root } = await orphanedRound();
		const shown = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<boolean>();
		const first = commandHost(root, "omp-first-operator", async () => {
			shown.resolve();
			return answer.promise;
		});
		const pending = first.commands.get("wb")!.handler(`repair ${TASK}`, first.ctx);
		await shown.promise;
		const second = commandHost(root, "omp-second-operator");
		await second.commands.get("wb")!.handler(`repair ${TASK}`, second.ctx);
		const committed = recoveryRound(root);
		expect(committed["commit_state"]).toBe("committed");
		const audit: RecoveryAudit = JSON.parse(String(committed["receipt_recovery_json"]));
		expect(audit.operator.sessionId).toBe("omp-second-operator");
		answer.resolve(true);
		await pending;
		const after = recoveryRound(root);
		expect(after["receipt_sha256"]).toBe(committed["receipt_sha256"]);
		expect(after["receipt_recovery_json"]).toBe(committed["receipt_recovery_json"]);
	});
});

/**
 * The host surface the `/wb` command runs against.
 *
 * The command is dispatched through the real registered handler with a fake
 * user context, so the recovery under test is the one a human actually
 * reaches. The activation is shut down through the shared teardown, so the
 * project's files are never removed while a background write is still in
 * flight.
 */
function commandHost(
	root: string,
	sessionId: string,
	confirm: (title: string, message: string) => Promise<boolean> = async () => true,
	options: { hasUI?: boolean; input?: () => Promise<string | undefined> } = {},
): {
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	notices: string[];
	counters: { connects: number };
	dialogs: Array<{ kind: "select" | "input" | "confirm"; title: string; text: string }>;
	sent: Array<{
		customType: unknown; content: unknown; display: unknown;
		options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
	}>;
	ctx: ExtensionCommandContext;
	switchSession: (sessionId: string) => Promise<void>;
	shutdown: () => Promise<void>;
} {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const notices: string[] = [];
	const counters = { connects: 0 };
	const dialogs: Array<{ kind: "select" | "input" | "confirm"; title: string; text: string }> = [];
	const sent: Array<{
		customType: unknown; content: unknown; display: unknown;
		options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
	}> = [];
	const lifecycle = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
	let currentSessionId = sessionId;
	let stopped = false;
	const shutdown = async () => {
		if (stopped) return;
		stopped = true;
		await lifecycle.get("session_shutdown")?.({}, ctx);
	};
	activations.push(shutdown);
	const api = {
		zod: {
			string: () => chain(), number: () => chain(), boolean: () => chain(), array: () => chain(),
			enum: () => chain(), object: () => chain(),
		},
		logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => {
			lifecycle.set(event, handler);
		},
		registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, spec);
		},
		registerTool: () => undefined,
		sendMessage: (message: Record<string, unknown>, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
			sent.push({
				customType: message["customType"], content: message["content"],
				display: message["display"], options,
			});
		},
	} as unknown as ExtensionAPI;
	activate(api, {
		foregroundWaitMs: 0,
		workbuddyHomeDir: path.join(root, ".test-home"),
		discover: async () => [],
		connect: async () => {
			counters.connects += 1;
			throw new Error("Receipt recovery must not connect to WorkBuddy");
		},
	});
	const ctx = {
		cwd: root,
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionId: () => currentSessionId },
		ui: {
			notify: (message: string) => { notices.push(message); },
			select: async (title: string, choices: unknown[]) => {
				const labels = choices.map((choice) =>
					typeof choice === "string" ? choice : String((choice as { label?: unknown } | null)?.label ?? choice),
				);
				dialogs.push({ kind: "select", title, text: labels.join("\n") });
				return labels[0];
			},
			input: async (title: string) => {
				dialogs.push({ kind: "input", title, text: "" });
				return options.input === undefined ? "Observed the isolated fixture turn has ended" : options.input();
			},
			confirm: async (title: string, text: string) => {
				dialogs.push({ kind: "confirm", title, text });
				return confirm(title, text);
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		commands, notices, counters, dialogs, sent, ctx, shutdown,
		switchSession: async (nextSessionId) => {
			currentSessionId = nextSessionId;
			await lifecycle.get("session_switch")?.({}, ctx);
		},
	};
}

/** A minimal zod chain: these tests drive handlers, not schema validation. */
function chain(): Record<string, () => unknown> {
	const self: Record<string, () => unknown> = {};
	for (const name of ["describe", "optional", "strict", "default", "min", "max", "nonnegative"]) {
		self[name] = () => self;
	}
	return self;
}
