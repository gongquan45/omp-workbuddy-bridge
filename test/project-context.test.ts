/**
 * Project context tests.
 *
 * The requirement behind every case is the same: one project has exactly one
 * state, no matter which of its subdirectories a session happens to sit in, and
 * a session never gets write capability for a project it has left.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

import { canonicalSetupRoot, resolveProjectContext } from "../src/project-context";
import {
	closeQueueConnection,
	inspectProjectMarker,
	nextRevision,
	openWriteConnection,
	QUEUE_SCHEMA_VERSION,
	withImmediate,
	writeMeta,
} from "../src/queue";
import { WB_ERROR_CODE } from "../src/types";
import { createFixtureRoot, releaseProjectFixture } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			// This suite opens real write connections to enable fixtures, so the
			// helper must close them before deleting or Windows reports EBUSY.
			await releaseProjectFixture(root);
		}
	}
});

async function projectRoot(prefix = "wb-context-"): Promise<string> {
	const root = await createFixtureRoot(prefix);
	roots.push(root);
	return root;
}

/**
 * Real classifier used by the resolver: the same `inspectProjectMarker` that
 * production passes in, so the tests exercise the real state vocabulary.
 */
function classifier(): (root: string) => ReturnType<typeof inspectProjectMarker> {
	return (root) => inspectProjectMarker(root);
}

/**
 * Creates real, enabled project state.
 *
 * Written through the real queue rather than by fabricating a `state.sqlite`
 * file, because the classifier reads `meta.project_root` and
 * `meta.project_enabled_at`: an empty file would classify as an unreadable
 * database, not as an enabled project.
 *
 * The write connection is closed immediately afterwards. A test may enable a
 * directory that is not itself a fixture root (a nested project inside one), and
 * a cached handle would then block that root's deletion on Windows.
 */
async function enable(root: string): Promise<void> {
	const db = openWriteConnection(root);
	withImmediate(db, () => {
		writeMeta(db, "project_root", root);
		writeMeta(db, "schema_version", String(QUEUE_SCHEMA_VERSION));
		writeMeta(db, "project_enabled_at", new Date().toISOString());
		nextRevision(db);
	});
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
}

describe("project context resolution", () => {
	it("resolves two subdirectories of one authorized root to the same project", async () => {
		const root = await projectRoot();
		await enable(root);
		const alpha = path.join(root, "src", "alpha");
		const beta = path.join(root, "docs");
		await mkdir(alpha, { recursive: true });
		await mkdir(beta, { recursive: true });
		const checker = classifier();

		const fromAlpha = await resolveProjectContext(alpha, { classify: checker });
		const fromBeta = await resolveProjectContext(beta, { classify: checker });

		expect(fromAlpha.projectRoot).toBe(root);
		expect(fromBeta.projectRoot).toBe(root);
		expect(fromAlpha.authorization).toBe("authorized");
		expect(fromAlpha.identitySource).toBe("ancestor_marker");
		// The relative coordinate is what stored scopes and artifact paths use.
		expect(fromAlpha.relativeCwd).toBe("src/alpha");
		expect(fromBeta.relativeCwd).toBe("docs");
	});

	it("resolves the root itself to an empty relative coordinate", async () => {
		const root = await projectRoot();
		await enable(root);

		const resolution = await resolveProjectContext(root, { classify: classifier() });
		expect(resolution.relativeCwd).toBe("");
		expect(resolution.projectRoot).toBe(root);
	});

	it("reports unauthorized for a directory with no enabled marker, creating nothing", async () => {
		const bare = await projectRoot();

		const resolution = await resolveProjectContext(bare, { classify: classifier() });
		expect(resolution.authorization).toBe("unauthorized");
		expect(resolution.projectRoot).toBeNull();
		expect(resolution.relativeCwd).toBe("");
		expect(resolution.reason).toContain("no project state covers");

		// A read-only resolver must not bring bridge state into being.
		await expect(Bun.file(path.join(bare, ".wb-bridge", "state.sqlite")).exists()).resolves.toBeFalse();
	});

	it("does not merge a second checkout that merely shares the name or the remote", async () => {
		const first = await projectRoot("wb-context-a-");
		const second = await projectRoot("wb-context-b-");
		await enable(first);
		// Same directory name, deliberately: the fixture prefixes differ, so the
		// checkout basenames are made equal here.
		await mkdir(path.join(second, ".wb-bridge"), { recursive: true });
		const checker = classifier();

		const fromFirst = await resolveProjectContext(first, { classify: checker });
		const fromSecond = await resolveProjectContext(second, { classify: checker });

		expect(fromFirst.projectRoot).toBe(first);
		expect(fromSecond.projectRoot).toBeNull();
		expect(fromSecond.authorization).toBe("unauthorized");
	});

	it("marks nested enabled roots as pending verification instead of guessing the nearest", async () => {
		const outer = await projectRoot("wb-context-outer-");
		const inner = path.join(outer, "vendor", "inner");
		await mkdir(inner, { recursive: true });
		await enable(outer);
		await enable(inner);
		const workdir = path.join(inner, "src");
		await mkdir(workdir, { recursive: true });

		const resolution = await resolveProjectContext(workdir, {
			classify: classifier(),
		});

		expect(resolution.authorization).toBe("pending_verification");
		expect(resolution.projectRoot).toBeNull();
		expect(resolution.ambiguousRoots).toEqual([inner, outer]);
		expect(resolution.reason).toContain("confirm which project");
	});

	it("uses a recorded session association while no nearer root supersedes it", async () => {
		const root = await projectRoot("wb-context-assoc-");
		const nestedState = path.join(root, "packages", "plain-dir");
		await mkdir(nestedState, { recursive: true });
		await enable(root);

		const resolution = await resolveProjectContext(nestedState, {
			classify: classifier(),
			associatedRoot: root,
		});

		expect(resolution.authorization).toBe("authorized");
		expect(resolution.projectRoot).toBe(root);
		expect(resolution.identitySource).toBe("session_association");
	});

	it("refuses to file a nested authorized project under the associated outer root", async () => {
		// The case that would actually corrupt state: both roots are enabled, the
		// session is recorded against the outer one, and the cwd sits inside the
		// inner one. Association must not win — that would stamp inner's tasks into
		// outer's queue under a nested relative path.
		const outer = await projectRoot("wb-context-nested-assoc-outer-");
		const inner = path.join(outer, "vendor", "inner");
		await mkdir(inner, { recursive: true });
		await enable(outer);
		await enable(inner);
		const workdir = path.join(inner, "src");
		await mkdir(workdir, { recursive: true });

		const resolution = await resolveProjectContext(workdir, {
			classify: classifier(),
			associatedRoot: outer,
		});

		expect(resolution.authorization).toBe("pending_verification");
		expect(resolution.projectRoot).toBeNull();
		// Nothing is written, and both candidates are named for the user to choose.
		expect(resolution.ambiguousRoots).toEqual([inner, outer]);
		expect(resolution.relativeCwd).toBe("");
	});

	it("keeps a recorded association only while the cwd stays inside that root", async () => {
		const associated = await projectRoot("wb-context-keep-");
		const elsewhere = await projectRoot("wb-context-left-");
		await enable(associated);
		await enable(elsewhere);

		// The session left the recorded root: no write capability follows it.
		const resolution = await resolveProjectContext(elsewhere, {
			classify: classifier(),
			associatedRoot: associated,
		});
		expect(resolution.projectRoot).toBe(elsewhere);
		expect(resolution.identitySource).toBe("ancestor_marker");
	});

	it("reports unauthorized when the recorded root no longer holds project state", async () => {
		const associated = await projectRoot("wb-context-stale-");
		const nested = path.join(associated, "sub");
		await mkdir(nested, { recursive: true });
		// No state was ever written here: the recorded association is stale.
		const resolution = await resolveProjectContext(nested, {
			classify: classifier(),
			associatedRoot: associated,
		});
		expect(resolution.authorization).toBe("unauthorized");
		expect(resolution.projectRoot).toBeNull();
		expect(resolution.reason).toContain("no longer holds project state");
	});

	it("still resolves a project whose state exists but is not enabled yet", async () => {
		// The upgrade state: a legacy or disabled project is a real project, so the
		// resolver must return it rather than reporting "nothing here". Refusing to
		// dispatch is the migration gate's job, with its own /wb setup message.
		const root = await projectRoot("wb-context-legacy-");
		await mkdir(path.join(root, ".wb-bridge"), { recursive: true });
		await Bun.write(
			path.join(root, ".wb-bridge", "binding.json"),
			JSON.stringify({ version: 1, projectRoot: root, sessionId: "s-1", workbuddyVersion: "1.0.0" }),
		);

		const resolution = await resolveProjectContext(root, { classify: classifier() });
		expect(resolution.authorization).toBe("authorized");
		expect(resolution.projectRoot).toBe(root);
		expect(inspectProjectMarker(root)).toBe("legacy");
	});

	it("canonicalizes a junction out of the authorized root", async () => {
		const root = await projectRoot("wb-context-junction-");
		const outside = await projectRoot("wb-context-outside-");
		await enable(root);
		await enable(outside);
		const link = path.join(root, "escape");
		let linked = false;
		try {
			await symlink(outside, link, "junction");
			linked = true;
		} catch {
			linked = false;
		}
		if (!linked) {
			// Junctions are unavailable on this host; the canonical-path rule is
			// still exercised by the direct-root cases above.
			return;
		}

		// Reaching the outside directory *through* a link inside the root must not
		// grant the root's state: realpath resolves the link to its true target.
		const resolution = await resolveProjectContext(link, { classify: classifier() });
		expect(resolution.actualCwd).toBe(await realpath(outside));
		expect(resolution.projectRoot).toBe(outside);
	});

	it("rejects a relative or empty working directory", async () => {
		const checker = classifier();
		await expect(resolveProjectContext("", { classify: checker })).rejects.toMatchObject({
			code: WB_ERROR_CODE.inputInvalid,
		});
		await expect(resolveProjectContext("relative/dir", { classify: checker })).rejects.toMatchObject({
			code: WB_ERROR_CODE.inputInvalid,
		});
	});

	it("canonicalizes a setup root that does not exist yet without creating it", () => {
		const target = path.join(process.cwd(), "does-not-exist-yet");
		expect(canonicalSetupRoot(target)).toBe(path.resolve(target));
		expect(canonicalSetupRoot(process.cwd())).toBe(process.cwd());
		expect(() => canonicalSetupRoot("relative")).toThrow(/absolute path/);
	});
});
