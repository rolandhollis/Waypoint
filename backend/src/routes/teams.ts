import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { TeamRow } from "../types.js";

/**
 * Team CRUD. Renamed from `productAreas` in migration 006 — a project
 * can now belong to any number of teams via the `project_teams` join
 * table, and single-select assignments were migrated across.
 */
export const teamsRouter = Router();

const DEFAULT_PALETTE = [
  "#ef4444", "#3b82f6", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

teamsRouter.get("/", async (_req, res) => {
  const { rows } = await query<TeamRow>(
    `SELECT * FROM teams ORDER BY "order" ASC, name ASC`,
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
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM teams`);
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? DEFAULT_PALETTE[n % DEFAULT_PALETTE.length]!;
    // Explicit null = "no cap"; undefined falls through to the column
    // default (3) set in migration 015.
    const capacity = body.capacity === undefined ? 3 : body.capacity;
    const { rows } = await client.query<TeamRow>(
      `INSERT INTO teams (name, color, capacity, "order", created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.name, color, capacity, n, req.user!.id],
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
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<TeamRow>(`SELECT * FROM teams WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "team not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<TeamRow>(
    `UPDATE teams SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
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
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE teams SET "order" = $1, updated_at = NOW() WHERE id = $2`,
        [i, body.order[i]],
      );
    }
  });
  const { rows } = await query<TeamRow>(`SELECT * FROM teams ORDER BY "order" ASC, name ASC`);
  res.json(rows);
});

const deleteSchema = z.object({
  reassign_to: z.string().uuid().nullable().optional(),
});

teamsRouter.delete("/:id", requireAdmin, async (req, res) => {
  const body = deleteSchema.parse(req.body ?? {});
  const result = await withTransaction(async (client) => {
    const { rows: teamRows } = await client.query<TeamRow>(
      `SELECT * FROM teams WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );
    const team = teamRows[0];
    if (!team) throw new HttpError(404, "team not found");

    if (body.reassign_to) {
      // Move each project currently assigned to this team over to the
      // replacement team. ON CONFLICT DO NOTHING covers projects that
      // already belong to both.
      await client.query(
        `INSERT INTO project_teams (project_id, team_id)
           SELECT project_id, $1 FROM project_teams WHERE team_id = $2
         ON CONFLICT DO NOTHING`,
        [body.reassign_to, team.id],
      );
    }

    // ON DELETE CASCADE on the join table cleans up the memberships,
    // whether or not we reassigned.
    await client.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
    return { deleted: team.id };
  });
  res.json(result);
});
