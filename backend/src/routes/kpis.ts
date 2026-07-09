import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { KpiRow } from "../types.js";

/**
 * KPI CRUD. Mirrors the shape of the Teams router (name / description /
 * color / order + drag-reorder), so the frontend admin UI can reuse the
 * same sortable-row pattern. Reads are available to any authenticated
 * user; mutations require admin.
 */
export const kpisRouter = Router();

// Cool-neutral palette so KPI chips don't visually collide with the
// warmer team palette in `teams.ts` when both render side-by-side.
const DEFAULT_PALETTE = [
  "#0ea5e9", "#22c55e", "#a855f7", "#f43f5e",
  "#eab308", "#14b8a6", "#f97316", "#6366f1",
];

kpisRouter.get("/", async (_req, res) => {
  const { rows } = await query<KpiRow>(
    `SELECT * FROM kpis ORDER BY "order" ASC, name ASC`,
  );
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
  color: z.string().max(32).optional(),
});

kpisRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM kpis`);
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? DEFAULT_PALETTE[n % DEFAULT_PALETTE.length]!;
    const { rows } = await client.query<KpiRow>(
      `INSERT INTO kpis (name, description, color, "order", created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.name, body.description ?? "", color, n, req.user!.id],
    );
    return rows[0];
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().max(32).optional(),
});

kpisRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<KpiRow>(`SELECT * FROM kpis WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "kpi not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<KpiRow>(
    `UPDATE kpis SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "kpi not found");
  res.json(rows[0]);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

kpisRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE kpis SET "order" = $1, updated_at = NOW() WHERE id = $2`,
        [i, body.order[i]],
      );
    }
  });
  const { rows } = await query<KpiRow>(`SELECT * FROM kpis ORDER BY "order" ASC, name ASC`);
  res.json(rows);
});

kpisRouter.delete("/:id", requireAdmin, async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows: kpiRows } = await client.query<KpiRow>(
      `SELECT * FROM kpis WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );
    const kpi = kpiRows[0];
    if (!kpi) throw new HttpError(404, "kpi not found");
    // project_kpis cascades via FK ON DELETE CASCADE, so any project
    // that was tracking this KPI silently drops it. No reassign option
    // — KPIs are outcome buckets, not swappable owners.
    await client.query(`DELETE FROM kpis WHERE id = $1`, [kpi.id]);
    return { deleted: kpi.id };
  });
  res.json(result);
});
