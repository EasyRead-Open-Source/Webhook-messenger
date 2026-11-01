import { HttpError, json, readBody, parseJSON } from "./common.js";
import { verifyConnect, connectEvent, serverEvent } from "./apple.js";
export { DeliveryQueue } from "./queue.js";

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") return json({ status: "ok" });
      if (!["/webhooks/app-store-connect", "/webhooks/app-store/production", "/webhooks/app-store/sandbox"].includes(path)) {
        return json({ error: "not_found" }, 404);
      }
      if (request.method !== "POST") {
        const response = json({ error: "method_not_allowed" }, 405);
        response.headers.set("Allow", "POST");
        return response;
      }
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new HttpError(415, "unsupported_media_type");
      }
      const bytes = await readBody(request);
      let event;
      if (path === "/webhooks/app-store-connect") {
        verifyConnect(bytes, request.headers.get("x-apple-signature"), env);
        event = connectEvent(parseJSON(bytes), bytes);
      } else {
        event = await serverEvent(parseJSON(bytes), env, path.endsWith("/production") ? "production" : "sandbox");
      }
      // Destination configuration can be repaired later. Acknowledge only after
      // the authenticated event is durable, never after a background waitUntil.
      if (!env.DELIVERY_QUEUE) throw new HttpError(503, "configuration_error");
      const queue = env.DELIVERY_QUEUE.get(env.DELIVERY_QUEUE.idFromName("feishu"));
      return await queue.fetch("https://queue.internal/enqueue", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      console.error(JSON.stringify({ event: "webhook_internal_error" }));
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
