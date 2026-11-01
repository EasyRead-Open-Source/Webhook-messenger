import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { baseEnv, connectBody, connectHeaders, testPKI, notification } from "./helpers.js";

// Test-only controls are appended in memory. They never enter the shipped bundle.
const controls = `
function storageFault(storage, shouldFail) {
  const wrap = (target) => new Proxy(target, {
    get(target, property) {
      if (property === "transaction") return (callback) => target.transaction((tx) => callback(wrap(tx)));
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (shouldFail(property, args)) throw new Error("Injected storage failure");
        return value.apply(target, args);
      };
    }
  });
  return wrap(storage);
}

export class TestDeliveryQueue extends DeliveryQueue {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/state") {
      return Response.json({ entries: [...await this.ctx.storage.list()], alarm: await this.ctx.storage.getAlarm() });
    }
    if (path === "/__test/fail-enqueue") {
      this.failEnqueue = true;
      return new Response("ok");
    }
    if (path === "/__test/no-alarm") {
      await this.ctx.storage.deleteAlarm();
      return new Response("ok");
    }
    if (path === "/__test/tick" || path === "/__test/fail-after-send") {
      await this.ctx.storage.deleteAlarm();
      const pending = await this.ctx.storage.list({ prefix: "pending:" });
      const first = pending.entries().next().value;
      if (first) {
        await this.ctx.storage.delete(first[0]);
        await this.ctx.storage.put("pending:0000000000000000:" + first[1], first[1]);
      }
      await this.ctx.storage.put("nextSend", 0);
      if (path === "/__test/fail-after-send") {
        let armed = true;
        const storage = storageFault(this.ctx.storage, (method, args) => {
          if (armed && method === "delete" && typeof args[0] === "string" && args[0].startsWith("pending:")) {
            armed = false;
            return true;
          }
          return false;
        });
        await DeliveryQueue.prototype.alarm.call({ ctx: { storage }, env: this.env, schedule: this.schedule.bind(this) });
      } else {
        await this.alarm();
      }
      return new Response("ok");
    }
    if (path === "/__test/alarm") {
      await this.alarm();
      return new Response("ok");
    }
    if (path === "/__test/capacity") {
      await this.ctx.storage.put("count", 10000);
      return new Response("ok");
    }
    if (path === "/__test/expire") {
      for (const [key, hash] of await this.ctx.storage.list({ prefix: "expiry:" })) {
        await this.ctx.storage.delete(key);
        await this.ctx.storage.put("expiry:0000000000000000:" + hash, hash);
      }
      await this.alarm();
      return new Response("ok");
    }
    if (this.failEnqueue) {
      this.failEnqueue = false;
      const storage = storageFault(this.ctx.storage, (method) => method === "setAlarm");
      return DeliveryQueue.prototype.fetch.call({ ctx: { storage } }, request);
    }
    return super.fetch(request);
  }
}
`;

async function runtime(t, extra = {}) {
  const sent = [];
  const logs = [];
  let result = { code: 0 };
  const options = {
    name: "test-worker", modules: true,
    script: readFileSync(new URL("../dist/index.js", import.meta.url), "utf8") + controls,
    compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"],
    bindings: { ...baseEnv, ...extra },
    handleStructuredLogs: (entry) => logs.push(entry),
    durableObjects: { DELIVERY_QUEUE: { className: "TestDeliveryQueue", useSQLite: true } },
    cf: false,
    outboundService: async (request) => {
      if (new URL(request.url).hostname === "ocsp.example.test") return new Response(null, { status: 503 });
      assert.equal(new URL(request.url).hostname, "open.feishu.cn");
      sent.push(await request.json());
      return Response.json(result);
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(() => mf.dispose());
  await mf.ready;
  let namespace = await mf.getDurableObjectNamespace("DELIVERY_QUEUE");
  let stub = namespace.get(namespace.idFromName("feishu"));
  return {
    mf, sent, logs, get stub() { return stub; }, fail: () => { result = { code: 9499, msg: "private upstream error" }; },
    recover: () => { result = { code: 0 }; },
    state: async () => (await stub.fetch("https://local/__test/state")).json(),
    tick: async () => { const response = await stub.fetch("https://local/__test/tick"); assert.equal(response.status, 200); },
    updateEnv: async (changes) => {
      Object.assign(options.bindings, changes);
      await mf.setOptions(convertV4MiniflareOptions(options));
      await mf.ready;
      namespace = await mf.getDurableObjectNamespace("DELIVERY_QUEUE");
      stub = namespace.get(namespace.idFromName("feishu"));
    },
  };
}

const post = (rt, path, body, headers = { "content-type": "application/json" }) =>
  rt.mf.dispatchFetch(`https://worker.test${path}`, { method: "POST", headers, body });

test("workerd: routes, input limits and Apple authentication fail closed", async (t) => {
  const rt = await runtime(t);
  assert.equal((await rt.mf.dispatchFetch("https://worker.test/health")).status, 200);
  assert.equal((await rt.mf.dispatchFetch("https://worker.test/nope")).status, 404);
  assert.equal((await rt.mf.dispatchFetch("https://worker.test/webhooks/app-store-connect")).status, 405);
  const body = connectBody();
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, {})).status, 415);
  assert.equal((await post(rt, "/webhooks/app-store-connect", body)).status, 401);
  assert.equal((await post(rt, "/webhooks/app-store-connect", "x".repeat(131073))).status, 413);
  assert.equal((await post(rt, "/webhooks/app-store-connect", "{", connectHeaders("{"))).status, 400);
  const broken = await runtime(t, { APP_STORE_CONNECT_WEBHOOK_SECRET: "" });
  const response = await post(broken, "/webhooks/app-store-connect", body, connectHeaders(body));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"configuration_error"}');
  assert.equal(rt.sent.length, 0);
});

test("workerd: concurrent duplicates enqueue once, survive retries and discard private fields", async (t) => {
  const rt = await runtime(t);
  const body = connectBody();
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))));
  assert.equal(responses.filter((r) => r.status === 202).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 7);
  let state = await rt.state();
  assert.equal(state.entries.find(([key]) => key === "count")[1], 1);
  assert.ok(!JSON.stringify(state).includes("private"));
  rt.fail();
  await rt.tick();
  state = await rt.state();
  assert.equal(rt.sent.length, 1);
  assert.equal(state.entries.find(([key]) => key.startsWith("event:"))[1].attempts, 1);
  assert.ok(state.alarm > Date.now());
  rt.recover();
  await rt.tick();
  state = await rt.state();
  assert.equal(rt.sent.length, 2);
  assert.equal(state.entries.find(([key]) => key === "count")[1], 0);
  assert.deepEqual(Object.keys(state.entries.find(([key]) => key.startsWith("event:"))[1]), ["expires"]);
  assert.ok(!JSON.stringify(rt.sent).includes("private"));
  assert.match(JSON.stringify(rt.logs), /feishu_delivery_retry/);
  assert.ok(!JSON.stringify(rt.logs).includes("private"));
  assert.ok(!JSON.stringify(rt.logs).includes(baseEnv.FEISHU_SIGNING_SECRET));
  assert.ok(!JSON.stringify(rt.logs).includes(baseEnv.FEISHU_WEBHOOK_URL));
  assert.ok(rt.sent[1].sign);
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 200);
  await rt.stub.fetch("https://local/__test/expire");
  state = await rt.state();
  assert.ok(!state.entries.some(([key]) => key.startsWith("event:")));
  await rt.stub.fetch("https://local/__test/capacity");
  const newBody = connectBody("another-event");
  assert.equal((await post(rt, "/webhooks/app-store-connect", newBody, connectHeaders(newBody))).status, 503);
});

test("workerd: actual V2 certificate verification and nested signatures run in Workers", async (t) => {
  const pki = testPKI();
  const rt = await runtime(t, { APPLE_ROOT_CERTIFICATES: pki.roots });
  const payload = notification(pki);
  const body = JSON.stringify({ signedPayload: pki.jws(payload) });
  const accepted = await post(rt, "/webhooks/app-store/production", body);
  assert.equal(accepted.status, 202, await accepted.text());
  assert.equal((await post(rt, "/webhooks/app-store/sandbox", body)).status, 401);
  const parts = pki.jws(payload).split(".");
  const tampered = JSON.stringify({ signedPayload: `${parts[0]}.${Buffer.from(JSON.stringify({ ...payload, notificationType: "REFUND" })).toString("base64url")}.${parts[2]}` });
  assert.equal((await post(rt, "/webhooks/app-store/production", tampered)).status, 401);
  await rt.tick();
  assert.equal(rt.sent.length, 1);
  const card = JSON.stringify(rt.sent[0]);
  assert.match(card, /premium.monthly/);
  assert.ok(!card.includes("private"));
  assert.ok(!JSON.stringify(await rt.state()).includes("signedPayload"));
  const sandbox = notification(pki, {
    notificationUUID: "sandbox-event", notificationType: "TEST",
    data: { bundleId: baseEnv.APP_STORE_BUNDLE_ID, environment: "Sandbox" },
  });
  assert.equal((await post(rt, "/webhooks/app-store/sandbox", JSON.stringify({ signedPayload: pki.jws(sandbox) }))).status, 202);
});

test("workerd: online revocation outages fail closed with a retryable status", async (t) => {
  const pki = testPKI();
  const rt = await runtime(t, { APPLE_ROOT_CERTIFICATES: pki.roots, APPLE_ENABLE_ONLINE_CHECKS: "true" });
  const response = await post(rt, "/webhooks/app-store/production", JSON.stringify({ signedPayload: pki.jws(notification(pki)) }));
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error, "verification_unavailable");
  assert.equal(rt.sent.length, 0);
  assert.ok(!(await rt.state()).entries.some(([key]) => key.startsWith("event:")));
});

test("workerd: the global delivery interval survives separate requests", async (t) => {
  const rt = await runtime(t);
  for (const id of ["rate-1", "rate-2"]) {
    const body = connectBody(id);
    assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 202);
  }
  await rt.tick();
  assert.equal(rt.sent.length, 1);
  await rt.stub.fetch("https://local/__test/alarm");
  assert.equal(rt.sent.length, 1);
  assert.equal((await rt.state()).entries.find(([key]) => key === "count")[1], 1);
});

test("workerd: destination misconfiguration retains events across a runtime restart", async (t) => {
  const rt = await runtime(t, { FEISHU_SIGNING_SECRET: "" });
  const body = connectBody("destination-outage");
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 202);
  await rt.tick();
  assert.equal(rt.sent.length, 0); // Never send an unsigned request.
  assert.equal((await rt.state()).entries.find(([key]) => key === "count")[1], 1);
  await rt.updateEnv({ FEISHU_SIGNING_SECRET: baseEnv.FEISHU_SIGNING_SECRET, APP_DISPLAY_NAME: "Recovered runtime" });
  assert.equal((await rt.state()).entries.find(([key]) => key === "count")[1], 1);
  await rt.tick();
  assert.equal(rt.sent.length, 1);
  assert.ok(rt.sent[0].sign);
  assert.match(rt.sent[0].card.header.title.content, /Recovered runtime/);
  assert.equal((await rt.state()).entries.find(([key]) => key === "count")[1], 0);
});

test("workerd: a duplicate repairs a missing pending alarm", async (t) => {
  const rt = await runtime(t);
  const body = connectBody("alarm-repair");
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 202);
  await rt.stub.fetch("https://local/__test/no-alarm");
  assert.equal((await rt.state()).alarm, null);
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 200);
  assert.ok((await rt.state()).alarm > Date.now());
  await rt.tick();
  assert.equal(rt.sent.length, 1);
});

test("workerd: enqueue and alarm commit together before an Apple acknowledgement", async (t) => {
  const rt = await runtime(t);
  const body = connectBody("admission-failure");
  await rt.stub.fetch("https://local/__test/fail-enqueue");
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 503);
  const state = await rt.state();
  assert.equal(state.alarm, null);
  assert.ok(!state.entries.some(([key]) => key.startsWith("event:") || key.startsWith("pending:")));
  assert.equal(rt.sent.length, 0);
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 202);
  await rt.tick();
  assert.equal(rt.sent.length, 1);
});

test("workerd: a failed success-write preserves the notification for retry", async (t) => {
  const rt = await runtime(t);
  const body = connectBody("completion-failure");
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 202);
  await rt.stub.fetch("https://local/__test/fail-after-send");
  assert.equal(rt.sent.length, 1);
  const state = await rt.state();
  assert.equal(state.entries.find(([key]) => key === "count")[1], 1);
  assert.ok(state.entries.some(([key]) => key.startsWith("pending:")));
  assert.ok(state.alarm > Date.now());
  await rt.updateEnv({ APP_DISPLAY_NAME: "After completion failure" });
  await rt.tick();
  assert.equal(rt.sent.length, 2); // At-least-once delivery can duplicate, but does not discard the event.
  assert.equal((await rt.state()).entries.find(([key]) => key === "count")[1], 0);
  assert.equal((await post(rt, "/webhooks/app-store-connect", body, connectHeaders(body))).status, 200);
});

test("workerd: invalid optional V2 details cannot discard a verified event or leak unverified fields", async (t) => {
  const pki = testPKI();
  const rt = await runtime(t, { APPLE_ROOT_CERTIFICATES: pki.roots });
  const payload = notification(pki);
  const invalid = pki.jws({ productId: "unverified-private-product" }, { alg: "HS256" });
  const data = { ...payload.data, signedTransactionInfo: invalid, signedRenewalInfo: invalid };
  const body = JSON.stringify({ signedPayload: pki.jws({ ...payload, data }) });
  assert.equal((await post(rt, "/webhooks/app-store/production", body)).status, 202);
  const pending = JSON.stringify(await rt.state());
  assert.ok(!pending.includes("unverified-private-product"));
  assert.ok(!pending.includes("signedPayload"));
  await rt.tick();
  assert.equal(rt.sent.length, 1);
  assert.match(JSON.stringify(rt.sent[0]), /Some optional details could not be verified/);
  assert.ok(!JSON.stringify(rt.sent).includes("unverified-private-product"));
  assert.ok(!JSON.stringify(rt.logs).includes("unverified-private-product"));
});
