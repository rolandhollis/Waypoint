import { config } from "../config.js";
import { query } from "../db/pool.js";
import { sendEmail } from "./email.js";
import { renderMentionsAsPlain, snippetForEmail } from "../lib/mentions.js";

/**
 * Send a "you were mentioned" email.
 *
 * Reuses the shared `sendEmail` helper (same Resend client, From
 * address, and dry-run fallback that the weekly status reminder /
 * digest / password reset flows use — no queue, no retry cascade,
 * fire-and-forget from the request handler).
 *
 * Callers wrap the invocation in `.catch(logError)` so a mail-provider
 * failure never leaves the underlying comment / description write
 * uncommitted; email is best-effort by design.
 */

export type MentionSourceType = "comment" | "description";

export type SendMentionEmailInput = {
  mentionedUserId: string;
  mentioningUserId: string;
  projectId: string;
  sourceType: MentionSourceType;
  /** Raw body/description text — mentions inside are rewritten to
   *  `@Name` before the snippet lands in the email. */
  bodyText: string;
};

type UserLite = { id: string; name: string; email: string | null };
type ProjectLite = { id: string; title: string };

async function loadUserLite(id: string): Promise<UserLite | null> {
  const { rows } = await query<UserLite>(
    `SELECT id, name, email FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadProjectLite(id: string): Promise<ProjectLite | null> {
  const { rows } = await query<ProjectLite>(
    `SELECT id, title FROM projects WHERE id = $1`,
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

/**
 * Length caps on the inline snippet, aligned with the spec:
 * comments quote up to ~500 chars, descriptions ~200. Both are the
 * "as rendered to a human" length (i.e. `renderMentionsAsPlain` has
 * already dropped `(user:UUID)` weight from the count) so the visible
 * body reads as intended regardless of how many tokens were in the
 * source.
 */
const COMMENT_SNIPPET_MAX = 500;
const DESCRIPTION_SNIPPET_MAX = 200;

/**
 * Render + send a mention notification. Skips the send (returns
 * false) when:
 *   * self-mention (user tagged themselves)
 *   * mentioned user isn't in the DB (deleted between save + email)
 *   * mentioned user has no email address on file
 *
 * All three cases are legitimate — the write already committed and
 * this best-effort side channel is allowed to opt out silently.
 */
export async function sendMentionEmail(
  input: SendMentionEmailInput,
): Promise<boolean> {
  // Cheapest guard first: never send someone an email for tagging
  // themselves. Costs one comparison, saves a DB round-trip.
  if (input.mentionedUserId === input.mentioningUserId) return false;

  const [mentioned, mentioning, project] = await Promise.all([
    loadUserLite(input.mentionedUserId),
    loadUserLite(input.mentioningUserId),
    loadProjectLite(input.projectId),
  ]);
  if (!mentioned) return false;
  if (!mentioned.email) return false;
  if (!mentioning || !project) return false;

  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const projectUrl = `${appUrl}/projects/${project.id}`;

  const snippetMax =
    input.sourceType === "comment" ? COMMENT_SNIPPET_MAX : DESCRIPTION_SNIPPET_MAX;
  const snippet = snippetForEmail(input.bodyText ?? "", snippetMax);
  const contextPhrase =
    input.sourceType === "comment"
      ? "a comment on"
      : "the description of";

  const subject = `You were mentioned on "${project.title}"`;

  const plain = [
    `Hi ${mentioned.name.split(/\s+/)[0] ?? mentioned.name},`,
    "",
    `${mentioning.name} mentioned you in ${contextPhrase} "${project.title}".`,
    "",
    snippet ? `\u2014 quoted \u2014\n${snippet}\n\u2014 end \u2014` : "",
    "",
    `Open item: ${projectUrl}`,
    "",
    `You're receiving this because ${mentioning.name} tagged you in Waypoint.`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  // HTML mirror. Deliberately un-fancy — no logo, no images — matching
  // the treatment `renderReminder` in statusReminders.ts uses, so
  // mentions land alongside the other transactional mail without a
  // visual style rift.
  const escapedSnippet = escapeHtml(snippet);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:520px;">
      <p>Hi ${escapeHtml(mentioned.name.split(/\s+/)[0] ?? mentioned.name)},</p>
      <p><strong>${escapeHtml(mentioning.name)}</strong> mentioned you in ${escapeHtml(contextPhrase)}
        &ldquo;${escapeHtml(project.title)}&rdquo;.</p>
      ${snippet
        ? `<blockquote style="border-left:3px solid #E2E8F0;color:#334155;margin:12px 0;padding:6px 12px;white-space:pre-wrap;">${escapedSnippet}</blockquote>`
        : ""}
      <p><a href="${escapeHtml(projectUrl)}" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open item</a></p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        You&rsquo;re receiving this because ${escapeHtml(mentioning.name)} tagged you in Waypoint.
      </p>
    </div>
  `.trim();

  await sendEmail({
    to: mentioned.email,
    subject,
    text: plain,
    html,
  });
  return true;
}

/**
 * Fire-and-forget wrapper the routes prefer — they don't want to
 * block the response on the provider round-trip and can't do anything
 * useful with a delivery failure at write time. Errors are logged to
 * console (same treatment as the reminder pipeline) so a delivery
 * investigation still has something to grep for.
 */
export function fireMentionEmail(input: SendMentionEmailInput): void {
  sendMentionEmail(input).catch((err) => {
    console.error(
      `[mention] send failed project=${input.projectId} to_user=${input.mentionedUserId}`,
      err,
    );
  });
}

// Re-export for callers that want the "how does this text render as
// plain-language" helper without pulling from the lib module directly.
export { renderMentionsAsPlain };
