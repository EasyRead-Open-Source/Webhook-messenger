export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function required(env, name) {
  if (typeof env[name] !== "string" || !env[name].trim()) {
    throw new HttpError(503, "configuration_error");
  }
  return env[name];
}

export function stringList(value, fallback = []) {
  if (value === undefined) return fallback;
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items) || items.length > 50 ||
        items.some((item) => typeof item !== "string" || item.length > 200)) throw new Error();
    return items;
  } catch {
    throw new HttpError(503, "configuration_error");
  }
}

export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Apply a streaming byte limit even when Content-Length is absent or forged.
export async function readBody(request, maxBytes = 128 * 1024) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new HttpError(413, "payload_too_large");
  }
  if (!request.body) throw new HttpError(400, "invalid_body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new HttpError(408, "request_timeout");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function parseJSON(bytes) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function identifier(value, max = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[a-zA-Z0-9._:-]+$/.test(value);
}

export function optionalText(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) : undefined;
}

// Reapply the allowlist at the storage boundary, even for internal callers.
export function eventSummary(event) {
  if (!object(event) || !identifier(event.id, 300) || !identifier(event.type)) {
    throw new HttpError(400, "invalid_event");
  }
  const summary = { id: event.id, type: event.type };
  for (const field of ["source", "state", "previousState", "date", "subtype", "environment", "product"]) {
    const value = optionalText(event[field]);
    if (value !== undefined) summary[field] = value;
  }
  if (Number.isSafeInteger(event.expiresDate)) summary.expiresDate = event.expiresDate;
  if (event.autoRenewStatus === 0 || event.autoRenewStatus === 1) summary.autoRenewStatus = event.autoRenewStatus;
  if (event.detailsUnavailable === true) summary.detailsUnavailable = true;
  return summary;
}
