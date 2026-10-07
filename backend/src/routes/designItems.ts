import { Router } from "express";
import type { PoolClient } from "pg";
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

type DesignAuditAction = "create" | "edit" | "complete" | "delete" | "restore";

const AUDITED_FIELDS = [
  "name",
  "description",
  "team_id",
  "assigned_to",
  "ticket_status",
  "jira_key",
  "links",
  "due_date",
  "is_blocked",
  "blocked_reason",
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

async function recordDesignAudit(
  client: PoolClient,
  args: {
    designItemId: string;
    userId: string | null;
    action: DesignAuditAction;
    field?: string | null;
    from?: unknown;
    to?: unknown;
  },
) {
  await client.query(
    `INSERT INTO design_item_audit_events
       (design_item_id, user_id, action, field, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      args.designItemId,
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

function auditedSnapshot(row: DesignItemRow): Record<AuditedField, unknown> {
  return {
    name: row.name,
    description: row.description,
    team_id: row.team_id,
    assigned_to: row.assigned_to,
    ticket_status: row.ticket_status,
    jira_key: row.jira_key,
    links: normalizeLinks(row.links),
    due_date: row.due_date ?? null,
    is_blocked: row.is_blocked ?? false,
    blocked_reason: row.blocked_reason ?? null,
  };
}

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
    due_date: row.due_date ?? null,
    is_blocked: row.is_blocked ?? false,
    blocked_reason: row.blocked_reason ?? null,
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
  due_date: z.string().nullable().optional(),
  is_blocked: z.boolean().optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
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

    // New tickets land at top of Parking Lot (in_design + null assignee)
    // or at the top of the chosen person column.
    await client.query(
      `UPDATE design_items
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1
          AND status = 'in_design'
          AND assigned_to IS NOT DISTINCT FROM $2::uuid`,
      [groupId, body.assigned_to ?? null],
    );

    const ticketStatus = body.ticket_status ?? "not";
    const jiraKey = body.jira_key === undefined
      ? null
      : body.jira_key?.trim() || null;
    const links = body.links ?? [];
    const dueDate = body.due_date === undefined
      ? null
      : body.due_date?.trim() || null;
    const isBlocked = body.is_blocked ?? false;
    const blockedReason = isBlocked
      ? (body.blocked_reason?.trim() || null)
      : null;

    const { rows } = await client.query<DesignItemRow>(
      `INSERT INTO design_items (
         group_id, name, description, team_id, source,
         status, ticket_status, jira_key, links,
         due_date, is_blocked, blocked_reason,
         position, assigned_to, created_by
       ) VALUES (
         $1, $2, $3, $4, 'Design Tab',
         'in_design', $5, $6, $7::jsonb,
         $8, $9, $10,
         0, $11, $12
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
        dueDate,
        isBlocked,
        blockedReason,
        body.assigned_to ?? null,
        req.user!.id,
      ],
    );
    const created = rows[0]!;
    await recordDesignAudit(client, {
      designItemId: created.id,
      userId: req.user!.id,
      action: "create",
    });
    return created;
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
  /** Lifecycle column: next_up = Backlog, in_design = Parking Lot / person. */
  status: z.enum(["next_up", "in_design"]).optional(),
  ticket_status: z.enum(TICKET_STATUSES).optional(),
  jira_key: z.string().trim().max(64).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
  due_date: z.string().nullable().optional(),
  is_blocked: z.boolean().optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
});

designItemsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  const itemId = String(req.params.id);

  const updated = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<DesignItemRow>(
      `SELECT * FROM design_items
        WHERE id = $1 AND group_id = $2 AND status IN ('next_up', 'in_design')
        FOR UPDATE`,
      [itemId, groupId],
    );
    if (!existingRows[0]) throw new HttpError(404, "design item not found or not editable");
    const existing = existingRows[0];
    const previousAssignee = existing.assigned_to;

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

    // Backlog is unowned next_up; person / Parking Lot are in_design.
    if (body.status === "next_up" && body.assigned_to === undefined) {
      body.assigned_to = null;
    }
    if (body.assigned_to) {
      body.status = body.status ?? "in_design";
      if (body.status === "next_up") {
        throw new HttpError(400, "Backlog items cannot have an assignee");
      }
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    const nextValues: Partial<Record<AuditedField, unknown>> = {};

    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "name" && typeof v === "string") {
        const trimmed = v.trim();
        if (!trimmed) throw new HttpError(400, "name is required");
        values.push(trimmed);
        fields.push(`name = $${values.length}`);
        nextValues.name = trimmed;
        continue;
      }
      if (k === "description" && typeof v === "string") {
        const trimmed = v.trim();
        values.push(trimmed);
        fields.push(`description = $${values.length}`);
        nextValues.description = trimmed;
        continue;
      }
      if (k === "jira_key") {
        const trimmed = typeof v === "string" ? v.trim() : "";
        const normalized = trimmed || null;
        values.push(normalized);
        fields.push(`jira_key = $${values.length}`);
        nextValues.jira_key = normalized;
        continue;
      }
      if (k === "due_date") {
        const normalized =
          typeof v === "string" ? (v.trim() || null) : v === null ? null : null;
        values.push(normalized);
        fields.push(`due_date = $${values.length}`);
        nextValues.due_date = normalized;
        continue;
      }
      if (k === "is_blocked") {
        const next = Boolean(v);
        values.push(next);
        fields.push(`is_blocked = $${values.length}`);
        nextValues.is_blocked = next;
        // Clearing the flag also clears the reason (same as product items).
        if (!next && body.blocked_reason === undefined) {
          values.push(null);
          fields.push(`blocked_reason = $${values.length}`);
          nextValues.blocked_reason = null;
        }
        continue;
      }
      if (k === "blocked_reason") {
        const normalized =
          typeof v === "string" ? (v.trim() || null) : v === null ? null : null;
        values.push(normalized);
        fields.push(`blocked_reason = $${values.length}`);
        nextValues.blocked_reason = normalized;
        continue;
      }
      if (k === "links") {
        const normalized = normalizeLinks(v);
        values.push(JSON.stringify(normalized));
        fields.push(`links = $${values.length}::jsonb`);
        nextValues.links = normalized;
        continue;
      }
      values.push(v);
      fields.push(`${k} = $${values.length}`);
      if ((AUDITED_FIELDS as readonly string[]).includes(k)) {
        nextValues[k as AuditedField] = v;
      }
    }

    if (!fields.length) {
      return { row: existing, previousAssignee, changed: false as const };
    }

    values.push(itemId, groupId);
    const { rows } = await client.query<DesignItemRow>(
      `UPDATE design_items
          SET ${fields.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length - 1}
          AND group_id = $${values.length}
          AND status IN ('next_up', 'in_design')
        RETURNING *`,
      values,
    );
    if (!rows[0]) throw new HttpError(404, "design item not found or not editable");

    const before = auditedSnapshot(existing);
    for (const field of AUDITED_FIELDS) {
      if (!(field in nextValues)) continue;
      const from = before[field];
      const to = nextValues[field];
      if (valuesEqual(from, to)) continue;
      await recordDesignAudit(client, {
        designItemId: itemId,
        userId: req.user!.id,
        action: "edit",
        field,
        from,
        to,
      });
    }

    return { row: rows[0], previousAssignee, changed: true as const };
  });

  const dto = await fetchDto(updated.row.id);
  const newAssignee = updated.row.assigned_to;
  if (
    body.assigned_to !== undefined &&
    newAssignee &&
    newAssignee !== updated.previousAssignee &&
    newAssignee !== req.user!.id
  ) {
    fireDesignAssignmentEmail({
      designItemId: updated.row.id,
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
 * Fixed columns:
 *   - Parking Lot: assigned_to null + status in_design
 *   - Backlog:     assigned_to null + status next_up
 * Person columns use assigned_to = user id + status in_design.
 * Assignee is preserved when completing.
 */
const boardLayoutSchema = z.object({
  columns: z.array(
    z.object({
      assigned_to: z.string().uuid().nullable(),
      status: z.enum(["next_up", "in_design"]).default("in_design"),
      item_ids: z.array(z.string().uuid()),
    }),
  ),
  completed_ids: z.array(z.string().uuid()).default([]),
});

designItemsRouter.post("/board-layout", requireWrite, async (req, res) => {
  const body = boardLayoutSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query<DesignItemRow>(
      `SELECT * FROM design_items
        WHERE group_id = $1 AND status IN ('next_up', 'in_design', 'completed')
        FOR UPDATE`,
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

    // Active Parking Lot / Backlog / person columns
    for (const col of body.columns) {
      // Person columns are always in_design; Backlog is next_up + null.
      const nextStatus =
        col.assigned_to != null
          ? "in_design"
          : col.status === "next_up"
            ? "next_up"
            : "in_design";
      for (let i = 0; i < col.item_ids.length; i++) {
        const id = col.item_ids[i]!;
        const prev = byId.get(id)!;
        const nextAssignee = col.assigned_to;
        const wasCompleted = prev.status === "completed";
        await client.query(
          `UPDATE design_items
              SET status = $1,
                  assigned_to = $2,
                  position = $3,
                  completed_at = NULL,
                  ticket_status = CASE
                    WHEN $4::text = 'completed' AND ticket_status = 'done' THEN 'on'
                    ELSE ticket_status
                  END,
                  updated_at = NOW()
            WHERE id = $5 AND group_id = $6`,
          [nextStatus, nextAssignee, i, prev.status, id, groupId],
        );

        if (wasCompleted) {
          await recordDesignAudit(client, {
            designItemId: id,
            userId: req.user!.id,
            action: "restore",
          });
          if (prev.ticket_status === "done") {
            await recordDesignAudit(client, {
              designItemId: id,
              userId: req.user!.id,
              action: "edit",
              field: "ticket_status",
              from: "done",
              to: "on",
            });
          }
        }
        if (!valuesEqual(prev.assigned_to, nextAssignee)) {
          await recordDesignAudit(client, {
            designItemId: id,
            userId: req.user!.id,
            action: "edit",
            field: "assigned_to",
            from: prev.assigned_to,
            to: nextAssignee,
          });
        }

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
      const prev = byId.get(id)!;
      const alreadyCompleted = prev.status === "completed";
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
      if (!alreadyCompleted) {
        await recordDesignAudit(client, {
          designItemId: id,
          userId: req.user!.id,
          action: "complete",
        });
        if (prev.ticket_status !== "done") {
          await recordDesignAudit(client, {
            designItemId: id,
            userId: req.user!.id,
            action: "edit",
            field: "ticket_status",
            from: prev.ticket_status,
            to: "done",
          });
        }
      }
    }
  });

  const { rows } = await query<DesignItemDto>(LIST_SQL, [groupId]);
  res.json(rows.map(mapDto));
});

designItemsRouter.post("/:id/complete", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const updated = await withTransaction(async (client) => {
    const { rows } = await client.query<DesignItemRow>(
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
    if (!rows[0]) {
      throw new HttpError(404, "design item not found or not active");
    }
    await recordDesignAudit(client, {
      designItemId: rows[0].id,
      userId: req.user!.id,
      action: "complete",
    });
    return rows[0];
  });

  const dto = await fetchDto(updated.id);
  res.json(dto);
});

designItemsRouter.delete("/:id", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const deletedId = await withTransaction(async (client) => {
    const { rows } = await client.query<DesignItemRow>(
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
    if (!rows[0]) {
      throw new HttpError(404, "design item not found or already archived");
    }
    await recordDesignAudit(client, {
      designItemId: rows[0].id,
      userId: req.user!.id,
      action: "delete",
    });
    return rows[0].id;
  });
  res.json({ deleted: deletedId });
});

/**
 * GET /design-items/:id/history — chronological audit trail for one ticket.
 */
designItemsRouter.get("/:id/history", async (req, res) => {
  const groupId = req.groupId!;
  const itemId = String(req.params.id);
  const { rows: ownership } = await query<{ id: string }>(
    `SELECT id FROM design_items WHERE id = $1 AND group_id = $2`,
    [itemId, groupId],
  );
  if (!ownership[0]) throw new HttpError(404, "design item not found");

  const { rows } = await query<{
    id: string;
    design_item_id: string;
    user_id: string | null;
    timestamp: Date;
    kind: string;
    field: string | null;
    from_value: unknown;
    to_value: unknown;
  }>(
    `SELECT id, design_item_id, user_id, "timestamp",
            action AS kind,
            field, from_value, to_value
       FROM design_item_audit_events
      WHERE design_item_id = $1
      ORDER BY "timestamp" ASC`,
    [itemId],
  );
  res.json(rows);
});
