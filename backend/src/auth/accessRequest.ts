import { config } from "../config.js";
import { query } from "../db/pool.js";
import { sendEmail } from "../notifications/email.js";

export type AccessRequestInput = {
  email: string;
  name: string;
  message?: string | null;
};

/**
 * Notify every super-admin that someone asked for a Waypoint account.
 * Admins then create the user via Admin → Users (existing invite flow).
 *
 * Returns whether any mail was attempted. Callers still respond 204
 * either way so we don't leak roster membership to unauthenticated
 * clients. If the email already belongs to a user we skip the send
 * (they're already provisioned) but still return quietly.
 */
export async function requestAccountAccess(
  input: AccessRequestInput,
): Promise<{ emailed: boolean; alreadyUser: boolean }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const message = input.message?.trim() || null;

  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  if (existing[0]) {
    return { emailed: false, alreadyUser: true };
  }

  const recipients = await loadSuperAdminEmails();
  if (recipients.length === 0) {
    console.warn(
      `[access-request] no super-admin recipients for ${email}; falling back to SUPER_ADMIN_EMAIL`,
    );
  }
  const to = recipients.length > 0 ? recipients : fallbackSuperAdmin();
  if (to.length === 0) {
    console.error(`[access-request] nowhere to send request for ${email}`);
    return { emailed: false, alreadyUser: false };
  }

  const adminUrl = buildAdminCreateUrl({ email, name, message });
  const subject = `Waypoint access request: ${name} <${email}>`;
  const text = buildText({ email, name, message, adminUrl });
  const html = buildHtml({ email, name, message, adminUrl });

  for (const recipient of to) {
    await sendEmail({
      to: recipient,
      subject,
      text,
      html,
      replyTo: email,
    });
  }
  return { emailed: true, alreadyUser: false };
}

async function loadSuperAdminEmails(): Promise<string[]> {
  const { rows } = await query<{ email: string }>(
    `SELECT email FROM users
      WHERE is_super_user = TRUE
        AND email IS NOT NULL
        AND trim(email) <> ''
      ORDER BY email`,
  );
  return rows.map((r) => r.email.trim()).filter(Boolean);
}

function fallbackSuperAdmin(): string[] {
  const email = config.superAdmin.email?.trim();
  return email ? [email] : [];
}

/** Deep-link that opens Admin → Users with the create-user modal prefilled. */
function buildAdminCreateUrl(args: {
  email: string;
  name: string;
  message: string | null;
}): string {
  const base = config.publicAppUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    tab: "users",
    requestEmail: args.email,
    requestName: args.name,
  });
  if (args.message) params.set("requestMessage", args.message);
  return `${base}/admin?${params.toString()}`;
}

function buildText(args: {
  email: string;
  name: string;
  message: string | null;
  adminUrl: string;
}): string {
  const lines = [
    `Someone requested a Waypoint account.`,
    ``,
    `Name: ${args.name}`,
    `Email: ${args.email}`,
  ];
  if (args.message) {
    lines.push(``, `Message:`, args.message);
  }
  lines.push(
    ``,
    `Open this link to review and create their account (Users tab, form pre-filled):`,
    args.adminUrl,
    ``,
    `After you create them they'll get an invite email to set a password.`,
    `You can reply directly to this email to reach the requester.`,
  );
  return lines.join("\n");
}

function buildHtml(args: {
  email: string;
  name: string;
  message: string | null;
  adminUrl: string;
}): string {
  const messageBlock = args.message
    ? `<p style="margin: 16px 0 8px 0;"><strong>Message:</strong></p>
       <p style="margin: 0 0 12px 0; white-space: pre-wrap; color: #334155;">${escapeHtml(args.message)}</p>`
    : "";
  return `
<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; line-height: 1.5; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto;">
      <h1 style="font-size: 18px; margin: 0 0 12px 0;">Waypoint access request</h1>
      <p style="margin: 0 0 12px 0;">
        <strong>${escapeHtml(args.name)}</strong> requested a new account.
      </p>
      <p style="margin: 0 0 8px 0;"><strong>Name:</strong> ${escapeHtml(args.name)}</p>
      <p style="margin: 0 0 8px 0;"><strong>Email:</strong> ${escapeHtml(args.email)}</p>
      ${messageBlock}
      <p style="margin: 20px 0;">
        <a href="${escapeAttr(args.adminUrl)}"
           style="display:inline-block;padding:10px 16px;background:#DC2626;color:#fff;
                  border-radius:6px;text-decoration:none;font-weight:600;">
          Review &amp; create user
        </a>
      </p>
      <p style="margin: 12px 0; color: #475569; font-size: 13px;">
        This opens Admin → Users with their details filled in. Click Create user
        to provision the account and send the invite. Reply to this message to
        reach the requester.
      </p>
    </div>
  </body>
</html>
  `.trim();
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
