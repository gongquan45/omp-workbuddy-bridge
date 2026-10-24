/**
 * Installer behaviour on a real owned fixture filesystem.
 *
 * Process execution is injected, so these tests never run a real `bun install`,
 * register a plugin with the operator's OMP, or touch a real WorkBuddy config.
 * What they do exercise is the part that must be true in production: an existing
 * directory is reused only after byte/dependency verification, a partial
 * directory is refused, preview writes nothing, and apply's OMP children see the
 * isolated user root.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	applyRelease,
	atLeast,
	inspectCandidate,
	isolatedUserEnv,
	planRelease,
	preflight,
	runCli,
	verifyRegistration,
	type ProcessRunner,
	type RunOptions,
} from "../src/install";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await removeFixtureRoot(root);
		}
	}
});

async function fixtureRoot(prefix: string): Promise<string> {
	const root = await createFixtureRoot(prefix);
	roots.push(root);
	return root;
}

interface SourceOptions {
	version?: string;
	marker?: string;
	dependencies?: string[];
}

/** A minimal but complete release payload; directory contents are the identity. */
async function createSource(root: string, options: SourceOptions = {}): Promise<string> {
	const source = path.join(root, "source");
	await mkdir(path.join(source, "src"), { recursive: true });
	await mkdir(path.join(source, "skills", "demo"), { recursive: true });
	const dependencies = Object.fromEntries((options.dependencies ?? []).map((name) => [name, "1.0.0"]));
	await writeFile(
		path.join(source, "package.json"),
		`${JSON.stringify(
			{
				name: "omp-wb-bridge",
				version: options.version ?? "2.1.0",
				type: "module",
				dependencies,
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(path.join(source, "bun.lock"), "lockfile-v1\n");
	await writeFile(path.join(source, "tsconfig.json"), "{}\n");
	const marker = options.marker ?? "release-a";
	await writeFile(path.join(source, "src", "mcp.ts"), `// ${marker}\n`);
	await writeFile(path.join(source, "skills", "demo", "SKILL.md"), `# ${marker}\n`);
	return source;
}

interface RecordedCall {
	command: string[];
	options: RunOptions;
}

interface FakeRunnerOptions {
	bunVersion?: string;
	ompVersion?: string;
	failInstall?: boolean;
	listedVersion?: string;
	listedPath?: (installedPath: string) => string;
}

function ok(stdout: string): { exitCode: number; stdout: string; stderr: string } {
	return { exitCode: 0, stdout, stderr: "" };
}

/**
 * Records every command; `bun install` creates the dependency directories the
 * fake package declares, and plugin list echoes back the path that was installed.
 */
function fakeRunner(options: FakeRunnerOptions = {}): {
	run: ProcessRunner;
	calls: RecordedCall[];
	state: { installedPath: string | null };
} {
	const calls: RecordedCall[] = [];
	const state = { installedPath: null as string | null };
	const run: ProcessRunner = (command, runOptions) => {
		calls.push({ command: [...command], options: runOptions });
		if (command[0] === "bun" && command[1] === "--version") {
			return ok(`${options.bunVersion ?? "1.4.0"}\n`);
		}
		if (command[0] === "omp" && command[1] === "--version") {
			return ok(`${options.ompVersion ?? "omp/18.12.3"}\n`);
		}
		if (command[0] === "bun" && command[1] === "install") {
			if (options.failInstall === true) {
				return { exitCode: 1, stdout: "", stderr: "registry unavailable" };
			}
			if (runOptions.cwd === undefined) {
				return { exitCode: 1, stdout: "", stderr: "missing cwd" };
			}
			const manifest = JSON.parse(readFileSync(path.join(runOptions.cwd, "package.json"), "utf-8")) as {
				dependencies?: Record<string, string>;
			};
			for (const dependency of Object.keys(manifest.dependencies ?? {})) {
				const directory = path.join(runOptions.cwd, "node_modules", dependency);
				mkdirSync(directory, { recursive: true });
				writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: dependency, version: "1.0.0" }));
			}
			return ok("");
		}
		if (command[0] === "omp" && command[1] === "plugin" && command[2] === "install") {
			state.installedPath = command[3] ?? null;
			return ok("Installed omp-wb-bridge\n");
		}
		if (command[0] === "omp" && command[1] === "plugin" && command[2] === "list") {
			const reported = options.listedPath?.(state.installedPath ?? "") ?? state.installedPath ?? "";
			return ok(
				`${JSON.stringify({
					npm: [
						{
							name: "omp-wb-bridge",
							version: options.listedVersion ?? "2.1.0",
							path: reported,
							enabled: true,
						},
					],
					marketplace: [],
				})}\n`,
			);
		}
		return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command.join(" ")}` };
	};
	return { run, calls, state };
}

describe("version gating", () => {
	it("compares numeric versions, including the host's prefixed version line", () => {
		expect(atLeast("18.10.3", "18.10.3")).toBeTrue();
		expect(atLeast("18.11.0", "18.10.3")).toBeTrue();
		expect(atLeast("v1.4.0", "1.4.0")).toBeTrue();
		expect(atLeast("omp/18.12.3", "18.10.3")).toBeTrue();
		expect(atLeast("Bun 1.4.0-canary.7", "1.4.0")).toBeTrue();
	});

	it("refuses older and unparseable versions", () => {
		expect(atLeast("18.10.2", "18.10.3")).toBeFalse();
		expect(atLeast("2.0.0", "18.10.3")).toBeFalse();
		expect(atLeast("not-a-version", "1.4.0")).toBeFalse();
	});
});

describe("preflight", () => {
	it("accepts the actual host shape and names the host behind each failure", () => {
		const checks = preflight(fakeRunner().run);
		expect(checks.map((check) => check.name)).toEqual(["Bun", "OMP"]);
		expect(checks.every((check) => check.ok)).toBeTrue();

		const old = preflight(fakeRunner({ ompVersion: "omp/18.9.0" }).run);
		expect(old[1]?.ok).toBeFalse();
		expect(old[1]?.detail).toContain("18.9.0");
		expect(old[1]?.advice).toContain("18.10.3");
	});
});

describe("candidate identity", () => {
	it("is content-addressed: same bytes reuse one identity, changed bytes get another", async () => {
		const firstRoot = await fixtureRoot("wb-install-a-");
		const secondRoot = await fixtureRoot("wb-install-b-");
		const source = await createSource(firstRoot);
		const base = path.join(firstRoot, "releases");

		const first = await inspectCandidate({ sourceRoot: source, releaseBaseDir: base });
		const repeated = await inspectCandidate({ sourceRoot: source, releaseBaseDir: base });
		expect(repeated.digest).toBe(first.digest);
		expect(repeated.releasePath).toBe(first.releasePath);

		const changed = await createSource(secondRoot, { marker: "release-b" });
		const other = await inspectCandidate({ sourceRoot: changed, releaseBaseDir: base });
		expect(other.digest).not.toBe(first.digest);
		expect(other.releasePath).not.toBe(first.releasePath);
	});

	it("keeps two builds of the same version as distinct candidates", async () => {
		const root = await fixtureRoot("wb-install-distinct-");
		const source = await createSource(root);
		const base = path.join(root, "releases");
		const firstPlan = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		const applied = await applyRelease(firstPlan, { run: fakeRunner().run });
		expect(applied.verified).toBeTrue();

		await writeFile(path.join(source, "src", "mcp.ts"), "// release-b\n");
		const secondPlan = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect(secondPlan.action).toBe("create");
		expect(secondPlan.candidate.version).toBe(firstPlan.candidate.version);
		expect(secondPlan.candidate.releasePath).not.toBe(firstPlan.candidate.releasePath);

		const secondApplied = await applyRelease(secondPlan, { run: fakeRunner().run });
		expect(secondApplied.verified).toBeTrue();
		expect(existsSync(firstPlan.candidate.releasePath)).toBeTrue();
		expect(existsSync(secondPlan.candidate.releasePath)).toBeTrue();
	});
});

describe("release apply and reuse", () => {
	it("installs a manifest-backed candidate and reuses it only while bytes and deps match", async () => {
		const root = await fixtureRoot("wb-install-reuse-");
		const source = await createSource(root, { dependencies: ["fixture-dep"] });
		const base = path.join(root, "releases");

		const plan = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect(plan.action).toBe("create");
		const result = await applyRelease(plan, { run: fakeRunner().run });
		expect(result.created).toBeTrue();
		expect(result.verified).toBeTrue();
		expect(result.failure).toBeNull();

		const manifest = JSON.parse(
			await readFile(path.join(plan.candidate.releasePath, "release-manifest.json"), "utf-8"),
		) as { digest: string; files: string[]; version: string };
		expect(manifest.digest).toBe(plan.candidate.digest);
		expect(manifest.version).toBe(plan.candidate.version);
		expect(manifest.files).toEqual(plan.candidate.files);
		expect(existsSync(path.join(plan.candidate.releasePath, "node_modules", "fixture-dep", "package.json"))).toBeTrue();

		expect((await planRelease({ sourceRoot: source, releaseBaseDir: base })).action).toBe("reuse");

		await writeFile(path.join(plan.candidate.releasePath, "src", "mcp.ts"), "// tampered\n");
		const tampered = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect(tampered.action).toBe("refuse");
		expect(tampered.reason).toContain("not reusable");
	});

	it("refuses an installed candidate whose dependencies disappeared", async () => {
		const root = await fixtureRoot("wb-install-deps-");
		const source = await createSource(root, { dependencies: ["fixture-dep"] });
		const base = path.join(root, "releases");
		const plan = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect((await applyRelease(plan, { run: fakeRunner().run })).verified).toBeTrue();

		await rm(path.join(plan.candidate.releasePath, "node_modules"), { recursive: true, force: true });
		const afterRemoval = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect(afterRemoval.action).toBe("refuse");
		expect(afterRemoval.reason).toContain("dependencies are incomplete");
	});

	it("never treats a partial directory as installed", async () => {
		const root = await fixtureRoot("wb-install-partial-");
		const source = await createSource(root);
		const base = path.join(root, "releases");
		const plan = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		await mkdir(plan.candidate.releasePath, { recursive: true });
		const stray = path.join(plan.candidate.releasePath, "stray.txt");
		await writeFile(stray, "keep me\n");

		const refused = await planRelease({ sourceRoot: source, releaseBaseDir: base });
		expect(refused.action).toBe("refuse");
		expect(refused.reason).toContain("partial");

		const attempted = await applyRelease(refused, { run: fakeRunner().run });
		expect(attempted.created).toBeFalse();
		expect(attempted.verified).toBeFalse();
		expect(attempted.failure).toContain("not reusable");
		expect(await readFile(stray, "utf-8")).toBe("keep me\n");
	});

	it("reports a failed dependency install and leaves no candidate behind", async () => {
		const root = await fixtureRoot("wb-install-fail-");
		const source = await createSource(root, { dependencies: ["fixture-dep"] });
		const base = path.join(root, "releases");
		const plan = await planRelease({ sourceRoot: source, releaseBaseDir: base });

		const result = await applyRelease(plan, { run: fakeRunner({ failInstall: true }).run });
		expect(result.created).toBeFalse();
		expect(result.verified).toBeFalse();
		expect(result.failure).toContain("bun install");
		expect(existsSync(plan.candidate.releasePath)).toBeFalse();
		expect(await readdir(base)).toEqual([]);
	});
});

describe("registration identity", () => {
	it("matches the exact structured name, version and resolved release path", async () => {
		const root = await fixtureRoot("wb-install-register-");
		const releasePath = path.join(root, "release");
		await mkdir(releasePath, { recursive: true });
		const expected = { name: "omp-wb-bridge", version: "2.1.0", releasePath };
		const good = JSON.stringify({
			npm: [{ name: "omp-wb-bridge", version: "2.1.0", path: releasePath, enabled: true }],
			marketplace: [],
		});
		expect((await verifyRegistration(good, expected)).ok).toBeTrue();

		const wrongPath = JSON.stringify({
			npm: [{ name: "omp-wb-bridge", version: "2.1.0", path: path.join(root, "other"), enabled: true }],
		});
		expect((await verifyRegistration(wrongPath, expected)).ok).toBeFalse();

		const wrongVersion = JSON.stringify({
			npm: [{ name: "omp-wb-bridge", version: "2.1.1", path: releasePath, enabled: true }],
		});
		expect((await verifyRegistration(wrongVersion, expected)).ok).toBeFalse();

		const substringName = JSON.stringify({
			npm: [{ name: "omp-wb-bridge-old", version: "2.1.0", path: releasePath, enabled: true }],
		});
		expect((await verifyRegistration(substringName, expected)).ok).toBeFalse();

		const ambiguous = JSON.stringify({
			npm: [
				{ name: "omp-wb-bridge", version: "2.1.0", path: releasePath, enabled: true },
				{ name: "omp-wb-bridge", version: "2.1.0", path: path.join(root, "other"), enabled: true },
			],
		});
		expect((await verifyRegistration(ambiguous, expected)).ok).toBeFalse();

		expect((await verifyRegistration("not json", expected)).ok).toBeFalse();
	});

	it("refuses a disabled registration", async () => {
		const root = await fixtureRoot("wb-install-disabled-");
		const releasePath = path.join(root, "release");
		await mkdir(releasePath, { recursive: true });
		const listing = JSON.stringify({
			npm: [{ name: "omp-wb-bridge", version: "2.1.0", path: releasePath, enabled: false }],
		});
		const result = await verifyRegistration(listing, { name: "omp-wb-bridge", version: "2.1.0", releasePath });
		expect(result.ok).toBeFalse();
		expect(result.detail).toContain("disabled");
	});
});

describe("CLI isolation and mutation boundary", () => {
	it("propagates an isolated HOME/USERPROFILE to OMP children", async () => {
		const root = await fixtureRoot("wb-install-env-");
		const user = path.join(root, "user");
		const env = isolatedUserEnv(user);
		expect(env.HOME).toBe(path.resolve(user));
		expect(env.USERPROFILE).toBe(path.resolve(user));
		for (const value of Object.values(env)) {
			expect(value.startsWith(path.resolve(user))).toBeTrue();
		}
	});

	it("preview performs no copy, install, registration or configuration write", async () => {
		const root = await fixtureRoot("wb-install-preview-");
		const source = await createSource(root);
		const base = path.join(root, "releases");
		const user = path.join(root, "user");
		const project = path.join(root, "project");
		await mkdir(project);
		const fake = fakeRunner();
		const output: string[] = [];
		const errors: string[] = [];

		const code = await runCli(
			["--preview", "--release-root", base, "--user-root", user, "--project", project],
			{
				run: fake.run,
				sourceRoot: source,
				stdout: (text) => output.push(text),
				stderr: (text) => errors.push(text),
			},
		);

		expect(code).toBe(0);
		expect(errors).toEqual([]);
		expect(existsSync(base)).toBeFalse();
		expect(existsSync(user)).toBeFalse();
		expect(existsSync(path.join(project, ".omp"))).toBeFalse();
		expect(fake.calls.every((call) => call.command[1] === "--version")).toBeTrue();
		expect(output.join("")).toContain("Preview only");
	});

	it("preview --json reports the plan and leaves activation unverified", async () => {
		const root = await fixtureRoot("wb-install-preview-json-");
		const source = await createSource(root);
		const base = path.join(root, "releases");
		const user = path.join(root, "user");
		const output: string[] = [];

		const code = await runCli(["--preview", "--json", "--release-root", base, "--user-root", user], {
			run: fakeRunner().run,
			sourceRoot: source,
			stdout: (text) => output.push(text),
			stderr: () => undefined,
		});

		expect(code).toBe(0);
		const report = JSON.parse(output.join("")) as {
			mode: string;
			activation: string;
			candidate: { action: string; digest: string };
			registration: { performed: boolean };
			configuration: { targets: Array<{ filePath: string }> };
		};
		expect(report.mode).toBe("preview");
		expect(report.activation).toBe("unverified");
		expect(report.candidate.action).toBe("create");
		expect(report.candidate.digest.startsWith("sha256:")).toBeTrue();
		expect(report.registration.performed).toBeFalse();
		expect(report.configuration.targets.some((target) => target.filePath.endsWith(path.join(".workbuddy", "mcp.json")))).toBeTrue();
	});

	it("apply installs once at user level, registers the exact path, and writes no legacy project install", async () => {
		const root = await fixtureRoot("wb-install-apply-");
		const source = await createSource(root, { dependencies: ["fixture-dep"] });
		const base = path.join(root, "releases");
		const user = path.join(root, "user");
		const project = path.join(root, "project");
		await mkdir(project);
		const fake = fakeRunner();
		const output: string[] = [];

		const code = await runCli(
			["--apply", "--release-root", base, "--user-root", user, "--project", project],
			{
				run: fake.run,
				sourceRoot: source,
				stdout: (text) => output.push(text),
				stderr: (text) => output.push(text),
			},
		);

		expect(code).toBe(0);
		const releasePath = fake.state.installedPath;
		expect(releasePath).not.toBeNull();
		expect(existsSync(path.join(releasePath!, "release-manifest.json"))).toBeTrue();
		expect(existsSync(path.join(user, ".workbuddy", "mcp.json"))).toBeTrue();
		expect(existsSync(path.join(project, ".omp", "mcp.json"))).toBeFalse();

		const config = JSON.parse(await readFile(path.join(user, ".workbuddy", "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, { command: string; args: string[] }>;
		};
		const entry = config.mcpServers["omp-wb-bridge"];
		expect(entry).toBeDefined();
		expect(entry!.args).toEqual([path.join(releasePath!, "src", "mcp.ts"), "--global"]);
		expect(entry!.args).not.toContain("--project");

		const ompCalls = fake.calls.filter((call) => call.command[0] === "omp" && call.command[1] === "plugin");
		expect(ompCalls).toHaveLength(2);
		for (const call of ompCalls) {
			expect(call.options.env?.HOME).toBe(path.resolve(user));
			expect(call.options.env?.USERPROFILE).toBe(path.resolve(user));
		}
		// The installer never reports activation as proven: only a real host start can.
		expect(output.join("")).toContain("Activation: unverified");
		// The registered identity is reported as the exact release path and version,
		// which is what "installed" means here — never an inferred activation.
		expect(output.join("")).toContain("registered omp-wb-bridge@2.1.0");
	});

	it("fails closed on unknown options without touching the filesystem or running a process", async () => {
		const root = await fixtureRoot("wb-install-unknown-");
		const source = await createSource(root);
		const base = path.join(root, "releases");
		const fake = fakeRunner();
		const errors: string[] = [];

		const code = await runCli(["--applyy", "--release-root", base], {
			run: fake.run,
			sourceRoot: source,
			stdout: () => undefined,
			stderr: (text) => errors.push(text),
		});

		expect(code).toBe(2);
		expect(fake.calls).toEqual([]);
		expect(existsSync(base)).toBeFalse();
		expect(errors.join("")).toContain("unknown option");
	});
});
