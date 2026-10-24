/**
 * Session pool: the binding roster it owns, and an identity resolver that
 * refuses to guess.
 *
 * The pool no longer selects a target: allocation belongs to the queue alone.
 * What is tested here is the roster itself — how a legacy binding is
 * normalized, how verified candidates are partitioned against a project, how
 * the canonical v2 record is merged, and how one member's connection identity
 * is recovered.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";

import {
	bindingForSession,
	listBoundSessions,
	parseWorkerRecord,
	partitionProjectCandidates,
	readProjectSessionCatalog,
	readWorkerRecord,
	reconcileProjectBinding,
	resolveWorkBuddyCaller,
	workBuddySessionsDir,
	listWorkerPids,
} from "../src/session-pool";
import {
	openProjectQueue,
	openWriteConnection,
	registerOwner,
	withImmediate,
	writeMeta,
	type ApprovedEnqueue,
} from "../src/queue";
import {
	buildConfirmationDigest,
	computeFileSha256,
	stageTask,
} from "../src/tasks";
import {
	WB_ERROR_CODE,
	WbTaskError,
	type Binding,
	type DesktopCandidate,
	type OwnerIdentity,
	type RoundConfirmationV3,
	type TaskRequest,
} from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop()!;
		await releaseProjectFixture(root).catch(() => undefined);
	}
});

async function fixture(prefix = "wb-pool-"): Promise<string> {
	const root = await createFixtureRoot(prefix);
	roots.push(root);
	return root;
}

/** One verified candidate as discovery reports it. */
function candidate(
	sessionId: string,
	projectRoot: string,
	version = "5.8.2",
): DesktopCandidate {
	return {
		endpoint: `http://127.0.0.1:${1000 + Math.floor(Math.random() * 8000)}`,
		binding: { version: 1, projectRoot, sessionId, workbuddyVersion: version },
		busy: false,
	};
}

/** A legacy v1 binding: one session, no roster, no consent flag. */
function legacyBinding(projectRoot: string, sessionId = "aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee"): Binding {
	return {
		version: 1,
		projectRoot,
		sessionId,
		workbuddyVersion: "5.8.2",
	};
}

// ---------------------------------------------------------------------------
// The queue seam the roster's verification flag has to survive.
//
// The queue is the only authority that decides which session may take work, so
// a member the roster marks as unverified must arrive there as unverified.
// The observation is taken straight from the normalized roster — no rule is
// re-derived here — so a roster that dropped the flag would show up as a
// claimable session instead of a refused one.
// ---------------------------------------------------------------------------

const UNPROVEN = "11111111-1111-4111-8111-111111111111";
const PROVEN = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";

function owner(): OwnerIdentity {
	return {
		sessionId: "omp-session-1",
		generation: "gen-1",
		processId: process.pid,
		instanceId: "instance-1",
	};
}

function request(): TaskRequest {
	return {
		goal: {
			objective: "run the pool's work",
			context: "",
			constraints: [],
			acceptance: ["the work ran"],
			externalActions: [],
		},
		inputFiles: ["input.txt"],
		expectedOutputs: ["result.txt"],
	};
}

/** Enables the project so the queue accepts an enqueue. */
function enable(root: string): void {
	const db = openWriteConnection(root);
	withImmediate(db, () => {
		registerOwner(db, owner(), Date.now());
		writeMeta(db, "project_enabled_at", new Date().toISOString());
	});
}

/**
 * Freezes one pool-targeted round through the production staging path and
 * returns the enqueue input for it.
 */
async function stagePoolRound(root: string): Promise<ApprovedEnqueue> {
	const inputRel = "input.txt";
	const sourcePath = path.join(root, inputRel);
	const content = "frozen bytes\n";
	await writeFile(sourcePath, content, "utf-8");
	const sha = await computeFileSha256(sourcePath);
	const targetPolicy = { kind: "workspace_pool" as const, role: null };
	const manifestSha256 = buildConfirmationDigest({
		projectRoot: root,
		requestId: REQUEST,
		taskId: TASK,
		round: 1,
		owner: owner(),
		goal: request().goal,
		targetPolicy,
		expectedOutputs: ["result.txt"],
		inputs: [{ path: inputRel, sha256: sha, bytes: Buffer.byteLength(content) }],
		deliveryMode: "foreground",
	});
	const confirmation: RoundConfirmationV3 = {
		source: "host_dialog",
		at: new Date().toISOString(),
		targetPolicy,
		requestId: REQUEST,
		manifestSha256,
		owner: owner(),
		previousRound: 0,
		inputs: [{ path: inputRel, sha256: sha }],
		deliveryMode: "foreground",
	};
	const staged = await stageTask(root, confirmation, request(), TASK, 1);
	return {
		taskId: TASK,
		round: 1,
		requestId: REQUEST,
		manifestSha256: staged.manifestSha256,
		manifestPath: staged.manifestPath,
		snapshotRoot: staged.snapshotRoot,
		expectedPreviousRound: null,
		readPaths: [inputRel],
		writePaths: [`.wb-bridge/tasks/${TASK}/rounds/1/outputs`],
		targetPolicy,
		ownerSession: owner().sessionId,
		ownerGeneration: owner().generation,
		executorInstanceId: owner().instanceId,
		approval: { source: "host_dialog", at: confirmation.at, payloadSha256: staged.manifestSha256 },
		title: `Task ${TASK.slice(0, 4)}`,
		deliveryMode: "foreground",
	};
}

/**
 * Feeds the roster's own verification state into the queue, queues the pool's
 * work and claims it.
 */
async function claimedSessionFor(root: string, binding: Binding): Promise<string | null> {
	const observations = listBoundSessions(binding).map((member) => ({
		sessionId: member.sessionId,
		workbuddyVersion: member.workbuddyVersion ?? binding.workbuddyVersion ?? "5.8.2",
		availability: "idle" as const,
		// The roster's own flag, passed through unchanged: the queue, not the
		// test, decides what an unverified member may do.
		verified: member.verified,
	}));
	const input = await stagePoolRound(root);
	const queue = openProjectQueue(root, { mode: "write" })!;
	try {
		queue.syncProjectSessions(observations, Date.now());
		queue.enqueue(input);
		const claim = queue.claim(owner(), Date.now());
		return claim.kind === "claimed" ? claim.sessionId : null;
	} finally {
		queue.close();
	}
}

describe("legacy roster normalization", () => {
	it("treats a legacy binding's single session as the whole roster", () => {
		const binding = legacyBinding("/project");
		expect(listBoundSessions(binding)).toEqual([
			{ sessionId: binding.sessionId, workbuddyVersion: "5.8.2" },
		]);
	});

	it("deduplicates a roster by session id, keeping the first occurrence", () => {
		const binding: Binding = {
			version: 2,
			projectRoot: "/project",
			sessionId: "primary",
			workbuddyVersion: "5.8.2",
			sessions: [
				{ sessionId: "aaa", role: "default", title: "First" },
				{ sessionId: "bbb" },
				{ sessionId: "aaa", role: "other", title: "Second" },
			],
		};
		const members = listBoundSessions(binding);
		expect(members.map((member) => member.sessionId)).toEqual(["aaa", "bbb"]);
		// The later duplicate must not overwrite the user's own annotations, and
		// the member still carries a version for the queue's observations.
		expect(members[0]).toEqual({
			sessionId: "aaa",
			role: "default",
			title: "First",
			workbuddyVersion: "5.8.2",
		});
	});

	it("never mutates the binding it was given", () => {
		const binding: Binding = {
			version: 2,
			projectRoot: "/project",
			sessionId: "primary",
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: "aaa" }],
		};
		const before = JSON.stringify(binding);
		listBoundSessions(binding);
		expect(JSON.stringify(binding)).toBe(before);
	});
});

/**
 * The boundary the roster's verification flag really has to survive.
 *
 * The queue is the only authority that decides which session may take work, so
 * a member the roster marks as unverified must arrive there as unverified.
 * The observation is taken straight from the normalized roster — no rule is
 * re-derived here — so a roster that dropped the flag would show up as a
 * claimable session instead of a refused one.
 */
describe("an unverified member never receives the pool's work", () => {
	it("refuses the unproven member and runs the work on the proven one", async () => {
		const root = await fixture("wb-pool-queue-");
		enable(root);
		const binding: Binding = {
			version: 2,
			projectRoot: root,
			sessionId: PROVEN,
			workbuddyVersion: "5.8.2",
			sessions: [
				// The unproven session sorts first, so a claim that lands on it
				// cannot be an accident of the selection order.
				{ sessionId: UNPROVEN, verified: false },
				{ sessionId: PROVEN, verified: true },
			],
			autoBindProjectSessions: true,
		};

		const claimed = await claimedSessionFor(root, binding);

		expect(claimed).toBe(PROVEN);
	});

	it("refuses the unproven member outright when it is the only one", async () => {
		const root = await fixture("wb-pool-queue-only-");
		enable(root);
		const binding: Binding = {
			version: 2,
			projectRoot: root,
			sessionId: UNPROVEN,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: UNPROVEN, verified: false }],
			autoBindProjectSessions: true,
		};

		// Nothing may be claimed: the only member of the pool is not proven to
		// be there, so the work waits instead of landing on it.
		const claimed = await claimedSessionFor(root, binding);

		expect(claimed).toBeNull();
	});

	it("does not let a later duplicate promote an unproven member", async () => {
		const root = await fixture("wb-pool-queue-dup-");
		enable(root);
		const binding: Binding = {
			version: 2,
			projectRoot: root,
			sessionId: PROVEN,
			workbuddyVersion: "5.8.2",
			sessions: [
				// The roster lists the session twice: the first occurrence says
				// unproven, the second claims it is proven. The first wins.
				{ sessionId: UNPROVEN, verified: false },
				{ sessionId: UNPROVEN, verified: true },
				{ sessionId: PROVEN, verified: true },
			],
			autoBindProjectSessions: true,
		};

		const claimed = await claimedSessionFor(root, binding);

		expect(claimed).toBe(PROVEN);
	});
});

describe("candidate partitioning by project ownership", () => {
	it("accepts the exact project and a legitimate descendant directory", async () => {
		const projectRoot = await fixture("wb-part-project-");
		const subdirectory = path.join(projectRoot, "src", "feature");
		await mkdir(subdirectory, { recursive: true });
		const binding = legacyBinding(projectRoot);

		const { eligible, excluded } = await partitionProjectCandidates(binding, [
			candidate("11111111-1111-4111-8111-111111111111", projectRoot),
			candidate("22222222-2222-4222-8222-222222222222", subdirectory),
		]);

		expect(eligible.map((entry) => entry.binding.sessionId)).toEqual([
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		]);
		expect(excluded).toEqual([]);
	});

	it("refuses a foreign project and a project that merely contains this one", async () => {
		const outer = await fixture("wb-part-outer-");
		const projectRoot = path.join(outer, "inner");
		await mkdir(projectRoot, { recursive: true });
		const foreign = await fixture("wb-part-foreign-");
		const binding = legacyBinding(projectRoot);

		const { eligible, excluded } = await partitionProjectCandidates(binding, [
			candidate("33333333-3333-4333-8333-333333333333", foreign),
			candidate("44444444-4444-4444-8444-444444444444", outer),
		]);

		expect(eligible).toEqual([]);
		expect(excluded.map((entry) => entry.reason).sort()).toEqual(["foreign_project", "nested_project_root"]);
	});

	it("refuses a session that only reaches the project through a symlink", async () => {
		const projectRoot = await fixture("wb-part-project-");
		const foreign = await fixture("wb-part-foreign-");
		const link = path.join(projectRoot, "link-to-foreign");
		try {
			await symlink(foreign, link, "dir");
		} catch {
			return; // Symlinks are unavailable on this platform; nothing to prove.
		}
		const binding = legacyBinding(projectRoot);

		const { eligible, excluded } = await partitionProjectCandidates(binding, [
			candidate("55555555-5555-4555-8555-555555555555", link),
		]);

		expect(eligible).toEqual([]);
		expect(excluded[0]?.reason).toBe("foreign_project");
	});

	it("deduplicates one session reported by several workers", async () => {
		const projectRoot = await fixture("wb-part-project-");
		const binding = legacyBinding(projectRoot);
		const sessionId = "66666666-6666-4666-8666-666666666666";

		const { eligible } = await partitionProjectCandidates(binding, [
			candidate(sessionId, projectRoot),
			candidate(sessionId, projectRoot),
		]);

		expect(eligible).toHaveLength(1);
	});

	it("fails closed when the bound project root does not exist", async () => {
		const binding = legacyBinding(path.join(await fixture("wb-part-gone-"), "missing"));
		let caught: unknown = null;
		try {
			await partitionProjectCandidates(binding, []);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}
	});
});

describe("canonical v2 reconciliation", () => {
	it("migrates a legacy binding into a canonical v2 roster with the project consent", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const binding = legacyBinding(projectRoot);
		const newSession = "77777777-7777-4777-8777-777777777777";

		const merged = await reconcileProjectBinding(binding, [candidate(newSession, projectRoot)]);

		expect(merged.version).toBe(2);
		expect(merged.projectRoot).toBe(await realpath(projectRoot));
		expect(merged.autoBindProjectSessions).toBe(true);
		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([binding.sessionId, newSession]);
		// The roster keeps the version each member was observed with.
		expect(merged.sessions?.[0]?.workbuddyVersion).toBe("5.8.2");
		expect(merged.sessions?.[1]?.workbuddyVersion).toBe("5.8.2");
		// Only the session a live worker was proven to own may be handed work.
		expect(merged.sessions?.map((member) => member.verified)).toEqual([false, true]);
	});

	it("keeps an offline member and the project consent across a restart", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const offline = "88888888-8888-4888-8888-888888888888";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId: offline,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: offline, role: "default", workbuddyVersion: "5.8.2" }],
			autoBindProjectSessions: true,
		};

		// No candidate at all: the desktop application is closed.
		const merged = await reconcileProjectBinding(binding, []);

		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([offline]);
		expect(merged.sessions?.[0]).toEqual({
			sessionId: offline,
			role: "default",
			workbuddyVersion: "5.8.2",
			verified: false,
		});
		expect(merged.autoBindProjectSessions).toBe(true);
	});

	it("drops a member whose ownership was disproved, but only that member", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const foreign = await fixture("wb-rec-foreign-");
		const good = "99999999-9999-4999-8999-999999999999";
		const moved = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId: good,
			workbuddyVersion: "5.8.2",
			sessions: [
				{ sessionId: good, workbuddyVersion: "5.8.2" },
				{ sessionId: moved, workbuddyVersion: "5.8.2" },
			],
			autoBindProjectSessions: true,
		};

		const merged = await reconcileProjectBinding(binding, [candidate(moved, foreign)]);

		// The disproved session is not presented as eligible any more.
		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([good]);
	});

	it("repoints the primary identity when that session was disproved", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const foreign = await fixture("wb-rec-foreign-");
		const good = "99999999-9999-4999-8999-999999999999";
		const moved = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId: moved,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: moved, workbuddyVersion: "5.8.2" }],
			autoBindProjectSessions: true,
		};

		const merged = await reconcileProjectBinding(binding, [
			candidate(moved, foreign),
			candidate(good, projectRoot),
		]);

		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([good]);
		// The record must not keep naming a session that serves another project.
		expect(merged.sessionId).toBe(good);
	});

	it("refreshes the observed version of a member it already knows", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId, role: "default", workbuddyVersion: "5.8.2" }],
		};

		const merged = await reconcileProjectBinding(binding, [candidate(sessionId, projectRoot, "9.9.9")]);

		expect(merged.sessions).toEqual([
			{ sessionId, role: "default", workbuddyVersion: "9.9.9", verified: true },
		]);
	});

	it("keeps a foreign candidate out of the roster without failing the refresh", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const foreign = await fixture("wb-rec-foreign-");
		const binding = legacyBinding(projectRoot);

		const merged = await reconcileProjectBinding(binding, [
			candidate("cccccccc-dddd-4eee-8fff-000000000000", foreign),
		]);

		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([binding.sessionId]);
		expect(merged.autoBindProjectSessions).toBe(true);
	});

	it("never persists an endpoint or a token", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const binding = legacyBinding(projectRoot);
		const merged = await reconcileProjectBinding(binding, [candidate("dddddddd-eeee-4fff-8000-111111111111", projectRoot)]);
		const serialized = JSON.stringify(merged);
		expect(serialized).not.toContain("http://");
		expect(serialized).not.toContain("token");
	});

	it("never re-admits a session two candidates disagree about, in either order", async () => {
		// Two workers claim the same UUID for different projects: one says it
		// belongs here, the other says it belongs elsewhere. The session is
		// therefore unproven, and it must not end up in the roster as a
		// verified member — whichever candidate happens to be seen first.
		const projectRoot = await fixture("wb-rec-project-");
		const foreign = await fixture("wb-rec-foreign-");
		const disputed = "eeeeeeee-ffff-4000-8000-111111111111";
		const good = "eeeeeeee-ffff-4000-8000-222222222222";
		const binding = legacyBinding(projectRoot, "primary");

		const here = candidate(disputed, projectRoot);
		const there = candidate(disputed, foreign);
		const proven = candidate(good, projectRoot);

		const first = await reconcileProjectBinding(binding, [here, there, proven]);
		const second = await reconcileProjectBinding(binding, [there, here, proven]);

		for (const merged of [first, second]) {
			expect(merged.sessions?.map((member) => member.sessionId)).not.toContain(disputed);
		}
		// The order of the reports must not change the outcome.
		expect(first.sessions?.map((member) => member.sessionId)).toEqual(
			second.sessions?.map((member) => member.sessionId),
		);
	});

	it("never hands the pool's work to a session two candidates disagree about", async () => {
		// The roster is only half the story: what matters is that the queue
		// never offers the disputed session to a task.
		const projectRoot = await fixture("wb-rec-queue-project-");
		const foreign = await fixture("wb-rec-queue-foreign-");
		const disputed = "ffffffff-0000-4000-8000-333333333333";
		const good = "ffffffff-0000-4000-8000-444444444444";
		const binding = legacyBinding(projectRoot, "primary");

		const merged = await reconcileProjectBinding(binding, [
			candidate(disputed, projectRoot),
			candidate(disputed, foreign),
			candidate(good, projectRoot),
		]);

		enable(projectRoot);
		const claimed = await claimedSessionFor(projectRoot, merged);

		// The work runs on the session that was actually proven, never on the
		// one two workers contradicted.
		expect(claimed).toBe(good);
	});

	it("keeps a disputed session out of the roster even when it was enrolled before", async () => {
		const projectRoot = await fixture("wb-rec-project-");
		const foreign = await fixture("wb-rec-foreign-");
		const disputed = "ffffffff-0000-4000-8000-222222222222";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId: disputed,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: disputed, workbuddyVersion: "5.8.2" }],
			autoBindProjectSessions: true,
		};

		const merged = await reconcileProjectBinding(binding, [
			candidate(disputed, projectRoot),
			candidate(disputed, foreign),
		]);

		expect(merged.sessions?.map((member) => member.sessionId)).not.toContain(disputed);
	});

	it("never hands the pool's work to a session that was enrolled before it was contradicted", async () => {
		const projectRoot = await fixture("wb-rec-queue-pre-");
		const foreign = await fixture("wb-rec-queue-pre-foreign-");
		const disputed = "ffffffff-0000-4000-8000-555555555555";
		const binding: Binding = {
			version: 2,
			projectRoot,
			sessionId: disputed,
			workbuddyVersion: "5.8.2",
			sessions: [{ sessionId: disputed, workbuddyVersion: "5.8.2" }],
			autoBindProjectSessions: true,
		};

		const merged = await reconcileProjectBinding(binding, [
			candidate(disputed, projectRoot),
			candidate(disputed, foreign),
		]);

		enable(projectRoot);
		const claimed = await claimedSessionFor(projectRoot, merged);

		// Nothing may be claimed: the only member of the pool was disproved.
		expect(claimed).toBeNull();
	});
});

describe("member connection identity", () => {
	it("returns the concrete identity of an enrolled member", () => {
		const binding: Binding = {
			version: 2,
			projectRoot: "/project",
			sessionId: "primary",
			workbuddyVersion: "5.8.2",
			sessions: [
				{ sessionId: "primary", workbuddyVersion: "5.8.2" },
				{ sessionId: "other", workbuddyVersion: "9.9.9" },
			],
			autoBindProjectSessions: true,
		};

		const resolved = bindingForSession(binding, "other");
		expect(resolved.sessionId).toBe("other");
		// The member's own version, not the binding's default one.
		expect(resolved.workbuddyVersion).toBe("9.9.9");
		expect(resolved.autoBindProjectSessions).toBe(true);
	});

	it("refuses a session the project never enrolled", () => {
		const binding = legacyBinding("/project");
		let caught: unknown = null;
		try {
			bindingForSession(binding, "11111111-2222-4333-8444-555555555555");
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught instanceof WbTaskError).toBe(true);
		if (caught instanceof WbTaskError) {
			expect(caught.code).toBe(WB_ERROR_CODE.bindingInvalid);
		}
	});
});

describe("native session catalog", () => {
	const SEED = "aaaaaaaa-0000-4000-8000-000000000001";

	/** Builds a catalog database with the desktop application's own shape. */
	async function catalogFixture(
		rows: Array<{
			id: string;
			cwd: string;
			status?: string;
			deleted_at?: number | null;
			is_background_automation?: number | null;
			transport?: string;
			user_id?: string | null;
		}>,
	): Promise<string> {
		const home = await fixture("wb-catalog-");
		const db = new Database(path.join(home, "workbuddy.db"), { create: true });
		db.run(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			cwd TEXT NOT NULL,
			user_id TEXT NOT NULL,
			title TEXT,
			status TEXT NOT NULL DEFAULT 'Pending',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			deleted_at INTEGER,
			is_background_automation INTEGER,
			transport TEXT NOT NULL DEFAULT 'local',
			session_settings TEXT
		)`);
		const insert = db.prepare(
			`INSERT INTO sessions (id, cwd, user_id, status, created_at, updated_at, deleted_at, is_background_automation, transport, session_settings)
			 VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
		);
		for (const row of rows) {
			insert.run(
				row.id,
				row.cwd,
				row.user_id ?? "u",
				row.status ?? "completed",
				row.deleted_at ?? null,
				row.is_background_automation ?? null,
				row.transport ?? "local",
				null,
			);
		}
		db.close();
		return home;
	}

	it("lists the project's own sessions and refuses the other projects'", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const foreign = await fixture("wb-catalog-foreign-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot },
			{ id: "22222222-2222-4222-8222-222222222222", cwd: foreign },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.failure).toBeNull();
		expect(catalog.sessions.map((entry) => entry.sessionId)).toEqual([SEED]);
	});

	it("never lists another account's sessions", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, user_id: "account-one" },
			{ id: "33333333-3333-4333-8333-333333333333", cwd: projectRoot, user_id: "account-two" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions.map((entry) => entry.sessionId)).toEqual([SEED]);
	});

	it("refuses to broaden the scope when the seed is unknown", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, user_id: "account-one" },
			{ id: "44444444-4444-4444-8444-444444444444", cwd: projectRoot, user_id: "account-two" },
		]);

		const missingSeed = await readProjectSessionCatalog(projectRoot, home, "99999999-9999-4999-8999-999999999999");
		expect(missingSeed.sessions).toEqual([]);
		expect(missingSeed.failure).toBe("catalog_seed_unknown");

		const noSeed = await readProjectSessionCatalog(projectRoot, home, null);
		expect(noSeed.sessions).toEqual([]);
		expect(noSeed.failure).toBe("catalog_seed_unknown");
	});

	it("reports an unknown seed as a seed problem, not an unexpected schema", async () => {
		// A seed the catalog does not know leaves the account scope unknown.
		// That is not a broken catalog: reporting it as a schema failure would
		// tell the user their installation is damaged, and would hide the real
		// cause behind a wrong reason.
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, user_id: "account-one" },
			{ id: "44444444-4444-4444-8444-444444444444", cwd: projectRoot, user_id: "account-one" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, "unknown-seed-session");

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_seed_unknown");
		expect(catalog.failure).not.toBe("catalog_schema_unexpected");
		expect(catalog.detail).toContain("unknown-seed-session");
	});

	it("leaks no session when the seed is unknown, not even the legacy ones", async () => {
		// The account scope cannot be established, so nothing may be listed —
		// in particular not the rows that carry no account at all.
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await fixture("wb-catalog-legacy-");
		const db = new Database(path.join(home, "workbuddy.db"), { create: true });
		db.run(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			cwd TEXT NOT NULL,
			user_id TEXT,
			title TEXT,
			status TEXT NOT NULL DEFAULT 'Pending',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			deleted_at INTEGER,
			is_background_automation INTEGER,
			transport TEXT NOT NULL DEFAULT 'local',
			session_settings TEXT
		)`);
		const insert = db.prepare(
			`INSERT INTO sessions (id, cwd, user_id, status, created_at, updated_at, deleted_at, is_background_automation, transport, session_settings)
			 VALUES (?, ?, ?, ?, 1, 1, NULL, NULL, ?, NULL)`,
		);
		insert.run(SEED, projectRoot, "account-one", "completed", "local");
		// A legacy row that carries no account at all.
		insert.run("55555555-5555-4555-8555-555555555555", projectRoot, null, "completed", "local");
		db.close();

		const catalog = await readProjectSessionCatalog(projectRoot, home, "unknown-seed-session");

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_seed_unknown");
	});

	it("refuses a seed that belongs to another project", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const foreign = await fixture("wb-catalog-foreign-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, user_id: "account-one" },
			// A conversation of another project, but of the same account.
			{ id: "13131313-1313-4131-8131-131313131313", cwd: foreign, user_id: "account-one" },
		]);

		// The foreign conversation may not stand in for this project's account:
		// the scope would then be anchored on another project.
		const catalog = await readProjectSessionCatalog(projectRoot, home, "13131313-1313-4131-8131-131313131313");

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_seed_unknown");
		expect(catalog.detail).toContain("does not belong to this project");
	});

	it("refuses a seed whose project merely contains this one", async () => {
		const outer = await fixture("wb-catalog-outer-");
		const projectRoot = path.join(outer, "inner");
		await mkdir(projectRoot, { recursive: true });
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, user_id: "account-one" },
			{ id: "14141414-1414-4141-8141-141414141414", cwd: outer, user_id: "account-one" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, "14141414-1414-4141-8141-141414141414");

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_seed_unknown");
	});

	it("still enrolls the project when the seed was later deleted", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			// The seed is an account anchor, not an execution candidate: it may be
			// deleted, and the project's other sessions still belong to it.
			{ id: SEED, cwd: projectRoot, deleted_at: 1, user_id: "account-one" },
			{ id: "15151515-1515-4151-8151-151515151515", cwd: projectRoot, user_id: "account-one" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.failure).toBeNull();
		expect(catalog.sessions.map((entry) => entry.sessionId)).toEqual([
			"15151515-1515-4151-8151-151515151515",
		]);
	});

	it("skips deleted sessions, background automations and non-local transports", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot },
			{ id: "55555555-5555-4555-8555-555555555555", cwd: projectRoot, deleted_at: 1 },
			{ id: "66666666-6666-4666-8666-666666666666", cwd: projectRoot, is_background_automation: 1 },
			{ id: "77777777-7777-4777-8777-777777777777", cwd: projectRoot, transport: "remote" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions.map((entry) => entry.sessionId)).toEqual([SEED]);
	});

	it("enrolls a completed conversation: its status is not a filter", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot, status: "completed" },
			{ id: "88888888-8888-4888-8888-888888888888", cwd: projectRoot, status: "terminated" },
			{ id: "12121212-1212-4121-8121-121212121212", cwd: projectRoot, status: "Working" },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions.map((entry) => entry.sessionId)).toEqual([
			SEED,
			"88888888-8888-4888-8888-888888888888",
			"12121212-1212-4121-8121-121212121212",
		]);
	});

	it("accepts a session opened in a subdirectory of the project", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const subdirectory = path.join(projectRoot, "src");
		await mkdir(subdirectory, { recursive: true });
		const home = await catalogFixture([
			{ id: SEED, cwd: subdirectory },
		]);

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions).toHaveLength(1);
	});

	it("reports a missing catalog as an empty catalog, not a failure", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const empty = await fixture("wb-catalog-empty-");

		const catalog = await readProjectSessionCatalog(projectRoot, empty, SEED);

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_missing");
	});

	it("fails closed on an unexpected schema", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await fixture("wb-catalog-odd-");
		const db = new Database(path.join(home, "workbuddy.db"), { create: true });
		db.run("CREATE TABLE something_else (id TEXT)");
		db.close();

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_schema_unexpected");
		expect(catalog.detail).not.toBeNull();
	});

	it("fails closed when the sessions table lost a required column", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await fixture("wb-catalog-partial-");
		const db = new Database(path.join(home, "workbuddy.db"), { create: true });
		db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)");
		db.close();

		const catalog = await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(catalog.sessions).toEqual([]);
		expect(catalog.failure).toBe("catalog_schema_unexpected");
	});

	it("never writes to the catalog", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const home = await catalogFixture([
			{ id: SEED, cwd: projectRoot },
		]);
		const dbPath = path.join(home, "workbuddy.db");
		const before = statSync(dbPath).size;

		await readProjectSessionCatalog(projectRoot, home, SEED);

		expect(statSync(dbPath).size).toBe(before);
	});

	it("enrolls a catalog session as an unverified member", async () => {
		const projectRoot = await fixture("wb-catalog-project-");
		const binding = legacyBinding(projectRoot);
		const catalogSession = "99999999-9999-4999-8999-999999999999";

		const merged = await reconcileProjectBinding(
			binding,
			[],
			[{ sessionId: catalogSession, cwd: projectRoot, status: "completed" }],
		);

		expect(merged.sessions?.map((member) => member.sessionId)).toEqual([
			binding.sessionId,
			catalogSession,
		]);
		// The catalog knows the session belongs here, but nothing proves a live
		// worker owns it, so it must not be handed work.
		expect(merged.sessions?.[1]?.verified).toBe(false);
	});
});

describe("WorkBuddy caller identity", () => {
	const SESSION = "99999999-8888-4777-8666-555555555555";

	it("verifies a caller whose worker record agrees on pid, kind and directory", async () => {
		const sessionsDir = await fixture("wb-identity-");
		const projectRoot = await fixture("wb-identity-project-");
		await writeFile(
			path.join(sessionsDir, "4242.json"),
			JSON.stringify({ pid: 4242, sessionId: SESSION, kind: "interactive", version: "5.8.2", cwd: projectRoot }),
			"utf-8",
		);

		const identity = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: projectRoot,
			sessionsDir,
			isAlive: () => true,
		});
		expect(identity).toEqual({
			kind: "verified",
			workerPid: 4242,
			sessionId: SESSION,
			version: "5.8.2",
			cwd: await realpath(projectRoot),
		});
	});

	it("stays pending when the record belongs to another pid", async () => {
		const sessionsDir = await fixture("wb-identity-");
		await writeFile(
			path.join(sessionsDir, "4242.json"),
			JSON.stringify({ pid: 9999, sessionId: SESSION, kind: "interactive", cwd: "/x" }),
			"utf-8",
		);
		const identity = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: "/x",
			sessionsDir,
			isAlive: () => true,
		});
		expect(identity.kind).toBe("pending");
		if (identity.kind === "pending") {
			expect(identity.reason).toContain("belongs to pid 9999");
		}
	});

	it("stays pending when the worker is a non-interactive kind", async () => {
		const sessionsDir = await fixture("wb-identity-");
		const projectRoot = await fixture("wb-identity-project-");
		await writeFile(
			path.join(sessionsDir, "4242.json"),
			JSON.stringify({ pid: 4242, sessionId: SESSION, kind: "headless", cwd: projectRoot }),
			"utf-8",
		);
		const identity = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: projectRoot,
			sessionsDir,
			isAlive: () => true,
		});
		expect(identity.kind).toBe("pending");
	});

	it("stays pending when the directories disagree or no directory was injected", async () => {
		const sessionsDir = await fixture("wb-identity-");
		const projectRoot = await fixture("wb-identity-project-");
		const elsewhere = await fixture("wb-identity-elsewhere-");
		await writeFile(
			path.join(sessionsDir, "4242.json"),
			JSON.stringify({ pid: 4242, sessionId: SESSION, kind: "interactive", cwd: projectRoot }),
			"utf-8",
		);

		const mismatch = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: elsewhere,
			sessionsDir,
			isAlive: () => true,
		});
		expect(mismatch.kind).toBe("pending");

		const missing = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: null,
			sessionsDir,
			isAlive: () => true,
		});
		expect(missing.kind).toBe("pending");
	});

	it("stays pending when the parent worker is gone or has no record", async () => {
		const sessionsDir = await fixture("wb-identity-");
		const dead = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: "/x",
			sessionsDir,
			isAlive: () => false,
		});
		expect(dead.kind).toBe("pending");

		const noRecord = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: "/x",
			sessionsDir,
			isAlive: () => true,
		});
		expect(noRecord.kind).toBe("pending");
		if (noRecord.kind === "pending") {
			expect(noRecord.reason).toContain("cannot be tied to this call");
		}
	});

	it("reads and validates the registry record, rejecting malformed ones", async () => {
		const sessionsDir = await fixture("wb-identity-");
		// A record without a usable pid or session id is not identity evidence.
		expect(parseWorkerRecord({ pid: "4242", sessionId: SESSION })).toBeNull();
		expect(parseWorkerRecord({ pid: 4242 })).toBeNull();
		expect(parseWorkerRecord(null)).toBeNull();
		expect(parseWorkerRecord({ pid: 4242, sessionId: SESSION, kind: "interactive" })).toMatchObject({
			pid: 4242,
			sessionId: SESSION,
		});

		await writeFile(path.join(sessionsDir, "4242.json"), "{ not json", "utf-8");
		expect(await readWorkerRecord(4242, { sessionsDir })).toBeNull();
	});

	it("lists worker pids from the registry directory only", async () => {
		const sessionsDir = await fixture("wb-sessions-list-");
		await Bun.write(path.join(sessionsDir, "123.json"), "{}");
		await Bun.write(path.join(sessionsDir, "456.json"), "{}");
		await Bun.write(path.join(sessionsDir, "notes.txt"), "ignore me");
		expect((await listWorkerPids({ sessionsDir })).sort()).toEqual([123, 456]);

		// The default directory is derived from the home directory, never invented.
		expect(workBuddySessionsDir("/home/example")).toBe(path.join("/home/example", ".workbuddy", "sessions"));
	});
});

describe("identity resolver refuses to search for a plausible session", () => {
	it("does not scan other registry records when the parent has none", async () => {
		const sessionsDir = await fixture("wb-identity-");
		const projectRoot = await fixture("wb-identity-project-");
		// Another worker for the same project exists, but it is not this caller.
		await writeFile(
			path.join(sessionsDir, "9999.json"),
			JSON.stringify({ pid: 9999, sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", kind: "interactive", cwd: projectRoot }),
			"utf-8",
		);
		const identity = await resolveWorkBuddyCaller({
			parentPid: 4242,
			injectedCwd: projectRoot,
			sessionsDir,
			isAlive: () => true,
		});
		expect(identity.kind).toBe("pending");
		// And the reason makes the situation actionable rather than mysterious.
		if (identity.kind === "pending") {
			expect(identity.reason).toContain("4242");
		}
	});
});
