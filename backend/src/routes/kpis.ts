import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { KpiRow } from "../types.js";

/**
 * KPI CRUD, scoped to the caller's current tenant. Every read /
 * write filters by req.groupId so RMN and VC KPIs stay independent.
 */
export const kpisRouter = Router();

const DEFAULT_PALETTE = [
  "#0ea5e9", "#22c55e", "#a855f7", "#f43f5e",
  "#eab308", "#14b8a6", "#f97316", "#6366f1",
];

kpisRouter.get("/", async (req, res) => {
  const { rows } = await query<KpiRow>(
    `SELECT * FROM kpis WHERE group_id = $1 ORDER BY "order" ASC, name ASC`,
    [req.groupId!],
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
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM kpis WHERE group_id = $1`,
      [groupId],
    );
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? DEFAULT_PALETTE[n % DEFAULT_PALETTE.length]!;
    const { rows } = await client.query<KpiRow>(
      `INSERT INTO kpis (group_id, name, description, color, "order", created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [groupId, body.name, body.description ?? "", color, n, req.user!.id],
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
  const groupId = req.groupId!;
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<KpiRow>(
      `SELECT * FROM kpis WHERE id = $1 AND group_id = $2`,
      [req.params.id, groupId],
    );
    if (!rows[0]) throw new HttpError(404, "kpi not found");
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id, groupId);
  const { rows } = await query<KpiRow>(
    `UPDATE kpis SET ${fields.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND group_id = $${values.length}
       RETURNING *`,
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
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE kpis SET "order" = $1, updated_at = NOW() WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], groupId],
      );
    }
  });
  const { rows } = await query<KpiRow>(
    `SELECT * FROM kpis WHERE group_id = $1 ORDER BY "order" ASC, name ASC`,
    [groupId],
  );
  res.json(rows);
});

kpisRouter.delete("/:id", requireAdmin, async (req, res) => {
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: kpiRows } = await client.query<KpiRow>(
      `SELECT * FROM kpis WHERE id = $1 AND group_id = $2 FOR UPDATE`,
      [req.params.id, groupId],
    );
    const kpi = kpiRows[0];
    if (!kpi) throw new HttpError(404, "kpi not found");
    await client.query(`DELETE FROM kpis WHERE id = $1`, [kpi.id]);
    return { deleted: kpi.id };
  });
  res.json(result);
});
