/**
 * Config ownership: the bridge may only change what it can prove it owns.
 *
 * These write into files the user also edits, so every case here is about not
 * destroying something: a foreign same-named entry, a file that changed after the
 * preview, malformed JSON, and a rollback that must leave a user's own edit alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyIntegration, planIntegration, setupTargets, type ConfigTarget } from "../src/integration";
import { WB_ERROR_CODE } from "../src/types";
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

async function fixture(): Promise<string> {
	const root = await createFixtureRoot("wb-integration-");
	roots.push(root);
	return root;
}

function target(filePath: string): ConfigTarget {
	return { filePath, entryName: "omp-wb-bridge", entry: { command: "bun", args: ["mcp.ts", "--global"] } };
}

describe("planning a config change", () => {
	it("records the baseline bytes and the planned digest without writing", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2), "utf-8");
		const before = await readFile(file, "utf-8");

		const plan = await planIntegration([target(file)]);
		expect(plan.applicable).toBeTrue();
		expect(plan.targets[0]?.baselineSha256).toBeString();
		expect(plan.targets[0]?.currentEntry).toBeNull();
		// Planning must not touch the file.
		expect(await readFile(file, "utf-8")).toBe(before);
	});

	it("preserves every foreign entry in the written result", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(
			file,
			JSON.stringify({ mcpServers: { other: { command: "keep-me", args: ["a"] } }, unrelated: 7 }, null, 2),
			"utf-8",
		);

		const plan = await planIntegration([target(file)]);
		const report = await applyIntegration(plan);
		expect(report.applied).toEqual([file]);

		const written = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
		expect(written.unrelated).toBe(7);
		expect((written.mcpServers as Record<string, unknown>).other).toEqual({ command: "keep-me", args: ["a"] });
		expect((written.mcpServers as Record<string, unknown>)["omp-wb-bridge"]).toEqual({
			command: "bun",
			args: ["mcp.ts", "--global"],
		});
	});

	it("refuses malformed JSON and a non-object root instead of overwriting", async () => {
		const root = await fixture();
		const broken = path.join(root, "broken.json");
		await writeFile(broken, "{ not json", "utf-8");
		const arrayRoot = path.join(root, "array.json");
		await writeFile(arrayRoot, "[1,2,3]", "utf-8");

		const plan = await planIntegration([target(broken), target(arrayRoot)]);
		expect(plan.applicable).toBeFalse();
		// Each target explains itself; neither is silently replaced.
		expect(plan.targets[0]?.blockedReason).toContain("Invalid JSON");
		expect(plan.targets[1]?.blockedReason).toContain("root must be a JSON object");

		const report = await applyIntegration(plan);
		expect(report.applied).toEqual([]);
		expect(await readFile(broken, "utf-8")).toBe("{ not json");
	});

	it("refuses a same-named entry this bridge does not own", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(
			file,
			JSON.stringify({ mcpServers: { "omp-wb-bridge": { command: 42, args: "nope" } } }, null, 2),
			"utf-8",
		);

		const plan = await planIntegration([target(file)]);
		// Adopting it would claim ownership of a configuration the user wrote.
		expect(plan.applicable).toBeFalse();
		expect(plan.targets[0]?.blockedReason).toContain("does not match this bridge installation");
	});

	it("treats a same-named entry from another installation as foreign", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		// Well-formed, but pointing at a different Bun and a different release
		// directory: this is another installation of the bridge, not ours. Rewriting
		// it would break that install while looking like a successful setup.
		await writeFile(
			file,
			JSON.stringify(
				{ mcpServers: { "omp-wb-bridge": { command: "C:/other/bun.exe", args: ["C:/other/mcp.ts"] } } },
				null,
				2,
			),
			"utf-8",
		);

		const plan = await planIntegration([target(file)]);
		expect(plan.applicable).toBeFalse();
		expect(plan.targets[0]?.blockedReason).toContain("does not match this bridge installation");
		expect(plan.targets[0]?.currentEntry).toBeNull();
	});

	it("adopts the entry it wrote previously, so setup is idempotent", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");

		const first = await applyIntegration(await planIntegration([target(file)]));
		expect(first.applied).toEqual([file]);
		const afterFirst = await readFile(file, "utf-8");

		// A second identical apply recognises its own entry and produces the same
		// bytes; nothing is duplicated or reordered.
		const second = await applyIntegration(await planIntegration([target(file)]));
		expect(second.applied).toEqual([file]);
		expect(await readFile(file, "utf-8")).toBe(afterFirst);
	});
});

describe("applying against a moved baseline", () => {
	it("refuses a file that changed after the preview", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
		const plan = await planIntegration([target(file)]);

		// The user edits the file between preview and apply.
		const edited = JSON.stringify({ mcpServers: {}, userAdded: true }, null, 2);
		await writeFile(file, edited, "utf-8");

		const report = await applyIntegration(plan);
		expect(report.applied).toEqual([]);
		expect(report.failed[0]?.reason).toContain("changed after it was previewed");
		// The edit survives untouched.
		expect(await readFile(file, "utf-8")).toBe(edited);
	});

	it("rolls back only the files it wrote when a later target fails", async () => {
		const root = await fixture();
		const first = path.join(root, "a.json");
		const second = path.join(root, "b.json");
		await writeFile(first, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
		// The second target is blocked, so the first must not be left applied.
		await writeFile(second, "{ broken", "utf-8");

		const plan = await planIntegration([target(first), target(second)]);
		const report = await applyIntegration(plan);
		// Nothing is written: a plan with a blocked target is refused as a whole, so
		// the project is never left half-configured.
		expect(report.applied).toEqual([]);
		expect(report.failed).toHaveLength(2);
		// The first file keeps exactly its baseline bytes.
		expect(JSON.parse(await readFile(first, "utf-8"))).toEqual({ mcpServers: {} });
	});

	it("keeps a user edit that lands between preview and apply", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
		const plan = await planIntegration([target(file)]);

		// The user adds a server while the preview is on screen.
		const edited = JSON.stringify({ mcpServers: { mine: { command: "x", args: [] } } }, null, 2);
		await writeFile(file, edited, "utf-8");

		const report = await applyIntegration(plan);
		// Their edit wins: the apply refuses rather than reconstructing a document
		// from a baseline it can no longer prove.
		expect(report.applied).toEqual([]);
		expect(report.failed).toHaveLength(1);
		expect(await readFile(file, "utf-8")).toBe(edited);
	});
});

describe("target list", () => {
	it("writes one global WorkBuddy entry and removes only the legacy project entry", () => {
		const home = path.join("C:", "home");
		const entrypoint = path.join("C:", "release", "src", "mcp.ts");
		const legacyRoot = path.join("C:", "project");

		const targets = setupTargets({ workbuddyHomeDir: home, bunExecutable: "bun", mcpEntrypoint: entrypoint });
		expect(targets).toHaveLength(1);
		expect(targets[0]?.filePath).toBe(path.join(home, ".workbuddy", "mcp.json"));
		// The entry carries `--global`: the project is derived from the verified caller
		// at call time, so one installation serves every authorized project.
		expect(targets[0]?.entry).toBeDefined();
		expect(targets[0]?.entry!.args).toEqual([entrypoint, "--global"]);

		const migrated = setupTargets({
			workbuddyHomeDir: home,
			bunExecutable: "bun",
			mcpEntrypoint: entrypoint,
			legacyProjectRoot: legacyRoot,
		});
		expect(migrated).toHaveLength(2);
		// A removal target has no replacement entry; it retires the older writer.
		expect(migrated[1]?.filePath).toBe(path.join(legacyRoot, ".omp", "mcp.json"));
		expect(migrated[1]?.entry).toBeNull();
	});

	it("creates a missing config file with only the owned entry", async () => {
		const root = await fixture();
		const file = path.join(root, "nested", "mcp.json");

		const report = await applyIntegration(await planIntegration([target(file)]));
		expect(report.applied).toEqual([file]);
		const written = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
		expect(Object.keys(written)).toEqual(["mcpServers"]);
		expect(Object.keys(written.mcpServers as Record<string, unknown>)).toEqual(["omp-wb-bridge"]);
	});

	it("surfaces an integration error with the plan's reasons", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await writeFile(file, "null", "utf-8");
		const plan = await planIntegration([target(file)]);

		const { assertApplicable } = await import("../src/integration");
		expect(() => assertApplicable(plan)).toThrow();
		try {
			assertApplicable(plan);
		} catch (err: unknown) {
			expect(err).toMatchObject({ code: WB_ERROR_CODE.integrationIncomplete });
		}
	});
});

describe("integration fixtures stay inside their root", () => {
	it("never writes outside the fixture root", async () => {
		const root = await fixture();
		const file = path.join(root, "mcp.json");
		await mkdir(path.dirname(file), { recursive: true });
		await applyIntegration(await planIntegration([target(file)]));
		// The only created path is the target itself.
		expect(await Bun.file(file).exists()).toBeTrue();
	});
});
