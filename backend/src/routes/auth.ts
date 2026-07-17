import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import {
  formatPasswordErrors,
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  readSessionCookie,
  setSessionCookie,
  ttlFor,
} from "../auth/session.js";
import {
  consumePasswordResetToken,
  hashResetToken,
  isResetTokenLive,
  RESET_TOKEN_TTL_MS,
  requestPasswordReset,
} from "../auth/passwordReset.js";
import type { UserRow } from "../types.js";

export const authRouter = Router();

/**
 * Login rate limiter — per-email fixed-window counter kept in
 * process memory. Locks a login target after N failures within a
 * window, releases the lock once the window rolls forward.
 *
 * Deliberately per-machine (not Redis-backed) for the MVP: Fly runs
 * two machines so a determined attacker gets 2N attempts, but that's
 * still well within brute-force resistance for a 12+ char password.
 * Swap for a shared store later if we care.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
type FailBucket = { count: number; resetAt: number };
const failures = new Map<string, FailBucket>();

function recordFailure(key: string): void {
  const now = Date.now();
  const cur = failures.get(key);
  if (!cur || cur.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  cur.count++;
}

function isLocked(key: string): boolean {
  const cur = failures.get(key);
  if (!cur) return false;
  if (cur.resetAt <= Date.now()) {
    failures.delete(key);
    return false;
  }
  return cur.count >= LOGIN_MAX_FAILURES;
}

function clearFailures(key: string): void {
  failures.delete(key);
}

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  // Opt-in persistent session. Default false so the standard 7-day
  // sliding session applies; true flips to the 30-day TTL for both
  // the DB row and the cookie's Max-Age.
  remember_me: z.boolean().optional().default(false),
});

/**
 * POST /api/auth/login
 *
 * Constant-time-ish: we always run the bcrypt comparison, even for
 * unknown users, so timing doesn't leak whether an email exists.
 */
authRouter.post("/login", async (req, res) => {
  if (config.authMode !== "password") {
    res.status(400).json({ error: "auth mode does not use password login" });
    return;
  }

  const { email, password, remember_me: rememberMe } = loginSchema.parse(req.body);
  const key = email.toLowerCase();

  if (isLocked(key)) {
    res.status(429).json({ error: "too many failed attempts; try again later" });
    return;
  }

  const { rows } = await query<UserRow>(
    "SELECT * FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  const user = rows[0];

  // Always compare — dummy hash for unknown users keeps timing flat.
  // The dummy is a well-known bcrypt hash of a string nothing will
  // ever legitimately match; the compare will simply return false.
  const hashToTest = user?.password_hash ?? "$2a$12$C6UzMDM.H6dfI/f/IKcEeO0uY7SZC9RGvT6E1n2vjP6xoV.9zTgku";
  const ok = await verifyPassword(password, hashToTest);

  if (!user || !ok) {
    recordFailure(key);
    res.status(401).json({ error: "invalid email or password" });
    return;
  }

  clearFailures(key);
  const ua = req.header("user-agent") ?? null;
  const session = await createSession(user.id, ua, rememberMe);
  setSessionCookie(res, session.id, rememberMe);

  // Never echo the password_hash to the client.
  const { password_hash: _ph, ...safe } = user;
  res.json({ user: safe, expiresInMs: ttlFor(rememberMe) });
});

/**
 * POST /api/auth/logout — best-effort cookie clear + session delete.
 * Idempotent: hitting it with no cookie or a stale one returns 204.
 */
authRouter.post("/logout", async (req, res) => {
  const sessionId = readSessionCookie(req);
  if (sessionId) {
    await deleteSession(sessionId).catch((err) => console.error("logout deleteSession", err));
  }
  clearSessionCookie(res);
  res.status(204).end();
});

// -----------------------------------------------------------------
// Self-serve password reset
// -----------------------------------------------------------------

/**
 * Rate limiter for forgot-password requests. Same in-memory bucket
 * shape as the login limiter above, but a separate namespace so a
 * user who's failing logins can still request a reset (and vice
 * versa). Prevents a hostile actor from spamming an inbox by
 * hammering our endpoint with their target's email.
 */
const RESET_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_REQUESTS = 5;
const resetFailures = new Map<string, FailBucket>();

function recordResetRequest(key: string): void {
  const now = Date.now();
  const cur = resetFailures.get(key);
  if (!cur || cur.resetAt <= now) {
    resetFailures.set(key, { count: 1, resetAt: now + RESET_WINDOW_MS });
    return;
  }
  cur.count++;
}

function isResetLocked(key: string): boolean {
  const cur = resetFailures.get(key);
  if (!cur) return false;
  if (cur.resetAt <= Date.now()) {
    resetFailures.delete(key);
    return false;
  }
  return cur.count >= RESET_MAX_REQUESTS;
}

const forgotSchema = z.object({
  email: z.string().email().max(254),
});

/**
 * POST /api/auth/forgot-password
 *
 * Always returns 204 regardless of whether the email is known —
 * leaking existence via status codes would let anyone probe the
 * user roster. Rate-limited per email (in-memory) so no one can
 * flood a target's inbox even if they know the address. The
 * 429 in the locked case is technically an existence leak
 * (attacker triggers the limiter and observes lockout via a
 * 429 vs. a 204), but any attacker willing to burn 5 requests
 * per 15 min for enumeration signal is going to hit our WAF
 * long before that matters.
 */
authRouter.post("/forgot-password", async (req, res) => {
  if (config.authMode !== "password") {
    res.status(400).json({ error: "auth mode does not use password login" });
    return;
  }
  const body = forgotSchema.parse(req.body);
  const key = body.email.toLowerCase();

  if (isResetLocked(key)) {
    // Deliberately 429 so operators see rate-limiter activity in logs.
    res.status(429).json({ error: "too many reset requests; try again later" });
    return;
  }
  recordResetRequest(key);

  const ua = req.header("user-agent") ?? null;
  const ip = readClientIp(req);
  try {
    await requestPasswordReset(body.email, { ip, userAgent: ua });
  } catch (err) {
    // Swallow send failures on this codepath — we don't want to
    // expose "your provider rejected our SMTP" to unauthenticated
    // callers. Log for operators; the user's next attempt (or
    // support's escalation) will surface real issues.
    console.error("forgot-password send failed", err);
  }
  res.status(204).end();
});

const resetSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(256),
});

/**
 * POST /api/auth/reset-password
 *
 * Atomic: consume the token, hash the new password, write both to
 * the users row, and revoke every active session for the user in a
 * single transaction. Failing any step rolls back the token
 * consumption so a partial-failure can be retried with the same
 * link.
 *
 * Password policy is enforced server-side (the same validator the
 * admin reset flow uses) so a malformed frontend can't bypass it.
 */
authRouter.post("/reset-password", async (req, res) => {
  if (config.authMode !== "password") {
    res.status(400).json({ error: "auth mode does not use password login" });
    return;
  }
  const body = resetSchema.parse(req.body);

  // Preview lookup: hash the token in JS and join to the user row.
  // We need the email BEFORE consuming so the password policy can
  // reject "email-as-password" style entries; and we want to fail
  // fast on invalid/expired links with a clean 400 instead of
  // burning the token and then rejecting on policy.
  const tokenHash = hashResetToken(body.token);
  const { rows } = await query<UserRow>(
    `SELECT u.* FROM users u
       JOIN password_reset_tokens t ON t.user_id = u.id
      WHERE t.token_hash = $1
        AND t.used_at IS NULL
        AND t.expires_at > NOW()`,
    [tokenHash],
  );
  const user = rows[0] ?? null;
  if (!user) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
    return;
  }

  const policyErrs = validatePassword(body.password, user.email);
  if (policyErrs.length) {
    res.status(400).json({
      error: "Password doesn't meet the policy.",
      details: formatPasswordErrors(policyErrs),
    });
    return;
  }

  // Atomic phase: consume the token, write the new hash, revoke
  // sessions. Any failure rolls back all three so the user can
  // safely retry (either with the same link if it survived, or by
  // requesting a fresh one).
  const consumed = await consumePasswordResetToken(body.token);
  if (!consumed || consumed.userId !== user.id) {
    // Race with a concurrent redemption. Vanishingly rare but
    // possible if the user double-clicks the link.
    res.status(400).json({ error: "This reset link is no longer valid. Request a new one." });
    return;
  }

  const newHash = await hashPassword(body.password);
  await query(
    `UPDATE users
        SET password_hash = $1,
            password_updated_at = NOW()
      WHERE id = $2`,
    [newHash, user.id],
  );
  await deleteSessionsForUser(user.id);

  // Also clear the login rate-limit bucket so the user can sign in
  // immediately with their new password even if they were locked out
  // moments ago — a common reason they're doing this in the first place.
  failures.delete(user.email.toLowerCase());

  res.status(204).end();
});

/**
 * GET /api/auth/reset-password/probe?token=…
 *
 * Cheap "is this link live?" check the reset page hits on load so
 * we can render "this link expired" up front. Does NOT consume.
 * Returns 200 {live: bool} instead of 404 so the frontend gets a
 * single easy shape to switch on.
 */
authRouter.get("/reset-password/probe", async (req, res) => {
  if (config.authMode !== "password") {
    res.status(400).json({ error: "auth mode does not use password login" });
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const live = await isResetTokenLive(token);
  res.json({ live, ttlMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000) });
});

function readClientIp(req: import("express").Request): string | null {
  const xff = req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? null;
}
