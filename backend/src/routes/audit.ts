import { Router } from "express";
import { z } from "zod";
import { addDays } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { query } from "../db/pool.js";
import { parseEventFilter } from "../lib/auditEventFilter.js";
import { loadGroupWeeklyStatusSchedule } from "../lib/groupConstants.js";
import { requireAdmin } from "../middleware/auth.js";
import type { RecentAuditEventRow } from "../types.js";

/**
 * Admin audit trail — paginated tenant-wide feed of project mutations.
 * Merges `project_audit_events` (field edits, lifecycle) with
 * `status_history` lane moves. Move duplicates in audit_events are
 * excluded (same rule as GET /projects/audit/recent).
 */
export const auditRouter = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(100).optional().default(50),
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  event: z.string().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

function parseInstant(raw?: string): Date | undefined {
  if (!raw?.trim()) return undefined;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

type AuditListParams = {
  groupId: string;
  page: number;
  pageSize: number;
  userId?: string;
  projectId?: string;
  eventFilter: ReturnType<typeof parseEventFilter>;
  from?: Date;
  to?: Date;
};

function buildCombinedSql(
  params: AuditListParams,
  mode: "list" | "count",
): { sql: string; values: unknown[] } {
  const values: unknown[] = [params.groupId];
  let idx = 2;

  const auditClauses = [
    "p.group_id = $1",
    "p.deleted_at IS NULL",
    "e.action <> 'move'",
  ];
  const moveClauses = [
    "p.group_id = $1",
    "p.deleted_at IS NULL",
    "sh.from_swim_lane_id IS NOT NULL",
  ];

  if (params.userId) {
    auditClauses.push(`e.user_id = $${idx}`);
    moveClauses.push(`sh.moved_by_user_id = $${idx}`);
    values.push(params.userId);
    idx += 1;
  }

  if (params.projectId) {
    auditClauses.push(`e.project_id = $${idx}`);
    moveClauses.push(`sh.project_id = $${idx}`);
    values.push(params.projectId);
    idx += 1;
  }

  const { action, field, fieldPrefix } = params.eventFilter;

  if (action) {
    if (action === "move") {
      auditClauses.push("FALSE");
    } else {
      auditClauses.push(`e.action = $${idx}`);
      values.push(action);
      idx += 1;
      moveClauses.push("FALSE");
    }
  }

  if (field) {
    auditClauses.push(`e.field = $${idx}`);
    values.push(field);
    idx += 1;
    moveClauses.push("FALSE");
  }

  if (fieldPrefix) {
    auditClauses.push(`e.field LIKE $${idx}`);
    values.push(`${fieldPrefix}:%`);
    idx += 1;
    moveClauses.push("FALSE");
  }

  if (params.from) {
    auditClauses.push(`e."timestamp" >= $${idx}`);
    moveClauses.push(`sh."timestamp" >= $${idx}`);
    values.push(params.from.toISOString());
    idx += 1;
  }

  if (params.to) {
    auditClauses.push(`e."timestamp" <= $${idx}`);
    moveClauses.push(`sh."timestamp" <= $${idx}`);
    values.push(params.to.toISOString());
    idx += 1;
  }

  const rootsCte = `
    WITH RECURSIVE walk AS (
      SELECT id AS start_id, id AS cur_id, parent_id, title AS cur_title, 0 AS depth
        FROM projects
       WHERE group_id = $1 AND deleted_at IS NULL
      UNION ALL
      SELECT w.start_id, p.id, p.parent_id, p.title, w.depth + 1
        FROM walk w
        JOIN projects p ON p.id = w.parent_id AND p.deleted_at IS NULL
    ),
    roots AS (
      SELECT DISTINCT ON (start_id) start_id AS project_id, cur_id AS root_id, cur_title AS root_title
        FROM walk
       ORDER BY start_id, depth DESC
    )`;

  const combinedBody = `
    SELECT
      e.id::text AS id,
      'audit'::text AS kind,
      e.project_id,
      p.title AS project_title,
      p.type AS project_type,
      r.root_id AS root_epic_id,
      r.root_title AS root_epic_title,
      e.user_id,
      u.name AS user_name,
      e.action,
      e.field,
      e.from_value,
      e.to_value,
      e."timestamp" AS occurred_at,
      COALESCE(sl.is_archive, FALSE) AS in_archive
    FROM project_audit_events e
    JOIN projects p ON p.id = e.project_id
    JOIN roots r ON r.project_id = p.id
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
    WHERE ${auditClauses.join(" AND ")}
    UNION ALL
    SELECT
      sh.id::text AS id,
      'move'::text AS kind,
      sh.project_id,
      p.title AS project_title,
      p.type AS project_type,
      r.root_id AS root_epic_id,
      r.root_title AS root_epic_title,
      sh.moved_by_user_id AS user_id,
      u.name AS user_name,
      'move'::text AS action,
      'swim_lane_id'::text AS field,
      to_jsonb(sh.from_swim_lane_id) AS from_value,
      to_jsonb(sh.to_swim_lane_id) AS to_value,
      sh."timestamp" AS occurred_at,
      COALESCE(sl.is_archive, FALSE) AS in_archive
    FROM status_history sh
    JOIN projects p ON p.id = sh.project_id
    JOIN roots r ON r.project_id = p.id
    LEFT JOIN users u ON u.id = sh.moved_by_user_id
    LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
    WHERE ${moveClauses.join(" AND ")}`;

  if (mode === "count") {
    return {
      sql: `${rootsCte}, combined AS (${combinedBody}) SELECT COUNT(*)::int AS total FROM combined`,
      values,
    };
  }

  const offset = (params.page - 1) * params.pageSize;
  values.push(params.pageSize, offset);
  return {
    sql: `${rootsCte}
      SELECT * FROM (${combinedBody}) combined
      ORDER BY occurred_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  };
}

auditRouter.get("/events", requireAdmin, async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  const params: AuditListParams = {
    groupId: req.groupId!,
    page: q.page,
    pageSize: q.page_size,
    userId: q.user_id,
    projectId: q.project_id,
    eventFilter: parseEventFilter(q.event),
    from: parseInstant(q.from),
    to: parseInstant(q.to),
  };

  const countBuilt = buildCombinedSql(params, "count");
  const { rows: countRows } = await query<{ total: number }>(countBuilt.sql, countBuilt.values);
  const total = countRows[0]?.total ?? 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / params.pageSize);

  const listBuilt = buildCombinedSql(params, "list");
  const { rows } = await query<RecentAuditEventRow>(listBuilt.sql, listBuilt.values);

  res.json({
    events: rows.map((r) => ({
      ...r,
      occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    })),
    page: params.page,
    page_size: params.pageSize,
    total,
    total_pages: totalPages,
  });
});

const activityByDaySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  user_id: z.string().uuid().optional(),
});

/**
 * Homepage activity chart — count of audit events + lane moves per
 * calendar day in the workspace reporting timezone. Excludes
 * `global_priority` edits (Prioritization drags) so bulk reorders
 * don't dominate the chart. Available to every authenticated group
 * member (not admin-only).
 */
auditRouter.get("/activity-by-day", async (req, res) => {
  const q = activityByDaySchema.parse(req.query);
  if (q.from > q.to) {
    res.status(400).json({ error: "`from` must be on or before `to`" });
    return;
  }

  const schedule = await loadGroupWeeklyStatusSchedule(req.groupId!);
  const tz = schedule.timezone;

  const fromInstant = fromZonedTime(`${q.from}T00:00:00.000`, tz);
  const toInstant = fromZonedTime(`${q.to}T23:59:59.999`, tz);
  const spanDays =
    Math.floor((toInstant.getTime() - fromInstant.getTime()) / 86_400_000) + 1;
  if (spanDays > 90) {
    res.status(400).json({ error: "date range cannot exceed 90 days" });
    return;
  }

  const values: unknown[] = [req.groupId!, fromInstant.toISOString(), toInstant.toISOString(), tz];
  let userClauseAudit = "";
  let userClauseMove = "";
  if (q.user_id) {
    values.push(q.user_id);
    userClauseAudit = `AND e.user_id = $5`;
    userClauseMove = `AND sh.moved_by_user_id = $5`;
  }

  const { rows } = await query<{ day: string; count: number }>(
    `
    WITH events AS (
      SELECT e."timestamp" AS ts
        FROM project_audit_events e
        JOIN projects p ON p.id = e.project_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND e.action <> 'move'
         AND e.field IS DISTINCT FROM 'global_priority'
         AND e."timestamp" >= $2::timestamptz
         AND e."timestamp" <= $3::timestamptz
         ${userClauseAudit}
      UNION ALL
      SELECT sh."timestamp" AS ts
        FROM status_history sh
        JOIN projects p ON p.id = sh.project_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND sh.from_swim_lane_id IS NOT NULL
         AND sh."timestamp" >= $2::timestamptz
         AND sh."timestamp" <= $3::timestamptz
         ${userClauseMove}
    )
    SELECT to_char((ts AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count
      FROM events
     GROUP BY 1
     ORDER BY 1
    `,
    values,
  );

  const byDay = new Map(rows.map((r) => [r.day, r.count] as const));
  const days: Array<{ date: string; count: number }> = [];
  // Walk calendar dates at UTC noon so DST cannot skip/duplicate a day key.
  let cursor = new Date(`${q.from}T12:00:00.000Z`);
  const end = new Date(`${q.to}T12:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    days.push({ date: key, count: byDay.get(key) ?? 0 });
    cursor = addDays(cursor, 1);
  }

  res.json({
    from: q.from,
    to: q.to,
    user_id: q.user_id ?? null,
    timezone: tz,
    days,
    total: days.reduce((sum, d) => sum + d.count, 0),
  });
});

const activityByUserSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Homepage A/B chart — count of audit events + lane moves per user
 * in the workspace reporting timezone. Same event universe as
 * `/activity-by-day` (also excludes `global_priority` edits).
 * Available to every authenticated group member.
 */
auditRouter.get("/activity-by-user", async (req, res) => {
  const q = activityByUserSchema.parse(req.query);
  if (q.from > q.to) {
    res.status(400).json({ error: "`from` must be on or before `to`" });
    return;
  }

  const schedule = await loadGroupWeeklyStatusSchedule(req.groupId!);
  const tz = schedule.timezone;

  const fromInstant = fromZonedTime(`${q.from}T00:00:00.000`, tz);
  const toInstant = fromZonedTime(`${q.to}T23:59:59.999`, tz);
  const spanDays =
    Math.floor((toInstant.getTime() - fromInstant.getTime()) / 86_400_000) + 1;
  if (spanDays > 90) {
    res.status(400).json({ error: "date range cannot exceed 90 days" });
    return;
  }

  const { rows } = await query<{
    user_id: string | null;
    user_name: string | null;
    count: number;
  }>(
    `
    WITH events AS (
      SELECT e.user_id AS user_id
        FROM project_audit_events e
        JOIN projects p ON p.id = e.project_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND e.action <> 'move'
         AND e.field IS DISTINCT FROM 'global_priority'
         AND e."timestamp" >= $2::timestamptz
         AND e."timestamp" <= $3::timestamptz
      UNION ALL
      SELECT sh.moved_by_user_id AS user_id
        FROM status_history sh
        JOIN projects p ON p.id = sh.project_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND sh.from_swim_lane_id IS NOT NULL
         AND sh."timestamp" >= $2::timestamptz
         AND sh."timestamp" <= $3::timestamptz
    )
    SELECT e.user_id,
           u.name AS user_name,
           COUNT(*)::int AS count
      FROM events e
      LEFT JOIN users u ON u.id = e.user_id
     GROUP BY e.user_id, u.name
     ORDER BY count DESC, COALESCE(u.name, '') ASC
    `,
    [req.groupId!, fromInstant.toISOString(), toInstant.toISOString()],
  );

  const users = rows.map((r) => ({
    user_id: r.user_id,
    user_name: r.user_name?.trim() || "Unknown",
    count: r.count,
  }));

  res.json({
    from: q.from,
    to: q.to,
    timezone: tz,
    users,
    total: users.reduce((sum, u) => sum + u.count, 0),
  });
});
