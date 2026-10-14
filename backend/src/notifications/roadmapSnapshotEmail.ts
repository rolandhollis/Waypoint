import { formatInTimeZone } from "date-fns-tz";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { loadGroupConstants } from "../lib/groupConstants.js";
import { sendEmail, type EmailAttachment } from "./email.js";
import {
  DIGEST_UNSUB_KIND,
  loadDigestRecipients,
} from "./statusDigest.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Ad-hoc roadmap snapshot email to the status-digest recipient roster.
 *
 * Manual-only (no cron). The admin UI captures one Compact 3-month
 * PNG per team in the browser, then POSTs the images here. We embed
 * each PNG inline (cid:) under a team headline so the message reads
 * as a vertical stack of team roadmaps.
 */

export const ROADMAP_SNAPSHOT_KIND = "roadmap_snapshot";

/** Mark a group as needing a roadmap snapshot email (after digest). */
export async function enqueueRoadmapSnapshotFollowup(
  groupId: string,
  digestWeekOf?: string | null,
): Promise<void> {
  await query(
    `INSERT INTO roadmap_snapshot_followups (group_id, digest_week_of, requested_at, source)
     VALUES ($1, $2::date, NOW(), 'status_digest')
     ON CONFLICT (group_id) DO UPDATE
       SET requested_at = NOW(),
           digest_week_of = EXCLUDED.digest_week_of,
           source = EXCLUDED.source`,
    [groupId, digestWeekOf ?? null],
  );
}

export async function getRoadmapSnapshotFollowup(
  groupId: string,
): Promise<{ requestedAt: string; digestWeekOf: string | null } | null> {
  const { rows } = await query<{
    requested_at: Date | string;
    digest_week_of: Date | string | null;
  }>(
    `SELECT requested_at, digest_week_of
       FROM roadmap_snapshot_followups
      WHERE group_id = $1`,
    [groupId],
  );
  const row = rows[0];
  if (!row) return null;
  const requestedAt =
    row.requested_at instanceof Date
      ? row.requested_at.toISOString()
      : String(row.requested_at);
  const digestWeekOf =
    row.digest_week_of == null
      ? null
      : row.digest_week_of instanceof Date
        ? row.digest_week_of.toISOString().slice(0, 10)
        : String(row.digest_week_of).slice(0, 10);
  return { requestedAt, digestWeekOf };
}

export async function clearRoadmapSnapshotFollowup(groupId: string): Promise<void> {
  await query(`DELETE FROM roadmap_snapshot_followups WHERE group_id = $1`, [groupId]);
}

export type RoadmapSnapshotTeamImage = {
  teamId: string;
  teamName: string;
  /** Raw PNG bytes (already decoded from the client's base64). */
  png: Buffer;
  /** Epic titles currently in a development-classified swim lane. */
  inDevelopment: string[];
};

export type RoadmapSnapshotRunResult = {
  recipients: number;
  sent: number;
  errors: number;
  dayOf: string;
  dryRun: boolean;
  /** True when the send targeted only the requesting admin. */
  testToSelf: boolean;
  subject: string;
  teamCount: number;
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

function slugFilename(name: string, teamId: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `roadmap-${slug || "team"}-${teamId.slice(0, 8)}.png`;
}

function contentIdForTeam(teamId: string): string {
  // Resend contentIds should be email-safe tokens; UUIDs are fine.
  return `team-${teamId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Deep link matching the Compact 3-month capture (team filter + zoom). */
export function roadmapTeamDeepLink(appUrl: string, teamId: string): string {
  const base = appUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    zoom: "3mo",
    teams: teamId,
  });
  return `${base}/roadmap?${params.toString()}`;
}

function renderInDevelopmentList(titles: string[]): { text: string; html: string } {
  if (!titles.length) {
    return {
      text: "  In development: (none)",
      html: `<p style="margin:0 0 10px 0;font-size:13px;color:#64748b;">In development: none</p>`,
    };
  }
  const text = ["  In development:", ...titles.map((t) => `  - ${t}`)].join("\n");
  const items = titles
    .map((t) => `<li style="margin:0 0 2px 0;">${escapeHtml(t)}</li>`)
    .join("");
  const html = `
    <div style="margin:0 0 10px 0;">
      <p style="margin:0 0 4px 0;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#64748b;">
        In development
      </p>
      <ul style="margin:0;padding:0 0 0 18px;font-size:13px;color:#0f172a;line-height:1.45;">
        ${items}
      </ul>
    </div>
  `.trim();
  return { text, html };
}

function renderRoadmapSnapshot(input: {
  subject: string;
  intro?: string | null;
  groupName: string;
  recipientName?: string | null;
  appUrl: string;
  /** Digestion-list unsub link; omit for admin test-to-self sends. */
  unsubscribeUrl?: string | null;
  testToSelf?: boolean;
  teams: Array<{
    teamId: string;
    teamName: string;
    contentId: string;
    roadmapUrl: string;
    inDevelopment: string[];
  }>;
  rangeLabel: string;
}): { subject: string; text: string; html: string } {
  const {
    subject,
    intro,
    groupName,
    recipientName,
    appUrl,
    unsubscribeUrl,
    testToSelf,
    teams,
    rangeLabel,
  } = input;
  const first = recipientName?.split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";
  const introText = (intro ?? "").trim();
  const subjectOut = testToSelf
    ? `[Test] ${subject.trim()}`
    : subject.trim();

  const footerText = testToSelf
    ? [
        `This was a test send to you as a ${groupName} admin — the distribution list was not emailed.`,
      ]
    : [
        `You're receiving this because an admin added your address to the ${groupName} digest list.`,
        "Don't want these emails? Unsubscribe with one click:",
        unsubscribeUrl ?? "",
      ];

  const footerHtml = testToSelf
    ? `<p style="color:#64748b;font-size:12px;margin-top:24px;">
        This was a test send to you as a ${escapeHtml(groupName)} admin — the distribution list was not emailed.
      </p>`
    : `<p style="color:#64748b;font-size:12px;margin-top:24px;">
        You're receiving this because an admin added your address to the ${escapeHtml(groupName)} digest list.
        ${
          unsubscribeUrl
            ? `<a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe with one click</a>.`
            : ""
        }
      </p>`;

  const textParts = [
    greeting,
    "",
    introText || `Here's the ${groupName} roadmap snapshot (${rangeLabel}).`,
    "",
    ...teams.flatMap((t) => {
      const inDev = renderInDevelopmentList(t.inDevelopment);
      return [
        t.teamName,
        inDev.text,
        `  Open filtered roadmap: ${t.roadmapUrl}`,
        "",
      ];
    }),
    `(Team roadmap images are attached / shown in the HTML version of this email.)`,
    "",
    `Open Waypoint: ${appUrl}/roadmap`,
    "",
    ...footerText,
  ];

  const teamBlocksHtml = teams
    .map((t) => {
      const inDev = renderInDevelopmentList(t.inDevelopment);
      return `
      <div style="margin:0 0 28px 0;">
        <h2 style="margin:0 0 8px 0;font-size:18px;line-height:1.3;">
          <a href="${escapeHtml(t.roadmapUrl)}" style="color:#0f172a;text-decoration:none;">
            ${escapeHtml(t.teamName)}
          </a>
        </h2>
        ${inDev.html}
        <a href="${escapeHtml(t.roadmapUrl)}" style="display:block;text-decoration:none;">
          <img
            src="cid:${t.contentId}"
            alt="${escapeHtml(t.teamName)} roadmap — open in Waypoint"
            width="100%"
            style="display:block;width:100%;max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:8px;background:#fff;"
          />
        </a>
      </div>`;
    })
    .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:720px;">
      <p>${escapeHtml(greeting)}</p>
      ${
        introText
          ? `<p>${escapeHtml(introText)}</p>`
          : `<p>Here's the ${escapeHtml(groupName)} roadmap snapshot for the next ${escapeHtml(rangeLabel)}. Click a chart to open that team's roadmap in Waypoint.</p>`
      }
      ${teamBlocksHtml || `<p style="color:#64748b;">No team roadmaps were included.</p>`}
      <p style="margin-top:16px;"><a href="${appUrl}/roadmap" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open roadmap</a></p>
      ${footerHtml}
    </div>
  `.trim();

  return { subject: subjectOut, text: textParts.join("\n"), html };
}

export async function runRoadmapSnapshotEmail({
  subject,
  intro,
  teams,
  dryRun = false,
  testToSelf = null,
  scopeGroupId,
}: {
  subject: string;
  intro?: string | null;
  teams: RoadmapSnapshotTeamImage[];
  dryRun?: boolean;
  /**
   * When set, email only this admin — skips the digest roster and
   * does not touch notification_log (so a test never blocks or
   * clears a real distribution-list send).
   */
  testToSelf?: { email: string; userId: string; userName: string | null } | null;
  scopeGroupId: string;
}): Promise<RoadmapSnapshotRunResult> {
  const subjectText = subject.trim();
  if (!subjectText) throw new Error("subject is required");
  if (!dryRun && teams.length === 0) {
    throw new Error("at least one team roadmap image is required");
  }
  if (testToSelf && !testToSelf.email.trim()) {
    throw new Error("test recipient email is required");
  }

  const dayOf = reportingTodayIso();
  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const groupConstants = await loadGroupConstants({ groupId: scopeGroupId });
  const byGroup = await loadDigestRecipients({ groupId: scopeGroupId });
  const digestRecipients = byGroup.get(scopeGroupId) ?? [];

  type SendTarget = {
    id: string | null;
    email: string;
    user_id: string | null;
    user_name: string | null;
  };

  const recipients: SendTarget[] = testToSelf
    ? [
        {
          id: null,
          email: testToSelf.email.trim(),
          user_id: testToSelf.userId,
          user_name: testToSelf.userName,
        },
      ]
    : digestRecipients;

  const { rows: groupRows } = await query<{ name: string }>(
    `SELECT name FROM groups WHERE id = $1`,
    [scopeGroupId],
  );
  const groupName = groupRows[0]?.name ?? "your workspace";

  const teamMeta = teams.map((t) => ({
    teamId: t.teamId,
    teamName: t.teamName,
    contentId: contentIdForTeam(t.teamId),
    filename: slugFilename(t.teamName, t.teamId),
    png: t.png,
    inDevelopment: t.inDevelopment,
    roadmapUrl: roadmapTeamDeepLink(appUrl, t.teamId),
  }));

  const attachments: EmailAttachment[] = teamMeta.map((t) => ({
    filename: t.filename,
    content: t.png,
    contentType: "image/png",
    contentId: t.contentId,
  }));

  // Full-list sends clear today's log so a re-send is allowed.
  // Test-to-self never touches the digest log.
  if (!dryRun && !testToSelf && recipients.length) {
    const deleted = await query(
      `DELETE FROM notification_log
        WHERE kind = $1 AND week_of = $2::date AND group_id = $3`,
      [ROADMAP_SNAPSHOT_KIND, dayOf, scopeGroupId],
    );
    console.log(
      `[roadmap-snapshot] cleared ${deleted.rowCount ?? 0} notification_log row(s) before send`,
    );
  }

  let sent = 0;
  let errors = 0;

  for (const r of recipients) {
    try {
      const unsubUrl =
        !testToSelf && r.id
          ? `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
              makeUnsubscribeToken(r.id, DIGEST_UNSUB_KIND),
            )}`
          : null;
      const msg = renderRoadmapSnapshot({
        subject: subjectText,
        intro,
        groupName,
        recipientName: r.user_name,
        appUrl,
        unsubscribeUrl: unsubUrl,
        testToSelf: Boolean(testToSelf),
        teams: teamMeta.map((t) => ({
          teamId: t.teamId,
          teamName: t.teamName,
          contentId: t.contentId,
          roadmapUrl: t.roadmapUrl,
          inDevelopment: t.inDevelopment,
        })),
        rangeLabel: "3 months",
      });

      if (dryRun) {
        console.log(
          `[roadmap-snapshot] DRY RUN — would send to ${r.email}: ${msg.subject} (${teams.length} team image(s))${
            testToSelf ? " [test-to-self]" : ""
          }`,
        );
        sent += 1;
        continue;
      }

      if (!testToSelf) {
        await query(
          `INSERT INTO notification_log
             (user_id, group_id, kind, week_of, recipient_email, provider_message_id)
           VALUES ($1, $2, $3, $4::date, $5, NULL)`,
          [r.user_id, scopeGroupId, ROADMAP_SNAPSHOT_KIND, dayOf, r.email],
        );
      }

      const result = await sendEmail({
        to: r.email,
        from: config.email.formatFrom(groupConstants.get(scopeGroupId)?.email_title),
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments,
        ...(unsubUrl
          ? {
              headers: {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
      });
      if (!result.delivered) {
        throw new Error("RESEND_API_KEY not set — email was not delivered");
      }
      if (!testToSelf) {
        await query(
          `UPDATE notification_log
              SET provider_message_id = $1
            WHERE kind = $2 AND group_id = $3 AND LOWER(recipient_email) = LOWER($4) AND week_of = $5::date`,
          [result.messageId, ROADMAP_SNAPSHOT_KIND, scopeGroupId, r.email, dayOf],
        );
      }
      sent += 1;
    } catch (err) {
      errors += 1;
      console.error(`[roadmap-snapshot] send failed for email=${r.email}:`, err);
      if (!testToSelf) {
        try {
          await query(
            `DELETE FROM notification_log
              WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date AND provider_message_id IS NULL`,
            [ROADMAP_SNAPSHOT_KIND, scopeGroupId, r.email, dayOf],
          );
        } catch (cleanupErr) {
          console.error(`[roadmap-snapshot] cleanup failed for ${r.email}:`, cleanupErr);
        }
      }
    }
  }

  console.log(
    `[roadmap-snapshot] group=${scopeGroupId} dryRun=${dryRun} testToSelf=${Boolean(testToSelf)} day=${dayOf} teams=${teams.length} recipients=${recipients.length} sent=${sent} errors=${errors}`,
  );

  return {
    recipients: recipients.length,
    sent,
    errors,
    dayOf,
    dryRun,
    testToSelf: Boolean(testToSelf),
    subject: testToSelf ? `[Test] ${subjectText}` : subjectText,
    teamCount: teams.length,
  };
}
