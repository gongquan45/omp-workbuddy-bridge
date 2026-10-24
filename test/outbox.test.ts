/**
 * Outbox: a notification that survives its recipient being offline.
 *
 * The three properties a user notices: the same fact never wakes them twice, a
 * message that was *sent* is not treated as *received*, and an owner that goes
 * away leaves the notification waiting rather than dropping it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import {
	ackOutbox,
	claimOutbox,
	closeQueueConnection,
	enableProject,
	enqueueOutbox,
	listOutbox,
	openWriteConnection,
	outboxDeliveryId,
	registerOwner,
	retireOwner,
} from "../src/queue";
import type { OwnerIdentity } from "../src/types";
import { createFixtureRoot, removeFixtureRoot } from "./helpers/fixtures";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) {
			await removeFixtureRoot(root);
		}
	}
});

function owner(generation = "gen-1"): OwnerIdentity {
	return { sessionId: "omp-session-1", generation, processId: process.pid, instanceId: randomUUID() };
}

async function project(): Promise<string> {
	const root = await createFixtureRoot("wb-outbox-");
	roots.push(root);
	await enableProject(root);
	closeQueueConnection(root);
	closeQueueConnection(root, "read");
	return root;
}

describe("outbox delivery", () => {
	it("derives a stable id so the same fact is enqueued once", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			expect(outboxDeliveryId(requestId, "result", 2)).toBe(`${requestId}:result:2`);

			const first = enqueueOutbox(db, { requestId, kind: "result", revision: 2, owner: owner() });
			expect(first.kind).toBe("created");
			// A retried publish must not produce a second wake-up for the same fact.
			const again = enqueueOutbox(db, { requestId, kind: "result", revision: 2, owner: owner() });
			expect(again.kind).toBe("existing");
			expect(listOutbox(db, 10)).toHaveLength(1);

			// A different revision is a different fact and is queued separately.
			expect(enqueueOutbox(db, { requestId, kind: "result", revision: 3, owner: owner() }).kind).toBe("created");
			expect(listOutbox(db, 10)).toHaveLength(2);
		} finally {
			closeQueueConnection(root);
		}
	});

	it("leaves a notification for its owner and lets the same generation retry a claim", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			enqueueOutbox(db, { requestId, kind: "recovery", revision: 1, owner: owner() });

			const first = claimOutbox(db, owner(), 10);
			expect(first).toHaveLength(1);
			// Re-claiming in the same generation is allowed: a send attempt that died
			// must be retryable without inventing a new generation.
			const retry = claimOutbox(db, owner(), 10);
			expect(retry.map((row) => row.deliveryId)).toEqual(first.map((row) => row.deliveryId));

			// A different, live owner does not steal it: the notification belongs to
			// the recorded followup owner, not to whoever asks first.
			const foreign = claimOutbox(db, { ...owner("gen-2"), sessionId: "omp-other" }, 10);
			expect(foreign).toEqual([]);
		} finally {
			closeQueueConnection(root);
		}
	});

	it("treats sending as distinct from receiving", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			const { deliveryId } = enqueueOutbox(db, { requestId, kind: "result", revision: 1, owner: owner() });
			const [claimed] = claimOutbox(db, owner(), 10);
			expect(claimed?.deliveryId).toBe(deliveryId);

			// Claimed but not acknowledged: still pending, so an offline consumer keeps
			// the fact available rather than losing it to a successful send.
			let row = listOutbox(db, 10)[0]!;
			expect(row.acknowledged_at).toBeNull();

			expect(ackOutbox(db, deliveryId, owner(), Date.now())).toEqual({ kind: "acked" });
			row = listOutbox(db, 10)[0]!;
			expect(row.acknowledged_at).not.toBeNull();

			// An acknowledged row is never claimed again, and a repeat ack is a no-op.
			expect(claimOutbox(db, owner(), 10)).toEqual([]);
			expect(ackOutbox(db, deliveryId, owner(), Date.now())).toEqual({ kind: "unchanged" });
		} finally {
			closeQueueConnection(root);
		}
	});

	it("re-routes a claim left behind by a generation that retired", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			const retiring = owner("gen-old");
			enqueueOutbox(db, { requestId, kind: "result", revision: 1, owner: retiring });
			expect(claimOutbox(db, retiring, 10)).toHaveLength(1);

			// While the claiming generation is live, nobody else may take its delivery.
			registerOwner(db, { ...retiring, instanceId: "instance-old" }, Date.now());
			const successor = owner("gen-new");
			registerOwner(db, successor, Date.now());
			expect(claimOutbox(db, successor, 10)).toHaveLength(0);

			// Now the old generation retires. Its claim must become deliverable again
			// rather than stranding the notification forever.
			retireOwner(db, { ...retiring, instanceId: "instance-old" });
			const afterRetire = claimOutbox(db, successor, 10);
			expect(afterRetire).toHaveLength(1);
			expect(afterRetire[0]?.requestId).toBe(requestId);
		} finally {
			closeQueueConnection(root);
		}
	});

	it("lets a re-routed delivery be acknowledged by its new holder", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			const retiring = owner("gen-old");
			const { deliveryId } = enqueueOutbox(db, { requestId, kind: "result", revision: 1, owner: retiring });
			registerOwner(db, retiring, Date.now());
			claimOutbox(db, retiring, 10);

			// A session switch retires the old generation before the new one registers,
			// which is also why the owners table forbids two live generations for one
			// session: the successor exists only after the predecessor is gone.
			retireOwner(db, retiring);
			const successor = owner("gen-new");
			registerOwner(db, successor, Date.now());
			expect(claimOutbox(db, successor, 10)).toHaveLength(1);

			// The row's owner_generation still names the original addressee, so an
			// acknowledgement fenced on that would never succeed. It is fenced on the
			// current claimer instead, which is what makes a re-route usable.
			expect(ackOutbox(db, deliveryId, successor, Date.now())).toEqual({ kind: "acked" });
			expect(listOutbox(db, 10)[0]!.acknowledged_at).not.toBeNull();
		} finally {
			closeQueueConnection(root);
		}
	});

	it("refuses to acknowledge from a generation that does not own the delivery", async () => {
		const root = await project();
		const db = openWriteConnection(root);
		try {
			const requestId = randomUUID();
			const { deliveryId } = enqueueOutbox(db, { requestId, kind: "recovery", revision: 1, owner: owner() });

			// A retired or foreign generation cannot mark someone else's delivery as
			// received; the fact stays pending for its real owner.
			expect(ackOutbox(db, deliveryId, owner("gen-2"), Date.now())).toEqual({ kind: "unchanged" });
			expect(listOutbox(db, 10)[0]!.acknowledged_at).toBeNull();
		} finally {
			closeQueueConnection(root);
		}
	});
});
