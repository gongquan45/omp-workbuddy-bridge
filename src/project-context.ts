/**
 * Project context resolution: the single answer to "which project is this?".
 *
 * Every entry point — OMP tools, the MCP server, the queue, artifacts, help and
 * configuration checks — must locate the project through this module. Without
 * one resolver, each entry point re-derives a root from whatever cwd it happens
 * to see, which is how a subdirectory session, a nested checkout and a second
 * worktree of the same remote end up with separate project state.
 *
 * Resolution order, and the reason for each step:
 *
 *  1. Canonicalize the actual cwd (`realpath`), so a junction, an 8.3 short
 *     name or different drive-letter casing cannot impersonate a second root.
 *  2. Walk ancestors and classify each one through the injected predicate. A
 *     session in `<root>/src/feature` therefore shares state with `<root>`.
 *  3. Zero candidate roots → `unauthorized`. Nothing is created; the caller
 *     must run project setup.
 *  4. Two or more candidate roots, with no usable association for this session
 *     → `pending_verification`. Guessing "the nearest one" would silently move
 *     an existing project's tasks into a nested one.
 *
 * A recorded association from project setup wins over the bare walk, but only
 * while it is still the *nearest* enabled root covering the cwd. Leaving the
 * root ends the write capability instead of following the session; a nearer
 * nested project makes the answer ambiguous instead of letting one project's
 * tasks be filed under another project's queue.
 */

import { statSync, realpathSync } from "node:fs";
import path from "node:path";

import { canonicalProjectRoot, type ProjectMarkerState } from "./queue";
import { WB_ERROR_CODE, WbTaskError } from "./types";

/** Bridge state classifications the resolver acts on. */
export type ProjectMarkerKind = ProjectMarkerState;

/** How the project root for this call was decided. */
export type IdentitySource =
	/** A recorded session↔root association (project setup) covered the cwd. */
	| "session_association"
	/** An enabled marker was found at or above the cwd. */
	| "ancestor_marker"
	/** No enabled marker exists at or above the cwd. */
	| "none";

/** Whether the resolved context may write project state. */
export type ProjectAuthorization =
	| "authorized"
	/** Inside an enabled root, but a nested enabled root makes it ambiguous. */
	| "pending_verification"
	/** No enabled project root covers this cwd. */
	| "unauthorized";

/** Everything one entry point needs in order to act on behalf of a project. */
export interface ProjectResolution {
	/** Canonical authorized project root; `null` when unauthorized. */
	projectRoot: string | null;
	/** Canonical actual working directory the call arrived with. */
	actualCwd: string;
	/** `actualCwd` relative to `projectRoot`, POSIX separators; `""` at the root. */
	relativeCwd: string;
	authorization: ProjectAuthorization;
	identitySource: IdentitySource;
	/**
	 * Roots that made a nested match ambiguous. Empty unless the authorization
	 * is `pending_verification`; the user resolves it by picking one.
	 */
	ambiguousRoots: string[];
	/** Why this resolution is not simply authorized; `null` when it is. */
	reason: string | null;
}

/** Directory traversal guard: a pathological tree must not hang a tool call. */
const MAX_ANCESTOR_DEPTH = 64;

/**
 * True when the directory itself is an enabled project root.
 *
 * "Enabled" is read from the marker pair only: `state.sqlite` next to a
 * `project_enabled_at` row. Reading the row requires opening SQLite, which this
 * resolver deliberately does not do — it is called by read-only surfaces too.
 * Instead the caller supplies its own enablement check; see
 * `resolveProjectContext` below.
 */
export interface ProjectResolutionOptions {
	/**
	 * Classifies the bridge state at `root`.
	 *
	 * Injected so this module stays free of SQLite: the queue owns
	 * classification, and read-only callers pass a check that never creates
	 * state. Returning the classification (rather than a boolean) keeps this
	 * module from inventing a second notion of "has project state", which is how
	 * a project needing migration would otherwise be invisible.
	 */
	readonly classify: (root: string) => ProjectMarkerKind;
	/**
	 * Root this OMP session was explicitly associated with during setup, when
	 * one is recorded. Verified against the cwd before it is trusted.
	 */
	readonly associatedRoot?: string | null;
}

/** Canonicalizes an existing directory; returns null when it cannot be resolved. */
function canonicalDirectory(target: string): string | null {
	try {
		if (!statSync(target).isDirectory()) {
			return null;
		}
		return realpathSync(target);
	} catch {
		return null;
	}
}

/** True when `child` is `parent` itself or lies beneath it. */
function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	if (relative.length === 0) {
		return true;
	}
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Collects the given directory and every ancestor, nearest first. */
function ancestorChain(start: string): string[] {
	const chain: string[] = [];
	let current = start;
	for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
		chain.push(current);
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return chain;
}

/**
 * Resolves which project a call belongs to, without writing anything.
 *
 * The returned `relativeCwd` is the coordinate every stored path uses: input
 * files, read/write scopes and artifact references are all project-root
 * relative, so a subdirectory session and its parent share one state.
 */
export async function resolveProjectContext(
	cwd: string,
	options: ProjectResolutionOptions,
): Promise<ProjectResolution> {
	if (typeof cwd !== "string" || cwd.trim().length === 0 || !path.isAbsolute(cwd)) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Project working directory must be an absolute path, got: ${JSON.stringify(cwd)}`,
		);
	}
	const actualCwd = canonicalDirectory(cwd);
	if (actualCwd === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Project working directory could not be resolved: ${cwd}`,
		);
	}

	const toResolution = (
		projectRoot: string | null,
		authorization: ProjectAuthorization,
		identitySource: IdentitySource,
		ambiguousRoots: string[] = [],
		reason: string | null = null,
	): ProjectResolution => ({
		projectRoot,
		actualCwd,
		relativeCwd:
			projectRoot === null
				? ""
				: path.relative(projectRoot, actualCwd).split(path.sep).join("/"),
		authorization,
		identitySource,
		ambiguousRoots,
		reason,
	});

	// Candidate roots at or above the cwd, nearest first. The classification is
	// the queue's single authority, so an enabled root, a root awaiting
	// migration and a disabled root are all found here; only `absent` is skipped,
	// and a `foreign` database is a conflict rather than a project.
	const candidateRoots: string[] = [];
	const foreignRoots: string[] = [];
	for (const directory of ancestorChain(actualCwd)) {
		const state = options.classify(directory);
		if (state === "absent") {
			continue;
		}
		if (state === "foreign") {
			foreignRoots.push(directory);
			continue;
		}
		candidateRoots.push(directory);
	}
	const nearestCandidate = candidateRoots[0] ?? null;

	// A recorded association is the user's explicit choice, but it is only
	// usable while it both covers the cwd and is the nearest enabled root. If a
	// *nearer* enabled root sits inside the associated one, the two projects'
	// tasks would interleave in a single queue, so that case is ambiguous rather
	// than association-wins.
	const associated =
		options.associatedRoot === undefined || options.associatedRoot === null
			? null
			: canonicalDirectory(options.associatedRoot);

	// A database here that belongs to a different root is a conflict, not a
	// project: writing through it would mix two projects' state.
	if (foreignRoots.length > 0 && candidateRoots.length === 0) {
		return toResolution(
			null,
			"pending_verification",
			"none",
			foreignRoots,
			`bridge state at ${foreignRoots[0]} belongs to a different project root; confirm which project this session belongs to`,
		);
	}

	if (associated !== null && isWithin(associated, actualCwd)) {
		if (candidateRoots.includes(associated)) {
			if (nearestCandidate === associated) {
				return toResolution(associated, "authorized", "session_association");
			}
			return toResolution(
				null,
				"pending_verification",
				"none",
				[nearestCandidate!, associated],
				`a nearer project root ${nearestCandidate} sits inside the recorded root ${associated}; confirm which project this session belongs to`,
			);
		}
		// A recorded root with no state left is not usable: the association cannot
		// keep granting capability for a project that is no longer there.
		return toResolution(
			null,
			"unauthorized",
			"none",
			[],
			`recorded project root ${associated} no longer holds project state; run project setup again`,
		);
	}

	if (nearestCandidate === null) {
		return toResolution(
			null,
			"unauthorized",
			"none",
			[],
			`no project state covers ${actualCwd}; run project setup to authorize one`,
		);
	}
	if (candidateRoots.length === 1) {
		return toResolution(nearestCandidate, "authorized", "ancestor_marker");
	}
	// Nested project roots with no usable association: a nested project was
	// authorized while this session works inside it. Picking either one would
	// move tasks between projects, so the user decides.
	return toResolution(
		null,
		"pending_verification",
		"none",
		candidateRoots,
		`${candidateRoots.length} project roots contain ${actualCwd}; confirm which project this session belongs to`,
	);
}

/**
 * Canonical project root for a *new* project being set up.
 *
 * Setup is the one place a root may be created rather than discovered, so this
 * only canonicalizes: `realpath` when the directory exists, `path.resolve`
 * otherwise (the caller creates it).
 */
export function canonicalSetupRoot(target: string): string {
	if (typeof target !== "string" || target.trim().length === 0 || !path.isAbsolute(target)) {
		throw new WbTaskError(
			WB_ERROR_CODE.inputInvalid,
			`Project root must be an absolute path, got: ${JSON.stringify(target)}`,
		);
	}
	return canonicalDirectory(target) ?? canonicalProjectRoot(target);
}
