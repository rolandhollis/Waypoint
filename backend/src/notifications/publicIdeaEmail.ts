import { config } from "../config.js";
import { query } from "../db/pool.js";
import { sendEmail } from "./email.js";

export type PublicIdeaNotifyInput = {
  groupId: string;
  groupName: string;
  projectId: string;
  /** Absolute URL to `/projects/:id` — primary CTA in the email. */
  projectUrl: string;
  title: string;
  description: string;
  teamNames: string[];
  submitterName: string;
  submitterEmail: string;
};

/**
 * Email every admin of the workspace that a public idea form
 * created a new backlog item. Includes a deep link to the ticket
 * detail page.
 */
export async function notifyAdminsOfPublicIdea(
  input: PublicIdeaNotifyInput,
): Promise<{ emailed: number }> {
  const recipients = await loadGroupAdminEmails(input.groupId);
  if (recipients.length === 0) {
    console.warn(
      `[public-idea] no admin recipients for group=${input.groupId}; skipping notify`,
    );
    return { emailed: 0 };
  }

  const subject = `New public idea: ${input.title}`;
  const text = buildText(input);
  const html = buildHtml(input);

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject,
        text,
        html,
        replyTo: input.submitterEmail,
        from: config.email.formatFrom(undefined),
      });
      emailed += 1;
    } catch (err) {
      console.error(`[public-idea] email failed for ${to}:`, err);
    }
  }
  return { emailed };
}

async function loadGroupAdminEmails(groupId: string): Promise<string[]> {
  const { rows } = await query<{ email: string }>(
    `SELECT DISTINCT u.email
       FROM users u
       JOIN user_groups ug ON ug.user_id = u.id
      WHERE ug.group_id = $1
        AND ug.role = 'admin'
        AND u.email IS NOT NULL
        AND trim(u.email) <> ''
      ORDER BY u.email`,
    [groupId],
  );
  return rows.map((r) => r.email.trim()).filter(Boolean);
}

function buildText(input: PublicIdeaNotifyInput): string {
  const lines = [
    `A new idea was submitted via the public form for ${input.groupName}.`,
    ``,
    `Title: ${input.title}`,
    `Submitted by: ${input.submitterName} <${input.submitterEmail}>`,
  ];
  if (input.teamNames.length) {
    lines.push(`Teams: ${input.teamNames.join(", ")}`);
  }
  lines.push(
    ``,
    `Description:`,
    input.description.trim() || "(none)",
    ``,
    `View ticket:`,
    input.projectUrl,
    ``,
    `You can reply directly to this email to reach the submitter.`,
  );
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(input: PublicIdeaNotifyInput): string {
  const desc = input.description.trim()
    ? escapeHtml(input.description.trim()).replace(/\n/g, "<br/>")
    : "<em>(none)</em>";
  const teams = input.teamNames.length
    ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top;">Teams</td><td style="padding:4px 0;color:#0f172a;">${escapeHtml(input.teamNames.join(", "))}</td></tr>`
    : "";
  const href = escapeHtml(input.projectUrl);
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">
      <p>A new idea was submitted via the public form for <strong>${escapeHtml(input.groupName)}</strong>.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;">
        <tr>
          <td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top;">Title</td>
          <td style="padding:4px 0;font-weight:600;color:#0f172a;">
            <a href="${href}" style="color:#0f172a;text-decoration:none;">${escapeHtml(input.title)}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top;">Submitted by</td>
          <td style="padding:4px 0;color:#0f172a;">${escapeHtml(input.submitterName)} &lt;${escapeHtml(input.submitterEmail)}&gt;</td>
        </tr>
        ${teams}
      </table>
      <div style="margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:6px;">Description</div>
        <div style="color:#334155;">${desc}</div>
      </div>
      <p style="margin:20px 0 8px;">
        <a href="${href}"
           style="display:inline-block;background:#dc2626;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;padding:10px 18px;border-radius:6px;">
          View ticket
        </a>
      </p>
      <p style="margin:0 0 16px;font-size:12px;color:#64748b;word-break:break-all;">
        <a href="${href}" style="color:#64748b;">${href}</a>
      </p>
      <p style="font-size:12px;color:#64748b;">Reply to this email to reach the submitter.</p>
    </div>`;
}
