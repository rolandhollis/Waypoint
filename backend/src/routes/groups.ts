import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireSuperUser } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { AppConstants, GroupRow, Role } from "../types.js";

/**
 * Groups (tenants) CRUD + membership management.
 *
 * Read endpoints (GET /, GET /:id/members) are open to any
 * authenticated user, filtered to what they can actually see:
 *   - regular users get only the groups they're members of
 *   - super-users get every group in the system
 *
 * Write endpoints (POST/PATCH/DELETE, membership grants) require
 * the SuperUser flag — deliberately global, not per-group, because
 * managing tenants is a platform-level concern.
 */
export const groupsRouter = Router();

const GROUP_COLOR_PALETTE = [
  "#DC2626", "#0EA5E9", "#10B981", "#F59E0B",
  "#8B5CF6", "#EC4899", "#14B8A6", "#F97316",
];

/**
 * Normalize whatever's in `groups.constants` (JSONB, freeform) into
 * the narrow `AppConstants` surface every consumer expects. We do
 * this on read so the frontend never has to reason about missing
 * keys, non-string values, or leftover keys from earlier schema
 * ideas.
 *
 * Rules:
 *   * Missing key → the field is omitted (undefined). Consumers
 *     treat undefined as "not set — fall back to built-in default".
 *   * Explicit null → preserved as null. Same practical effect as
 *     undefined for defaults, but distinguishes "admin cleared it"
 *     from "never set" if a future audit surface wants to show that.
 *   * Non-string value → dropped. The zod schema on the PATCH path
 *     stops these from being written today, but tolerating garbage
 *     on read means a pre-existing stray value can't break every
 *     group's `/constants` GET.
 */
function deriveConstants(raw: unknown): AppConstants {
  const bag = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const out: AppConstants = {};
  if ("app_name" in bag) {
    const v = bag.app_name;
    if (v === null) out.app_name = null;
    else if (typeof v === "string") out.app_name = v;
  }
  return out;
}

/** Wrap a raw `groups` row so `constants` is always the derived
 *  shape (never a raw JSONB blob) before we ship it over the wire. */
function scrubGroup<T extends { constants: unknown }>(row: T): Omit<T, "constants"> & { constants: AppConstants } {
  return { ...row, constants: deriveConstants(row.constants) };
}

/**
 * List groups the caller can see. SuperUsers see all groups;
 * regular users see just the ones they belong to.
 */
groupsRouter.get("/", async (req, res) => {
  const user = req.user!;
  const { rows } = await query<GroupRow>(
    user.is_super_user
      ? `SELECT * FROM groups ORDER BY name ASC`
      : `SELECT g.* FROM groups g
           JOIN user_groups ug ON ug.group_id = g.id
          WHERE ug.user_id = $1
          ORDER BY g.name ASC`,
    user.is_super_user ? [] : [user.id],
  );
  res.json(rows.map(scrubGroup));
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(32).optional(),
});

groupsRouter.post("/", requireSuperUser, async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const { rows: countRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM groups`,
    );
    const n = countRows[0]?.n ?? 0;
    const color = body.color ?? GROUP_COLOR_PALETTE[n % GROUP_COLOR_PALETTE.length]!;

    const { rows } = await client.query<GroupRow>(
      `INSERT INTO groups (name, color, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [body.name.trim(), color, req.user!.id],
    );
    const group = scrubGroup(rows[0]!);

    // Every super-user is auto-enrolled as admin in the new group
    // so nobody accidentally locks themselves out by creating an
    // empty tenant. Matches how bootstrap.ts back-fills super
    // memberships on startup.
    await client.query(
      `INSERT INTO user_groups (user_id, group_id, role)
         SELECT u.id, $1, 'admin' FROM users u WHERE u.is_super_user = TRUE
       ON CONFLICT (user_id, group_id) DO NOTHING`,
      [group.id],
    );

    // Seed the same default swim lanes we baked into migration 017
    // for VoucherCodes so a brand-new tenant is usable immediately.
    await client.query(
      `INSERT INTO swim_lanes
         (group_id, name, description, "order", color, is_terminal,
          requires_weekly_status, is_default_new, phase_date_key,
          is_admin_only, is_archive)
       VALUES
         ($1, 'Backlog',       'Ideas parked for later triage.',           0, '#94A3B8', FALSE, FALSE, TRUE,  NULL,                    FALSE, FALSE),
         ($1, 'Ready for Dev', 'Scoped, sized, and approved to build.',    1, '#3B82F6', FALSE, FALSE, FALSE, 'target_date',           FALSE, FALSE),
         ($1, 'In Dev',        'Actively being built.',                    2, '#F59E0B', FALSE, TRUE,  FALSE, 'dev_start_date',        FALSE, FALSE),
         ($1, 'Complete',      'Shipped and live.',                        3, '#10B981', TRUE,  FALSE, FALSE, 'optimization_end_date', FALSE, FALSE),
         ($1, 'Archive',       'Retired / cancelled — hidden from board.', 4, '#64748B', TRUE,  FALSE, FALSE, NULL,                    TRUE,  TRUE)`,
      [group.id],
    );

    // Seed the standard T-shirt size ladder used by the EZEstimates
    // view. Mirrors the seed baked into migration 028 for existing
    // groups so a brand-new tenant lands with S/M/L/XL/XXL ready to
    // go. Admin can relabel or re-size from Admin → T-Shirt Sizes.
    await client.query(
      `INSERT INTO tshirt_sizes (group_id, label, days, position)
       VALUES
         ($1, 'S',   3,  0),
         ($1, 'M',   7,  1),
         ($1, 'L',   14, 2),
         ($1, 'XL',  30, 3),
         ($1, 'XXL', 90, 4)`,
      [group.id],
    );

    return group;
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().max(32).nullable().optional(),
});

groupsRouter.patch("/:id", requireSuperUser, async (req, res) => {
  const body = patchSchema.parse(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    fields.push(`"${k}" = $${values.length}`);
  }
  if (!fields.length) {
    const { rows } = await query<GroupRow>(`SELECT * FROM groups WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "group not found");
    res.json(scrubGroup(rows[0]));
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<GroupRow>(
    `UPDATE groups SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "group not found");
  res.json(scrubGroup(rows[0]));
});

/**
 * Delete a group. Refuses if the group still holds any projects
 * (the ON DELETE CASCADE would silently wipe them, so we make the
 * super-user acknowledge the situation instead).
 */
groupsRouter.delete("/:id", requireSuperUser, async (req, res) => {
  const groupId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: projectRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM projects WHERE group_id = $1 AND deleted_at IS NULL`,
      [groupId],
    );
    const n = projectRows[0]?.n ?? 0;
    if (n > 0) {
      throw new HttpError(400, `cannot delete group: still holds ${n} active project${n === 1 ? "" : "s"}. Move or archive them first.`);
    }

    // Repoint any user whose current_group_id was pointing at this
    // group so they land somewhere valid after the delete. Falls
    // back to their first remaining membership; the /me endpoint
    // handles the (unlikely) case where they now have zero groups.
    await client.query(
      `UPDATE users u
          SET current_group_id = (
            SELECT ug.group_id FROM user_groups ug
              WHERE ug.user_id = u.id AND ug.group_id <> $1
              ORDER BY ug.created_at ASC LIMIT 1
          )
        WHERE u.current_group_id = $1`,
      [groupId],
    );

    const { rows } = await client.query<{ id: string }>(
      `DELETE FROM groups WHERE id = $1 RETURNING id`,
      [groupId],
    );
    if (!rows[0]) throw new HttpError(404, "group not found");
    return { deleted: rows[0].id };
  });
  res.json(result);
});

// -------------------------------------------------------------------
// Runtime constants (per-tenant)
// -------------------------------------------------------------------

/**
 * Look up the caller's role in a specific group. SuperUsers are
 * treated as implicit admins of every tenant — same rule the
 * `groupScope` middleware applies for the scoped routers. Returns
 * `null` for a non-member.
 *
 * Kept inline (not shared with `groupScope`) because the constants
 * endpoints operate on an id from the URL, not on the caller's
 * currently-selected group, so we can't reuse the middleware.
 */
async function roleInGroup(userId: string, groupId: string, isSuperUser: boolean): Promise<Role | null> {
  if (isSuperUser) return "admin";
  const { rows } = await query<{ role: Role }>(
    `SELECT role FROM user_groups WHERE user_id = $1 AND group_id = $2`,
    [userId, groupId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Read the derived constants for a group. Any member of the group
 * (or a super-user) can call this — the frontend uses it to hydrate
 * the "current app name" for the navbar even for viewers who can't
 * edit the value.
 *
 * 403 (not 404) for non-members so we don't leak group existence,
 * matching the members-list endpoint above.
 */
groupsRouter.get("/:id/constants", async (req, res) => {
  const groupId = String(req.params.id);
  const user = req.user!;
  const role = await roleInGroup(user.id, groupId, user.is_super_user);
  if (!role) throw new HttpError(403, "not a member of this group");

  const { rows } = await query<{ constants: unknown }>(
    `SELECT constants FROM groups WHERE id = $1`,
    [groupId],
  );
  if (!rows[0]) throw new HttpError(404, "group not found");
  res.json(deriveConstants(rows[0].constants));
});

/**
 * Patch one or more constants for a group. Admin-only for that
 * specific group (super-users implicitly admin everywhere).
 *
 * Body is a *partial* — only the keys the caller wants to change
 * need to be present. Semantics:
 *   * string → set the key to that string (validated by zod).
 *   * null   → clear the key back to the built-in default (drops
 *              the key from the JSONB blob so a later shape change
 *              doesn't inherit a stale explicit value).
 *   * absent → leave whatever was there alone.
 *
 * The merge is done in-app (read → merge → write) rather than in
 * SQL (`jsonb_set` per key) so the null-means-delete rule stays
 * a single line of code and the on-disk shape is always exactly
 * whatever we passed through `deriveConstants` — no accreted
 * unknown keys from earlier experiments.
 *
 * Returns the merged, derived constants — same shape as GET.
 */
const constantsPatchSchema = z.object({
  app_name: z.string().trim().min(1).max(60).nullable().optional(),
}).strict();

groupsRouter.patch("/:id/constants", async (req, res) => {
  const groupId = String(req.params.id);
  const user = req.user!;
  const role = await roleInGroup(user.id, groupId, user.is_super_user);
  if (!role) throw new HttpError(403, "not a member of this group");
  if (role !== "admin") throw new HttpError(403, "admin role required in this group");

  const body = constantsPatchSchema.parse(req.body);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<{ constants: unknown }>(
      `SELECT constants FROM groups WHERE id = $1 FOR UPDATE`,
      [groupId],
    );
    if (!existing[0]) throw new HttpError(404, "group not found");

    const current = deriveConstants(existing[0].constants);
    const next: AppConstants = { ...current };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (v === null) {
        delete next[k as keyof AppConstants];
      } else {
        (next as Record<string, string>)[k] = v;
      }
    }

    await client.query(
      `UPDATE groups SET constants = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(next), groupId],
    );
    return next;
  });

  res.json(result);
});

// -------------------------------------------------------------------
// Membership management
// -------------------------------------------------------------------

/**
 * List members of a group. Any group member (or super-user) can
 * see the roster; non-members get a 403 rather than a 404 so we
 * don't leak group existence.
 */
groupsRouter.get("/:id/members", async (req, res) => {
  const groupId = String(req.params.id);
  const user = req.user!;
  if (!user.is_super_user) {
    const { rows: check } = await query<{ role: Role }>(
      `SELECT role FROM user_groups WHERE user_id = $1 AND group_id = $2`,
      [user.id, groupId],
    );
    if (!check[0]) throw new HttpError(403, "not a member of this group");
  }
  const { rows } = await query<{ user_id: string; role: Role; name: string; email: string }>(
    `SELECT ug.user_id, ug.role, u.name, u.email
       FROM user_groups ug
       JOIN users u ON u.id = ug.user_id
      WHERE ug.group_id = $1
      ORDER BY u.name ASC`,
    [groupId],
  );
  res.json(rows);
});

const memberUpsertSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["admin", "owner", "viewer"]),
});

groupsRouter.post("/:id/members", requireSuperUser, async (req, res) => {
  const groupId = String(req.params.id);
  const body = memberUpsertSchema.parse(req.body);
  const { rows: groupCheck } = await query<{ id: string }>(
    `SELECT id FROM groups WHERE id = $1`,
    [groupId],
  );
  if (!groupCheck[0]) throw new HttpError(404, "group not found");
  const { rows } = await query(
    `INSERT INTO user_groups (user_id, group_id, role)
        VALUES ($1, $2, $3)
     ON CONFLICT (user_id, group_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING user_id, group_id, role`,
    [body.user_id, groupId, body.role],
  );
  res.status(201).json(rows[0]);
});

groupsRouter.delete("/:id/members/:userId", requireSuperUser, async (req, res) => {
  const groupId = String(req.params.id);
  const memberId = String(req.params.userId);

  const { rows: check } = await query<{ is_super_user: boolean }>(
    `SELECT is_super_user FROM users WHERE id = $1`,
    [memberId],
  );
  if (check[0]?.is_super_user) {
    // Bootstrap ensures the super-user is a member of every group;
    // letting the admin UI strip that would immediately be undone
    // on the next server restart. Refuse the delete so the state
    // shown in the UI matches what will persist.
    throw new HttpError(400, "cannot remove a super-user from a group");
  }

  const result = await withTransaction(async (client) => {
    const { rows: deleted } = await client.query<{ user_id: string }>(
      `DELETE FROM user_groups WHERE user_id = $1 AND group_id = $2 RETURNING user_id`,
      [memberId, groupId],
    );
    if (!deleted[0]) throw new HttpError(404, "membership not found");

    // If they were "in" this group, drop them onto their next-oldest
    // membership so their current_group_id stays valid. Null is OK
    // if they now have zero memberships; the /me endpoint handles it.
    await client.query(
      `UPDATE users u
          SET current_group_id = (
            SELECT ug.group_id FROM user_groups ug
              WHERE ug.user_id = u.id
              ORDER BY ug.created_at ASC LIMIT 1
          )
        WHERE u.id = $1 AND u.current_group_id = $2`,
      [memberId, groupId],
    );

    return { deleted: deleted[0].user_id };
  });
  res.json(result);
});
