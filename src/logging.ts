/**
 * Project-level structured event log for the bridge.
 *
 * Every writer owns exactly one JSONL file named
 * `bridge-<pid>-<instanceId>-<sequence>.jsonl` under
 * `<project>/.wb-bridge/logs/` and appends serially to it. Rotation advances
 * the sequence and opens a new file; retention only ever deletes the writer's
 * own rotations plus files of provably dead writers, so a live sibling
 * process never has its current file removed.
 *
 * The log is diagnostic: its I/O must never decide a business outcome.
 * Records are built field-by-field from a whitelist — external objects are
 * never spread in — and must never contain endpoints, ports, connection
 * tokens, environment values, full prompts, summaries, file contents or
 * reasoning.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./storage";

/** Maximum bytes of one writer file before it rotates. */
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated files kept per writer besides the current one. */
export const LOG_KEEP_ROTATIONS = 3;
/** Default retention window in days. */
export const LOG_DEFAULT_RETENTION_DAYS = 7;

/** Fixed diagnostic event vocabulary. */
export type BridgeEvent =
	| "integration.applied"
	| "integration.failed"
	| "pool.refreshed"
	| "queue.enqueued"
	| "queue.waiting"
	| "queue.claimed"
	| "dispatch.armed"
	| "dispatch.settled"
	| "cancel.requested"
	| "help.requested"
	| "help.answered"
	| "recovery.required"
	| "receipt.repaired"
	| "commit.failed";

/** Optional correlation fields; only these may appear besides time/level/event. */
export interface BridgeEventFields {
	taskId?: string;
	round?: number;
	requestId?: string;
	sessionId?: string;
	ownerPid?: number;
	attemptId?: string;
	revision?: number;
	reasonCode?: string;
	errorCode?: string;
	durationMs?: number;
	count?: number;
}

export type BridgeLogLevel = "debug" | "info" | "warn" | "error";

const BRIDGE_EVENTS: readonly BridgeEvent[] = [
	"integration.applied",
	"integration.failed",
	"pool.refreshed",
	"queue.enqueued",
	"queue.waiting",
	"queue.claimed",
	"dispatch.armed",
	"dispatch.settled",
	"cancel.requested",
	"help.requested",
	"help.answered",
	"recovery.required",
	"commit.failed",
];

const BRIDGE_LEVELS: readonly BridgeLogLevel[] = ["debug", "info", "warn", "error"];

/** One serialized diagnostic record as stored and returned. */
export type BridgeLogRecord = {
	time: string;
	level: BridgeLogLevel;
	event: BridgeEvent;
} & BridgeEventFields;

function messageOf(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/**
 * Re-projects one parsed JSON line into a {@link BridgeLogRecord}, accepting
 * only the fixed vocabulary and whitelist field types; returns `null` for
 * anything else so callers can count it as a malformed line instead of
 * echoing unknown bytes into panes or exports.
 */
function parseLogRecord(parsed: unknown): BridgeLogRecord | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const rec = parsed as Record<string, unknown>;
	if (typeof rec.time !== "string" || rec.time.length === 0) {
		return null;
	}
	if (!BRIDGE_EVENTS.includes(rec.event as BridgeEvent)) {
		return null;
	}
	if (!BRIDGE_LEVELS.includes(rec.level as BridgeLogLevel)) {
		return null;
	}
	const out: BridgeLogRecord = {
		time: rec.time,
		level: rec.level as BridgeLogLevel,
		event: rec.event as BridgeEvent,
	};
	const optional: (keyof BridgeEventFields)[] = [
		"taskId",
		"requestId",
		"sessionId",
		"attemptId",
		"reasonCode",
		"errorCode",
	];
	for (const key of optional) {
		const value = rec[key];
		if (typeof value === "string") {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	for (const key of ["round", "ownerPid", "revision", "durationMs", "count"] as const) {
		const value = rec[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return out;
}

/** Copies confirmed whitelist fields out of caller-supplied fields. */
function pickFields(fields: BridgeEventFields): BridgeEventFields {
	const picked: BridgeEventFields = {};
	if (fields.taskId !== undefined) picked.taskId = fields.taskId;
	if (fields.round !== undefined) picked.round = fields.round;
	if (fields.requestId !== undefined) picked.requestId = fields.requestId;
	if (fields.sessionId !== undefined) picked.sessionId = fields.sessionId;
	if (fields.ownerPid !== undefined) picked.ownerPid = fields.ownerPid;
	if (fields.attemptId !== undefined) picked.attemptId = fields.attemptId;
	if (fields.revision !== undefined) picked.revision = fields.revision;
	if (fields.reasonCode !== undefined) picked.reasonCode = fields.reasonCode;
	if (fields.errorCode !== undefined) picked.errorCode = fields.errorCode;
	if (fields.durationMs !== undefined) picked.durationMs = fields.durationMs;
	if (fields.count !== undefined) picked.count = fields.count;
	return picked;
}

/** Per-process activation identity; one writer state per project at a time. */
let instanceId = "";

/** Registers the activation's instance id before the first log write. */
export function setLogInstanceId(id: string): void {
	instanceId = id;
}

/** Supplies a stable fallback id when the host never registered one. */
export function ensureLogInstanceId(): string {
	if (!instanceId) {
		instanceId = crypto.randomUUID();
	}
	return instanceId;
}

interface WriterState {
	dir: string;
	sequence: number;
	handle: FileHandle | null;
	bytes: number;
	retentionDays: number;
	lastPruneAt: number;
	/** Set on the first I/O failure; cleared on the next successful append. */
	unavailable: string | null;
}

/** Injected host sink for the one sanitized warning per failure episode. */
export type LogWarnSink = (message: string) => void;

/** One writer state per project root, keyed by case-folded absolute path. */
const writers = new Map<string, WriterState>();

/** Serializes appends per project so a JSONL line is never interleaved. */
const appendLocks = new Map<string, Promise<void>>();

/**
 * Current logging failure per project root, independent of writer state: a
 * writer-open failure inserts no writer, so the diagnostic must not live only
 * inside the writer entry.
 */
const unavailableReasons = new Map<string, string>();

/** Where the per-episode host warning goes; unset means nowhere. */
let warnSink: LogWarnSink | null = null;

/** Registers the sink that receives the one sanitized logging warning. */
export function setLogWarnSink(sink: LogWarnSink | null): void {
	warnSink = sink;
}

function writerKey(root: string): string {
	return path.resolve(root).toLowerCase();
}

function logsDir(root: string): string {
	return path.join(root, ".wb-bridge", "logs");
}

/** Encodes the per-writer file name for a given rotation sequence. */
function nextFileName(sequence: number): string {
	return `bridge-${process.pid}-${instanceId}-${String(sequence).padStart(4, "0")}.jsonl`;
}

function parseRetentionDays(value: unknown): number {
	const n = typeof value === "number" ? Math.floor(value) : LOG_DEFAULT_RETENTION_DAYS;
	if (!Number.isFinite(n) || n < 1 || n > 30) {
		return LOG_DEFAULT_RETENTION_DAYS;
	}
	return n;
}

/**
 * Why logging is currently unavailable for the project, or `null` when the
 * last append succeeded. The workbench and doctor surface this verbatim.
 */
export function logUnavailableReason(root: string): string | null {
	return unavailableReasons.get(writerKey(root)) ?? null;
}

/** Prepares (or reuses) this process's writer for the project. */
async function getWriter(root: string): Promise<WriterState> {
	ensureLogInstanceId();
	const key = writerKey(root);
	const existing = writers.get(key);
	if (existing) {
		return existing;
	}
	const w: WriterState = {
		dir: logsDir(root),
		sequence: 0,
		handle: null,
		bytes: 0,
		retentionDays: LOG_DEFAULT_RETENTION_DAYS,
		lastPruneAt: 0,
		unavailable: null,
	};
	writers.set(key, w);
	await mkdir(w.dir, { recursive: true });
	// Continue numbering after this writer's existing files so a reopen
	// keeps a monotonic sequence instead of rewriting history.
	try {
		const names = await readdir(w.dir);
		const prefix = `bridge-${process.pid}-${instanceId}-`;
		for (const name of names) {
			if (name.startsWith(prefix) && name.endsWith(".jsonl")) {
				const seq = Number.parseInt(name.slice(prefix.length, -6), 10);
				if (Number.isFinite(seq) && seq >= w.sequence) {
					w.sequence = seq + 1;
				}
			}
		}
	} catch {
		// Fresh directory: start at 0.
	}
	return w;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

/** Extracts the owning pid from a log file name, or null when malformed. */
function ownerPidOf(name: string): number | null {
	const stem = name.slice("bridge-".length, -".jsonl".length);
	const pid = Number.parseInt(stem, 10);
	return Number.isFinite(pid) && `${pid}` === stem.split("-")[0] ? pid : null;
}

/**
 * Deletes this writer's rotations beyond the keep window and files of provably
 * dead writers past retention. Live writers' files are never touched.
 */
async function pruneOldFiles(w: WriterState): Promise<void> {
	const cutoff = Date.now() - w.retentionDays * 24 * 60 * 60 * 1000;
	let names: string[];
	try {
		names = await readdir(w.dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith("bridge-") || !name.endsWith(".jsonl")) {
			continue;
		}
		const filePid = ownerPidOf(name);
		if (filePid === null) {
			continue;
		}
		if (filePid === process.pid) {
			// Retention for my own closed rotations; the live file is not here.
			const stem = name.slice("bridge-".length, -".jsonl".length);
			const seq = Number.parseInt(stem.slice(stem.lastIndexOf("-") + 1), 10);
			if (Number.isFinite(seq) && seq < w.sequence - LOG_KEEP_ROTATIONS) {
				await unlink(path.join(w.dir, name)).catch(() => undefined);
			}
			continue;
		}
		const filePath = path.join(w.dir, name);
		const info = await stat(filePath).catch(() => null);
		if (!info || info.mtimeMs >= cutoff) {
			continue;
		}
		if (isPidAlive(filePid)) {
			continue;
		}
		await unlink(filePath).catch(() => undefined);
	}
}

/**
 * Appends one diagnostic event to this process's log file for the project.
 *
 * Never throws and never rejects: log I/O must not decide a business outcome.
 * On failure the writer records an `unavailable` reason (read by the workbench
 * and {@link exportDiagnostics}), emits exactly one sanitized host warning per
 * failure episode through the registered sink, and returns normally; the next
 * successful append clears the flag.
 */
export async function logEvent(
	root: string,
	event: BridgeEvent,
	fields: BridgeEventFields = {},
	level: BridgeLogLevel = "info",
	now: () => number = Date.now,
): Promise<void> {
	const key = writerKey(root);
	const prev = appendLocks.get(key) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(async () => {
		let w: WriterState;
		try {
			w = await getWriter(root);
		} catch (err: unknown) {
			markUnavailable(root, "writer-open", err);
			return;
		}
		const record: BridgeLogRecord = {
			time: new Date(now()).toISOString(),
			level,
			event,
			...pickFields(fields),
		};
		const line = `${JSON.stringify(record)}\n`;
		try {
			if (w.handle === null) {
				// The directory may have been removed since the writer was created
				// (external cleanup, test teardown); recreate before opening.
				await mkdir(w.dir, { recursive: true });
				const filePath = path.join(w.dir, nextFileName(w.sequence));
				w.handle = await open(filePath, "a");
				w.bytes = (await stat(filePath).catch(() => null))?.size ?? 0;
			}
			if (w.bytes + Buffer.byteLength(line, "utf-8") > LOG_FILE_MAX_BYTES) {
				// Rotate: close the current sequence, advance, open a new file.
				await w.handle.close().catch(() => undefined);
				w.handle = null;
				w.sequence += 1;
				w.handle = await open(path.join(w.dir, nextFileName(w.sequence)), "a");
				w.bytes = 0;
			}
			await w.handle.write(line);
			w.bytes += Buffer.byteLength(line, "utf-8");
			if (w.unavailable !== null) {
				w.unavailable = null; // Recovered: next failure warns again.
				unavailableReasons.delete(key);
			}
			if (now() - w.lastPruneAt > 60_000) {
				w.lastPruneAt = now();
				await pruneOldFiles(w);
			}
		} catch (err: unknown) {
			markUnavailable(root, "append", err);
		}
	});
	appendLocks.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	await next;
}

/**
 * Awaits every log write already queued for this root.
 *
 * The append chain never rejects, so this cannot fail: it reports only "the writes
 * that were pending when you asked have been attempted". That is what a caller that
 * needs the record on disk before proceeding should wait on — a timer would be a
 * guess about how long a filesystem takes.
 */
export async function flushBridgeLogs(root: string): Promise<void> {
	await (appendLocks.get(writerKey(root)) ?? Promise.resolve());
}

/** Records one failure episode and warns the host once, sanitized. */
function markUnavailable(root: string, operation: string, err: unknown): void {
	const detail = redactSecrets(messageOf(err));
	const key = writerKey(root);
	const w = writers.get(key);
	// Warn once per failure episode: a live writer mid-episode or a previously
	// recorded reason means the host has already been told.
	const alreadyWarned = w !== undefined ? w.unavailable !== null : unavailableReasons.has(key);
	const reason = `${operation}: ${detail}`;
	if (w) {
		w.unavailable = reason;
	}
	unavailableReasons.set(key, reason);
	if (!alreadyWarned && warnSink) {
		warnSink(`WorkBuddy bridge log unavailable (${operation}); diagnostics may be incomplete`);
	}
}

/** Reads the newest `limit` records, optionally filtered to one task. */
export async function readBridgeLogs(
	root: string,
	options: { taskId?: string; limit: number },
): Promise<BridgeLogRecord[]> {
	const limit = Math.max(1, Math.min(options.limit, 1000));
	let names: string[] = [];
	try {
		names = (await readdir(logsDir(root))).filter((n) => n.startsWith("bridge-") && n.endsWith(".jsonl")).sort();
	} catch {
		return [];
	}
	const matched: BridgeLogRecord[] = [];
	// Files sort by sequence ascending, so walk them newest first.
	for (let i = names.length - 1; i >= 0 && matched.length < limit; i--) {
		const name = names[i];
		if (name === undefined) {
			continue;
		}
		let content: string;
		try {
			content = await readFile(path.join(logsDir(root), name), "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		for (let j = lines.length - 1; j >= 0 && matched.length < limit; j--) {
			const raw = lines[j];
			if (raw === undefined || raw.trim().length === 0) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Corrupt line: skipped here; exportDiagnostics counts them.
				continue;
			}
			const record = parseLogRecord(parsed);
			if (record === null) {
				continue;
			}
			if (options.taskId !== undefined && record.taskId !== options.taskId) {
				continue;
			}
			matched.push(record);
		}
	}
	return matched;
}

/** Redacts loopback URLs/ports and bearer-like or long hex token values. */
export function redactSecrets(text: string): string {
	return text
		.replace(/https?:\/\/127\.0\.0\.1:\d+/gi, "http://127.0.0.1:<redacted>")
		.replace(/https?:\/\/localhost:\d+/gi, "http://localhost:<redacted>")
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
		.replace(/\b[0-9a-f]{64,}\b/gi, "<redacted-token>");
}

interface BridgeDiagnosticIssue {
	kind: "corrupt_lines" | "logging_unavailable";
	count?: number;
	detail: string;
}

/**
 * Counts unusable lines: JSON failures and lines outside the fixed vocabulary,
 * using the same validator as the reader so both paths agree.
 */
async function countCorruptLines(dir: string): Promise<number> {
	let corrupt = 0;
	const names = await readdir(dir)
		.then((n) => n.filter((x) => x.startsWith("bridge-") && x.endsWith(".jsonl")))
		.catch(() => [] as string[]);
	for (const name of names) {
		const raw = await readFile(path.join(dir, name), "utf-8").catch(() => "");
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				corrupt += 1;
				continue;
			}
			if (parseLogRecord(parsed) === null) {
				corrupt += 1;
			}
		}
	}
	return corrupt;
}

/**
 * Merges this project's redacted events plus read-only state summaries into
 * `diagnostics/<uuid>.json`. Copies no SQLite file, input or artifact.
 */
export async function exportDiagnostics(
	root: string,
	options: { taskId?: string; limit?: number; now?: () => number } = {},
): Promise<string> {
	const now = options.now ?? Date.now;
	const limit = options.limit ?? 500;
	const issues: BridgeDiagnosticIssue[] = [];
	const records = await readBridgeLogs(root, { taskId: options.taskId, limit }).catch(
		(err: unknown): BridgeLogRecord[] => {
			issues.push({ kind: "logging_unavailable", detail: messageOf(err) });
			return [];
		},
	);
	const dir = logsDir(root);
	const fileNames = await readdir(dir)
		.then((n) => n.filter((x) => x.startsWith("bridge-") && x.endsWith(".jsonl")))
		.catch(() => [] as string[]);
	const corrupt = await countCorruptLines(dir);
	if (corrupt > 0) {
		issues.push({
			kind: "corrupt_lines",
			count: corrupt,
			detail: "Malformed JSONL lines were skipped while reading",
		});
	}
	const payload = {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		projectRoot: root,
		taskId: options.taskId ?? null,
		records,
		stateSummary: {
			hasBinding: existsSync(path.join(root, ".wb-bridge", "binding.json")),
			logFileCount: fileNames.length,
		},
		issues,
	};
	const outDir = path.join(root, ".wb-bridge", "diagnostics");
	await mkdir(outDir, { recursive: true });
	const outPath = path.join(outDir, `${crypto.randomUUID()}.json`);
	await atomicWriteFile(outDir, outPath, JSON.stringify(payload, null, 2));
	return outPath;
}

/** Closes this process's writer for the project (tests and shutdown). */
export async function closeLogWriter(root: string): Promise<void> {
	const key = writerKey(root);
	const w = writers.get(key);
	if (w?.handle) {
		await w.handle.close().catch(() => undefined);
	}
	// Drop the entry even when no handle was ever opened so a stale
	// `unavailable` flag cannot leak into a later test or reactivation.
	writers.delete(key);
	unavailableReasons.delete(key);
}

/** Applies a user-configured retention window (1–30 days) to the writer. */
export async function setLogRetention(root: string, days: number): Promise<void> {
	const w = await getWriter(root);
	w.retentionDays = parseRetentionDays(days);
}

/** Resolves the project's log directory (tests and diagnostics listing). */
export function logDirectory(root: string): string {
	return logsDir(root);
}
