import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import type { RecentAuditEventRow } from "../types.js";

/**
 * Admin audit trail — paginated tenant-wide feed of project mutations.
 * Merges `project_audit_events` (field edits, lifecycle) with
 * `status_history` lane moves. Move duplicates in audit_events are
 * excluded (same rule as GET /projects/audit/recent).
 */
export const auditRouter = Router();

const AUDIT_ACTIONS = ["create", "edit", "move", "archive", "restore"] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(100).optional().default(50),
  user_id: z.string().uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
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
  action?: typeof AUDIT_ACTIONS[number];
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

  if (params.action) {
    if (params.action === "move") {
      auditClauses.push("FALSE");
    } else {
      auditClauses.push(`e.action = $${idx}`);
      values.push(params.action);
      idx += 1;
      moveClauses.push("FALSE");
    }
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
    action: q.action,
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
