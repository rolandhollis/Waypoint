import { format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { loadGroupConstants, type GroupScheduleScope } from "../lib/groupConstants.js";
import { sendEmail } from "./email.js";
import {
  DIGEST_UNSUB_KIND,
  loadDigestRecipients,
  type DigestRecipient,
} from "./statusDigest.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Friday 3:00pm America/Chicago design-board status email.
 *
 * One message per digest recipient (same roster as the weekly status
 * digest). Body groups active assigned tickets by designer, then an
 * "Up Next" section with the first 6 unassigned Backlog items.
 */

export const DESIGN_STATUS_DIGEST_KIND = "design_status_digest";

const UP_NEXT_LIMIT = 6;
const DESC_SNIPPET = 400;

type DesignItemLite = {
  id: string;
  name: string;
  description: string;
  due_date: string | null;
  assigned_to: string | null;
  designer_name: string | null;
  lane_order: number | null;
  position: number;
};

type DesignerGroup = {
  designerId: string;
  designerName: string;
  items: DesignItemLite[];
};

type GroupBundle = {
  groupId: string;
  groupName: string;
  byDesigner: DesignerGroup[];
  upNext: DesignItemLite[];
  recipients: DigestRecipient[];
};

export type DesignStatusDigestRunResult = {
  groups: number;
  recipients: number;
  assignedItems: number;
  upNextItems: number;
  sent: number;
  skippedEmpty: number;
  errors: number;
  dayOf: string;
  dryRun: boolean;
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

function snippet(text: string, max = DESC_SNIPPET): string {
  const trimmed = text.trim().replace(/\r\n/g, "\n");
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatDue(due: string | null): string {
  if (!due) return "No due date";
  try {
    return format(parseISO(due), "MMM d, yyyy");
  } catch {
    return due;
  }
}

async function loadGroupNames(scope?: GroupScheduleScope): Promise<Map<string, string>> {
  const { rows } = await query<{ id: string; name: string }>(
    scope?.groupId
      ? `SELECT id, name FROM groups WHERE id = $1`
      : scope?.groupIds?.length
        ? `SELECT id, name FROM groups WHERE id = ANY($1::uuid[])`
        : `SELECT id, name FROM groups`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadAssignedItems(
  scope?: GroupScheduleScope,
): Promise<Map<string, DesignItemLite[]>> {
  const { rows } = await query<DesignItemLite & { group_id: string }>(
    scope?.groupId
      ? `SELECT di.group_id,
                di.id,
                di.name,
                di.description,
                di.due_date::text AS due_date,
                di.assigned_to,
                di.position,
                COALESCE(NULLIF(btrim(l.name), ''), u.name) AS designer_name,
                l."order" AS lane_order
           FROM design_items di
           JOIN users u ON u.id = di.assigned_to
           LEFT JOIN design_board_lanes l
             ON l.group_id = di.group_id AND l.user_id = di.assigned_to
          WHERE di.group_id = $1
            AND di.deleted_at IS NULL
            AND di.status IN ('next_up', 'in_design')
            AND di.assigned_to IS NOT NULL
          ORDER BY COALESCE(l."order", 9999) ASC,
                   COALESCE(NULLIF(btrim(l.name), ''), u.name) ASC,
                   di.due_date ASC NULLS LAST,
                   di.position ASC,
                   di.name ASC`
      : scope?.groupIds?.length
        ? `SELECT di.group_id,
                  di.id,
                  di.name,
                  di.description,
                  di.due_date::text AS due_date,
                  di.assigned_to,
                  di.position,
                  COALESCE(NULLIF(btrim(l.name), ''), u.name) AS designer_name,
                  l."order" AS lane_order
             FROM design_items di
             JOIN users u ON u.id = di.assigned_to
             LEFT JOIN design_board_lanes l
               ON l.group_id = di.group_id AND l.user_id = di.assigned_to
            WHERE di.group_id = ANY($1::uuid[])
              AND di.deleted_at IS NULL
              AND di.status IN ('next_up', 'in_design')
              AND di.assigned_to IS NOT NULL
            ORDER BY di.group_id,
                     COALESCE(l."order", 9999) ASC,
                     COALESCE(NULLIF(btrim(l.name), ''), u.name) ASC,
                     di.due_date ASC NULLS LAST,
                     di.position ASC,
                     di.name ASC`
        : `SELECT di.group_id,
                  di.id,
                  di.name,
                  di.description,
                  di.due_date::text AS due_date,
                  di.assigned_to,
                  di.position,
                  COALESCE(NULLIF(btrim(l.name), ''), u.name) AS designer_name,
                  l."order" AS lane_order
             FROM design_items di
             JOIN users u ON u.id = di.assigned_to
             LEFT JOIN design_board_lanes l
               ON l.group_id = di.group_id AND l.user_id = di.assigned_to
            WHERE di.deleted_at IS NULL
              AND di.status IN ('next_up', 'in_design')
              AND di.assigned_to IS NOT NULL
            ORDER BY di.group_id,
                     COALESCE(l."order", 9999) ASC,
                     COALESCE(NULLIF(btrim(l.name), ''), u.name) ASC,
                     di.due_date ASC NULLS LAST,
                     di.position ASC,
                     di.name ASC`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );

  const out = new Map<string, DesignItemLite[]>();
  for (const row of rows) {
    const { group_id, ...item } = row;
    const list = out.get(group_id) ?? [];
    list.push(item);
    out.set(group_id, list);
  }
  return out;
}

async function loadUpNextItems(
  scope?: GroupScheduleScope,
): Promise<Map<string, DesignItemLite[]>> {
  // Rank backlog per group, then keep the first UP_NEXT_LIMIT.
  const { rows } = await query<DesignItemLite & { group_id: string; rn: number }>(
    scope?.groupId
      ? `SELECT * FROM (
           SELECT di.group_id,
                  di.id,
                  di.name,
                  di.description,
                  di.due_date::text AS due_date,
                  di.assigned_to,
                  di.position,
                  NULL::text AS designer_name,
                  NULL::int AS lane_order,
                  ROW_NUMBER() OVER (
                    PARTITION BY di.group_id
                    ORDER BY di.position ASC, di.created_at ASC, di.name ASC
                  ) AS rn
             FROM design_items di
            WHERE di.group_id = $1
              AND di.deleted_at IS NULL
              AND di.status = 'next_up'
              AND di.assigned_to IS NULL
         ) ranked
         WHERE rn <= $2
         ORDER BY rn ASC`
      : scope?.groupIds?.length
        ? `SELECT * FROM (
             SELECT di.group_id,
                    di.id,
                    di.name,
                    di.description,
                    di.due_date::text AS due_date,
                    di.assigned_to,
                    di.position,
                    NULL::text AS designer_name,
                    NULL::int AS lane_order,
                    ROW_NUMBER() OVER (
                      PARTITION BY di.group_id
                      ORDER BY di.position ASC, di.created_at ASC, di.name ASC
                    ) AS rn
               FROM design_items di
              WHERE di.group_id = ANY($1::uuid[])
                AND di.deleted_at IS NULL
                AND di.status = 'next_up'
                AND di.assigned_to IS NULL
           ) ranked
           WHERE rn <= $2
           ORDER BY group_id, rn ASC`
        : `SELECT * FROM (
             SELECT di.group_id,
                    di.id,
                    di.name,
                    di.description,
                    di.due_date::text AS due_date,
                    di.assigned_to,
                    di.position,
                    NULL::text AS designer_name,
                    NULL::int AS lane_order,
                    ROW_NUMBER() OVER (
                      PARTITION BY di.group_id
                      ORDER BY di.position ASC, di.created_at ASC, di.name ASC
                    ) AS rn
               FROM design_items di
              WHERE di.deleted_at IS NULL
                AND di.status = 'next_up'
                AND di.assigned_to IS NULL
           ) ranked
           WHERE rn <= $1
           ORDER BY group_id, rn ASC`,
    scope?.groupId
      ? [scope.groupId, UP_NEXT_LIMIT]
      : scope?.groupIds?.length
        ? [scope.groupIds, UP_NEXT_LIMIT]
        : [UP_NEXT_LIMIT],
  );

  const out = new Map<string, DesignItemLite[]>();
  for (const row of rows) {
    const { group_id, rn: _rn, ...item } = row;
    const list = out.get(group_id) ?? [];
    list.push(item);
    out.set(group_id, list);
  }
  return out;
}

function groupByDesigner(items: DesignItemLite[]): DesignerGroup[] {
  const map = new Map<string, DesignerGroup>();
  for (const item of items) {
    const id = item.assigned_to!;
    const existing = map.get(id);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    map.set(id, {
      designerId: id,
      designerName: item.designer_name?.trim() || "Designer",
      items: [item],
    });
  }
  return [...map.values()];
}

async function collectBundles(scope?: GroupScheduleScope): Promise<GroupBundle[]> {
  const [names, assigned, upNext, recipientsByGroup] = await Promise.all([
    loadGroupNames(scope),
    loadAssignedItems(scope),
    loadUpNextItems(scope),
    loadDigestRecipients(scope),
  ]);

  const groupIds = new Set<string>([
    ...names.keys(),
    ...assigned.keys(),
    ...upNext.keys(),
    ...recipientsByGroup.keys(),
  ]);
  if (scope?.groupId) groupIds.add(scope.groupId);
  if (scope?.groupIds) for (const id of scope.groupIds) groupIds.add(id);

  const bundles: GroupBundle[] = [];
  for (const groupId of groupIds) {
    const assignedItems = assigned.get(groupId) ?? [];
    const next = upNext.get(groupId) ?? [];
    if (!assignedItems.length && !next.length) continue;
    bundles.push({
      groupId,
      groupName: names.get(groupId) ?? "your workspace",
      byDesigner: groupByDesigner(assignedItems),
      upNext: next,
      recipients: recipientsByGroup.get(groupId) ?? [],
    });
  }
  return bundles;
}

function renderItemText(item: DesignItemLite, index: number): string[] {
  const desc = snippet(item.description);
  const lines = [
    `${index}. ${item.name}`,
    `   Due: ${formatDue(item.due_date)}`,
  ];
  if (desc) lines.push(`   ${desc.replace(/\n/g, "\n   ")}`);
  return lines;
}

function renderItemHtml(item: DesignItemLite): string {
  const desc = snippet(item.description);
  const due = formatDue(item.due_date);
  const dueColor = item.due_date ? "#0f172a" : "#64748b";
  return `
    <div style="margin:0 0 14px;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;">
      <div style="font-weight:600;color:#0f172a;margin:0 0 4px;">${escapeHtml(item.name)}</div>
      <div style="font-size:12px;font-weight:600;color:${dueColor};margin:0 0 8px;">
        Due: ${escapeHtml(due)}
      </div>
      ${
        desc
          ? `<div style="font-size:13px;color:#334155;white-space:pre-wrap;">${escapeHtml(desc)}</div>`
          : `<div style="font-size:13px;color:#94a3b8;font-style:italic;">No description</div>`
      }
    </div>`;
}

function renderDigest(input: {
  groupName: string;
  dayOf: string;
  byDesigner: DesignerGroup[];
  upNext: DesignItemLite[];
  recipientName?: string | null;
  appUrl: string;
  unsubscribeUrl: string;
}): { subject: string; text: string; html: string } {
  const { groupName, dayOf, byDesigner, upNext, recipientName, appUrl, unsubscribeUrl } =
    input;
  const first = recipientName?.split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";
  const designUrl = `${appUrl}/design`;
  let dayLabel = dayOf;
  try {
    dayLabel = format(parseISO(dayOf), "EEEE, MMM d");
  } catch {
    // keep ISO
  }
  const assignedCount = byDesigner.reduce((n, g) => n + g.items.length, 0);
  const subject = `Design status update — ${groupName} — ${dayLabel}`;

  const textParts: string[] = [
    greeting,
    "",
    `Here's the ${groupName} design board status for ${dayLabel}.`,
    "",
  ];

  if (byDesigner.length) {
    textParts.push(`In progress (${assignedCount})`, "");
    for (const group of byDesigner) {
      textParts.push(`${group.designerName} (${group.items.length})`);
      group.items.forEach((item, i) => {
        textParts.push(...renderItemText(item, i + 1), "");
      });
    }
  } else {
    textParts.push("No items are currently assigned to designers.", "");
  }

  textParts.push("Up Next", "");
  if (upNext.length) {
    upNext.forEach((item, i) => {
      textParts.push(...renderItemText(item, i + 1), "");
    });
  } else {
    textParts.push("Backlog is empty.", "");
  }

  textParts.push(
    `Open Design: ${designUrl}`,
    "",
    `You're receiving this because an admin added your address to the ${groupName} digest list.`,
    "Don't want these emails? Unsubscribe with one click:",
    unsubscribeUrl,
  );

  const designerHtml = byDesigner.length
    ? byDesigner
        .map(
          (g) => `
      <h2 style="font-size:15px;margin:24px 0 10px;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">
        ${escapeHtml(g.designerName)}
        <span style="font-weight:500;color:#64748b;font-size:13px;"> · ${g.items.length}</span>
      </h2>
      ${g.items.map(renderItemHtml).join("")}`,
        )
        .join("")
    : `<p style="color:#64748b;">No items are currently assigned to designers.</p>`;

  const upNextHtml = upNext.length
    ? upNext.map(renderItemHtml).join("")
    : `<p style="color:#64748b;">Backlog is empty.</p>`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:560px;">
      <p>${escapeHtml(greeting)}</p>
      <p>Here&rsquo;s the <strong>${escapeHtml(groupName)}</strong> design board status for ${escapeHtml(dayLabel)}.</p>
      <h1 style="font-size:16px;margin:28px 0 0;color:#0f172a;">In progress${assignedCount ? ` (${assignedCount})` : ""}</h1>
      ${designerHtml}
      <h1 style="font-size:16px;margin:32px 0 10px;color:#0f172a;border-top:2px solid #0f172a;padding-top:16px;">Up Next</h1>
      <p style="font-size:12px;color:#64748b;margin:0 0 12px;">Next ${UP_NEXT_LIMIT} items in the Design backlog.</p>
      ${upNextHtml}
      <p style="margin-top:20px;">
        <a href="${escapeHtml(designUrl)}"
           style="display:inline-block;background:#DC2626;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">
          Open Design board
        </a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        You&rsquo;re receiving this because an admin added your address to the ${escapeHtml(groupName)} digest list.
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b;">Unsubscribe with one click</a>.
      </p>
    </div>
  `.trim();

  return { subject, text: textParts.join("\n"), html };
}

export async function runDesignStatusDigest({
  dryRun = false,
  scopeGroupId,
  scopeGroupIds,
}: {
  dryRun?: boolean;
  scopeGroupId?: string;
  scopeGroupIds?: string[];
} = {}): Promise<DesignStatusDigestRunResult> {
  const scope: GroupScheduleScope | undefined = scopeGroupIds?.length
    ? { groupIds: scopeGroupIds }
    : scopeGroupId
      ? { groupId: scopeGroupId }
      : undefined;

  const dayOf = reportingTodayIso();
  const appUrl = config.publicAppUrl.replace(/\/$/, "");
  const groupConstants = await loadGroupConstants(scope);
  const bundles = await collectBundles(scope);

  if (!dryRun) {
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
        ? [DESIGN_STATUS_DIGEST_KIND, dayOf, scope.groupId]
        : scope?.groupIds?.length
          ? [DESIGN_STATUS_DIGEST_KIND, dayOf, scope.groupIds]
          : [DESIGN_STATUS_DIGEST_KIND, dayOf],
    );
    console.log(
      `[design-status-digest] cleared ${deleted.rowCount ?? 0} notification_log row(s) before send`,
    );
  }

  let recipients = 0;
  let assignedItems = 0;
  let upNextItems = 0;
  let sent = 0;
  let skippedEmpty = 0;
  let errors = 0;

  for (const bundle of bundles) {
    assignedItems += bundle.byDesigner.reduce((n, g) => n + g.items.length, 0);
    upNextItems += bundle.upNext.length;

    if (!bundle.recipients.length) {
      skippedEmpty += 1;
      continue;
    }
    recipients += bundle.recipients.length;

    for (const r of bundle.recipients) {
      try {
        const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
          makeUnsubscribeToken(r.id, DIGEST_UNSUB_KIND),
        )}`;
        const msg = renderDigest({
          groupName: bundle.groupName,
          dayOf,
          byDesigner: bundle.byDesigner,
          upNext: bundle.upNext,
          recipientName: r.user_name,
          appUrl,
          unsubscribeUrl: unsubUrl,
        });

        if (dryRun) {
          console.log(
            `[design-status-digest] DRY RUN — would send to ${r.email}: ${msg.subject}`,
          );
          sent += 1;
          continue;
        }

        await query(
          `INSERT INTO notification_log
             (user_id, group_id, kind, week_of, recipient_email, provider_message_id)
           VALUES ($1, $2, $3, $4::date, $5, NULL)`,
          [r.user_id, bundle.groupId, DESIGN_STATUS_DIGEST_KIND, dayOf, r.email],
        );

        const result = await sendEmail({
          to: r.email,
          from: config.email.formatFrom(groupConstants.get(bundle.groupId)?.email_title),
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
          [result.messageId, DESIGN_STATUS_DIGEST_KIND, bundle.groupId, r.email, dayOf],
        );
        sent += 1;
      } catch (err) {
        errors += 1;
        console.error(
          `[design-status-digest] send failed for group=${bundle.groupId} email=${r.email}:`,
          err,
        );
        try {
          await query(
            `DELETE FROM notification_log
              WHERE kind = $1 AND group_id = $2 AND LOWER(recipient_email) = LOWER($3) AND week_of = $4::date AND provider_message_id IS NULL`,
            [DESIGN_STATUS_DIGEST_KIND, bundle.groupId, r.email, dayOf],
          );
        } catch (cleanupErr) {
          console.error(
            `[design-status-digest] cleanup failed for ${r.email}:`,
            cleanupErr,
          );
        }
      }
    }
  }

  console.log(
    `[design-status-digest] scope=${scopeGroupIds?.length ? scopeGroupIds.join(",") : scopeGroupId ?? "global"} dryRun=${dryRun} day=${dayOf} groups=${bundles.length} recipients=${recipients} assigned=${assignedItems} upNext=${upNextItems} sent=${sent} skippedEmpty=${skippedEmpty} errors=${errors}`,
  );

  return {
    groups: bundles.length,
    recipients,
    assignedItems,
    upNextItems,
    sent,
    skippedEmpty,
    errors,
    dayOf,
    dryRun,
  };
}
