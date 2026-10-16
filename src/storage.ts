import { unlink, writeFile, rename, link, mkdir } from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";

/**
 * Writes data to a target path atomically by creating a unique temporary file
 * in the same directory and renaming it into place. This prevents concurrent readers
 * or system crashes from seeing partially written JSON files.
 */
export async function atomicWriteFile(directory: string, targetPath: string, content: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const tempPath = path.join(directory, `.tmp-${crypto.randomUUID()}`);
	try {
		await writeFile(tempPath, content, "utf-8");
		await rename(tempPath, targetPath);
	} catch (err: unknown) {
		try {
			await unlink(tempPath);
		} catch {
			// Ignore errors if the temp file was never written or already removed.
		}
		throw err;
	}
}

/**
 * Attempts to acquire an exclusive lock file using a staging file and hard link.
 * Returns true if the lock was created, or false if the lock file already exists (EEXIST).
 * Any other filesystem error is thrown.
 */
export async function tryCreateLockFile(lockPath: string, content: string): Promise<boolean> {
	await mkdir(path.dirname(lockPath), { recursive: true });
	const stagingPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.claim`;
	try {
		await writeFile(stagingPath, content, "utf-8");
		await link(stagingPath, lockPath);
		return true;
	} catch (err: unknown) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") {
			return false;
		}
		throw err;
	} finally {
		await unlink(stagingPath).catch(() => undefined);
	}
}
