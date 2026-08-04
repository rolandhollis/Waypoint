import { config } from "../config.js";
import { pool, query, withTransaction } from "../db/pool.js";
import { weekOfMonday } from "../lib/time.js";
import { compareSwimLaneReportOrder } from "../lib/statusReportOrder.js";
import { sendEmail } from "./email.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Friday-afternoon status-report digest.
 *
 * Fan-out shape:
 *   1. For every tenant (or one when scopeGroupId is set), gather
 *      the roster of digest recipients from status_digest_recipients.
 *   2. For that same tenant, load every completed weekly_status_update
 *      for the current week, joined with project + swim lane so we
 *      can group by lane in the email body.
 *   3. Send one email per recipient. Bodies are the same within a
 *      group (all recipients see the same weekly rollup) but each
 *      recipient gets their own message so unsubscribe / delivery
 *      state is independent.
 *   4. notification_log gets a row per send with kind='status_report_digest'
 *      so the same (group, email, week) combination can never
 *      double-send — the unique partial index does the enforcement.
 *
 * If a group has zero recipients OR zero completed updates for the
 * current week, we skip it silently rather than sending a "nothing
 * to report" email — that would train recipients to ignore the
 * message when it does have content.
 */

const KIND = "status_report_digest";

/** Token kind for one-click digest unsubscribe (recipient row id in payload). */
export const DIGEST_UNSUB_KIND = "status_digest_unsubscribe";

type UpdateRow = {
  project_id: string;
  project_title: string;
  swim_lane_id: string;
  swim_lane_name: string;
  swim_lane_order: number;
  health_flag: "white" | "green" | "yellow" | "red";
  executive_summary: string;
  detailed_update: unknown;
  owner_name: string | null;
  submitted_by_name: string | null;
};

type DigestRecipient = {
  id: string;
  email: string;
  user_id: string | null;
  user_name: string | null;
};

type GroupBundle = {
  groupId: string;
  groupName: string;
  updates: UpdateRow[];
  recipients: DigestRecipient[];
};

async function loadRecipientsBatch(scopeGroupId?: string): Promise<Map<string, DigestRecipient[]>> {
  const { rows } = await query<{
    group_id: string;
    id: string;
    email: string;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
  }>(
    scopeGroupId
      ? `SELECT r.group_id,
                r.id,
                r.email,
                r.user_id,
                u.name AS user_name,
                u.email AS user_email
           FROM status_digest_recipients r
           LEFT JOIN users u ON u.id = r.user_id
          WHERE r.group_id = $1`
      : `SELECT r.group_id,
                r.id,
                r.email,
                r.user_id,
                u.name AS user_name,
                u.email AS user_email
           FROM status_digest_recipients r
           LEFT JOIN users u ON u.id = r.user_id`,
    scopeGroupId ? [scopeGroupId] : [],
  );

  const out = new Map<string, DigestRecipient[]>();
  for (const r of rows) {
    const recipient: DigestRecipient = {
      id: r.id,
      email: r.user_id && r.user_email ? r.user_email : r.email,
      user_id: r.user_id,
      user_name: r.user_name,
    };
    const list = out.get(r.group_id) ?? [];
    list.push(recipient);
    out.set(r.group_id, list);
  }
  return out;
}

async function loadUpdatesBatch(weekIso: string, scopeGroupId?: string): Promise<Map<string, UpdateRow[]>> {
  const { rows } = await query<UpdateRow & { group_id: string }>(
    scopeGroupId
      ? `SELECT p.group_id,
                p.id AS project_id,
                p.title AS project_title,
                s.id AS swim_lane_id,
                s.name AS swim_lane_name,
                s."order" AS swim_lane_order,
                w.health_flag,
                w.executive_summary,
                w.detailed_update,
                owner.name AS owner_name,
                submitter.name AS submitted_by_name
           FROM weekly_status_updates w
           JOIN projects p ON p.id = w.project_id
           LEFT JOIN swim_lanes s ON s.id = p.swim_lane_id
           LEFT JOIN users owner ON owner.id = p.owner_id
           LEFT JOIN users submitter ON submitter.id = w.submitted_by_user_id
          WHERE w.week_of = $1::date
            AND w.completed = TRUE
            AND p.group_id = $2
            AND p.deleted_at IS NULL
          ORDER BY s."order" DESC NULLS LAST, s.name, p.title`
      : `SELECT p.group_id,
                p.id AS project_id,
                p.title AS project_title,
                s.id AS swim_lane_id,
                s.name AS swim_lane_name,
                s."order" AS swim_lane_order,
                w.health_flag,
                w.executive_summary,
                w.detailed_update,
                owner.name AS owner_name,
                submitter.name AS submitted_by_name
           FROM weekly_status_updates w
           JOIN projects p ON p.id = w.project_id
           LEFT JOIN swim_lanes s ON s.id = p.swim_lane_id
           LEFT JOIN users owner ON owner.id = p.owner_id
           LEFT JOIN users submitter ON submitter.id = w.submitted_by_user_id
          WHERE w.week_of = $1::date
            AND w.completed = TRUE
            AND p.deleted_at IS NULL
          ORDER BY p.group_id, s."order" DESC NULLS LAST, s.name, p.title`,
    scopeGroupId ? [weekIso, scopeGroupId] : [weekIso],
  );

  const out = new Map<string, UpdateRow[]>();
  for (const row of rows) {
    const { group_id, ...update } = row;
    const list = out.get(group_id) ?? [];
    list.push(update);
    out.set(group_id, list);
  }
  return out;
}

async function collectByGroup(weekIso: string, scopeGroupId?: string): Promise<GroupBundle[]> {
  const { rows: groups } = await query<{ id: string; name: string }>(
    scopeGroupId
      ? `SELECT id, name FROM groups WHERE id = $1`
      : `SELECT id, name FROM groups`,
    scopeGroupId ? [scopeGroupId] : [],
  );

  const updatesByGroup = await loadUpdatesBatch(weekIso, scopeGroupId);
  const recipientsByGroup = await loadRecipientsBatch(scopeGroupId);

  return groups.map((g) => ({
    groupId: g.id,
    groupName: g.name,
    updates: updatesByGroup.get(g.id) ?? [],
    recipients: recipientsByGroup.get(g.id) ?? [],
  }));
}

function healthLabel(flag: UpdateRow["health_flag"]): string {
  switch (flag) {
    case "green":
      return "On track";
    case "yellow":
      return "At risk";
    case "red":
      return "Blocked";
    case "white":
    default:
      return "Not flagged";
  }
}

function healthColor(flag: UpdateRow["health_flag"]): string {
  switch (flag) {
    case "green":
      return "#16a34a";
    case "yellow":
      return "#ca8a04";
    case "red":
      return "#dc2626";
    case "white":
    default:
      return "#64748b";
  }
}

function bullets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") {
        return (b as { text: string }).text;
      }
      return "";
    })
    .filter((s) => s.trim().length > 0);
}

function laneGroupsForReport(updates: UpdateRow[]): Array<{ laneName: string; laneOrder: number | null; items: UpdateRow[] }> {
  const byLane = new Map<string, { laneName: string; laneOrder: number | null; items: UpdateRow[] }>();
  for (const u of updates) {
    const key = u.swim_lane_id ?? u.swim_lane_name ?? "(no lane)";
    const existing = byLane.get(key);
    if (existing) {
      existing.items.push(u);
    } else {
      byLane.set(key, {
        laneName: u.swim_lane_name ?? "(no lane)",
        laneOrder: u.swim_lane_order ?? null,
        items: [u],
      });
    }
  }
  return Array.from(byLane.values()).sort((a, b) =>
    compareSwimLaneReportOrder(a.laneOrder, b.laneOrder, a.laneName, b.laneName),
  );
}

function renderDigest(input: {
  groupName: string;
  weekOf: Date;
  updates: UpdateRow[];
  appUrl: string;
  recipientName?: string;
  unsubscribeUrl: string;
}): { subject: string; text: string; html: string } {
  const { groupName, weekOf, updates, appUrl, recipientName, unsubscribeUrl } = input;
  const weekLabel = weekOf.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: config.reportingTimezone,
  });
  const subject = `Waypoint · ${groupName} weekly update — ${weekLabel}`;

  const laneGroups = laneGroupsForReport(updates);
  const laneCount = laneGroups.length;

  const greeting = recipientName ? `Hi ${recipientName.split(/\s+/)[0] ?? recipientName},` : "Hello,";

  const textLines: string[] = [];
  textLines.push(greeting);
  textLines.push("");
  textLines.push(`${groupName} status updates for the week of ${weekLabel}:`);
  textLines.push("");
  for (const { laneName, items } of laneGroups) {
    textLines.push(`--- ${laneName} ---`);
    for (const u of items) {
      const projectUrl = `${appUrl}/projects/${u.project_id}`;
      textLines.push(`• ${u.project_title} [${healthLabel(u.health_flag)}]`);
      textLines.push(`   ${projectUrl}`);
      if (u.owner_name) textLines.push(`   Owner: ${u.owner_name}`);
      if (u.submitted_by_name) textLines.push(`   Submitted by: ${u.submitted_by_name}`);
      if (u.executive_summary?.trim()) {
        textLines.push(`   ${u.executive_summary.trim()}`);
      }
      const bs = bullets(u.detailed_update);
      for (const b of bs) textLines.push(`   - ${b}`);
      textLines.push("");
    }
  }
  textLines.push(`Open status report: ${appUrl}/status-report`);
  textLines.push("");
  textLines.push("Unsubscribe from digest emails:");
  textLines.push(unsubscribeUrl);
  textLines.push("");
  textLines.push("— Waypoint");
  const text = textLines.join("\n");

  const preheader = `${updates.length} update${updates.length === 1 ? "" : "s"} across ${laneCount} lane${laneCount === 1 ? "" : "s"} for ${groupName}.`;
  const laneHtml = laneGroups
    .map(
      ({ laneName, items }) => `
    <section style="margin-top:22px;">
      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#334155;margin:0 0 8px;">${escapeHtml(laneName)}</h2>
      ${items
        .map((u) => {
          const projectUrl = `${appUrl}/projects/${u.project_id}`;
          const bs = bullets(u.detailed_update);
          const bulletsHtml = bs.length
            ? `<ul style="margin:6px 0 0;padding-left:18px;color:#334155;">${bs
                .map((b) => `<li style="margin:2px 0;">${escapeHtml(b)}</li>`)
                .join("")}</ul>`
            : "";
          const summaryHtml = u.executive_summary?.trim()
            ? `<p style="margin:6px 0 0;color:#334155;">${escapeHtml(u.executive_summary.trim())}</p>`
            : "";
          const ownerHtml = u.owner_name
            ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">Owner: ${escapeHtml(u.owner_name)}</div>`
            : "";
          const submitterHtml = u.submitted_by_name
            ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">Submitted by: ${escapeHtml(u.submitted_by_name)}</div>`
            : "";
          return `
        <article style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;">
            <a href="${projectUrl}" style="font-weight:600;color:#0f172a;text-decoration:none;margin-right:12px;">${escapeHtml(u.project_title)}</a>
            <span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:9999px;margin-left:8px;background:${healthColor(u.health_flag)};color:#fff;flex-shrink:0;">${escapeHtml(healthLabel(u.health_flag))}</span>
          </div>
          ${ownerHtml}
          ${submitterHtml}
          ${summaryHtml}
          ${bulletsHtml}
        </article>`;
        })
        .join("")}
    </section>`,
    )
    .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px;">
      <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
      <p>${escapeHtml(greeting)}</p>
      <p>Here's the <strong>${escapeHtml(groupName)}</strong> weekly status rollup for the week of <strong>${escapeHtml(weekLabel)}</strong> — ${updates.length} update${updates.length === 1 ? "" : "s"} across ${laneCount} swim lane${laneCount === 1 ? "" : "s"}.</p>
      ${laneHtml}
      <p style="margin-top:24px;">
        <a href="${appUrl}/status-report" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open status report</a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:16px;">
        You're receiving this because a Waypoint admin added your address to the ${escapeHtml(groupName)} digest list.
        <a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe with one click</a>.
      </p>
    </div>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type DigestRunResult = {
  weekOf: string;
  dryRun: boolean;
  forceResend: boolean;
  groups: number;
  recipients: number;
  updatesIncluded: number;
  sent: number;
  skippedAlreadySent: number;
  skippedEmptyGroups: number;
  errors: number;
};

export async function removeDigestRecipient(recipientId: string): Promise<{ email: string } | null> {
  const { rows } = await pool.query<{ email: string }>(
    `DELETE FROM status_digest_recipients WHERE id = $1 RETURNING email`,
    [recipientId],
  );
  return rows[0] ?? null;
}

export async function runStatusReportDigest({
  dryRun = false,
  forceResend = false,
  scopeGroupId,
}: { dryRun?: boolean; forceResend?: boolean; scopeGroupId?: string } = {}): Promise<DigestRunResult> {
  const week = weekOfMonday(new Date());
  const weekIso = week.toISOString().slice(0, 10);
  const appUrl = config.publicAppUrl.replace(/\/$/, "");

  if (forceResend && !dryRun) {
    const deleted = await query(
      scopeGroupId
        ? `DELETE FROM notification_log
            WHERE kind = $1 AND week_of = $2::date AND group_id = $3`
        : `DELETE FROM notification_log
            WHERE kind = $1 AND week_of = $2::date`,
      scopeGroupId ? [KIND, weekIso, scopeGroupId] : [KIND, weekIso],
    );
    console.log(`[digest] force_resend cleared ${deleted.rowCount ?? 0} notification_log row(s)`);
  }

  const bundles = await collectByGroup(weekIso, scopeGroupId);

  let recipients = 0;
  let updatesIncluded = 0;
  let sent = 0;
  let skipped = 0;
  let skippedEmpty = 0;
  let errors = 0;

  for (const bundle of bundles) {
    if (!bundle.updates.length) {
      skippedEmpty += 1;
      continue;
    }
    updatesIncluded += bundle.updates.length;
    const list = bundle.recipients;
    recipients += list.length;
    if (!list.length) continue;

    for (const r of list) {
      try {
        const alreadySent = await withTransaction(async (client) => {
          try {
            await client.query(
              `INSERT INTO notification_log
                 (user_id, group_id, kind, week_of, recipient_email, provider_message_id)
               VALUES ($1, $2, $3, $4::date, $5, NULL)`,
              [r.user_id, bundle.groupId, KIND, weekIso, r.email],
            );
            return false;
          } catch (e) {
            if ((e as { code?: string }).code === "23505") return true;
            throw e;
          }
        });
        if (alreadySent) {
          skipped += 1;
          continue;
        }

        const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
          makeUnsubscribeToken(r.id, DIGEST_UNSUB_KIND),
        )}`;
        const msg = renderDigest({
          groupName: bundle.groupName,
          weekOf: week,
          updates: bundle.updates,
          appUrl,
          recipientName: r.user_name ?? undefined,
          unsubscribeUrl: unsubUrl,
        });

        if (dryRun) {
          console.log(`[digest] DRY RUN — would send to ${r.email}: ${msg.subject}`);
          sent += 1;
          await query(
            `DELETE FROM notification_log
              WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date`,
            [KIND, bundle.groupId, r.email, weekIso],
          );
          continue;
        }

        const result = await sendEmail({
          to: r.email,
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
          [result.messageId, KIND, bundle.groupId, r.email, weekIso],
        );
        sent += 1;
      } catch (err) {
        errors += 1;
        console.error(`[digest] send failed for group=${bundle.groupId} email=${r.email}:`, err);
        try {
          await query(
            `DELETE FROM notification_log
              WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date AND provider_message_id IS NULL`,
            [KIND, bundle.groupId, r.email, weekIso],
          );
        } catch (cleanupErr) {
          console.error(`[digest] cleanup failed for ${r.email}:`, cleanupErr);
        }
      }
    }
  }

  console.log(
    `[digest] status_report_digest scope=${scopeGroupId ?? "global"} dryRun=${dryRun} forceResend=${forceResend} groups=${bundles.length} recipients=${recipients} updates=${updatesIncluded} sent=${sent} alreadySent=${skipped} skippedEmptyGroups=${skippedEmpty} errors=${errors}`,
  );

  return {
    weekOf: weekIso,
    dryRun,
    forceResend,
    groups: bundles.length,
    recipients,
    updatesIncluded,
    sent,
    skippedAlreadySent: skipped,
    skippedEmptyGroups: skippedEmpty,
    errors,
  };
}
