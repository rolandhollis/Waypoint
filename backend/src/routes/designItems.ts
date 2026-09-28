import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { fireDesignAssignmentEmail } from "../notifications/designAssignmentEmail.js";
import type { DesignItemLink, DesignItemRow, DesignTicketStatus } from "../types.js";

/**
 * CRUD + person-column board layout for Product Design Tickets.
 * Lifecycle `status` (next_up / in_design / completed / deleted) is
 * separate from workflow `ticket_status` (card pill) and `assigned_to`
 * (person column). Completing a ticket keeps its assignee.
 */
export const designItemsRouter = Router();

type DesignItemDto = DesignItemRow & {
  creator_name: string;
  team_name: string | null;
  team_color: string | null;
  assignee_name: string | null;
};

const TICKET_STATUSES = ["not", "on", "risk", "review", "indev", "done"] as const;

const linkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
});

function normalizeLinks(raw: unknown): DesignItemLink[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignItemLink[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const label = typeof (row as { label?: unknown }).label === "string"
      ? (row as { label: string }).label.trim()
      : "";
    const url = typeof (row as { url?: unknown }).url === "string"
      ? (row as { url: string }).url.trim()
      : "";
    if (label && url) out.push({ label, url });
  }
  return out;
}

function mapDto(row: DesignItemDto): DesignItemDto {
  return {
    ...row,
    links: normalizeLinks(row.links),
    jira_key: row.jira_key ?? null,
    ticket_status: (row.ticket_status ?? "not") as DesignTicketStatus,
  };
}

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
  return rows[0] ? mapDto(rows[0]) : undefined;
}

async function assertAssigneeInGroup(userId: string, groupId: string) {
  const { rows } = await query<{ id: string }>(
    `SELECT u.id FROM users u
      JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $2
     WHERE u.id = $1`,
    [userId, groupId],
  );
  if (!rows[0]) throw new HttpError(400, "assignee not found in this group");
}

designItemsRouter.get("/", async (req, res) => {
  const { rows } = await query<DesignItemDto>(LIST_SQL, [req.groupId!]);
  res.json(rows.map(mapDto));
});

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(10000).optional(),
  team_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  ticket_status: z.enum(TICKET_STATUSES).optional(),
  jira_key: z.string().trim().max(64).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
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

    // New tickets land at top of their assignee (or unassigned) column.
    await client.query(
      `UPDATE design_items
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1
          AND status IN ('next_up', 'in_design')
          AND assigned_to IS NOT DISTINCT FROM $2::uuid`,
      [groupId, body.assigned_to ?? null],
    );

    const ticketStatus = body.ticket_status ?? "not";
    const jiraKey = body.jira_key === undefined
      ? null
      : body.jira_key?.trim() || null;
    const links = body.links ?? [];

    const { rows } = await client.query<DesignItemRow>(
      `INSERT INTO design_items (
         group_id, name, description, team_id, source,
         status, ticket_status, jira_key, links,
         position, assigned_to, created_by
       ) VALUES (
         $1, $2, $3, $4, 'Design Tab',
         'in_design', $5, $6, $7::jsonb,
         0, $8, $9
       )
       RETURNING *`,
      [
        groupId,
        name,
        body.description?.trim() ?? "",
        body.team_id ?? null,
        ticketStatus,
        jiraKey,
        JSON.stringify(links),
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
  ticket_status: z.enum(TICKET_STATUSES).optional(),
  jira_key: z.string().trim().max(64).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
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
    await assertAssigneeInGroup(body.assigned_to, groupId);
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
    if (k === "jira_key") {
      const trimmed = typeof v === "string" ? v.trim() : "";
      values.push(trimmed || null);
      fields.push(`jira_key = $${values.length}`);
      continue;
    }
    if (k === "links") {
      values.push(JSON.stringify(v));
      fields.push(`links = $${values.length}::jsonb`);
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

/** Legacy next_up / in_design layout (kept for older clients). */
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
  res.json(rows.map(mapDto));
});

/**
 * Person-column board layout. Each column lists item ids top→bottom.
 * Items may move between assignees, into Unassigned, or into Completed
 * (and back). Assignee is preserved when completing.
 */
const boardLayoutSchema = z.object({
  columns: z.array(
    z.object({
      assigned_to: z.string().uuid().nullable(),
      item_ids: z.array(z.string().uuid()),
    }),
  ),
  completed_ids: z.array(z.string().uuid()).default([]),
});

designItemsRouter.post("/board-layout", requireWrite, async (req, res) => {
  const body = boardLayoutSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query<{
      id: string;
      status: string;
      assigned_to: string | null;
    }>(
      `SELECT id, status, assigned_to FROM design_items
        WHERE group_id = $1 AND status IN ('next_up', 'in_design', 'completed')`,
      [groupId],
    );
    const byId = new Map(existing.map((r) => [r.id, r]));

    const seen = new Set<string>();
    for (const col of body.columns) {
      if (col.assigned_to) {
        const { rows: userRows } = await client.query<{ id: string }>(
          `SELECT u.id FROM users u
            JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $2
           WHERE u.id = $1`,
          [col.assigned_to, groupId],
        );
        if (!userRows[0]) throw new HttpError(400, "assignee not found in this group");
      }
      for (const id of col.item_ids) {
        if (seen.has(id)) throw new HttpError(400, "duplicate item in board layout");
        seen.add(id);
        if (!byId.has(id)) throw new HttpError(400, `unknown design item ${id}`);
      }
    }
    for (const id of body.completed_ids) {
      if (seen.has(id)) throw new HttpError(400, "item listed in both active and completed");
      seen.add(id);
      if (!byId.has(id)) throw new HttpError(400, `unknown design item ${id}`);
    }

    // Active person / unassigned columns
    for (const col of body.columns) {
      for (let i = 0; i < col.item_ids.length; i++) {
        const id = col.item_ids[i]!;
        const prev = byId.get(id)!;
        const nextAssignee = col.assigned_to;
        await client.query(
          `UPDATE design_items
              SET status = 'in_design',
                  assigned_to = $1,
                  position = $2,
                  completed_at = NULL,
                  ticket_status = CASE
                    WHEN $3::text = 'completed' AND ticket_status = 'done' THEN 'on'
                    ELSE ticket_status
                  END,
                  updated_at = NOW()
            WHERE id = $4 AND group_id = $5`,
          [nextAssignee, i, prev.status, id, groupId],
        );
        if (
          nextAssignee &&
          nextAssignee !== prev.assigned_to &&
          nextAssignee !== req.user!.id
        ) {
          fireDesignAssignmentEmail({
            designItemId: id,
            assigneeUserId: nextAssignee,
            assignerUserId: req.user!.id,
            groupId,
          });
        }
      }
    }

    // Completed column — keep assignee, mark done
    for (let i = 0; i < body.completed_ids.length; i++) {
      const id = body.completed_ids[i]!;
      await client.query(
        `UPDATE design_items
            SET status = 'completed',
                position = $1,
                completed_at = COALESCE(completed_at, NOW()),
                ticket_status = 'done',
                updated_at = NOW()
          WHERE id = $2 AND group_id = $3`,
        [i, id, groupId],
      );
    }
  });

  const { rows } = await query<DesignItemDto>(LIST_SQL, [groupId]);
  res.json(rows.map(mapDto));
});

designItemsRouter.post("/:id/complete", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const { rows: updated } = await query<DesignItemRow>(
    `UPDATE design_items
        SET status = 'completed',
            completed_at = NOW(),
            ticket_status = 'done',
            updated_at = NOW()
      WHERE id = $1
        AND group_id = $2
        AND status IN ('next_up', 'in_design')
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "design item not found or not active");
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
        AND status IN ('next_up', 'in_design', 'completed')
      RETURNING *`,
    [req.params.id, groupId],
  );
  if (!updated[0]) {
    throw new HttpError(404, "design item not found or already archived");
  }
  res.json({ deleted: updated[0].id });
});
