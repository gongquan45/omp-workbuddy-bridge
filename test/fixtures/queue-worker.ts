/**
 * Queue worker fixture: one real Bun process racing for a project's queue.
 *
 * Protocol (stdin/stdout JSONL, one object per line):
 *  - reads  { op: "enqueue" | "claim" | "close", ... }
 *  - writes { ok: true, result } or { ok: false, error: { code, message } }
 *
 * The parent test creates the project, registers the owner and enables the
 * project; the worker only exercises enqueue/claim so a second real process
 * contends on the same SQLite file.
 */

import { openProjectQueue, openWriteConnection, withImmediate, registerOwner } from "../../src/queue";
import type { OwnerIdentity } from "../../src/types";

interface WorkerMessage {
	op: "enqueue" | "claim" | "close";
	root?: string;
	owner?: { sessionId: string; generation: string; processId: number; instanceId: string };
	input?: Record<string, unknown>;
}

function respond(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
	const decoder = new TextDecoder();
	const buffer = await Bun.stdin.arrayBuffer();
	const text = decoder.decode(buffer);
	const lines = text.split("\n").filter((line) => line.trim().length > 0);

	for (const line of lines) {
		let parsed: WorkerMessage;
		try {
			parsed = JSON.parse(line) as WorkerMessage;
		} catch {
			respond({ ok: false, error: { code: "WB_INPUT_INVALID", message: "worker received malformed line" } });
			continue;
		}
		try {
			if (parsed.op === "close") {
				respond({ ok: true, result: "closed" });
				continue;
			}
			if (parsed.root === undefined || parsed.owner === undefined) {
				respond({ ok: false, error: { code: "WB_INPUT_INVALID", message: "root and owner are required" } });
				continue;
			}
			// Narrow the IPC-supplied owner before it reaches typed APIs: the
			// fixture is a cross-process boundary, so the shape is validated here
			// rather than asserted.
			const owner = parsed.owner;
			if (
				typeof owner.sessionId !== "string" ||
				typeof owner.generation !== "string" ||
				typeof owner.instanceId !== "string"
			) {
				respond({ ok: false, error: { code: "WB_INPUT_INVALID", message: "owner identity is incomplete" } });
				continue;
			}
			const identity: OwnerIdentity = {
				sessionId: owner.sessionId,
				generation: owner.generation,
				instanceId: owner.instanceId,
				processId: process.pid,
			};
			if (parsed.op === "claim") {
				const queue = openProjectQueue(parsed.root, { mode: "write" });
				if (queue === null) {
					respond({ ok: false, error: { code: "WB_STORAGE_ERROR", message: "no queue" } });
					continue;
				}
				const outcome = queue.claim(identity, Date.now());
				respond({ ok: true, result: outcome });
				continue;
			}
			// enqueue: the parent pre-registers owner and enables the project; the
			// worker proves its writer can insert through the same file.
			const db = openWriteConnection(parsed.root);
			withImmediate(db, () => registerOwner(db, identity, Date.now()));
			const queue = openProjectQueue(parsed.root, { mode: "write" });
			if (queue === null) {
				respond({ ok: false, error: { code: "WB_STORAGE_ERROR", message: "no queue" } });
				continue;
			}
			const result = queue.enqueue(
				parsed.input as unknown as Parameters<typeof queue.enqueue>[0],
			);
			respond({ ok: true, result });
		} catch (err: unknown) {
			const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "WB_STORAGE_ERROR";
			respond({ ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
		}
	}
	process.exit(0);
}

await main();
