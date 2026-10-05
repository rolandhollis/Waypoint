import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { seedDefaultAbTestLanes } from "../lib/abTestLanes.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { AbTestItemRow, DesignItemLink } from "../types.js";

/**
 * A/B Testing board — swim lanes are admin-managed named stages.
 * Assignee is card metadata; dragging a card changes lane_id.
 */
export const abTestItemsRouter = Router();

type AbTestItemDto = AbTestItemRow & {
  creator_name: string;
  team_name: string | null;
  team_color: string | null;
  assignee_name: string | null;
  lane_name: string;
  lane_is_terminal: boolean;
};

type AbTestAuditAction = "create" | "edit" | "complete" | "delete" | "restore";

const AUDITED_FIELDS = [
  "name",
  "description",
  "team_id",
  "assigned_to",
  "lane_id",
  "jira_key",
  "links",
  "due_date",
  "is_blocked",
  "blocked_reason",
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

async function recordAudit(
  client: PoolClient,
  args: {
    itemId: string;
    userId: string | null;
    action: AbTestAuditAction;
    field?: string | null;
    from?: unknown;
    to?: unknown;
  },
) {
  await client.query(
    `INSERT INTO ab_test_item_audit_events
       (ab_test_item_id, user_id, action, field, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      args.itemId,
      args.userId,
      args.action,
      args.field ?? null,
      args.from === undefined ? null : JSON.stringify(args.from),
      args.to === undefined ? null : JSON.stringify(args.to),
    ],
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

function auditedSnapshot(row: AbTestItemRow): Record<AuditedField, unknown> {
  return {
    name: row.name,
    description: row.description,
    team_id: row.team_id,
    assigned_to: row.assigned_to,
    lane_id: row.lane_id,
    jira_key: row.jira_key,
    links: normalizeLinks(row.links),
    due_date: row.due_date ?? null,
    is_blocked: row.is_blocked ?? false,
    blocked_reason: row.blocked_reason ?? null,
  };
}

const linkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
});

function normalizeLinks(raw: unknown): DesignItemLink[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignItemLink[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const label =
      typeof (row as { label?: unknown }).label === "string"
        ? (row as { label: string }).label.trim()
        : "";
    const url =
      typeof (row as { url?: unknown }).url === "string"
        ? (row as { url: string }).url.trim()
        : "";
    if (label && url) out.push({ label, url });
  }
  return out;
}

function mapDto(row: AbTestItemDto): AbTestItemDto {
  return {
    ...row,
    links: normalizeLinks(row.links),
    jira_key: row.jira_key ?? null,
    due_date: row.due_date ?? null,
    is_blocked: row.is_blocked ?? false,
    blocked_reason: row.blocked_reason ?? null,
  };
}

const LIST_SQL = `
  SELECT ai.*,
         u.name AS creator_name,
         t.name AS team_name,
         t.color AS team_color,
         au.name AS assignee_name,
         l.name AS lane_name,
         l.is_terminal AS lane_is_terminal
    FROM ab_test_items ai
    JOIN users u ON u.id = ai.created_by
    JOIN ab_test_board_lanes l ON l.id = ai.lane_id
    LEFT JOIN teams t ON t.id = ai.team_id
    LEFT JOIN users au ON au.id = ai.assigned_to
   WHERE ai.group_id = $1
   ORDER BY
     CASE WHEN ai.deleted_at IS NOT NULL THEN 1 ELSE 0 END,
     l."order" ASC,
     CASE WHEN ai.deleted_at IS NULL THEN ai.position ELSE NULL END ASC NULLS LAST,
     CASE
       WHEN l.is_terminal THEN ai.completed_at
       WHEN ai.deleted_at IS NOT NULL THEN ai.deleted_at
       ELSE NULL
     END DESC NULLS LAST,
     ai.created_at DESC
`;

type LaneMeta = { id: string; is_terminal: boolean };

async function loadLane(
  client: PoolClient,
  laneId: string,
  groupId: string,
): Promise<LaneMeta> {
  const { rows } = await client.query<LaneMeta>(
    `SELECT id, is_terminal FROM ab_test_board_lanes
      WHERE id = $1 AND group_id = $2`,
    [laneId, groupId],
  );
  if (!rows[0]) throw new HttpError(400, "swim lane not found in this group");
  return rows[0];
}

async function firstLane(client: PoolClient, groupId: string): Promise<LaneMeta> {
  await seedDefaultAbTestLanes(client, groupId);
  const { rows } = await client.query<LaneMeta>(
    `SELECT id, is_terminal FROM ab_test_board_lanes
      WHERE group_id = $1
      ORDER BY "order" ASC
      LIMIT 1`,
    [groupId],
  );
  if (!rows[0]) throw new HttpError(400, "no swim lanes on this board");
  return rows[0];
}

async function fetchDto(id: string): Promise<AbTestItemDto | undefined> {
  const { rows } = await query<AbTestItemDto>(
    `SELECT ai.*,
            u.name AS creator_name,
            t.name AS team_name,
            t.color AS team_color,
            au.name AS assignee_name,
            l.name AS lane_name,
            l.is_terminal AS lane_is_terminal
       FROM ab_test_items ai
       JOIN users u ON u.id = ai.created_by
       JOIN ab_test_board_lanes l ON l.id = ai.lane_id
       LEFT JOIN teams t ON t.id = ai.team_id
       LEFT JOIN users au ON au.id = ai.assigned_to
      WHERE ai.id = $1`,
    [id],
  );
  return rows[0] ? mapDto(rows[0]) : undefined;
}

async function assertTeamInGroup(client: PoolClient, teamId: string, groupId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM teams WHERE id = $1 AND group_id = $2`,
    [teamId, groupId],
  );
  if (!rows[0]) throw new HttpError(400, "team not found in this group");
}

async function assertUserInGroup(client: PoolClient, userId: string, groupId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT u.id FROM users u
      JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $2
     WHERE u.id = $1`,
    [userId, groupId],
  );
  if (!rows[0]) throw new HttpError(400, "assignee not found in this group");
}

abTestItemsRouter.get("/", async (req, res) => {
  await withTransaction(async (client) => {
    await seedDefaultAbTestLanes(client, req.groupId!);
  });
  const { rows } = await query<AbTestItemDto>(LIST_SQL, [req.groupId!]);
  res.json(rows.map(mapDto));
});

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  lane_id: z.string().uuid().optional(),
  jira_key: z.string().trim().max(64).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
  due_date: z.string().nullable().optional(),
  is_blocked: z.boolean().optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
});

abTestItemsRouter.post("/", requireWrite, async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  const name = body.name.trim();
  if (!name) throw new HttpError(400, "name is required");

  const result = await withTransaction(async (client) => {
    if (body.team_id) await assertTeamInGroup(client, body.team_id, groupId);
    if (body.assigned_to) await assertUserInGroup(client, body.assigned_to, groupId);

    const lane = body.lane_id
      ? await loadLane(client, body.lane_id, groupId)
      : await firstLane(client, groupId);

    await client.query(
      `UPDATE ab_test_items
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1
          AND deleted_at IS NULL
          AND lane_id = $2`,
      [groupId, lane.id],
    );

    const jiraKey =
      body.jira_key === undefined ? null : body.jira_key?.trim() || null;
    const links = body.links ?? [];
    const dueDate =
      body.due_date === undefined ? null : body.due_date?.trim() || null;
    const isBlocked = body.is_blocked ?? false;
    const blockedReason = isBlocked ? body.blocked_reason?.trim() || null : null;
    const completedAt = lane.is_terminal ? new Date() : null;

    const { rows } = await client.query<AbTestItemRow>(
      `INSERT INTO ab_test_items (
         group_id, name, description, team_id, lane_id,
         jira_key, links, due_date, is_blocked, blocked_reason,
         position, assigned_to, created_by, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7::jsonb, $8, $9, $10,
         0, $11, $12, $13
       )
       RETURNING *`,
      [
        groupId,
        name,
        body.description?.trim() ?? "",
        body.team_id ?? null,
        lane.id,
        jiraKey,
        JSON.stringify(links),
        dueDate,
        isBlocked,
        blockedReason,
        body.assigned_to ?? null,
        req.user!.id,
        completedAt,
      ],
    );
    const created = rows[0]!;
    await recordAudit(client, {
      itemId: created.id,
      userId: req.user!.id,
      action: "create",
    });
    if (lane.is_terminal) {
      await recordAudit(client, {
        itemId: created.id,
        userId: req.user!.id,
        action: "complete",
      });
    }
    return created;
  });

  res.status(201).json(await fetchDto(result.id));
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  lane_id: z.string().uuid().optional(),
  jira_key: z.string().trim().max(64).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
  due_date: z.string().nullable().optional(),
  is_blocked: z.boolean().optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
});

abTestItemsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const itemId = String(req.params.id);

  const updated = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<AbTestItemRow>(
      `SELECT * FROM ab_test_items
        WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [itemId, groupId],
    );
    if (!existingRows[0]) throw new HttpError(404, "ab test item not found or not editable");
    const existing = existingRows[0];

    if (body.team_id) await assertTeamInGroup(client, body.team_id, groupId);
    if (body.assigned_to) await assertUserInGroup(client, body.assigned_to, groupId);

    const prevLane = await loadLane(client, existing.lane_id, groupId);
    const nextLane = body.lane_id
      ? await loadLane(client, body.lane_id, groupId)
      : prevLane;

    const nextName = body.name !== undefined ? body.name.trim() : existing.name;
    if (!nextName) throw new HttpError(400, "name is required");

    const nextBlocked =
      body.is_blocked !== undefined ? body.is_blocked : existing.is_blocked;
    const nextBlockedReason = nextBlocked
      ? body.blocked_reason !== undefined
        ? body.blocked_reason?.trim() || null
        : existing.blocked_reason
      : null;

    let completedAt = existing.completed_at;
    if (nextLane.is_terminal && !prevLane.is_terminal) {
      completedAt = new Date();
    } else if (!nextLane.is_terminal && prevLane.is_terminal) {
      completedAt = null;
    }

    if (body.lane_id && body.lane_id !== existing.lane_id) {
      await client.query(
        `UPDATE ab_test_items
            SET position = position + 1, updated_at = NOW()
          WHERE group_id = $1
            AND deleted_at IS NULL
            AND lane_id = $2
            AND id <> $3`,
        [groupId, body.lane_id, itemId],
      );
    }

    const { rows } = await client.query<AbTestItemRow>(
      `UPDATE ab_test_items
          SET name = $1,
              description = $2,
              team_id = $3,
              assigned_to = $4,
              lane_id = $5,
              jira_key = $6,
              links = $7::jsonb,
              due_date = $8,
              is_blocked = $9,
              blocked_reason = $10,
              position = CASE WHEN $11::boolean THEN 0 ELSE position END,
              completed_at = $12,
              updated_at = NOW()
        WHERE id = $13 AND group_id = $14 AND deleted_at IS NULL
        RETURNING *`,
      [
        nextName,
        body.description !== undefined
          ? body.description.trim()
          : existing.description,
        body.team_id !== undefined ? body.team_id : existing.team_id,
        body.assigned_to !== undefined ? body.assigned_to : existing.assigned_to,
        nextLane.id,
        body.jira_key !== undefined
          ? body.jira_key?.trim() || null
          : existing.jira_key,
        JSON.stringify(
          body.links !== undefined ? body.links : normalizeLinks(existing.links),
        ),
        body.due_date !== undefined
          ? body.due_date?.trim() || null
          : existing.due_date,
        nextBlocked,
        nextBlockedReason,
        body.lane_id !== undefined && body.lane_id !== existing.lane_id,
        completedAt,
        itemId,
        groupId,
      ],
    );
    if (!rows[0]) throw new HttpError(404, "ab test item not found or not editable");

    const before = auditedSnapshot(existing);
    const after = auditedSnapshot(rows[0]);
    for (const field of AUDITED_FIELDS) {
      if (!valuesEqual(before[field], after[field])) {
        await recordAudit(client, {
          itemId,
          userId: req.user!.id,
          action: "edit",
          field,
          from: before[field],
          to: after[field],
        });
      }
    }
    if (!prevLane.is_terminal && nextLane.is_terminal) {
      await recordAudit(client, {
        itemId,
        userId: req.user!.id,
        action: "complete",
      });
    } else if (prevLane.is_terminal && !nextLane.is_terminal) {
      await recordAudit(client, {
        itemId,
        userId: req.user!.id,
        action: "restore",
      });
    }
    return rows[0];
  });

  res.json(await fetchDto(updated.id));
});

const boardLayoutSchema = z.object({
  columns: z.array(
    z.object({
      lane_id: z.string().uuid(),
      item_ids: z.array(z.string().uuid()),
    }),
  ),
});

abTestItemsRouter.post("/board-layout", requireWrite, async (req, res) => {
  const body = boardLayoutSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    await seedDefaultAbTestLanes(client, groupId);
    const { rows: lanes } = await client.query<LaneMeta>(
      `SELECT id, is_terminal FROM ab_test_board_lanes WHERE group_id = $1`,
      [groupId],
    );
    const laneById = new Map(lanes.map((l) => [l.id, l]));
    const seenLanes = new Set<string>();
    for (const col of body.columns) {
      if (seenLanes.has(col.lane_id)) {
        throw new HttpError(400, "duplicate lane in board layout");
      }
      seenLanes.add(col.lane_id);
      if (!laneById.has(col.lane_id)) {
        throw new HttpError(400, `unknown swim lane ${col.lane_id}`);
      }
    }
    if (seenLanes.size !== lanes.length) {
      throw new HttpError(400, "board layout must include every swim lane");
    }

    const { rows: existing } = await client.query<AbTestItemRow>(
      `SELECT * FROM ab_test_items
        WHERE group_id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [groupId],
    );
    const byId = new Map(existing.map((r) => [r.id, r]));
    const seen = new Set<string>();

    for (const col of body.columns) {
      for (const id of col.item_ids) {
        if (seen.has(id)) throw new HttpError(400, "duplicate item in board layout");
        seen.add(id);
        if (!byId.has(id)) throw new HttpError(400, `unknown ab test item ${id}`);
      }
    }

    for (const col of body.columns) {
      const lane = laneById.get(col.lane_id)!;
      for (let i = 0; i < col.item_ids.length; i++) {
        const id = col.item_ids[i]!;
        const prev = byId.get(id)!;
        const prevLane = laneById.get(prev.lane_id);
        const wasTerminal = prevLane?.is_terminal ?? false;
        const enteringComplete = lane.is_terminal && !wasTerminal;
        const leavingComplete = !lane.is_terminal && wasTerminal;

        await client.query(
          `UPDATE ab_test_items
              SET lane_id = $1,
                  position = $2,
                  completed_at = CASE
                    WHEN $3 THEN COALESCE(completed_at, NOW())
                    ELSE NULL
                  END,
                  updated_at = NOW()
            WHERE id = $4 AND group_id = $5`,
          [lane.id, i, lane.is_terminal, id, groupId],
        );

        if (!valuesEqual(prev.lane_id, lane.id)) {
          await recordAudit(client, {
            itemId: id,
            userId: req.user!.id,
            action: "edit",
            field: "lane_id",
            from: prev.lane_id,
            to: lane.id,
          });
        }
        if (enteringComplete) {
          await recordAudit(client, {
            itemId: id,
            userId: req.user!.id,
            action: "complete",
          });
        } else if (leavingComplete) {
          await recordAudit(client, {
            itemId: id,
            userId: req.user!.id,
            action: "restore",
          });
        }
      }
    }
  });

  const { rows } = await query<AbTestItemDto>(LIST_SQL, [groupId]);
  res.json(rows.map(mapDto));
});

abTestItemsRouter.delete("/:id", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const deletedId = await withTransaction(async (client) => {
    const { rows } = await client.query<AbTestItemRow>(
      `UPDATE ab_test_items
          SET deleted_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND group_id = $2
          AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id, groupId],
    );
    if (!rows[0]) {
      throw new HttpError(404, "ab test item not found or already archived");
    }
    await recordAudit(client, {
      itemId: rows[0].id,
      userId: req.user!.id,
      action: "delete",
    });
    return rows[0].id;
  });
  res.json({ deleted: deletedId });
});

abTestItemsRouter.get("/:id/history", async (req, res) => {
  const groupId = req.groupId!;
  const itemId = String(req.params.id);
  const { rows: ownership } = await query<{ id: string }>(
    `SELECT id FROM ab_test_items WHERE id = $1 AND group_id = $2`,
    [itemId, groupId],
  );
  if (!ownership[0]) throw new HttpError(404, "ab test item not found");

  const { rows } = await query<{
    id: string;
    ab_test_item_id: string;
    user_id: string | null;
    timestamp: Date;
    kind: string;
    field: string | null;
    from_value: unknown;
    to_value: unknown;
  }>(
    `SELECT id, ab_test_item_id, user_id, "timestamp",
            action AS kind,
            field, from_value, to_value
       FROM ab_test_item_audit_events
      WHERE ab_test_item_id = $1
      ORDER BY "timestamp" ASC`,
    [itemId],
  );
  res.json(rows);
});
