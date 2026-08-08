import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { syncDesignQueueForSimpleFeature } from "../lib/designQueue.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { SimpleFeatureRow } from "../types.js";

/**
 * CRUD + layout for small initiatives tracked outside the roadmap.
 * Active items live in `next_up` or `in_development`; completing or
 * deleting soft-archives a row with a timestamp.
 */
export const simpleFeaturesRouter = Router();

type SimpleFeatureDto = SimpleFeatureRow & {
  creator_name: string;
  team_name: string | null;
  team_color: string | null;
};

const LIST_SQL = `
  SELECT sf.*,
         u.name AS creator_name,
         t.name AS team_name,
         t.color AS team_color
    FROM simple_features sf
    JOIN users u ON u.id = sf.created_by
    LEFT JOIN teams t ON t.id = sf.team_id
   WHERE sf.group_id = $1
   ORDER BY
     CASE sf.status
       WHEN 'next_up' THEN 0
       WHEN 'in_development' THEN 1
       WHEN 'completed' THEN 2
       WHEN 'deleted' THEN 3
       ELSE 4
     END,
     CASE
       WHEN sf.status IN ('next_up', 'in_development') THEN sf.position
       ELSE NULL
     END ASC NULLS LAST,
     CASE
       WHEN sf.status = 'completed' THEN sf.completed_at
       WHEN sf.status = 'deleted' THEN sf.deleted_at
       ELSE NULL
     END DESC NULLS LAST,
     sf.created_at DESC
`;

simpleFeaturesRouter.get("/", async (req, res) => {
  const { rows } = await query<SimpleFeatureDto>(LIST_SQL, [req.groupId!]);
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  needs_design: z.boolean().optional(),
});

simpleFeaturesRouter.post("/", requireWrite, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  const name = body.name.trim();
  if (!name) throw new HttpError(400, "name is required");

  const result = await withTransaction(async (client) => {
    if (body.team_id) {
      const { rows: teamRows } = await client.query<{ id: string }>(
        `SELECT id FROM teams WHERE id = $1 AND group_id = $2`,
        [body.team_id, groupId],
      );
      if (!teamRows[0]) throw new HttpError(400, "team not found in this group");
    }

    await client.query(
      `UPDATE simple_features
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1 AND status = 'next_up'`,
      [groupId],
    );

    const { rows } = await client.query<SimpleFeatureRow>(
      `INSERT INTO simple_features (
         group_id, name, description, team_id, needs_design,
         status, position, created_by
       ) VALUES ($1, $2, $3, $4, $5, 'next_up', 0, $6)
       RETURNING *`,
      [
        groupId,
        name,
        body.description?.trim() ?? "",
        body.team_id ?? null,
        body.needs_design ?? false,
        req.user!.id,
      ],
    );
    const created = rows[0]!;
    await syncDesignQueueForSimpleFeature(client, created, req.user!.id);
    return created;
  });

  const { rows } = await query<SimpleFeatureDto>(
    `SELECT sf.*,
            u.name AS creator_name,
            t.name AS team_name,
            t.color AS team_color
       FROM simple_features sf
       JOIN users u ON u.id = sf.created_by
       LEFT JOIN teams t ON t.id = sf.team_id
      WHERE sf.id = $1`,
    [result!.id],
  );
  res.status(201).json(rows[0]);
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  needs_design: z.boolean().optional(),
});

simpleFeaturesRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;

  if (body.team_id) {
    const { rows: teamRows } = await query<{ id: string }>(
      `SELECT id FROM teams WHERE id = $1 AND group_id = $2`,
      [body.team_id, groupId],
    );
    if (!teamRows[0]) throw new HttpError(400, "team not found in this group");
  }

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
    values.push(v);
    fields.push(`${k} = $${values.length}`);
  }

  if (!fields.length) {
    const { rows } = await query<SimpleFeatureDto>(
      `SELECT sf.*,
              u.name AS creator_name,
              t.name AS team_name,
              t.color AS team_color
         FROM simple_features sf
         JOIN users u ON u.id = sf.created_by
         LEFT JOIN teams t ON t.id = sf.team_id
        WHERE sf.id = $1 AND sf.group_id = $2`,
      [req.params.id, groupId],
    );
    if (!rows[0]) throw new HttpError(404, "simple feature not found");
    res.json(rows[0]);
    return;
  }

  values.push(req.params.id, groupId);
  const { rows: updated } = await query<SimpleFeatureRow>(
    `UPDATE simple_features
        SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length - 1}
        AND group_id = $${values.length}
        AND status IN ('next_up', 'in_development')
      RETURNING *`,
    values,
  );
  if (!updated[0]) throw new HttpError(404, "simple feature not found or not editable");

  await withTransaction(async (client) => {
    await syncDesignQueueForSimpleFeature(client, updated[0]!, req.user!.id);
  });

  const { rows } = await query<SimpleFeatureDto>(
    `SELECT sf.*,
            u.name AS creator_name,
            t.name AS team_name,
            t.color AS team_color
       FROM simple_features sf
       JOIN users u ON u.id = sf.created_by
       LEFT JOIN teams t ON t.id = sf.team_id
      WHERE sf.id = $1`,
    [updated[0].id],
  );
  res.json(rows[0]);
});

const layoutSchema = z.object({
  next_up: z.array(z.string().uuid()),
  in_development: z.array(z.string().uuid()),
});

simpleFeaturesRouter.post("/layout", requireWrite, async (req, res) => {
  const body = layoutSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    const { rows: active } = await client.query<{ id: string }>(
      `SELECT id FROM simple_features
        WHERE group_id = $1 AND status IN ('next_up', 'in_development')`,
      [groupId],
    );
    const expected = new Set(active.map((r) => r.id));
    const provided = new Set([...body.next_up, ...body.in_development]);
    if (expected.size !== provided.size) {
      throw new HttpError(400, "layout must include every active item exactly once");
    }
    for (const id of expected) {
      if (!provided.has(id)) {
        throw new HttpError(400, "layout must include every active item exactly once");
      }
    }

    for (let i = 0; i < body.next_up.length; i++) {
      await client.query(
        `UPDATE simple_features
            SET status = 'next_up', position = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.next_up[i], groupId],
      );
    }
    for (let i = 0; i < body.in_development.length; i++) {
      await client.query(
        `UPDATE simple_features
            SET status = 'in_development', position = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.in_development[i], groupId],
      );
    }
  });

  const { rows } = await query<SimpleFeatureDto>(LIST_SQL, [groupId]);
  res.json(rows);
});

simpleFeaturesRouter.post("/:id/complete", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const { rows: updated } = await query<SimpleFeatureRow>(
    `UPDATE simple_features
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND group_id = $2
        AND status = 'in_development'
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "simple feature not found or not in development");
  }

  await withTransaction(async (client) => {
    await syncDesignQueueForSimpleFeature(client, updated[0]!, req.user!.id);
  });

  const { rows } = await query<SimpleFeatureDto>(
    `SELECT sf.*,
            u.name AS creator_name,
            t.name AS team_name,
            t.color AS team_color
       FROM simple_features sf
       JOIN users u ON u.id = sf.created_by
       LEFT JOIN teams t ON t.id = sf.team_id
      WHERE sf.id = $1`,
    [updated[0].id],
  );
  res.json(rows[0]);
});

simpleFeaturesRouter.delete("/:id", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const { rows: updated } = await query<SimpleFeatureRow>(
    `UPDATE simple_features
        SET status = 'deleted',
            deleted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND group_id = $2
        AND status IN ('next_up', 'in_development')
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "simple feature not found or already archived");
  }

  await withTransaction(async (client) => {
    await syncDesignQueueForSimpleFeature(client, updated[0]!, req.user!.id);
  });

  res.json({ deleted: updated[0].id });
});
