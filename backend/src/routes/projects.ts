import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { ProjectAuditAction, ProjectRow, SwimLaneRow, TimelineEntryRow } from "../types.js";

export const projectsRouter = Router();

/**
 * Fields we bother diffing into the audit trail on PATCH. Excludes
 * server-managed columns (id, timestamps, positional metadata) and
 * `swim_lane_id` (that goes through /move and is logged separately).
 */
const AUDITED_FIELDS = [
  "title",
  "description",
  "owner_id",
  "teams",
  "tags",
  "start_date",
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

/**
 * Write one audit-event row. Called from inside the same transaction
 * as the mutation so a failed mutation rolls back the audit entry too.
 */
async function recordAudit(
  client: PoolClient,
  args: {
    projectId: string;
    userId: string | null;
    action: ProjectAuditAction;
    field?: string | null;
    from?: unknown;
    to?: unknown;
  },
) {
  await client.query(
    `INSERT INTO project_audit_events
       (project_id, user_id, action, field, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      args.projectId,
      args.userId,
      args.action,
      args.field ?? null,
      args.from === undefined ? null : JSON.stringify(args.from),
      args.to === undefined ? null : JSON.stringify(args.to),
    ],
  );
}

/**
 * Deep-ish equality check that treats arrays as unordered *sets* (used
 * for `teams` and `tags` — order isn't semantically meaningful there,
 * so `["a","b"] === ["b","a"]` and no audit event is written).
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].map(String).sort();
    const sortedB = [...b].map(String).sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return false;
}

/**
 * SELECT fragment that hydrates a project row with its `teams` array
 * (multi-team membership lives in the `project_teams` join). The alias
 * `p` must be used for the FROM.
 */
const PROJECT_COLUMNS = `
  p.*,
  COALESCE(
    (SELECT array_agg(pt.team_id) FROM project_teams pt WHERE pt.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS teams
`;

/**
 * Replace the full set of team memberships for a project. Used both by
 * POST (initial set) and PATCH (when the client sends a `teams` field).
 */
async function replaceProjectTeams(client: PoolClient, projectId: string, teamIds: string[]) {
  await client.query(`DELETE FROM project_teams WHERE project_id = $1`, [projectId]);
  if (teamIds.length === 0) return;
  const values = teamIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO project_teams (project_id, team_id) VALUES ${values}`,
    [projectId, ...teamIds],
  );
}

/**
 * Enforce phase-boundary ordering across the four phase dates. Each field
 * is independently nullable ("not scheduled yet"), but any pair that IS
 * set must be non-decreasing left to right: start ≤ target ≤ devStart ≤
 * devEnd ≤ optStart ≤ optEnd. Missing intermediate anchors fall through
 * to whichever earlier field is available.
 */
function validatePhaseDates(p: {
  start_date?: string | null;
  target_date?: string | null;
  dev_start_date?: string | null;
  dev_end_date?: string | null;
  optimization_start_date?: string | null;
  optimization_end_date?: string | null;
}) {
  const s = p.start_date ?? null;
  const t = p.target_date ?? null;
  const ds = p.dev_start_date ?? null;
  const de = p.dev_end_date ?? null;
  const os = p.optimization_start_date ?? null;
  const oe = p.optimization_end_date ?? null;

  if (s && t && t < s) throw new HttpError(400, "target_date must be on or after start_date");
  if (ds) {
    if (!t) throw new HttpError(400, "dev_start_date requires target_date to be set");
    if (ds < t) throw new HttpError(400, "dev_start_date must be on or after target_date");
  }
  if (de) {
    const anchor = ds ?? t;
    if (!anchor) throw new HttpError(400, "dev_end_date requires target_date to be set");
    if (de < anchor) throw new HttpError(400, "dev_end_date must be on or after the dev start");
  }
  if (os) {
    if (!de) throw new HttpError(400, "optimization_start_date requires dev_end_date to be set");
    if (os < de) throw new HttpError(400, "optimization_start_date must be on or after dev_end_date");
  }
  if (oe) {
    const anchor = os ?? de;
    if (!anchor) throw new HttpError(400, "optimization_end_date requires dev_end_date to be set");
    if (oe < anchor) throw new HttpError(400, "optimization_end_date must be on or after the optimization start");
  }
}

const projectBaseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(50_000).optional(),
  swim_lane_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  teams: z.array(z.string().uuid()).max(10).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  dev_start_date: z.string().nullable().optional(),
  dev_end_date: z.string().nullable().optional(),
  optimization_start_date: z.string().nullable().optional(),
  optimization_end_date: z.string().nullable().optional(),
});

/** Column names that live on the `projects` table itself (i.e. what the
 * projects UPDATE/INSERT can touch directly). `teams` is a virtual
 * column derived from the join, so it's excluded. */
const PROJECT_COLUMN_KEYS = [
  "title", "description", "swim_lane_id", "owner_id", "tags",
  "start_date", "target_date", "dev_start_date", "dev_end_date",
  "optimization_start_date", "optimization_end_date",
] as const;

const listSchema = z.object({
  include_deleted: z.enum(["true", "false"]).optional(),
});

/**
 * SQL fragment that hides projects in admin-only lanes from non-admin
 * requesters. Composed into the WHERE clause of both list and detail
 * reads so a non-admin can neither enumerate nor probe archived cards.
 */
const HIDDEN_LANE_CLAUSE = `
  NOT EXISTS (
    SELECT 1 FROM swim_lanes sl
    WHERE sl.id = p.swim_lane_id AND sl.is_admin_only = TRUE
  )
`;

projectsRouter.get("/", async (req, res) => {
  const q = listSchema.parse(req.query);
  const includeDeleted = q.include_deleted === "true";
  const isAdmin = req.user?.role === "admin";
  const clauses: string[] = [];
  if (!includeDeleted) clauses.push("p.deleted_at IS NULL");
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p
       ${where}
       ORDER BY p.position ASC, p.created_at ASC`,
  );
  res.json(rows);
});

projectsRouter.get("/:id", async (req, res) => {
  const isAdmin = req.user?.role === "admin";
  const clauses = ["p.id = $1"];
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE ${clauses.join(" AND ")}`,
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  res.json(rows[0]);
});

projectsRouter.post("/", requireWrite, async (req, res) => {
  const body = projectBaseSchema.parse(req.body);
  validatePhaseDates(body);
  const result = await withTransaction(async (client) => {
    // Every project must live in a lane (migration 010 enforces this
    // at the DB level). If the client didn't pick one, fall back to
    // the admin-designated default_new lane; if no default is set
    // either, use the first non-terminal lane. Fail with a clear
    // 400 when the workspace has no lanes at all.
    let laneId = body.swim_lane_id ?? null;
    if (!laneId) {
      const { rows: laneRows } = await client.query<{ id: string }>(
        `SELECT id FROM swim_lanes
          ORDER BY is_default_new DESC,
                   is_terminal ASC,
                   "order" ASC
          LIMIT 1`,
      );
      laneId = laneRows[0]?.id ?? null;
      if (!laneId) throw new HttpError(400, "cannot create a project: no swim lanes exist yet");
    }

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
      [laneId],
    );
    const position = maxRows[0]?.next ?? 0;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects
         (title, description, swim_lane_id, position, owner_id, tags,
          start_date, target_date, dev_start_date, dev_end_date,
          optimization_start_date, optimization_end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        body.title,
        body.description ?? "",
        laneId,
        position,
        body.owner_id ?? req.user!.id,
        body.tags ?? [],
        body.start_date ?? null,
        body.target_date ?? null,
        body.dev_start_date ?? null,
        body.dev_end_date ?? null,
        body.optimization_start_date ?? null,
        body.optimization_end_date ?? null,
        req.user!.id,
      ],
    );
    const projectId = rows[0]!.id;
    if (body.teams?.length) {
      await replaceProjectTeams(client, projectId, body.teams);
    }
    await client.query(
      `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
       VALUES ($1, NULL, $2, $3)`,
      [projectId, laneId, req.user!.id],
    );
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "create",
    });
    const { rows: finalRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return finalRows[0];
  });
  res.status(201).json(result);
});

projectsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = projectBaseSchema.partial().parse(req.body);
  // Movement is a separate endpoint that also writes status_history;
  // reject swim_lane_id changes here to keep the audit trail single-source.
  if (body.swim_lane_id !== undefined) {
    throw new HttpError(400, "use POST /projects/:id/move to change swim_lane_id");
  }
  const projectId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 FOR UPDATE`,
      [projectId],
    );
    const existing = existingRows[0];
    if (!existing) throw new HttpError(404, "project not found");

    // If any phase-date is being changed, revalidate the whole chain using
    // the incoming value where present, otherwise the persisted value. This
    // catches attempts to (say) push target_date past a persisted dev_start.
    const touchesPhaseDates =
      body.start_date !== undefined ||
      body.target_date !== undefined ||
      body.dev_start_date !== undefined ||
      body.dev_end_date !== undefined ||
      body.optimization_start_date !== undefined ||
      body.optimization_end_date !== undefined;
    if (touchesPhaseDates) {
      validatePhaseDates({
        start_date: body.start_date !== undefined ? body.start_date : existing.start_date,
        target_date: body.target_date !== undefined ? body.target_date : existing.target_date,
        dev_start_date: body.dev_start_date !== undefined ? body.dev_start_date : existing.dev_start_date,
        dev_end_date: body.dev_end_date !== undefined ? body.dev_end_date : existing.dev_end_date,
        optimization_start_date: body.optimization_start_date !== undefined ? body.optimization_start_date : existing.optimization_start_date,
        optimization_end_date: body.optimization_end_date !== undefined ? body.optimization_end_date : existing.optimization_end_date,
      });
    }

    // `teams` is a join-table field, not a column on projects. Apply it
    // separately as a full replacement (empty array = clear all teams).
    if (body.teams !== undefined) {
      await replaceProjectTeams(client, projectId, body.teams);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of PROJECT_COLUMN_KEYS) {
      const v = (body as Record<string, unknown>)[key];
      if (v === undefined) continue;
      values.push(v);
      fields.push(`"${key}" = $${values.length}`);
    }
    if (fields.length) {
      values.push(projectId);
      await client.query(
        `UPDATE projects SET ${fields.join(", ")}, updated_at = NOW()
           WHERE id = $${values.length} AND deleted_at IS NULL`,
        values,
      );
    }

    // Diff each audited field and write one event per actual change.
    // `existing` is the pre-mutation row we already fetched under FOR
    // UPDATE, so we compare against it (not against another SELECT).
    for (const field of AUDITED_FIELDS) {
      const incoming = (body as Record<string, unknown>)[field];
      if (incoming === undefined) continue;
      const before = (existing as unknown as Record<string, unknown>)[field];
      if (valuesEqual(before, incoming)) continue;
      await recordAudit(client, {
        projectId,
        userId: req.user!.id,
        action: "edit",
        field,
        from: before ?? null,
        to: incoming ?? null,
      });
    }

    const { rows: finalRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return finalRows[0]!;
  });
  res.json(result);
});

const moveSchema = z.object({
  swim_lane_id: z.string().uuid(),
  position: z.number().int().min(0).optional(),
});

/**
 * Move a project into a new lane at an optional position. Extracted so
 * both `POST /:id/move` and `POST /:id/archive` share the same
 * side-effects (terminal-lane completion stamping, position compaction,
 * status_history entry, audit event) without duplicating the SQL.
 */
async function moveProjectImpl(
  client: PoolClient,
  args: {
    projectId: string;
    toLaneId: string;
    position?: number;
    userId: string;
  },
): Promise<ProjectRow> {
  const { rows: existingRows } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE`,
    [args.projectId],
  );
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "project not found");

  const from = existing.swim_lane_id;
  const to = args.toLaneId;

  // Terminal-lane side effect on `actual_completion_date`: auto-stamp on
  // entry into a terminal lane, auto-clear on exit. Only when the lane
  // actually changes so within-lane reorders never touch the field.
  let extraSet = "";
  if (from !== to) {
    if (to && !existing.actual_completion_date) {
      const { rows: laneRows } = await client.query<SwimLaneRow>(
        `SELECT * FROM swim_lanes WHERE id = $1`,
        [to],
      );
      if (laneRows[0]?.is_terminal) {
        extraSet = ", actual_completion_date = CURRENT_DATE";
      }
    } else if (existing.actual_completion_date) {
      const { rows: laneRows } = await client.query<SwimLaneRow>(
        `SELECT * FROM swim_lanes WHERE id = $1`,
        [to ?? "00000000-0000-0000-0000-000000000000"],
      );
      if (!laneRows[0]?.is_terminal) {
        extraSet = ", actual_completion_date = NULL";
      }
    }
  }

  // Build the destination lane's new order by fetching its current members
  // (minus the moved row) and splicing the moved id in at the requested
  // slot, defaulting to the end when no position is provided.
  const { rows: destRows } = await client.query<{ id: string }>(
    `SELECT id FROM projects
      WHERE swim_lane_id IS NOT DISTINCT FROM $1
        AND deleted_at IS NULL
        AND id <> $2
      ORDER BY position ASC, created_at ASC`,
    [to, existing.id],
  );
  const destIds = destRows.map((r) => r.id);
  const insertAt = args.position === undefined
    ? destIds.length
    : Math.max(0, Math.min(destIds.length, args.position));
  destIds.splice(insertAt, 0, existing.id);

  await client.query(
    `UPDATE projects
       SET swim_lane_id = $1, position = $2${extraSet}, updated_at = NOW()
      WHERE id = $3`,
    [to, insertAt, existing.id],
  );
  for (let i = 0; i < destIds.length; i++) {
    if (destIds[i] === existing.id) continue;
    await client.query(
      `UPDATE projects SET position = $1 WHERE id = $2 AND position <> $1`,
      [i, destIds[i]],
    );
  }

  if (from !== to) {
    // Compact positions in the source lane so removing a card doesn't
    // leave a gap in its former lane's ordering.
    const { rows: srcRows } = await client.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE swim_lane_id IS NOT DISTINCT FROM $1
          AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC`,
      [from],
    );
    for (let i = 0; i < srcRows.length; i++) {
      await client.query(
        `UPDATE projects SET position = $1 WHERE id = $2 AND position <> $1`,
        [i, srcRows[i]!.id],
      );
    }

    await client.query(
      `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [existing.id, from, to, args.userId],
    );
    await recordAudit(client, {
      projectId: existing.id,
      userId: args.userId,
      action: "move",
      field: "swim_lane_id",
      from,
      to,
    });
  }

  const { rows: updated } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
    [existing.id],
  );
  return updated[0]!;
}

projectsRouter.post("/:id/move", requireWrite, async (req, res) => {
  const body = moveSchema.parse(req.body);
  const result = await withTransaction((client) =>
    moveProjectImpl(client, {
      projectId: String(req.params.id),
      toLaneId: body.swim_lane_id,
      position: body.position,
      userId: req.user!.id,
    }),
  );
  res.json(result);
});

/**
 * Move a project into the workspace's archive lane. The lane's id is
 * resolved server-side so non-admins (who never see the lane in their
 * swim-lanes response) can still archive their own work with one click.
 */
projectsRouter.post("/:id/archive", requireWrite, async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: laneRows } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes WHERE is_archive = TRUE LIMIT 1`,
    );
    const archiveLaneId = laneRows[0]?.id;
    if (!archiveLaneId) {
      throw new HttpError(400, "no archive lane is configured. Ask an admin to flag one in Admin → Swim lanes.");
    }
    return moveProjectImpl(client, {
      projectId: String(req.params.id),
      toLaneId: archiveLaneId,
      userId: req.user!.id,
    });
  });
  res.json(result);
});

projectsRouter.delete("/:id", requireWrite, async (req, res) => {
  const projectId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [projectId],
    );
    if (!updated[0]) throw new HttpError(404, "project not found or already deleted");
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "archive",
    });
    const { rows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return rows[0]!;
  });
  res.json(result);
});

projectsRouter.post("/:id/restore", requireWrite, async (req, res) => {
  const projectId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [projectId],
    );
    if (!updated[0]) throw new HttpError(404, "project not found");
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "restore",
    });
    const { rows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return rows[0]!;
  });
  res.json(result);
});

/**
 * Unified timeline: lane movements (from `status_history`) merged with
 * per-field edits, creates, archives, and restores (from
 * `project_audit_events`), normalized to a single row shape and sorted
 * ascending. The frontend renders each row as one line in the audit
 * trail without caring which underlying table it came from.
 */
projectsRouter.get("/:id/history", async (req, res) => {
  const { rows } = await query<TimelineEntryRow>(
    `SELECT id, project_id, moved_by_user_id AS user_id, "timestamp",
            'move'::text AS kind,
            from_swim_lane_id, to_swim_lane_id,
            NULL::text AS field, NULL::jsonb AS from_value, NULL::jsonb AS to_value
       FROM status_history
      WHERE project_id = $1
     UNION ALL
     SELECT id, project_id, user_id, "timestamp",
            action AS kind,
            NULL::uuid AS from_swim_lane_id, NULL::uuid AS to_swim_lane_id,
            field, from_value, to_value
       FROM project_audit_events
      WHERE project_id = $1
      ORDER BY "timestamp" ASC`,
    [req.params.id],
  );
  res.json(rows);
});
