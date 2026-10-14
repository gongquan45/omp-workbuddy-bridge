/**
 * Transport-level tests for the WorkBuddy ACP-over-HTTP client.
 *
 * The fixtures reproduce the framing observed on the real worker surface:
 * `POST /api/v1/acp/connect` returns a bare JSON envelope, and every
 * `POST /api/v1/acp` reply is an SSE stream that may interleave the JSON-RPC
 * response with `session/update` notifications for the same connection.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { client as acpClient, methods, PROTOCOL_VERSION, type Stream } from "@agentclientprotocol/sdk";
import { AcpHttpError, connectAcpHttp, type AcpHttpConnection } from "../src/acp-http";

/** SSE writer with explicit byte control, so chunk boundaries can be forced. */
interface StreamFixture {
	/** Enqueues raw bytes on the current reply stream. */
	write(chunk: string | Uint8Array): void;
	/** Ends the current reply stream. */
	close(): void;
	/** Records a request observed by the server. */
	readonly requests: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }>;
}

interface Fixture {
	readonly origin: string;
	readonly state: StreamFixture;
	stop(): void;
}

const active: AcpHttpConnection[] = [];

afterEach(async () => {
	while (active.length > 0) {
		await active.pop()?.close();
	}
});

/** Serves the connect handshake plus a controllable SSE reply stream. */
function startFixture(
	options: {
		connectStatus?: number;
		connectBody?: string;
		replyStatus?: number;
		acceptHeaderRequired?: boolean;
		onPost?: (body: unknown, state: StreamFixture) => void;
		notificationStream?: boolean;
	} = {},
): Fixture {
	const requests: StreamFixture["requests"] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;

	const state: StreamFixture = {
		requests,
		write(chunk) {
			if (controller === undefined) return;
			controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
		},
		close() {
			if (controller === undefined) return;
			closed = true;
			controller.close();
		},
	};

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});

			if (url.pathname === "/api/v1/acp/connect") {
				requests.push({ path: url.pathname, method: request.method, headers, body: null });
				if (options.connectStatus !== undefined && options.connectStatus !== 200) {
					return new Response("denied", { status: options.connectStatus });
				}
				return new Response(options.connectBody ?? JSON.stringify({ connectionId: "conn-1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}

			if (url.pathname === "/api/v1/acp" && request.method === "DELETE") {
				requests.push({ path: url.pathname, method: request.method, headers, body: null });
				closed = true;
				return new Response("", { status: 200 });
			}

			if (url.pathname === "/api/v1/acp" && request.method === "GET") {
				requests.push({ path: url.pathname, method: request.method, headers, body: null });
				if (options.notificationStream !== true) {
					return new Response("not found", { status: 404 });
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(
								new TextEncoder().encode(
									'event: message\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"session_info_update"}}}\n\n',
								),
							);
							c.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}

			if (url.pathname === "/api/v1/acp" && request.method === "POST") {
				const body: unknown = JSON.parse(await request.text());
				requests.push({ path: url.pathname, method: request.method, headers, body });

				if (options.acceptHeaderRequired === true) {
					const accept = headers.accept ?? "";
					if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
						return new Response(
							JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable" }, id: null }),
							{ status: 406, headers: { "content-type": "application/json" } },
						);
					}
				}

				if (options.replyStatus !== undefined && options.replyStatus !== 200) {
					return new Response("upstream failure", { status: options.replyStatus });
				}

				closed = false;
				const stream = new ReadableStream<Uint8Array>({
					start(c) {
						controller = c;
						// The worker emits this framing marker immediately so SSE
						// headers reach the client before the first real message.
						// Without an initial byte the response headers stay unflushed.
						c.enqueue(new TextEncoder().encode(":ok\n\n"));
					},
					cancel() {
						closed = true;
					},
				});
				options.onPost?.(body, state);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}

			return new Response("unexpected", { status: 500 });
		},
	});

	void closed;
	return {
		origin: `http://127.0.0.1:${server.port}`,
		state,
		stop: () => void server.stop(true),
	};
}

/** Reads one message from a stream with a bound, so a stall fails instead of hanging. */
async function nextMessage(stream: Stream, timeoutMs = 2_000): Promise<unknown> {
	const reader = stream.readable.getReader();
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("timed out waiting for an ACP message")), timeoutMs);
	});
	try {
		const result = await Promise.race([reader.read(), timeout]);
		if (result.done === true) {
			throw new Error("ACP stream ended before a message arrived");
		}
		return result.value;
	} finally {
		reader.releaseLock();
	}
}

async function connect(fixture: Fixture, signal = new AbortController().signal): Promise<AcpHttpConnection> {
	const connection = await connectAcpHttp(fixture.origin, signal);
	active.push(connection);
	return connection;
}

describe("connectAcpHttp - connection handshake", () => {
	it("exchanges the anti-CSRF header and carries the connect credentials on every later request", async () => {
		const fixture = startFixture({
			connectBody: JSON.stringify({ connectionId: "conn-9c", sessionToken: "tok-77" }),
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			writer.releaseLock();

			const connectRequest = fixture.state.requests.find((r) => r.path === "/api/v1/acp/connect");
			expect(connectRequest?.method).toBe("POST");
			expect(connectRequest?.headers["x-codebuddy-request"]).toBe("1");
			expect(connectRequest?.headers["acp-connection-id"]).toBeUndefined();

			const post = fixture.state.requests.find((r) => r.method === "POST" && r.path === "/api/v1/acp");
			expect(post?.headers["acp-connection-id"]).toBe("conn-9c");
			expect(post?.headers["acp-session-token"]).toBe("tok-77");
			expect(post?.headers["x-codebuddy-request"]).toBe("1");
		} finally {
			fixture.stop();
		}
	});

	it("offers both JSON and SSE content types on POST, which the worker requires", async () => {
		const fixture = startFixture({ acceptHeaderRequired: true });
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			writer.releaseLock();

			const post = fixture.state.requests.find((r) => r.method === "POST" && r.path === "/api/v1/acp");
			expect(post).toBeDefined();
			expect(post?.headers.accept).toContain("application/json");
			expect(post?.headers.accept).toContain("text/event-stream");
		} finally {
			fixture.stop();
		}
	});

	it("surfaces an auth failure as a distinguishable error", async () => {
		const fixture = startFixture({ connectStatus: 403 });
		try {
			const failure = await connectAcpHttp(fixture.origin, new AbortController().signal).catch(
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(AcpHttpError);
			expect((failure as AcpHttpError).status).toBe(403);
			expect((failure as AcpHttpError).isAuthFailure).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	it("rejects an endpoint that is not loopback plaintext", async () => {
		for (const endpoint of [
			"https://127.0.0.1:9523",
			"http://localhost:9523",
			"http://10.0.0.5:9523",
			"http://user:pw@127.0.0.1:9523",
			"http://127.0.0.1",
		]) {
			const failure = await connectAcpHttp(endpoint, new AbortController().signal).catch(
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(AcpHttpError);
		}
	});
});

describe("connectAcpHttp - SSE decoding", () => {
	it("delivers a response arriving in the reply stream", async () => {
		const fixture = startFixture({
			onPost: (_body, state) => {
				state.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n\n');
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			writer.releaseLock();

			expect(await nextMessage(connection.stream)).toEqual({
				jsonrpc: "2.0",
				id: 1,
				result: { protocolVersion: 1 },
			});
		} finally {
			fixture.stop();
		}
	});

	it("keeps multi-byte UTF-8 whole across chunk boundaries and splits on CRLF or bare LF", async () => {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "中文🙂done" } } },
		});
		const frame = `event: message\r\ndata: ${payload}\r\n\r\n`;

		const fixture = startFixture({
			onPost: (_body, state) => {
				const bytes = new TextEncoder().encode(frame);
				// "中" is 3 bytes: cut one byte into it so the decoder must hold
				// the partial sequence, and cut between CR and LF as well.
				const cut = new TextEncoder().encode('event: message\r\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"').length;
				state.write(bytes.slice(0, cut + 1));
				state.write(bytes.slice(cut + 1, cut + 2));
				state.write(bytes.slice(cut + 2, frame.indexOf("\r\n\r\n") + 3));
				state.write(bytes.slice(frame.indexOf("\r\n\r\n") + 3));
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
			writer.releaseLock();

			const message = (await nextMessage(connection.stream)) as {
				params: { update: { content: { text: string } } };
			};
			expect(message.params.update.content.text).toBe("中文🙂done");
		} finally {
			fixture.stop();
		}
	});

	it("joins multi-line data fields and ignores heartbeat comments", async () => {
		const fixture = startFixture({
			onPost: (_body, state) => {
				state.write(": heartbeat\n\n");
				state.write('event: message\ndata: {"jsonrpc":"2.0","id":3,\ndata: "result":{"ok":true,"note":"a: b"}}\n\n');
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
			writer.releaseLock();

			expect(await nextMessage(connection.stream)).toEqual({
				jsonrpc: "2.0",
				id: 3,
				result: { ok: true, note: "a: b" },
			});
		} finally {
			fixture.stop();
		}
	});

	it("ignores named events that are not message frames", async () => {
		const fixture = startFixture({
			onPost: (_body, state) => {
				state.write('event: ping\ndata: {"jsonrpc":"2.0","method":"ignored"}\n\n');
				state.write('event: message\ndata: {"jsonrpc":"2.0","id":4,"result":null}\n\n');
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
			writer.releaseLock();

			expect(await nextMessage(connection.stream)).toEqual({ jsonrpc: "2.0", id: 4, result: null });
		} finally {
			fixture.stop();
		}
	});

	it("accepts a bare JSON reply body", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/api/v1/acp/connect") {
					return Response.json({ connectionId: "conn-json" });
				}
				if (request.method === "DELETE") return new Response("", { status: 200 });
				if (request.method === "GET") return new Response("", { status: 404 });
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { mode: "json" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		try {
			const connection = await connectAcpHttp(`http://127.0.0.1:${server.port}`, new AbortController().signal);
			active.push(connection);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
			writer.releaseLock();

			expect(await nextMessage(connection.stream)).toEqual({
				jsonrpc: "2.0",
				id: 5,
				result: { mode: "json" },
			});
		} finally {
			server.stop(true);
		}
	});

	it("reads optional notifications from the GET stream", async () => {
		const fixture = startFixture({ notificationStream: true, onPost: () => {} });
		try {
			const connection = await connect(fixture);
			// The GET stream is opened during connect; its frame arrives unprompted.
			expect(await nextMessage(connection.stream)).toEqual({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId: "s1", update: { sessionUpdate: "session_info_update" } },
			});
		} finally {
			fixture.stop();
		}
	});
});

describe("connectAcpHttp - prompt lifetime", () => {
	it("returns from write once the reply headers arrive, while the turn is still running", async () => {
		let sawFirstChunk = false;
		const fixture = startFixture({
			onPost: (_body, state) => {
				state.write('event: message\ndata: {"jsonrpc":"2.0","id":10,"result":{"stopReason":"end_turn"}}\n\n');
				// Never closed: the prompt body stays open for the whole turn.
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 10, method: "session/prompt", params: { sessionId: "s1" } });
			const message = (await nextMessage(connection.stream)) as { result: { stopReason: string } };
			sawFirstChunk = message.result.stopReason === "end_turn";
			writer.releaseLock();
			expect(sawFirstChunk).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	it("lets a client answer a permission request that arrives mid-prompt, before the prompt resolves", async () => {
		// The worker asks for permission on the prompt stream and only ends the
		// turn once the client answers on a separate request. Awaiting the prompt
		// body before answering would deadlock the turn, so this test fails if
		// write() waits for the stream to end.
		const order: string[] = [];
		const fixture = startFixture({
			onPost: (body, state) => {
				const method = (body as { method?: string }).method;
				if (method === "session/prompt") {
					order.push("prompt");
					state.write(
						'event: message\ndata: {"jsonrpc":"2.0","id":20,"method":"session/request_permission","params":{"sessionId":"s1","toolCallId":"t1","options":[{"optionId":"deny","name":"Deny","kind":"reject_once"}]}}\n\n',
					);
				} else if (method === "session/request_permission_answer") {
					order.push("answer");
					state.write('event: message\ndata: {"jsonrpc":"2.0","id":21,"result":{"stopReason":"end_turn"}}\n\n');
				}
			},
		});
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 20, method: "session/prompt", params: { sessionId: "s1" } });
			expect(order).toEqual(["prompt"]);

			const permission = (await nextMessage(connection.stream)) as { method: string };
			expect(permission.method).toBe("session/request_permission");

			await writer.write({
				jsonrpc: "2.0",
				id: 21,
				method: "session/request_permission_answer",
				params: { optionId: "deny" },
			});
			writer.releaseLock();
			expect(order).toEqual(["prompt", "answer"]);
		} finally {
			fixture.stop();
		}
	});

	it("errors the stream on an HTTP failure instead of reporting success", async () => {
		const fixture = startFixture({ replyStatus: 500 });
		try {
			const connection = await connect(fixture);
			const writer = connection.stream.writable.getWriter();
			const failure = await writer
				.write({ jsonrpc: "2.0", id: 30, method: "session/prompt", params: {} })
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(AcpHttpError);
			expect((failure as AcpHttpError).status).toBe(500);
		} finally {
			fixture.stop();
		}
	});

	it("errors the readable side when a reply body is not valid JSON-RPC", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/api/v1/acp/connect") {
					return Response.json({ connectionId: "conn-bad" });
				}
				if (request.method === "DELETE" || request.method === "GET") {
					return new Response("", { status: 404 });
				}
				return new Response('event: message\ndata: not-json\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const connection = await connectAcpHttp(`http://127.0.0.1:${server.port}`, new AbortController().signal);
			active.push(connection);
			const writer = connection.stream.writable.getWriter();
			await writer.write({ jsonrpc: "2.0", id: 31, method: "initialize", params: {} });
			writer.releaseLock();

			const reader = connection.stream.readable.getReader();
			const failure = await reader.read().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(AcpHttpError);
		} finally {
			server.stop(true);
		}
	});
});

describe("connectAcpHttp - teardown", () => {
	it("releases only its own connection and never signals the worker to stop", async () => {
		const fixture = startFixture({ onPost: () => {} });
		try {
			const connection = await connect(fixture);
			await connection.close();

			const release = fixture.state.requests.find(
				(r) => r.method === "DELETE" && r.path === "/api/v1/acp",
			);
			expect(release?.headers["acp-connection-id"]).toBe("conn-1");
			// No request other than the ACP surface may be touched.
			expect(fixture.state.requests.every((r) => r.path.startsWith("/api/v1/acp"))).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	it("closes when the caller's signal aborts", async () => {
		const fixture = startFixture({ onPost: () => {} });
		try {
			const controller = new AbortController();
			const connection = await connect(fixture, controller.signal);
			const writer = connection.stream.writable.getWriter();
			controller.abort();

			const failure = await writer
				.write({ jsonrpc: "2.0", id: 40, method: "initialize", params: {} })
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
		} finally {
			fixture.stop();
		}
	});
});

describe("connectAcpHttp - works through the ACP SDK client", () => {
	it("drives initialize and a prompt end to end over the transport", async () => {
		const seen: string[] = [];
		const fixture = startFixture({
			onPost: (body, state) => {
				const message = body as { id: number; method: string };
				seen.push(message.method);
				if (message.method === methods.agent.initialize) {
					state.write(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: PROTOCOL_VERSION,
								agentCapabilities: { loadSession: true },
							},
						})}\n\n`,
					);
				} else if (message.method === methods.agent.session.load) {
					state.write(
						`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`,
					);
				} else if (message.method === methods.agent.session.prompt) {
					state.write(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							method: "session/update",
							params: {
								sessionId: "sess-1",
								update: {
									sessionUpdate: "agent_message_chunk",
									content: { type: "text", text: "报告已生成" },
								},
							},
						})}\n\n`,
					);
					state.write(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { stopReason: "end_turn" },
						})}\n\n`,
					);
				}
			},
		});
		try {
			const connection = await connect(fixture);
			const chunks: string[] = [];

			const app = acpClient()
				.onNotification(methods.client.session.update, ({ params }) => {
					const update = params.update;
					if (update.sessionUpdate === "agent_message_chunk" && "content" in update) {
						const content = update.content;
						if (content.type === "text") {
							chunks.push(content.text);
						}
					}
				});

			await app.connectWith(connection.stream, async (context) => {
				const initialized = await context.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: { name: "omp-workbuddy-bridge", version: "1.0.0" },
					clientCapabilities: {},
				});
				expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);
				expect(initialized.agentCapabilities?.loadSession).toBe(true);

				await context.request(methods.agent.session.load, { sessionId: "sess-1", cwd: process.cwd(), mcpServers: [] });
				const prompt = await context.request(methods.agent.session.prompt, {
					sessionId: "sess-1",
					prompt: [{ type: "text", text: "生成报告" }],
				});
				expect(prompt.stopReason).toBe("end_turn");
			});

			expect(chunks.join("")).toBe("报告已生成");
			expect(seen).toEqual([
				methods.agent.initialize,
				methods.agent.session.load,
				methods.agent.session.prompt,
			]);
		} finally {
			fixture.stop();
		}
	});
});
