import { config } from "../config.js";
import { query } from "../db/pool.js";
import {
  deriveConstants,
  emailTitleForConstants,
  loadGroupConstants,
} from "../lib/groupConstants.js";
import { sendEmail } from "./email.js";

/**
 * Notify a user they were assigned to a design queue item.
 *
 * Best-effort transactional mail — same fire-and-forget pattern as
 * mention notifications. Callers fire after the write commits.
 */

export type SendDesignAssignmentEmailInput = {
  designItemId: string;
  assigneeUserId: string;
  assignerUserId: string;
  groupId: string;
};

type UserLite = { id: string; name: string; email: string | null };
type DesignItemLite = { id: string; name: string; description: string };

async function loadUserLite(id: string): Promise<UserLite | null> {
  const { rows } = await query<UserLite>(
    `SELECT id, name, email FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadDesignItemLite(id: string): Promise<DesignItemLite | null> {
  const { rows } = await query<DesignItemLite>(
    `SELECT id, name, description FROM design_items WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function snippet(text: string, max = 200): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export async function sendDesignAssignmentEmail(
  input: SendDesignAssignmentEmailInput,
): Promise<boolean> {
  if (input.assigneeUserId === input.assignerUserId) return false;

  const [assignee, assigner, item, groupConstants] = await Promise.all([
    loadUserLite(input.assigneeUserId),
    loadUserLite(input.assignerUserId),
    loadDesignItemLite(input.designItemId),
    loadGroupConstants({ groupId: input.groupId }),
  ]);

  if (!assignee?.email) return false;
  if (!assigner || !item) return false;

  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const designUrl = `${appUrl}/design`;
  const snippetText = snippet(item.description);
  const fromName = emailTitleForConstants(
    groupConstants.get(input.groupId) ?? deriveConstants(null),
  );

  const subject = `Design assignment: "${item.name}"`;

  const plain = [
    `Hi ${assignee.name.split(/\s+/)[0] ?? assignee.name},`,
    "",
    `${assigner.name} assigned you to "${item.name}" on the Design queue.`,
    snippetText ? `\n${snippetText}` : "",
    "",
    `Open Design: ${designUrl}`,
    "",
    `You're receiving this because ${assigner.name} assigned this item to you.`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const escapedSnippet = escapeHtml(snippetText);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:520px;">
      <p>Hi ${escapeHtml(assignee.name.split(/\s+/)[0] ?? assignee.name)},</p>
      <p><strong>${escapeHtml(assigner.name)}</strong> assigned you to
        &ldquo;${escapeHtml(item.name)}&rdquo; on the Design queue.</p>
      ${escapedSnippet
        ? `<p style="color:#334155;margin:12px 0;white-space:pre-wrap;">${escapedSnippet}</p>`
        : ""}
      <p><a href="${escapeHtml(designUrl)}" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open Design</a></p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        You&rsquo;re receiving this because ${escapeHtml(assigner.name)} assigned this item to you.
      </p>
    </div>
  `.trim();

  await sendEmail({
    to: assignee.email,
    from: config.email.formatFrom(fromName),
    subject,
    text: plain,
    html,
  });
  return true;
}

export function fireDesignAssignmentEmail(input: SendDesignAssignmentEmailInput): void {
  sendDesignAssignmentEmail(input).catch((err) => {
    console.error(
      `[design-assignment] send failed item=${input.designItemId} to_user=${input.assigneeUserId}`,
      err,
    );
  });
}
