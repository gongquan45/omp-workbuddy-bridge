/**
 * Discovery and session tests for the WorkBuddy desktop client.
 *
 * Discovery must only ever surface a worker that provably belongs to the
 * requested project, and a session must only ever attach to the exact bound
 * UUID. Both are asserted against local fixtures rather than the real desktop
 * app, so the tests stay isolated and repeatable.
 */
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { connect, discover, inspectWorkers, parseSocketOwners, type ConnectOptions } from "../src/desktop-client";
import { WB_ERROR_CODE } from "../src/types";
import { createFixtureRootSync, removeFixtureRoot } from "./helpers/fixtures";

/** Temporary roots created per test, removed afterwards. */
const temporaryDirs: string[] = [];

function makeTempDir(): string {
	const dir = createFixtureRootSync("wb-bridge-test-");
	temporaryDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (temporaryDirs.length > 0) {
		const dir = temporaryDirs.pop();
		if (dir !== undefined) {
			// The helper proves ownership before deleting; it never falls back to a
			// path heuristic, so a wrong fixture fails instead of removing a directory.
			await removeFixtureRoot(dir);
		}
	}
});

/** Writes one worker session state record, as the registry does. */
function writeSessionRecord(sessionsDir: string, record: Record<string, unknown>): void {
	fs.mkdirSync(sessionsDir, { recursive: true });
	const pid = typeof record.pid === "number" ? record.pid : 1000;
	fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify(record, null, 2));
}

/** Writes one worker log file in the shape the CLI dispatcher produces. */
function writeLogFile(logsDir: string, name: string, options: { cwd: string; sessionId: string; endpoints: string[]; version?: string }): void {
	const dir = path.join(logsDir, "2026-10-13");
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		`Workspace Path: ${options.cwd}`,
		`[2026/10/13 18:57:34.172] [Info] [pid=12352] [CliDispatcher]  [Prewarm] activated pid=12352 version=${options.version ?? "5.8.2"} → prevCwd=E:\\WorkBuddy, cwd=${options.cwd}, cwdChanged=true, args=["--serve","--session-id","${options.sessionId}","--permission-mode","bypassPermissions"]`,
		`[2026/10/13 18:57:34.195] [Info] [pid=12352] [WorkerRegistryLifecycle]  Worker PID file synced with session UUID: ${options.sessionId}`,
		...options.endpoints.map(
			(endpoint) => `[2026/10/13 18:59:39.996] [Info] [pid=2980] [WorkerRegistryLifecycle]  Worker registered with endpoint: ${endpoint}`,
		),
	];
	fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);
}

/** A minimal worker that answers the informational probes discovery performs. */
interface WorkerFixture {
	endpoint: string;
	requests: string[];
	stop(): void;
}

function startWorker(options: {
	cwd: string;
	sessionId: string | null;
	writerOccupied?: boolean;
	version?: string;
	healthStatus?: string;
	envelope?: boolean;
	errorBody?: boolean;
	onConnect?: (request: Request) => Response | undefined;
}): WorkerFixture {
	const requests: string[] = [];
	const wrap = (payload: Record<string, unknown>): Record<string, unknown> =>
		options.errorBody === true
			? { error: "boom" }
			: options.envelope === true
				? { data: payload }
				: payload;

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			requests.push(url.pathname);
			const handled = options.onConnect?.(request);
			if (handled !== undefined) {
				return handled;
			}
			if (url.pathname === "/api/v1/health") {
				return Response.json(
					wrap({ status: options.healthStatus ?? "ok", uptime: 12, platforms: [], pid: 4242 }),
				);
			}
			if (url.pathname === "/api/v1/info") {
				return Response.json(
					wrap({
						cwd: options.cwd,
						version: options.version ?? "5.8.2",
						os: "win32",
						arch: "x64",
						nodeVersion: "22.22.2",
						gatewayMode: "local",
						tunnelUrl: null,
						uptime: 12,
						userName: "tester",
					}),
				);
			}
			if (url.pathname === "/api/v1/sessions/live") {
				return Response.json(wrap({ sessionId: options.sessionId, writerOccupied: options.writerOccupied ?? false }));
			}
			return new Response("not found", { status: 404 });
		},
	});

	return {
		endpoint: `http://127.0.0.1:${server.port}`,
		requests,
		stop: () => void server.stop(true),
	};
}

/** Discovery options pointing at a fixture's temporary roots. */
function optionsFor(sessionsDir: string, logsDir: string, extra: ConnectOptions = {}): ConnectOptions {
	// Endpoint recovery inspects the host's real sockets, which would make these
	// tests depend on whatever WorkBuddy happens to be running, so it is disabled
	// here and exercised explicitly by the recovery tests. The socket-owner map is
	// empty for the same reason: an ownership proof must be stated by the test,
	// never inferred from the host's real process table.
	return {
		sessionsDir,
		logsDir,
		fetchTimeoutMs: 1_000,
		locateEndpoints: async () => [],
		locatePortOwners: () => new Map(),
		isOwnerAlive: () => true,
		...extra,
	};
}

/**
 * The socket-owner map that proves a fixture endpoint is owned by a worker.
 *
 * Ownership proof compares the endpoint's port owner with the pid that wrote
 * the session record, so a fixture states both. The pids are fixture-local
 * numbers that name no real process, and `isOwnerAlive` keeps the liveness
 * check off the host's real process table.
 */
function ownedBy(port: number, pid: number): Map<number, number> {
	return new Map([[port, pid]]);
}

/** The port a fixture endpoint listens on. */
function portOf(endpoint: string): number {
	return Number(new URL(endpoint).port);
}

describe("discover - session state records", () => {
	it("validates a live worker and reports its writer state", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const sessionId = "672a3eff-e57a-4bcd-8681-0eac3cdfb04f";
		const worker = startWorker({ cwd: projectRoot, sessionId, writerOccupied: true });
		try {
			writeSessionRecord(sessionsDir, {
				pid: 27324,
				sessionId,
				cwd: projectRoot,
				endpoint: worker.endpoint,
				version: "5.8.2",
			});

			const found = await discover(
				projectRoot,
				new AbortController().signal,
				optionsFor(sessionsDir, logsDir),
			);
			expect(found.length).toBe(1);
			expect(found[0]?.endpoint).toBe(worker.endpoint);
			expect(found[0]?.binding.sessionId).toBe(sessionId);
			expect(found[0]?.busy).toBe(true);
			expect(found[0]?.binding.workbuddyVersion).toBe("5.8.2");
		} finally {
			worker.stop();
		}
	});

	it("accepts a {data: ...} envelope and prefers the worker's reported version", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const worker = startWorker({ cwd: projectRoot, sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", envelope: true, version: "9.9.9" });
		try {
			writeSessionRecord(sessionsDir, {
				pid: 1,
				sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				cwd: projectRoot,
				endpoint: worker.endpoint,
			});

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found.length).toBe(1);
			expect(found[0]?.binding.workbuddyVersion).toBe("9.9.9");
		} finally {
			worker.stop();
		}
	});

	it("excludes a worker serving a different project", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const otherRoot = makeTempDir();
		const worker = startWorker({ cwd: otherRoot, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" });
		try {
			writeSessionRecord(sessionsDir, {
				pid: 2,
				sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
				cwd: projectRoot,
				endpoint: worker.endpoint,
			});

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found).toEqual([]);
		} finally {
			worker.stop();
		}
	});

	it("excludes a worker whose live session id contradicts the record", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const worker = startWorker({ cwd: projectRoot, sessionId: "11111111-2222-4333-8444-555555555555" });
		try {
			writeSessionRecord(sessionsDir, {
				pid: 3,
				sessionId: "99999999-8888-4777-8666-555555555555",
				cwd: projectRoot,
				endpoint: worker.endpoint,
			});

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found).toEqual([]);
		} finally {
			worker.stop();
		}
	});

	it("excludes a worker reporting an unhealthy status or an error body", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const sessionId = "22222222-3333-4444-8555-666666666666";
		const sick = startWorker({ cwd: projectRoot, sessionId, healthStatus: "degraded" });
		const broken = startWorker({ cwd: projectRoot, sessionId, errorBody: true });
		try {
			writeSessionRecord(sessionsDir, { pid: 4, sessionId, cwd: projectRoot, endpoint: sick.endpoint });
			writeSessionRecord(sessionsDir, { pid: 5, sessionId, cwd: projectRoot, endpoint: broken.endpoint });

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found).toEqual([]);
		} finally {
			sick.stop();
			broken.stop();
		}
	});

	it("skips malformed files and records missing required fields without throwing", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.writeFileSync(path.join(sessionsDir, "broken.json"), "{ this is not json");
		fs.writeFileSync(path.join(sessionsDir, "array.json"), "[]");
		fs.writeFileSync(
			path.join(sessionsDir, "incomplete.json"),
			JSON.stringify({ pid: 6, sessionId: "no-endpoint-here", cwd: projectRoot }),
		);

		const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
		expect(found).toEqual([]);
	});

	it("returns an empty array when no candidate source exists at all", async () => {
		const missing = path.join(makeTempDir(), "does-not-exist");
		const projectRoot = makeTempDir();
		const found = await discover(
			projectRoot,
			new AbortController().signal,
			optionsFor(path.join(missing, "sessions"), path.join(missing, "logs")),
		);
		expect(found).toEqual([]);
	});

	it("rejects endpoints that are not loopback plaintext with an explicit port", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const rejected = [
			"https://127.0.0.1:9523",
			"http://localhost:9523",
			"http://10.0.0.5:9523",
			"http://user:pw@127.0.0.1:9523",
			"http://127.0.0.1",
			"ftp://127.0.0.1:9523",
		];
		rejected.forEach((endpoint, index) => {
			writeSessionRecord(sessionsDir, {
				pid: 100 + index,
				sessionId: `33333333-4444-4555-8666-77777777777${index}`,
				cwd: projectRoot,
				endpoint,
			});
		});

		const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
		expect(found).toEqual([]);
	});

	it("drops a candidate whose worker stops answering within the probe budget", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const dead = startWorker({
			cwd: projectRoot,
			sessionId: "44444444-5555-4666-8777-888888888888",
			onConnect: () => new Response("gone", { status: 500 }),
		});
		try {
			writeSessionRecord(sessionsDir, {
				pid: 7,
				sessionId: "44444444-5555-4666-8777-888888888888",
				cwd: projectRoot,
				endpoint: dead.endpoint,
			});

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found).toEqual([]);
		} finally {
			dead.stop();
		}
	});
});

describe("discover - log fallback", () => {
	it("recovers the session UUID, endpoint and version from a log file", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "50d68b61-35cc-437f-98b1-fe882efeb8a9";
		const worker = startWorker({ cwd: projectRoot, sessionId });
		try {
			// Two registrations: the later one is the live worker.
			writeLogFile(logsDir, "run.log", {
				cwd: projectRoot,
				sessionId,
				endpoints: ["http://127.0.0.1:1"],
				version: "5.8.2",
			});
			// Replace the fixture's endpoint by appending the live registration.
			fs.appendFileSync(
				path.join(logsDir, "2026-10-13", "run.log"),
				`[2026/10/13 19:10:55.687] [Info] [pid=20432] [WorkerRegistryLifecycle]  Worker registered with endpoint: ${worker.endpoint}\n`,
			);

			// Only an endpoint with a current listener counts: the fixture's own port is
			// declared listening, and the stale `127.0.0.1:1` registration is not.
			const found = await discover(projectRoot, new AbortController().signal, {
				...optionsFor(sessionsDir, logsDir),
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 20432),
			});
			expect(found.length).toBe(1);
			expect(found[0]?.endpoint).toBe(worker.endpoint);
			expect(found[0]?.binding.sessionId).toBe(sessionId);
			expect(found[0]?.binding.workbuddyVersion).toBe("5.8.2");
		} finally {
			worker.stop();
		}
	});

	it("ignores logs that never reach a registered endpoint", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		writeLogFile(logsDir, "aborted.log", {
			cwd: projectRoot,
			sessionId: "55555555-6666-4777-8888-999999999999",
			endpoints: [],
		});

		const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
		expect(found).toEqual([]);
	});

	it("deduplicates a session recorded by both sources", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
		const worker = startWorker({ cwd: projectRoot, sessionId });
		try {
			writeSessionRecord(sessionsDir, { pid: 8, sessionId, cwd: projectRoot, endpoint: worker.endpoint });
			writeLogFile(logsDir, "both.log", { cwd: projectRoot, sessionId, endpoints: [worker.endpoint] });

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
			expect(found.length).toBe(1);
		} finally {
			worker.stop();
		}
	});
});

describe("connect - binding lifecycle", () => {
	it("reports a missing worker as WB_SESSION_NOT_RUNNING", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const failure = await connect(
			{ version: 1, projectRoot, sessionId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb", workbuddyVersion: "5.8.2" },
			{ onUpdate: async () => undefined, onRequest: async () => undefined },
			new AbortController().signal,
			optionsFor(sessionsDir, logsDir),
		).catch((error: unknown) => error);
		expect(codedOf(failure)).toBe(WB_ERROR_CODE.sessionNotRunning);
	});

	it("reports an occupied writer as WB_BUSY", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const sessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
		const worker = startWorker({ cwd: projectRoot, sessionId, writerOccupied: true });
		try {
			writeSessionRecord(sessionsDir, { pid: 9, sessionId, cwd: projectRoot, endpoint: worker.endpoint });
			const failure = await connect(
				{ version: 1, projectRoot, sessionId, workbuddyVersion: "5.8.2" },
				{ onUpdate: async () => undefined, onRequest: async () => undefined },
				new AbortController().signal,
				optionsFor(sessionsDir, logsDir),
			).catch((error: unknown) => error);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.busy);
		} finally {
			worker.stop();
		}
	});

	it("maps a refused connection to WB_AUTH_REQUIRED", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = makeTempDir();
		const sessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
		// The worker refuses every request, auxiliary probes included, so the
		// credential-gated branch is the one under test.
		const worker = startWorker({
			cwd: projectRoot,
			sessionId,
			onConnect: () => new Response("denied", { status: 403 }),
		});
		// The worker that owns the endpoint. Its registry record is what proves
		// which conversation this address serves, so it has to name this session
		// and this project as a current interactive worker.
		const ownerPid = 10;
		try {
			writeSessionRecord(sessionsDir, {
				pid: ownerPid,
				kind: "interactive",
				sessionId,
				cwd: projectRoot,
				endpoint: worker.endpoint,
			});
			const failure = await connect(
				{ version: 1, projectRoot, sessionId, workbuddyVersion: "5.8.2" },
				{ onUpdate: async () => undefined, onRequest: async () => undefined },
				new AbortController().signal,
				optionsFor(sessionsDir, logsDir, {
					// The endpoint's socket owner is the worker that wrote the record,
					// so the handshake is reached and refused there.
					locatePortOwners: () => ownedBy(portOf(worker.endpoint), ownerPid),
					isOwnerAlive: () => true,
				}),
			).catch((error: unknown) => error);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.authRequired);
		} finally {
			worker.stop();
		}
	});

	it("recovers a session whose worker published no endpoint, pairing it with the live worker", async () => {
		// WorkBuddy activates some sessions from a prewarm pool, and those workers
		// serve ACP on an OS-assigned port they never record. The session must still
		// be discovered, with its version recovered from the worker's own log.
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "abababab-cdcd-4efe-8a0a-1b1b1b1b1b1b";

		const worker = startAcpWorker({ cwd: projectRoot, sessionId });
		try {
			// The record names the session but no endpoint, as a prewarm activation does.
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "4242.json"),
				JSON.stringify({ pid: 4242, sessionId, cwd: projectRoot, kind: "interactive" }),
			);
			// The log carries the worker's version for that same session.
			writeLogFile(logsDir, "run.log", {
				cwd: projectRoot,
				sessionId,
				endpoints: [],
				version: "5.8.2",
			});

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				// The OS-level enumeration only keeps endpoints owned by a real
				// WorkBuddy process, so the fixture supplies its endpoint directly.
				locateEndpoints: async () => [worker.endpoint],
				// Pairing follows the socket owner: this fixture's record pid 4242 is
				// the process the endpoint belongs to.
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 4242),
				isOwnerAlive: () => true,
			});

			const match = found.find((candidate) => candidate.binding.sessionId === sessionId);
			expect(match).toBeDefined();
			expect(match?.endpoint).toBe(worker.endpoint);
			// The version comes from the worker's log, since the session record of a
			// prewarm-activated worker does not carry one.
			expect(match?.binding.workbuddyVersion).toBe("5.8.2");
			expect(match?.busy).toBe(false);
		} finally {
			worker.stop();
		}
	});

	it("pairs an endpoint only with the session record that owns its socket", async () => {
		// The real failure: a WorkBuddy 5.8.3 worker answers every /api/v1 probe with
		// 401, so validation falls through to ACP, where `session/resume` accepts any
		// UUID and reports no sessionId back. Two interactive records for the same
		// project were paired with the one live endpoint — the process behind it and
		// an older session whose worker had exited — so discovery returned two
		// candidates for one port. The stale one carried no version (it never appeared
		// in a prewarm activation banner) and came first, so binding it failed with
		// "workbuddyVersion must be a non-empty string".
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const liveSession = "11111111-2222-4333-8444-555555555555";
		const staleSession = "99999999-8888-4777-8666-555555555555";

		const acp = startAcpWorker({ cwd: projectRoot, sessionId: liveSession, omitResumedSessionId: true });
		const combined = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/api/v1/acp")) {
					return await fetch(`${acp.endpoint}${url.pathname}${url.search}`, {
						method: request.method,
						headers: request.headers,
						body: request.method === "POST" ? await request.text() : undefined,
					});
				}
				// Every auxiliary probe is credential-gated, exactly like the desktop worker.
				return new Response("unauthorized", { status: 401 });
			},
		});
		const endpoint = `http://127.0.0.1:${combined.port}`;
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "7001.json"),
				JSON.stringify({ pid: 7001, sessionId: staleSession, cwd: projectRoot, kind: "interactive" }),
			);
			fs.writeFileSync(
				path.join(sessionsDir, "7002.json"),
				JSON.stringify({ pid: 7002, sessionId: liveSession, cwd: projectRoot, kind: "interactive" }),
			);
			// Neither record names an endpoint, exactly as a prewarm-activated worker
			// writes them, so both reach the pairing loop and compete for the one port.
			// The log gives the live session its version; the stale one has none.
			writeLogFile(logsDir, "live.log", { cwd: projectRoot, sessionId: liveSession, endpoints: [] });

			const port = Number(new URL(endpoint).port);
			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [endpoint],
				locatePortOwners: () => ownedBy(port, 7002),
				isOwnerAlive: () => true,
			});

			expect(found.length).toBe(1);
			expect(found[0]?.binding.sessionId).toBe(liveSession);
			expect(found[0]?.binding.workbuddyVersion).not.toBe("");
		} finally {
			acp.stop();
			combined.stop(true);
		}
	});

	it("verifies through ACP when the worker gates its HTTP probes behind a credential", async () => {
		// A real desktop worker (WorkBuddy 5.8.3) answers every /api/v1 probe with 401
		// while its ACP surface accepts the attach path, which is where the credential
		// lives. Concluding "no usable session" there made every such worker
		// undiscoverable, so the handshake — the surface dispatch actually uses — has
		// to decide, with the same resume + cwd identity checks.
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "efefefef-abab-4b0b-9c1c-3d3d3d3d3d3d";

		const acp = startAcpWorker({ cwd: projectRoot, sessionId });
		const refusing = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("unauthorized", { status: 401 }),
		});
		// One endpoint that refuses probes and speaks ACP is what a real worker looks
		// like; routing both paths to the same port keeps the fixture honest.
		const combined = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/api/v1/acp")) {
					return await fetch(`${acp.endpoint}${url.pathname}${url.search}`, {
						method: request.method,
						headers: request.headers,
						body: request.method === "POST" ? await request.text() : undefined,
					});
				}
				if (url.pathname.startsWith("/api/v1/")) {
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("not found", { status: 404 });
			},
		});
		void refusing;
		const endpoint = `http://127.0.0.1:${combined.port}`;
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "4242.json"),
				JSON.stringify({ pid: 4242, sessionId, cwd: projectRoot, kind: "interactive", endpoint }),
			);

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [endpoint],
				// The endpoint's socket owner is the worker that wrote the record
				// above; without that proof the handshake is never entered.
				locatePortOwners: () => ownedBy(portOf(endpoint), 4242),
				isOwnerAlive: () => true,
			});
			const match = found.find((candidate) => candidate.binding.sessionId === sessionId);
			expect(match).toBeDefined();
			expect(match?.endpoint).toBe(endpoint);
			expect(match?.busy).toBe(false);
		} finally {
			acp.stop();
			combined.stop(true);
			refusing.stop(true);
		}
	});

	it("rejects a recovered endpoint that serves a different session", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "cdcdcdcd-efef-4a0a-8b1b-2c2c2c2c2c2c";

		// The worker answers for some other session, so the pairing must not stick.
		const worker = startAcpWorker({ cwd: projectRoot, sessionId: "00000000-1111-4222-8333-444444444444" });
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "4243.json"),
				JSON.stringify({ pid: 4243, sessionId, cwd: projectRoot, kind: "interactive" }),
			);

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [worker.endpoint],
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 4243),
				isOwnerAlive: () => true,
			});
			expect(found).toEqual([]);
			// The ownership proof holds — the socket owner is the recorded worker —
			// but the worker serves a different conversation, so the handshake is
			// refused rather than adopted.
			expect(worker.calls).toContain("session/resume");
		} finally {
			worker.stop();
		}
	});
});

/**
 * The ownership gate that stands between a discovered address and the ACP
 * handshake.
 *
 * A native WorkBuddy 5.8.3 worker answers `session/resume` for a UUID it does
 * not own and can *create* that UUID, so entering ACP on an address whose
 * owner is not proven creates the very session discovery is meant to find. A
 * historical log address whose port has since been taken by another worker of
 * the same project is the concrete failure: resuming the old UUID there would
 * materialize a session nobody owns.
 */
describe("discover - endpoint ownership gate", () => {
	/** A worker that refuses every auxiliary probe and speaks ACP, like the real one. */
	function startGatedWorker(options: {
		cwd: string;
		sessionId: string;
		omitResumedSessionId?: boolean;
	}): { endpoint: string; calls: string[]; stop(): void } {
		const acp = startAcpWorker({
			cwd: options.cwd,
			sessionId: options.sessionId,
			...(options.omitResumedSessionId === true ? { omitResumedSessionId: true } : {}),
		});
		const combined = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/api/v1/acp")) {
					return await fetch(`${acp.endpoint}${url.pathname}${url.search}`, {
						method: request.method,
						headers: request.headers,
						body: request.method === "POST" ? await request.text() : undefined,
					});
				}
				// Every auxiliary probe is credential-gated, exactly like the desktop
				// worker, which is what pushes validation onto the ACP path.
				return new Response("unauthorized", { status: 401 });
			},
		});
		return {
			endpoint: `http://127.0.0.1:${combined.port}`,
			calls: acp.calls,
			stop: () => {
				acp.stop();
				combined.stop(true);
			},
		};
	}

	it("never enters ACP for a stale log address now owned by another worker", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const staleSession = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
		const liveSession = "cccccccc-4444-4555-8666-dddddddddddd";

		const worker = startGatedWorker({ cwd: projectRoot, sessionId: liveSession });
		try {
			// The log records the address the *stale* worker once had. The port now
			// belongs to the live worker, so the address is live but the session it
			// names is not.
			writeLogFile(logsDir, "stale.log", {
				cwd: projectRoot,
				sessionId: staleSession,
				endpoints: [worker.endpoint],
			});
			// The live worker's own registry record names a different session, so
			// the address cannot be proven to serve the stale one.
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "5150.json"),
				JSON.stringify({ pid: 5150, sessionId: liveSession, cwd: projectRoot, kind: "interactive" }),
			);

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [],
				// The socket owner is the live worker, not the stale session.
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 5150),
				isOwnerAlive: () => true,
			});

			expect(found).toEqual([]);
			// The whole point: no handshake, so no session was created or resumed.
			expect(worker.calls).toEqual([]);
			expect(worker.calls).not.toContain("initialize");
			expect(worker.calls).not.toContain("session/resume");
			expect(worker.calls).not.toContain("session/load");
			expect(worker.calls).not.toContain("session/new");
		} finally {
			worker.stop();
		}
	});

	it("never enters ACP when the socket owner is a different pid than the record", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "eeeeeeee-6666-4777-8888-eeeeeeeeeeee";

		const worker = startGatedWorker({ cwd: projectRoot, sessionId });
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "6161.json"),
				JSON.stringify({
					pid: 6161,
					sessionId,
					cwd: projectRoot,
					kind: "interactive",
					endpoint: worker.endpoint,
				}),
			);

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [],
				// The endpoint's socket owner is some other process entirely.
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 7171),
				isOwnerAlive: () => true,
			});

			expect(found).toEqual([]);
			expect(worker.calls).toEqual([]);
		} finally {
			worker.stop();
		}
	});

	it("never enters ACP for a log-only candidate with no registry record at all", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "ffffffff-7777-4888-8999-ffffffffffff";

		const worker = startGatedWorker({ cwd: projectRoot, sessionId });
		try {
			// Only the log knows this session; the registry does not.
			writeLogFile(logsDir, "logonly.log", {
				cwd: projectRoot,
				sessionId,
				endpoints: [worker.endpoint],
			});

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [],
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 8181),
				isOwnerAlive: () => true,
			});

			expect(found).toEqual([]);
			expect(worker.calls).toEqual([]);
		} finally {
			worker.stop();
		}
	});

	it("still binds a genuinely owned active child whose probes are refused", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "12121212-3434-4565-8787-909090909090";

		const worker = startGatedWorker({ cwd: projectRoot, sessionId });
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "9191.json"),
				JSON.stringify({ pid: 9191, sessionId, cwd: projectRoot, kind: "interactive" }),
			);
			// The worker's version comes from its own startup banner, which is where
			// a credential-gated worker records it.
			writeLogFile(logsDir, "owned.log", { cwd: projectRoot, sessionId, endpoints: [], version: "5.8.3" });

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [worker.endpoint],
				// The proof: the endpoint's socket owner is the very worker whose
				// current registry record names this session and directory.
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 9191),
				isOwnerAlive: () => true,
			});

			expect(found.length).toBe(1);
			expect(found[0]?.binding.sessionId).toBe(sessionId);
			expect(found[0]?.endpoint).toBe(worker.endpoint);
			expect(found[0]?.binding.workbuddyVersion).toBe("5.8.3");
			// The handshake really happened, which is what the refused probes
			// require.
			expect(worker.calls).toContain("initialize");
			expect(worker.calls).toContain("session/resume");
			expect(worker.calls).not.toContain("session/new");
		} finally {
			worker.stop();
		}
	});

	it("refuses to inherit a dead worker's identity through a reused pid", async () => {
		const logsDir = makeTempDir();
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const projectRoot = makeTempDir();
		const sessionId = "13131313-5656-4788-8989-121212121212";

		const worker = startGatedWorker({ cwd: projectRoot, sessionId });
		try {
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "9292.json"),
				JSON.stringify({ pid: 9292, sessionId, cwd: projectRoot, kind: "interactive" }),
			);

			const found = await discover(projectRoot, new AbortController().signal, {
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 2_000,
				locateEndpoints: async () => [worker.endpoint],
				locatePortOwners: () => ownedBy(portOf(worker.endpoint), 9292),
				// The owner is gone; the pid was taken over by something else.
				isOwnerAlive: () => false,
			});

			expect(found).toEqual([]);
			expect(worker.calls).toEqual([]);
		} finally {
			worker.stop();
		}
	});
});

/**
 * A minimal ACP-speaking worker used to prove the recovery handshake.
 *
 * It answers the connect handshake and the ACP resume, which is exactly what
 * recovery uses to confirm a candidate belongs to the requested session.
 */
function startAcpWorker(options: { cwd: string; sessionId: string; omitResumedSessionId?: boolean }): { endpoint: string; stop(): void; calls: string[] } {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/v1/acp/connect") {
				return Response.json({ connectionId: "recovery-probe" });
			}
			if (url.pathname === "/api/v1/acp" && request.method === "DELETE") {
				return new Response("", { status: 200 });
			}
			if (url.pathname === "/api/v1/acp" && request.method === "POST") {
				const body = JSON.parse(await request.text()) as { id: unknown; method: string };
				calls.push(body.method);
				// Each reply is one complete SSE body prefixed by the framing comment.
				const frames: string[] = [":ok\n\n"];
				if (body.method === "initialize") {
					frames.push(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
						})}\n\n`,
					);
				} else if (body.method === "session/resume") {
					frames.push(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							// A real WorkBuddy 5.8.3 worker replies without a `sessionId`
							// field at all (observed: resuming two different UUIDs both
							// returned `undefined`). The fixture can reproduce that, which is
							// the case where resumption alone cannot prove identity.
							result: options.omitResumedSessionId
								? { cwd: options.cwd }
								: { sessionId: options.sessionId, cwd: options.cwd },
						})}\n\n`,
					);
				} else {
					frames.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`);
				}
				return new Response(frames.join(""), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}`,
		stop: () => void server.stop(true),
		calls,
	};
}

/** Reads the `WB_*` code off an error without trusting its shape. */
function codedOf(error: unknown): string | undefined {
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

describe("inspectWorkers - GET-only verification", () => {
	/** Records every request's method and path, so no write can hide in a probe. */
	interface InspectWorkerFixture {
		endpoint: string;
		requests: string[];
		methods: string[];
		stop(): void;
	}

	function startInspectWorker(options: {
		cwd: string;
		sessionId: string | null;
		writerOccupied?: boolean;
		version?: string;
		healthStatus?: string;
		healthBody?: unknown;
		infoBody?: unknown;
		liveBody?: unknown;
		refuse?: boolean;
		missing?: "health" | "info" | "live";
	}): InspectWorkerFixture {
		const requests: string[] = [];
		const methods: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				requests.push(url.pathname);
				methods.push(request.method);
				if (options.refuse === true) {
					return new Response("unauthorized", { status: 401 });
				}
				if (options.missing === "health" && url.pathname === "/api/v1/health") {
					return new Response("not found", { status: 404 });
				}
				if (options.missing === "info" && url.pathname === "/api/v1/info") {
					return new Response("not found", { status: 404 });
				}
				if (options.missing === "live" && url.pathname === "/api/v1/sessions/live") {
					return new Response("not found", { status: 404 });
				}
				if (url.pathname === "/api/v1/health") {
					return Response.json(
						options.healthBody ?? { status: options.healthStatus ?? "ok", uptime: 12, pid: 4242 },
					);
				}
				if (url.pathname === "/api/v1/info") {
					return Response.json(
						options.infoBody ?? { cwd: options.cwd, version: options.version ?? "5.8.2", os: "win32" },
					);
				}
				if (url.pathname === "/api/v1/sessions/live") {
					return Response.json(
						options.liveBody ?? {
							sessionId: options.sessionId,
							writerOccupied: options.writerOccupied ?? false,
						},
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		return {
			endpoint: `http://127.0.0.1:${server.port}`,
			requests,
			methods,
			stop: () => void server.stop(true),
		};
	}

	/** Writes the registry entry that associates a session id with an endpoint. */
	function registerSession(sessionsDir: string, sessionId: string, cwd: string, endpoint: string): void {
		writeSessionRecord(sessionsDir, { pid: 4242, kind: "interactive", sessionId, cwd, endpoint });
	}

	const BOUND_SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

	it("reports a healthy worker as verified and sends only the three allowed GETs", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const worker = startInspectWorker({ cwd: projectRoot, sessionId: BOUND_SESSION });
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, worker.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);

			expect(inspections).toEqual([
				{ endpoint: worker.endpoint, status: "verified", workbuddyVersion: "5.8.2" },
			]);
			// The read-only contract: no POST, no DELETE, only the documented probes.
			expect([...new Set(worker.methods)]).toEqual(["GET"]);
			expect([...worker.requests].sort()).toEqual([
				"/api/v1/health",
				"/api/v1/info",
				"/api/v1/sessions/live",
			]);
		} finally {
			worker.stop();
		}
	});

	it("reports an occupied writer as busy without attaching", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const worker = startInspectWorker({ cwd: projectRoot, sessionId: BOUND_SESSION, writerOccupied: true });
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, worker.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);
			expect(inspections[0]?.status).toBe("busy");
			expect(worker.methods.every((method) => method === "GET")).toBe(true);
		} finally {
			worker.stop();
		}
	});

	it("reports a refused probe as auth_required without falling back to ACP", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const worker = startInspectWorker({ cwd: projectRoot, sessionId: BOUND_SESSION, refuse: true });
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, worker.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);
			expect(inspections[0]?.status).toBe("auth_required");
			// A refused auxiliary surface must not trigger an ACP handshake.
			expect(worker.methods.every((method) => method === "GET")).toBe(true);
		} finally {
			worker.stop();
		}
	});

	it("reports an unhealthy worker as such", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const sick = startInspectWorker({ cwd: projectRoot, sessionId: BOUND_SESSION, healthStatus: "degraded" });
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, sick.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);
			expect(inspections.map((inspection) => inspection.status)).toEqual(["unhealthy"]);
		} finally {
			sick.stop();
		}
	});

	it("reports a worker whose reported cwd is another project as a mismatch", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const foreignRoot = await fs.promises.realpath(makeTempDir());
		// The session record claims this project, but the worker itself reports a
		// different one, which is exactly what the identity check must catch.
		const foreign = startInspectWorker({ cwd: foreignRoot, sessionId: BOUND_SESSION });
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, foreign.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);
			expect(inspections.map((inspection) => inspection.status)).toEqual(["mismatch"]);
		} finally {
			foreign.stop();
		}
	});

	it("reports unknown when a probe returns no usable identity", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		// The info body carries no cwd, so identity cannot be established.
		const worker = startInspectWorker({
			cwd: projectRoot,
			sessionId: BOUND_SESSION,
			infoBody: { version: "5.8.2", os: "win32" },
		});
		try {
			registerSession(sessionsDir, BOUND_SESSION, projectRoot, worker.endpoint);
			const inspections = await inspectWorkers(
				{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
				new AbortController().signal,
				{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
			);
			expect(inspections[0]?.status).toBe("unknown");
		} finally {
			worker.stop();
		}
	});

	it("reports an endpoint that stopped answering as unreachable, not unknown", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		// A worker recorded an endpoint, then exited before the probe. A registry
		// record is exactly what discovery trusts without a reachability check, so
		// this is the case where "nothing answered" really reaches diagnosis — and it
		// must be reported as a session that is gone, not as one this build cannot
		// read, which would send the user to restart a healthy desktop.
		const gone = startInspectWorker({ cwd: projectRoot, sessionId: BOUND_SESSION });
		const closedPort = Number(new URL(gone.endpoint).port);
		gone.stop();
		registerSession(sessionsDir, BOUND_SESSION, projectRoot, `http://127.0.0.1:${closedPort}`);
		const inspections = await inspectWorkers(
			{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
			new AbortController().signal,
			{
				sessionsDir,
				logsDir,
				fetchTimeoutMs: 1_000,
				locateEndpoints: async () => [],
				locatePortOwners: () => new Map([[closedPort, 4242]]),
			},
		);
		expect(inspections.map((inspection) => inspection.status)).toEqual(["unreachable"]);
	});

	it("returns nothing when no worker matches the bound session", async () => {
		const sessionsDir = path.join(makeTempDir(), "sessions");
		const logsDir = makeTempDir();
		const projectRoot = await fs.promises.realpath(makeTempDir());
		const inspections = await inspectWorkers(
			{ version: 1, projectRoot, sessionId: BOUND_SESSION, workbuddyVersion: "5.8.2" },
			new AbortController().signal,
			{ sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [] },
		);
		// An empty result means nothing was found, never that the worker is stopped.
		expect(inspections).toEqual([]);
	});
});

/**
 * The socket table is a snapshot of a live system, and the states a connection
 * passes through are part of that snapshot.
 *
 * A worker whose serving port is caught mid-close shows that port in a closing
 * state and never as a listener. Reading only the "server-looking" states made
 * the port of a running worker disappear from the owner map, and the worker's
 * session then looked absent from its project even though it was serving.
 */
describe("parseSocketOwners - live socket table states", () => {
	it("keeps a port that is only seen in a closing state", () => {
		const table = [
			"  TCP    127.0.0.1:9065         127.0.0.1:3495         ESTABLISHED     12692",
			"  TCP    127.0.0.1:9065         127.0.0.1:4761         FIN_WAIT_1      12692",
			"  TCP    127.0.0.1:3718         127.0.0.1:3719         ESTABLISHED     21940",
			"  TCP    127.0.0.1:3718         0.0.0.0:0              LISTENING       21940",
		].join("\r\n");

		const owners = parseSocketOwners(table);
		// The port caught mid-close is still the port its process serves.
		expect(owners.get(9065)).toBe(12692);
		expect(owners.get(3718)).toBe(21940);
	});

	it("prefers the listening socket's owner over a client's row for the same port", () => {
		// The same port appears as the local end of a connection held by the
		// client, and as a listener owned by the server. The server's row is
		// authoritative, because the client is the one that connected.
		const table = [
			"  TCP    127.0.0.1:9065         127.0.0.1:9066         ESTABLISHED     11688",
			"  TCP    127.0.0.1:9065         0.0.0.0:0              LISTENING       12692",
		].join("\r\n");

		expect(parseSocketOwners(table).get(9065)).toBe(12692);
	});

	it("ignores rows that are not loopback or carry no usable pid", () => {
		const table = [
			"  TCP    0.0.0.0:1029           0.0.0.0:0              LISTENING       1344",
			"  TCP    192.168.0.175:139      0.0.0.0:0              LISTENING       4",
			"  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       0",
		].join("\r\n");

		const owners = parseSocketOwners(table);
		expect(owners.size).toBe(0);
	});
});
