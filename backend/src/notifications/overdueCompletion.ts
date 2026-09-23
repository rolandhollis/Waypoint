import { formatInTimeZone } from "date-fns-tz";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import {
  loadGroupConstants,
  type GroupScheduleScope,
} from "../lib/groupConstants.js";
import { sendEmail } from "./email.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Daily "your project's planned completion date is past" reminder.
 *
 * Predicate: `optimization_end_date` (roadmap end / post-dev complete)
 * is before today in the reporting timezone, the card is not soft-deleted,
 * and its current swim lane is neither terminal (Complete) nor archive.
 *
 * Fan-out: one consolidated email per opted-in owner listing every
 * overdue project they own (across scoped groups). Same
 * `email_reminders_enabled` opt-out + unsubscribe token as weekly
 * status reminders.
 *
 * `notification_log.week_of` stores the Chicago calendar day so the
 * cron does not double-send within the same day; admin "Send now"
 * clears that day's rows for the scoped owners before sending.
 */

export const OVERDUE_COMPLETION_KIND = "overdue_completion";

export type OverdueProject = {
  id: string;
  title: string;
  optimization_end_date: string;
  group_id: string;
  group_name: string;
};

type OverdueByOwner = Map<
  string,
  {
    ownerId: string;
    projects: OverdueProject[];
    groupNames: Set<string>;
    groupIds: Set<string>;
  }
>;

/** Calendar date (YYYY-MM-DD) in the reporting timezone. */
export function reportingTodayIso(now: Date = new Date()): string {
  return formatInTimeZone(now, config.reportingTimezone, "yyyy-MM-dd");
}

async function loadCandidates(): Promise<Map<string, { id: string; name: string; email: string }>> {
  const { rows } = await query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email
       FROM users
      WHERE email_reminders_enabled = TRUE
        AND email IS NOT NULL
        AND email <> ''`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Projects whose planned completion date has passed and that are not
 * yet in a Complete / Archive lane.
 */
export async function loadOverdueProjects(opts: {
  todayIso: string;
  scope?: GroupScheduleScope;
  ownerId?: string;
}): Promise<OverdueProject[]> {
  const { todayIso, scope, ownerId } = opts;
  const params: unknown[] = [todayIso];
  const clauses: string[] = [
    `p.deleted_at IS NULL`,
    `p.owner_id IS NOT NULL`,
    `p.optimization_end_date IS NOT NULL`,
    `p.optimization_end_date < $1::date`,
    `COALESCE(sl.is_terminal, FALSE) = FALSE`,
    `COALESCE(sl.is_archive, FALSE) = FALSE`,
  ];

  if (scope?.groupId) {
    params.push(scope.groupId);
    clauses.push(`p.group_id = $${params.length}`);
  } else if (scope?.groupIds?.length) {
    params.push(scope.groupIds);
    clauses.push(`p.group_id = ANY($${params.length}::uuid[])`);
  }

  if (ownerId) {
    params.push(ownerId);
    clauses.push(`p.owner_id = $${params.length}`);
  }

  const { rows } = await query<{
    id: string;
    title: string;
    optimization_end_date: string;
    group_id: string;
    group_name: string;
  }>(
    `SELECT p.id,
            p.title,
            p.optimization_end_date::text AS optimization_end_date,
            p.group_id,
            g.name AS group_name
       FROM projects p
       JOIN groups g ON g.id = p.group_id
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY p.optimization_end_date ASC, p.title ASC`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    optimization_end_date: r.optimization_end_date.slice(0, 10),
    group_id: r.group_id,
    group_name: r.group_name,
  }));
}

async function collectOverdueByOwner(
  todayIso: string,
  scope?: GroupScheduleScope,
): Promise<OverdueByOwner> {
  const params: unknown[] = [todayIso];
  let groupClause = "";
  if (scope?.groupId) {
    params.push(scope.groupId);
    groupClause = `AND p.group_id = $${params.length}`;
  } else if (scope?.groupIds?.length) {
    params.push(scope.groupIds);
    groupClause = `AND p.group_id = ANY($${params.length}::uuid[])`;
  }

  const { rows } = await query<{
    id: string;
    title: string;
    optimization_end_date: string;
    group_id: string;
    group_name: string;
    owner_id: string;
  }>(
    `SELECT p.id,
            p.title,
            p.optimization_end_date::text AS optimization_end_date,
            p.group_id,
            g.name AS group_name,
            p.owner_id
       FROM projects p
       JOIN groups g ON g.id = p.group_id
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
      WHERE p.deleted_at IS NULL
        AND p.owner_id IS NOT NULL
        AND p.optimization_end_date IS NOT NULL
        AND p.optimization_end_date < $1::date
        AND COALESCE(sl.is_terminal, FALSE) = FALSE
        AND COALESCE(sl.is_archive, FALSE) = FALSE
        ${groupClause}
      ORDER BY p.optimization_end_date ASC, p.title ASC`,
    params,
  );

  const out: OverdueByOwner = new Map();
  for (const r of rows) {
    const project: OverdueProject = {
      id: r.id,
      title: r.title,
      optimization_end_date: r.optimization_end_date.slice(0, 10),
      group_id: r.group_id,
      group_name: r.group_name,
    };
    const existing = out.get(r.owner_id);
    if (existing) {
      existing.projects.push(project);
      existing.groupNames.add(r.group_name);
      existing.groupIds.add(r.group_id);
    } else {
      out.set(r.owner_id, {
        ownerId: r.owner_id,
        projects: [project],
        groupNames: new Set([r.group_name]),
        groupIds: new Set([r.group_id]),
      });
    }
  }
  return out;
}

function formatGroupLabel(groupNames: string[]): string {
  if (groupNames.length === 0) return "your workspace";
  if (groupNames.length === 1) return groupNames[0] ?? "your workspace";
  return `${groupNames.slice(0, -1).join(", ")} and ${groupNames[groupNames.length - 1] ?? ""}`;
}

function renderOverdueEmail(input: {
  name: string;
  projects: OverdueProject[];
  groupNames: string[];
  todayIso: string;
  appUrl: string;
  unsubscribeUrl: string;
  timezone: string;
}): { subject: string; text: string; html: string } {
  const { name, projects, groupNames, todayIso, appUrl, unsubscribeUrl, timezone } = input;
  const count = projects.length;
  const itemsLabel = count === 1 ? "1 project" : `${count} projects`;
  const groupLabel = formatGroupLabel(groupNames);
  const todayLabel = new Date(`${todayIso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });

  const subject =
    count === 1
      ? `Completion date passed — update ${projects[0]?.title ?? "your project"}`
      : `${itemsLabel} past their completion date`;

  const preheader = `${itemsLabel} in ${groupLabel} need a Complete status or a new completion date.`;

  const lines = projects.map((p) => {
    const endLabel = new Date(`${p.optimization_end_date}T12:00:00Z`).toLocaleDateString(
      "en-US",
      { month: "short", day: "numeric", year: "numeric", timeZone: timezone },
    );
    return { title: p.title, endLabel, url: `${appUrl}/projects/${p.id}` };
  });

  const projectListText = [
    "",
    "Projects to update:",
    ...lines.map((l) => `• ${l.title} (completion ${l.endLabel})\n  ${l.url}`),
    "",
  ].join("\n");

  const projectListHtml = `<ul style="margin:8px 0 0;padding-left:18px;color:#334155;">${lines
    .map(
      (l) =>
        `<li style="margin:4px 0;"><a href="${l.url}" style="color:#0f172a;font-weight:600;text-decoration:none;">${escapeHtml(l.title)}</a><br><span style="font-size:12px;color:#64748b;">Completion date: ${escapeHtml(l.endLabel)}</span></li>`,
    )
    .join("")}</ul>`;

  const text = [
    `Hi ${name.split(/\s+/)[0] ?? name},`,
    "",
    `As of ${todayLabel}, you have ${itemsLabel} past their planned completion date in ${groupLabel}.`,
    "Please either move each item to Complete, or update the completion date so the roadmap stays accurate.",
    projectListText,
    `Open Waypoint: ${appUrl}/board`,
    "",
    "Don't want these emails? Unsubscribe with one click:",
    unsubscribeUrl,
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:520px;">
      <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
      <p>Hi ${escapeHtml(name.split(/\s+/)[0] ?? name)},</p>
      <p>As of <strong>${escapeHtml(todayLabel)}</strong>, you have <strong>${escapeHtml(itemsLabel)}</strong> past their planned completion date in ${escapeHtml(groupLabel)}.</p>
      <p>Please either move each item to <strong>Complete</strong>, or update the completion date so the roadmap stays accurate.</p>
      ${projectListHtml}
      <p style="margin-top:16px;"><a href="${appUrl}/board" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open board</a></p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        Don't want these emails?
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

export type OverdueCompletionRunResult = {
  candidates: number;
  pendingOwners: number;
  projectsIncluded: number;
  sent: number;
  errors: number;
  dayOf: string;
  dryRun: boolean;
};

export async function runOverdueCompletionReminders({
  dryRun = false,
  scopeGroupId,
  scopeGroupIds,
  /** When true (admin Send now), clear today's log rows and re-send.
   *  Cron leaves prior successful sends alone for the day. */
  force = false,
}: {
  dryRun?: boolean;
  scopeGroupId?: string;
  scopeGroupIds?: string[];
  force?: boolean;
} = {}): Promise<OverdueCompletionRunResult> {
  const scope: GroupScheduleScope | undefined = scopeGroupIds?.length
    ? { groupIds: scopeGroupIds }
    : scopeGroupId
      ? { groupId: scopeGroupId }
      : undefined;

  const todayIso = reportingTodayIso();
  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const tz = config.reportingTimezone;
  const groupConstants = await loadGroupConstants(scope);
  const candidates = await loadCandidates();
  const pending = await collectOverdueByOwner(todayIso, scope);

  const projectsIncluded = Array.from(pending.values()).reduce(
    (n, b) => n + b.projects.length,
    0,
  );

  const alreadySent = new Set<string>();
  if (!dryRun) {
    if (force) {
      const ownerIds = Array.from(pending.keys());
      if (ownerIds.length) {
        const deleted = await query(
          `DELETE FROM notification_log
            WHERE kind = $1 AND week_of = $2::date AND user_id = ANY($3::uuid[])`,
          [OVERDUE_COMPLETION_KIND, todayIso, ownerIds],
        );
        console.log(
          `[overdue-completion] cleared ${deleted.rowCount ?? 0} notification_log row(s) before force send`,
        );
      }
    } else {
      const { rows } = await query<{ user_id: string }>(
        `SELECT user_id FROM notification_log
          WHERE kind = $1 AND week_of = $2::date AND provider_message_id IS NOT NULL`,
        [OVERDUE_COMPLETION_KIND, todayIso],
      );
      for (const r of rows) alreadySent.add(r.user_id);
    }
  }

  let sent = 0;
  let errors = 0;

  for (const [ownerId, bucket] of pending) {
    const user = candidates.get(ownerId);
    if (!user) continue;
    if (!force && alreadySent.has(ownerId)) continue;

    try {
      const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
        makeUnsubscribeToken(ownerId, OVERDUE_COMPLETION_KIND),
      )}`;
      const msg = renderOverdueEmail({
        name: user.name,
        projects: bucket.projects,
        groupNames: Array.from(bucket.groupNames).sort(),
        todayIso,
        appUrl,
        unsubscribeUrl: unsubUrl,
        timezone: tz,
      });

      if (dryRun) {
        console.log(`[overdue-completion] DRY RUN — would send to ${user.email}: ${msg.subject}`);
        sent += 1;
        continue;
      }

      await query(
        `INSERT INTO notification_log (user_id, kind, week_of, provider_message_id)
         VALUES ($1, $2, $3::date, NULL)`,
        [ownerId, OVERDUE_COMPLETION_KIND, todayIso],
      );

      const fromGroupId = scope?.groupId
        ? scope.groupId
        : Array.from(bucket.groupIds).sort()[0];

      const result = await sendEmail({
        to: user.email,
        from: config.email.formatFrom(
          fromGroupId ? groupConstants.get(fromGroupId)?.email_title : null,
        ),
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
          WHERE user_id = $2 AND kind = $3 AND week_of = $4::date`,
        [result.messageId, ownerId, OVERDUE_COMPLETION_KIND, todayIso],
      );
      sent += 1;
    } catch (err) {
      errors += 1;
      console.error(`[overdue-completion] send failed for user=${ownerId}:`, err);
      try {
        await query(
          `DELETE FROM notification_log
            WHERE user_id = $1 AND kind = $2 AND week_of = $3::date AND provider_message_id IS NULL`,
          [ownerId, OVERDUE_COMPLETION_KIND, todayIso],
        );
      } catch (cleanupErr) {
        console.error(`[overdue-completion] cleanup failed for user=${ownerId}:`, cleanupErr);
      }
    }
  }

  console.log(
    `[overdue-completion] scope=${scopeGroupIds?.length ? scopeGroupIds.join(",") : scopeGroupId ?? "global"} dryRun=${dryRun} force=${force} day=${todayIso} candidates=${candidates.size} pendingOwners=${pending.size} projects=${projectsIncluded} sent=${sent} errors=${errors}`,
  );

  return {
    candidates: candidates.size,
    pendingOwners: pending.size,
    projectsIncluded,
    sent,
    errors,
    dayOf: todayIso,
    dryRun,
  };
}
