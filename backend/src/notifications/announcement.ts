import { formatInTimeZone } from "date-fns-tz";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { loadGroupConstants } from "../lib/groupConstants.js";
import { sendEmail } from "./email.js";
import {
  DIGEST_UNSUB_KIND,
  loadDigestRecipients,
} from "./statusDigest.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Ad-hoc announcement emails to the status-digest recipient roster.
 *
 * Manual-only (no cron). Scoped to one group. Uses the same
 * `status_digest_recipients` list and digest unsubscribe token so
 * one-click unsub removes the address from that shared roster.
 *
 * `notification_log.week_of` stores the Chicago calendar day for
 * observability; each real send clears that day's announcement rows
 * for the group so a re-send is allowed.
 */

export const ANNOUNCEMENT_KIND = "announcement";

export type AnnouncementRunResult = {
  recipients: number;
  sent: number;
  errors: number;
  dayOf: string;
  dryRun: boolean;
  subject: string;
};

function reportingTodayIso(now: Date = new Date()): string {
  return formatInTimeZone(now, config.reportingTimezone, "yyyy-MM-dd");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → simple HTML paragraphs (escaped). */
function bodyToHtml(body: string): string {
  const paragraphs = body
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return "";
  return paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function renderAnnouncement(input: {
  subject: string;
  body: string;
  groupName: string;
  recipientName?: string | null;
  appUrl: string;
  unsubscribeUrl: string;
}): { subject: string; text: string; html: string } {
  const { subject, body, groupName, recipientName, appUrl, unsubscribeUrl } = input;
  const first = recipientName?.split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";

  const text = [
    greeting,
    "",
    body.trim(),
    "",
    `Open Waypoint: ${appUrl}`,
    "",
    `You're receiving this because an admin added your address to the ${groupName} digest list.`,
    "Don't want these emails? Unsubscribe with one click:",
    unsubscribeUrl,
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:520px;">
      <p>${escapeHtml(greeting)}</p>
      ${bodyToHtml(body)}
      <p style="margin-top:16px;"><a href="${appUrl}" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open Waypoint</a></p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        You're receiving this because an admin added your address to the ${escapeHtml(groupName)} digest list.
        <a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe with one click</a>.
      </p>
    </div>
  `.trim();

  return { subject: subject.trim(), text, html };
}

export async function runAnnouncement({
  subject,
  body,
  dryRun = false,
  scopeGroupId,
}: {
  subject: string;
  body: string;
  dryRun?: boolean;
  scopeGroupId: string;
}): Promise<AnnouncementRunResult> {
  const subjectText = subject.trim();
  const bodyText = body.trim();
  if (!subjectText) throw new Error("subject is required");
  if (!bodyText) throw new Error("body is required");

  const dayOf = reportingTodayIso();
  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const groupConstants = await loadGroupConstants({ groupId: scopeGroupId });
  const byGroup = await loadDigestRecipients({ groupId: scopeGroupId });
  const recipients = byGroup.get(scopeGroupId) ?? [];

  const { rows: groupRows } = await query<{ name: string }>(
    `SELECT name FROM groups WHERE id = $1`,
    [scopeGroupId],
  );
  const groupName = groupRows[0]?.name ?? "your workspace";

  if (!dryRun && recipients.length) {
    const deleted = await query(
      `DELETE FROM notification_log
        WHERE kind = $1 AND week_of = $2::date AND group_id = $3`,
      [ANNOUNCEMENT_KIND, dayOf, scopeGroupId],
    );
    console.log(
      `[announcement] cleared ${deleted.rowCount ?? 0} notification_log row(s) before send`,
    );
  }

  let sent = 0;
  let errors = 0;

  for (const r of recipients) {
    try {
      const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
        makeUnsubscribeToken(r.id, DIGEST_UNSUB_KIND),
      )}`;
      const msg = renderAnnouncement({
        subject: subjectText,
        body: bodyText,
        groupName,
        recipientName: r.user_name,
        appUrl,
        unsubscribeUrl: unsubUrl,
      });

      if (dryRun) {
        console.log(`[announcement] DRY RUN — would send to ${r.email}: ${msg.subject}`);
        sent += 1;
        continue;
      }

      await query(
        `INSERT INTO notification_log
           (user_id, group_id, kind, week_of, recipient_email, provider_message_id)
         VALUES ($1, $2, $3, $4::date, $5, NULL)`,
        [r.user_id, scopeGroupId, ANNOUNCEMENT_KIND, dayOf, r.email],
      );

      const result = await sendEmail({
        to: r.email,
        from: config.email.formatFrom(groupConstants.get(scopeGroupId)?.email_title),
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (!result.delivered) {
        throw new Error("RESEND_API_KEY not set — email was not delivered");
      }
      await query(
        `UPDATE notification_log
            SET provider_message_id = $1
          WHERE kind = $2 AND group_id = $3 AND LOWER(recipient_email) = LOWER($4) AND week_of = $5::date`,
        [result.messageId, ANNOUNCEMENT_KIND, scopeGroupId, r.email, dayOf],
      );
      sent += 1;
    } catch (err) {
      errors += 1;
      console.error(`[announcement] send failed for email=${r.email}:`, err);
      try {
        await query(
          `DELETE FROM notification_log
            WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date AND provider_message_id IS NULL`,
          [ANNOUNCEMENT_KIND, scopeGroupId, r.email, dayOf],
        );
      } catch (cleanupErr) {
        console.error(`[announcement] cleanup failed for ${r.email}:`, cleanupErr);
      }
    }
  }

  console.log(
    `[announcement] group=${scopeGroupId} dryRun=${dryRun} day=${dayOf} recipients=${recipients.length} sent=${sent} errors=${errors}`,
  );

  return {
    recipients: recipients.length,
    sent,
    errors,
    dayOf,
    dryRun,
    subject: subjectText,
  };
}
