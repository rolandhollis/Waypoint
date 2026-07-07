import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { ProjectRow, StatusHistoryRow, SwimLaneRow } from "../types.js";

export const projectsRouter = Router();

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

projectsRouter.get("/", async (req, res) => {
  const q = listSchema.parse(req.query);
  const includeDeleted = q.include_deleted === "true";
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p
       ${includeDeleted ? "" : "WHERE p.deleted_at IS NULL"}
       ORDER BY p.position ASC, p.created_at ASC`,
  );
  res.json(rows);
});

projectsRouter.get("/:id", async (req, res) => {
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  res.json(rows[0]);
});

projectsRouter.post("/", requireWrite, async (req, res) => {
  const body = projectBaseSchema.parse(req.body);
  validatePhaseDates(body);
  const result = await withTransaction(async (client) => {
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM projects WHERE swim_lane_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL`,
      [body.swim_lane_id ?? null],
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
        body.swim_lane_id ?? null,
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
      [projectId, body.swim_lane_id ?? null, req.user!.id],
    );
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

    const { rows: finalRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return finalRows[0]!;
  });
  res.json(result);
});

const moveSchema = z.object({
  swim_lane_id: z.string().uuid().nullable(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post("/:id/move", requireWrite, async (req, res) => {
  const body = moveSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE`,
      [req.params.id],
    );
    const existing = existingRows[0];
    if (!existing) throw new HttpError(404, "project not found");

    const from = existing.swim_lane_id;
    const to = body.swim_lane_id;

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
    const insertAt = body.position === undefined
      ? destIds.length
      : Math.max(0, Math.min(destIds.length, body.position));
    destIds.splice(insertAt, 0, existing.id);

    // Rewrite the moved row (lane + position + any terminal-lane side effect)
    // and then compact positions in the destination lane so they stay 0..N-1
    // with no gaps and no ties.
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

    // On a cross-lane move, compact the source lane too so removing a card
    // doesn't leave a gap in its former lane's ordering.
    if (from !== to) {
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
        [existing.id, from, to, req.user!.id],
      );
    }

    const { rows: updated } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [existing.id],
    );
    return updated[0];
  });
  res.json(result);
});

projectsRouter.delete("/:id", requireWrite, async (req, res) => {
  const { rows } = await query<ProjectRow>(
    `WITH updated AS (
       UPDATE projects SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id
     )
     SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id IN (SELECT id FROM updated)`,
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "project not found or already deleted");
  res.json(rows[0]);
});

projectsRouter.post("/:id/restore", requireWrite, async (req, res) => {
  const { rows } = await query<ProjectRow>(
    `WITH updated AS (
       UPDATE projects SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING id
     )
     SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id IN (SELECT id FROM updated)`,
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  res.json(rows[0]);
});

projectsRouter.get("/:id/history", async (req, res) => {
  const { rows } = await query<StatusHistoryRow>(
    `SELECT * FROM status_history WHERE project_id = $1 ORDER BY "timestamp" ASC`,
    [req.params.id],
  );
  res.json(rows);
});
