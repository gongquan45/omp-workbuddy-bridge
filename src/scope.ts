import path from "node:path";
import process from "node:process";
import { WbTaskError, WB_ERROR_CODE } from "./types";

/**
 * Normalizes a scope path: converts backslashes to forward slashes,
 * strips leading/trailing slashes, and rejects '..' or absolute paths.
 */
export function normalizeScopePath(raw: string): string {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, "Scope path must be a non-empty string");
	}
	if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Scope path must be relative: "${raw}"`);
	}
	const normalized = path.normalize(raw).split(path.sep).join("/");
	const segments = normalized.split("/");
	if (segments.some((seg) => seg === "..")) {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Scope path contains '..' traversal: "${raw}"`);
	}
	if (normalized === "." || normalized === "") {
		throw new WbTaskError(WB_ERROR_CODE.inputInvalid, `Scope path cannot target the entire project root: "${raw}"`);
	}
	return normalized;
}

/**
 * Checks if two normalized paths overlap hierarchically (exact match, parent-child, or child-parent).
 */
export function pathsOverlap(pathA: string, pathB: string): boolean {
	const a = process.platform === "win32" ? pathA.toLowerCase() : pathA;
	const b = process.platform === "win32" ? pathB.toLowerCase() : pathB;
	if (a === b) {
		return true;
	}
	if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
		return true;
	}
	return false;
}

export interface ScopePaths {
	readPaths: string[];
	writePaths: string[];
}

/**
 * True when a proposed scope conflicts with an existing one.
 *
 * Direction rules: a write conflicts with any overlapping read or write; a read
 * conflicts only with an overlapping write; read/read never conflicts.
 *
 * The stored side is untrusted data written by an earlier version, so a path
 * that cannot be normalized is treated as CONFLICTING rather than skipped: a
 * poisoned row must never license concurrent writers.
 */
export function scopesConflict(proposed: ScopePaths, existing: ScopePaths): boolean {
	const normalizeOrNull = (raw: string): string | null => {
		try {
			return normalizeScopePath(raw);
		} catch {
			return null;
		}
	};
	const existingWrites = existing.writePaths.map(normalizeOrNull);
	const existingReads = existing.readPaths.map(normalizeOrNull);
	// An un-normalizable stored path blocks everything: fail closed.
	if (existingWrites.some((p) => p === null) || existingReads.some((p) => p === null)) {
		return true;
	}
	for (const rawWrite of proposed.writePaths) {
		const write = normalizeOrNull(rawWrite);
		if (write === null) {
			return true;
		}
		for (const other of [...existingWrites, ...existingReads]) {
			if (other !== null && pathsOverlap(write, other)) {
				return true;
			}
		}
	}
	for (const rawRead of proposed.readPaths) {
		const read = normalizeOrNull(rawRead);
		if (read === null) {
			return true;
		}
		for (const other of existingWrites) {
			if (other !== null && pathsOverlap(read, other)) {
				return true;
			}
		}
	}
	return false;
}
