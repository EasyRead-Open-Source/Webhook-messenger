import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

const files = process.argv.slice(2);
if (!files.length || files.length > 5) {
  console.error("Usage: node scripts/apple-roots.mjs <AppleRootCA.cer> [AppleRootCA-G2.cer] [AppleRootCA-G3.cer]");
  process.exit(1);
}
try {
  const roots = files.map((file) => {
    const certificate = new X509Certificate(readFileSync(file));
    if (!certificate.ca || !certificate.verify(certificate.publicKey) || !/Apple Root CA/.test(certificate.subject)) {
      throw new Error("Unexpected certificate");
    }
    return certificate.raw.toString("base64");
  });
  console.log(JSON.stringify(roots));
} catch {
  console.error("Unable to read Apple root certificates. Obtain the original certificates directly from Apple PKI.");
  process.exit(1);
}
