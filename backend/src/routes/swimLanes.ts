import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { SwimLaneRow } from "../types.js";

export const swimLanesRouter = Router();

swimLanesRouter.get("/", async (_req, res) => {
  const { rows } = await query<SwimLaneRow>(
    `SELECT * FROM swim_lanes ORDER BY "order" ASC`,
  );
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000).optional(),
  color: z.string().max(32).nullable().optional(),
  is_terminal: z.boolean().optional(),
  requires_weekly_status: z.boolean().optional(),
});

swimLanesRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM swim_lanes`,
    );
    const nextOrder = maxRows[0]?.next ?? 0;
    const { rows } = await client.query<SwimLaneRow>(
      `INSERT INTO swim_lanes (name, description, "order", color, is_terminal, requires_weekly_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        body.name, body.description ?? "", nextOrder, body.color ?? null,
        body.is_terminal ?? false, body.requires_weekly_status ?? false,
        req.user!.id,
      ],
    );
    return rows[0];
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(4000).optional(),
  color: z.string().max(32).nullable().optional(),
  is_terminal: z.boolean().optional(),
  requires_weekly_status: z.boolean().optional(),
});

swimLanesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<SwimLaneRow>(`SELECT * FROM swim_lanes WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "swim lane not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<SwimLaneRow>(
    `UPDATE swim_lanes SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "swim lane not found");
  res.json(rows[0]);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

swimLanesRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  await withTransaction(async (client) => {
    // Two-step reorder to avoid unique-index conflicts if we ever add one.
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE swim_lanes SET "order" = $1, updated_at = NOW() WHERE id = $2`,
        [i, body.order[i]],
      );
    }
  });
  const { rows } = await query<SwimLaneRow>(`SELECT * FROM swim_lanes ORDER BY "order" ASC`);
  res.json(rows);
});

const deleteSchema = z.object({
  reassign_to: z.string().uuid().nullable().optional(),
});

/**
 * Delete a swim lane.
 * Per PRD §5.2:
 *   - If lane has cards and at least one other lane exists, admin must pass reassign_to.
 *   - If it is the last lane, cards' swim_lane_id becomes null (Unassigned).
 */
swimLanesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const body = deleteSchema.parse(req.body ?? {});
  const result = await withTransaction(async (client) => {
    const { rows: laneRows } = await client.query<SwimLaneRow>(
      `SELECT * FROM swim_lanes WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );
    const lane = laneRows[0];
    if (!lane) throw new HttpError(404, "swim lane not found");

    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
      [lane.id],
    );
    const hasCards = (countRows[0]?.n ?? 0) > 0;

    const { rows: otherLanes } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes WHERE id <> $1`,
      [lane.id],
    );
    const hasOtherLanes = otherLanes.length > 0;

    if (hasCards && hasOtherLanes) {
      if (!body.reassign_to) {
        throw new HttpError(400, "reassign_to is required when lane has cards and other lanes exist");
      }
      if (!otherLanes.find((l) => l.id === body.reassign_to)) {
        throw new HttpError(400, "reassign_to must be another existing lane");
      }
      await client.query(
        `UPDATE projects SET swim_lane_id = $1, updated_at = NOW()
           WHERE swim_lane_id = $2 AND deleted_at IS NULL`,
        [body.reassign_to, lane.id],
      );
    } else if (hasCards) {
      // Last remaining lane — set cards to null (Unassigned).
      await client.query(
        `UPDATE projects SET swim_lane_id = NULL, updated_at = NOW()
           WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
        [lane.id],
      );
    }

    await client.query(`DELETE FROM swim_lanes WHERE id = $1`, [lane.id]);
    return { deleted: lane.id };
  });
  res.json(result);
});
