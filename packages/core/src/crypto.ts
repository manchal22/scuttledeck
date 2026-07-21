import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Ingest tokens are stored only as SHA-256 hashes; this derives the lookup key. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Verify a GitHub webhook delivery against `X-Hub-Signature-256`.
 * Must be computed over the raw request body, before any JSON parsing.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}
