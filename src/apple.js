import { createHmac, timingSafeEqual, createHash, X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";
import { HttpError, required, object, identifier, optionalText } from "./common.js";

export function verifyConnect(bytes, signature, env) {
  const secret = required(env, "APP_STORE_CONNECT_WEBHOOK_SECRET");
  if (!/^hmacsha256=[a-fA-F0-9]{64}$/.test(signature ?? "")) {
    throw new HttpError(401, "invalid_signature");
  }
  const expected = createHmac("sha256", secret).update(bytes).digest();
  const actual = Buffer.from(signature.slice(11), "hex");
  if (!timingSafeEqual(expected, actual)) throw new HttpError(401, "invalid_signature");
}

export function connectEvent(body, bytes) {
  const data = body.data;
  if (!object(data) || !identifier(data.type)) throw new HttpError(400, "invalid_event");
  const attributes = object(data.attributes) ? data.attributes : {};
  const state = attributes.newValue ?? attributes.newExternalBuildState ?? attributes.newInternalBuildState ?? attributes.newState;
  const previousState = attributes.oldValue ?? attributes.oldExternalBuildState ?? attributes.oldInternalBuildState ?? attributes.oldState;
  // Preserve authenticated events with missing IDs or new optional field shapes.
  const id = identifier(data.id) ? data.id : createHash("sha256").update(bytes).digest("hex");
  return {
    id: `connect:${id}`,
    source: "App Store Connect",
    type: data.type,
    state: optionalText(state),
    previousState: optionalText(previousState),
    date: optionalText(attributes.timestamp),
  };
}

// Keep only one configuration in memory; never cache decoded user payloads.
let cached;
let library;
async function appleLibrary() {
  // Apple's jsrsasign dependency initializes a PRNG. Workers only permits this
  // inside a request context, so the package must not execute at module startup.
  library ??= await import("@apple/app-store-server-library");
  return library;
}

async function verifierFor(env, environment) {
  const { SignedDataVerifier, Environment } = await appleLibrary();
  const bundleId = required(env, "APP_STORE_BUNDLE_ID");
  const appIdText = required(env, "APP_STORE_APPLE_ID");
  const rootText = required(env, "APPLE_ROOT_CERTIFICATES");
  const online = env.APPLE_ENABLE_ONLINE_CHECKS ?? "true";
  if (!/^\d+$/.test(appIdText) || !Number.isSafeInteger(Number(appIdText)) || Number(appIdText) <= 0 ||
      !["true", "false"].includes(online)) throw new HttpError(503, "configuration_error");
  const key = createHash("sha256").update(JSON.stringify([bundleId, appIdText, rootText, online])).digest("hex");
  if (cached?.key !== key) {
    try {
      const entries = JSON.parse(rootText);
      if (!Array.isArray(entries) || !entries.length || entries.length > 5 ||
          entries.some((root) => typeof root !== "string" || root.length > 10000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(root))) throw new Error();
      const roots = entries.map((root) => Buffer.from(root, "base64"));
      for (const root of roots) {
        const cert = new X509Certificate(root);
        if (!cert.ca || !cert.verify(cert.publicKey)) throw new Error();
      }
      cached = {
        key,
        production: new SignedDataVerifier(roots, online === "true", Environment.PRODUCTION, bundleId, Number(appIdText)),
        sandbox: new SignedDataVerifier(roots, online === "true", Environment.SANDBOX, bundleId, Number(appIdText)),
      };
    } catch {
      throw new HttpError(503, "configuration_error");
    }
  }
  return cached[environment];
}

function requireES256(value) {
  try {
    if (typeof value !== "string" || value.length > 100000) throw new Error();
    const parts = value.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!object(header) || header.alg !== "ES256" || header.b64 === false || header.crit !== undefined) throw new Error();
  } catch {
    throw new HttpError(401, "invalid_signature");
  }
}

export async function serverEvent(body, env, environment) {
  if (typeof body.signedPayload !== "string" || body.signedPayload.length > 100000) {
    throw new HttpError(400, "invalid_event");
  }
  const verifier = await verifierFor(env, environment);
  const { VerificationStatus } = await appleLibrary();
  try {
    requireES256(body.signedPayload);
    const notification = await verifier.verifyAndDecodeNotification(body.signedPayload);
    if (notification.version !== "2.0" || !identifier(notification.notificationUUID) ||
        !identifier(notification.notificationType) || !Number.isSafeInteger(notification.signedDate) ||
        notification.signedDate < Date.now() - 30 * 86400000 || notification.signedDate > Date.now() + 60000) {
      throw new HttpError(400, "invalid_event");
    }
    // The verified outer envelope authenticates the event. Optional enrichment
    // must not discard it when an older nested certificate or OCSP check fails.
    const data = notification.data;
    let detailsUnavailable = false;
    const detail = async (signed, verify) => {
      if (signed === undefined) return undefined;
      let timeout;
      try {
        requireES256(signed);
        // Optional OCSP work must not hold up durable receipt of the event.
        return await Promise.race([
          verify(signed),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("details_timeout")), 3000); }),
        ]);
      } catch {
        detailsUnavailable = true;
        return undefined;
      } finally {
        clearTimeout(timeout);
      }
    };
    const [transaction, renewal] = await Promise.all([
      detail(data?.signedTransactionInfo, (signed) => verifier.verifyAndDecodeTransaction(signed)),
      detail(data?.signedRenewalInfo, (signed) => verifier.verifyAndDecodeRenewalInfo(signed)),
    ]);
    return {
      id: `server:${environment}:${notification.notificationUUID}`,
      source: "App Store Server Notifications V2",
      type: notification.notificationType,
      subtype: optionalText(notification.subtype),
      environment: environment === "production" ? "Production" : "Sandbox",
      date: new Date(notification.signedDate).toISOString(),
      product: optionalText(transaction?.productId ?? renewal?.productId),
      expiresDate: transaction?.expiresDate,
      autoRenewStatus: renewal?.autoRenewStatus,
      detailsUnavailable,
      // No account tokens, order IDs, transaction IDs, receipts, or raw JWS.
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
      throw new HttpError(503, "verification_unavailable");
    }
    throw new HttpError(401, "invalid_signature");
  }
}
