/**
 * WorkBuddy session pool: binding roster helpers and an identity resolver that
 * refuses to guess.
 *
 * The pool answers two questions and nothing else:
 *
 *  - *Which sessions belong to this project?* — {@link listBoundSessions},
 *    {@link reconcileProjectBinding} and {@link bindingForSession} normalize and
 *    validate the roster that the project persists in `.wb-bridge/binding.json`.
 *  - *Which session is this process?* — {@link resolveWorkBuddyCaller} proves the
 *    identity of the worker that launched this MCP server.
 *
 * It deliberately does **not** allocate work. Choosing which member of a pool
 * takes the next task is the queue's authority alone: a second selector here
 * would let two processes pick different sessions for the same task and would
 * let a session that already holds a context be recycled for unrelated work.
 * That is why the exploratory `selectTarget` helper this file used to carry was
 * removed rather than kept next to the queue's own selection.
 *
 * Everything here is pure with respect to the roster except
 * {@link reconcileProjectBinding}, which reads the filesystem to canonicalize
 * project roots — it still writes nothing: persisting the result is the caller's
 * job, so that a read-only inspection can never mutate the binding.
 */

import { existsSync, statSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { WbTaskError, WB_ERROR_CODE, type Binding, type BoundSession, type DesktopCandidate } from "./types";

// ---------------------------------------------------------------------------
// Binding roster
// ---------------------------------------------------------------------------

/**
 * Normalizes a binding record into the roster it really describes.
 *
 * A legacy (v1) binding has no roster at all: its single `sessionId` *is* the
 * pool, so it is returned as a one-member roster. A v2 binding keeps its roster
 * as recorded, deduplicated by session id and with the first occurrence of a
 * duplicate winning — the record's order is the user's order, and a later
 * duplicate cannot be allowed to overwrite it.
 *
 * The result is a copy: the caller's binding is never mutated, and no member is
 * invented beyond what the record states.
 */
export function listBoundSessions(binding: Binding): BoundSession[] {
	const members: BoundSession[] = [];
	const byId = new Map<string, BoundSession>();

	const push = (member: BoundSession): void => {
		const existing = byId.get(member.sessionId);
		if (existing === undefined) {
			const copy: BoundSession = { sessionId: member.sessionId };
			if (member.role !== undefined) copy.role = member.role;
			if (member.title !== undefined) copy.title = member.title;
			if (member.isDefault !== undefined) copy.isDefault = member.isDefault;
			if (member.workbuddyVersion !== undefined) copy.workbuddyVersion = member.workbuddyVersion;
			// Verification is part of the member's identity for the consumer: a
			// member that was proven unverified must not be promoted to
			// "eligible" by dropping the flag on the way through.
			if (member.verified !== undefined) copy.verified = member.verified;
			byId.set(member.sessionId, copy);
			members.push(copy);
			return;
		}
		// A duplicate may still contribute a field the first occurrence lacked.
		if (existing.role === undefined && member.role !== undefined) existing.role = member.role;
		if (existing.title === undefined && member.title !== undefined) existing.title = member.title;
		if (existing.isDefault === undefined && member.isDefault !== undefined) existing.isDefault = member.isDefault;
		if (existing.workbuddyVersion === undefined && member.workbuddyVersion !== undefined) {
			existing.workbuddyVersion = member.workbuddyVersion;
		}
		// The same duplicate policy applies to verification: the first
		// occurrence that states it wins, and a later duplicate may only
		// contribute the fact when the first one was silent. An explicit `false`
		// is never overwritten by a later `true`.
		if (existing.verified === undefined && member.verified !== undefined) {
			existing.verified = member.verified;
		}
	};

	const roster = binding.sessions;
	if (roster === undefined) {
		push({
			sessionId: binding.sessionId,
			workbuddyVersion: binding.workbuddyVersion,
		});
		return members;
	}
	for (const member of roster) {
		push({
			...member,
			// A member enrolled before versions were recorded per member falls back
			// to the version the binding itself carries, so a consumer always has
			// a version string for every roster entry.
			workbuddyVersion: member.workbuddyVersion ?? binding.workbuddyVersion,
		});
	}
	return members;
}

/** Why a candidate session is not eligible for this project's pool. */
export type CandidateExclusion =
	/** The candidate's own project root resolves outside this project. */
	| "foreign_project"
	/** The candidate's project root contains this project; the ownership is ambiguous. */
	| "nested_project_root"
	/** The candidate's project root cannot be resolved on disk. */
	| "unresolvable_project_root";

/** One candidate that was not enrolled, with the reason it was left out. */
export interface ExcludedCandidate {
	sessionId: string;
	reason: CandidateExclusion;
	/** The canonical project root that produced the exclusion. */
	projectRoot: string | null;
}

/** Outcome of partitioning discovery data against one project's pool. */
export interface CandidatePartition {
	/** Candidates that may be enrolled in this project's roster. */
	eligible: DesktopCandidate[];
	/** Candidates that were refused, with the reason. */
	excluded: ExcludedCandidate[];
}

/**
 * Canonical realpath of a directory, or null when it cannot be resolved.
 *
 * The value keeps the filesystem's own spelling, because it is what a binding
 * record should persist.
 */
async function realDirectory(target: string): Promise<string | null> {
	try {
		const resolved = await realpath(target);
		return statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

/**
 * Comparison form of a path.
 *
 * Symlinks are resolved, so a link pointing out of the project cannot pass as
 * a descendant, and a link pointing into it cannot pass as foreign. Windows
 * comparisons ignore case and slash orientation, matching how the desktop
 * client already normalizes the same paths.
 */
async function canonicalPath(target: string): Promise<string | null> {
	const resolved = await realDirectory(target);
	if (resolved === null) {
		return null;
	}
	return process.platform === "win32"
		? resolved.replaceAll("/", "\\").toLowerCase()
		: resolved;
}

/** True when `candidate` lies strictly inside `root` (not equal to it). */
function isStrictDescendant(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Splits discovery candidates into the ones this project may enroll and the
 * ones it must refuse.
 *
 * A candidate is eligible when its own project root is this project, or a
 * directory inside it — a session opened in a subdirectory of the project is a
 * legitimate member of the same project. It is refused when its root lies
 * outside the project (somebody else's work), when it *contains* the project
 * (the ownership would be ambiguous: the candidate serves a larger project that
 * happens to include this one), or when its root cannot be resolved at all.
 *
 * Candidates are deduplicated by session UUID: one session is one member, even
 * when several workers answer for it.
 */
export async function partitionProjectCandidates(
	binding: Binding,
	candidates: readonly DesktopCandidate[],
): Promise<CandidatePartition> {
	const projectRoot = await canonicalPath(binding.projectRoot);
	if (projectRoot === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Binding project root does not exist on disk: ${binding.projectRoot}`,
		);
	}

	const eligible: DesktopCandidate[] = [];
	const excluded: ExcludedCandidate[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const sessionId = candidate.binding.sessionId;
		// The worker's own working directory is the evidence of which project the
		// session serves; `binding.projectRoot` only names the project the
		// discovery run was aimed at.
		const claimed = candidate.cwd ?? candidate.binding.projectRoot;
		if (claimed === undefined || claimed === null || claimed === "") {
			excluded.push({ sessionId, reason: "unresolvable_project_root", projectRoot: null });
			continue;
		}
		const candidateRoot = await canonicalPath(claimed);
		if (candidateRoot === null) {
			excluded.push({ sessionId, reason: "unresolvable_project_root", projectRoot: null });
			continue;
		}
		if (candidateRoot !== projectRoot) {
			if (isStrictDescendant(projectRoot, candidateRoot)) {
				// A descendant directory of this project: same project, different
				// working directory. Legitimate.
			} else if (isStrictDescendant(candidateRoot, projectRoot)) {
				excluded.push({ sessionId, reason: "nested_project_root", projectRoot: candidateRoot });
				continue;
			} else {
				excluded.push({ sessionId, reason: "foreign_project", projectRoot: candidateRoot });
				continue;
			}
		}
		if (seen.has(sessionId)) {
			continue;
		}
		seen.add(sessionId);
		eligible.push(candidate);
	}

	return { eligible, excluded };
}

/**
 * Merges the persisted roster with freshly verified candidates and the native
 * catalog, and returns the canonical v2 binding for this project.
 *
 * The result is the record the project should persist: a v2 roster, the
 * project-wide auto-enrollment consent enabled, and no endpoint, token or
 * other credential — the binding describes *who* may serve this project, never
 * *where* it can be reached.
 *
 * Four rules shape the merge:
 *
 *  - **Offline members are kept.** A member that is merely not present in the
 *    candidates right now stays in the roster: the desktop application may be
 *    closed, and dropping it would silently revoke a session the user still
 *    owns. Its recorded version and identity are preserved as they were.
 *  - **Contradicted members are dropped.** A member whose session UUID is now
 *    verified for a *different* project is not offline — its ownership was
 *    disproved, so it is excluded from the roster (and therefore from
 *    eligibility) until it is verified again. Historical task affinity for that
 *    session is untouched: it lives in the queue, not here.
 *  - **Catalog members are enrolled, but not as verified.** A session the
 *    desktop catalog records for this project is enrolled so that the project
 *    keeps it across restarts, but it is marked unverified: nothing proves that
 *    a live worker owns it right now, so the queue must not hand it new work.
 *  - **Consent is never lost.** The project-wide auto-enrollment policy is
 *    carried over and enabled, so a restart enrolls newly opened sessions
 *    without asking the user again.
 *
 * The function writes nothing. Persisting the result is the caller's decision.
 */
export async function reconcileProjectBinding(
	binding: Binding,
	candidates: readonly DesktopCandidate[],
	catalog: readonly CatalogSession[] = [],
): Promise<Binding> {
	const projectRoot = await realDirectory(binding.projectRoot);
	if (projectRoot === null) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Binding project root does not exist on disk: ${binding.projectRoot}`,
		);
	}

	const { eligible, excluded } = await partitionProjectCandidates(binding, candidates);

	// Members whose UUID was disproved for this project are dropped instead of
	// being carried over as if they were merely offline.
	const contradicted = new Set(
		excluded
			.filter((entry) => entry.reason === "foreign_project" || entry.reason === "nested_project_root")
			.map((entry) => entry.sessionId),
	);

	const members: BoundSession[] = [];
	const byId = new Map<string, BoundSession>();

	const add = (member: BoundSession): void => {
		if (byId.has(member.sessionId)) {
			return;
		}
		const copy: BoundSession = { sessionId: member.sessionId };
		if (member.role !== undefined) copy.role = member.role;
		if (member.title !== undefined) copy.title = member.title;
		if (member.isDefault !== undefined) copy.isDefault = member.isDefault;
		if (member.workbuddyVersion !== undefined) copy.workbuddyVersion = member.workbuddyVersion;
		if (member.verified !== undefined) copy.verified = member.verified;
		byId.set(member.sessionId, copy);
		members.push(copy);
	};

	// Members already enrolled come first, in the order the user arranged them.
	for (const member of listBoundSessions(binding)) {
		if (contradicted.has(member.sessionId)) {
			continue;
		}
		// A member that was verified in an earlier run is not verified now: this
		// round proved nothing about it, so it must not be handed work until
		// discovery proves it again.
		add({ ...member, verified: false });
	}

	// Newly verified members join after the known ones.
	for (const candidate of eligible) {
		// A UUID that was disproved for this project is never re-admitted by a
		// candidate that claims it belongs here: two candidates that disagree
		// about the ownership of one session leave that session unproven, and
		// an unproven session must not be handed work. The check happens here
		// and not only in the exclusion set, so the outcome does not depend on
		// the order in which the candidates were reported.
		if (contradicted.has(candidate.binding.sessionId)) {
			continue;
		}
		if (byId.has(candidate.binding.sessionId)) {
			// Refresh the version the member was observed with, but keep the
			// recorded identity and the user's own annotations.
			const existing = byId.get(candidate.binding.sessionId)!;
			const version = candidate.binding.workbuddyVersion;
			if (version !== undefined && version !== "" && existing.workbuddyVersion !== version) {
				existing.workbuddyVersion = version;
			}
			// This member was just proven to be owned by a live worker of this
			// project, so it may be handed work.
			existing.verified = true;
			continue;
		}
		add({
			sessionId: candidate.binding.sessionId,
			workbuddyVersion:
				candidate.binding.workbuddyVersion === "" ? undefined : candidate.binding.workbuddyVersion,
			verified: true,
		});
	}

	// Catalog members join last, and only as unverified members: the catalog
	// knows the session belongs to this project, but not that a worker owns it
	// right now.
	for (const entry of catalog) {
		if (contradicted.has(entry.sessionId) || byId.has(entry.sessionId)) {
			continue;
		}
		add({ sessionId: entry.sessionId, verified: false });
	}

	return {
		version: 2,
		projectRoot,
		// The primary identity stays the user's own session, unless that session
		// was disproved for this project: a record must not keep pointing at a
		// session that now demonstrably serves a different project.
		sessionId:
			contradicted.has(binding.sessionId)
				? (members[0]?.sessionId ?? binding.sessionId)
				: binding.sessionId,
		workbuddyVersion: binding.workbuddyVersion,
		sessions: members,
		autoBindProjectSessions: true,
	};
}

/**
 * Returns the concrete connection identity of one enrolled member.
 *
 * The result is what a delegation needs to reach that one session: its project
 * root, its session UUID and the WorkBuddy version observed for it. The
 * version is the *member's* own, because a roster can mix members created by
 * different desktop versions.
 *
 * @throws WbTaskError with `WB_BINDING_INVALID` when the session is not part
 *   of this project's roster: the caller asked for a member the project never
 *   enrolled, and inventing one would hand the work to an unknown session.
 */
export function bindingForSession(binding: Binding, sessionId: string): Binding {
	const member = listBoundSessions(binding).find((entry) => entry.sessionId === sessionId);
	if (member === undefined) {
		throw new WbTaskError(
			WB_ERROR_CODE.bindingInvalid,
			`Session ${sessionId} is not enrolled in the pool of project ${binding.projectRoot}`,
		);
	}
	const version = member.workbuddyVersion ?? binding.workbuddyVersion;
	return {
		version: 2,
		projectRoot: binding.projectRoot,
		sessionId: member.sessionId,
		workbuddyVersion: version,
		sessions: [{ ...member, workbuddyVersion: version }],
		...(binding.autoBindProjectSessions === undefined
			? {}
			: { autoBindProjectSessions: binding.autoBindProjectSessions }),
	};
}

// ---------------------------------------------------------------------------
// Native session catalog
//
// The desktop application records every conversation it ever created in its own
// SQLite catalog. The active worker registry only lists the sessions that are
// running *right now*, so a project that must enroll "all sessions of this
// project" cannot be served by the registry alone: after a restart, the
// sessions that exist but are not running would be forgotten.
//
// The catalog is therefore read for metadata only — the session UUID, the
// directory it works in, and whether it is deleted or a background automation.
// No title, settings, prompt or conversation content is read, and the database
// is opened read-only and never written or created.
// ---------------------------------------------------------------------------

/** One session as the desktop catalog records it, without any content. */
export interface CatalogSession {
	/** Conversation UUID. */
	sessionId: string;
	/** The directory the session works in, as the catalog spells it. */
	cwd: string;
	/** The catalog's own status word, e.g. `completed` or `working`. */
	status: string;
}

/** The catalog could not be read, or does not have the expected shape. */
export type CatalogFailureReason =
	/** The catalog file does not exist; there is nothing to enroll. */
	| "catalog_missing"
	/** The catalog could not be opened or queried. */
	| "catalog_unreadable"
	/** The catalog exists but does not have the expected `sessions` table. */
	| "catalog_schema_unexpected"
	/**
	 * The account scope could not be established.
	 *
	 * The catalog holds the sessions of every account that ever used the
	 * application. Without the project's own seed session there is no way to
	 * tell which of them belong to this user, and listing them all would enroll
	 * other people's conversations. Nothing is returned instead.
	 */
	| "catalog_seed_unknown";

/** Result of reading the native catalog for one project. */
export interface ProjectSessionCatalog {
	/** Sessions of this project, in catalog order. */
	sessions: CatalogSession[];
	/** Set when the catalog could not be read; the sessions are then empty. */
	failure: CatalogFailureReason | null;
	/** Human-readable detail about the failure, when there was one. */
	detail: string | null;
}

/**
 * The desktop application's home directory, where its catalog lives.
 */
export function workBuddyHomeDir(homeDir?: string): string {
	return homeDir ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? os.homedir(), ".workbuddy");
}

/** The columns this reader needs from the native `sessions` table. */
const REQUIRED_CATALOG_COLUMNS = [
	"id",
	"cwd",
	"user_id",
	"status",
	"deleted_at",
	"is_background_automation",
	"transport",
] as const;

/**
 * Reads the desktop catalog's own record of this project's sessions.
 *
 * The catalog is the desktop application's private store, and it holds the
 * sessions of *every* account that ever used the application. Three
 * restrictions keep this read to what the user owns:
 *
 *  - **Account scope.** The account is derived from the project's own bound
 *    session (the "seed"): only sessions of that account, plus the legacy
 *    entries that carry no account at all, are considered. The account
 *    identifier itself is never returned, printed or persisted.
 *  - **Visible sessions only.** A session is visible when it is not deleted
 *    (`deleted_at IS NULL`), is not a background automation, and is stored
 *    locally. Its status is not filtered: a completed or terminated
 *    conversation still exists and still belongs to the project.
 *  - **Metadata only.** The session UUID, its directory and its status word
 *    are read. No title, settings, prompt or conversation content is touched.
 *
 * The project boundary is the same one the pool uses elsewhere — the session's
 * directory must be this project or a directory inside it, and a directory that
 * merely *contains* the project is refused as ambiguous.
 *
 * A missing catalog is not an error: the desktop application may simply not be
 * installed, and live discovery still works. An unreadable or unexpected
 * catalog is reported as a failure with a reason and yields no sessions, so the
 * caller can show the problem instead of silently enrolling nothing.
 *
 * @param seedSessionId The project's own bound session; the account is derived
 *   from it. `null` — or a session the catalog does not know — leaves the
 *   account scope unknown, and nothing is returned.
 */
export async function readProjectSessionCatalog(
	projectRoot: string,
	workbuddyHomeDir: string,
	seedSessionId: string | null,
): Promise<ProjectSessionCatalog> {
	const canonicalProject = await canonicalPath(projectRoot);
	if (canonicalProject === null) {
		return {
			sessions: [],
			failure: "catalog_unreadable",
			detail: `the project root does not exist on disk: ${projectRoot}`,
		};
	}

	const catalogPath = path.join(workbuddyHomeDir, "workbuddy.db");
	if (!existsSync(catalogPath)) {
		return { sessions: [], failure: "catalog_missing", detail: null };
	}

	// Phase one: everything the catalog can answer, read with the connection
	// open. The database is closed — with its statements finalized — before any
	// filesystem work follows, so the desktop application is never blocked by
	// this reader on the file it owns.
	type CatalogRows = { seed: { cwd: string; transport: string }; rows: Array<{ id: string; cwd: string; status: string }> };
	let read: CatalogRows | ProjectSessionCatalog | null = null;
	try {
		// Read-only and never created: the catalog belongs to the desktop
		// application, and this extension only ever reads it.
		const db = new Database(catalogPath, { readonly: true, create: false });
		try {
			read = readCatalogRows(db, seedSessionId);
		} finally {
			// The connection is closed before any filesystem work follows, and
			// `close(true)` finalizes the outstanding statements with it: the lazy
			// close would leave the catalog file locked until the garbage collector
			// runs, and the desktop application owns that file.
			db.close(true);
		}
	} catch (err: unknown) {
		return {
			sessions: [],
			failure: "catalog_unreadable",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	if (read === null || "failure" in read) {
		return read ?? {
			sessions: [],
			failure: "catalog_unreadable",
			detail: "the catalog could not be read",
		};
	}
	const seed = read.seed;
	const rows = read.rows;

	// Phase two: the project boundary, which needs the filesystem. The seed
	// must belong to this project: a session of another project may not stand
	// in for this project's account, or any unrelated conversation could
	// authorize this project's enrollment.
	const seedRoot = await canonicalPath(seed.cwd);
	if (seedRoot === null) {
		return {
			sessions: [],
			failure: "catalog_seed_unknown",
			detail: `the bound session ${seedSessionId} has no resolvable working directory`,
		};
	}
	if (seedRoot !== canonicalProject && !isStrictDescendant(canonicalProject, seedRoot)) {
		return {
			sessions: [],
			failure: "catalog_seed_unknown",
			detail: `the bound session ${seedSessionId} does not belong to this project`,
		};
	}

	const sessions: CatalogSession[] = [];
	for (const row of rows) {
		if (typeof row.id !== "string" || row.id.trim().length === 0) {
			continue;
		}
		if (typeof row.cwd !== "string" || row.cwd.trim().length === 0) {
			continue;
		}
		const candidateRoot = await canonicalPath(row.cwd);
		if (candidateRoot === null) {
			continue;
		}
		if (candidateRoot !== canonicalProject) {
			if (isStrictDescendant(canonicalProject, candidateRoot)) {
				// A session opened in a subdirectory of the project: same project.
			} else {
				// Another project, or one that merely contains this one.
				continue;
			}
		}
		sessions.push({
			sessionId: row.id,
			cwd: row.cwd,
			status: typeof row.status === "string" ? row.status : "",
		});
	}
	return { sessions, failure: null, detail: null };
}

/**
 * Reads the seed row and the account's visible rows in one read-only phase.
 *
 * Everything here needs no filesystem, so it all happens with the connection
 * open; the project boundary is checked afterwards, once the connection is
 * closed.
 */
function readCatalogRows(
	db: Database,
	seedSessionId: string | null,
):
	| { seed: { cwd: string; transport: string }; rows: Array<{ id: string; cwd: string; status: string }> }
	| ProjectSessionCatalog {
	try {
		// The schema is checked explicitly rather than assumed: the catalog
		// carries no schema version, so a table that lost a required column must
		// be reported instead of silently yielding fewer sessions.
		const columns = new Set(
			(db.query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
				(column) => column.name,
			),
		);
		if (columns.size === 0) {
			return {
				sessions: [],
				failure: "catalog_schema_unexpected",
				detail: "the catalog has no `sessions` table",
			};
		}
		const missing = REQUIRED_CATALOG_COLUMNS.filter((column) => !columns.has(column));
		if (missing.length > 0) {
			return {
				sessions: [],
				failure: "catalog_schema_unexpected",
				detail: `the catalog's sessions table is missing: ${missing.join(", ")}`,
			};
		}

		// The seed is the *account anchor*: it says which account's conversations
		// this project may look at. It is not an execution candidate, so it may
		// itself be deleted or offline — what matters is that the catalog still
		// records it and that it is stored locally.
		if (seedSessionId === null || seedSessionId.trim().length === 0) {
			return {
				sessions: [],
				failure: "catalog_seed_unknown",
				detail: "no bound session was supplied to establish the account scope",
			};
		}
		// `Statement.get` yields `null` for a row that does not exist — not
		// `undefined` — so the seed is read as a nullable value and guarded on
		// both. A missing seed means the account scope is unknown, which is a
		// seed problem and not a schema problem: it must never be reported as
		// an unexpected catalog shape.
		const seed = db
			.query(`SELECT cwd, transport FROM sessions WHERE id = ?`)
			.get(seedSessionId) as { cwd: string; transport: string } | null | undefined;
		if (seed === null || seed === undefined) {
			return {
				sessions: [],
				failure: "catalog_seed_unknown",
				detail: `the bound session ${seedSessionId} is not recorded in the catalog`,
			};
		}
		if (typeof seed.cwd !== "string" || typeof seed.transport !== "string") {
			return {
				sessions: [],
				failure: "catalog_seed_unknown",
				detail: `the bound session ${seedSessionId} has no usable catalog record`,
			};
		}
		if (seed.transport !== "local") {
			return {
				sessions: [],
				failure: "catalog_seed_unknown",
				detail: `the bound session ${seedSessionId} is not a local session`,
			};
		}

		// The seed's account is derived inside the read-only query and is never
		// returned: only the account's own sessions are listed, plus the legacy
		// entries that carry no account at all. The enrolled rows are the
		// visible ones — not deleted, not a background automation, local.
		const rows = db
			.query(
				`SELECT id, cwd, status FROM sessions
				 WHERE deleted_at IS NULL
				   AND COALESCE(is_background_automation, 0) = 0
				   AND transport = 'local'
				   AND (
				     user_id = (SELECT user_id FROM sessions WHERE id = ?)
				     OR user_id IS NULL
				     OR user_id = ''
				   )`,
			)
			.all(seedSessionId) as Array<{ id: string; cwd: string; status: string }>;
		return { seed, rows };
	} catch (err: unknown) {
		return {
			sessions: [],
			failure: "catalog_schema_unexpected",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// WorkBuddy worker registry
//
// Each worker writes `~/.workbuddy/sessions/<pid>.json`. The record is the only
// local evidence tying a live process to a session UUID, a version and a working
// directory, so it is what the identity resolver below reads.
// ---------------------------------------------------------------------------

/** WorkBuddy's per-worker session registry. */
export function workBuddySessionsDir(homeDir?: string): string {
	const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
	return path.join(home, ".workbuddy", "sessions");
}

/** One parsed worker registry record. */
export interface WorkerRegistryRecord {
	pid: number;
	sessionId: string;
	kind: string | null;
	version: string | null;
	cwd: string | null;
}

/** Narrowing reader for the registry record; `null` when it is not usable. */
export function parseWorkerRecord(raw: unknown): WorkerRegistryRecord | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const pid = "pid" in raw ? raw.pid : undefined;
	const sessionId = "sessionId" in raw ? raw.sessionId : undefined;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		return null;
	}
	if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
		return null;
	}
	const readString = (key: string): string | null => {
		if (!(key in raw)) {
			return null;
		}
		const value = (raw as Record<string, unknown>)[key];
		return typeof value === "string" && value.trim().length > 0 ? value : null;
	};
	return {
		pid,
		sessionId,
		kind: readString("kind"),
		version: readString("version"),
		cwd: readString("cwd"),
	};
}

/**
 * Reads the registry record for one worker process.
 *
 * Absent, unreadable or malformed records all yield `null`: the caller must then
 * treat the relation as unproven rather than searching for a record that "looks
 * like" the caller.
 */
export async function readWorkerRecord(
	pid: number,
	options: { sessionsDir?: string } = {},
): Promise<WorkerRegistryRecord | null> {
	const directory = options.sessionsDir ?? workBuddySessionsDir();
	const file = path.join(directory, `${pid}.json`);
	let text: string;
	try {
		text = await readFile(file, "utf-8");
	} catch {
		return null;
	}
	try {
		return parseWorkerRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Outcome of resolving which WorkBuddy worker invoked this process. */
export type CallerIdentity =
	| {
			kind: "verified";
			/** Worker process id the record belongs to. */
			workerPid: number;
			sessionId: string;
			version: string | null;
			/** Canonical working directory the worker reports. */
			cwd: string;
	  }
	| {
			kind: "pending";
			/** Why the identity could not be proven; shown to the user, never guessed away. */
			reason: string;
	  };

/**
 * Resolves the WorkBuddy session that launched this MCP process.
 *
 * The mechanism: WorkBuddy starts one stdio MCP server per worker, so this
 * process's parent is that worker, and the worker's own registry record names its
 * session, version and working directory. Three checks make that trustworthy
 * instead of merely plausible:
 *
 *  - the parent pid must be alive (a reused pid must not resurrect a dead session);
 *  - the record's `kind` must be the interactive worker, not some other mode;
 *  - the record's working directory must match the directory the host injected
 *    into the environment, and that directory must exist.
 *
 * Any mismatch yields `pending`. That is deliberate: a wrong session id would let
 * one project's work be filed under another's, and searching for a session that
 * "looks like" this caller is exactly the guess this refuses to make.
 */
export async function resolveWorkBuddyCaller(
	options: {
		/** Parent pid; defaults to this process's parent. */
		parentPid?: number;
		/** Directory the host injected (`CODEBUDDY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`). */
		injectedCwd?: string | null;
		sessionsDir?: string;
		/** Liveness check, injectable so tests do not depend on real pids. */
		isAlive?: (pid: number) => boolean;
	} = {},
): Promise<CallerIdentity> {
	const parentPid = options.parentPid ?? process.ppid;
	if (!Number.isInteger(parentPid) || parentPid <= 0) {
		return { kind: "pending", reason: "the MCP process has no parent worker to identify" };
	}
	const alive = options.isAlive ?? defaultIsAlive;
	if (!alive(parentPid)) {
		return { kind: "pending", reason: `parent worker ${parentPid} is not running` };
	}

	const record = await readWorkerRecord(parentPid, { sessionsDir: options.sessionsDir });
	if (record === null) {
		return {
			kind: "pending",
			reason: `no WorkBuddy session record for worker ${parentPid}; the session cannot be tied to this call`,
		};
	}
	if (record.pid !== parentPid) {
		// The file name and the record must agree, otherwise the record is stale.
		return {
			kind: "pending",
			reason: `session record for worker ${parentPid} belongs to pid ${record.pid}`,
		};
	}
	if (record.kind !== null && record.kind !== "interactive") {
		return {
			kind: "pending",
			reason: `worker ${parentPid} is not an interactive session (kind ${record.kind})`,
		};
	}

	const injected = options.injectedCwd ?? null;
	if (injected === null) {
		return {
			kind: "pending",
			reason: "the host did not provide a project directory for this process",
		};
	}
	if (record.cwd === null) {
		return { kind: "pending", reason: `session record for worker ${parentPid} has no working directory` };
	}

	const canonicalRecord = await canonicalOrNull(record.cwd);
	const canonicalInjected = await canonicalOrNull(injected);
	if (canonicalRecord === null || canonicalInjected === null) {
		return {
			kind: "pending",
			reason: `cannot verify the working directory of worker ${parentPid}`,
		};
	}
	if (canonicalRecord !== canonicalInjected) {
		return {
			kind: "pending",
			reason: `worker ${parentPid} works in ${canonicalRecord}, not the injected ${canonicalInjected}`,
		};
	}

	return {
		kind: "verified",
		workerPid: parentPid,
		sessionId: record.sessionId,
		version: record.version,
		cwd: canonicalRecord,
	};
}

/** Canonical directory or null; also proves the path is a real directory. */
async function canonicalOrNull(target: string): Promise<string | null> {
	try {
		const resolved = await realpath(target);
		return statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

/** Liveness check that treats any non-ESRCH failure as alive. */
function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		if (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			typeof err.code === "string" &&
			err.code === "ESRCH"
		) {
			return false;
		}
		// EPERM and friends mean "exists but not ours": still alive.
		return true;
	}
}

/** Lists worker pids that have a registry record, newest file first. */
export async function listWorkerPids(options: { sessionsDir?: string } = {}): Promise<number[]> {
	const directory = options.sessionsDir ?? workBuddySessionsDir();
	if (!existsSync(directory)) {
		return [];
	}
	const entries = await readdir(directory);
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => Number.parseInt(entry.slice(0, -".json".length), 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}
