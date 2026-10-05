import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { seedDefaultAbTestLanes } from "../lib/abTestLanes.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";

export const abTestBoardLanesRouter = Router();

export type AbTestBoardLaneRow = {
  id: string;
  group_id: string;
  name: string;
  order: number;
  is_terminal: boolean;
  created_at: Date;
  updated_at: Date;
};

const LANE_SELECT = `
  SELECT id, group_id, name, "order", is_terminal, created_at, updated_at
    FROM ab_test_board_lanes
   WHERE group_id = $1
   ORDER BY "order" ASC, name ASC
`;

abTestBoardLanesRouter.get("/", async (req, res) => {
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    await seedDefaultAbTestLanes(client, groupId);
  });
  const { rows } = await query<AbTestBoardLaneRow>(LANE_SELECT, [groupId]);
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(256),
  is_terminal: z.boolean().optional(),
});

abTestBoardLanesRouter.post("/", requireAdmin, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  const name = body.name.trim();

  const createdId = await withTransaction(async (client) => {
    await seedDefaultAbTestLanes(client, groupId);
    const { rows: dup } = await client.query<{ id: string }>(
      `SELECT id FROM ab_test_board_lanes
        WHERE group_id = $1 AND lower(name) = lower($2)`,
      [groupId, name],
    );
    if (dup[0]) throw new HttpError(409, "a swim lane with that name already exists");

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX("order"), -1) + 1 AS next
         FROM ab_test_board_lanes WHERE group_id = $1`,
      [groupId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ab_test_board_lanes (group_id, name, "order", is_terminal)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [groupId, name, maxRows[0]?.next ?? 0, body.is_terminal ?? false],
    );
    return rows[0]!.id;
  });

  const { rows } = await query<AbTestBoardLaneRow>(
    `SELECT id, group_id, name, "order", is_terminal, created_at, updated_at
       FROM ab_test_board_lanes WHERE id = $1`,
    [createdId],
  );
  res.status(201).json(rows[0]);
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  is_terminal: z.boolean().optional(),
});

abTestBoardLanesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const laneId = String(req.params.id);
  if (body.name === undefined && body.is_terminal === undefined) {
    throw new HttpError(400, "nothing to update");
  }

  const updated = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<AbTestBoardLaneRow>(
      `SELECT id, group_id, name, "order", is_terminal, created_at, updated_at
         FROM ab_test_board_lanes
        WHERE id = $1 AND group_id = $2
        FOR UPDATE`,
      [laneId, groupId],
    );
    if (!existing[0]) throw new HttpError(404, "swim lane not found");

    const nextName = body.name !== undefined ? body.name.trim() : existing[0].name;
    if (!nextName) throw new HttpError(400, "name is required");
    if (body.name !== undefined) {
      const { rows: dup } = await client.query<{ id: string }>(
        `SELECT id FROM ab_test_board_lanes
          WHERE group_id = $1 AND lower(name) = lower($2) AND id <> $3`,
        [groupId, nextName, laneId],
      );
      if (dup[0]) throw new HttpError(409, "a swim lane with that name already exists");
    }

    const { rows } = await client.query<AbTestBoardLaneRow>(
      `UPDATE ab_test_board_lanes
          SET name = $1,
              is_terminal = $2,
              updated_at = NOW()
        WHERE id = $3 AND group_id = $4
        RETURNING id, group_id, name, "order", is_terminal, created_at, updated_at`,
      [
        nextName,
        body.is_terminal !== undefined ? body.is_terminal : existing[0].is_terminal,
        laneId,
        groupId,
      ],
    );
    return rows[0]!;
  });

  res.json(updated);
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

abTestBoardLanesRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    for (let i = 0; i < body.order.length; i++) {
      await client.query(
        `UPDATE ab_test_board_lanes
            SET "order" = $1, updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, body.order[i], groupId],
      );
    }
  });
  const { rows } = await query<AbTestBoardLaneRow>(LANE_SELECT, [groupId]);
  res.json(rows);
});

abTestBoardLanesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const groupId = req.groupId!;
  const laneId = String(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: laneRows } = await client.query<AbTestBoardLaneRow>(
      `SELECT id, group_id, name, "order", is_terminal, created_at, updated_at
         FROM ab_test_board_lanes
        WHERE id = $1 AND group_id = $2
        FOR UPDATE`,
      [laneId, groupId],
    );
    const lane = laneRows[0];
    if (!lane) throw new HttpError(404, "swim lane not found");

    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ab_test_board_lanes WHERE group_id = $1`,
      [groupId],
    );
    if ((countRows[0]?.n ?? 0) <= 1) {
      throw new HttpError(400, "cannot delete the last swim lane");
    }

    const { rows: destRows } = await client.query<{ id: string; is_terminal: boolean }>(
      `SELECT id, is_terminal FROM ab_test_board_lanes
        WHERE group_id = $1 AND id <> $2
        ORDER BY "order" ASC
        LIMIT 1
        FOR UPDATE`,
      [groupId, laneId],
    );
    const dest = destRows[0];
    if (!dest) throw new HttpError(400, "cannot delete the last swim lane");

    const { rows: movingRows } = await client.query<{ id: string }>(
      `SELECT id FROM ab_test_items
        WHERE group_id = $1 AND lane_id = $2 AND deleted_at IS NULL
        ORDER BY position ASC
        FOR UPDATE`,
      [groupId, laneId],
    );

    if (movingRows.length > 0) {
      await client.query(
        `UPDATE ab_test_items
            SET position = position + $1, updated_at = NOW()
          WHERE group_id = $2 AND lane_id = $3 AND deleted_at IS NULL`,
        [movingRows.length, groupId, dest.id],
      );
      for (let i = 0; i < movingRows.length; i++) {
        await client.query(
          `UPDATE ab_test_items
              SET lane_id = $1,
                  position = $2,
                  completed_at = CASE WHEN $3 THEN COALESCE(completed_at, NOW()) ELSE NULL END,
                  updated_at = NOW()
            WHERE id = $4`,
          [dest.id, i, dest.is_terminal, movingRows[i]!.id],
        );
      }
    }

    await client.query(`DELETE FROM ab_test_board_lanes WHERE id = $1`, [lane.id]);
    return {
      deleted: lane.id,
      name: lane.name,
      tickets_moved: movingRows.length,
      moved_to: dest.id,
    };
  });

  res.json(result);
});
