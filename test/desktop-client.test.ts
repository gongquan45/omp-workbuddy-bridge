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
import os from "node:os";
import path from "node:path";
import { connect, discover, inspectWorkers, type ConnectOptions } from "../src/desktop-client";
import { WB_ERROR_CODE } from "../src/types";

/** Temporary roots created per test, removed afterwards. */
const temporaryDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bridge-test-"));
	temporaryDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (temporaryDirs.length > 0) {
		const dir = temporaryDirs.pop();
		if (dir !== undefined) {
			fs.rmSync(dir, { recursive: true, force: true });
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
	// here and exercised explicitly by the recovery tests.
	return { sessionsDir, logsDir, fetchTimeoutMs: 1_000, locateEndpoints: async () => [], ...extra };
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

			const found = await discover(projectRoot, new AbortController().signal, optionsFor(sessionsDir, logsDir));
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
		const worker = startWorker({
			cwd: projectRoot,
			sessionId,
			onConnect: () => new Response("denied", { status: 403 }),
		});
		try {
			writeSessionRecord(sessionsDir, { pid: 10, sessionId, cwd: projectRoot, endpoint: worker.endpoint });
			const failure = await connect(
				{ version: 1, projectRoot, sessionId, workbuddyVersion: "5.8.2" },
				{ onUpdate: async () => undefined, onRequest: async () => undefined },
				new AbortController().signal,
				optionsFor(sessionsDir, logsDir),
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
			});
			expect(found).toEqual([]);
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
function startAcpWorker(options: { cwd: string; sessionId: string }): { endpoint: string; stop(): void } {
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
							result: { sessionId: options.sessionId, cwd: options.cwd },
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
