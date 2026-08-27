import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { parseFeatureGroupCsv } from "../lib/featureGroupCsvImport.js";
import { PRIORITY_TIERS, type PriorityTier } from "../lib/priorityTiers.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { FeatureGroupFeatureRow, FeatureGroupRow } from "../types.js";

export const featureGroupsRouter = Router();

export { PRIORITY_TIERS, type PriorityTier };

type FeatureGroupDto = FeatureGroupRow & {
  creator_name: string;
  feature_count: number;
};

type FeatureGroupFeatureDto = FeatureGroupFeatureRow & {
  creator_name: string;
};

type FeatureGroupDetailDto = FeatureGroupDto & {
  features: FeatureGroupFeatureDto[];
};

const GROUP_LIST_SQL = `
  SELECT fg.*,
         u.name AS creator_name,
         (SELECT COUNT(*)::int
            FROM feature_group_features fgf
           WHERE fgf.feature_group_id = fg.id) AS feature_count
    FROM feature_groups fg
    JOIN users u ON u.id = fg.created_by
   WHERE fg.group_id = $1
   ORDER BY fg.position ASC, fg.created_at ASC
`;

const FEATURE_SELECT = `
  SELECT fgf.*,
         u.name AS creator_name
    FROM feature_group_features fgf
    JOIN users u ON u.id = fgf.created_by
   WHERE fgf.feature_group_id = $1
   ORDER BY fgf.rank ASC, fgf.created_at ASC
`;

async function loadGroupDto(groupId: string, tenantId: string): Promise<FeatureGroupDto | null> {
  const { rows } = await query<FeatureGroupDto>(
    `SELECT fg.*,
            u.name AS creator_name,
            (SELECT COUNT(*)::int
               FROM feature_group_features fgf
              WHERE fgf.feature_group_id = fg.id) AS feature_count
       FROM feature_groups fg
       JOIN users u ON u.id = fg.created_by
      WHERE fg.id = $1 AND fg.group_id = $2`,
    [groupId, tenantId],
  );
  return rows[0] ?? null;
}

async function loadGroupDetail(groupId: string, tenantId: string): Promise<FeatureGroupDetailDto | null> {
  const group = await loadGroupDto(groupId, tenantId);
  if (!group) return null;
  const { rows: features } = await query<FeatureGroupFeatureDto>(FEATURE_SELECT, [groupId]);
  return { ...group, features };
}

function assertCreatorOrAdmin(
  createdBy: string,
  userId: string,
  role: string | undefined,
): void {
  const isCreator = createdBy === userId;
  const isAdmin = role === "admin";
  if (!isCreator && !isAdmin) {
    throw new HttpError(403, "only the creator or an admin may delete this group");
  }
}

featureGroupsRouter.get("/", async (req, res) => {
  const { rows } = await query<FeatureGroupDto>(GROUP_LIST_SQL, [req.groupId!]);
  res.json(rows);
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
});

featureGroupsRouter.post("/", requireWrite, async (req, res) => {
  const body = createGroupSchema.parse(req.body);
  const tenantId = req.groupId!;
  const name = body.name.trim();
  if (!name) throw new HttpError(400, "name is required");

  const id = await withTransaction(async (client) => {
    await client.query(
      `UPDATE feature_groups
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1`,
      [tenantId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feature_groups (group_id, name, description, position, created_by)
       VALUES ($1, $2, $3, 0, $4)
       RETURNING id`,
      [tenantId, name, body.description?.trim() ?? "", req.user!.id],
    );
    return rows[0]!.id;
  });

  const group = await loadGroupDto(id, tenantId);
  res.status(201).json(group);
});

const reorderGroupsSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

featureGroupsRouter.post("/reorder", requireWrite, async (req, res) => {
  const body = reorderGroupsSchema.parse(req.body);
  const tenantId = req.groupId!;

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feature_groups WHERE group_id = $1`,
      [tenantId],
    );
    const expected = new Set(rows.map((r) => r.id));
    const provided = new Set(body.order);
    if (expected.size !== provided.size || body.order.some((id) => !expected.has(id))) {
      throw new HttpError(400, "order must include every feature group exactly once");
    }
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE feature_groups SET position = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], tenantId],
      );
    }
  });

  const { rows } = await query<FeatureGroupDto>(GROUP_LIST_SQL, [tenantId]);
  res.json(rows);
});

featureGroupsRouter.get("/:id", async (req, res) => {
  const detail = await loadGroupDetail(req.params.id, req.groupId!);
  if (!detail) throw new HttpError(404, "feature group not found");
  res.json(detail);
});

const patchGroupSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
});

featureGroupsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = patchGroupSchema.parse(req.body);
  const tenantId = req.groupId!;
  const groupId = req.params.id!;
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "name" && typeof v === "string") {
      const trimmed = v.trim();
      if (!trimmed) throw new HttpError(400, "name is required");
      values.push(trimmed);
      fields.push(`name = $${values.length}`);
      continue;
    }
    if (k === "description" && typeof v === "string") {
      values.push(v.trim());
      fields.push(`description = $${values.length}`);
      continue;
    }
  }

  if (!fields.length) {
    const group = await loadGroupDto(groupId, tenantId);
    if (!group) throw new HttpError(404, "feature group not found");
    res.json(group);
    return;
  }

  values.push(groupId, tenantId);
  const { rows } = await query<{ id: string }>(
    `UPDATE feature_groups
        SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND group_id = $${values.length}
      RETURNING id`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "feature group not found");

  const group = await loadGroupDto(rows[0].id, tenantId);
  res.json(group);
});

featureGroupsRouter.delete("/:id", requireWrite, async (req, res) => {
  const tenantId = req.groupId!;
  const groupId = req.params.id!;
  const { rows } = await query<{ created_by: string }>(
    `SELECT created_by FROM feature_groups WHERE id = $1 AND group_id = $2`,
    [groupId, tenantId],
  );
  if (!rows[0]) throw new HttpError(404, "feature group not found");
  assertCreatorOrAdmin(rows[0].created_by, req.user!.id, req.userGroupRole);

  await query(`DELETE FROM feature_groups WHERE id = $1 AND group_id = $2`, [
    groupId,
    tenantId,
  ]);
  res.json({ deleted: groupId });
});

const createFeatureSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  priority_tier: z.enum(PRIORITY_TIERS).optional(),
});

featureGroupsRouter.post("/:id/features", requireWrite, async (req, res) => {
  const body = createFeatureSchema.parse(req.body);
  const tenantId = req.groupId!;
  const groupId = req.params.id!;
  const name = body.name.trim();
  if (!name) throw new HttpError(400, "name is required");

  const group = await loadGroupDto(groupId, tenantId);
  if (!group) throw new HttpError(404, "feature group not found");

  const tier: PriorityTier = body.priority_tier ?? "P3";

  const featureId = await withTransaction(async (client) => {
    const { rows: tierRows } = await client.query<{ max_pos: number | null }>(
      `SELECT COALESCE(MAX(position), -1) AS max_pos
         FROM feature_group_features
        WHERE feature_group_id = $1 AND priority_tier = $2`,
      [groupId, tier],
    );
    const nextPos = (tierRows[0]?.max_pos ?? -1) + 1;

    const { rows: rankRows } = await client.query<{ max_rank: number | null }>(
      `SELECT COALESCE(MAX(rank), -1) AS max_rank
         FROM feature_group_features
        WHERE feature_group_id = $1`,
      [groupId],
    );
    const nextRank = (rankRows[0]?.max_rank ?? -1) + 1;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feature_group_features (
         feature_group_id, name, description, priority_tier,
         position, rank, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [groupId, name, body.description?.trim() ?? "", tier, nextPos, nextRank, req.user!.id],
    );
    return rows[0]!.id;
  });

  const { rows } = await query<FeatureGroupFeatureDto>(
    `SELECT fgf.*, u.name AS creator_name
       FROM feature_group_features fgf
       JOIN users u ON u.id = fgf.created_by
      WHERE fgf.id = $1`,
    [featureId],
  );
  res.status(201).json(rows[0]);
});

const patchFeatureSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
});

featureGroupsRouter.patch("/:id/features/:featureId", requireWrite, async (req, res) => {
  const body = patchFeatureSchema.parse(req.body);
  const tenantId = req.groupId!;
  const groupId = req.params.id!;
  const featureId = req.params.featureId!;

  const group = await loadGroupDto(groupId, tenantId);
  if (!group) throw new HttpError(404, "feature group not found");

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "name" && typeof v === "string") {
      const trimmed = v.trim();
      if (!trimmed) throw new HttpError(400, "name is required");
      values.push(trimmed);
      fields.push(`name = $${values.length}`);
      continue;
    }
    if (k === "description" && typeof v === "string") {
      values.push(v.trim());
      fields.push(`description = $${values.length}`);
      continue;
    }
  }

  if (!fields.length) {
    const { rows } = await query<FeatureGroupFeatureDto>(
      `SELECT fgf.*, u.name AS creator_name
         FROM feature_group_features fgf
         JOIN users u ON u.id = fgf.created_by
        WHERE fgf.id = $1 AND fgf.feature_group_id = $2`,
      [featureId, groupId],
    );
    if (!rows[0]) throw new HttpError(404, "feature not found");
    res.json(rows[0]);
    return;
  }

  values.push(featureId, groupId);
  const { rows: updated } = await query<{ id: string }>(
    `UPDATE feature_group_features fgf
        SET ${fields.join(", ")}, updated_at = NOW()
      FROM feature_groups fg
     WHERE fgf.id = $${values.length - 1}
       AND fgf.feature_group_id = $${values.length}
       AND fg.id = fgf.feature_group_id
       AND fg.group_id = $${values.length + 1}
     RETURNING fgf.id`,
    [...values, tenantId],
  );
  if (!updated[0]) throw new HttpError(404, "feature not found");

  const { rows } = await query<FeatureGroupFeatureDto>(
    `SELECT fgf.*, u.name AS creator_name
       FROM feature_group_features fgf
       JOIN users u ON u.id = fgf.created_by
      WHERE fgf.id = $1`,
    [updated[0].id],
  );
  res.json(rows[0]);
});

featureGroupsRouter.delete("/:id/features/:featureId", requireWrite, async (req, res) => {
  const tenantId = req.groupId!;
  const groupId = req.params.id!;
  const featureId = req.params.featureId!;

  const { rows } = await query<{ id: string }>(
    `DELETE FROM feature_group_features fgf
      USING feature_groups fg
     WHERE fgf.id = $1
       AND fgf.feature_group_id = $2
       AND fg.id = fgf.feature_group_id
       AND fg.group_id = $3
     RETURNING fgf.id`,
    [featureId, groupId, tenantId],
  );
  if (!rows[0]) throw new HttpError(404, "feature not found");
  res.json({ deleted: featureId });
});

const tierListSchema = z.array(z.string().uuid());
const layoutSchema = z.object({
  P0: tierListSchema,
  P1: tierListSchema,
  P2: tierListSchema,
  P3: tierListSchema,
});

featureGroupsRouter.post("/:id/features/layout", requireWrite, async (req, res) => {
  const body = layoutSchema.parse(req.body);
  const tenantId = req.groupId!;
  const groupId = req.params.id!;

  const group = await loadGroupDto(groupId, tenantId);
  if (!group) throw new HttpError(404, "feature group not found");

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM feature_group_features WHERE feature_group_id = $1`,
      [groupId],
    );
    const expected = new Set(existing.map((r) => r.id));
    const provided = new Set([...body.P0, ...body.P1, ...body.P2, ...body.P3]);
    if (expected.size !== provided.size || [...expected].some((id) => !provided.has(id))) {
      throw new HttpError(400, "layout must include every feature exactly once");
    }

    let rank = 0;
    for (const tier of PRIORITY_TIERS) {
      const ids = body[tier];
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          `UPDATE feature_group_features
              SET priority_tier = $1, position = $2, rank = $3, updated_at = NOW()
            WHERE id = $4 AND feature_group_id = $5`,
          [tier, i, rank, ids[i], groupId],
        );
        rank += 1;
      }
    }
  });

  const detail = await loadGroupDetail(groupId, tenantId);
  res.json(detail);
});

const importCsvSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
});

featureGroupsRouter.post("/:id/features/import-csv", requireWrite, async (req, res) => {
  const { csv } = importCsvSchema.parse(req.body);
  const tenantId = req.groupId!;
  const groupId = req.params.id!;

  const group = await loadGroupDto(groupId, tenantId);
  if (!group) throw new HttpError(404, "feature group not found");

  const rows = parseFeatureGroupCsv(csv);
  const coerced_count = rows.filter((r) => r.tier_coerced).length;

  await withTransaction(async (client) => {
    const { rows: rankRows } = await client.query<{ max_rank: number | null }>(
      `SELECT COALESCE(MAX(rank), -1) AS max_rank
         FROM feature_group_features
        WHERE feature_group_id = $1`,
      [groupId],
    );
    let rank = (rankRows[0]?.max_rank ?? -1) + 1;

    const tierNextPosition = new Map<PriorityTier, number>();
    for (const tier of PRIORITY_TIERS) {
      const { rows: posRows } = await client.query<{ max_pos: number | null }>(
        `SELECT COALESCE(MAX(position), -1) AS max_pos
           FROM feature_group_features
          WHERE feature_group_id = $1 AND priority_tier = $2`,
        [groupId, tier],
      );
      tierNextPosition.set(tier, (posRows[0]?.max_pos ?? -1) + 1);
    }

    for (const row of rows) {
      const position = tierNextPosition.get(row.priority_tier)!;
      tierNextPosition.set(row.priority_tier, position + 1);

      await client.query(
        `INSERT INTO feature_group_features (
           feature_group_id, name, description, priority_tier,
           position, rank, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          groupId,
          row.name,
          row.description,
          row.priority_tier,
          position,
          rank,
          req.user!.id,
        ],
      );
      rank += 1;
    }
  });

  const detail = await loadGroupDetail(groupId, tenantId);
  res.json({
    imported_count: rows.length,
    coerced_tier_count: coerced_count,
    group: detail,
  });
});
