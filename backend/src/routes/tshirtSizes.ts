import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { TshirtSizeRow } from "../types.js";

/**
 * T-shirt sizes CRUD, scoped to the caller's current tenant. Backs
 * the EZEstimates view's size picker + the Admin → T-Shirt Sizes
 * tab.
 *
 * The catalog cardinality is fixed at 5 rows per group (S/M/L/XL/XXL)
 * — seeded by migration 028 for existing groups and by the group
 * create hook (backend/src/routes/groups.ts) for new ones. There's
 * no POST or DELETE here on purpose: admins can only relabel and
 * re-size, never add or remove rows.
 */
export const tshirtSizesRouter = Router();

tshirtSizesRouter.get("/", async (req, res) => {
  const { rows } = await query<TshirtSizeRow>(
    `SELECT * FROM tshirt_sizes WHERE group_id = $1 ORDER BY position ASC`,
    [req.groupId!],
  );
  res.json(rows);
});

const patchSchema = z.object({
  label: z.string().min(1).max(32).optional(),
  // Non-negative so tenants can define a 0-day preset (useful when a
  // phase like Post-Dev is expected to be a no-op for trivial items).
  // The picker interprets 0 as "phase_end == phase_start" — a valid
  // same-day window — not as "clear the phase".
  days: z.number().int().nonnegative().max(3650).optional(),
});

tshirtSizesRouter.patch("/:id", requireAdmin, async (req, res) => {
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
    const { rows } = await query<TshirtSizeRow>(
      `SELECT * FROM tshirt_sizes WHERE id = $1 AND group_id = $2`,
      [req.params.id, groupId],
    );
    if (!rows[0]) throw new HttpError(404, "tshirt size not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id, groupId);
  const { rows } = await query<TshirtSizeRow>(
    `UPDATE tshirt_sizes SET ${fields.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND group_id = $${values.length}
       RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "tshirt size not found");
  res.json(rows[0]);
});
