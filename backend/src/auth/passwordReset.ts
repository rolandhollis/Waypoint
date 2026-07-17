import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { sendEmail } from "../notifications/email.js";
import type { UserRow } from "../types.js";

/**
 * Self-serve password reset.
 *
 * Two operations, kept in one file so the token lifecycle stays
 * legible in one place:
 *   * requestPasswordReset(email)  → generates a token, stores its
 *     hash, and sends the email. Always returns without leaking
 *     whether the email was known.
 *   * consumePasswordResetToken(token) → hashes the incoming token
 *     and looks up a matching *unused, unexpired* row. Marks it
 *     used on success. Returns the user id (caller updates the
 *     password + revokes sessions in one transaction).
 *
 * We deliberately store token hashes rather than plaintext so a
 * database compromise doesn't hand an attacker a fistful of live
 * reset links. Tokens are 32 random bytes → ~256 bits of entropy,
 * so a SHA-256 pre-image search is not a realistic threat and we
 * skip the bcrypt cost that made login lookups a slog to reason
 * about.
 */

/** Token lifetime — matches the UX copy on the request confirmation
 *  screen and the reset email. Kept intentionally short so a stolen
 *  mailbox has a narrow window; 30 minutes is enough time for the
 *  user to walk from "I clicked forgot" to "I typed a new password"
 *  without being a nuisance. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Length in bytes of the underlying random value. 32 bytes → 256
 *  bits of entropy → 43-char base64url string. */
const TOKEN_BYTES = 32;

/**
 * Generate a URL-safe random token. Base64url so it round-trips
 * through query strings without percent-encoding surprises.
 */
function mintTokenPlaintext(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 hex of the plaintext. Consumers store this and query by
 * it — plaintext leaves the server only inside the reset email.
 */
export function hashResetToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export type ResetContext = {
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * If a user with `email` exists, mint a reset token and mail it.
 * Otherwise silently no-op. Returns the plaintext token when one
 * was created, `null` otherwise — used by tests / smoke scripts;
 * production callers ignore the return value so timing-side
 * channels don't leak existence.
 *
 * We invalidate every prior UNUSED token for the user on request
 * so a fresh click on "Forgot" retires older, potentially-stale
 * links (e.g. a request the user made yesterday and forgot about).
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

  const plaintext = mintTokenPlaintext();
  const tokenHash = hashResetToken(plaintext);

  // Retire any prior unused tokens for this user. Cheap (indexed on
  // user_id) and keeps consume-time lookups uncluttered.
  await query(
    `UPDATE password_reset_tokens
        SET used_at = NOW()
      WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );

  await query(
    `INSERT INTO password_reset_tokens
       (user_id, token_hash, expires_at, requested_ip, requested_user_agent)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4, $5)`,
    [user.id, tokenHash, String(RESET_TOKEN_TTL_MS), ctx.ip ?? null, ctx.userAgent ?? null],
  );

  await sendResetEmail(user, plaintext);

  return { tokenPlaintext: plaintext, user };
}

/**
 * Look up a token by its hash. Returns the associated user id when
 * the row exists, is unexpired, and hasn't been used. Marks the
 * token consumed atomically so a rapid double-click can't redeem
 * twice.
 *
 * On success the caller is expected to (a) update the user's
 * password + password_updated_at and (b) revoke every active
 * session for the user — matching what the admin-driven reset
 * path already does.
 */
export async function consumePasswordResetToken(
  plaintext: string,
): Promise<{ userId: string } | null> {
  if (!plaintext) return null;
  const tokenHash = hashResetToken(plaintext);
  // Atomic: mark used only if still valid, and return the user id
  // in the same round-trip. RETURNING gives us zero-row => invalid
  // and one-row => success without a follow-up SELECT.
  const { rows } = await query<{ user_id: string }>(
    `UPDATE password_reset_tokens
        SET used_at = NOW()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { userId: row.user_id } : null;
}

/**
 * Quick "is this token still valid?" probe used by the reset page
 * on load — lets us show "this link has expired" up front instead
 * of after the user picks a new password and hits Save. Does NOT
 * consume the token.
 */
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

// -----------------------------------------------------------------
// Email rendering + send
// -----------------------------------------------------------------

function buildResetUrl(plaintext: string): string {
  // URL-encode defensively even though base64url is already
  // URL-safe; costs nothing and future-proofs against callers who
  // hand us a non-base64url token.
  const base = config.publicAppUrl.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(plaintext)}`;
}

async function sendResetEmail(user: UserRow, plaintext: string): Promise<void> {
  const url = buildResetUrl(plaintext);
  const ttlMinutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  // Dev convenience: when we're not actually sending (no Resend key
  // configured — typical for a local checkout) echo the redemption
  // URL to the backend log. Safe to include here because if the
  // email didn't leave the box, nobody but the operator watching the
  // log is going to see the plaintext token. When a real API key
  // IS configured we suppress this so prod logs never carry a live
  // reset link.
  if (!config.email.resendApiKey) {
    console.warn(`[password-reset] dry-run link for ${user.email}: ${url}`);
  }
  const subject = "Reset your Waypoint password";
  const text = [
    `Hi ${user.name || "there"},`,
    ``,
    `Someone (hopefully you) asked to reset the Waypoint password for ${user.email}.`,
    ``,
    `Open this link within the next ${ttlMinutes} minutes to pick a new password:`,
    url,
    ``,
    `If you didn't request this, you can ignore this email — your existing password will keep working.`,
    ``,
    `— Waypoint`,
  ].join("\n");

  const html = `
<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 24px;">
    <div style="max-width: 480px; margin: 0 auto;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">
        Reset your Waypoint password. Link expires in ${ttlMinutes} minutes.
      </div>
      <h1 style="font-size: 18px; margin: 0 0 12px 0;">Reset your Waypoint password</h1>
      <p style="margin: 0 0 12px 0;">Hi ${escapeHtml(user.name || "there")},</p>
      <p style="margin: 0 0 12px 0;">
        Someone (hopefully you) asked to reset the Waypoint password for
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
