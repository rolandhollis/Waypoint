import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { ProductAreaRow } from "../types.js";

export const productAreasRouter = Router();

const DEFAULT_PALETTE = [
  "#ef4444", "#3b82f6", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

productAreasRouter.get("/", async (_req, res) => {
  const { rows } = await query<ProductAreaRow>(
    `SELECT * FROM product_areas ORDER BY "order" ASC, name ASC`,
  );
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().max(32).optional(),
});

productAreasRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM product_areas`);
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? DEFAULT_PALETTE[n % DEFAULT_PALETTE.length]!;
    const { rows } = await client.query<ProductAreaRow>(
      `INSERT INTO product_areas (name, color, "order", created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name, color, n, req.user!.id],
    );
    return rows[0];
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().max(32).optional(),
});

productAreasRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<ProductAreaRow>(`SELECT * FROM product_areas WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "product area not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<ProductAreaRow>(
    `UPDATE product_areas SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "product area not found");
  res.json(rows[0]);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

productAreasRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE product_areas SET "order" = $1, updated_at = NOW() WHERE id = $2`,
        [i, body.order[i]],
      );
    }
  });
  const { rows } = await query<ProductAreaRow>(`SELECT * FROM product_areas ORDER BY "order" ASC, name ASC`);
  res.json(rows);
});

const deleteSchema = z.object({
  reassign_to: z.string().uuid().nullable().optional(),
});

productAreasRouter.delete("/:id", requireAdmin, async (req, res) => {
  const body = deleteSchema.parse(req.body ?? {});
  const result = await withTransaction(async (client) => {
    const { rows: areaRows } = await client.query<ProductAreaRow>(
      `SELECT * FROM product_areas WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );
    const area = areaRows[0];
    if (!area) throw new HttpError(404, "product area not found");

    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM projects WHERE product_area_id = $1 AND deleted_at IS NULL`,
      [area.id],
    );
    const hasProjects = (countRows[0]?.n ?? 0) > 0;

    if (hasProjects) {
      // reassign_to may be null → "Unassigned" (per PRD §5.2a wording).
      await client.query(
        `UPDATE projects SET product_area_id = $1, updated_at = NOW()
           WHERE product_area_id = $2 AND deleted_at IS NULL`,
        [body.reassign_to ?? null, area.id],
      );
    }
    await client.query(`DELETE FROM product_areas WHERE id = $1`, [area.id]);
    return { deleted: area.id };
  });
  res.json(result);
});
