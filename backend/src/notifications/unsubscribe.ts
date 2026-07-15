import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Stateless unsubscribe tokens.
 *
 * The email footer needs a "Unsubscribe" link the recipient can
 * click without logging in — but we don't want to store a
 * per-email GUID for every send. Instead each link carries an
 * HMAC-signed payload of `${userId}.${kind}` so the server can
 * verify authenticity + intent from the URL alone with no DB
 * round-trip.
 *
 * Rotating EMAIL_UNSUBSCRIBE_SECRET invalidates every outstanding
 * link, which is intentional — it's the emergency stop if a
 * secret ever leaks.
 */
export function makeUnsubscribeToken(userId: string, kind: string): string {
  const payload = `${userId}.${kind}`;
  const sig = crypto
    .createHmac("sha256", config.email.unsubscribeSecret)
    .update(payload)
    .digest("base64url");
  // Encode payload as base64url so query-string parsing doesn't
  // choke on the dot separator or any UUID edge cases.
  const enc = Buffer.from(payload, "utf8").toString("base64url");
  return `${enc}.${sig}`;
}

export function verifyUnsubscribeToken(
  token: string,
): { userId: string; kind: string } | null {
  const [enc, sig] = token.split(".");
  if (!enc || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(enc, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", config.email.unsubscribeSecret)
    .update(payload)
    .digest("base64url");
  // Constant-time compare so a "does this signature validate" oracle
  // can't be built via response timing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const [userId, kind] = payload.split(".");
  if (!userId || !kind) return null;
  return { userId, kind };
}
