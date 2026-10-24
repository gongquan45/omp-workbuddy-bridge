#!/usr/bin/env bun
/**
 * Installer: verifies the host, installs this bridge as an immutable release,
 * registers that exact directory with OMP, and previews/applyies the MCP entries.
 *
 * Two facts drive the design:
 *
 * - A release directory is addressed by *payload digest*, not only by version.
 *   Two builds of the same version are different candidates and must not share a
 *   directory; a directory that does not byte-for-byte match its manifest (or
 *   lacks its installed dependencies) is reported as partial and never reused.
 * - Nothing is written unless the operator passes `--apply`. Preflight, candidate
 *   planning and configuration planning are read-only and are the default.
 *
 * The installer never installs, upgrades or restarts Bun, OMP or WorkBuddy. It
 * reports `active: unverified` even after a successful apply, because only an
 * actual host start proves which code OMP loaded.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import { applyIntegration, planIntegration, setupTargets, type IntegrationPlan, type TargetPlan } from "./integration";

/** Package name this installer owns; registration is matched on the exact value. */
export const PACKAGE_NAME = "omp-wb-bridge";

/** Entries a release directory must contain. Missing entries make a candidate incomplete. */
const RELEASE_ENTRIES = ["package.json", "bun.lock", "tsconfig.json", "src", "skills"] as const;

/** Name of the file that records a release's identity. Never part of the payload digest. */
const MANIFEST_FILE = "release-manifest.json";

const MIN_BUN = "1.4.0";
const MIN_OMP = "18.10.3";

/** Result of one preflight check. */
export interface Check {
	name: string;
	ok: boolean;
	detail: string;
	/** What the user should do when the check failed. */
	advice?: string;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Process execution seam.
 *
 * Tests inject this so planning/apply can be exercised without touching a real
 * OMP installation or running a real `bun install`. The default runner resolves
 * the executable through `Bun.which` so a shim on PATH is the program that runs.
 */
export type ProcessRunner = (command: string[], options: RunOptions) => RunResult;

export const defaultRunner: ProcessRunner = (command, options) => {
	const requested = command[0];
	if (requested === undefined) {
		return { exitCode: 127, stdout: "", stderr: "no executable was named" };
	}
	const executable = Bun.which(requested) ?? requested;
	try {
		const result = Bun.spawnSync({
			cmd: [executable, ...command.slice(1)],
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
		};
	} catch (err: unknown) {
		return {
			exitCode: 127,
			stdout: "",
			stderr: `could not start ${requested}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
};

/** Extracts the first numeric `major.minor.patch` from a version line. */
function numericVersion(value: string): [number, number, number] | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
	if (match === null) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares two version strings; returns true when `actual >= required`. */
export function atLeast(actual: string, required: string): boolean {
	const a = numericVersion(actual);
	const r = numericVersion(required);
	if (a === null || r === null) {
		return false;
	}
	for (let index = 0; index < 3; index++) {
		const left = a[index] ?? 0;
		const right = r[index] ?? 0;
		if (left !== right) {
			return left > right;
		}
	}
	return true;
}

/** Runs `command --version` and returns its output, or null when it is absent or fails. */
function probeVersion(command: string, run: ProcessRunner): string | null {
	const result = run([command, "--version"], {});
	if (result.exitCode !== 0) {
		return null;
	}
	const output = result.stdout.trim();
	return output.length === 0 ? null : output;
}

/** Collects the environment facts the install depends on. */
export function preflight(run: ProcessRunner = defaultRunner): Check[] {
	const bunVersion = probeVersion("bun", run);
	const ompVersion = probeVersion("omp", run);
	return [
		{
			name: "Bun",
			ok: bunVersion !== null && atLeast(bunVersion, MIN_BUN),
			detail: bunVersion === null ? "not found on PATH" : bunVersion,
			advice: `Install Bun ${MIN_BUN}+ from https://bun.sh and re-run.`,
		},
		{
			name: "OMP",
			ok: ompVersion !== null && atLeast(ompVersion, MIN_OMP),
			detail: ompVersion === null ? "not found on PATH" : ompVersion,
			advice: `Install OMP ${MIN_OMP}+ (the pinned host this extension targets) and re-run.`,
		},
	];
}

/** Default base directory that holds one child directory per immutable candidate. */
export function defaultReleaseBase(): string {
	const data =
		process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
	return path.join(data, "omp-wb-bridge", "releases");
}

/** Default user root whose `.workbuddy`/OMP state an install may touch. */
export function defaultUserRoot(): string {
	return os.homedir();
}

/**
 * The immutable directory for one exact payload.
 *
 * Version is included for humans; the digest makes two same-version builds
 * distinct instead of letting one silently stand in for the other.
 */
export function candidateReleasePath(baseDir: string, version: string, digest: string): string {
	return path.join(path.resolve(baseDir), `${version}-${digest.replace(/^sha256:/, "").slice(0, 12)}`);
}

/**
 * Environment for OMP children.
 *
 * A smoke run must not read or write the operator's real OMP plugins/settings.
 * Both HOME and USERPROFILE are set because Node/Bun's `os.homedir()` reads the
 * former on POSIX and the latter on Windows; the XDG/AppData values cover hosts
 * that resolve their config directory from those variables instead.
 */
export function isolatedUserEnv(userRoot: string): Record<string, string> {
	const root = path.resolve(userRoot);
	return {
		HOME: root,
		USERPROFILE: root,
		APPDATA: path.join(root, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(root, "AppData", "Local"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
	};
}

/** Thrown when the source tree cannot be described as a candidate at all. */
export class CandidateError extends Error {
	override name = "CandidateError";
}

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Walks the release entries and hashes every regular file.
 *
 * Symlinks are refused: an installed release must be self-contained, and a link
 * would make the digest describe something other than the bytes on this machine.
 */
async function collectPayload(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();

	const walk = async (relative: string): Promise<void> => {
		const absolute = path.join(root, relative);
		const info = await lstat(absolute).catch(() => null);
		if (info === null) {
			throw new CandidateError(`release entry is missing: ${relative}`);
		}
		if (info.isSymbolicLink()) {
			throw new CandidateError(`release entry is a symlink, which is not supported: ${relative}`);
		}
		if (info.isDirectory()) {
			const children = await readdir(absolute, { withFileTypes: true });
			children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
			for (const child of children) {
				if (child.name === "node_modules" || child.name === ".git") {
					continue;
				}
				await walk(relative === "" ? child.name : `${relative}/${child.name}`);
			}
			return;
		}
		if (!info.isFile()) {
			throw new CandidateError(`release entry is not a regular file: ${relative}`);
		}
		files.set(relative, await readFile(absolute).then((bytes) => sha256(bytes)));
	};

	for (const entry of RELEASE_ENTRIES) {
		await walk(entry);
	}
	return files;
}

/** Stable digest over relative paths and file hashes. */
function digestFiles(files: Map<string, string>): string {
	const hash = createHash("sha256");
	for (const relative of [...files.keys()].sort()) {
		hash.update(`${relative}\0${files.get(relative)}\n`);
	}
	return `sha256:${hash.digest("hex")}`;
}

interface PackageIdentity {
	version: string;
	dependencies: string[];
}

/** Reads the package name/version/dependencies, refusing a tree that is not this package. */
async function readPackageIdentity(root: string): Promise<PackageIdentity> {
	let raw: string;
	try {
		raw = await readFile(path.join(root, "package.json"), "utf-8");
	} catch (err: unknown) {
		throw new CandidateError(
			`cannot read ${path.join(root, "package.json")}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		throw new CandidateError(`package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new CandidateError("package.json is not an object");
	}
	const name = "name" in parsed ? parsed.name : undefined;
	const version = "version" in parsed ? parsed.version : undefined;
	if (name !== PACKAGE_NAME) {
		throw new CandidateError(`package.json name must be ${PACKAGE_NAME}, found ${String(name)}`);
	}
	if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
		throw new CandidateError(`package.json has an unusable version: ${String(version)}`);
	}
	const dependencies: string[] = [];
	if ("dependencies" in parsed && typeof parsed.dependencies === "object" && parsed.dependencies !== null) {
		dependencies.push(...Object.keys(parsed.dependencies).sort());
	}
	return { version, dependencies };
}

/** One exact source payload, addressed independently of where the source lives. */
export interface ReleaseCandidate {
	name: string;
	version: string;
	digest: string;
	releasePath: string;
	sourceRoot: string;
	files: string[];
	dependencies: string[];
}

export interface CandidateInput {
	sourceRoot?: string;
	releaseBaseDir?: string;
}

/** Describes the source tree as an immutable candidate without writing anything. */
export async function inspectCandidate(input: CandidateInput = {}): Promise<ReleaseCandidate> {
	const sourceRoot = path.resolve(input.sourceRoot ?? path.join(import.meta.dir, ".."));
	const baseDir = path.resolve(input.releaseBaseDir ?? defaultReleaseBase());
	const identity = await readPackageIdentity(sourceRoot);
	const files = await collectPayload(sourceRoot);
	const digest = digestFiles(files);
	return {
		name: PACKAGE_NAME,
		version: identity.version,
		digest,
		releasePath: candidateReleasePath(baseDir, identity.version, digest),
		sourceRoot,
		files: [...files.keys()].sort(),
		dependencies: identity.dependencies,
	};
}

const ManifestSchema = z.object({
	format: z.literal(1),
	name: z.literal(PACKAGE_NAME),
	version: z.string(),
	digest: z.string(),
	files: z.array(z.string()),
});

type ReleaseManifest = z.infer<typeof ManifestSchema>;

type ManifestRead =
	| { status: "missing"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "ok"; manifest: ReleaseManifest };

async function readManifest(releasePath: string): Promise<ManifestRead> {
	let raw: string;
	try {
		raw = await readFile(path.join(releasePath, MANIFEST_FILE), "utf-8");
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return { status: "missing", reason: `${MANIFEST_FILE} is missing (the directory is partial)` };
		}
		return {
			status: "invalid",
			reason: `cannot read ${MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		return {
			status: "invalid",
			reason: `${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const result = ManifestSchema.safeParse(parsed);
	if (!result.success) {
		return { status: "invalid", reason: `${MANIFEST_FILE} does not describe a release manifest` };
	}
	return { status: "ok", manifest: result.data };
}

/** Dependencies declared by a release that are not installed in its own `node_modules`. */
async function missingDependencies(releasePath: string): Promise<string[]> {
	const identity = await readPackageIdentity(releasePath);
	const missing: string[] = [];
	for (const dependency of identity.dependencies) {
		const packageJson = path.join(releasePath, "node_modules", ...dependency.split("/"), "package.json");
		if (!existsSync(packageJson)) {
			missing.push(dependency);
		}
	}
	return missing;
}

export interface ReleaseVerification {
	ok: boolean;
	reason: string | null;
	digest: string | null;
	dependencies: string[];
}

/**
 * Proves that a directory is the candidate it claims to be.
 *
 * This checks the manifest, every payload byte and the installed dependency
 * set. File existence alone is not enough: a half-copied directory can have the
 * right names and still be unable to run.
 */
export async function verifyRelease(
	releasePath: string,
	candidate: Pick<ReleaseCandidate, "digest" | "version">,
): Promise<ReleaseVerification> {
	const manifest = await readManifest(releasePath);
	if (manifest.status !== "ok") {
		return { ok: false, reason: manifest.reason, digest: null, dependencies: [] };
	}
	if (manifest.manifest.version !== candidate.version) {
		return {
			ok: false,
			reason: `manifest version ${manifest.manifest.version} does not match candidate version ${candidate.version}`,
			digest: null,
			dependencies: [],
		};
	}
	if (manifest.manifest.digest !== candidate.digest) {
		return {
			ok: false,
			reason: `manifest digest ${manifest.manifest.digest} does not match candidate ${candidate.digest}`,
			digest: null,
			dependencies: [],
		};
	}
	let files: Map<string, string>;
	try {
		files = await collectPayload(releasePath);
	} catch (err: unknown) {
		return {
			ok: false,
			reason: `release payload is incomplete: ${err instanceof Error ? err.message : String(err)}`,
			digest: null,
			dependencies: [],
		};
	}
	const actualFiles = [...files.keys()].sort();
	const manifestFiles = [...manifest.manifest.files].sort();
	if (
		actualFiles.length !== manifestFiles.length ||
		actualFiles.some((file, index) => file !== manifestFiles[index])
	) {
		return {
			ok: false,
			reason: "release file list differs from its manifest",
			digest: null,
			dependencies: [],
		};
	}
	const digest = digestFiles(files);
	if (digest !== candidate.digest) {
		return {
			ok: false,
			reason: `installed payload digest ${digest} does not match candidate ${candidate.digest}`,
			digest,
			dependencies: [],
		};
	}
	let missing: string[];
	try {
		missing = await missingDependencies(releasePath);
	} catch (err: unknown) {
		return {
			ok: false,
			reason: `cannot verify installed dependencies: ${err instanceof Error ? err.message : String(err)}`,
			digest,
			dependencies: [],
		};
	}
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `installed dependencies are incomplete: ${missing.join(", ")}`,
			digest,
			dependencies: missing,
		};
	}
	return { ok: true, reason: null, digest, dependencies: [] };
}

export type ReleaseAction = "create" | "reuse" | "refuse";

export interface ReleasePlan {
	candidate: ReleaseCandidate;
	action: ReleaseAction;
	reason: string | null;
}

/**
 * Decides what an apply would do for this source.
 *
 * An existing directory is reused only after full verification. Anything else
 * (partial copy, edited bytes, missing deps, stale manifest) is refused rather
 * than overwritten or treated as installed.
 */
export async function planRelease(input: CandidateInput = {}): Promise<ReleasePlan> {
	const candidate = await inspectCandidate(input);
	if (!existsSync(candidate.releasePath)) {
		return { candidate, action: "create", reason: null };
	}
	const verification = await verifyRelease(candidate.releasePath, candidate);
	if (!verification.ok) {
		return {
			candidate,
			action: "refuse",
			reason: `existing release directory ${candidate.releasePath} is not reusable: ${verification.reason}`,
		};
	}
	return { candidate, action: "reuse", reason: null };
}

export interface ReleaseApplyResult {
	releasePath: string;
	created: boolean;
	reused: boolean;
	verified: boolean;
	failure: string | null;
}

function failureMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Applies a release plan.
 *
 * New candidates are assembled in a sibling staging directory, verified there,
 * installed, and only then renamed into place. A failed copy/install therefore
 * leaves no half-release that a later run could mistake for an installation.
 */
export async function applyRelease(
	plan: ReleasePlan,
	options: { run?: ProcessRunner } = {},
): Promise<ReleaseApplyResult> {
	const { candidate } = plan;
	if (plan.action === "refuse") {
		return {
			releasePath: candidate.releasePath,
			created: false,
			reused: false,
			verified: false,
			failure: plan.reason ?? "release plan is refused",
		};
	}
	if (plan.action === "reuse") {
		const verification = await verifyRelease(candidate.releasePath, candidate);
		return {
			releasePath: candidate.releasePath,
			created: false,
			reused: verification.ok,
			verified: verification.ok,
			failure: verification.ok ? null : verification.reason,
		};
	}

	const run = options.run ?? defaultRunner;
	const destination = candidate.releasePath;
	const parent = path.dirname(destination);
	const staging = path.join(parent, `.staging-${path.basename(destination)}-${process.pid}-${randomUUID().slice(0, 8)}`);

	try {
		await mkdir(parent, { recursive: true });
		for (const relative of candidate.files) {
			const target = path.join(staging, relative);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(path.join(candidate.sourceRoot, relative), target);
		}
		const stagedFiles = await collectPayload(staging);
		const stagedDigest = digestFiles(stagedFiles);
		if (stagedDigest !== candidate.digest) {
			throw new Error(
				`copied payload digest ${stagedDigest} does not match source digest ${candidate.digest}; the source changed while it was being installed`,
			);
		}
		const manifest: ReleaseManifest = {
			format: 1,
			name: PACKAGE_NAME,
			version: candidate.version,
			digest: candidate.digest,
			files: candidate.files,
		};
		await writeFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

		const install = run(["bun", "install", "--frozen-lockfile"], { cwd: staging });
		if (install.exitCode !== 0) {
			throw new Error(
				`bun install --frozen-lockfile failed in the staging release: ${install.stderr.trim() || "no output"}`,
			);
		}
		const missing = await missingDependencies(staging);
		if (missing.length > 0) {
			throw new Error(`bun install did not provide these dependencies: ${missing.join(", ")}`);
		}

		try {
			await rename(staging, destination);
		} catch (err: unknown) {
			// A concurrent installer may have completed the same candidate first.
			if (existsSync(destination)) {
				const verification = await verifyRelease(destination, candidate);
				if (verification.ok) {
					return {
						releasePath: destination,
						created: false,
						reused: true,
						verified: true,
						failure: null,
					};
				}
				return {
					releasePath: destination,
					created: false,
					reused: false,
					verified: false,
					failure: `another process created ${destination} but it is not this candidate: ${verification.reason}`,
				};
			}
			return {
				releasePath: destination,
				created: false,
				reused: false,
				verified: false,
				failure: `could not move the verified staging release into place: ${failureMessage(err)}`,
			};
		}

		const verification = await verifyRelease(destination, candidate);
		return {
			releasePath: destination,
			created: true,
			reused: false,
			verified: verification.ok,
			failure: verification.ok ? null : verification.reason,
		};
	} catch (err: unknown) {
		return {
			releasePath: destination,
			created: false,
			reused: false,
			verified: false,
			failure: failureMessage(err),
		};
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** One plugin as reported by `omp plugin list --json`. */
export interface PluginIdentity {
	name: string;
	version: string;
	path: string;
	enabled: boolean | null;
}

const PluginListSchema = z.object({
	npm: z
		.array(
			z.object({
				name: z.string(),
				version: z.string(),
				path: z.string(),
				enabled: z.boolean().optional(),
			}),
		)
		.optional(),
});

export interface RegistrationExpected {
	name: string;
	version: string;
	releasePath: string;
}

export interface RegistrationVerification {
	ok: boolean;
	detail: string;
	identity: PluginIdentity | null;
}

/** Resolves a path to its real location so a link to the release is the release. */
async function canonicalPath(target: string): Promise<string> {
	const resolved = await realpath(target).catch(() => path.resolve(target));
	const absolute = path.resolve(resolved);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Verifies registration from the structured list output.
 *
 * The name must match exactly and the reported directory must resolve to this
 * release. A substring match would accept `omp-wb-bridge-old`, and a name-only
 * match would accept a second copy at another path.
 */
export async function verifyRegistration(
	listing: string,
	expected: RegistrationExpected,
): Promise<RegistrationVerification> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(listing);
	} catch (err: unknown) {
		return {
			ok: false,
			detail: `omp plugin list --json did not return JSON: ${failureMessage(err)}`,
			identity: null,
		};
	}
	const result = PluginListSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, detail: "omp plugin list --json did not return the expected { npm: [...] } shape", identity: null };
	}
	const named = (result.data.npm ?? []).filter((plugin) => plugin.name === expected.name);
	if (named.length === 0) {
		return { ok: false, detail: `no npm plugin named ${expected.name} is registered`, identity: null };
	}
	if (named.length > 1) {
		return {
			ok: false,
			detail: `${named.length} npm plugins are named ${expected.name}; the registration is ambiguous`,
			identity: null,
		};
	}
	const plugin = named[0]!;
	if (plugin.version !== expected.version) {
		return {
			ok: false,
			detail: `registered version ${plugin.version} does not match ${expected.version}`,
			identity: null,
		};
	}
	if (plugin.enabled === false) {
		return { ok: false, detail: `${expected.name} is registered but disabled`, identity: null };
	}
	const actual = await canonicalPath(plugin.path);
	const wanted = await canonicalPath(expected.releasePath);
	if (actual !== wanted) {
		return {
			ok: false,
			detail: `registered path ${plugin.path} resolves to ${actual}, not the installed release ${wanted}`,
			identity: null,
		};
	}
	return {
		ok: true,
		detail: `registered ${plugin.name}@${plugin.version} at ${plugin.path}`,
		identity: {
			name: plugin.name,
			version: plugin.version,
			path: plugin.path,
			enabled: plugin.enabled ?? null,
		},
	};
}

export interface RegistrationReport {
	check: Check;
	identity: PluginIdentity | null;
}

/** Registers the verified release and reads the structured listing back. */
export async function registerPlugin(
	candidate: Pick<ReleaseCandidate, "releasePath" | "version">,
	options: { run?: ProcessRunner; env?: Record<string, string | undefined> } = {},
): Promise<RegistrationReport> {
	const run = options.run ?? defaultRunner;
	const env = options.env;
	const install = run(["omp", "plugin", "install", candidate.releasePath], { env });
	if (install.exitCode !== 0) {
		return {
			check: {
				name: "OMP plugin registration",
				ok: false,
				detail: install.stderr.trim() || "omp plugin install failed",
				advice: "Check `omp plugin --help` for the local-link install form on this OMP version.",
			},
			identity: null,
		};
	}
	const list = run(["omp", "plugin", "list", "--json"], { env });
	if (list.exitCode !== 0) {
		return {
			check: {
				name: "OMP plugin registration",
				ok: false,
				detail: "omp plugin list --json failed, so the registration cannot be verified",
				advice: "Run `omp plugin list --json` manually and confirm the exact plugin path.",
			},
			identity: null,
		};
	}
	const verification = await verifyRegistration(list.stdout, {
		name: PACKAGE_NAME,
		version: candidate.version,
		releasePath: candidate.releasePath,
	});
	return {
		check: {
			name: "OMP plugin registration",
			ok: verification.ok,
			detail: verification.detail,
			advice: verification.ok ? undefined : "Restart OMP and inspect `omp plugin list --json`.",
		},
		identity: verification.identity,
	};
}

export interface ConfigurationPreview {
	/** Project whose legacy bridge-owned OMP entry may be removed; not a project install. */
	legacyProjectRoot: string | null;
	targets: TargetPlan[];
	applicable: boolean;
}

/**
 * Builds the MCP plan; never writes.
 *
 * The bridge is installed once at user level. A project path is only legacy
 * cleanup for an older OMP-side entry, never a second installation site.
 */
export async function previewConfiguration(input: {
	legacyProjectRoot: string | null;
	userRoot: string;
	bunExecutable: string;
	mcpEntrypoint: string;
}): Promise<ConfigurationPreview> {
	const plan: IntegrationPlan = await planIntegration(
		setupTargets({
			workbuddyHomeDir: input.userRoot,
			bunExecutable: input.bunExecutable,
			mcpEntrypoint: input.mcpEntrypoint,
			...(input.legacyProjectRoot === null ? {} : { legacyProjectRoot: input.legacyProjectRoot }),
		}),
	);
	return { legacyProjectRoot: input.legacyProjectRoot, targets: plan.targets, applicable: plan.applicable };
}

export interface CliOptions {
	mode: "preview" | "apply";
	releaseBaseDir: string | null;
	userRoot: string | null;
	projectRoot: string | null;
	json: boolean;
	help: boolean;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const USAGE = `Usage: bun src/install.ts [options]

Preview (default, writes nothing):
  bun src/install.ts --preview --release-root <dir> --user-root <dir> [--project <dir>] [--json]

Apply (creates/reuses the release, registers it, and writes the previewed entries):
  bun src/install.ts --apply --release-root <dir> --user-root <dir> [--project <dir>] [--json]

Options:
  --preview, --dry-run   Plan only. This is the default.
  --apply                Perform the planned release, registration and config writes.
  --release-root <dir>   Directory that holds immutable release candidates.
  --user-root <dir>      Isolated HOME/USERPROFILE for OMP children and .workbuddy.
  --project <dir>        Legacy cleanup: remove this project's old bridge-owned
                         OMP entry. The install itself stays user-level.
  --json                 Print one JSON object instead of the text report.
  --help, -h             Show this help.

Unknown options and missing values fail without writing anything.
`;

/** Parses argv; unknown/duplicated/ambiguous options fail closed. */
export function parseArgs(argv: string[]): ParseResult {
	const options: CliOptions = {
		mode: "preview",
		releaseBaseDir: null,
		userRoot: null,
		projectRoot: null,
		json: false,
		help: false,
	};
	let modeSet = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--preview" || argument === "--dry-run") {
			if (modeSet) {
				return { ok: false, error: `${argument} conflicts with an earlier mode option` };
			}
			modeSet = true;
			options.mode = "preview";
			continue;
		}
		if (argument === "--apply") {
			if (modeSet) {
				return { ok: false, error: "--apply conflicts with an earlier mode option" };
			}
			modeSet = true;
			options.mode = "apply";
			continue;
		}
		if (argument === "--release-root" || argument === "--user-root" || argument === "--project") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				return { ok: false, error: `${argument} needs a value` };
			}
			index++;
			if (argument === "--release-root") {
				if (options.releaseBaseDir !== null) {
					return { ok: false, error: "--release-root was given more than once" };
				}
				options.releaseBaseDir = value;
			} else if (argument === "--user-root") {
				if (options.userRoot !== null) {
					return { ok: false, error: "--user-root was given more than once" };
				}
				options.userRoot = value;
			} else {
				if (options.projectRoot !== null) {
					return { ok: false, error: "--project was given more than once" };
				}
				options.projectRoot = value;
			}
			continue;
		}
		return { ok: false, error: `unknown option: ${argument}` };
	}
	return { ok: true, options };
}

interface CliDependencies {
	run?: ProcessRunner;
	sourceRoot?: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

function printChecks(checks: Check[], write: (text: string) => void): void {
	for (const check of checks) {
		write(`  [${check.ok ? "ok  " : "FAIL"}] ${check.name}: ${check.detail}\n`);
		if (!check.ok && check.advice !== undefined) {
			write(`         -> ${check.advice}\n`);
		}
	}
}

function configurationSummary(configuration: ConfigurationPreview): Array<{
	filePath: string;
	missing: boolean;
	blockedReason: string | null;
}> {
	return configuration.targets.map((target) => ({
		filePath: target.filePath,
		missing: target.missing,
		blockedReason: target.blockedReason,
	}));
}

async function projectProblem(projectRoot: string, candidate: ReleaseCandidate): Promise<string | null> {
	const info = await stat(projectRoot).catch(() => null);
	if (info === null || !info.isDirectory()) {
		return `--project is not a directory: ${projectRoot}`;
	}
	const project = await canonicalPath(projectRoot);
	const release = await canonicalPath(candidate.releasePath);
	if (project === release || project.startsWith(`${release}${path.sep}`)) {
		return "--project must be the business project, not the installed release directory";
	}
	return null;
}

async function userRootProblem(userRoot: string): Promise<string | null> {
	const info = await stat(userRoot).catch(() => null);
	if (info !== null && !info.isDirectory()) {
		return `--user-root is not a directory: ${userRoot}`;
	}
	return null;
}

/**
 * CLI implementation with injected execution and IO.
 *
 * Tests use this entry point to prove that preview performs no install,
 * registration or config write, and that apply propagates the isolated user env.
 */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
	const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		stderr(`error: ${parsed.error}\n\n${USAGE}`);
		return 2;
	}
	const options = parsed.options;
	if (options.help) {
		stdout(USAGE);
		return 0;
	}

	const run = dependencies.run ?? defaultRunner;
	const releaseBaseDir = path.resolve(options.releaseBaseDir ?? defaultReleaseBase());
	const userRoot = path.resolve(options.userRoot ?? defaultUserRoot());
	const projectRoot = options.projectRoot === null ? null : path.resolve(options.projectRoot);

	const checks = preflight(run);
	const report: Record<string, unknown> = {
		mode: options.mode,
		checks,
		candidate: null,
		registration: { performed: false, ok: null, detail: "not run" },
		configuration: { legacyProjectRoot: projectRoot, targets: [], applied: false, failures: [] },
		activation: "unverified",
	};

	const writeReport = (): void => {
		if (options.json) {
			stdout(`${JSON.stringify(report, null, 2)}\n`);
			return;
		}
		stdout("omp-wb-bridge installer\n\nEnvironment:\n");
		printChecks(checks, stdout);
		const candidate = report.candidate as
			| { version: string; digest: string; releasePath: string; action: ReleaseAction; reason: string | null }
			| null;
		if (candidate !== null) {
			stdout("\nCandidate:\n");
			stdout(`  version: ${candidate.version}\n`);
			stdout(`  digest: ${candidate.digest}\n`);
			stdout(`  release: ${candidate.releasePath}\n`);
			stdout(`  action: ${candidate.action}${candidate.reason === null ? "" : ` (${candidate.reason})`}\n`);
		}
		const registration = report.registration as { performed: boolean; ok: boolean | null; detail: string };
		stdout("\nRegistration:\n");
		if (!registration.performed) {
			stdout(`  not run (${registration.detail})\n`);
		} else {
			stdout(`  [${registration.ok === true ? "ok  " : "FAIL"}] ${registration.detail}\n`);
		}
		const configuration = report.configuration as {
			legacyProjectRoot: string | null;
			targets: Array<{ filePath: string; missing: boolean; blockedReason: string | null }>;
			applied: boolean;
			failures: Array<{ filePath: string; reason: string }>;
		};
		stdout("\nConfiguration:\n");
		if (configuration.targets.length === 0) {
			stdout("  (no targets)\n");
		}
		for (const target of configuration.targets) {
			stdout(
				`  ${target.blockedReason === null ? (configuration.applied ? "written" : "will write") : "BLOCKED"} ${target.filePath}${target.missing ? " (new file)" : ""}\n`,
			);
			if (target.blockedReason !== null) {
				stdout(`    ${target.blockedReason}\n`);
			}
		}
		for (const failure of configuration.failures) {
			stdout(`  [FAIL] ${failure.filePath}: ${failure.reason}\n`);
		}
		if (configuration.legacyProjectRoot !== null) {
			stdout(`  legacy project cleanup checked: ${configuration.legacyProjectRoot}\n`);
		}
		stdout("\nActivation: unverified — a restart and an actual host start are required.\n");
		if (options.mode === "preview") {
			stdout("\nPreview only: nothing was copied, installed, registered or configured. Re-run with --apply.\n");
		}
	};

	if (checks.some((check) => !check.ok)) {
		writeReport();
		return 1;
	}

	let candidate: ReleaseCandidate;
	try {
		const plan = await planRelease({ sourceRoot: dependencies.sourceRoot, releaseBaseDir });
		candidate = plan.candidate;
		report.candidate = {
			version: plan.candidate.version,
			digest: plan.candidate.digest,
			releasePath: plan.candidate.releasePath,
			action: plan.action,
			reason: plan.reason,
		};
		if (plan.action === "refuse") {
			writeReport();
			return 1;
		}
	} catch (err: unknown) {
		stderr(`error: ${failureMessage(err)}\n`);
		return 1;
	}

	const rootIssue = await userRootProblem(userRoot);
	if (rootIssue !== null) {
		stderr(`error: ${rootIssue}\n`);
		return 1;
	}
	if (projectRoot !== null) {
		const issue = await projectProblem(projectRoot, candidate);
		if (issue !== null) {
			stderr(`error: ${issue}\n`);
			return 1;
		}
	}

	const bunExecutable = Bun.which("bun") ?? process.execPath;
	const configuration = await previewConfiguration({
		legacyProjectRoot: projectRoot,
		userRoot,
		bunExecutable,
		mcpEntrypoint: path.join(candidate.releasePath, "src", "mcp.ts"),
	});
	report.configuration = {
		legacyProjectRoot: projectRoot,
		targets: configurationSummary(configuration),
		applied: false,
		failures: [],
	};

	if (options.mode === "preview") {
		writeReport();
		return 0;
	}

	// Only an explicit --apply reaches this point with mutation enabled.
	await mkdir(userRoot, { recursive: true });
	const release = await applyRelease(await planRelease({ sourceRoot: dependencies.sourceRoot, releaseBaseDir }), {
		run,
	});
	if (!release.verified) {
		report.release = release;
		writeReport();
		stderr(`error: release install failed: ${release.failure ?? "unknown failure"}\n`);
		return 1;
	}
	report.release = release;

	const env = isolatedUserEnv(userRoot);
	const registration = await registerPlugin(candidate, { run, env });
	report.registration = {
		performed: true,
		ok: registration.check.ok,
		detail: registration.check.detail,
		identity: registration.identity,
	};
	if (!registration.check.ok) {
		writeReport();
		return 1;
	}

	let exitCode = 0;
	if (!configuration.applicable) {
		report.configuration = {
			legacyProjectRoot: projectRoot,
			targets: configurationSummary(configuration),
			applied: false,
			failures: configuration.targets
				.filter((target) => target.blockedReason !== null)
				.map((target) => ({ filePath: target.filePath, reason: target.blockedReason! })),
		};
		exitCode = 1;
	} else {
		const applied = await applyIntegration({ targets: configuration.targets, applicable: true });
		report.configuration = {
			legacyProjectRoot: projectRoot,
			targets: configurationSummary(configuration),
			applied: applied.failed.length === 0,
			failures: applied.failed,
			diverged: applied.diverged,
		};
		if (applied.failed.length > 0 || applied.diverged.length > 0) {
			exitCode = 1;
		}
	}

	report.activation = "unverified";
	writeReport();
	return exitCode;
}

async function main(): Promise<number> {
	return runCli(process.argv.slice(2));
}

// Only run when executed, never when imported: the helpers above are covered by
// tests, and importing them must not touch the machine.
if (import.meta.main) {
	process.exitCode = await main();
}
