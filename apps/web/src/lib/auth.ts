import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * Session auth: a single shared password (DASHBOARD_PASSWORD) gates the
 * dashboard. Successful login sets an httpOnly cookie `sd_session` of the
 * form `<expiryMs>.<hmacSha256(password, "scuttledeck-session:"+expiryMs)>`.
 * The middleware verifies it with WebCrypto using the same construction.
 * If DASHBOARD_PASSWORD is unset the dashboard is OPEN — the Helm chart
 * always generates one; only bare local dev runs unprotected.
 */

export const SESSION_COOKIE = "sd_session";
const SESSION_TTL_MS =
  Number(process.env.SESSION_TTL_HOURS ?? 168) * 60 * 60 * 1000;

export function dashboardPassword(): string | undefined {
  const p = process.env.DASHBOARD_PASSWORD;
  return p && p.length > 0 ? p : undefined;
}

export function passwordMatches(candidate: string, expected: string): boolean {
  // Hash both sides to fixed length so timingSafeEqual is applicable.
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function mintSessionToken(password: string, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const sig = createHmac("sha256", password)
    .update(`scuttledeck-session:${exp}`)
    .digest("hex");
  return `${exp}.${sig}`;
}
