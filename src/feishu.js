import { createHmac } from "node:crypto";
import { HttpError, required, stringList, readBody, parseJSON } from "./common.js";

export function feishuConfig(env) {
  let url;
  try { url = new URL(required(env, "FEISHU_WEBHOOK_URL")); } catch { throw new HttpError(503, "configuration_error"); }
  if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{16,100}$/.test(url.pathname)) {
    throw new HttpError(503, "configuration_error");
  }
  const secret = required(env, "FEISHU_SIGNING_SECRET");
  const users = stringList(env.FEISHU_MENTION_USER_IDS);
  if (users.some((id) => id !== "all" && !/^ou_[a-zA-Z0-9]{1,100}$/.test(id))) {
    throw new HttpError(503, "configuration_error");
  }
  const events = stringList(env.FEISHU_MENTION_EVENTS);
  const keyword = env.FEISHU_MESSAGE_KEYWORD ?? "App Store";
  const name = env.APP_DISPLAY_NAME ?? "App Store";
  if (!keyword.trim() || keyword.length > 100 || name.length > 100) throw new HttpError(503, "configuration_error");
  return { url: url.href, secret, users, events, keyword, name };
}

function text(value, max = 240) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function date(value) {
  if (value === undefined || value === null) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

export function eventColor(event) {
  const signal = `${event.type} ${event.state ?? ""} ${event.subtype ?? ""}`;
  if (/REJECTED|REFUND|REVOKE|FAIL|EXPIRED|INVALID|REMOVED/.test(signal)) return "red";
  if (/GRACE|BILLING|PENDING|WAITING|REVIEW|CONSENT/.test(signal)) return "orange";
  if (/DID_RENEW|SUBSCRIBED|ACCEPTED|READY_FOR_SALE|READY_FOR_DISTRIBUTION|COMPLETE|APPROVED/.test(signal)) return "green";
  return "blue";
}

export function buildCard(event, env) {
  const config = feishuConfig(env);
  const fields = [
    ["Source", event.source], ["Event", event.type], ["Environment", event.environment],
    ["Previous state", event.previousState], ["Current state", event.state],
    ["Subtype", event.subtype], ["Product", event.product], ["Event time (UTC)", date(event.date)],
    ["Expires (UTC)", date(event.expiresDate)],
    ["Auto-renew", event.autoRenewStatus === 1 ? "Enabled" : event.autoRenewStatus === 0 ? "Disabled" : undefined],
    ["Details", event.detailsUnavailable ? "Some optional details could not be verified" : undefined],
  ].filter(([, value]) => text(value)).map(([label, value]) => ({
    is_short: true, text: { tag: "plain_text", content: `${label}\n${text(value)}` },
  }));
  const elements = [{ tag: "div", fields }];
  if (config.events.some((name) => [event.type, event.state, event.subtype].includes(name)) && config.users.length) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: config.users.map((id) => `<at id=${id}></at>`).join(" ") } });
  }
  const appId = env.APP_STORE_APPLE_ID;
  const url = /^\d+$/.test(appId ?? "")
    ? `https://appstoreconnect.apple.com/apps/${appId}` : "https://appstoreconnect.apple.com/apps";
  elements.push({ tag: "action", actions: [
    { tag: "button", type: "primary", text: { tag: "plain_text", content: "Open App Store Connect" }, url },
  ] });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: "Verified Apple notification · Sensitive user fields omitted" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: false },
      header: { template: eventColor(event), title: { tag: "plain_text", content: `${config.keyword} · ${config.name}` } },
      elements,
    },
  };
}

export function signMessage(message, secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  // Feishu uses timestamp + newline + secret as the HMAC key and an EMPTY message.
  const sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  return { ...message, timestamp, sign };
}

export async function sendToFeishu(event, env, fetcher = fetch) {
  const config = feishuConfig(env);
  const body = JSON.stringify(signMessage(buildCard(event, env), config.secret));
  if (new TextEncoder().encode(body).byteLength > 20000) throw new Error("message_too_large");
  const response = await fetcher(config.url, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json" }, body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("delivery_failed");
  }
  // HTTP 200 may still contain a bot signature, keyword, or rate-limit error.
  const result = parseJSON(await readBody(response, 16384));
  if (result.code !== 0 && !(result.code === undefined && result.StatusCode === 0)) {
    throw new Error("delivery_failed");
  }
}
