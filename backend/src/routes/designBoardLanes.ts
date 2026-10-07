import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const designBoardLanesRouter = Router();

export type DesignBoardLaneRow = {
  id: string;
  group_id: string;
  user_id: string;
  name: string;
  order: number;
  created_at: Date;
  updated_at: Date;
  user_name: string;
  user_color: string | null;
  user_email: string;
};

const LANE_SELECT = `
  SELECT l.id, l.group_id, l.user_id, l.name, l."order", l.created_at, l.updated_at,
         u.name AS user_name, u.color AS user_color, u.email AS user_email
    FROM design_board_lanes l
    JOIN users u ON u.id = l.user_id
   WHERE l.group_id = $1
   ORDER BY l."order" ASC, l.name ASC
`;

designBoardLanesRouter.get("/", async (req, res) => {
  const { rows } = await query<DesignBoardLaneRow>(LANE_SELECT, [req.groupId!]);
  res.json(rows);
});

const createSchema = z.object({
  user_id: z.string().uuid(),
  name: z.string().trim().min(1).max(256).optional(),
});

designBoardLanesRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;

  const result = await withTransaction(async (client) => {
    // User must be a member of this group (or super-user).
    const { rows: memberRows } = await client.query<{ id: string; name: string }>(
      `SELECT u.id, u.name
         FROM users u
        WHERE u.id = $1
          AND (
            u.is_super_user = TRUE
            OR EXISTS (
              SELECT 1 FROM user_groups ug
               WHERE ug.user_id = u.id AND ug.group_id = $2
            )
          )`,
      [body.user_id, groupId],
    );
    if (!memberRows[0]) {
      throw new HttpError(400, "user is not a member of this group");
    }

    const { rows: existing } = await client.query(
      `SELECT 1 FROM design_board_lanes WHERE group_id = $1 AND user_id = $2`,
      [groupId, body.user_id],
    );
    if (existing[0]) {
      throw new HttpError(409, "that user already has a swim lane on this board");
    }

    const laneName = (body.name?.trim() || memberRows[0].name).trim();
    if (!laneName) throw new HttpError(400, "name is required");

    const { rows: dup } = await client.query<{ id: string }>(
      `SELECT id FROM design_board_lanes
        WHERE group_id = $1 AND lower(name) = lower($2)`,
      [groupId, laneName],
    );
    if (dup[0]) {
      throw new HttpError(409, "a swim lane with that name already exists");
    }

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX("order"), -1) + 1 AS next
         FROM design_board_lanes WHERE group_id = $1`,
      [groupId],
    );
    const nextOrder = maxRows[0]?.next ?? 0;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO design_board_lanes (group_id, user_id, name, "order")
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [groupId, body.user_id, laneName, nextOrder],
    );
    return rows[0]!.id;
  });

  const { rows: created } = await query<DesignBoardLaneRow>(
    `SELECT l.id, l.group_id, l.user_id, l.name, l."order", l.created_at, l.updated_at,
            u.name AS user_name, u.color AS user_color, u.email AS user_email
       FROM design_board_lanes l
       JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`,
    [result],
  );
  res.status(201).json(created[0]);
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(256),
});

designBoardLanesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const laneId = String(req.params.id);
  const nextName = body.name.trim();
  if (!nextName) throw new HttpError(400, "name is required");

  const updated = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM design_board_lanes
        WHERE id = $1 AND group_id = $2
        FOR UPDATE`,
      [laneId, groupId],
    );
    if (!existing[0]) throw new HttpError(404, "swim lane not found");

    const { rows: dup } = await client.query<{ id: string }>(
      `SELECT id FROM design_board_lanes
        WHERE group_id = $1 AND lower(name) = lower($2) AND id <> $3`,
      [groupId, nextName, laneId],
    );
    if (dup[0]) throw new HttpError(409, "a swim lane with that name already exists");

    await client.query(
      `UPDATE design_board_lanes
          SET name = $1, updated_at = NOW()
        WHERE id = $2 AND group_id = $3`,
      [nextName, laneId, groupId],
    );
    return laneId;
  });

  const { rows } = await query<DesignBoardLaneRow>(
    `SELECT l.id, l.group_id, l.user_id, l.name, l."order", l.created_at, l.updated_at,
            u.name AS user_name, u.color AS user_color, u.email AS user_email
       FROM design_board_lanes l
       JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`,
    [updated],
  );
  res.json(rows[0]);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

designBoardLanesRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE design_board_lanes
            SET "order" = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], groupId],
      );
    }
  });
  const { rows } = await query<DesignBoardLaneRow>(LANE_SELECT, [groupId]);
  res.json(rows);
});

/**
 * DELETE /design-board-lanes/:id
 *
 * Removes the person column. Active tickets assigned to that user
 * move to the top of Unassigned (preserving relative order).
 * Completed tickets keep their assignee for history but lose the
 * person column.
 */
designBoardLanesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const groupId = req.groupId!;
  const laneId = String(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: laneRows } = await client.query<{
      id: string;
      user_id: string;
      name: string;
    }>(
      `SELECT l.id, l.user_id, l.name
         FROM design_board_lanes l
        WHERE l.id = $1 AND l.group_id = $2
        FOR UPDATE`,
      [laneId, groupId],
    );
    const lane = laneRows[0];
    if (!lane) throw new HttpError(404, "swim lane not found");

    const { rows: movingRows } = await client.query<{ id: string }>(
      `SELECT id FROM design_items
        WHERE group_id = $1
          AND assigned_to = $2
          AND status IN ('next_up', 'in_design')
          AND deleted_at IS NULL
        ORDER BY position ASC`,
      [groupId, lane.user_id],
    );
    const movingCount = movingRows.length;

    if (movingCount > 0) {
      // Make room at the top of Unassigned.
      await client.query(
        `UPDATE design_items
            SET position = position + $1, updated_at = NOW()
          WHERE group_id = $2
            AND assigned_to IS NULL
            AND status IN ('next_up', 'in_design')
            AND deleted_at IS NULL`,
        [movingCount, groupId],
      );

      for (let i = 0; i < movingRows.length; i++) {
        await client.query(
          `UPDATE design_items
              SET assigned_to = NULL,
                  position = $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [i, movingRows[i]!.id],
        );
      }
    }

    await client.query(`DELETE FROM design_board_lanes WHERE id = $1`, [lane.id]);
    return {
      deleted: lane.id,
      user_id: lane.user_id,
      name: lane.name,
      tickets_moved: movingCount,
    };
  });

  res.json(result);
});
