import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { TshirtSizeRow } from "../types.js";

/**
 * T-shirt sizes CRUD, scoped to the caller's current tenant. Backs
 * the EZEstimates view's size picker + the Admin → T-Shirt Sizes
 * tab.
 *
 * The catalog was originally a fixed 5-row ladder (S/M/L/XL/XXL)
 * seeded by migration 028 and the group create hook (see
 * backend/src/routes/groups.ts). Migration 039 dropped the
 * UNIQUE (group_id, position) constraint so admins can now add,
 * delete, and drag-reorder rows from the Admin tab — matching the
 * teams / KPIs / swim-lanes admin surfaces.
 *
 * Validation:
 *   - `label` is non-empty and unique within the tenant (enforced
 *     both by the DB unique index and by a case-insensitive check
 *     in POST so "s" and "S" can't coexist).
 *   - `days` is a non-negative integer 0..3650. Zero is allowed and
 *     means "phase_end == phase_start" — a valid same-day window,
 *     not a "clear the phase" signal. See migration 030 for the
 *     rationale.
 *
 * Delete is safe by construction: nothing in the schema holds a FK
 * to tshirt_sizes.id (the row is a preset consumed by label lookup
 * — see nearestSizeLabel in backend/src/ai/estimator.ts), so no
 * in-use guard is required. If a future migration introduces such a
 * FK, add the guard in DELETE below and return 409 with a
 * `{ code: "TSHIRT_SIZE_IN_USE", refCount }` body.
 */
export const tshirtSizesRouter = Router();

tshirtSizesRouter.get("/", async (req, res) => {
  const { rows } = await query<TshirtSizeRow>(
    `SELECT * FROM tshirt_sizes WHERE group_id = $1 ORDER BY position ASC`,
    [req.groupId!],
  );
  res.json(rows);
});

const createSchema = z.object({
  label: z.string().min(1).max(32),
  // Match the PATCH bounds so a new preset can be added directly at
  // 0 days (same-day window; see migration 030).
  days: z.number().int().nonnegative().max(3650).optional(),
});

tshirtSizesRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  const label = body.label.trim();
  if (!label) throw new HttpError(400, "label is required");

  const result = await withTransaction(async (client) => {
    // Case-insensitive dupe check: the DB unique index is
    // case-sensitive, so without this a tenant could end up with
    // "S" and "s" side by side.
    const { rows: dupe } = await client.query<{ id: string }>(
      `SELECT id FROM tshirt_sizes WHERE group_id = $1 AND LOWER(label) = LOWER($2)`,
      [groupId, label],
    );
    if (dupe[0]) throw new HttpError(409, `a size labeled "${label}" already exists`);

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tshirt_sizes WHERE group_id = $1`,
      [groupId],
    );
    const nextPosition = maxRows[0]?.next ?? 0;
    const days = body.days ?? 7;
    const { rows } = await client.query<TshirtSizeRow>(
      `INSERT INTO tshirt_sizes (group_id, label, days, position)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [groupId, label, days, nextPosition],
    );
    return rows[0];
  });
  res.status(201).json(result);
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

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

tshirtSizesRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    // Mirrors the kpis / teams / swim-lanes reorder shape: assign
    // sequential positions inside a transaction, filtered by
    // group_id so a caller can't shuffle another tenant's rows by
    // smuggling their ids into the payload. Migration 039 dropped
    // the UNIQUE (group_id, position) constraint that would
    // otherwise trip mid-loop.
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE tshirt_sizes SET position = $1, updated_at = NOW() WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], groupId],
      );
    }
  });
  const { rows } = await query<TshirtSizeRow>(
    `SELECT * FROM tshirt_sizes WHERE group_id = $1 ORDER BY position ASC`,
    [groupId],
  );
  res.json(rows);
});

tshirtSizesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: sizeRows } = await client.query<TshirtSizeRow>(
      `SELECT * FROM tshirt_sizes WHERE id = $1 AND group_id = $2 FOR UPDATE`,
      [req.params.id, groupId],
    );
    const size = sizeRows[0];
    if (!size) throw new HttpError(404, "tshirt size not found");
    // No FK references tshirt_sizes.id today (presets are consumed
    // by label lookup via nearestSizeLabel). If that changes, add
    // the reference count + 409 { code: "TSHIRT_SIZE_IN_USE" }
    // guard here.
    await client.query(`DELETE FROM tshirt_sizes WHERE id = $1`, [size.id]);
    return { deleted: size.id };
  });
  res.json(result);
});
