/**
 * Shared MCP configuration management: plan, preview, apply, undo.
 *
 * The safety property this module exists for is *ownership*: the bridge writes
 * entries into files it does not own (a user's `~/.workbuddy/mcp.json`, a
 * project's `.omp/mcp.json`), so every change is recorded with the exact bytes it
 * replaced. An apply refuses to touch a file whose baseline moved, and a rollback
 * restores only files still holding precisely what this apply wrote — a user edit
 * made in between is preserved and reported rather than overwritten.
 *
 * Two kinds of target exist now:
 *
 *  - the single WorkBuddy read-only context entry, launched with `--global` so
 *    the project is derived from the verified caller instead of being pinned to
 *    an install checkout;
 *  - a removal target for the legacy OMP-side entry that used to expose the
 *    write tools. Removing it is a cutover, not a preference: an entry pointing
 *    at an older release would still launch the old writer server.
 *
 * Entries written by an earlier version of this bridge (same install root, a
 * `src/mcp.ts` script, only known flags) are recognised as owned and migrated.
 * Anything else under the same name is foreign and blocks the plan, because
 * rewriting another installation would break it while looking successful.
 *
 * Nothing here reads or stores a whole configuration file beyond the memory of
 * one call, and no credential, token or foreign entry is ever recorded.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { WB_ERROR_CODE, WbTaskError } from "./types";

/**
 * The shape this module reads out of an MCP config file.
 *
 * A config file is outside-controlled data, so it is parsed once here and the
 * typed result is what the rest of the module consumes — no field-by-field runtime
 * guards. Unknown keys are preserved via `looseObject`, because the bridge only
 * owns one entry and must not drop a user's other servers.
 */
const McpEntrySchema = z.object({
	command: z.string(),
	args: z.array(z.string()),
});

const McpConfigSchema = z.looseObject({
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

type McpConfig = z.infer<typeof McpConfigSchema>;
type McpEntry = { command: string; args: string[] };

/** One managed file target. */
export interface ConfigTarget {
	/** Absolute path of the file. */
	filePath: string;
	/** Stable name of the entry this bridge owns in that file. */
	entryName: string;
	/**
	 * The entry to write, or `null` to remove a bridge-owned entry.
	 *
	 * A removal target is how the legacy OMP-side write server is retired; it is
	 * never used to delete an entry this bridge cannot prove it wrote.
	 */
	entry: McpEntry | null;
}

/**
 * What a plan will do to one entry.
 *
 * `migrate` is distinct from `update`: the existing entry is a previous release
 * of this bridge, so the preview can say the old path/flags are being replaced
 * rather than presenting it as an ordinary edit.
 */
export type IntegrationAction = "create" | "update" | "migrate" | "remove" | "unchanged";

/** What one target looked like before a plan was applied. */
export interface TargetBaseline {
	filePath: string;
	entryName: string;
	/** True when the file did not exist. */
	missing: boolean;
	/** SHA-256 of the bytes read, or `null` when the file did not exist. */
	baselineSha256: string | null;
	/** The managed entry currently present, when this bridge owns it. */
	currentEntry: McpEntry | null;
}

/** What one target will look like once applied. */
export interface TargetPlan extends TargetBaseline {
	/** The bytes to write, serialized deterministically. */
	content: string;
	/** SHA-256 of `content`, so a later rollback can prove what it wrote. */
	plannedSha256: string;
	/** Why this target cannot be applied, when it cannot. */
	blockedReason: string | null;
	/** The entry-level change this target performs. */
	action: IntegrationAction;
}

/** A complete, previewable plan. */
export interface IntegrationPlan {
	targets: TargetPlan[];
	/** True when every target can be applied as planned. */
	applicable: boolean;
}

/** What an apply actually did. */
export interface ApplyReport {
	applied: string[];
	failed: Array<{ filePath: string; reason: string }>;
	/** Files that could not be rolled back because they had changed. */
	diverged: string[];
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Reads a file's bytes, distinguishing "absent" from "unreadable". */
async function readIfPresent(filePath: string): Promise<{ missing: boolean; content: string | null }> {
	try {
		return { missing: false, content: await readFile(filePath, "utf-8") };
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return { missing: true, content: null };
		}
		throw err;
	}
}

/** The install tree an entrypoint belongs to, or null when it is not absolute. */
function installRootFor(entrypoint: string): string | null {
	if (!path.isAbsolute(entrypoint)) {
		return null;
	}
	const packageDir = path.dirname(path.dirname(entrypoint));
	const parent = path.dirname(packageDir);
	// The installer keeps releases under <root>/releases/<version>; a release
	// entrypoint must be recognised across versions, not only its own.
	return path.basename(parent) === "releases" ? path.dirname(parent) : packageDir;
}

/**
 * True when `script` is an `src/mcp.ts` belonging to the same install tree.
 *
 * Ownership is proved by location, not by the entry name: the name alone is not
 * evidence, and a second checkout of this bridge must stay foreign rather than
 * being silently rewritten. Relative scripts cannot be located and are refused.
 */
function isBridgeScript(script: string, installRoot: string | null): boolean {
	if (installRoot === null || !path.isAbsolute(script)) {
		return false;
	}
	const relative = path.relative(installRoot, path.resolve(script));
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
		return false;
	}
	const parts = relative.split(path.sep);
	return parts.length >= 2 && parts[parts.length - 2] === "src" && parts[parts.length - 1] === "mcp.ts";
}

/**
 * True when the arguments after the script are flags this bridge has written.
 *
 * This is a signature check, not a general CLI parser: any unknown flag makes
 * the entry foreign, so a same-named entry for another tool is never adopted.
 */
function hasBridgeFlags(args: string[]): boolean {
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--global") {
			continue;
		}
		if (arg === "--project") {
			if (index + 1 >= args.length || args[index + 1]!.length === 0) {
				return false;
			}
			index++;
			continue;
		}
		if (arg === "--agent") {
			const value = args[index + 1];
			if (value !== "omp" && value !== "workbuddy") {
				return false;
			}
			index++;
			continue;
		}
		return false;
	}
	return true;
}

function entriesEqual(left: McpEntry, right: McpEntry): boolean {
	return (
		left.command === right.command &&
		left.args.length === right.args.length &&
		left.args.every((arg, index) => arg === right.args[index])
	);
}

/**
 * Reads the managed entry out of a config document.
 *
 * Returns `null` when the bridge has never written that name, and the owned
 * entry when it has. A same-named entry that cannot be proved to belong to this
 * install is reported through `blockedReason` instead of being adopted: adopting
 * it would claim ownership of a configuration the user or another installation
 * made.
 */
function readManagedEntry(
	document: McpConfig,
	entryName: string,
	planned: McpEntry | null,
	installRoot: string | null,
): { entry: McpEntry | null; foreign: boolean; legacy: boolean } {
	const servers = document.mcpServers;
	if (servers === undefined) {
		return { entry: null, foreign: false, legacy: false };
	}
	const candidate = servers[entryName];
	if (candidate === undefined) {
		return { entry: null, foreign: false, legacy: false };
	}
	const parsed = McpEntrySchema.safeParse(candidate);
	if (!parsed.success) {
		// Not even the shape this bridge writes, so it belongs to someone else.
		return { entry: null, foreign: true, legacy: false };
	}
	// An exact match is owned even when the planned entry is a relative test path;
	// the entry is byte-for-byte what this plan would write.
	if (planned !== null && entriesEqual(parsed.data, planned)) {
		return { entry: parsed.data, foreign: false, legacy: false };
	}
	// Otherwise ownership must come from the installation the entry launches.
	const script = parsed.data.args[0];
	const owned =
		script !== undefined &&
		isBridgeScript(script, installRoot) &&
		(planned === null || hasBridgeFlags(parsed.data.args));
	return owned
		? { entry: parsed.data, foreign: false, legacy: true }
		: { entry: null, foreign: true, legacy: false };
}

/**
 * Builds a plan for the given targets without writing anything.
 *
 * Every target is re-read here, so the baseline the plan records is the baseline
 * `apply` will verify against. A target whose existing content cannot be parsed,
 * whose root is not an object, or whose entry is foreign becomes blocked with a
 * reason instead of being silently rewritten. Removal targets that have nothing
 * to remove are omitted entirely, so a user's config is not rewritten just to
 * prove it has no bridge entry.
 */
export async function planIntegration(targets: ConfigTarget[]): Promise<IntegrationPlan> {
	const planned: TargetPlan[] = [];
	for (const target of targets) {
		let read: { missing: boolean; content: string | null };
		try {
			read = await readIfPresent(target.filePath);
		} catch (err: unknown) {
			planned.push({
				filePath: target.filePath,
				entryName: target.entryName,
				missing: false,
				baselineSha256: null,
				currentEntry: null,
				content: "",
				plannedSha256: "",
				blockedReason: `Cannot read ${target.filePath}: ${err instanceof Error ? err.message : String(err)}`,
				action: "unchanged",
			});
			continue;
		}

		const baselineSha256 = read.content === null ? null : sha256(read.content);
		let document: McpConfig = { mcpServers: {} };
		let currentEntry: McpEntry | null = null;
		let legacy = false;
		let blockedReason: string | null = null;

		if (!read.missing) {
			let raw: unknown;
			try {
				raw = JSON.parse(read.content!);
			} catch (err: unknown) {
				raw = undefined;
				blockedReason = `Invalid JSON in ${target.filePath}: ${
					err instanceof Error ? err.message : String(err)
				}; fix or remove the file, then retry`;
			}
			if (raw !== undefined) {
				const parsed = McpConfigSchema.safeParse(raw);
				if (!parsed.success) {
					// Name the shape the user has to fix, not the validator's internal path.
					blockedReason = `Malformed config at ${target.filePath}: root must be a JSON object with an mcpServers object`;
				} else {
					document = parsed.data;
					const script = target.entry?.args[0] ?? null;
					const managed = readManagedEntry(
						document,
						target.entryName,
						target.entry,
						script === null ? null : installRootFor(script),
					);
					currentEntry = managed.entry;
					legacy = managed.legacy;
					if (managed.foreign) {
						blockedReason = `${target.filePath} already has a "${target.entryName}" entry that does not match this bridge installation; resolve the difference first`;
					}
				}
			}
		}

		const servers: Record<string, unknown> = { ...(document.mcpServers ?? {}) };
		if (target.entry === null) {
			if (blockedReason === null && currentEntry === null) {
				// Nothing this bridge owns in the file: leave it byte-identical and
				// do not even list it as a change.
				if (read.missing) {
					continue;
				}
				continue;
			}
			delete servers[target.entryName];
		} else {
			servers[target.entryName] = target.entry;
		}
		// Only the owned fragment is written back; every other key is preserved by
		// spreading the parsed document, never by serializing a filtered version.
		const nextDocument: McpConfig = { ...document, mcpServers: servers };
		const content = `${JSON.stringify(nextDocument, null, 2)}\n`;
		const action: IntegrationAction =
			target.entry === null
				? "remove"
				: currentEntry === null
					? read.missing
						? "create"
						: "update"
					: legacy
						? "migrate"
						: sha256(content) === baselineSha256
							? "unchanged"
							: "update";
		planned.push({
			filePath: target.filePath,
			entryName: target.entryName,
			missing: read.missing,
			baselineSha256,
			currentEntry,
			content,
			plannedSha256: sha256(content),
			blockedReason,
			action,
		});
	}
	return { targets: planned, applicable: planned.every((target) => target.blockedReason === null) };
}

/**
 * Applies a plan, verifying each file's baseline first.
 *
 * A target whose bytes no longer match the plan's baseline is refused: the user
 * (or another process) changed it after the preview, and writing anyway would
 * discard that. Successful writes are recorded so a later failure can roll back
 * only what this apply actually wrote.
 */
export async function applyIntegration(plan: IntegrationPlan): Promise<ApplyReport> {
	const report: ApplyReport = { applied: [], failed: [], diverged: [] };
	const written: TargetPlan[] = [];

	// A plan with any blocked target writes nothing at all. Applying the good half
	// and then failing the bad half would leave the project partially configured,
	// which is the state the plan's "多文件 apply 按自有记录原子写" forbids.
	if (!plan.applicable) {
		for (const target of plan.targets) {
			report.failed.push({
				filePath: target.filePath,
				reason: target.blockedReason ?? "the plan is not applicable as a whole",
			});
		}
		return report;
	}

	for (const target of plan.targets) {
		if (target.blockedReason !== null) {
			report.failed.push({ filePath: target.filePath, reason: target.blockedReason });
			continue;
		}
		const current = await readIfPresent(target.filePath).catch(() => null);
		const currentSha = current === null || current.content === null ? null : sha256(current.content);
		if (current === null || currentSha !== target.baselineSha256) {
			report.failed.push({
				filePath: target.filePath,
				reason: `${target.filePath} changed after it was previewed; re-run the preview to see the current state`,
			});
			continue;
		}
		try {
			await mkdir(path.dirname(target.filePath), { recursive: true });
			await writeFile(target.filePath, target.content, "utf-8");
			written.push(target);
			report.applied.push(target.filePath);
		} catch (err: unknown) {
			report.failed.push({
				filePath: target.filePath,
				reason: `Cannot write ${target.filePath}: ${err instanceof Error ? err.message : String(err)}`,
			});
			break;
		}
	}

	if (report.failed.length > 0) {
		// A partial apply would leave the project half-configured; undo only the
		// files still holding exactly what this call wrote.
		for (const target of written) {
			const current = await readIfPresent(target.filePath).catch(() => null);
			const currentSha = current === null || current.content === null ? null : sha256(current.content);
			if (currentSha !== target.plannedSha256) {
				// Someone edited it after we wrote; their version wins.
				report.diverged.push(target.filePath);
				continue;
			}
			if (target.missing) {
				// The file did not exist before, so rollback removes what we created.
				await writeFile(target.filePath, "", "utf-8").catch(() => undefined);
				continue;
			}
			const restored = await restoreBaseline(target);
			if (!restored) {
				report.diverged.push(target.filePath);
			}
		}
	}
	return report;
}

/**
 * Restores a target's baseline bytes.
 *
 * The baseline content is recoverable only through the same managed-entry rewrite
 * that created it, so this removes the owned entry rather than inventing content:
 * a rollback that fabricated a document would be worse than a failed rollback.
 */
async function restoreBaseline(target: TargetPlan): Promise<boolean> {
	const current = await readIfPresent(target.filePath).catch(() => null);
	if (current === null || current.content === null) {
		return false;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(current.content);
	} catch {
		return false;
	}
	const parsed = McpConfigSchema.safeParse(raw);
	if (!parsed.success || parsed.data.mcpServers === undefined) {
		return false;
	}
	const servers: Record<string, unknown> = { ...parsed.data.mcpServers };
	if (target.currentEntry === null) {
		delete servers[target.entryName];
	} else {
		servers[target.entryName] = target.currentEntry;
	}
	const restoredDocument = { ...parsed.data, mcpServers: servers };
	const content = `${JSON.stringify(restoredDocument, null, 2)}\n`;
	if (sha256(content) !== target.baselineSha256) {
		// The reconstructed document is not byte-identical to the baseline (formatting
		// differences, or a concurrent edit). Reporting divergence is honest; writing
		// a guess is not.
		return false;
	}
	await writeFile(target.filePath, content, "utf-8");
	return true;
}

/**
 * Builds the targets `/wb setup` and the installer write.
 *
 * One entry, registered once for WorkBuddy: it launches the read-only context
 * server with `--global`, so the canonical project comes from the verified
 * calling worker at call time. Pinning an install checkout here is what made the
 * old entry answer about the wrong project.
 *
 * `legacyProjectRoot` additionally plans removal of the old project-level OMP
 * entry, which exposed the write tools. That is a cleanup of this bridge's own
 * previous configuration, and only a provably bridge-owned entry is removed.
 */
export function setupTargets(input: {
	workbuddyHomeDir: string;
	bunExecutable: string;
	mcpEntrypoint: string;
	legacyProjectRoot?: string;
}): ConfigTarget[] {
	const targets: ConfigTarget[] = [
		{
			filePath: path.join(input.workbuddyHomeDir, ".workbuddy", "mcp.json"),
			entryName: "omp-wb-bridge",
			entry: { command: input.bunExecutable, args: [input.mcpEntrypoint, "--global"] },
		},
	];
	if (input.legacyProjectRoot !== undefined) {
		targets.push({
			filePath: path.join(input.legacyProjectRoot, ".omp", "mcp.json"),
			entryName: "omp-wb-bridge",
			entry: null,
		});
	}
	return targets;
}


/** Raises the plan's coded error for a plan that cannot be applied. */
export function assertApplicable(plan: IntegrationPlan): void {
	if (plan.applicable) {
		return;
	}
	const reasons = plan.targets
		.filter((target) => target.blockedReason !== null)
		.map((target) => `${target.filePath}: ${target.blockedReason}`);
	throw new WbTaskError(
		WB_ERROR_CODE.integrationIncomplete,
		`The configuration cannot be applied as planned:\n${reasons.join("\n")}`,
	);
}
