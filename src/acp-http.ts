/**
 * ACP-over-HTTP transport for WorkBuddy workers.
 *
 * WorkBuddy's ACP HTTP surface differs from the ACP SDK's `createHttpStream`:
 *
 * 1. A connection id is issued by `POST /api/v1/acp/connect` (JSON), not by an
 *    `Acp-Connection-Id` response header on `initialize`.
 * 2. Every `POST /api/v1/acp` answers with `text/event-stream`, including the
 *    response to `initialize` itself. The SDK transport expects `initialize` to
 *    answer with a plain JSON body, so it cannot drive this server.
 * 3. `POST` requires an `Accept` header listing *both* `application/json` and
 *    `text/event-stream`; a request offering only one is rejected with 406.
 *
 * This module therefore builds an ACP {@link Stream} directly: JSON-RPC messages
 * written to the stream are POSTed one per request, and every SSE chunk the
 * server emits is decoded back into JSON-RPC messages on the readable side.
 */
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

const CONNECT_PATH = "/api/v1/acp/connect";
const ACP_PATH = "/api/v1/acp";

/**
 * Anti-CSRF header required by every WorkBuddy HTTP endpoint. Its fixed value
 * forces cross-origin requests to preflight, which is the server-side guard.
 */
const REQUEST_HEADER = "X-CodeBuddy-Request";
const REQUEST_HEADER_VALUE = "1";
const CONNECTION_ID_HEADER = "acp-connection-id";
const SESSION_TOKEN_HEADER = "acp-session-token";

/**
 * `POST` replies were verified to reject requests that do not offer both
 * content types, so the Accept header is not a preference but a requirement.
 */
const ACCEPT_HEADER = "application/json, text/event-stream";

/** Bound on the connect handshake; a dead worker must not hang the caller. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Bound on releasing the server-side connection during {@link AcpHttpConnection.close}.
 * Closing is best-effort: a worker that already exited must not block teardown.
 */
const RELEASE_TIMEOUT_MS = 3_000;

/** Failure originating from the HTTP surface rather than the ACP layer. */
export class AcpHttpError extends Error {
	/** HTTP status of the failing response, when one was received. */
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "AcpHttpError";
		this.status = status;
	}

	/** True when the worker refused the request because the client is unauthenticated. */
	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

/** Result of {@link connectAcpHttp}. */
export interface AcpHttpConnection {
	/** ACP stream carrying JSON-RPC messages to and from the worker. */
	readonly stream: Stream;
	/** Releases this client's connection. Never terminates the worker or its sessions. */
	close(): Promise<void>;
}

/** Bounds a payload echoed into a diagnostic message. */
function truncate(text: string): string {
	const limit = 200;
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** A parsed JSON-RPC message; arrays are rejected because ACP v1 forbids batching. */
function parseMessage(payload: string): AnyMessage {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		throw new AcpHttpError(`ACP response was not valid JSON: ${truncate(payload)}`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new AcpHttpError(`ACP response was not a JSON-RPC message: ${truncate(payload)}`);
	}
	return value as AnyMessage;
}

/**
 * Validates a worker endpoint and returns its origin.
 *
 * Only loopback plaintext endpoints are accepted: the binding is resolved from
 * local worker logs, so anything else indicates either a tampered log or a
 * mistaken value, and both must fail closed rather than send credentials off-host.
 */
function normalizeEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new AcpHttpError(`Invalid WorkBuddy endpoint: ${endpoint}`);
	}
	if (url.protocol !== "http:") {
		throw new AcpHttpError(`WorkBuddy endpoint must use http: (got ${url.protocol})`);
	}
	if (url.hostname !== "127.0.0.1") {
		throw new AcpHttpError(`WorkBuddy endpoint must target 127.0.0.1 (got ${url.hostname})`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new AcpHttpError("WorkBuddy endpoint must not embed credentials");
	}
	if (url.port === "") {
		throw new AcpHttpError("WorkBuddy endpoint must include an explicit port");
	}
	const port = Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new AcpHttpError(`WorkBuddy endpoint has an invalid port: ${url.port}`);
	}
	return url.origin;
}

/**
 * Extracts `{connectionId, sessionToken}` from a connect reply.
 *
 * The reply is a bare object rather than a JSON-RPC envelope, so it is parsed
 * directly instead of through {@link parseMessage}.
 */
function readConnectResult(raw: string): { connectionId: string; sessionToken?: string } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new AcpHttpError(`WorkBuddy connect reply was not valid JSON: ${truncate(raw)}`);
	}
	if (value === null || typeof value !== "object") {
		throw new AcpHttpError("WorkBuddy connect reply was not an object");
	}
	const record = value as Record<string, unknown>;
	const connectionId = record.connectionId;
	if (typeof connectionId !== "string" || connectionId === "") {
		throw new AcpHttpError("WorkBuddy connect reply did not include a connectionId");
	}
	const sessionToken = record.sessionToken;
	return typeof sessionToken === "string" && sessionToken !== ""
		? { connectionId, sessionToken }
		: { connectionId };
}

/**
 * One WorkBuddy ACP HTTP connection.
 *
 * Owns exactly one server-side connection id and never touches worker lifetime:
 * {@link AcpHttpConnection.close} releases the connection, nothing more.
 */
class AcpHttpTransport implements AcpHttpConnection {
	readonly #origin: string;
	readonly #connectionId: string;
	readonly #sessionToken: string | undefined;
	readonly #abort = new AbortController();
	/** Pumps still draining; awaited on close so no read outlives the connection. */
	readonly #pumps = new Set<Promise<void>>();

	readonly #stream: Stream;
	#controller: ReadableStreamDefaultController<AnyMessage> | undefined;
	#closed = false;
	#failure: Error | undefined;

	private constructor(origin: string, connectionId: string, sessionToken: string | undefined) {
		this.#origin = origin;
		this.#connectionId = connectionId;
		this.#sessionToken = sessionToken;
		const readable = new ReadableStream<AnyMessage>({
			start: (controller) => {
				this.#controller = controller;
			},
			cancel: () => {
				// The reader side going away is a disconnect, so tear the
				// server-side connection down rather than leaking it.
				void this.close();
			},
		});
		// Built once: the ACP client captures this pair and relies on the same
		// objects for the connection's lifetime.
		this.#stream = {
			readable,
			writable: new WritableStream<AnyMessage>({
				write: async (message) => {
					await this.#send(message);
				},
				close: async () => {
					await this.close();
				},
				abort: async () => {
					await this.close();
				},
			}),
		};
	}

	/** Performs the connect handshake and starts the notification stream. */
	static async connect(endpoint: string, signal: AbortSignal): Promise<AcpHttpTransport> {
		const origin = normalizeEndpoint(endpoint);
		if (signal.aborted) {
			throw new AcpHttpError("ACP connection aborted before it was established");
		}

		const timeout = new AbortController();
		const onAbort = (): void => timeout.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(new URL(CONNECT_PATH, origin), {
				method: "POST",
				headers: { [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
				// A worker is addressed by IP and port, so a redirect can only
				// point somewhere this client was not asked to trust.
				redirect: "error",
				signal: timeout.signal,
			});
		} catch (error) {
			throw new AcpHttpError(`WorkBuddy connect request failed: ${describeError(error)}`);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}

		if (!response.ok) {
			throw new AcpHttpError(
				`WorkBuddy connect request failed with HTTP ${response.status}`,
				response.status,
			);
		}

		const { connectionId, sessionToken } = readConnectResult(await response.text());
		const transport = new AcpHttpTransport(origin, connectionId, sessionToken);

		// The outer signal aborts the whole connection.
		signal.addEventListener("abort", () => void transport.close(), { once: true });
		// A server-pushed notification stream is optional: workers without it
		// still deliver every reply on the POST streams.
		transport.#startNotificationStream();
		return transport;
	}

	get stream(): Stream {
		return this.#stream;
	}

	/**
	 * Sends one JSON-RPC message.
	 *
	 * Resolves once the reply stream's headers are in and its pump is running,
	 * deliberately *not* once the response body ends: a `session/prompt` body
	 * stays open for the whole turn and is the channel on which the server asks
	 * for permission, so awaiting it here would deadlock the turn.
	 */
	async #send(message: AnyMessage): Promise<void> {
		if (this.#closed) {
			throw new AcpHttpError("ACP connection is closed");
		}
		if (this.#failure !== undefined) {
			throw this.#failure;
		}
		if (Array.isArray(message)) {
			throw new AcpHttpError("ACP v1 does not support batched JSON-RPC messages");
		}

		const body = JSON.stringify(message);
		let response: Response;
		try {
			response = await fetch(new URL(ACP_PATH, this.#origin), {
				method: "POST",
				headers: {
					[REQUEST_HEADER]: REQUEST_HEADER_VALUE,
					[CONNECTION_ID_HEADER]: this.#connectionId,
					...(this.#sessionToken !== undefined
						? { [SESSION_TOKEN_HEADER]: this.#sessionToken }
						: {}),
					"Content-Type": "application/json",
					Accept: ACCEPT_HEADER,
				},
				body,
				redirect: "error",
				signal: this.#abort.signal,
			});
		} catch (error) {
			throw this.#fail(new AcpHttpError(`ACP request failed: ${describeError(error)}`));
		}

		if (!response.ok) {
			// Read a bounded prefix so the message can be acted on without
			// letting a misbehaving worker stream an unbounded error body.
			const detail = await response.text().catch(() => "");
			throw this.#fail(
				new AcpHttpError(
					`ACP request failed with HTTP ${response.status}${detail === "" ? "" : `: ${truncate(detail)}`}`,
					response.status,
				),
			);
		}

		this.#track(this.#drain(response));
	}

	/** Starts and tracks one reply pump without awaiting it. */
	#track(pump: Promise<void>): void {
		const tracked = pump.catch((error: unknown) => {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
		});
		this.#pumps.add(tracked);
		void tracked.finally(() => this.#pumps.delete(tracked));
	}

	/** Pumps one POST reply body into the readable side. */
	async #drain(response: Response): Promise<void> {
		const contentType = response.headers.get("content-type") ?? "";
		if (response.body === null) {
			return;
		}
		if (contentType.includes("application/json")) {
			this.#emit(await response.text());
			return;
		}
		await this.#pump(response.body);
	}

	/**
	 * Opens the optional `GET /api/v1/acp` notification stream.
	 *
	 * Failures are non-fatal: POST streams carry every reply and every session
	 * update for a turn, so a worker without this endpoint is still usable.
	 */
	#startNotificationStream(): void {
		const url = new URL(ACP_PATH, this.#origin);
		const pump = (async (): Promise<void> => {
			const response = await fetch(url, {
				method: "GET",
				headers: {
					[REQUEST_HEADER]: REQUEST_HEADER_VALUE,
					[CONNECTION_ID_HEADER]: this.#connectionId,
					...(this.#sessionToken !== undefined
						? { [SESSION_TOKEN_HEADER]: this.#sessionToken }
						: {}),
					Accept: "text/event-stream",
				},
				redirect: "error",
				signal: this.#abort.signal,
			});
			if (response.status === 404 || response.status === 405) {
				return;
			}
			if (!response.ok || response.body === null) {
				return;
			}
			await this.#pump(response.body);
		})().catch(() => {
			// Unsupported or interrupted notification streams are not errors:
			// per-turn updates arrive on the POST streams.
		});
		this.#track(pump);
	}

	/**
	 * Decodes an SSE body into JSON-RPC messages.
	 *
	 * Writes each message straight into the readable side, so a chunk carrying
	 * both a response and a notification dispatches both in order.
	 */
	async #pump(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";
		let event = "";
		let data: string[] = [];

		const dispatch = (): void => {
			const lines = data;
			data = [];
			// A named event other than `message` is an SSE channel this client
			// does not consume; the default event name is `message`.
			const isMessage = event === "" || event === "message";
			event = "";
			if (!isMessage || lines.length === 0) {
				return;
			}
			this.#emit(lines.join("\n"));
		};

		const consumeLine = (line: string): void => {
			if (line === "") {
				dispatch();
				return;
			}
			// Comments (heartbeats) carry no payload.
			if (line.startsWith(":")) {
				return;
			}
			const separator = line.indexOf(":");
			const field = separator === -1 ? line : line.slice(0, separator);
			let value = separator === -1 ? "" : line.slice(separator + 1);
			if (value.startsWith(" ")) {
				value = value.slice(1);
			}
			if (field === "event") {
				event = value;
			} else if (field === "data") {
				data.push(value);
			}
		};

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// Only complete lines are consumed so a line split across chunks
				// (including a CRLF split after the CR) stays intact.
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					let line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.endsWith("\r")) {
						line = line.slice(0, -1);
					}
					consumeLine(line);
					newline = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			if (buffer !== "") {
				// A server that ends without a trailing newline still emitted a
				// final line; treat an unterminated event as terminated.
				consumeLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
			}
			dispatch();
		} finally {
			reader.releaseLock();
		}
	}

	/** Decodes one JSON-RPC payload and forwards it to the readable side. */
	#emit(payload: string): void {
		const trimmed = payload.trim();
		if (trimmed === "") {
			return;
		}
		this.#push(parseMessage(trimmed));
	}

	#push(message: AnyMessage): void {
		if (this.#closed || this.#controller === undefined) {
			return;
		}
		try {
			this.#controller.enqueue(message);
		} catch {
			// The readable side was cancelled; nothing left to deliver to.
			this.#closed = true;
		}
	}

	/** Records a fatal transport failure and surfaces it to readers. */
	#fail(error: Error): Error {
		this.#failure ??= error;
		if (!this.#closed) {
			this.#closed = true;
			try {
				this.#controller?.error(error);
			} catch {
				// Already errored or cancelled.
			}
		}
		return error;
	}

	async close(): Promise<void> {
		if (this.#closed) {
			await this.#settle();
			return;
		}
		this.#closed = true;
		// Stopping the pumps first keeps a straggling chunk from arriving after
		// the reader has been closed.
		this.#abort.abort();
		try {
			this.#controller?.close();
		} catch {
			// Already closed or errored.
		}
		await this.#release();
		await this.#settle();
	}

	/** Releases this client's server-side connection; never kills the worker. */
	async #release(): Promise<void> {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), RELEASE_TIMEOUT_MS);
		try {
			await fetch(new URL(ACP_PATH, this.#origin), {
				method: "DELETE",
				headers: {
					[REQUEST_HEADER]: REQUEST_HEADER_VALUE,
					[CONNECTION_ID_HEADER]: this.#connectionId,
					...(this.#sessionToken !== undefined
						? { [SESSION_TOKEN_HEADER]: this.#sessionToken }
						: {}),
				},
				redirect: "error",
				signal: timeout.signal,
			});
		} catch {
			// Releasing is best-effort: the worker may already be gone, and the
			// connection id expires with it.
		} finally {
			clearTimeout(timer);
		}
	}

	async #settle(): Promise<void> {
		while (this.#pumps.size > 0) {
			await Promise.allSettled([...this.#pumps]);
		}
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? "aborted" : error.message;
	}
	return String(error);
}

/**
 * Attaches to a verified WorkBuddy worker endpoint over ACP.
 *
 * @param endpoint Worker origin, e.g. `http://127.0.0.1:9523`.
 * @param signal Aborts the connection; aborting the signal closes it.
 */
export async function connectAcpHttp(
	endpoint: string,
	signal: AbortSignal,
): Promise<AcpHttpConnection> {
	return AcpHttpTransport.connect(endpoint, signal);
}
