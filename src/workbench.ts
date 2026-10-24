/**
 * Workbench projection and rendering.
 *
 * Two separate concerns, kept apart on purpose:
 *
 *  - `buildSnapshot` turns durable facts into a typed view. It never touches SQL,
 *    files or the network; the caller supplies what it already read.
 *  - `renderWorkbench` turns that view into terminal rows at a given width.
 *
 * Keeping rendering a pure function of the snapshot means every page can be
 * tested without a terminal, and the real TUI only has to prove it is wired up.
 */

/** One task row as the workbench shows it. */
export interface WorkbenchTask {
	taskId: string;
	round: number;
	status: string;
	/** Why it is waiting, when it is. */
	waitReason: string | null;
	/** Who is following it up, if anyone. */
	owner: string | null;
	/** Which WorkBuddy session runs it, when chosen. */
	executor: string | null;
	/** Acceptance state of the current deliverable set. */
	reviewState: string;
	/** Artifact paths, already project-relative. */
	artifacts: string[];
	/**
	 * The sessions that block a pool wait, each with its own cause.
	 *
	 * Only a pool wait has sessions to report: every other wait is about the
	 * task or about one named session.
	 */
	sessionBlockers: Array<{ sessionId: string; reason: string }>;
}

/** One session row. */
export interface WorkbenchSession {
	sessionId: string;
	title: string;
	/** `connected` / `not_connected` / `pending_verification`. */
	participation: string;
	/** `idle` / `busy` / `offline` / `auth_required` / `unknown`. */
	availability: string;
	/** Why it is not usable, when known. */
	reason: string | null;
	/** Where the fact came from, so a user can judge it. */
	source: string;
}

/** Diagnostics: integration, storage and migration facts. */
export interface WorkbenchDiagnostics {
	/**
	 * What this process can prove about installation, when anything can.
	 *
	 * Deliberately named for the *answer* rather than the question: an install fact and a
	 * queue-readability fact are not the same, and a page that prints one under the other's
	 * label is worse than one that says "unknown".
	 */
	install: string | null;
	/** Project registration / queue readability. */
	projectState: string | null;
	active: string | null;
	projectRoot: string | null;
	/** Issues that need a decision, each with the next action. */
	issues: Array<{ severity: string; message: string; nextAction: string }>;
}

/** Everything the workbench can show. */
export interface WorkbenchSnapshot {
	tasks: WorkbenchTask[];
	sessions: WorkbenchSession[];
	diagnostics: WorkbenchDiagnostics;
	/** Counts for the status line, derived rather than stored. */
	counts: { running: number; waiting: number; artifacts: number };
}

/** The three pages, in display order. */
export const WORKBENCH_PAGES = ["tasks", "sessions", "diagnostics"] as const;
export type WorkbenchPage = (typeof WORKBENCH_PAGES)[number];

/** Builds the snapshot's derived counts so no caller has to recount them. */
export function withCounts(snapshot: Omit<WorkbenchSnapshot, "counts">): WorkbenchSnapshot {
	const running = snapshot.tasks.filter(
		(task) => task.status === "running" || task.status === "awaiting_approval",
	).length;
	const waiting = snapshot.tasks.filter((task) => task.waitReason !== null).length;
	return {
		...snapshot,
		counts: {
			running,
			waiting,
			artifacts: snapshot.tasks.reduce((total, task) => total + task.artifacts.length, 0),
		},
	};
}

/** One-line summary used by the status bar and by headless output. */
export function statusLine(snapshot: WorkbenchSnapshot): string | null {
	const parts: string[] = [];
	if (snapshot.counts.running > 0) {
		parts.push(`${snapshot.counts.running} running`);
	}
	if (snapshot.counts.waiting > 0) {
		parts.push(`${snapshot.counts.waiting} waiting`);
	}
	if (snapshot.diagnostics.issues.length > 0) {
		parts.push(`${snapshot.diagnostics.issues.length} issue(s)`);
	}
	return parts.length === 0 ? null : `WorkBuddy: ${parts.join(", ")}`;
}

/** Truncates to a display width, marking the cut so a value is never silently clipped. */
export function truncate(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (value.length <= width) {
		return value;
	}
	if (width === 1) {
		return "…";
	}
	return `${value.slice(0, width - 1)}…`;
}

/** Pads to a width so columns line up; never truncates. */
function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Splits available width across columns, dropping trailing columns when the screen
 * is too narrow for them.
 *
 * Dropping is deliberate: a narrow terminal should still show the task identity and
 * its state, rather than a row of ellipses that communicates nothing.
 */
function allocate(total: number, weights: number[]): number[] {
	const usable = Math.max(0, total - (weights.length - 1));
	const sum = weights.reduce((a, b) => a + b, 0);
	return weights.map((weight) => Math.floor((usable * weight) / sum));
}

/**
 * Renders one page as terminal rows.
 *
 * No ANSI colour is emitted: the reader's theme decides colours, and a component
 * that hardcodes escapes would look broken under a different theme. Emphasis is
 * carried by layout and by the words themselves.
 */
export function renderWorkbench(
	snapshot: WorkbenchSnapshot,
	page: WorkbenchPage,
	width: number,
): readonly string[] {
	const rows: string[] = [];
	const safeWidth = Math.max(20, width);

	// Header: the page tabs plus the status summary.
	const tabs = WORKBENCH_PAGES.map((name) => (name === page ? `[${name}]` : ` ${name} `)).join("");
	rows.push(truncate(tabs, safeWidth));
	const summary = statusLine(snapshot);
	if (summary !== null) {
		rows.push(truncate(summary, safeWidth));
	}
	rows.push("");

	if (page === "tasks") {
		if (snapshot.tasks.length === 0) {
			rows.push("No tasks in this project.");
			rows.push("Delegate one with the wb_task tool.");
			return rows;
		}
		// Identity and state come first: a narrow screen keeps the short id and the
		// full status word and drops the auxiliary columns entirely, rather than
		// showing four columns of ellipses.
		const compact = safeWidth < 60;
		for (const task of snapshot.tasks) {
			if (compact) {
				rows.push(
					`${task.taskId.slice(0, 8)} ${truncate(task.status, Math.max(8, safeWidth - 10))}`.trimEnd(),
				);
			} else {
				const [idWidth, statusWidth, waitWidth, artifactWidth] = allocate(safeWidth, [10, 10, 8, 12]) as [
					number,
					number,
					number,
					number,
				];
				rows.push(
					[
						pad(truncate(`${task.taskId.slice(0, 8)}/${task.round}`, idWidth), idWidth),
						pad(truncate(task.status, statusWidth), statusWidth),
						pad(truncate(task.waitReason === null ? "-" : "waiting", waitWidth), waitWidth),
						truncate(task.artifacts.length === 0 ? "-" : `${task.artifacts.length} file(s)`, artifactWidth),
					]
						.join(" ")
						.trimEnd(),
				);
			}
			// The owner and executor are second-line detail: they matter when a task is
			// stuck, and would crowd the row when it is not.
			//
			// The wait reason is on this line rather than in a column, because a
			// column wide enough for every reason would squeeze out the artifact
			// count, and a truncated reason ("sessions_busy_or_unavaila…") says
			// less than the full name does.
			const detail = [
				task.waitReason === null ? null : `waiting ${task.waitReason}`,
				task.owner === null ? null : `owner ${task.owner}`,
				task.executor === null ? null : `via ${task.executor}`,
				`review ${task.reviewState}`,
			]
				.filter((part): part is string => part !== null)
				.join(" · ");
			rows.push(`    ${truncate(detail, safeWidth - 4)}`);
			// The sessions that block a pool wait are named with their own cause:
			// "waiting" alone does not tell a user which conversation to look at.
			for (const blocker of task.sessionBlockers) {
				rows.push(`    ${truncate(`blocked by ${blocker.sessionId} (${blocker.reason})`, safeWidth - 4)}`);
			}
		}
		return rows;
	}

	if (page === "sessions") {
		if (snapshot.sessions.length === 0) {
			rows.push("No WorkBuddy sessions observed for this project.");
			rows.push("Open the project in WorkBuddy; discovery only observes, it never attaches.");
			return rows;
		}
		const [titleWidth, availWidth, partWidth] = allocate(safeWidth, [8, 6, 8]) as [number, number, number];
		for (const session of snapshot.sessions) {
			rows.push(
				[
					pad(truncate(session.title, titleWidth), titleWidth),
					pad(truncate(session.availability, availWidth), availWidth),
					truncate(session.participation, partWidth),
				]
					.join(" ")
					.trimEnd(),
			);
			// The source is shown because "verified" without provenance is a claim the
			// user cannot check; the reason explains a non-idle state.
			const detail = [session.reason === null ? null : `reason ${session.reason}`, `source ${session.source}`]
				.filter((part): part is string => part !== null)
				.join(" · ");
			rows.push(`    ${truncate(detail, safeWidth - 4)}`);
		}
		return rows;
	}

	// diagnostics
	const diagnostics = snapshot.diagnostics;
	rows.push(`root      ${diagnostics.projectRoot ?? "not authorized"}`);
	rows.push(`install   ${diagnostics.install ?? "unknown — run /wb doctor for the release directory"}`);
	rows.push(`state     ${diagnostics.projectState ?? "unknown"}`);
	rows.push(`active    ${diagnostics.active ?? "unknown — restart OMP to load the plugin"}`);
	if (diagnostics.issues.length === 0) {
		rows.push("");
		rows.push("No local problems found. This cannot prove delegation works; only a real task does.");
		return rows;
	}
	rows.push("");
	for (const issue of diagnostics.issues) {
		rows.push(truncate(`[${issue.severity}] ${issue.message}`, safeWidth));
		rows.push(truncate(`    → ${issue.nextAction}`, safeWidth));
	}
	return rows;
}

/** Moves to the next page, wrapping. */
export function nextPage(page: WorkbenchPage): WorkbenchPage {
	const index = WORKBENCH_PAGES.indexOf(page);
	return WORKBENCH_PAGES[(index + 1) % WORKBENCH_PAGES.length]!;
}

/** Moves to the previous page, wrapping. */
export function previousPage(page: WorkbenchPage): WorkbenchPage {
	const index = WORKBENCH_PAGES.indexOf(page);
	return WORKBENCH_PAGES[(index - 1 + WORKBENCH_PAGES.length) % WORKBENCH_PAGES.length]!;
}
