/**
 * Fixture ownership: the only sanctioned way to create and delete a test root.
 *
 * The repository lost its working tree once because a test cleanup deleted a
 * path it had no business touching. "Absolute path" and "long enough string"
 * are not ownership proofs, so this module replaces both heuristics with a
 * single bookkeeping rule:
 *
 *  - `createFixtureRoot` makes the directory with `mkdtemp` under the canonical
 *    temp directory, resolves it to its real path, and registers that exact
 *    directory with a random per-creation token. Only fully created roots are
 *    registered.
 *  - `removeFixtureRoot` refuses anything this process did not register: it
 *    re-checks that the target is still a real directory (not a link), is a
 *    strict descendant of the canonical temp directory, does not contain the
 *    process cwd or the repository, and still carries the registration token
 *    and directory identity recorded at creation.
 *
 * Nothing here falls back to a heuristic. A refusal throws before any recursive
 * delete, so a caller that passes the wrong path loses the cleanup, never the
 * repository.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeQueueConnection } from "../../src/queue";

/** Recorded proof that one created directory is still the one we may delete. */
interface FixtureRegistration {
	token: string;
	/** Canonical directory this token was issued for. */
	root: string;
	/** Creation timestamp of the directory we made, when the platform reports it. */
	birthtimeMs: number;
	/** File index of the directory we made, when the platform reports it. */
	ino: number;
}

/** Registered roots, keyed by the canonical path used at creation. */
const registry = new Map<string, FixtureRegistration>();

/** Canonical repository root, resolved once so containment checks cannot drift. */
let repoRootPromise: Promise<string> | undefined;

function repoRoot(): Promise<string> {
	repoRootPromise ??= realpath(path.resolve(import.meta.dir, "..", ".."));
	return repoRootPromise;
}

/** Canonical temp directory; the only ancestor a fixture root may live under. */
let tempRootPromise: Promise<string> | undefined;

function canonicalTempRoot(): Promise<string> {
	tempRootPromise ??= realpath(os.tmpdir());
	return tempRootPromise;
}

/** True when `err` is a Node error carrying this `code` (for example ENOENT). */
function isErrnoCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof err.code === "string" &&
		err.code === code
	);
}

/**
 * Registry key for a path.
 *
 * Windows filesystems are case-insensitive, so two spellings of one directory
 * must map to the same registration; other platforms keep exact spelling.
 */
function registryKey(target: string): string {
	const resolved = path.resolve(target);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `child` is a strict descendant of `parent`. */
function isStrictDescendant(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The out-of-tree file that carries one root's ownership marker.
 *
 * Markers live beside the fixture roots rather than inside them: fixture
 * contents must stay exactly what the test wrote, and a marker inside the root
 * would be deleted along with it and could not prove identity afterwards.
 */
async function ownershipMarkerFile(token: string): Promise<string> {
	const directory = path.join(await canonicalTempRoot(), ".omp-wb-fixture-registry");
	return path.join(directory, `${token}.json`);
}

/** Persists the ownership marker; the marker is created before registration. */
async function writeMarker(registration: FixtureRegistration): Promise<void> {
	const file = await ownershipMarkerFile(registration.token);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(registration), "utf-8");
}

/** Reads a marker back; a missing or unparsable marker yields null. */
async function readMarker(token: string): Promise<FixtureRegistration | null> {
	let raw: string;
	try {
		raw = await readFile(await ownershipMarkerFile(token), "utf-8");
	} catch {
		return null;
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	if (!("token" in parsed) || !("root" in parsed) || !("birthtimeMs" in parsed) || !("ino" in parsed)) {
		return null;
	}
	const markerToken = parsed.token;
	const markerRoot = parsed.root;
	const markerBirthtime = parsed.birthtimeMs;
	const markerIno = parsed.ino;
	if (
		typeof markerToken !== "string" ||
		typeof markerRoot !== "string" ||
		typeof markerBirthtime !== "number" ||
		typeof markerIno !== "number"
	) {
		return null;
	}
	return { token: markerToken, root: markerRoot, birthtimeMs: markerBirthtime, ino: markerIno };
}

/**
 * Creates an isolated fixture root under the canonical temp directory.
 *
 * The directory is registered only after `mkdtemp`, `realpath` and the marker
 * write all succeed, so a half-created root is never treated as owned.
 */
export async function createFixtureRoot(prefix: string): Promise<string> {
	const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		const canonical = await realpath(raw);
		const created = await stat(canonical);
		const registration: FixtureRegistration = {
			token: randomUUID(),
			root: canonical,
			birthtimeMs: created.birthtimeMs,
			ino: typeof created.ino === "number" ? created.ino : 0,
		};
		await writeMarker(registration);
		registry.set(registryKey(canonical), registration);
		return canonical;
	} catch (err: unknown) {
		// The root exists but was never registered: reclaim the directory this
		// call itself just created rather than leaking it, then surface the error.
		await rm(raw, { recursive: true }).catch(() => undefined);
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Synchronous twin of `createFixtureRoot` for suites whose setup is sync.
 *
 * It applies the identical registration rules; only the fs calls differ.
 */
export function createFixtureRootSync(prefix: string): string {
	const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		const canonical = fs.realpathSync(raw);
		const created = fs.statSync(canonical);
		const registration: FixtureRegistration = {
			token: randomUUID(),
			root: canonical,
			birthtimeMs: created.birthtimeMs,
			ino: typeof created.ino === "number" ? created.ino : 0,
		};
		const marker = path.join(fs.realpathSync(os.tmpdir()), ".omp-wb-fixture-registry");
		fs.mkdirSync(marker, { recursive: true });
		fs.writeFileSync(path.join(marker, `${registration.token}.json`), JSON.stringify(registration), "utf-8");
		registry.set(registryKey(canonical), registration);
		return canonical;
	} catch (err: unknown) {
		fs.rmSync(raw, { recursive: true, force: true });
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Deletes a fixture root created by `createFixtureRoot` in this process.
 *
 * Throws, without deleting anything, whenever ownership cannot be proven.
 * Repeating a removal for an already-released root is a refusal, not a no-op.
 */
export async function removeFixtureRoot(target: string): Promise<void> {
	if (target.trim().length === 0) {
		throw new Error("refusing fixture cleanup: empty path");
	}

	const resolved = path.resolve(target);
	const registration = registry.get(registryKey(resolved));
	if (registration === undefined) {
		throw new Error(`refusing fixture cleanup: ${resolved} was not created by this process`);
	}

	// The registered path is the only acceptable target; a caller that resolved a
	// different spelling (junction, 8.3 name) must not widen ownership.
	if (registration.root !== resolved) {
		throw new Error(`refusing fixture cleanup: ${resolved} is not the registered root ${registration.root}`);
	}

	const tempRoot = await canonicalTempRoot();
	if (!isStrictDescendant(tempRoot, resolved)) {
		throw new Error(`refusing fixture cleanup: ${resolved} is outside ${tempRoot}`);
	}

	const [repo, cwd] = await Promise.all([repoRoot(), realpath(process.cwd())]);
	for (const guarded of [tempRoot, repo, cwd]) {
		if (resolved === guarded) {
			throw new Error(`refusing fixture cleanup: ${resolved} is a protected directory`);
		}
		if (isStrictDescendant(resolved, guarded)) {
			throw new Error(`refusing fixture cleanup: ${resolved} contains ${guarded}`);
		}
	}

	const info = await lstat(resolved).catch((err: unknown) => {
		if (isErrnoCode(err, "ENOENT")) {
			throw new Error(`refusing fixture cleanup: ${resolved} no longer exists`);
		}
		throw err;
	});
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`refusing fixture cleanup: ${resolved} is not a plain directory`);
	}

	const marker = await readMarker(registration.token);
	if (marker === null) {
		throw new Error(`refusing fixture cleanup: ownership marker for ${resolved} is missing`);
	}
	if (marker.token !== registration.token || marker.root !== registration.root) {
		throw new Error(`refusing fixture cleanup: ownership marker for ${resolved} does not match`);
	}
	// Directory identity: a path re-created by something else is not ours even
	// when its name matches the registered one.
	if (registration.ino !== 0 && marker.ino !== 0 && info.ino !== marker.ino) {
		throw new Error(`refusing fixture cleanup: ${resolved} is a different directory than the one created`);
	}
	if (registration.birthtimeMs > 0 && marker.birthtimeMs > 0 && info.birthtimeMs !== marker.birthtimeMs) {
		throw new Error(`refusing fixture cleanup: ${resolved} was re-created after registration`);
	}

	// Ownership is proven above. Windows can still hold a directory briefly while
	// a just-terminated child process releases its SQLite handles, so the delete
	// itself retries a bounded number of times instead of being silently skipped.
	await rm(resolved, { recursive: true, maxRetries: 10, retryDelay: 100 });
	registry.delete(registryKey(resolved));
	await unlink(await ownershipMarkerFile(registration.token)).catch(() => undefined);
}

/**
 * Releases every root this process still owns; used by suite teardown.
 *
 * A root that can no longer be proven ours is surfaced as a failure instead of
 * being skipped, so a stale registration cannot hide a real leak.
 */
export async function removeAllFixtureRoots(): Promise<void> {
	const failures: Error[] = [];
	for (const registration of [...registry.values()]) {
		try {
			await removeFixtureRoot(registration.root);
		} catch (err: unknown) {
			failures.push(err instanceof Error ? err : new Error(String(err)));
		}
	}
	if (failures.length > 0) {
		throw failures[0]!;
	}
}

/**
 * Drops this process's ownership claim without deleting anything.
 *
 * Used only by tests that deliberately destroy or replace a root themselves and
 * must then prove the helper refuses to touch it. It never removes a directory.
 */
export async function disownFixtureRoot(target: string): Promise<void> {
	const registration = registry.get(registryKey(target));
	if (registration === undefined) {
		return;
	}
	registry.delete(registryKey(target));
	await unlink(await ownershipMarkerFile(registration.token)).catch(() => undefined);
}

/** True when this process still owns `target`; lets a test assert a refusal. */
export function isRegisteredFixtureRoot(target: string): boolean {
	return registry.has(registryKey(path.resolve(target)));
}

/**
 * Releases a fixture root that also holds this process's project queue handles.
 *
 * `enableProject`, `openProjectQueue` and migration cache a `Database` per
 * project in `src/queue.ts`, and Windows refuses to delete a directory whose
 * SQLite file is still open by this process. Closing both modes first is the
 * difference between a real release and a leaked fixture, so the pair lives
 * here instead of being repeated (and forgotten) per suite.
 */
export async function releaseProjectFixture(root: string): Promise<void> {
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	await removeFixtureRoot(root);
}
