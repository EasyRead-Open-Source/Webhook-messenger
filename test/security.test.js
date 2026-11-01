import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyConnect, connectEvent, serverEvent } from "../src/apple.js";
import { buildCard, feishuConfig, signMessage, sendToFeishu } from "../src/feishu.js";
import { parseJSON, readBody, eventSummary } from "../src/common.js";
import { baseEnv, connectBody, connectHeaders, testPKI, notification } from "./helpers.js";

test("Connect authenticates the exact original bytes and rejects tampering", () => {
  const raw = connectBody();
  const signature = connectHeaders(raw)["x-apple-signature"];
  assert.doesNotThrow(() => verifyConnect(Buffer.from(raw), signature, baseEnv));
  for (const header of [null, "", "sha256=bad", `hmacsha256=${"0".repeat(64)}`, `hmacsha256=${"z".repeat(64)}`]) {
    assert.throws(() => verifyConnect(Buffer.from(raw), header, baseEnv), { status: 401 });
  }
  assert.throws(() => verifyConnect(Buffer.from(`${raw} `), signature, baseEnv), { status: 401 });
});

test("Apple's documented HMAC test vector matches", () => {
  const secret = "This is my secret";
  const digest = createHmac("sha256", secret).update("Hello, World!").digest("hex");
  assert.equal(digest, "7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657");
});

test("Connect projects only allowed fields and handles ID-less pings", () => {
  const raw = Buffer.from(connectBody());
  const event = connectEvent(parseJSON(raw), raw);
  assert.equal(event.state, "REJECTED");
  assert.ok(!JSON.stringify(event).includes("private"));
  const ping = { data: { type: "webhookPings" } };
  assert.match(connectEvent(ping, Buffer.from(JSON.stringify(ping))).id, /^connect:[a-f0-9]{64}$/);
  const future = connectEvent({ data: { type: "futureEvent", attributes: { newValue: { email: "secret" } } } }, raw);
  assert.match(future.id, /^connect:[a-f0-9]{64}$/);
  assert.equal(future.state, undefined);
  assert.ok(!JSON.stringify(future).includes("secret"));
});

test("reject unsafe destination URLs and malformed mention configuration", () => {
  for (const url of ["http://open.feishu.cn/open-apis/bot/v2/hook/0000000000000000", "https://evil.test/hook", `${baseEnv.FEISHU_WEBHOOK_URL}?secret=leak`, baseEnv.FEISHU_WEBHOOK_URL.replace("open.feishu.cn", "open.feishu.cn.evil.test")]) {
    assert.throws(() => feishuConfig({ ...baseEnv, FEISHU_WEBHOOK_URL: url }), { status: 503 });
  }
  assert.throws(() => feishuConfig({ ...baseEnv, FEISHU_MENTION_USER_IDS: '["all><at id=evil"]' }), { status: 503 });
  assert.throws(() => feishuConfig({ ...baseEnv, FEISHU_SIGNING_SECRET: "" }), { status: 503 });
});

test("Feishu signing uses an empty message and seconds", () => {
  const signed = signMessage({ msg_type: "interactive" }, "secret", 1599360473000);
  assert.equal(signed.timestamp, "1599360473");
  assert.equal(signed.sign, createHmac("sha256", "1599360473\nsecret").digest("base64"));
});

test("cards use plain data fields, severity, keyword, a safe link and opt-in mentions", () => {
  const event = { source: "App Store", type: "REFUND", product: "<at id=all></at>", transactionId: "secret" };
  const env = { ...baseEnv, FEISHU_MESSAGE_KEYWORD: "Alert", FEISHU_MENTION_USER_IDS: '["ou_test"]', FEISHU_MENTION_EVENTS: '["REFUND"]' };
  const card = buildCard(event, env);
  assert.equal(card.card.header.template, "red");
  assert.match(card.card.header.title.content, /Alert/);
  assert.equal(card.card.elements[0].fields.find((field) => field.text.content.includes("<at")).text.tag, "plain_text");
  assert.ok(JSON.stringify(card).includes("<at id=ou_test>"));
  assert.ok(!JSON.stringify(card).includes('"secret"'));
  assert.ok(!JSON.stringify(buildCard({ ...event, type: "TEST" }, env)).includes("ou_test"));
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 20000);
});

test("Feishu HTTP success is insufficient: enforce business status and reject redirects", async () => {
  let options;
  await sendToFeishu({ type: "TEST" }, baseEnv, async (_url, init) => {
    options = init;
    return Response.json({ code: 0 });
  });
  assert.equal(options.redirect, "manual");
  assert.ok(JSON.parse(options.body).sign);
  for (const result of [{ code: 19021 }, { code: 9499 }, {}, { code: 19024, StatusCode: 0 }]) {
    await assert.rejects(sendToFeishu({ type: "TEST" }, baseEnv, async () => Response.json(result)));
  }
  await assert.rejects(sendToFeishu({ type: "TEST" }, baseEnv, async () => new Response("private", { status: 429 })));
  await assert.rejects(sendToFeishu({ type: "TEST" }, baseEnv, async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })));
});

test("streamed bodies are size-limited without Content-Length", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close(); } });
  await assert.rejects(readBody(new Request("https://local.test", { method: "POST", body: stream, duplex: "half" }), 10), { status: 413 });
  assert.throws(() => parseJSON(Buffer.from("[]")), { status: 400 });
});

test("V2 verifies a real certificate chain and nested JWS, identity and environments", async () => {
  const pki = testPKI();
  const env = { ...baseEnv, APPLE_ROOT_CERTIFICATES: pki.roots };
  const payload = notification(pki);
  const body = { signedPayload: pki.jws(payload) };
  const event = await serverEvent(body, env, "production");
  assert.equal(event.type, "DID_RENEW");
  assert.equal(event.product, "premium.monthly");
  assert.equal(event.autoRenewStatus, 1);
  assert.ok(!JSON.stringify(event).includes("private"));
  await assert.rejects(serverEvent(body, env, "sandbox"), { status: 401 });
  await assert.rejects(serverEvent(body, { ...env, APP_STORE_BUNDLE_ID: "com.other.app" }, "production"), { status: 401 });
  await assert.rejects(serverEvent(body, { ...env, APP_STORE_APPLE_ID: "42" }, "production"), { status: 401 });
  await assert.rejects(serverEvent({ signedPayload: pki.jws(payload, { alg: "none" }) }, env, "production"), { status: 401 });
  const invalidNested = { ...payload, data: { ...payload.data, signedTransactionInfo: "invalid.jws.value" } };
  const partial = await serverEvent({ signedPayload: pki.jws(invalidNested) }, env, "production");
  assert.equal(partial.detailsUnavailable, true);
  assert.equal(partial.expiresDate, undefined);
  const old = { ...payload, signedDate: Date.now() - 31 * 86400000 };
  await assert.rejects(serverEvent({ signedPayload: pki.jws(old) }, env, "production"), { status: 401 });
  const otherPKI = testPKI();
  await assert.rejects(serverEvent(body, { ...env, APPLE_ROOT_CERTIFICATES: otherPKI.roots }, "production"), { status: 401 });
  await assert.rejects(serverEvent(body, { ...env, APPLE_ROOT_CERTIFICATES: "[]" }, "production"), { status: 503 });
});

test("only verified nested fields are displayed, without dropping an authentic outer event", async () => {
  const pki = testPKI();
  const env = { ...baseEnv, APPLE_ROOT_CERTIFICATES: pki.roots };
  const payload = notification(pki);
  for (const signed of [
    "invalid.jws.value",
    pki.jws({ productId: "unverified-private-product" }, { alg: "HS256" }),
    pki.jws({ bundleId: "com.other.app", environment: "Production", productId: "unverified-private-product" }),
    pki.jws({ bundleId: baseEnv.APP_STORE_BUNDLE_ID, environment: "Production", productId: "unverified-private-product", signedDate: Date.now() - 10 * 86400000 }),
  ]) {
    const data = { ...payload.data, signedTransactionInfo: signed, signedRenewalInfo: "invalid.jws.value" };
    const event = await serverEvent({ signedPayload: pki.jws({ ...payload, data }) }, env, "production");
    assert.equal(event.type, "DID_RENEW");
    assert.equal(event.detailsUnavailable, true);
    assert.equal(event.product, undefined);
    assert.ok(!JSON.stringify(buildCard(event, env)).includes("unverified-private-product"));
  }
});

test("unsupported critical JWS headers and corrupt signatures cannot authenticate an event", async () => {
  const pki = testPKI();
  const env = { ...baseEnv, APPLE_ROOT_CERTIFICATES: pki.roots };
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { crit: ["unknown"] }, { b64: false }]) {
    await assert.rejects(serverEvent({ signedPayload: pki.jws(notification(pki), header) }, env, "production"), { status: 401 });
  }
  const jws = pki.jws(notification(pki));
  const parts = jws.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  await assert.rejects(serverEvent({ signedPayload: `${parts[0]}.${parts[1]}.${signature.toString("base64url")}` }, env, "production"), { status: 401 });
});

test("storage projection drops unknown and structured fields", () => {
  const summary = eventSummary({ id: "event", type: "TEST", product: "p".repeat(1000), date: { email: "private" }, email: "private", signedPayload: "private", appAccountToken: "private" });
  assert.equal(summary.product.length, 240);
  assert.equal(summary.date, undefined);
  assert.ok(!JSON.stringify(summary).includes("private"));
  assert.throws(() => eventSummary({ id: "event", type: {} }), { status: 400 });
});

test("slow optional verification cannot block receipt of an authentic event", async (t) => {
  const { SignedDataVerifier } = await import("@apple/app-store-server-library");
  const pki = testPKI();
  let started;
  const called = new Promise((resolve) => { started = resolve; });
  t.mock.method(SignedDataVerifier.prototype, "verifyAndDecodeTransaction", () => {
    started();
    return new Promise(() => {});
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = serverEvent({ signedPayload: pki.jws(notification(pki)) }, { ...baseEnv, APPLE_ROOT_CERTIFICATES: pki.roots }, "production");
  await called;
  t.mock.timers.tick(3001);
  const event = await result;
  assert.equal(event.type, "DID_RENEW");
  assert.equal(event.detailsUnavailable, true);
  assert.equal(event.expiresDate, undefined);
});
