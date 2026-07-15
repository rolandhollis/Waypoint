import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";

/**
 * CRUD for the Friday-afternoon status-report digest recipient
 * list. Every request is already scoped to the caller's current
 * group by the groupScope middleware mounted upstream, so all
 * queries here read/write req.groupId without ever trusting a
 * client-supplied group id.
 *
 * Two shapes of recipient exist in the same table:
 *   * user-linked (user_id != null) — the digest resolves to the
 *     user's current email at send-time, so name changes stay
 *     in sync without admin action.
 *   * ad-hoc (user_id == null) — the email is the source of truth
 *     and never changes on its own; used for execs / contractors
 *     / anyone without a Waypoint account.
 */

export const digestRecipientsRouter = Router();

type RecipientRow = {
  id: string;
  group_id: string;
  user_id: string | null;
  email: string;
  created_at: string;
  created_by: string | null;
  user_name: string | null;
  user_email: string | null;
};

type RecipientOut = {
  id: string;
  email: string;
  user: { id: string; name: string; email: string } | null;
  created_at: string;
};

function shape(row: RecipientRow): RecipientOut {
  return {
    id: row.id,
    // For user-linked recipients, always show the user's CURRENT
    // email in the admin list — matches what the send will actually
    // do at runtime.
    email: row.user_id && row.user_email ? row.user_email : row.email,
    user:
      row.user_id && row.user_name && row.user_email
        ? { id: row.user_id, name: row.user_name, email: row.user_email }
        : null,
    created_at: row.created_at,
  };
}

digestRecipientsRouter.get("/", requireAdmin, async (req, res) => {
  const { rows } = await query<RecipientRow>(
    `SELECT r.id, r.group_id, r.user_id, r.email, r.created_at, r.created_by,
            u.name AS user_name, u.email AS user_email
       FROM status_digest_recipients r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.group_id = $1
      ORDER BY LOWER(COALESCE(u.email, r.email))`,
    [req.groupId!],
  );
  res.json(rows.map(shape));
});

// Two forms of "add": user picker or ad-hoc email. Kept as
// separate endpoints instead of a discriminated union so the
// admin UI (and any future SDK caller) picks the right shape
// explicitly instead of relying on presence/absence of a field.

const addUserSchema = z.object({
  user_id: z.string().uuid(),
});

digestRecipientsRouter.post("/user", requireAdmin, async (req, res) => {
  const body = addUserSchema.parse(req.body ?? {});
  // Confirm the picked user is a member of this group — otherwise
  // an admin could quietly add someone from another tenant to
  // their digest, which would leak update summaries across
  // tenants. We already know the caller's group_id is safe (set
  // by groupScope middleware).
  const { rows: memberCheck } = await query<{ email: string; name: string }>(
    `SELECT u.email, u.name
       FROM user_groups ug
       JOIN users u ON u.id = ug.user_id
      WHERE ug.user_id = $1 AND ug.group_id = $2`,
    [body.user_id, req.groupId!],
  );
  if (!memberCheck[0]) {
    res.status(400).json({ error: "user is not a member of this group" });
    return;
  }
  const { email } = memberCheck[0];
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO status_digest_recipients (group_id, user_id, email, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.groupId!, body.user_id, email, req.user?.id ?? null],
    );
    res.status(201).json({ id: rows[0]!.id });
  } catch (e) {
    // Case-insensitive unique index catches (group, email) dups.
    if ((e as { code?: string }).code === "23505") {
      res.status(409).json({ error: "recipient already on the list" });
      return;
    }
    throw e;
  }
});

const addEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("must be a valid email address")
    .max(254),
});

digestRecipientsRouter.post("/email", requireAdmin, async (req, res) => {
  const body = addEmailSchema.parse(req.body ?? {});
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO status_digest_recipients (group_id, user_id, email, created_by)
       VALUES ($1, NULL, $2, $3) RETURNING id`,
      [req.groupId!, body.email, req.user?.id ?? null],
    );
    res.status(201).json({ id: rows[0]!.id });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      res.status(409).json({ error: "recipient already on the list" });
      return;
    }
    throw e;
  }
});

digestRecipientsRouter.delete("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id!;
  const { rowCount } = await query(
    `DELETE FROM status_digest_recipients WHERE id = $1 AND group_id = $2`,
    [id, req.groupId!],
  );
  if (!rowCount) {
    res.status(404).json({ error: "recipient not found" });
    return;
  }
  res.status(204).send();
});
