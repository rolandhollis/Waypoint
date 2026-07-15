import { config } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { weekOfMonday } from "../lib/time.js";
import { sendEmail } from "./email.js";

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

type UpdateRow = {
  project_id: string;
  project_title: string;
  swim_lane_id: string;
  swim_lane_name: string;
  // Positional column on swim_lanes is called "order" — quoted
  // because it's a reserved word in SQL.
  swim_lane_order: number;
  health_flag: "white" | "green" | "yellow" | "red";
  executive_summary: string;
  detailed_update: unknown;
  owner_name: string | null;
  submitted_by_name: string | null;
};

type GroupBundle = {
  groupId: string;
  groupName: string;
  updates: UpdateRow[];
};

async function loadRecipients(
  groupId: string,
): Promise<Array<{ id: string; email: string; user_id: string | null; user_name: string | null }>> {
  const { rows } = await query<{
    id: string;
    email: string;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
  }>(
    `SELECT r.id,
            r.email,
            r.user_id,
            u.name AS user_name,
            u.email AS user_email
       FROM status_digest_recipients r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.group_id = $1`,
    [groupId],
  );
  return rows.map((r) => ({
    id: r.id,
    // User-linked rows resolve to the user's current email, matching
    // what the admin UI shows in the list. Ad-hoc rows use their
    // stored email verbatim.
    email: r.user_id && r.user_email ? r.user_email : r.email,
    user_id: r.user_id,
    user_name: r.user_name,
  }));
}

async function loadUpdatesForWeek(groupId: string, weekIso: string): Promise<UpdateRow[]> {
  const { rows } = await query<UpdateRow>(
    `SELECT p.id AS project_id,
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
      ORDER BY s."order" NULLS LAST, s.name, p.title`,
    [weekIso, groupId],
  );
  return rows;
}

async function collectByGroup(
  weekIso: string,
  scopeGroupId?: string,
): Promise<GroupBundle[]> {
  const { rows: groups } = await query<{ id: string; name: string }>(
    scopeGroupId
      ? `SELECT id, name FROM groups WHERE id = $1`
      : `SELECT id, name FROM groups`,
    scopeGroupId ? [scopeGroupId] : [],
  );

  const out: GroupBundle[] = [];
  for (const g of groups) {
    const updates = await loadUpdatesForWeek(g.id, weekIso);
    out.push({ groupId: g.id, groupName: g.name, updates });
  }
  return out;
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

function renderDigest(input: {
  groupName: string;
  weekOf: Date;
  updates: UpdateRow[];
  appUrl: string;
  recipientName?: string;
}): { subject: string; text: string; html: string } {
  const { groupName, weekOf, updates, appUrl, recipientName } = input;
  const weekLabel = weekOf.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: config.reportingTimezone,
  });
  const subject = `Waypoint · ${groupName} weekly update — ${weekLabel}`;

  // Group by swim lane for both plain-text and HTML renders.
  const byLane = new Map<string, UpdateRow[]>();
  for (const u of updates) {
    const key = u.swim_lane_name ?? "(no lane)";
    const arr = byLane.get(key) ?? [];
    arr.push(u);
    byLane.set(key, arr);
  }

  const greeting = recipientName ? `Hi ${recipientName.split(/\s+/)[0] ?? recipientName},` : "Hello,";

  const textLines: string[] = [];
  textLines.push(greeting);
  textLines.push("");
  textLines.push(`${groupName} status updates for the week of ${weekLabel}:`);
  textLines.push("");
  for (const [lane, items] of byLane) {
    textLines.push(`--- ${lane} ---`);
    for (const u of items) {
      textLines.push(`• ${u.project_title} [${healthLabel(u.health_flag)}]`);
      if (u.owner_name) textLines.push(`   Owner: ${u.owner_name}`);
      if (u.executive_summary?.trim()) {
        textLines.push(`   ${u.executive_summary.trim()}`);
      }
      const bs = bullets(u.detailed_update);
      for (const b of bs) textLines.push(`   - ${b}`);
      textLines.push("");
    }
  }
  textLines.push(`Open Waypoint: ${appUrl}/status-report`);
  textLines.push("");
  textLines.push("— Waypoint");
  const text = textLines.join("\n");

  const preheader = `${updates.length} update${updates.length === 1 ? "" : "s"} across ${byLane.size} lane${byLane.size === 1 ? "" : "s"} for ${groupName}.`;
  const laneHtml = Array.from(byLane.entries())
    .map(
      ([lane, items]) => `
    <section style="margin-top:22px;">
      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#334155;margin:0 0 8px;">${escapeHtml(lane)}</h2>
      ${items
        .map((u) => {
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
          return `
        <article style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:baseline;gap:8px;justify-content:space-between;">
            <strong style="color:#0f172a;">${escapeHtml(u.project_title)}</strong>
            <span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:9999px;background:${healthColor(u.health_flag)};color:#fff;">${escapeHtml(healthLabel(u.health_flag))}</span>
          </div>
          ${ownerHtml}
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
      <p>Here's the <strong>${escapeHtml(groupName)}</strong> weekly status rollup for the week of <strong>${escapeHtml(weekLabel)}</strong> — ${updates.length} update${updates.length === 1 ? "" : "s"} across ${byLane.size} swim lane${byLane.size === 1 ? "" : "s"}.</p>
      ${laneHtml}
      <p style="margin-top:24px;">
        <a href="${appUrl}/status-report" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open Waypoint</a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:16px;">
        You're receiving this because a Waypoint admin added your address to the ${escapeHtml(groupName)} digest list. Ask a Waypoint admin to remove you if you'd prefer not to receive it.
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
  groups: number;
  recipients: number;
  updatesIncluded: number;
  sent: number;
  skippedAlreadySent: number;
  skippedEmptyGroups: number;
  errors: number;
};

export async function runStatusReportDigest({
  dryRun = false,
  scopeGroupId,
}: { dryRun?: boolean; scopeGroupId?: string } = {}): Promise<DigestRunResult> {
  const week = weekOfMonday(new Date());
  const weekIso = week.toISOString().slice(0, 10);
  const appUrl = config.publicAppUrl.replace(/\/$/, "");

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
    const list = await loadRecipients(bundle.groupId);
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

        const msg = renderDigest({
          groupName: bundle.groupName,
          weekOf: week,
          updates: bundle.updates,
          appUrl,
          recipientName: r.user_name ?? undefined,
        });

        if (dryRun) {
          console.log(`[digest] DRY RUN — would send to ${r.email}: ${msg.subject}`);
          sent += 1;
          // Undo the reservation so a real run isn't blocked.
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
        });
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
    `[digest] status_report_digest scope=${scopeGroupId ?? "global"} dryRun=${dryRun} groups=${bundles.length} recipients=${recipients} updates=${updatesIncluded} sent=${sent} alreadySent=${skipped} skippedEmptyGroups=${skippedEmpty} errors=${errors}`,
  );

  return {
    weekOf: weekIso,
    dryRun,
    groups: bundles.length,
    recipients,
    updatesIncluded,
    sent,
    skippedAlreadySent: skipped,
    skippedEmptyGroups: skippedEmpty,
    errors,
  };
}
