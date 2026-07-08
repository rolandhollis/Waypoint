import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { SwimLaneRow } from "../types.js";

export const swimLanesRouter = Router();

swimLanesRouter.get("/", async (req, res) => {
  // Admin-only lanes (Archive et al) are filtered server-side rather
  // than by the client, so a non-admin can never obtain their ids
  // — even via curl. Admins see the full list, including hidden lanes.
  const isAdmin = req.user?.role === "admin";
  const { rows } = await query<SwimLaneRow>(
    isAdmin
      ? `SELECT * FROM swim_lanes ORDER BY "order" ASC`
      : `SELECT * FROM swim_lanes WHERE is_admin_only = FALSE ORDER BY "order" ASC`,
  );
  res.json(rows);
});

const PHASE_DATE_KEYS = [
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000).optional(),
  color: z.string().max(32).nullable().optional(),
  is_terminal: z.boolean().optional(),
  requires_weekly_status: z.boolean().optional(),
  is_default_new: z.boolean().optional(),
  is_admin_only: z.boolean().optional(),
  is_archive: z.boolean().optional(),
  phase_date_key: z.enum(PHASE_DATE_KEYS).nullable().optional(),
});

swimLanesRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    if (body.is_default_new) {
      await client.query(`UPDATE swim_lanes SET is_default_new = FALSE WHERE is_default_new = TRUE`);
    }
    // Same partial-unique-index dance as is_default_new: clear any prior
    // archive lane before creating a new one flagged as the archive.
    if (body.is_archive) {
      await client.query(`UPDATE swim_lanes SET is_archive = FALSE WHERE is_archive = TRUE`);
    }
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM swim_lanes`,
    );
    const nextOrder = maxRows[0]?.next ?? 0;
    const { rows } = await client.query<SwimLaneRow>(
      `INSERT INTO swim_lanes
         (name, description, "order", color, is_terminal, requires_weekly_status,
          is_default_new, is_admin_only, is_archive, phase_date_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        body.name, body.description ?? "", nextOrder, body.color ?? null,
        body.is_terminal ?? false, body.requires_weekly_status ?? false,
        body.is_default_new ?? false,
        body.is_admin_only ?? false,
        body.is_archive ?? false,
        body.phase_date_key ?? null,
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
  is_default_new: z.boolean().optional(),
  is_admin_only: z.boolean().optional(),
  is_archive: z.boolean().optional(),
  phase_date_key: z.enum(PHASE_DATE_KEYS).nullable().optional(),
});

// Columns the patch is allowed to write, guarding the dynamic SET.
const PATCHABLE_COLUMNS = new Set(Object.keys(patchSchema.shape));

swimLanesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const laneId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    // Promoting this lane to be the new-item default must first clear
    // whichever lane currently holds the flag, otherwise the partial
    // unique index would reject the update.
    if (body.is_default_new === true) {
      await client.query(
        `UPDATE swim_lanes SET is_default_new = FALSE WHERE is_default_new = TRUE AND id <> $1`,
        [laneId],
      );
    }
    // Same treatment for the "archive" flag: it's guarded by the same
    // sort of partial unique index (only one lane may be the archive
    // at a time), so clear the previous holder in the same txn.
    if (body.is_archive === true) {
      await client.query(
        `UPDATE swim_lanes SET is_archive = FALSE WHERE is_archive = TRUE AND id <> $1`,
        [laneId],
      );
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (!PATCHABLE_COLUMNS.has(k)) continue;
      values.push(v);
      fields.push(`"${k}" = $${values.length}`);
    }
    if (!fields.length) {
      const { rows } = await client.query<SwimLaneRow>(
        `SELECT * FROM swim_lanes WHERE id = $1`,
        [laneId],
      );
      if (!rows[0]) throw new HttpError(404, "swim lane not found");
      return rows[0];
    }
    values.push(laneId);
    const { rows } = await client.query<SwimLaneRow>(
      `UPDATE swim_lanes SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) throw new HttpError(404, "swim lane not found");
    return rows[0];
  });
  res.json(result);
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
 *   - If lane has cards and at least one other lane exists, admin must pass reassign_to.
 *   - If lane has cards and it is the only remaining lane, refuse the delete
 *     (projects.swim_lane_id is NOT NULL — see migration 010).
 *   - Empty lanes always delete freely.
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
      // Last remaining lane still holds cards — every project must
      // live in a lane, so the admin needs to create a new lane and
      // reassign these first.
      throw new HttpError(400, "cannot delete the only remaining swim lane while it still holds cards");
    }

    await client.query(`DELETE FROM swim_lanes WHERE id = $1`, [lane.id]);
    return { deleted: lane.id };
  });
  res.json(result);
});
