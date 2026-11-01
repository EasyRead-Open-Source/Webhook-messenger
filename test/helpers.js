import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate, sign, createHmac } from "node:crypto";

export const connectSecret = "local-test-connect-secret-not-a-production-key";
export const baseEnv = {
  FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000",
  FEISHU_SIGNING_SECRET: "local-test-feishu-secret",
  APP_STORE_CONNECT_WEBHOOK_SECRET: connectSecret,
  APP_STORE_BUNDLE_ID: "com.example.test",
  APP_STORE_APPLE_ID: "1234567890",
  APPLE_ENABLE_ONLINE_CHECKS: "false",
};

export function connectBody(id = "connect-event-1") {
  return JSON.stringify({ data: {
    id, type: "appStoreVersionAppVersionStateUpdated", version: 1,
    attributes: { oldValue: "WAITING_FOR_REVIEW", newValue: "REJECTED", timestamp: new Date().toISOString(), email: "private@example.test" },
    relationships: { instance: { data: { type: "appStoreVersions", id: "private-resource-id" } } },
  } });
}

export function connectHeaders(body) {
  return { "content-type": "application/json", "x-apple-signature": `hmacsha256=${createHmac("sha256", connectSecret).update(body).digest("hex")}` };
}

// Generate an ephemeral, explicitly untrusted test PKI. No private keys are committed.
export function testPKI() {
  const dir = mkdtempSync(join(tmpdir(), "webhook-test-pki-"));
  const openssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  try {
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-subj", "/CN=Untrusted local test root", "-days", "3", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    for (const name of ["intermediate", "leaf"]) {
      openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=Untrusted local test ${name}`);
    }
    writeFileSync(join(dir, "intermediate.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=DER:05:00\nauthorityInfoAccess=OCSP;URI:http://ocsp.example.test\n");
    writeFileSync(join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=DER:05:00\nauthorityInfoAccess=OCSP;URI:http://ocsp.example.test\n");
    openssl("x509", "-req", "-in", "intermediate.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "intermediate.pem", "-days", "2", "-extfile", "intermediate.ext");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "intermediate.pem", "-CAkey", "intermediate.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext");
    const chain = ["leaf", "intermediate", "root"].map((name) => new X509Certificate(readFileSync(join(dir, `${name}.pem`))).raw.toString("base64"));
    const key = readFileSync(join(dir, "leaf.key"));
    return {
      roots: JSON.stringify([chain[2]]),
      jws(payload, header = {}) {
        const head = Buffer.from(JSON.stringify({ alg: "ES256", x5c: chain, ...header })).toString("base64url");
        const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const data = `${head}.${body}`;
        return `${data}.${sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function notification(pki, changes = {}) {
  const transaction = pki.jws({
    bundleId: baseEnv.APP_STORE_BUNDLE_ID, environment: "Production", productId: "premium.monthly",
    signedDate: Date.now(), expiresDate: Date.now() + 86400000,
    transactionId: "private-transaction", originalTransactionId: "private-original", appAccountToken: "private-account-token",
  });
  const renewal = pki.jws({ environment: "Production", productId: "premium.monthly", autoRenewStatus: 1, signedDate: Date.now() });
  return {
    notificationType: "DID_RENEW", notificationUUID: "server-event-1", version: "2.0", signedDate: Date.now(),
    data: { bundleId: baseEnv.APP_STORE_BUNDLE_ID, appAppleId: Number(baseEnv.APP_STORE_APPLE_ID), environment: "Production", signedTransactionInfo: transaction, signedRenewalInfo: renewal },
    ...changes,
  };
}
