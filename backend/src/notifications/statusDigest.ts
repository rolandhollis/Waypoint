import { config } from "../config.js";
import { pool, query } from "../db/pool.js";
import {
  loadGroupWeeklyStatusSchedules,
  type GroupScheduleScope,
} from "../lib/groupConstants.js";
import { compareSwimLaneReportOrder } from "../lib/statusReportOrder.js";
import { eligibleProjects } from "../routes/statusUpdates.js";
import {
  resolveWeeklyStatusSchedule,
  weekOfMondayForSchedule,
} from "../lib/weeklyStatusSchedule.js";
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
  global_priority: number;
  health_flag: "white" | "green" | "yellow" | "red";
  executive_summary: string;
  detailed_update: unknown;
  owner_name: string | null;
  submitted_by_name: string | null;
  team_names: string[];
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
  /** Eligible projects with no completed update this week, by owner. */
  missingByOwner: OwnerMissingGroup[];
};

type MissingProject = { project_id: string; project_title: string };

type OwnerMissingGroup = {
  ownerName: string;
  projects: MissingProject[];
};

async function loadRecipientsBatch(scope?: GroupScheduleScope): Promise<Map<string, DigestRecipient[]>> {
  const { rows } = await query<{
    group_id: string;
    id: string;
    email: string;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
  }>(
    scope?.groupId
      ? `SELECT r.group_id,
                r.id,
                r.email,
                r.user_id,
                u.name AS user_name,
                u.email AS user_email
           FROM status_digest_recipients r
           LEFT JOIN users u ON u.id = r.user_id
          WHERE r.group_id = $1`
      : scope?.groupIds?.length
        ? `SELECT r.group_id,
                  r.id,
                  r.email,
                  r.user_id,
                  u.name AS user_name,
                  u.email AS user_email
             FROM status_digest_recipients r
             LEFT JOIN users u ON u.id = r.user_id
            WHERE r.group_id = ANY($1::uuid[])`
        : `SELECT r.group_id,
                  r.id,
                  r.email,
                  r.user_id,
                  u.name AS user_name,
                  u.email AS user_email
             FROM status_digest_recipients r
             LEFT JOIN users u ON u.id = r.user_id`,
    scope?.groupId
      ? [scope.groupId]
      : scope?.groupIds?.length
        ? [scope.groupIds]
        : [],
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

async function loadUpdatesBatch(weekIso: string, scope?: GroupScheduleScope): Promise<Map<string, UpdateRow[]>> {
  const { rows } = await query<UpdateRow & { group_id: string }>(
    scope?.groupId
      ? `SELECT p.group_id,
                p.id AS project_id,
                p.title AS project_title,
                s.id AS swim_lane_id,
                s.name AS swim_lane_name,
                s."order" AS swim_lane_order,
                p.global_priority,
                w.health_flag,
                w.executive_summary,
                w.detailed_update,
                owner.name AS owner_name,
                submitter.name AS submitted_by_name,
                COALESCE(
                  (SELECT array_agg(t.name ORDER BY pt.position ASC)
                     FROM project_teams pt
                     JOIN teams t ON t.id = pt.team_id
                    WHERE pt.project_id = p.id),
                  ARRAY[]::TEXT[]
                ) AS team_names
           FROM weekly_status_updates w
           JOIN projects p ON p.id = w.project_id
           LEFT JOIN swim_lanes s ON s.id = p.swim_lane_id
           LEFT JOIN users owner ON owner.id = p.owner_id
           LEFT JOIN users submitter ON submitter.id = w.submitted_by_user_id
          WHERE w.week_of = $1::date
            AND w.completed = TRUE
            AND p.group_id = $2
            AND p.deleted_at IS NULL
          ORDER BY s."order" DESC NULLS LAST, s.name, p.global_priority ASC, p.title`
      : scope?.groupIds?.length
        ? `SELECT p.group_id,
                  p.id AS project_id,
                  p.title AS project_title,
                  s.id AS swim_lane_id,
                  s.name AS swim_lane_name,
                  s."order" AS swim_lane_order,
                  p.global_priority,
                  w.health_flag,
                  w.executive_summary,
                  w.detailed_update,
                  owner.name AS owner_name,
                  submitter.name AS submitted_by_name,
                  COALESCE(
                    (SELECT array_agg(t.name ORDER BY pt.position ASC)
                       FROM project_teams pt
                       JOIN teams t ON t.id = pt.team_id
                      WHERE pt.project_id = p.id),
                    ARRAY[]::TEXT[]
                  ) AS team_names
             FROM weekly_status_updates w
             JOIN projects p ON p.id = w.project_id
             LEFT JOIN swim_lanes s ON s.id = p.swim_lane_id
             LEFT JOIN users owner ON owner.id = p.owner_id
             LEFT JOIN users submitter ON submitter.id = w.submitted_by_user_id
            WHERE w.week_of = $1::date
              AND w.completed = TRUE
              AND p.group_id = ANY($2::uuid[])
              AND p.deleted_at IS NULL
            ORDER BY p.group_id, s."order" DESC NULLS LAST, s.name, p.global_priority ASC, p.title`
        : `SELECT p.group_id,
                  p.id AS project_id,
                  p.title AS project_title,
                  s.id AS swim_lane_id,
                  s.name AS swim_lane_name,
                  s."order" AS swim_lane_order,
                  p.global_priority,
                  w.health_flag,
                  w.executive_summary,
                  w.detailed_update,
                  owner.name AS owner_name,
                  submitter.name AS submitted_by_name,
                  COALESCE(
                    (SELECT array_agg(t.name ORDER BY pt.position ASC)
                       FROM project_teams pt
                       JOIN teams t ON t.id = pt.team_id
                      WHERE pt.project_id = p.id),
                    ARRAY[]::TEXT[]
                  ) AS team_names
             FROM weekly_status_updates w
             JOIN projects p ON p.id = w.project_id
             LEFT JOIN swim_lanes s ON s.id = p.swim_lane_id
             LEFT JOIN users owner ON owner.id = p.owner_id
             LEFT JOIN users submitter ON submitter.id = w.submitted_by_user_id
            WHERE w.week_of = $1::date
              AND w.completed = TRUE
              AND p.deleted_at IS NULL
            ORDER BY p.group_id, s."order" DESC NULLS LAST, s.name, p.global_priority ASC, p.title`,
    scope?.groupId
      ? [weekIso, scope.groupId]
      : scope?.groupIds?.length
        ? [weekIso, scope.groupIds]
        : [weekIso],
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

/**
 * Projects eligible for a weekly status update this week that have no
 * completed submission yet — grouped by owner, owners sorted by count.
 */
async function loadMissingForGroup(groupId: string, week: Date): Promise<OwnerMissingGroup[]> {
  const weekIso = week.toISOString().slice(0, 10);
  const eligible = await eligibleProjects(week, groupId);
  if (!eligible.length) return [];

  const projectIds = eligible.map((e) => e.project_id);
  const { rows: projectRows } = await query<{
    id: string;
    title: string;
    owner_id: string | null;
    owner_name: string | null;
  }>(
    `SELECT p.id, p.title, p.owner_id, owner.name AS owner_name
       FROM projects p
       LEFT JOIN users owner ON owner.id = p.owner_id
      WHERE p.id = ANY($1::uuid[])`,
    [projectIds],
  );

  const { rows: updates } = await query<{ project_id: string; completed: boolean }>(
    `SELECT project_id, completed
       FROM weekly_status_updates
      WHERE week_of = $1::date AND project_id = ANY($2::uuid[])`,
    [weekIso, projectIds],
  );
  const completedIds = new Set(
    updates.filter((u) => u.completed).map((u) => u.project_id),
  );

  const byOwner = new Map<string, OwnerMissingGroup>();
  for (const p of projectRows) {
    if (completedIds.has(p.id)) continue;
    const ownerKey = p.owner_id ?? "__unassigned__";
    const ownerName = p.owner_name?.trim() || "Unassigned";
    const project: MissingProject = { project_id: p.id, project_title: p.title };
    const existing = byOwner.get(ownerKey);
    if (existing) {
      existing.projects.push(project);
    } else {
      byOwner.set(ownerKey, { ownerName, projects: [project] });
    }
  }

  return Array.from(byOwner.values())
    .sort((a, b) => {
      const byCount = b.projects.length - a.projects.length;
      if (byCount !== 0) return byCount;
      return a.ownerName.localeCompare(b.ownerName);
    })
    .map((g) => ({
      ownerName: g.ownerName,
      projects: g.projects
        .slice()
        .sort((a, b) => a.project_title.localeCompare(b.project_title)),
    }));
}

async function collectByGroup(week: Date, scope?: GroupScheduleScope): Promise<GroupBundle[]> {
  const weekIso = week.toISOString().slice(0, 10);
  const { rows: groups } = await query<{ id: string; name: string }>(
    scope?.groupId
      ? `SELECT id, name FROM groups WHERE id = $1`
      : scope?.groupIds?.length
        ? `SELECT id, name FROM groups WHERE id = ANY($1::uuid[])`
        : `SELECT id, name FROM groups`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );

  const updatesByGroup = await loadUpdatesBatch(weekIso, scope);
  const recipientsByGroup = await loadRecipientsBatch(scope);

  const bundles: GroupBundle[] = [];
  for (const g of groups) {
    bundles.push({
      groupId: g.id,
      groupName: g.name,
      updates: updatesByGroup.get(g.id) ?? [],
      recipients: recipientsByGroup.get(g.id) ?? [],
      missingByOwner: await loadMissingForGroup(g.id, week),
    });
  }
  return bundles;
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

/** Email-safe status badge — no flexbox / full pill radius (breaks in mobile clients). */
function healthBadgeHtml(flag: UpdateRow["health_flag"]): string {
  return `<span style="display:inline-block;font-size:11px;font-weight:600;line-height:1.3;padding:3px 10px;border-radius:12px;background:${healthColor(flag)};color:#fff;white-space:nowrap;mso-line-height-rule:exactly;">${escapeHtml(healthLabel(flag))}</span>`;
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

function compareWithinLanePriority(a: UpdateRow, b: UpdateRow): number {
  // global_priority 0 = unranked; sink those after explicitly ranked items.
  const gpA = a.global_priority === 0 ? Number.POSITIVE_INFINITY : a.global_priority;
  const gpB = b.global_priority === 0 ? Number.POSITIVE_INFINITY : b.global_priority;
  if (gpA !== gpB) return gpA - gpB;
  return a.project_title.localeCompare(b.project_title);
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
  return Array.from(byLane.values())
    .sort((a, b) =>
      compareSwimLaneReportOrder(a.laneOrder, b.laneOrder, a.laneName, b.laneName),
    )
    .map((g) => ({
      ...g,
      items: g.items.slice().sort(compareWithinLanePriority),
    }));
}

function formatUpdateTextLines(u: UpdateRow, appUrl: string): string[] {
  const projectUrl = `${appUrl}/projects/${u.project_id}`;
  const lines: string[] = [
    `• ${u.project_title} [${healthLabel(u.health_flag)}]`,
    `   ${projectUrl}`,
  ];
  if (u.owner_name) lines.push(`   Owner: ${u.owner_name}`);
  if (u.team_names.length) lines.push(`   Teams: ${u.team_names.join(", ")}`);
  if (u.submitted_by_name) lines.push(`   Submitted by: ${u.submitted_by_name}`);
  if (u.executive_summary?.trim()) lines.push(`   ${u.executive_summary.trim()}`);
  const bs = bullets(u.detailed_update);
  for (const b of bs) lines.push(`   - ${b}`);
  lines.push("");
  return lines;
}

function renderUpdateArticleHtml(u: UpdateRow, appUrl: string): string {
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
  const teamsHtml = u.team_names.length
    ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">Teams: ${escapeHtml(u.team_names.join(", "))}</div>`
    : "";
  const submitterHtml = u.submitted_by_name
    ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">Submitted by: ${escapeHtml(u.submitted_by_name)}</div>`
    : "";
  return `
        <article style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="vertical-align:top;padding-right:12px;">
                <a href="${projectUrl}" style="font-weight:600;color:#0f172a;text-decoration:none;">${escapeHtml(u.project_title)}</a>
              </td>
              <td align="right" style="vertical-align:top;white-space:nowrap;width:1%;">
                ${healthBadgeHtml(u.health_flag)}
              </td>
            </tr>
          </table>
          ${ownerHtml}
          ${teamsHtml}
          ${submitterHtml}
          ${summaryHtml}
          ${bulletsHtml}
        </article>`;
}

function missingUpdateCount(missingByOwner: OwnerMissingGroup[]): number {
  return missingByOwner.reduce((n, g) => n + g.projects.length, 0);
}

function renderMissingSectionText(
  missingByOwner: OwnerMissingGroup[],
  appUrl: string,
): string[] {
  const lines: string[] = [];
  if (!missingByOwner.length) return lines;
  lines.push("--- No update this week ---");
  for (const { ownerName, projects } of missingByOwner) {
    lines.push(`${ownerName} (${projects.length}):`);
    for (const p of projects) {
      lines.push(`• ${p.project_title}`);
      lines.push(`   ${appUrl}/projects/${p.project_id}`);
    }
    lines.push("");
  }
  return lines;
}

function renderMissingSectionHtml(
  missingByOwner: OwnerMissingGroup[],
  appUrl: string,
): string {
  if (!missingByOwner.length) return "";
  const ownerBlocks = missingByOwner
    .map(({ ownerName, projects }) => {
      const items = projects
        .map((p) => {
          const projectUrl = `${appUrl}/projects/${p.project_id}`;
          return `<li style="margin:2px 0;"><a href="${projectUrl}" style="color:#0f172a;text-decoration:none;">${escapeHtml(p.project_title)}</a></li>`;
        })
        .join("");
      return `
      <div style="margin-top:12px;">
        <h3 style="font-size:13px;font-weight:600;color:#0f172a;margin:0;">
          ${escapeHtml(ownerName)}
          <span style="font-weight:500;color:#64748b;">(${projects.length})</span>
        </h3>
        <ul style="margin:6px 0 0;padding-left:18px;color:#334155;">${items}</ul>
      </div>`;
    })
    .join("");
  return `
    <section style="margin-top:28px;border-top:1px solid #e2e8f0;padding-top:20px;">
      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#334155;margin:0 0 8px;">No update this week</h2>
      ${ownerBlocks}
    </section>`;
}

function renderDigest(input: {
  groupName: string;
  weekOf: Date;
  updates: UpdateRow[];
  missingByOwner: OwnerMissingGroup[];
  appUrl: string;
  recipientName?: string;
  unsubscribeUrl: string;
  timezone: string;
  /** Optional preamble for admin-triggered sends (not used by cron). */
  adminNote?: string;
}): { subject: string; text: string; html: string } {
  const {
    groupName,
    weekOf,
    updates,
    missingByOwner,
    appUrl,
    recipientName,
    unsubscribeUrl,
    timezone,
    adminNote,
  } = input;
  const weekLabel = weekOf.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
  const subject = `${groupName} weekly update — ${weekLabel}`;

  const laneGroups = laneGroupsForReport(updates);
  const laneCount = laneGroups.length;
  const missingCount = missingUpdateCount(missingByOwner);

  const greeting = recipientName ? `Hi ${recipientName.split(/\s+/)[0] ?? recipientName},` : "Hello,";
  const noteText = adminNote?.trim() ?? "";

  const textLines: string[] = [];
  textLines.push(greeting);
  textLines.push("");
  if (noteText) {
    textLines.push(noteText);
    textLines.push("");
  }
  textLines.push(`${groupName} status updates for the week of ${weekLabel}:`);
  textLines.push("");
  for (const { laneName, items } of laneGroups) {
    textLines.push(`--- ${laneName} ---`);
    for (const u of items) {
      textLines.push(...formatUpdateTextLines(u, appUrl));
    }
  }
  textLines.push(...renderMissingSectionText(missingByOwner, appUrl));
  textLines.push(`Open status report: ${appUrl}/status-report`);
  textLines.push("");
  textLines.push("Unsubscribe from digest emails:");
  textLines.push(unsubscribeUrl);
  const text = textLines.join("\n");

  const preheader =
    `${updates.length} update${updates.length === 1 ? "" : "s"} across ${laneCount} lane${laneCount === 1 ? "" : "s"}` +
    (missingCount > 0
      ? ` · ${missingCount} item${missingCount === 1 ? "" : "s"} without an update`
      : "") +
    ` for ${groupName}.`;

  const laneHtml = laneGroups
    .map(
      ({ laneName, items }) => `
    <section style="margin-top:22px;">
      <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#334155;margin:0 0 8px;">${escapeHtml(laneName)}</h2>
      ${items.map((u) => renderUpdateArticleHtml(u, appUrl)).join("")}
    </section>`,
    )
    .join("");

  const noteHtml = noteText
    ? `<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #DC2626;background:#fef2f2;border-radius:0 8px 8px 0;color:#334155;">${escapeHtml(noteText).replace(/\n/g, "<br>")}</div>`
    : "";

  const missingHtml = renderMissingSectionHtml(missingByOwner, appUrl);
  const summaryExtra =
    missingCount > 0
      ? ` · <strong>${missingCount}</strong> eligible item${missingCount === 1 ? "" : "s"} without a submitted update`
      : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px;">
      <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
      <p>${escapeHtml(greeting)}</p>
      ${noteHtml}
      <p>Here's the <strong>${escapeHtml(groupName)}</strong> weekly status rollup for the week of <strong>${escapeHtml(weekLabel)}</strong> — ${updates.length} update${updates.length === 1 ? "" : "s"} across ${laneCount} swim lane${laneCount === 1 ? "" : "s"}${summaryExtra}.</p>
      ${laneHtml}
      ${missingHtml}
      <p style="margin-top:24px;">
        <a href="${appUrl}/status-report" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open status report</a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:16px;">
        You're receiving this because an admin added your address to the ${escapeHtml(groupName)} digest list.
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
  scopeGroupIds,
  adminNote,
}: {
  dryRun?: boolean;
  forceResend?: boolean;
  scopeGroupId?: string;
  scopeGroupIds?: string[];
  /** Optional preamble included when an admin triggers send manually. */
  adminNote?: string;
} = {}): Promise<DigestRunResult> {
  const noteText = adminNote?.trim() || undefined;
  const scope: GroupScheduleScope | undefined = scopeGroupIds?.length
    ? { groupIds: scopeGroupIds }
    : scopeGroupId
      ? { groupId: scopeGroupId }
      : undefined;
  const schedules = await loadGroupWeeklyStatusSchedules(scope);
  const anchorSchedule =
    schedules.values().next().value ?? resolveWeeklyStatusSchedule();
  const now = new Date();
  const week = weekOfMondayForSchedule(now, anchorSchedule);
  const weekIso = week.toISOString().slice(0, 10);
  const appUrl = config.publicAppUrl.replace(/\/$/, "");

  // Admin manual sends (scopeGroupId) always email the full roster;
  // scheduled cron (scopeGroupIds) keeps per-week idempotency.
  if (!dryRun && (forceResend || scopeGroupId)) {
    const deleted = await query(
      scope?.groupId
        ? `DELETE FROM notification_log
            WHERE kind = $1 AND week_of = $2::date AND group_id = $3`
        : scope?.groupIds?.length
          ? `DELETE FROM notification_log
              WHERE kind = $1 AND week_of = $2::date AND group_id = ANY($3::uuid[])`
          : `DELETE FROM notification_log
              WHERE kind = $1 AND week_of = $2::date`,
      scope?.groupId
        ? [KIND, weekIso, scope.groupId]
        : scope?.groupIds?.length
          ? [KIND, weekIso, scope.groupIds]
          : [KIND, weekIso],
    );
    console.log(
      `[digest] cleared ${deleted.rowCount ?? 0} notification_log row(s) before manual send`,
    );
  }

  const bundles = await collectByGroup(week, scope);

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
        const { rows: prior } = await query<{ provider_message_id: string | null }>(
          `SELECT provider_message_id FROM notification_log
            WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date`,
          [KIND, bundle.groupId, r.email, weekIso],
        );
        if (prior[0]?.provider_message_id) {
          skipped += 1;
          continue;
        }

        if (!prior[0]) {
          try {
            await query(
              `INSERT INTO notification_log
                 (user_id, group_id, kind, week_of, recipient_email, provider_message_id)
               VALUES ($1, $2, $3, $4::date, $5, NULL)`,
              [r.user_id, bundle.groupId, KIND, weekIso, r.email],
            );
          } catch (e) {
            if ((e as { code?: string }).code === "23505") {
              const { rows: raced } = await query<{ provider_message_id: string | null }>(
                `SELECT provider_message_id FROM notification_log
                  WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date`,
                [KIND, bundle.groupId, r.email, weekIso],
              );
              if (raced[0]?.provider_message_id) {
                skipped += 1;
                continue;
              }
            } else {
              throw e;
            }
          }
        }

        const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
          makeUnsubscribeToken(r.id, DIGEST_UNSUB_KIND),
        )}`;
        const bundleSchedule = schedules.get(bundle.groupId) ?? anchorSchedule;
        const msg = renderDigest({
          groupName: bundle.groupName,
          weekOf: week,
          updates: bundle.updates,
          missingByOwner: bundle.missingByOwner,
          appUrl,
          recipientName: r.user_name ?? undefined,
          unsubscribeUrl: unsubUrl,
          timezone: bundleSchedule.timezone,
          adminNote: noteText,
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
    `[digest] status_report_digest scope=${scopeGroupIds?.length ? scopeGroupIds.join(",") : scopeGroupId ?? "global"} dryRun=${dryRun} forceResend=${forceResend} groups=${bundles.length} recipients=${recipients} updates=${updatesIncluded} sent=${sent} alreadySent=${skipped} skippedEmptyGroups=${skippedEmpty} errors=${errors}`,
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
