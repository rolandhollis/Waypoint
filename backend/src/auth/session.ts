import type { Request, Response } from "express";
import { query } from "../db/pool.js";
import type { UserRow } from "../types.js";

/**
 * Server-side session store. One row in `user_sessions` per active
 * login; the session id lives in an HttpOnly cookie. This gives us
 * three things a JWT wouldn't:
 *
 *   * instant revocation (admin resets a password → delete all rows
 *     for that user_id → all their devices sign out on next request)
 *   * no signing-key rotation drama
 *   * server-side visibility ("who is logged in right now?")
 *
 * Costs a DB round-trip per authenticated request, which is fine at
 * our scale (single-digit RPS).
 */

export const SESSION_COOKIE = "waypoint.session";
/** 7-day fixed lifetime — refreshable via touchSession() on each hit. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  user_agent: string | null;
};

export async function createSession(userId: string, userAgent: string | null): Promise<SessionRow> {
  const { rows } = await query<SessionRow>(
    `INSERT INTO user_sessions (user_id, expires_at, user_agent)
     VALUES ($1, NOW() + ($2 || ' milliseconds')::interval, $3)
     RETURNING *`,
    [userId, String(SESSION_TTL_MS), userAgent],
  );
  return rows[0]!;
}

export async function findSessionUser(sessionId: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT u.*
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/** Bump last_seen_at + slide the expiry forward. Cheap enough to
 *  run on every authenticated request. */
export async function touchSession(sessionId: string): Promise<void> {
  await query(
    `UPDATE user_sessions
        SET last_seen_at = NOW(),
            expires_at   = NOW() + ($2 || ' milliseconds')::interval
      WHERE id = $1`,
    [sessionId, String(SESSION_TTL_MS)],
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await query(`DELETE FROM user_sessions WHERE id = $1`, [sessionId]);
}

/** Invalidate every active session for a user — used on password
 *  reset so admin-managed rotations force re-login everywhere. */
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

// -----------------------------------------------------------------
// Cookie helpers
// -----------------------------------------------------------------

/**
 * Parse the session id out of the raw Cookie header. Kept ad-hoc
 * (no cookie-parser dep) since we only care about one name — this
 * saves adding a middleware whose surface would then also start
 * touching bodies etc.
 */
export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // Only mark Secure over HTTPS or in production — otherwise the
  // dev server (http://localhost:5173) would drop the cookie.
  if (isSecureContext()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=0`,
  ];
  if (isSecureContext()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isSecureContext(): boolean {
  return process.env.NODE_ENV === "production";
}
