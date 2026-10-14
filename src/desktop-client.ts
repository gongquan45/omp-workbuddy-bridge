/**
 * WorkBuddy desktop agent client and session discovery.
 *
 * This module locates running WorkBuddy desktop sessions on the local machine
 * and attaches to a dedicated session over ACP, providing lifecycle management,
 * prompt delivery, cancellation, and permission/interruption routing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageMetadata from "../package.json";
import {
	client as acpClient,
	methods,
	PROTOCOL_VERSION,
	type ClientConnection,
	type Implementation,
	type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AcpHttpError, connectAcpHttp, type AcpHttpConnection } from "./acp-http";
import type {
	Binding,
	DesktopCallbacks,
	DesktopCandidate,
	DesktopSession,
	DesktopSessionUpdate,
	PromptOutcome,
	WorkerInspection,
} from "./types";
import { WB_ERROR_CODE } from "./types";

export type {
	Binding,
	DesktopCallbacks,
	DesktopCandidate,
	DesktopSession,
	PromptOutcome,
	WorkerInspection,
};

/** Bridge identity advertised to ACP peers; the manifest is the release source. */
const CLIENT_INFO: Implementation = {
	name: packageMetadata.name,
	version: packageMetadata.version,
};

/** Standard anti-CSRF header required by every WorkBuddy HTTP surface. */
const REQUEST_HEADER = "X-CodeBuddy-Request";
const REQUEST_HEADER_VALUE = "1";

/** Default timeout for worker health/info/status checks during discovery. */
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

/** JSON-RPC standard error code for an unimplemented method. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * Builds a refusal for an interruption the caller declined to answer.
 *
 * Used when the entry point returns nothing: a decision is still owed to the
 * worker, and refusing is always safe — it can never approve anything.
 */
function refusalFor(interruption: unknown): Record<string, unknown> | undefined {
	if (interruption === null || typeof interruption !== "object") {
		return undefined;
	}
	const sessionId = "sessionId" in interruption && typeof interruption.sessionId === "string"
		? interruption.sessionId
		: "";
	const toolCallId = "toolCallId" in interruption && typeof interruption.toolCallId === "string"
		? interruption.toolCallId
		: "";
	if (toolCallId === "") {
		return undefined;
	}
	return { sessionId, toolCallId, decision: "deny" };
}

/**
 * WorkBuddy's extension method that answers an `interruption_request`.
 *
 * Requests arrive as a `session/update` notification carrying `_meta`, which
 * cannot carry a reply, so the decision travels back through this request.
 */
const INTERRUPTION_RESOLVE_METHOD = "_codebuddy.ai/resolveInterruption";

/** Key under which WorkBuddy publishes a pending permission request. */
const INTERRUPTION_META_KEY = "codebuddy.ai/interruptionRequest";

/**
 * Collects the permission requests carried by one session update.
 *
 * The worker publishes a request on the `session_info_update` frame's own
 * `_meta`, and the ACP schema allows it on the notification envelope as well,
 * so both locations are read and de-duplicated by request identity.
 */
function interruptionRequestsIn(params: unknown): unknown[] {
	if (params === null || typeof params !== "object") {
		return [];
	}
	const found: unknown[] = [];
	const seen = new Set<string>();

	const collect = (source: unknown): void => {
		if (source === null || typeof source !== "object" || !(INTERRUPTION_META_KEY in source)) {
			return;
		}
		const candidate = source[INTERRUPTION_META_KEY];
		if (candidate === undefined || candidate === null) {
			return;
		}
		// The same request may be reported on both the update and the envelope;
		// asking a human twice for one decision would be wrong.
		const key =
			typeof candidate === "object" && "interruptionId" in candidate && typeof candidate.interruptionId === "string"
				? candidate.interruptionId
				: JSON.stringify(candidate);
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		found.push(candidate);
	};

	collect(params);
	if ("_meta" in params && params._meta !== null && typeof params._meta === "object") {
		collect(params._meta);
	}
	if ("update" in params && params.update !== null && typeof params.update === "object") {
		collect(params.update);
		if ("_meta" in params.update && params.update._meta !== null && typeof params.update._meta === "object") {
			collect(params.update._meta);
		}
	}
	return found;
}

/** Domain error raised for WorkBuddy lifecycle, discovery, and protocol failures. */
export class WbError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "WbError";
		this.code = code;
	}
}

/** Configurable discovery sources and timeouts, used primarily by tests for isolation. */
export interface DiscoveryOptions {
	/** Directory containing worker session JSON records. */
	sessionsDir?: string;
	/** Directory containing worker log files and date subdirectories. */
	logsDir?: string;
	/** Timeout in milliseconds for each worker probe request. */
	fetchTimeoutMs?: number;
	/**
	 * Supplies endpoints of live workers that published no registry entry.
	 *
	 * Defaults to enumerating local sockets owned by WorkBuddy. Tests supply
	 * fixture endpoints so the pairing and verification logic can be exercised
	 * without a real desktop installation.
	 */
	locateEndpoints?: (signal: AbortSignal, timeoutMs: number) => Promise<string[]>;
}

/** Options passed to {@link connect}, extending discovery parameters. */
export interface ConnectOptions extends DiscoveryOptions {}

/** Raw candidate descriptor recovered from session state files or worker logs. */
interface DiscoveredCandidate {
	endpoint: string;
	sessionId: string;
	cwd: string;
	version: string;
}

/** Normalizes a filesystem path to a canonical form for cross-platform comparison. */
async function normalizePath(targetPath: string): Promise<string> {
	let resolved: string;
	try {
		resolved = await fs.promises.realpath(targetPath);
	} catch {
		resolved = path.resolve(targetPath);
	}
	// Case-insensitivity on Windows avoids false mismatches between drive letters
	// or slash orientations while preserving standard POSIX path equality.
	return process.platform === "win32"
		? resolved.replaceAll("/", "\\").toLowerCase()
		: resolved;
}

/** Formats an arbitrary error value into a readable diagnostic string. */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? "aborted" : error.message;
	}
	return String(error);
}

/** Validates that an endpoint strictly uses loopback HTTP with an explicit port. */
function parseAndValidateEndpoint(raw: string): string | null {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:") return null;
		if (parsed.hostname !== "127.0.0.1") return null;
		if (parsed.username !== "" || parsed.password !== "") return null;
		if (parsed.port === "") return null;
		const port = Number(parsed.port);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

/** Checks whether a failure indicates that authentication is required. */
function isAuthFailure(error: unknown): boolean {
	if (error instanceof AcpHttpError && error.isAuthFailure) return true;
	if (error && typeof error === "object") {
		const rec = error as Record<string, unknown>;
		if (rec.status === 401 || rec.status === 403) return true;
		if (rec.code === WB_ERROR_CODE.authRequired) return true;
		if (rec.code === "auth_required" || rec.code === "AUTH_REQUIRED") return true;
		if (typeof rec.message === "string") {
			const lower = rec.message.toLowerCase();
			if (lower.includes("auth_required") || lower.includes("unauthorized") || lower.includes("forbidden")) {
				return true;
			}
		}
	}
	return false;
}

/** Determines if a JSON-RPC error indicates that the requested method does not exist. */
function isMethodNotFound(error: unknown): boolean {
	if (error && typeof error === "object") {
		const rec = error as Record<string, unknown>;
		if (rec.code === JSONRPC_METHOD_NOT_FOUND) return true;
		if (typeof rec.message === "string" && rec.message.toLowerCase().includes("method not found")) {
			return true;
		}
	}
	return false;
}

/**
 * Determines whether an attachment was refused because another writer holds the
 * session.
 *
 * The desktop app keeps its own ACP writer for the sessions it displays, so an
 * external client is legitimately refused while the app is driving that session.
 * That is a "busy" condition the user can retry, not a protocol gap.
 */
function isWriterOccupied(error: unknown): boolean {
	if (error === null || typeof error !== "object") {
		return false;
	}
	if ("data" in error && error.data !== null && typeof error.data === "object") {
		if ("reason" in error.data && (error.data as { reason?: unknown }).reason === "writer_occupied") {
			return true;
		}
	}
	if ("message" in error && typeof error.message === "string") {
		const lower = error.message.toLowerCase();
		return lower.includes("external writer") || lower.includes("writer_occupied");
	}
	return false;
}

/**
 * Collects session records that name a session but no endpoint.
 *
 * These come from workers started out of WorkBuddy's prewarm pool, which serve
 * ACP on an OS-assigned port that the worker never publishes.
 */
async function recoverUnaddressedSessions(
	sessionsDir: string,
	known: DiscoveredCandidate[],
): Promise<Array<{ sessionId: string; cwd: string; version: string }>> {
	// A worker's version is not stored in its session record, but the log scanner
	// recovers it from the worker's own startup banner for the same session.
	const versionBySession = new Map(known.map((candidate) => [candidate.sessionId, candidate.version]));
	const found: Array<{ sessionId: string; cwd: string; version: string }> = [];
	let entries: string[];
	try {
		entries = await fs.promises.readdir(sessionsDir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.promises.readFile(path.join(sessionsDir, entry), "utf8"));
		} catch {
			// A partially written record is skipped rather than guessed at.
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		// Only an `interactive` session is a real WorkBuddy conversation; prewarm
		// pool sockets and background workers are not delegation targets.
		if (record.kind !== "interactive") continue;
		const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
		const cwd = typeof record.cwd === "string" ? record.cwd : "";
		if (sessionId === "" || cwd === "") continue;
		// Workers respawn on new ports while the session identity stays the same, so
		// a session whose previously recorded endpoint is now dead is recovered
		// too. Validation decides which hypothesis is the live worker.
		const recorded = typeof record.version === "string" ? record.version : "";
		found.push({
			sessionId,
			cwd,
			version: recorded === "" ? (versionBySession.get(sessionId) ?? "") : recorded,
		});
	}
	return found;
}

/**
 * Lists loopback endpoints owned by a live WorkBuddy process.
 *
 * This is the socket-enumeration half of endpoint discovery, separated from the
 * ACP connect probe so read-only diagnostics can inspect a worker's auxiliary
 * HTTP surface without sending a single POST.
 */
async function listWorkerEndpoints(): Promise<string[]> {
	if (process.platform !== "win32") {
		return [];
	}
	// `netstat` is the only always-present way to enumerate listening sockets on
	// Windows; its output is parsed for loopback listeners and their owning pid.
	let output: string;
	try {
		const netstat = Bun.spawnSync(["netstat", "-ano", "-p", "tcp"], { stdout: "pipe" });
		output = netstat.stdout.toString();
	} catch {
		return [];
	}

	const listeners = new Map<string, number>();
	for (const line of output.split(/\r?\n/)) {
		// A worker's ACP surface can appear either as a listener or only as an
		// established local socket, so both local-endpoint forms are collected and
		// the port's own handshake decides whether it is really a worker.
		const match = line.match(
			/^\s*TCP\s+(127\.0\.0\.1):(\d+)\s+\S+\s+(LISTENING|ESTABLISHED|CLOSE_WAIT)\s+(\d+)\s*$/,
		);
		if (match === null) continue;
		const port = Number(match[2]);
		const pid = Number(match[4]);
		if (!Number.isInteger(port) || port < 1 || port > 65_535 || pid <= 0) continue;
		listeners.set(`http://127.0.0.1:${port}`, pid);
	}

	// Only ports held by a live WorkBuddy process can belong to a worker, so a
	// socket owned by anything else is never contacted.
	const candidates: string[] = [];
	for (const [endpoint, pid] of listeners) {
		if (isLiveWorkBuddyProcess(pid)) {
			candidates.push(endpoint);
		}
	}
	return candidates.sort();
}

/**
 * Finds endpoints of live WorkBuddy workers that publish no registry entry.
 *
 * Only loopback listeners owned by a running WorkBuddy process are considered,
 * and a port is kept solely when it answers the ACP connect handshake, which is
 * the worker's own identity check. No other port is probed and nothing is
 * written to the worker.
 */
async function locateWorkerEndpoints(
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string[]> {
	const candidates = await listWorkerEndpoints();

	const responsive: string[] = [];
	await Promise.all(
		candidates.map(async (endpoint) => {
			const ok = await answersAcpConnect(endpoint, signal, timeoutMs);
			if (ok) responsive.push(endpoint);
		}),
	);
	return responsive.sort();
}

/** True when the pid belongs to a running WorkBuddy process. */
function isLiveWorkBuddyProcess(pid: number): boolean {
	let output: string;
	try {
		output = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			stdout: "pipe",
		}).stdout.toString();
	} catch {
		return false;
	}
	return /"WorkBuddy\.exe"/i.test(output);
}

/** True when the endpoint completes the worker's ACP connect handshake. */
async function answersAcpConnect(endpoint: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const requestSignal = AbortSignal.any([signal, timeout]);
	try {
		const response = await fetch(`${endpoint}/api/v1/acp/connect`, {
			method: "POST",
			headers: { [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
			redirect: "error",
			signal: requestSignal,
		});
		if (!response.ok) {
			return false;
		}
		const body = (await response.json()) as unknown;
		return (
			body !== null &&
			typeof body === "object" &&
			"connectionId" in body &&
			typeof (body as { connectionId: unknown }).connectionId === "string"
		);
	} catch {
		return false;
	}
}

/** Scans primary session JSON state files written by WorkBuddy worker registries. */
async function scanSessionStateFiles(sessionsDir: string): Promise<DiscoveredCandidate[]> {
	const candidates: DiscoveredCandidate[] = [];
	let entries: string[];
	try {
		entries = await fs.promises.readdir(sessionsDir);
	} catch {
		return candidates;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const fullPath = path.join(sessionsDir, entry);
		let content: string;
		try {
			content = await fs.promises.readFile(fullPath, "utf8");
		} catch {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			// Malformed or partially-written files are skipped per contract.
			continue;
		}

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			continue;
		}

		const rec = parsed as Record<string, unknown>;
		const meta = rec.meta && typeof rec.meta === "object" && !Array.isArray(rec.meta)
			? (rec.meta as Record<string, unknown>)
			: undefined;

		const rawEndpoint = typeof rec.endpoint === "string" && rec.endpoint !== ""
			? rec.endpoint
			: typeof rec.url === "string" && rec.url !== ""
			? rec.url
			: meta && typeof meta.endpoint === "string" && meta.endpoint !== ""
			? meta.endpoint
			: meta && typeof meta.url === "string" && meta.url !== ""
			? meta.url
			: null;

		const sessionId = typeof rec.sessionId === "string" && rec.sessionId !== ""
			? rec.sessionId
			: null;

		const cwd = typeof rec.cwd === "string" && rec.cwd !== ""
			? rec.cwd
			: null;

		if (!rawEndpoint || !sessionId || !cwd) {
			continue;
		}

		const endpoint = parseAndValidateEndpoint(rawEndpoint);
		if (!endpoint) {
			continue;
		}

		const version = typeof rec.version === "string" ? rec.version : "";
		candidates.push({ endpoint, sessionId, cwd, version });
	}

	return candidates;
}

/** Parses one WorkBuddy log file and extracts the workspace path, UUID, and worker endpoint. */
function parseLogFileContent(content: string): DiscoveredCandidate | null {
	const lines = content.split(/\r?\n/);
	let cwd: string | undefined;
	let sessionId: string | undefined;
	let endpoint: string | undefined;
	let version = "";

	for (const line of lines) {
		if (cwd === undefined && line.startsWith("Workspace Path:")) {
			cwd = line.slice("Workspace Path:".length).trim();
		}

		const syncMatch = line.match(/Worker PID file synced with session UUID:\s*([0-9a-fA-F-]+)/);
		if (syncMatch && syncMatch[1]) {
			sessionId = syncMatch[1].trim();
		}

		if (!sessionId) {
			const cliMatch = line.match(/--session-id["'\s,=]+([0-9a-fA-F-]+)/);
			if (cliMatch && cliMatch[1]) {
				sessionId = cliMatch[1].trim();
			}
		}

		// The LAST registration endpoint line wins within a single log file.
		const epMatch = line.match(/Worker registered with endpoint:\s*(http:\/\/127\.0\.0\.1:\d+)/);
		if (epMatch && epMatch[1]) {
			endpoint = epMatch[1].trim();
		}

		const verMatch = line.match(/\[Prewarm\]\s+activated\s+pid=\d+\s+version=([^\s→]+)/);
		if (verMatch && verMatch[1]) {
			version = verMatch[1].trim();
		}
	}

	if (!cwd || !sessionId || !endpoint) {
		return null;
	}

	const validatedEndpoint = parseAndValidateEndpoint(endpoint);
	if (!validatedEndpoint) {
		return null;
	}

	return {
		endpoint: validatedEndpoint,
		sessionId,
		cwd,
		version,
	};
}

/**
 * Reads session identity and version facts from worker logs.
 *
 * Unlike {@link parseLogFileContent}, a log is still useful when it never
 * recorded an endpoint: a prewarm-activated worker logs its session UUID and
 * version but publishes no port, and the version is needed for the binding.
 */
function parseLogMetadata(content: string): { sessionId: string; cwd: string; version: string } | null {
	let cwd: string | undefined;
	let sessionId: string | undefined;
	let version = "";
	for (const line of content.split(/\r?\n/)) {
		if (cwd === undefined && line.startsWith("Workspace Path:")) {
			cwd = line.slice("Workspace Path:".length).trim();
		}
		const syncMatch = line.match(/Worker PID file synced with session UUID:\s*([0-9a-fA-F-]+)/);
		if (syncMatch?.[1]) {
			sessionId = syncMatch[1].trim();
		}
		if (sessionId === undefined) {
			const cliMatch = line.match(/--session-id["'\s,=]+([0-9a-fA-F-]+)/);
			if (cliMatch?.[1]) {
				sessionId = cliMatch[1].trim();
			}
		}
		const versionMatch = line.match(/\[Prewarm\]\s+activated\s+pid=\d+\s+version=([^\s→]+)/);
		if (versionMatch?.[1]) {
			version = versionMatch[1].trim();
		}
	}
	if (cwd === undefined || sessionId === undefined) {
		return null;
	}
	return { sessionId, cwd, version };
}

/** Collects the version each session was last started with, keyed by session id. */
async function scanLogMetadata(logsDir: string): Promise<Map<string, string>> {
	const versions = new Map<string, string>();
	const files = await collectLogFiles(logsDir);
	for (const filePath of files) {
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, "utf8");
		} catch {
			continue;
		}
		const metadata = parseLogMetadata(content);
		if (metadata === null || metadata.version === "") {
			continue;
		}
		// Log files are visited newest first, so the first version seen for a
		// session is the most recent worker that served it.
		if (!versions.has(metadata.sessionId)) {
			versions.set(metadata.sessionId, metadata.version);
		}
	}
	return versions;
}

/** Lists candidate log files, newest date directory first. */
async function collectLogFiles(logsDir: string): Promise<string[]> {
	const files: string[] = [];
	let entries: string[];
	try {
		entries = await fs.promises.readdir(logsDir);
	} catch {
		return files;
	}
	const dateDirs = entries
		.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
		.sort((a, b) => b.localeCompare(a));
	for (const dateDir of dateDirs) {
		const subDir = path.join(logsDir, dateDir);
		try {
			for (const name of await fs.promises.readdir(subDir)) {
				if (name.endsWith(".log")) {
					files.push(path.join(subDir, name));
				}
			}
		} catch {
			// An unreadable date directory is skipped.
		}
	}
	for (const entry of entries) {
		if (entry.endsWith(".log")) {
			files.push(path.join(logsDir, entry));
		}
	}
	return files;
}

/** Scans WorkBuddy log directories from newest to oldest for active session registrations. */
async function scanLogs(logsDir: string): Promise<DiscoveredCandidate[]> {
	const candidates: DiscoveredCandidate[] = [];
	for (const filePath of await collectLogFiles(logsDir)) {
		try {
			const content = await fs.promises.readFile(filePath, "utf8");
			const candidate = parseLogFileContent(content);
			if (candidate) {
				candidates.push(candidate);
			}
		} catch {
			// Skip unreadable files without failing the whole discovery process.
		}
	}
	return candidates;
}

/** Queries one worker endpoint with timeout and verifies envelope success. */
async function fetchWorkerJson(
	url: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<Record<string, unknown> | null> {
	const perRequestTimeout = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, perRequestTimeout]) : perRequestTimeout;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { [REQUEST_HEADER]: REQUEST_HEADER_VALUE },
			redirect: "error",
			signal: requestSignal,
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		// A refused credential is reported distinctly so the caller can tell the
		// user to authorize instead of claiming the session is not running.
		if (response.status === 401 || response.status === 403) {
			throw new WbError(
				WB_ERROR_CODE.authRequired,
				`WorkBuddy worker refused the request with HTTP ${response.status}`,
			);
		}
		return null;
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return null;
	}

	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return null;
	}

	const record = body as Record<string, unknown>;
	if ("error" in record && record.error !== undefined && record.error !== null) {
		return null;
	}

	const unwrapped = "data" in record && record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
		? (record.data as Record<string, unknown>)
		: record;

	if ("error" in unwrapped && unwrapped.error !== undefined && unwrapped.error !== null) {
		return null;
	}

	return unwrapped;
}

/**
 * Verifies a candidate through the ACP handshake alone.
 *
 * Used when the worker's auxiliary HTTP probes are unavailable. The handshake
 * is an acceptable substitute because it exercises the very surface delegation
 * uses, and it authenticates the candidate: only a worker actually running the
 * expected session accepts the bound UUID.
 */
async function verifyThroughAcp(
	candidate: DiscoveredCandidate,
	targetProjectRoot: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<DesktopCandidate | null> {
	// The worker's reported version is authoritative, but its info endpoint may be
	// refused independently of ACP, so a recovered version is the fallback.
	const info = await fetchWorkerJson(`${candidate.endpoint}/api/v1/info`, signal, timeoutMs).catch(() => null);
	const version = info !== null && typeof info.version === "string" && info.version !== ""
		? info.version
		: candidate.version;

	const acp = acpClient();
	let connection: AcpHttpConnection;
	try {
		connection = await connectAcpHttp(candidate.endpoint, signal);
	} catch (error: unknown) {
		if (error instanceof AcpHttpError && error.isAuthFailure) {
			// Even the handshake was refused, so this worker cannot be attached to.
			throw new WbError(
				WB_ERROR_CODE.authRequired,
				`WorkBuddy worker at ${candidate.endpoint} refused the ACP handshake`,
			);
		}
		return null;
	}

	const connected = acp.connect(connection.stream);
	try {
		const initialized = await connected.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: CLIENT_INFO,
			clientCapabilities: {},
		});
		if (initialized.protocolVersion !== PROTOCOL_VERSION) {
			return null;
		}
		if (initialized.agentCapabilities?.loadSession !== true) {
			return null;
		}

		// Resuming the expected session is the identity check: a worker serving a
		// different session rejects this UUID, and the reported cwd is compared so
		// a worker for another project is never adopted.
		const resumed = await connected.agent.request(methods.agent.session.resume, {
			sessionId: candidate.sessionId,
			cwd: candidate.cwd,
		});
		if (
			"sessionId" in resumed &&
			typeof resumed.sessionId === "string" &&
			resumed.sessionId !== candidate.sessionId
		) {
			// The worker acknowledged a different session than the one asked for, so
			// adopting it would bind this project to somebody else's conversation.
			return null;
		}
		const reportedCwd = "cwd" in resumed && typeof resumed.cwd === "string" ? resumed.cwd : candidate.cwd;
		if ((await normalizePath(reportedCwd)) !== (await normalizePath(targetProjectRoot))) {
			return null;
		}

		return {
			endpoint: candidate.endpoint,
			binding: {
				version: 1,
				projectRoot: targetProjectRoot,
				sessionId: candidate.sessionId,
				workbuddyVersion: version,
			},
			// A writer conflict surfaces at connect time, so discovery reports the
			// session as usable and lets the caller act on the precise error.
			busy: false,
		};
	} catch (error: unknown) {
		if (isWriterOccupied(error)) {
			// The session exists and is being driven; that is discovery success
			// with a busy marker rather than a missing session.
			return {
				endpoint: candidate.endpoint,
				binding: {
					version: 1,
					projectRoot: targetProjectRoot,
					sessionId: candidate.sessionId,
					workbuddyVersion: version,
				},
				busy: true,
			};
		}
		return null;
	} finally {
		try {
			connected.close();
		} catch {
			// Closing an already-failed connection is not an error.
		}
		await connection.close().catch(() => undefined);
	}
}


async function validateCandidate(
	candidate: DiscoveredCandidate,
	targetProjectRoot: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<DesktopCandidate | null> {
	// The worker authenticates its own ACP surface separately from its auxiliary
	// HTTP endpoints, so a worker whose informational probes are refused can
	// still be verified through the handshake the delegation actually uses.
	const [health, info, live] = await Promise.all([
		fetchWorkerJson(`${candidate.endpoint}/api/v1/health`, signal, timeoutMs).catch(() => null),
		fetchWorkerJson(`${candidate.endpoint}/api/v1/info`, signal, timeoutMs).catch(() => null),
		fetchWorkerJson(`${candidate.endpoint}/api/v1/sessions/live`, signal, timeoutMs).catch(() => null),
	]);

	if (!health || !info || !live) {
		return await verifyThroughAcp(candidate, targetProjectRoot, signal, timeoutMs);
	}

	if (health.status !== "ok") {
		return null;
	}

	if (typeof info.cwd !== "string" || info.cwd === "") {
		return null;
	}

	// Cross-consistency check 1: Worker's reported cwd must match the candidate's discovered cwd.
	const normInfoCwd = await normalizePath(info.cwd);
	const normDiscoveredCwd = await normalizePath(candidate.cwd);
	if (normInfoCwd !== normDiscoveredCwd) {
		return null;
	}

	// Cross-consistency check 2: Worker's reported cwd must match the target project root realpath.
	const normTargetProjectRoot = await normalizePath(targetProjectRoot);
	if (normInfoCwd !== normTargetProjectRoot) {
		return null;
	}

	// Cross-consistency check 3: If live session reports a sessionId, it must match candidate's.
	if (live.sessionId !== null && live.sessionId !== undefined) {
		if (typeof live.sessionId !== "string" || live.sessionId !== candidate.sessionId) {
			return null;
		}
	}

	const busy = Boolean(live.writerOccupied);
	const workbuddyVersion = typeof info.version === "string" && info.version !== ""
		? info.version
		: candidate.version;

	const binding: Binding = {
		version: 1,
		projectRoot: targetProjectRoot,
		sessionId: candidate.sessionId,
		workbuddyVersion,
	};

	return {
		endpoint: candidate.endpoint,
		binding,
		busy,
	};
}

/**
 * Collects the unverified worker candidates that could serve a project.
 *
 * Shared by discovery (which then validates each candidate through the ACP
 * handshake) and by read-only diagnostics (which must never attach). Every
 * endpoint is parsed and validated before it enters the result, and nothing here
 * contacts a worker.
 */
async function collectDiscoveredCandidates(
	projectRoot: string,
	signal: AbortSignal,
	options: DiscoveryOptions | undefined,
	locate: (signal: AbortSignal, timeoutMs: number) => Promise<string[]>,
): Promise<{ targetProjectRoot: string; candidates: DiscoveredCandidate[] }> {
	let targetProjectRoot: string;
	try {
		targetProjectRoot = await fs.promises.realpath(projectRoot);
	} catch {
		targetProjectRoot = path.resolve(projectRoot);
	}

	const defaultBaseDir = path.join(
		process.env.USERPROFILE || process.env.HOME || os.homedir(),
		".workbuddy",
	);
	const sessionsDir = options?.sessionsDir ?? path.join(defaultBaseDir, "sessions");
	const logsDir = options?.logsDir ?? path.join(defaultBaseDir, "logs");
	const fetchTimeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

	const sessionCandidates = await scanSessionStateFiles(sessionsDir);
	const logCandidates = await scanLogs(logsDir);

	// A session activated from WorkBuddy's prewarm pool serves ACP but never
	// writes a registry endpoint, so its port is recovered from the OS instead.
	// The result is never trusted on its own: every candidate still has to pass
	// the same probe, cwd and session-id checks below.
	const unaddressed = await recoverUnaddressedSessions(sessionsDir, [...sessionCandidates, ...logCandidates]);
	const rawEndpoints = await locate(signal, fetchTimeoutMs);
	// Endpoints from a locator are untrusted input, so each one is validated
	// before it can become a candidate.
	const portCandidates: string[] = [];
	for (const raw of rawEndpoints) {
		const endpoint = parseAndValidateEndpoint(raw);
		if (endpoint !== null) {
			portCandidates.push(endpoint);
		}
	}

	// A prewarm-activated worker logs its version but no port, so the version is
	// taken from the logs to complete the binding written for a recovered session.
	if (portCandidates.length > 0 && unaddressed.length > 0) {
		const metadata = await scanLogMetadata(logsDir);
		for (const session of unaddressed) {
			if (session.version !== "") {
				continue;
			}
			const recorded = metadata.get(session.sessionId);
			if (recorded !== undefined && recorded !== "") {
				session.version = recorded;
			}
		}
	}

	// Primary session state files take precedence; deduplicate both endpoint and sessionId.
	const seenEndpoints = new Set<string>();
	const seenSessionIds = new Set<string>();
	const deduplicated: DiscoveredCandidate[] = [];

	for (const candidate of [...sessionCandidates, ...logCandidates]) {
		if (seenEndpoints.has(candidate.endpoint) || seenSessionIds.has(candidate.sessionId)) {
			continue;
		}
		seenEndpoints.add(candidate.endpoint);
		seenSessionIds.add(candidate.sessionId);
		deduplicated.push(candidate);
	}

	// Pair recovered endpoints with sessions that named no endpoint, and with
	// sessions whose named endpoint predates a worker restart. Each pairing is a
	// hypothesis: validation below still requires the worker's own cwd, health
	// and session id to agree before it becomes a candidate.
	for (const endpoint of portCandidates) {
		if (seenEndpoints.has(endpoint)) {
			continue;
		}
		for (const session of unaddressed) {
			seenSessionIds.delete(session.sessionId);
			deduplicated.push({
				endpoint,
				sessionId: session.sessionId,
				cwd: session.cwd,
				version: session.version,
			});
		}
	}

	return { targetProjectRoot, candidates: deduplicated };
}

/**
 * Discovers and validates live WorkBuddy sessions matching the target project root.
 *
 * @param projectRoot Working directory of the project to find sessions for.
 * @param signal Aborts the discovery operation.
 * @param options Configurable roots for session files and logs, and the probe budget.
 * @returns Validated candidates, or an empty array when nothing matches.
 * @throws WbError with `WB_AUTH_REQUIRED` when the only workers found refused the
 *   request as unauthenticated — an empty array would misreport that as "no session".
 */
export async function discover(
	projectRoot: string,
	signal: AbortSignal,
	options?: DiscoveryOptions,
): Promise<DesktopCandidate[]> {
	const locate = options?.locateEndpoints ?? locateWorkerEndpoints;
	const { targetProjectRoot, candidates } = await collectDiscoveredCandidates(
		projectRoot,
		signal,
		options,
		locate,
	);

	// Validate remaining candidates concurrently against the live worker HTTP endpoints.
	const validationResults = await Promise.allSettled(
		candidates.map((candidate) =>
			validateCandidate(candidate, targetProjectRoot, signal, options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
		),
	);

	const validCandidates: DesktopCandidate[] = [];
	let authFailure: WbError | undefined;
	for (const result of validationResults) {
		if (result.status === "fulfilled") {
			if (result.value !== null) {
				validCandidates.push(result.value);
			}
			continue;
		}
		// One refusing worker must not hide the others, but the refusal is kept
		// so an otherwise-empty result can explain why.
		if (result.reason instanceof WbError && result.reason.code === WB_ERROR_CODE.authRequired) {
			authFailure ??= result.reason;
		}
	}

	// Ensure predictable ordering across calls by sorting by endpoint string.
	validCandidates.sort((a, b) => a.endpoint.localeCompare(b.endpoint));

	if (validCandidates.length === 0 && authFailure !== undefined) {
		throw authFailure;
	}
	return validCandidates;
}

/**
 * Inspects the workers serving a bound session without attaching to any of them.
 *
 * Every probe is a GET, so no connection is claimed, no writer is taken and no
 * session is created, resumed or loaded. `verified` therefore means only that the
 * auxiliary HTTP endpoints agree about identity and health: ACP compatibility is
 * proven when a real delegation connects, never here.
 */
export async function inspectWorkers(
	binding: Binding,
	signal: AbortSignal,
	options?: DiscoveryOptions,
): Promise<WorkerInspection[]> {
	const locate =
		options?.locateEndpoints ??
		(async (_signal: AbortSignal, _timeoutMs: number): Promise<string[]> => await listWorkerEndpoints());
	const { targetProjectRoot, candidates } = await collectDiscoveredCandidates(
		binding.projectRoot,
		signal,
		options,
		locate,
	);
	const fetchTimeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

	// Only the bound session is inspected, and only once per endpoint.
	const byEndpoint = new Map<string, DiscoveredCandidate>();
	for (const candidate of candidates) {
		if (candidate.sessionId === binding.sessionId) {
			byEndpoint.set(candidate.endpoint, candidate);
		}
	}

	const normalizedTarget = await normalizePath(targetProjectRoot);
	const results = await Promise.all(
		[...byEndpoint.values()].map(async (candidate) => {
			const [health, info, live] = await Promise.allSettled([
				fetchWorkerJson(`${candidate.endpoint}/api/v1/health`, signal, fetchTimeoutMs),
				fetchWorkerJson(`${candidate.endpoint}/api/v1/info`, signal, fetchTimeoutMs),
				fetchWorkerJson(`${candidate.endpoint}/api/v1/sessions/live`, signal, fetchTimeoutMs),
			]);

			// The order below is the contract: a refusal is reported before anything
			// else, then missing evidence, then health, then identity, then writer state.
			// `fetchWorkerJson` rejects only for an explicit 401/403, and that is
			// re-checked here so only a real credential refusal is reported as one.
			const refusal = [health, info, live].find(
				(result) => result.status === "rejected" && isAuthFailure(result.reason),
			);
			if (refusal !== undefined) {
				return { endpoint: candidate.endpoint, status: "auth_required", workbuddyVersion: null } as const;
			}

			const healthBody = health.status === "fulfilled" ? health.value : null;
			const infoBody = info.status === "fulfilled" ? info.value : null;
			const liveBody = live.status === "fulfilled" ? live.value : null;

			// Identity cannot be established from a probe that returned no usable body.
			if (healthBody === null || infoBody === null || liveBody === null) {
				return { endpoint: candidate.endpoint, status: "unknown", workbuddyVersion: null } as const;
			}

			const healthStatus = healthBody.status;
			const reportedCwd = infoBody.cwd;
			const liveSessionId = liveBody.sessionId;
			const writerOccupied = liveBody.writerOccupied;
			const version = typeof infoBody.version === "string" && infoBody.version !== "" ? infoBody.version : null;

			// Every field the classification depends on must have the shape this
			// worker contract defines; anything else is evidence that is not usable.
			if (
				typeof healthStatus !== "string" ||
				healthStatus === "" ||
				typeof reportedCwd !== "string" ||
				reportedCwd === "" ||
				typeof liveSessionId !== "string" ||
				liveSessionId === "" ||
				typeof writerOccupied !== "boolean"
			) {
				return { endpoint: candidate.endpoint, status: "unknown", workbuddyVersion: version } as const;
			}

			if (healthStatus !== "ok") {
				return { endpoint: candidate.endpoint, status: "unhealthy", workbuddyVersion: version } as const;
			}

			// Both the discovered and the reported cwd must be this project, and the
			// live session must be the bound one; otherwise this endpoint belongs to
			// somebody else's work.
			const cwdAgrees =
				(await normalizePath(candidate.cwd)) === normalizedTarget &&
				(await normalizePath(reportedCwd)) === normalizedTarget;
			if (!cwdAgrees || liveSessionId !== binding.sessionId) {
				return { endpoint: candidate.endpoint, status: "mismatch", workbuddyVersion: version } as const;
			}

			return writerOccupied
				? ({ endpoint: candidate.endpoint, status: "busy", workbuddyVersion: version } as const)
				: ({ endpoint: candidate.endpoint, status: "verified", workbuddyVersion: version } as const);
		}),
	);

	return results.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

/** Implementation of {@link DesktopSession} backed by a long-lived ACP connection. */
class DesktopSessionImpl implements DesktopSession {
	readonly #transport: AcpHttpConnection;
	readonly #clientConn: ClientConnection;
	readonly #binding: Binding;
	readonly #signal: AbortSignal;
	#closed = false;

	constructor(
		transport: AcpHttpConnection,
		clientConn: ClientConnection,
		binding: Binding,
		signal: AbortSignal,
	) {
		this.#transport = transport;
		this.#clientConn = clientConn;
		this.#binding = binding;
		this.#signal = signal;
	}

	async prompt(text: string): Promise<PromptOutcome> {
		if (this.#closed || this.#signal.aborted) {
			throw new WbError(WB_ERROR_CODE.sessionNotRunning, "Desktop session is closed or aborted");
		}

		try {
			const response = await this.#clientConn.agent.request(
				methods.agent.session.prompt,
				{
					sessionId: this.#binding.sessionId,
					prompt: [{ type: "text", text }],
				},
			);

			// WorkBuddy reports a failure message alongside `stopReason`, which the
			// ACP response type does not model; read it without trusting a shape.
			const reported = "errorMessage" in response ? response.errorMessage : undefined;
			const outcome: PromptOutcome = {
				stopReason: String(response?.stopReason ?? "end_turn"),
				...(typeof reported === "string" ? { errorMessage: reported } : {}),
			};
			return outcome;
		} catch (error: unknown) {
			if (error instanceof WbError) throw error;
			throw new WbError(
				WB_ERROR_CODE.interrupted,
				`Prompt turn interrupted: ${describeError(error)}`,
			);
		}
	}

	async cancel(): Promise<void> {
		if (this.#closed || this.#signal.aborted) {
			throw new WbError(WB_ERROR_CODE.sessionNotRunning, "Desktop session is closed or aborted");
		}

		try {
			await this.#clientConn.agent.notify(
				methods.agent.session.cancel,
				{ sessionId: this.#binding.sessionId },
			);
		} catch (error: unknown) {
			if (error instanceof WbError) throw error;
			throw new WbError(
				WB_ERROR_CODE.interrupted,
				`Session cancel interrupted: ${describeError(error)}`,
			);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		try {
			this.#clientConn.close();
		} catch {
			// Best-effort client connection teardown.
		}
		await this.#transport.close();
	}
}

/**
 * Connects to a verified WorkBuddy desktop session over ACP HTTP.
 *
 * @param binding Target session binding containing sessionId and projectRoot.
 * @param callbacks Event and request handlers registered for agent communication.
 * @param signal Aborts the connection handshake and tears down the active stream.
 * @param options Optional discovery parameters.
 */
export async function connect(
	binding: Binding,
	callbacks: DesktopCallbacks,
	signal: AbortSignal,
	options?: ConnectOptions,
): Promise<DesktopSession> {
	let normalizedProjectRoot: string;
	try {
		normalizedProjectRoot = await fs.promises.realpath(binding.projectRoot);
	} catch {
		normalizedProjectRoot = path.resolve(binding.projectRoot);
	}

	// Always discover fresh on connect because workers respawn and dynamic ports change.
	const candidates = await discover(normalizedProjectRoot, signal, options);
	const candidate = candidates.find((c) => c.binding.sessionId === binding.sessionId);

	if (!candidate) {
		throw new WbError(
			WB_ERROR_CODE.sessionNotRunning,
			`No running WorkBuddy session found for sessionId: ${binding.sessionId}`,
		);
	}
	if (candidate.busy) {
		throw new WbError(
			WB_ERROR_CODE.busy,
			`WorkBuddy session ${binding.sessionId} is busy (writer occupied)`,
		);
	}

	let transport: AcpHttpConnection;
	try {
		transport = await connectAcpHttp(candidate.endpoint, signal);
	} catch (error: unknown) {
		if (isAuthFailure(error)) {
			throw new WbError(
				WB_ERROR_CODE.authRequired,
				`Authentication required for WorkBuddy worker at ${candidate.endpoint}`,
			);
		}
		throw error;
	}

	const app = acpClient({ name: CLIENT_INFO.name });

	// Register session/update notifications: pass frames faithfully, and surface
	// interruption requests embedded in _meta to callbacks.onRequest.
	app.onNotification(methods.client.session.update, async ({ params }) => {
		if (params.sessionId !== binding.sessionId) {
			return;
		}

		await callbacks.onUpdate(params as DesktopSessionUpdate);

		for (const interruption of interruptionRequestsIn(params)) {
			// A notification cannot carry an answer back, so the decision is
			// delivered as WorkBuddy's own resolveInterruption request. An
			// unanswered interruption would block the worker's interruption service
			// until it times out, so a non-answer is refused rather than dropped.
			const decision = await callbacks.onRequest("codebuddy.ai/interruptionRequest", interruption);
			const answer = decision ?? refusalFor(interruption);
			if (answer === undefined) {
				continue;
			}
			try {
				await clientConn.agent.request(INTERRUPTION_RESOLVE_METHOD, answer);
			} catch {
				// A refused or already-expired interruption is not fatal to the
				// turn; the worker decides what to do next.
			}
		}
	});

	// Standard ACP permission request handler. The entry point answers with the
	// typed outcome, or the request is cancelled when it declines to answer.
	app.onRequest(methods.client.session.requestPermission, async ({ params }) => {
		const response = await callbacks.onRequest(methods.client.session.requestPermission, params);
		if (response === undefined || response === null) {
			// `cancelled` is the protocol's own way of saying no decision was made,
			// and it releases the agent rather than leaving the request pending.
			return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResponse;
		}
		return response as RequestPermissionResponse;
	});

	// WorkBuddy's own extension method for correlating a decision with a session.
	app.onRequest("_codebuddy.ai/getUserInfo", (val: unknown) => val, async ({ params }) => {
		return callbacks.onRequest("_codebuddy.ai/getUserInfo", params);
	});

	// Use app.connect to retain control of the long-lived ACP connection handle.
	const clientConn = app.connect(transport.stream);

	// Initial handshake with strict capability declarations.
	let initResult: { protocolVersion: number; agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } };
	try {
		initResult = await clientConn.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: CLIENT_INFO,
			clientCapabilities: {},
		});
	} catch (error: unknown) {
		clientConn.close();
		await transport.close();
		if (isAuthFailure(error)) {
			throw new WbError(WB_ERROR_CODE.authRequired, `Worker requires authentication: ${describeError(error)}`);
		}
		throw new WbError(WB_ERROR_CODE.protocolUnsupported, `ACP initialize failed: ${describeError(error)}`);
	}

	if (initResult.protocolVersion !== PROTOCOL_VERSION) {
		clientConn.close();
		await transport.close();
		throw new WbError(
			WB_ERROR_CODE.protocolUnsupported,
			`Unsupported protocol version: ${initResult.protocolVersion} (expected ${PROTOCOL_VERSION})`,
		);
	}

	const agentCaps = initResult.agentCapabilities;
	const supportsLoad = agentCaps?.loadSession === true;
	const supportsResume = Boolean(agentCaps?.sessionCapabilities?.resume);

	if (!supportsLoad && !supportsResume) {
		clientConn.close();
		await transport.close();
		throw new WbError(
			WB_ERROR_CODE.protocolUnsupported,
			"Worker only supports session/new; cannot attach to existing dedicated session",
		);
	}

	// Load or resume session without history replay into caller state.
	let sessionLoaded = false;
	try {
		// Prefer session/resume to attach without replaying historical messages.
		const resumeResult = await clientConn.agent.request(
			methods.agent.session.resume,
			{
				sessionId: binding.sessionId,
				cwd: binding.projectRoot,
			},
		);

		if (resumeResult && typeof resumeResult === "object" && "sessionId" in resumeResult) {
			const returnedId = (resumeResult as Record<string, unknown>).sessionId;
			if (typeof returnedId === "string" && returnedId !== binding.sessionId) {
				throw new WbError(
					WB_ERROR_CODE.protocolUnsupported,
					`session/resume returned mismatched session UUID: ${returnedId}`,
				);
			}
		}
		sessionLoaded = true;
	} catch (error: unknown) {
		if (error instanceof WbError) {
			clientConn.close();
			await transport.close();
			throw error;
		}

		if (isAuthFailure(error)) {
			clientConn.close();
			await transport.close();
			throw new WbError(WB_ERROR_CODE.authRequired, describeError(error));
		}

		// The desktop app holding this session's writer is a busy condition, not a
		// protocol gap: the same call succeeds once the app lets go.
		if (isWriterOccupied(error)) {
			clientConn.close();
			await transport.close();
			throw new WbError(
				WB_ERROR_CODE.busy,
				`WorkBuddy is currently driving session ${binding.sessionId}; idle it in the desktop app and retry`,
			);
		}

		if (!isMethodNotFound(error)) {
			clientConn.close();
			await transport.close();
			throw new WbError(
				WB_ERROR_CODE.protocolUnsupported,
				`session/resume failed: ${describeError(error)}`,
			);
		}
	}

	// Fallback to session/load if session/resume is not implemented on the worker.
	if (!sessionLoaded) {
		try {
			const loadResult = await clientConn.agent.request(
				methods.agent.session.load,
				{
					sessionId: binding.sessionId,
					cwd: binding.projectRoot,
					mcpServers: [],
				},
			);

			if (loadResult && typeof loadResult === "object" && "sessionId" in loadResult) {
				const returnedId = (loadResult as Record<string, unknown>).sessionId;
				if (typeof returnedId === "string" && returnedId !== binding.sessionId) {
					throw new WbError(
						WB_ERROR_CODE.protocolUnsupported,
						`session/load returned mismatched session UUID: ${returnedId}`,
					);
				}
			}
		} catch (error: unknown) {
			clientConn.close();
			await transport.close();
			if (error instanceof WbError) throw error;
			if (isAuthFailure(error)) {
				throw new WbError(WB_ERROR_CODE.authRequired, describeError(error));
			}
			if (isWriterOccupied(error)) {
				throw new WbError(
					WB_ERROR_CODE.busy,
					`WorkBuddy is currently driving session ${binding.sessionId}; idle it in the desktop app and retry`,
				);
			}
			throw new WbError(
				WB_ERROR_CODE.protocolUnsupported,
				`session/load failed: ${describeError(error)}`,
			);
		}
	}

	return new DesktopSessionImpl(transport, clientConn, binding, signal);
}
