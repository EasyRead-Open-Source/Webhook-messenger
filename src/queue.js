import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { json, eventSummary } from "./common.js";
import { sendToFeishu } from "./feishu.js";

const RETENTION_MS = 30 * 86400000;
const QUEUE_LIMIT = 10000;
const dueKey = (time, id) => `pending:${String(time).padStart(16, "0")}:${id}`;
const expiryKey = (time, id) => `expiry:${String(time).padStart(16, "0")}:${id}`;
const keyTime = (key) => Number(key.split(":")[1]);

export class DeliveryQueue extends DurableObject {
  async fetch(request) {
    const { id, ...event } = eventSummary(await request.json());
    const hash = createHash("sha256").update(id).digest("hex");
    return this.ctx.storage.transaction(async (storage) => {
      const existing = await storage.get(`event:${hash}`);
      if (existing && (!existing.expires || existing.expires > Date.now())) {
        // A duplicate must also repair a missing alarm, rather than acknowledge
        // a pending event that could otherwise remain stranded indefinitely.
        if ((await storage.getAlarm()) === null) {
          const nextSend = (await storage.get("nextSend")) ?? 0;
          await storage.setAlarm(existing.expires ?? Math.max(Date.now() + 1000, nextSend));
        }
        return json({ status: "duplicate" });
      }
      const count = (await storage.get("count")) ?? 0;
      if (count >= QUEUE_LIMIT) return json({ error: "queue_full" }, 503);
      const due = Date.now();
      if (existing?.expires) await storage.delete(expiryKey(existing.expires, hash));
      await storage.put({
        [`event:${hash}`]: { event, attempts: 0 },
        [dueKey(due, hash)]: hash,
        count: count + 1,
      });
      const nextSend = (await storage.get("nextSend")) ?? 0;
      const alarm = await storage.getAlarm();
      const next = Math.max(due + 1000, nextSend);
      if (alarm === null || alarm > next) await storage.setAlarm(next);
      return json({ status: "queued" }, 202);
    });
  }

  async schedule() {
    await this.ctx.storage.transaction(async (storage) => {
      const pending = await storage.list({ prefix: "pending:", limit: 1 });
      const expiry = await storage.list({ prefix: "expiry:", limit: 1 });
      const nextSend = (await storage.get("nextSend")) ?? 0;
      const nextPending = pending.size ? Math.max(keyTime(pending.keys().next().value), nextSend) : Infinity;
      const nextExpiry = expiry.size ? keyTime(expiry.keys().next().value) : Infinity;
      const next = Math.min(nextPending, nextExpiry);
      if (Number.isFinite(next)) await storage.setAlarm(Math.max(Date.now() + 1000, next));
    });
  }

  async alarm() {
    try {
      const storage = this.ctx.storage;
      // Pre-arm recovery before network I/O. Unexpected failures must not strand the queue.
      await storage.setAlarm(Date.now() + 60000);
      await storage.transaction(async (tx) => {
        const expired = await tx.list({ prefix: "expiry:", limit: 100 });
        for (const [key, hash] of expired) {
          if (keyTime(key) > Date.now()) break;
          await tx.delete([key, `event:${hash}`]);
        }
      });
      const pending = await storage.list({ prefix: "pending:", limit: 1 });
      const entry = pending.entries().next().value;
      if (entry && keyTime(entry[0]) <= Date.now() && ((await storage.get("nextSend")) ?? 0) <= Date.now()) {
        const [key, hash] = entry;
        const record = await storage.get(`event:${hash}`);
        // One delivery at a time, at most one start per second (60/minute).
        await storage.put("nextSend", Date.now() + 1000);
        let delivered = false;
        try {
          await sendToFeishu(record.event, this.env);
          delivered = true;
        } catch {
          // Never log URLs, response bodies, exception text, or Apple payloads.
          console.warn(JSON.stringify({ event: "feishu_delivery_retry", attempt: record.attempts + 1 }));
        }
        await storage.transaction(async (tx) => {
          await tx.delete(key);
          if (delivered) {
            const expires = Date.now() + RETENTION_MS;
            await tx.put({ [`event:${hash}`]: { expires }, [expiryKey(expires, hash)]: hash });
            await tx.put("count", Math.max(0, ((await tx.get("count")) ?? 1) - 1));
          } else {
            const attempts = record.attempts + 1;
            const delay = Math.min(3600000, 2000 * 2 ** Math.min(attempts, 11));
            await tx.put({
              [`event:${hash}`]: { ...record, attempts },
              [dueKey(Date.now() + delay, hash)]: hash,
            });
          }
        });
      }
      await this.schedule();
      // Remove the recovery alarm only when there is no pending work or cleanup.
      await storage.transaction(async (tx) => {
        const pending = await tx.list({ prefix: "pending:", limit: 1 });
        const expiry = await tx.list({ prefix: "expiry:", limit: 1 });
        if (!pending.size && !expiry.size) await tx.deleteAlarm();
      });
    } catch {
      console.error(JSON.stringify({ event: "delivery_queue_recovery" }));
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }
}
