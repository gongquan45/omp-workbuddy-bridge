/**
 * ACP handshake and turn tests for the WorkBuddy desktop client.
 *
 * A local fixture serves the same ACP-over-HTTP surface the real worker exposes:
 * a `/api/v1/acp/connect` handshake, then SSE-framed JSON-RPC replies on
 * `/api/v1/acp`. Critically, a `session/prompt` POST answers with a stream that
 * stays open for the whole turn — that stream carries the turn's updates and can
 * carry a permission request the client must answer *before* the turn resolves.
 */
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type ConnectOptions } from "../src/desktop-client";
import type { DesktopSessionUpdate } from "../src/types";
import { WB_ERROR_CODE } from "../src/types";

const temporaryDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bridge-acp-"));
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

/** One JSON-RPC message the fixture received. */
interface ReceivedMessage {
	method?: string;
	id?: unknown;
	params?: Record<string, unknown>;
}

/** Per-POST reply stream, mirroring the worker's behaviour. */
class ReplyStream {
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	readonly response: Response;

	constructor() {
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
			},
		});
		// The worker writes a framing marker immediately so headers reach the
		// client before the first real message.
		this.controller?.enqueue(new TextEncoder().encode(":ok\n\n"));
		this.response = new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	/** Emits one JSON-RPC message on this stream. */
	send(frame: unknown): void {
		this.controller?.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
	}

	/** Emits a JSON-RPC response for the given request id. */
	respond(id: unknown, result: unknown): void {
		this.send({ jsonrpc: "2.0", id, result });
	}

	/** Ends this stream. */
	end(): void {
		this.controller?.close();
		this.controller = undefined;
	}
}

/**
 * A stand-in for one WorkBuddy worker speaking ACP over HTTP.
 *
 * `agentCapabilities` controls what the handshake advertises, which selects the
 * resume / load / refuse paths.
 */
class AcpFixture {
	readonly received: ReceivedMessage[] = [];
	readonly endpointsTouched: string[] = [];
	/** Methods the server claims not to implement. */
	readonly unsupported = new Set<string>();
	/** Stop reason the next `session/prompt` response carries. */
	stopReason = "end_turn";
	/** Error message the next `session/prompt` response carries. */
	errorMessage: string | undefined;
	/** Session id the resume/load response echoes back. */
	returnedSessionId: string | undefined;
	/** Updates emitted on a prompt's stream before its response. */
	updatesOnPrompt: Array<Record<string, unknown>> = [];
	/** Updates emitted on the resume/load stream right after its response. */
	updatesAfterHandshake: Array<Record<string, unknown>> = [];
	/** Keeps a prompt's stream open until the test ends it. */
	holdPrompt = false;
	/** JSON-RPC error the worker answers `session/resume` with, if any. */
	resumeError: unknown;

	/** Streams opened for prompt turns, so a test can drive a live turn. */
	readonly promptStreams: ReplyStream[] = [];
	/** Streams opened for non-prompt requests. */
	private readonly otherStreams: ReplyStream[] = [];
	private server!: ReturnType<typeof Bun.serve>;

	constructor(
		private readonly options: {
			cwd: string;
			sessionId: string;
			agentCapabilities?: Record<string, unknown>;
			advertiseProtocol?: number;
		},
	) {}

	get endpoint(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	start(): void {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => this.handle(request),
		});
	}

	stop(): void {
		for (const stream of this.promptStreams) {
			stream.end();
		}
		this.promptStreams.length = 0;
		for (const stream of this.otherStreams) {
			stream.end();
		}
		this.otherStreams.length = 0;
		this.server.stop(true);
	}

	lastMethodCall(method: string): ReceivedMessage | undefined {
		return [...this.received].reverse().find((message) => message.method === method);
	}

	countMethodCalls(method: string): number {
		return this.received.filter((message) => message.method === method).length;
	}

	/** Endpoints other than the ACP surface that the client reached. */
	nonAcpEndpointsTouched(): string[] {
		return this.endpointsTouched.filter((endpoint) => !endpoint.startsWith("/api/v1/acp"));
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		this.endpointsTouched.push(url.pathname);

		if (url.pathname === "/api/v1/acp/connect") {
			// A real worker can refuse here too, which the caller maps itself.
			return Response.json({ connectionId: "fixture-connection" });
		}
		if (url.pathname === "/api/v1/acp" && request.method === "DELETE") {
			return new Response("", { status: 200 });
		}
		if (url.pathname === "/api/v1/acp" && request.method === "GET") {
			return new Response("", { status: 404 });
		}
		if (url.pathname === "/api/v1/acp" && request.method === "POST") {
			return this.handleJsonRpc(await request.text());
		}
		if (url.pathname === "/api/v1/health") {
			return Response.json({ status: "ok", uptime: 1, platforms: [], pid: 1 });
		}
		if (url.pathname === "/api/v1/info") {
			return Response.json({
				cwd: this.options.cwd,
				version: "5.8.2",
				os: "win32",
				arch: "x64",
				nodeVersion: "22.22.2",
				gatewayMode: "local",
				tunnelUrl: null,
				uptime: 1,
				userName: "tester",
			});
		}
		if (url.pathname === "/api/v1/sessions/live") {
			return Response.json({ sessionId: this.options.sessionId, writerOccupied: false });
		}
		return new Response("not found", { status: 404 });
	}

	private handleJsonRpc(body: string): Response {
		const message = JSON.parse(body) as ReceivedMessage;
		if (typeof message.method !== "string") {
			return new Response("bad request", { status: 400 });
		}
		this.received.push({ method: message.method, id: message.id, params: message.params });

		if (this.unsupported.has(message.method)) {
			const stream = new ReplyStream();
			this.otherStreams.push(stream);
			stream.send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: "Method not found" },
			});
			stream.end();
			return stream.response;
		}

		switch (message.method) {
			case "initialize": {
				const stream = new ReplyStream();
				stream.respond(message.id, {
					protocolVersion: this.options.advertiseProtocol ?? 1,
					agentCapabilities: this.options.agentCapabilities ?? { loadSession: true },
				});
				stream.end();
				this.otherStreams.push(stream);
				return stream.response;
			}
			case "session/resume":
			case "session/load": {
				const stream = new ReplyStream();
				if (this.resumeError !== undefined) {
					const failure = this.resumeError as { code: number; message: string; data?: unknown };
					stream.send({ jsonrpc: "2.0", id: message.id, error: failure });
				} else {
					stream.respond(message.id, {
						sessionId: this.returnedSessionId ?? this.options.sessionId,
						models: {},
						modes: {},
					});
					for (const update of this.updatesAfterHandshake) {
						stream.send({ jsonrpc: "2.0", method: "session/update", params: update });
					}
				}
				stream.end();
				this.otherStreams.push(stream);
				return stream.response;
			}
			case "session/cancel": {
				// A notification: no reply is owed, so the stream just ends.
				const stream = new ReplyStream();
				stream.end();
				this.otherStreams.push(stream);
				return stream.response;
			}
			case "session/prompt": {
				// The prompt's own stream stays open for the turn, exactly as the
				// real worker's does.
				const stream = new ReplyStream();
				this.promptStreams.push(stream);
				for (const update of this.updatesOnPrompt) {
					stream.send({ jsonrpc: "2.0", method: "session/update", params: update });
				}
				if (!this.holdPrompt) {
					stream.send({
						jsonrpc: "2.0",
						id: message.id,
						result:
							this.errorMessage === undefined
								? { stopReason: this.stopReason }
								: { stopReason: this.stopReason, errorMessage: this.errorMessage },
					});
				}
				return stream.response;
			}
			default: {
				const stream = new ReplyStream();
				stream.respond(message.id, {});
				stream.end();
				this.otherStreams.push(stream);
				return stream.response;
			}
		}
	}
}

/** Registers a fixture's endpoint as the live worker for a project. */
function registerFixture(fixture: AcpFixture, sessionsDir: string, sessionId: string, cwd: string): void {
	fs.mkdirSync(sessionsDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionsDir, "7000.json"),
		JSON.stringify({ pid: 7000, sessionId, cwd, endpoint: fixture.endpoint }),
	);
}

/** Callback recorder passed to a connection. */
interface Recorder {
	updates: DesktopSessionUpdate[];
	requests: Array<{ method: string; params: unknown }>;
	/** Answers handed back for each request, when a test wants to decide. */
	answer?: (method: string, params: unknown) => unknown;
}

/** Connects to a fixture across the discovery path and returns the session. */
async function connectFixture(fixture: AcpFixture, sessionId: string, projectRoot: string, recorder: Recorder) {
	const sessionsDir = path.join(makeTempDir(), "sessions");
	const logsDir = makeTempDir();
	registerFixture(fixture, sessionsDir, sessionId, projectRoot);
	// Endpoint recovery is disabled: these tests supply their own worker, and the
	// host's real sockets must never influence the result.
	const options: ConnectOptions = {
		sessionsDir,
		logsDir,
		fetchTimeoutMs: 2_000,
		locateEndpoints: async () => [],
	};
	return await connect(
		{ version: 1, projectRoot, sessionId, workbuddyVersion: "5.8.2" },
		{
			onUpdate: async (update) => {
				recorder.updates.push(update);
			},
			onRequest: async (method, params) => {
				recorder.requests.push({ method, params });
				return recorder.answer?.(method, params);
			},
		},
		new AbortController().signal,
		options,
	);
}

/**
 * Waits for a condition without binding to a fixed duration.
 *
 * Yields to the event loop between checks because the condition depends on a
 * real HTTP round trip, not just on pending microtasks.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Bun.sleep(1);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function newRecorder(): Recorder {
	return { updates: [], requests: [] };
}

describe("connect - ACP handshake", () => {
	it("initializes without unimplemented capabilities and resumes the bound session", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "11111111-2222-4333-8444-555555555555";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			await session.close();

			const initialize = fixture.lastMethodCall("initialize");
			expect(initialize).toBeDefined();
			const params = initialize?.params ?? {};
			expect(params.protocolVersion).toBe(1);
			// Declaring capabilities the client does not implement would invite the
			// agent to make requests that can never be honoured.
			expect(params.clientCapabilities).toEqual({});

			// The bound session is attached to, never replaced.
			expect(fixture.lastMethodCall("session/resume")).toBeDefined();
			expect(fixture.countMethodCalls("session/new")).toBe(0);
		} finally {
			fixture.stop();
		}
	});

	it("falls back to session/load when the worker does not implement resume", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "22222222-3333-4444-8555-666666666666";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.unsupported.add("session/resume");
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			await session.close();

			const load = fixture.lastMethodCall("session/load");
			expect(load).toBeDefined();
			expect(load?.params?.sessionId).toBe(sessionId);
			expect(load?.params?.cwd).toBe(projectRoot);
		} finally {
			fixture.stop();
		}
	});

	it("refuses a worker that only offers session/new", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "33333333-4444-4555-8666-777777777777";
		const fixture = new AcpFixture({
			cwd: projectRoot,
			sessionId,
			agentCapabilities: { loadSession: false },
		});
		fixture.start();
		try {
			const failure = await connectFixture(fixture, sessionId, projectRoot, newRecorder()).catch(
				(error: unknown) => error,
			);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.protocolUnsupported);
			expect(fixture.countMethodCalls("session/new")).toBe(0);
		} finally {
			fixture.stop();
		}
	});

	it("reports a writer already attached to the session as WB_BUSY", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "12121212-3434-4565-8787-989898989898";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		// The desktop app keeps its own writer for the sessions it displays, so an
		// external client is refused until the app lets go.
		fixture.resumeError = { code: -32000, message: "Persistent Session already has an external writer", data: { reason: "writer_occupied" } };
		fixture.start();
		try {
			const failure = await connectFixture(fixture, sessionId, projectRoot, newRecorder()).catch(
				(error: unknown) => error,
			);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.busy);
		} finally {
			fixture.stop();
		}
	});

	it("refuses an incompatible protocol version", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "44444444-5555-4666-8777-888888888888";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId, advertiseProtocol: 99 });
		fixture.start();
		try {
			const failure = await connectFixture(fixture, sessionId, projectRoot, newRecorder()).catch(
				(error: unknown) => error,
			);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.protocolUnsupported);
		} finally {
			fixture.stop();
		}
	});

	it("refuses a resume that reports a different session uuid", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "55555555-6666-4777-8888-999999999999";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.returnedSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		fixture.start();
		try {
			const failure = await connectFixture(fixture, sessionId, projectRoot, newRecorder()).catch(
				(error: unknown) => error,
			);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.protocolUnsupported);
		} finally {
			fixture.stop();
		}
	});

	it("delivers session updates that arrive during the handshake", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.updatesAfterHandshake = [
			{
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "attached" } },
			},
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			await waitFor(() => recorder.updates.length > 0, "the handshake update");
			await session.close();

			expect(recorder.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
		} finally {
			fixture.stop();
		}
	});
});

describe("connect - prompt and cancel", () => {
	it("returns the stop reason and sends the prompt as one text block", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			const outcome = await session.prompt("do the work");
			await session.close();

			expect(outcome.stopReason).toBe("end_turn");
			const prompt = fixture.lastMethodCall("session/prompt");
			expect(prompt?.params?.sessionId).toBe(sessionId);
			expect(prompt?.params?.prompt).toEqual([{ type: "text", text: "do the work" }]);
		} finally {
			fixture.stop();
		}
	});

	it("surfaces an error message reported with the turn", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.errorMessage = "quota exhausted";
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			const outcome = await session.prompt("do the work");
			await session.close();
			expect(outcome.errorMessage).toBe("quota exhausted");
		} finally {
			fixture.stop();
		}
	});

	it("delivers the turn's updates while the prompt is still running", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.holdPrompt = true;
		fixture.updatesOnPrompt = [
			{
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
			},
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			const pending = session.prompt("long work");
			await waitFor(() => recorder.updates.length > 0, "the turn update");

			// The turn is still open: the reply has not been sent yet.
			expect(recorder.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
			await session.close();
			await pending.catch(() => undefined);
		} finally {
			fixture.stop();
		}
	});

	it("reports a dropped stream as WB_INTERRUPTED and never resends the prompt", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.holdPrompt = true;
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			const pending = session.prompt("long work");
			await waitFor(() => fixture.lastMethodCall("session/prompt") !== undefined, "the prompt to be sent");

			// The worker goes away mid-turn.
			fixture.stop();

			const failure = await pending.catch((error: unknown) => error);
			expect(codedOf(failure)).toBe(WB_ERROR_CODE.interrupted);
			// The prompt was submitted exactly once: no silent retry.
			expect(fixture.countMethodCalls("session/prompt")).toBe(1);
		} finally {
			fixture.stop();
		}
	});

	it("cancels with a sessionId-only notification that carries no id", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			await session.cancel();
			await session.close();

			const cancel = fixture.lastMethodCall("session/cancel");
			expect(cancel).toBeDefined();
			expect(cancel?.id).toBeUndefined();
			expect(cancel?.params).toEqual({ sessionId });
		} finally {
			fixture.stop();
		}
	});

	it("releases only its own ACP connection and never calls a worker control endpoint", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "cccccccc-dddd-4eee-8fff-000000000000";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			await session.close();
			// Closing twice must be harmless.
			await session.close();

			// Only the ACP surface is touched; discovery probes are read-only, and
			// no worker control endpoint (stop/restart) is ever called.
			expect(
				fixture.nonAcpEndpointsTouched().filter((endpoint) => endpoint.includes("daemon") || endpoint.includes("stop")),
			).toEqual([]);
		} finally {
			fixture.stop();
		}
	});

	it("refuses to prompt or cancel once the session is closed", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "dddddddd-eeee-4fff-8000-111111111111";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.start();
		try {
			const session = await connectFixture(fixture, sessionId, projectRoot, newRecorder());
			await session.close();

			expect(codedOf(await session.prompt("late").catch((error: unknown) => error))).toBe(
				WB_ERROR_CODE.sessionNotRunning,
			);
			expect(codedOf(await session.cancel().catch((error: unknown) => error))).toBe(
				WB_ERROR_CODE.sessionNotRunning,
			);
		} finally {
			fixture.stop();
		}
	});
});

describe("connect - permission requests", () => {
	it("forwards an interruption request carried in a session update", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "eeeeeeee-ffff-4000-8111-222222222222";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		const interruption = {
			interruptionId: "ir-1",
			toolCallId: "call-1",
			toolName: "Bash",
			reason: "writes outside outputs",
			options: ["allow", "deny"],
			toolInput: { command: "rm -rf build" },
		};
		fixture.holdPrompt = true;
		fixture.updatesOnPrompt = [
			{ sessionId, update: { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/interruptionRequest": interruption } } },
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			const pending = session.prompt("needs permission");
			await waitFor(() => recorder.requests.length > 0, "the interruption request");

			const request = recorder.requests[0];
			expect(request?.method).toBe("codebuddy.ai/interruptionRequest");
			expect(request?.params).toEqual(interruption);

			await session.close();
			await pending.catch(() => undefined);
		} finally {
			fixture.stop();
		}
	});

	it("sends the human's decision back to the worker as a resolveInterruption request", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "ffffffff-0000-4111-8222-333333333333";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		const interruption = {
			sessionId,
			interruptionId: "ir-2",
			toolCallId: "call-2",
			toolName: "Bash",
			options: ["allow", "deny"],
		};
		fixture.holdPrompt = true;
		fixture.updatesOnPrompt = [
			{ sessionId, update: { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/interruptionRequest": interruption } } },
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			// The human approves this one time.
			recorder.answer = () => ({ sessionId, toolCallId: "call-2", decision: "allow" });
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			const pending = session.prompt("needs permission");

			await waitFor(
				() => fixture.lastMethodCall("_codebuddy.ai/resolveInterruption") !== undefined,
				"the decision to reach the worker",
			);

			const resolve = fixture.lastMethodCall("_codebuddy.ai/resolveInterruption");
			expect(resolve?.params).toEqual({ sessionId, toolCallId: "call-2", decision: "allow" });

			await session.close();
			await pending.catch(() => undefined);
		} finally {
			fixture.stop();
		}
	});

	it("sends an explicit refusal when the client declines to answer", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "01010101-0202-4303-8404-050505050505";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.holdPrompt = true;
		fixture.updatesOnPrompt = [
			{
				sessionId,
				update: {
					sessionUpdate: "session_info_update",
					_meta: {
						"codebuddy.ai/interruptionRequest": {
							sessionId,
							interruptionId: "ir-3",
							toolCallId: "call-3",
							toolName: "Bash",
							options: ["allow", "deny"],
						},
					},
				},
			},
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			// No answer: the recorder's default is `undefined`.
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			const pending = session.prompt("needs permission");
			await waitFor(
				() => fixture.lastMethodCall("_codebuddy.ai/resolveInterruption") !== undefined,
				"the refusal to reach the worker",
			);

			// An unanswered request still owes the worker a decision: dropping it
			// would block the worker's interruption service until it timed out.
			const resolve = fixture.lastMethodCall("_codebuddy.ai/resolveInterruption");
			expect(resolve?.params).toEqual({ sessionId, toolCallId: "call-3", decision: "deny" });

			await session.close();
			await pending.catch(() => undefined);
		} finally {
			fixture.stop();
		}
	});

	it("ignores updates addressed to a different session", async () => {
		const projectRoot = makeTempDir();
		const sessionId = "02020202-0303-4404-8505-060606060606";
		const fixture = new AcpFixture({ cwd: projectRoot, sessionId });
		fixture.updatesAfterHandshake = [
			{
				sessionId: "some-other-session",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not ours" } },
			},
		];
		fixture.start();
		try {
			const recorder = newRecorder();
			const session = await connectFixture(fixture, sessionId, projectRoot, recorder);
			await session.close();
			expect(recorder.updates).toEqual([]);
		} finally {
			fixture.stop();
		}
	});
});

/** Reads the `WB_*` code off an error without trusting its shape. */
function codedOf(error: unknown): string | undefined {
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}
