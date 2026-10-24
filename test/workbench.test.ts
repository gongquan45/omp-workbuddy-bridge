/**
 * Workbench pages: what each one shows, and what a narrow screen may drop.
 *
 * Rendering is a pure function of the snapshot, so these cases assert layout
 * decisions rather than pixels: identity and state survive a narrow width, and a
 * status line only claims work that exists.
 */
import { describe, expect, it } from "bun:test";

import {
	nextPage,
	previousPage,
	renderWorkbench,
	statusLine,
	truncate,
	withCounts,
	WORKBENCH_PAGES,
	type WorkbenchPage,
	type WorkbenchSnapshot,
} from "../src/workbench";

function snapshot(overrides: Partial<Omit<WorkbenchSnapshot, "counts">> = {}): WorkbenchSnapshot {
	return withCounts({
		tasks: [],
		sessions: [],
		diagnostics: {
			install: "2.1.0 at C:/releases/2.1.0",
			projectState: "listed",
			active: null,
			projectRoot: "C:/project",
			issues: [],
		},
		...overrides,
	});
}

describe("status line", () => {
	it("is absent when there is nothing to report", () => {
		// An idle bridge must not keep a permanent badge on screen.
		expect(statusLine(snapshot())).toBeNull();
	});

	it("counts running, waiting and issues without inventing any", () => {
		const line = statusLine(
			snapshot({
				tasks: [
					{
						taskId: "11111111-1111-4111-8111-111111111111",
						round: 1,
						status: "running",
						waitReason: null,
						owner: "omp-1",
						executor: null,
						reviewState: "pending",
						artifacts: [],
						sessionBlockers: [],
					},
					{
						taskId: "22222222-2222-4222-8222-222222222222",
						round: 1,
						status: "queued",
						waitReason: "session_busy",
						owner: "omp-1",
						executor: null,
						reviewState: "pending",
						artifacts: ["out/a.md"],
						sessionBlockers: [],
					},
				],
				diagnostics: {
					install: null,
					projectState: null,
					active: null,
					projectRoot: null,
					issues: [{ severity: "error", message: "no binding", nextAction: "run /wb bind" }],
				},
			}),
		);
		expect(line).toBe("WorkBuddy: 1 running, 1 waiting, 1 issue(s)");
	});

	it("derives counts from the rows rather than trusting a caller-supplied number", () => {
		const built = withCounts({
			tasks: [
				{
					taskId: "a",
					round: 1,
					status: "running",
					waitReason: null,
					owner: null,
					executor: null,
					reviewState: "pending",
					artifacts: ["x", "y"],
					sessionBlockers: [],
				},
			],
			sessions: [],
			diagnostics: { install: null, projectState: null, active: null, projectRoot: null, issues: [] },
		});
		expect(built.counts).toEqual({ running: 1, waiting: 0, artifacts: 2 });
	});
});

describe("tasks page", () => {
	it("says what to do when the project has no tasks", () => {
		const rows = renderWorkbench(snapshot(), "tasks", 80).join("\n");
		expect(rows).toContain("No tasks in this project");
		// An empty page must point at an entry point, not just state emptiness.
		expect(rows).toContain("wb_task");
	});

	it("keeps identity and state readable on a narrow screen", () => {
		const narrow = renderWorkbench(
			snapshot({
				tasks: [
					{
						taskId: "33333333-3333-4333-8333-333333333333",
						round: 2,
						status: "awaiting_approval",
						waitReason: "scope_conflict",
						owner: "omp-session-with-a-very-long-name",
						executor: "wb-session",
						reviewState: "changes_requested",
						artifacts: ["out/report.md"],
						sessionBlockers: [],
					},
				],
			}),
			"tasks",
			40,
		);
		const text = narrow.join("\n");
		// The short id and the status survive even at 40 columns; the artifact count
		// may be dropped, because a row of ellipses helps nobody.
		expect(text).toContain("33333333");
		expect(text).toContain("awaiting");
		for (const row of narrow) {
			expect(row.length).toBeLessThanOrEqual(40);
		}
	});

	it("shows the owner, executor and review state as second-line detail", () => {
		const rows = renderWorkbench(
			snapshot({
				tasks: [
					{
						taskId: "44444444-4444-4444-8444-444444444444",
						round: 1,
						status: "completed",
						waitReason: null,
						owner: "omp-1",
						executor: "wb-9",
						reviewState: "accepted",
						artifacts: ["out/report.md"],
						sessionBlockers: [],
					},
				],
			}),
			"tasks",
			100,
		).join("\n");
		expect(rows).toContain("owner omp-1");
		expect(rows).toContain("via wb-9");
		expect(rows).toContain("review accepted");
	});

	it("names the sessions that block a pool wait, each with its own cause", () => {
		const rows = renderWorkbench(
			snapshot({
				tasks: [
					{
						taskId: "55555555-5555-4555-8555-555555555555",
						round: 1,
						status: "queued",
						waitReason: "sessions_busy_or_unavailable",
						owner: "omp-1",
						executor: null,
						reviewState: "pending",
						artifacts: [],
						sessionBlockers: [
							{ sessionId: "wb-one", reason: "session_busy" },
							{ sessionId: "wb-two", reason: "session_unavailable" },
						],
					},
				],
			}),
			"tasks",
			100,
		).join("\n");
		// "waiting" alone does not tell a user which conversation to look at.
		expect(rows).toContain("sessions_busy_or_unavailable");
		expect(rows).toContain("blocked by wb-one (session_busy)");
		expect(rows).toContain("blocked by wb-two (session_unavailable)");
	});
});

describe("sessions page", () => {
	it("explains that an empty roster is not an error, and that observation does not attach", () => {
		const rows = renderWorkbench(snapshot(), "sessions", 80).join("\n");
		expect(rows).toContain("No WorkBuddy sessions observed");
		expect(rows).toContain("never attaches");
	});

	it("shows provenance and the reason for a non-idle state", () => {
		const rows = renderWorkbench(
			snapshot({
				sessions: [
					{
						sessionId: "s1",
						title: "Delegation session",
						participation: "pending_verification",
						availability: "auth_required",
						reason: "auth_required",
						source: "registry+GET",
					},
				],
			}),
			"sessions",
			100,
		).join("\n");
		// "Verified" without provenance is a claim the user cannot check.
		expect(rows).toContain("source registry+GET");
		expect(rows).toContain("auth_required");
		expect(rows).toContain("pending_verification");
	});
});

describe("diagnostics page", () => {
	it("reports install, project state and activity as separate facts", () => {
		const rows = renderWorkbench(snapshot(), "diagnostics", 100).join("\n");
		// Each label names the question its value answers: an install fact must not be
		// printed under a project-state label, or a user debugging a missing bridge reads
		// "installed" and stops looking.
		expect(rows).toContain("install   2.1.0");
		expect(rows).toContain("state     listed");
		expect(rows).toContain("root      C:/project");
		// "Active" is unknown until OMP restarts; saying so is the honest answer.
		expect(rows).toContain("restart OMP");
	});

	it("lists every issue with the action that resolves it", () => {
		const rows = renderWorkbench(
			snapshot({
				diagnostics: {
					install: null,
					projectState: null,
					active: null,
					projectRoot: null,
					issues: [
						{
							severity: "error",
							message: "no authorized project covers this directory",
							nextAction: "run /wb setup",
						},
					],
				},
			}),
			"diagnostics",
			100,
		).join("\n");
		expect(rows).toContain("[error] no authorized project");
		expect(rows).toContain("→ run /wb setup");
	});

	it("does not claim health when there are no local problems", () => {
		const rows = renderWorkbench(snapshot(), "diagnostics", 100).join("\n");
		// A clean local check cannot prove delegation works; saying otherwise is the
		// exact overclaim the plan warns about.
		expect(rows).toContain("cannot prove delegation works");
	});
});

describe("navigation", () => {
	it("cycles through all three pages and back", () => {
		let page: WorkbenchPage = WORKBENCH_PAGES[0];
		const visited: string[] = [page];
		for (let step = 0; step < WORKBENCH_PAGES.length - 1; step++) {
			page = nextPage(page);
			visited.push(page);
		}
		expect(visited).toEqual(["tasks", "sessions", "diagnostics"]);
		// Wrapping keeps a two-key navigation usable without a boundary condition.
		expect(nextPage("diagnostics")).toBe("tasks");
		expect(previousPage("tasks")).toBe("diagnostics");
	});
});

describe("truncation", () => {
	it("marks a cut so a clipped value is not mistaken for the whole one", () => {
		expect(truncate("abcdefgh", 5)).toBe("abcd…");
		expect(truncate("abc", 5)).toBe("abc");
		expect(truncate("abcdefgh", 1)).toBe("…");
		expect(truncate("abcdefgh", 0)).toBe("");
	});
});
