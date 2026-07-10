import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { verifyPassword } from "../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  readSessionCookie,
  setSessionCookie,
  SESSION_TTL_MS,
} from "../auth/session.js";
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

  const { email, password } = loginSchema.parse(req.body);
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
  const session = await createSession(user.id, ua);
  setSessionCookie(res, session.id);

  // Never echo the password_hash to the client.
  const { password_hash: _ph, ...safe } = user;
  res.json({ user: safe, expiresInMs: SESSION_TTL_MS });
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
