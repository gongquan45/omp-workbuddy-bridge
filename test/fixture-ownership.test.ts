/**
 * Ownership tests for the fixture helper.
 *
 * Every assertion here exists because a past cleanup deleted a path it did not
 * create. The helper must therefore prove two things at once: a legitimate
 * fixture root can be released, and *nothing else* can be — the refusals are
 * demonstrated with live sentinels rather than by reading the source.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createFixtureRoot,
	disownFixtureRoot,
	isRegisteredFixtureRoot,
	removeAllFixtureRoots,
	removeFixtureRoot,
} from "./helpers/fixtures";

/** Roots created directly by a test, always released through the helper. */
const created: string[] = [];

afterEach(async () => {
	while (created.length > 0) {
		const root = created.pop();
		if (root === undefined || !isRegisteredFixtureRoot(root)) {
			continue;
		}
		await removeFixtureRoot(root);
	}
});

async function fixture(prefix = "wb-fixture-test-"): Promise<string> {
	const root = await createFixtureRoot(prefix);
	created.push(root);
	return root;
}

/** Writes a file whose survival proves a refusal happened before any delete. */
async function plantSentinel(dir: string, name = "sentinel.txt"): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await writeFile(file, "must survive", "utf-8");
	return file;
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

/** Unregistered path used for the "never created here" cases. */
async function unownedProbe(): Promise<string> {
	const probe = path.join(os.tmpdir(), `wb-fixture-unowned-${crypto.randomUUID()}`);
	await mkdir(probe, { recursive: true });
	return probe;
}

describe("fixture root ownership", () => {
	it("creates a canonical registered root inside the temp directory and releases it", async () => {
		const root = await fixture();
		expect(path.isAbsolute(root)).toBeTrue();
		expect(root).toBe(await realpath(root));
		expect(isRegisteredFixtureRoot(root)).toBeTrue();

		const sentinel = await plantSentinel(path.join(root, "nested"));
		expect(await exists(sentinel)).toBeTrue();

		await removeFixtureRoot(root);
		expect(await exists(root)).toBeFalse();
		// Released once: a second release is a refusal, never a silent success.
		expect(isRegisteredFixtureRoot(root)).toBeFalse();
		await expect(removeFixtureRoot(root)).rejects.toThrow(/not created by this process/);
	});

	it("refuses an empty path, a relative path and the temp directory itself", async () => {
		const siblingSentinel = await plantSentinel(
			path.join(os.tmpdir(), `wb-fixture-sentinel-${crypto.randomUUID()}`),
		);
		const sibling = path.dirname(siblingSentinel);
		try {
			await expect(removeFixtureRoot("")).rejects.toThrow(/empty path/);
			await expect(removeFixtureRoot("relative/dir")).rejects.toThrow(/not created by this process/);
			await expect(removeFixtureRoot(os.tmpdir())).rejects.toThrow(/not created by this process/);
			await expect(removeFixtureRoot(await realpath(os.tmpdir()))).rejects.toThrow();

			expect(await exists(siblingSentinel)).toBeTrue();
		} finally {
			await rm(sibling, { recursive: true, force: true });
		}
	});

	it("refuses an absolute directory this process never created", async () => {
		const probe = await unownedProbe();
		const sentinel = await plantSentinel(probe);
		try {
			await expect(removeFixtureRoot(probe)).rejects.toThrow(/not created by this process/);
			expect(await exists(sentinel)).toBeTrue();
		} finally {
			await rm(probe, { recursive: true, force: true });
		}
	});

	it("refuses the repository root and the process cwd", async () => {
		const repo = await realpath(path.resolve(import.meta.dir, ".."));
		await expect(removeFixtureRoot(repo)).rejects.toThrow(/not created by this process/);
		await expect(removeFixtureRoot(await realpath(process.cwd()))).rejects.toThrow();

		// The repository is still intact: these refusals never reach a delete.
		expect(await exists(path.join(repo, "package.json"))).toBeTrue();
		expect(await exists(path.join(repo, "src", "index.ts"))).toBeTrue();
	});

	it("refuses a registered path that was replaced by a directory link", async () => {
		const root = await fixture();
		const elsewhere = await fixture("wb-fixture-elsewhere-");
		const sentinel = await plantSentinel(elsewhere);

		// Simulate the accident: the recorded path now points somewhere else.
		await rm(root, { recursive: true });
		let linked = false;
		try {
			await symlink(elsewhere, root, "junction");
			linked = true;
		} catch {
			linked = false;
		}
		if (!linked) {
			// Junction creation is refused on this host: nothing to prove here.
			await disownFixtureRoot(root);
			return;
		}

		await expect(removeFixtureRoot(root)).rejects.toThrow(/not a plain directory/);
		expect(await exists(sentinel)).toBeTrue();

		// Drop only the stand-in link, then retire the registration: the helper
		// must not own a path it can no longer identify.
		await rm(root, { recursive: true, force: true });
		expect(await exists(sentinel)).toBeTrue();
		await disownFixtureRoot(root);
	});

	it("refuses a registered path whose directory was replaced by a new one", async () => {
		const root = await fixture();
		await plantSentinel(root);

		// Delete and re-create the same path: the name matches, identity does not.
		await rm(root, { recursive: true });
		await mkdir(root, { recursive: true });
		const sentinel = await plantSentinel(root, "replacement.txt");

		await expect(removeFixtureRoot(root)).rejects.toThrow(/no longer exists|re-created|different directory/);
		expect(await exists(sentinel)).toBeTrue();

		await rm(root, { recursive: true, force: true });
		await disownFixtureRoot(root);
	});

	it("keeps sibling fixtures independent when one is released", async () => {
		const kept = await fixture();
		const dropped = await fixture();
		const keptSentinel = await plantSentinel(kept);

		await removeFixtureRoot(dropped);
		expect(await exists(keptSentinel)).toBeTrue();
		expect(await readdir(kept)).toContain("sentinel.txt");
	});

	it("releases every remaining root exactly once through the bulk helper", async () => {
		const first = await createFixtureRoot("wb-fixture-bulk-a-");
		const second = await createFixtureRoot("wb-fixture-bulk-b-");
		expect(isRegisteredFixtureRoot(first)).toBeTrue();
		expect(isRegisteredFixtureRoot(second)).toBeTrue();

		await removeAllFixtureRoots();
		expect(await exists(first)).toBeFalse();
		expect(await exists(second)).toBeFalse();
		expect(isRegisteredFixtureRoot(first)).toBeFalse();
		expect(isRegisteredFixtureRoot(second)).toBeFalse();
	});
});
