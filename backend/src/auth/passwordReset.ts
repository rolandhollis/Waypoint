import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { sendEmail } from "../notifications/email.js";
import type { UserRow } from "../types.js";

/**
 * Self-serve password reset + admin invite set-password.
 *
 * Tokens live in `password_reset_tokens` with a `purpose`:
 *   * `reset`  — forgot-password (short TTL)
 *   * `invite` — admin created the account; user picks first password
 *
 * We store SHA-256 hashes only — plaintext leaves the server in email.
 */

export type TokenPurpose = "reset" | "invite";

/** Forgot-password link lifetime. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Invite link lifetime — long enough for a new hire to open mail later. */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

function mintTokenPlaintext(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashResetToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export type ResetContext = {
  ip?: string | null;
  userAgent?: string | null;
};

async function mintTokenForUser(
  user: UserRow,
  purpose: TokenPurpose,
  ctx: ResetContext,
): Promise<string> {
  const plaintext = mintTokenPlaintext();
  const tokenHash = hashResetToken(plaintext);
  const ttlMs = purpose === "invite" ? INVITE_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;

  // Retire unused tokens of the same purpose for this user.
  await query(
    `UPDATE password_reset_tokens
        SET used_at = NOW()
      WHERE user_id = $1 AND used_at IS NULL AND purpose = $2`,
    [user.id, purpose],
  );

  await query(
    `INSERT INTO password_reset_tokens
       (user_id, token_hash, expires_at, purpose, requested_ip, requested_user_agent)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4, $5, $6)`,
    [user.id, tokenHash, String(ttlMs), purpose, ctx.ip ?? null, ctx.userAgent ?? null],
  );

  if (purpose === "invite") {
    await sendInviteEmail(user, plaintext);
  } else {
    await sendResetEmail(user, plaintext);
  }

  return plaintext;
}

/**
 * If a user with `email` exists, mint a reset token and mail it.
 * Otherwise silently no-op.
 */
export async function requestPasswordReset(
  email: string,
  ctx: ResetContext = {},
): Promise<{ tokenPlaintext: string | null; user: UserRow | null }> {
  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const user = rows[0];
  if (!user) return { tokenPlaintext: null, user: null };

  const plaintext = await mintTokenForUser(user, "reset", ctx);
  return { tokenPlaintext: plaintext, user };
}

/**
 * Mint (or remint) an invite for a user who has never set a password.
 * Callers should ensure password_hash is null.
 */
export async function sendUserInvite(
  user: UserRow,
  ctx: ResetContext = {},
): Promise<string> {
  return mintTokenForUser(user, "invite", ctx);
}

export async function consumePasswordResetToken(
  plaintext: string,
): Promise<{ userId: string; purpose: TokenPurpose } | null> {
  if (!plaintext) return null;
  const tokenHash = hashResetToken(plaintext);
  const { rows } = await query<{ user_id: string; purpose: TokenPurpose }>(
    `UPDATE password_reset_tokens
        SET used_at = NOW()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id, purpose`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, purpose: row.purpose ?? "reset" } : null;
}

export async function isResetTokenLive(plaintext: string): Promise<boolean> {
  if (!plaintext) return false;
  const tokenHash = hashResetToken(plaintext);
  const { rowCount } = await query(
    `SELECT 1 FROM password_reset_tokens
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()`,
    [tokenHash],
  );
  return (rowCount ?? 0) > 0;
}

export type TokenProbe = {
  live: boolean;
  purpose: TokenPurpose | null;
  ttlMinutes: number;
  name: string | null;
  email: string | null;
};

/** Probe without consuming — used by the set-password landing page. */
export async function probeResetToken(plaintext: string): Promise<TokenProbe> {
  if (!plaintext) {
    return { live: false, purpose: null, ttlMinutes: 0, name: null, email: null };
  }
  const tokenHash = hashResetToken(plaintext);
  const { rows } = await query<{
    purpose: TokenPurpose;
    expires_at: Date;
    name: string;
    email: string;
  }>(
    `SELECT t.purpose, t.expires_at, u.name, u.email
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.used_at IS NULL
        AND t.expires_at > NOW()`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) {
    return {
      live: false,
      purpose: null,
      ttlMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
      name: null,
      email: null,
    };
  }
  const ttlMs = Math.max(0, new Date(row.expires_at).getTime() - Date.now());
  return {
    live: true,
    purpose: row.purpose ?? "reset",
    ttlMinutes: Math.max(1, Math.round(ttlMs / 60000)),
    name: row.name,
    email: row.email,
  };
}

function buildSetPasswordUrl(plaintext: string): string {
  const base = config.publicAppUrl.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(plaintext)}`;
}

async function sendResetEmail(user: UserRow, plaintext: string): Promise<void> {
  const url = buildSetPasswordUrl(plaintext);
  const ttlMinutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  if (!config.email.resendApiKey) {
    console.warn(`[password-reset] dry-run link for ${user.email}: ${url}`);
  }
  const subject = "Reset your password";
  const text = [
    `Hi ${user.name || "there"},`,
    ``,
    `Someone (hopefully you) asked to reset the password for ${user.email}.`,
    ``,
    `Open this link within the next ${ttlMinutes} minutes to pick a new password:`,
    url,
    ``,
    `If you didn't request this, you can ignore this email — your existing password will keep working.`,
  ].join("\n");

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 24px;">
    <div style="max-width: 480px; margin: 0 auto;">
      <h1 style="font-size: 18px; margin: 0 0 12px 0;">Reset your password</h1>
      <p style="margin: 0 0 12px 0;">Hi ${escapeHtml(user.name || "there")},</p>
      <p style="margin: 0 0 12px 0;">
        Someone (hopefully you) asked to reset the password for
        <strong>${escapeHtml(user.email)}</strong>.
      </p>
      <p style="margin: 20px 0;">
        <a href="${escapeAttr(url)}"
           style="display:inline-block;padding:10px 16px;background:#DC2626;color:#fff;
                  border-radius:6px;text-decoration:none;font-weight:600;">
          Choose a new password
        </a>
      </p>
      <p style="margin: 12px 0; color: #475569; font-size: 13px;">
        Link expires in <strong>${ttlMinutes} minutes</strong>. If the button doesn't work,
        copy and paste this URL:<br>
        <span style="word-break: break-all;">${escapeHtml(url)}</span>
      </p>
      <p style="margin: 24px 0 0 0; color: #64748b; font-size: 12px;">
        If you didn't request this, you can safely ignore this email — your existing password
        will keep working.
      </p>
    </div>
  </body>
</html>
  `.trim();

  await sendEmail({ to: user.email, subject, text, html });
}

async function sendInviteEmail(user: UserRow, plaintext: string): Promise<void> {
  const url = buildSetPasswordUrl(plaintext);
  const ttlDays = Math.round(INVITE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000));
  if (!config.email.resendApiKey) {
    console.warn(`[invite] dry-run link for ${user.email}: ${url}`);
  }
  const subject = "You're invited to Waypoint — set your password";
  const text = [
    `Hi ${user.name || "there"},`,
    ``,
    `You've been invited to Waypoint (${user.email}).`,
    ``,
    `Open this link within the next ${ttlDays} days to create your password and sign in:`,
    url,
    ``,
    `If you weren't expecting this, you can ignore this email.`,
  ].join("\n");

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 24px;">
    <div style="max-width: 480px; margin: 0 auto;">
      <h1 style="font-size: 18px; margin: 0 0 12px 0;">Welcome to Waypoint</h1>
      <p style="margin: 0 0 12px 0;">Hi ${escapeHtml(user.name || "there")},</p>
      <p style="margin: 0 0 12px 0;">
        You've been invited to Waypoint as <strong>${escapeHtml(user.email)}</strong>.
        Set a password to finish creating your account.
      </p>
      <p style="margin: 20px 0;">
        <a href="${escapeAttr(url)}"
           style="display:inline-block;padding:10px 16px;background:#DC2626;color:#fff;
                  border-radius:6px;text-decoration:none;font-weight:600;">
          Set your password
        </a>
      </p>
      <p style="margin: 12px 0; color: #475569; font-size: 13px;">
        Link expires in <strong>${ttlDays} days</strong>. If the button doesn't work,
        copy and paste this URL:<br>
        <span style="word-break: break-all;">${escapeHtml(url)}</span>
      </p>
      <p style="margin: 24px 0 0 0; color: #64748b; font-size: 12px;">
        If you weren't expecting this invitation, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>
  `.trim();

  await sendEmail({ to: user.email, subject, text, html });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
