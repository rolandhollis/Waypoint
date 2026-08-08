import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { fireDesignAssignmentEmail } from "../notifications/designAssignmentEmail.js";
import type { DesignItemRow } from "../types.js";

/**
 * CRUD + layout for the design kanban. Active items live in `next_up`
 * or `in_design`; completing or deleting soft-archives a row.
 */
export const designItemsRouter = Router();

type DesignItemDto = DesignItemRow & {
  creator_name: string;
  team_name: string | null;
  team_color: string | null;
  assignee_name: string | null;
};

const LIST_SQL = `
  SELECT di.*,
         u.name AS creator_name,
         t.name AS team_name,
         t.color AS team_color,
         au.name AS assignee_name
    FROM design_items di
    JOIN users u ON u.id = di.created_by
    LEFT JOIN teams t ON t.id = di.team_id
    LEFT JOIN users au ON au.id = di.assigned_to
   WHERE di.group_id = $1
   ORDER BY
     CASE di.status
       WHEN 'next_up' THEN 0
       WHEN 'in_design' THEN 1
       WHEN 'completed' THEN 2
       WHEN 'deleted' THEN 3
       ELSE 4
     END,
     CASE
       WHEN di.status IN ('next_up', 'in_design') THEN di.position
       ELSE NULL
     END ASC NULLS LAST,
     CASE
       WHEN di.status = 'completed' THEN di.completed_at
       WHEN di.status = 'deleted' THEN di.deleted_at
       ELSE NULL
     END DESC NULLS LAST,
     di.created_at DESC
`;

async function fetchDto(id: string): Promise<DesignItemDto | undefined> {
  const { rows } = await query<DesignItemDto>(
    `SELECT di.*,
            u.name AS creator_name,
            t.name AS team_name,
            t.color AS team_color,
            au.name AS assignee_name
       FROM design_items di
       JOIN users u ON u.id = di.created_by
       LEFT JOIN teams t ON t.id = di.team_id
       LEFT JOIN users au ON au.id = di.assigned_to
      WHERE di.id = $1`,
    [id],
  );
  return rows[0];
}

designItemsRouter.get("/", async (req, res) => {
  const { rows } = await query<DesignItemDto>(LIST_SQL, [req.groupId!]);
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

designItemsRouter.post("/", requireWrite, async (req, res) => {
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
    if (body.assigned_to) {
      const { rows: userRows } = await client.query<{ id: string }>(
        `SELECT u.id FROM users u
          JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $2
         WHERE u.id = $1`,
        [body.assigned_to, groupId],
      );
      if (!userRows[0]) throw new HttpError(400, "assignee not found in this group");
    }

    await client.query(
      `UPDATE design_items
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1 AND status = 'next_up'`,
      [groupId],
    );

    const { rows } = await client.query<DesignItemRow>(
      `INSERT INTO design_items (
         group_id, name, description, team_id, source,
         status, position, assigned_to, created_by
       ) VALUES ($1, $2, $3, $4, 'Design Tab', 'next_up', 0, $5, $6)
       RETURNING *`,
      [
        groupId,
        name,
        body.description?.trim() ?? "",
        body.team_id ?? null,
        body.assigned_to ?? null,
        req.user!.id,
      ],
    );
    return rows[0];
  });

  const dto = await fetchDto(result!.id);
  if (body.assigned_to && body.assigned_to !== req.user!.id) {
    fireDesignAssignmentEmail({
      designItemId: result!.id,
      assigneeUserId: body.assigned_to,
      assignerUserId: req.user!.id,
      groupId,
    });
  }
  res.status(201).json(dto);
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

designItemsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const itemId = String(req.params.id);

  const { rows: existingRows } = await query<{ assigned_to: string | null }>(
    `SELECT assigned_to FROM design_items
      WHERE id = $1 AND group_id = $2 AND status IN ('next_up', 'in_design')`,
    [itemId, groupId],
  );
  if (!existingRows[0]) throw new HttpError(404, "design item not found or not editable");
  const previousAssignee = existingRows[0].assigned_to;

  if (body.team_id) {
    const { rows: teamRows } = await query<{ id: string }>(
      `SELECT id FROM teams WHERE id = $1 AND group_id = $2`,
      [body.team_id, groupId],
    );
    if (!teamRows[0]) throw new HttpError(400, "team not found in this group");
  }
  if (body.assigned_to) {
    const { rows: userRows } = await query<{ id: string }>(
      `SELECT u.id FROM users u
        JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $2
       WHERE u.id = $1`,
      [body.assigned_to, groupId],
    );
    if (!userRows[0]) throw new HttpError(400, "assignee not found in this group");
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
    const dto = await fetchDto(itemId);
    if (!dto || dto.group_id !== groupId) throw new HttpError(404, "design item not found");
    res.json(dto);
    return;
  }

  values.push(itemId, groupId);
  const { rows: updated } = await query<DesignItemRow>(
    `UPDATE design_items
        SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length - 1}
        AND group_id = $${values.length}
        AND status IN ('next_up', 'in_design')
      RETURNING *`,
    values,
  );
  if (!updated[0]) throw new HttpError(404, "design item not found or not editable");

  const dto = await fetchDto(updated[0].id);
  const newAssignee = updated[0].assigned_to;
  if (
    body.assigned_to !== undefined &&
    newAssignee &&
    newAssignee !== previousAssignee &&
    newAssignee !== req.user!.id
  ) {
    fireDesignAssignmentEmail({
      designItemId: updated[0].id,
      assigneeUserId: newAssignee,
      assignerUserId: req.user!.id,
      groupId,
    });
  }
  res.json(dto);
});

const layoutSchema = z.object({
  next_up: z.array(z.string().uuid()),
  in_design: z.array(z.string().uuid()),
});

designItemsRouter.post("/layout", requireWrite, async (req, res) => {
  const body = layoutSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    const { rows: active } = await client.query<{ id: string }>(
      `SELECT id FROM design_items
        WHERE group_id = $1 AND status IN ('next_up', 'in_design')`,
      [groupId],
    );
    const expected = new Set(active.map((r) => r.id));
    const provided = new Set([...body.next_up, ...body.in_design]);
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
        `UPDATE design_items
            SET status = 'next_up', position = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.next_up[i], groupId],
      );
    }
    for (let i = 0; i < body.in_design.length; i++) {
      await client.query(
        `UPDATE design_items
            SET status = 'in_design', position = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.in_design[i], groupId],
      );
    }
  });

  const { rows } = await query<DesignItemDto>(LIST_SQL, [groupId]);
  res.json(rows);
});

designItemsRouter.post("/:id/complete", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const { rows: updated } = await query<DesignItemRow>(
    `UPDATE design_items
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND group_id = $2
        AND status = 'in_design'
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "design item not found or not in design");
  }

  const dto = await fetchDto(updated[0].id);
  res.json(dto);
});

designItemsRouter.delete("/:id", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const { rows: updated } = await query<DesignItemRow>(
    `UPDATE design_items
        SET status = 'deleted',
            deleted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND group_id = $2
        AND status IN ('next_up', 'in_design')
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "design item not found or already archived");
  }
  res.json({ deleted: updated[0].id });
});
