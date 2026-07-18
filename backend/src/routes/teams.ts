import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { TeamRow } from "../types.js";

/**
 * Team CRUD, scoped to the caller's current tenant. Teams are
 * per-group in the multi-tenant model — RMN's "Martech pod" is
 * unrelated to VC's "Growth" team.
 */
export const teamsRouter = Router();

const DEFAULT_PALETTE = [
  "#ef4444", "#3b82f6", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

teamsRouter.get("/", async (req, res) => {
  const { rows } = await query<TeamRow>(
    `SELECT * FROM teams WHERE group_id = $1 ORDER BY "order" ASC, name ASC`,
    [req.groupId!],
  );
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().max(32).optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
});

teamsRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM teams WHERE group_id = $1`,
      [groupId],
    );
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? DEFAULT_PALETTE[n % DEFAULT_PALETTE.length]!;
    const capacity = body.capacity === undefined ? 3 : body.capacity;
    const { rows } = await client.query<TeamRow>(
      `INSERT INTO teams (group_id, name, color, capacity, "order", created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [groupId, body.name, color, capacity, n, req.user!.id],
    );
    return rows[0];
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().max(32).optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
});

teamsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<TeamRow>(
      `SELECT * FROM teams WHERE id = $1 AND group_id = $2`,
      [req.params.id, groupId],
    );
    if (!rows[0]) throw new HttpError(404, "team not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id, groupId);
  const { rows } = await query<TeamRow>(
    `UPDATE teams SET ${fields.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND group_id = $${values.length}
       RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "team not found");
  res.json(rows[0]);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

teamsRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE teams SET "order" = $1, updated_at = NOW() WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], groupId],
      );
    }
  });
  const { rows } = await query<TeamRow>(
    `SELECT * FROM teams WHERE group_id = $1 ORDER BY "order" ASC, name ASC`,
    [groupId],
  );
  res.json(rows);
});

const deleteSchema = z.object({
  reassign_to: z.string().uuid().nullable().optional(),
});

teamsRouter.delete("/:id", requireAdmin, async (req, res) => {
  const body = deleteSchema.parse(req.body ?? {});
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: teamRows } = await client.query<TeamRow>(
      `SELECT * FROM teams WHERE id = $1 AND group_id = $2 FOR UPDATE`,
      [req.params.id, groupId],
    );
    const team = teamRows[0];
    if (!team) throw new HttpError(404, "team not found");

    if (body.reassign_to) {
      // Reassignment target must live in the same tenant.
      const { rows: check } = await client.query<{ id: string }>(
        `SELECT id FROM teams WHERE id = $1 AND group_id = $2`,
        [body.reassign_to, groupId],
      );
      if (!check[0]) throw new HttpError(400, "reassign_to must be a team in this group");
      // For every project that referenced the deleted team, either
      // do nothing (target team is already listed — ON CONFLICT) or
      // append the target team at the end of that project's team
      // ordering. Appending is the least-surprising outcome: the PM
      // never picked a rank for the reassigned team, so it should
      // land after every position they *did* pick.
      await client.query(
        `INSERT INTO project_teams (project_id, team_id, position)
           SELECT src.project_id,
                  $1,
                  COALESCE(
                    (SELECT MAX(pt2.position) + 1
                       FROM project_teams pt2
                      WHERE pt2.project_id = src.project_id),
                    0
                  )
             FROM project_teams src
            WHERE src.team_id = $2
         ON CONFLICT DO NOTHING`,
        [body.reassign_to, team.id],
      );
    }

    await client.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
    return { deleted: team.id };
  });
  res.json(result);
});
