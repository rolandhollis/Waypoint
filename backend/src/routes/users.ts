import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { groupScope, requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import {
  formatPasswordErrors,
  generatePassword,
  hashPassword,
  validatePassword,
} from "../auth/password.js";
import { deleteSessionsForUser } from "../auth/session.js";
import type { Role, UserRow } from "../types.js";
import { scrubUser, scrubUsers } from "../types.js";

export const usersRouter = Router();

// -----------------------------------------------------------------
// Self endpoints
// -----------------------------------------------------------------

/**
 * Return the caller's identity augmented with everything the
 * frontend needs to bootstrap the multi-tenant shell in one round
 * trip: their group memberships (with per-group role) and their
 * currently-active group id. Kept as a single endpoint (rather
 * than several) so the shell doesn't have to sequence three
 * requests before rendering.
 */
usersRouter.get("/me", async (req, res) => {
  const user = req.user!;
  const { rows: memberships } = await query<{
    group_id: string;
    role: "admin" | "owner" | "viewer";
    name: string;
    color: string | null;
  }>(
    // Super-users see every group in the switcher even without an
    // explicit user_groups row; the LEFT JOIN handles both cases
    // (super or regular). Regular users only see rows in user_groups.
    user.is_super_user
      ? `SELECT g.id AS group_id, COALESCE(ug.role, 'admin') AS role, g.name, g.color
           FROM groups g
           LEFT JOIN user_groups ug ON ug.group_id = g.id AND ug.user_id = $1
          ORDER BY g.name ASC`
      : `SELECT g.id AS group_id, ug.role, g.name, g.color
           FROM user_groups ug
           JOIN groups g ON g.id = ug.group_id
          WHERE ug.user_id = $1
          ORDER BY g.name ASC`,
    [user.id],
  );

  // If the persisted current_group_id points at a group the user is
  // no longer part of (revoked mid-session, group deleted), drop to
  // the first membership so the UI always lands somewhere valid.
  let currentGroupId = user.current_group_id;
  const validIds = memberships.map((m) => m.group_id);
  if (!currentGroupId || !validIds.includes(currentGroupId)) {
    currentGroupId = validIds[0] ?? null;
    if (currentGroupId && currentGroupId !== user.current_group_id) {
      await query(
        `UPDATE users SET current_group_id = $1, updated_at = NOW() WHERE id = $2`,
        [currentGroupId, user.id],
      );
    }
  }

  res.json({
    ...scrubUser(user),
    current_group_id: currentGroupId,
    memberships,
  });
});

const setCurrentGroupSchema = z.object({
  group_id: z.string().uuid(),
});

/**
 * Switch which tenant workspace the caller is currently "in".
 * Verifies membership (or super-user status) before writing so a
 * user can't hop into a group they don't belong to.
 */
usersRouter.patch("/me/current-group", async (req, res) => {
  const { group_id } = setCurrentGroupSchema.parse(req.body);
  const user = req.user!;

  if (!user.is_super_user) {
    const { rows: check } = await query<{ role: string }>(
      `SELECT role FROM user_groups WHERE user_id = $1 AND group_id = $2`,
      [user.id, group_id],
    );
    if (!check[0]) throw new HttpError(403, "you are not a member of that group");
  } else {
    const { rows: check } = await query<{ id: string }>(
      `SELECT id FROM groups WHERE id = $1`,
      [group_id],
    );
    if (!check[0]) throw new HttpError(404, "group not found");
  }

  const { rows } = await query<UserRow>(
    `UPDATE users SET current_group_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [group_id, user.id],
  );
  res.json({ ...scrubUser(rows[0]!), current_group_id: group_id });
});

usersRouter.patch("/me/prefs", async (req, res) => {
  const body = z.record(z.unknown()).parse(req.body);
  const merged = { ...(req.user!.prefs ?? {}), ...body };
  const { rows } = await query<UserRow>(
    `UPDATE users SET prefs = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(merged), req.user!.id],
  );
  res.json(scrubUser(rows[0]!));
});

// -----------------------------------------------------------------
// Admin roster — scoped to the caller's current group. Super-users
// are treated as implicit members of every group (mirrors
// middleware/auth.groupScope), so they always show up in every
// tenant's roster and can be assigned as owners regardless of
// which group is active.
// -----------------------------------------------------------------

usersRouter.get("/", groupScope, requireAdmin, async (req, res) => {
  const { rows } = await query<UserRow>(
    `SELECT u.*
       FROM users u
      WHERE u.is_super_user = TRUE
         OR EXISTS (
              SELECT 1 FROM user_groups ug
               WHERE ug.user_id = u.id AND ug.group_id = $1
            )
      ORDER BY u.name ASC`,
    [req.groupId!],
  );
  res.json(scrubUsers(rows));
});

/**
 * Guardrail used by every user-mutation endpoint under this router
 * so an admin in group A can never poke at a user who only lives
 * in group B. Super-users are treated as implicit members of every
 * group (matches the roster query above and groupScope semantics).
 * 404 (not 403) so we don't leak whether the target id exists.
 */
async function assertUserInCurrentGroup(userId: string, groupId: string): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    `SELECT u.*
       FROM users u
      WHERE u.id = $1
        AND (u.is_super_user = TRUE
             OR EXISTS (
                  SELECT 1 FROM user_groups ug
                   WHERE ug.user_id = u.id AND ug.group_id = $2
                ))`,
    [userId, groupId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "user not found");
  return row;
}

/** Convenience middleware: run assertUserInCurrentGroup and stash
 *  the loaded row on the request for the handler to reuse. */
async function assertTargetInGroup(req: Request, _res: Response, next: NextFunction) {
  const target = await assertUserInCurrentGroup(String(req.params.id), req.groupId!);
  (req as Request & { targetUser?: UserRow }).targetUser = target;
  next();
}

// -----------------------------------------------------------------
// Orphaned-user rescue.
//
// Users can end up with zero user_groups rows through a few paths
// (imported from a pre-multi-tenant seed, created before the
// membership grant landed, or explicitly removed from every group
// they were once in). The group-scoped roster hides them, but the
// unique email constraint still blocks re-creation — so an admin
// trying to invite someone gets "email already exists" with no way
// to fix it. This endpoint surfaces those orphans so any admin can
// adopt them into their current group.
//
// Deliberately NOT scoped to any group (there IS no group to scope
// to — that's the whole point). Super-users are excluded from the
// list because they're implicit members of every group and would
// never actually be inaccessible.
// -----------------------------------------------------------------

usersRouter.get("/unassigned", requireAdmin, async (_req, res) => {
  const { rows } = await query<UserRow>(
    `SELECT u.*
       FROM users u
      WHERE u.is_super_user = FALSE
        AND NOT EXISTS (SELECT 1 FROM user_groups WHERE user_id = u.id)
      ORDER BY u.name ASC`,
  );
  res.json(scrubUsers(rows));
});

// List the groups a user belongs to. Powers the "Groups" section
// of the user-detail modal on the admin tab.
//
// Deliberately just requires admin (any tenant) rather than
// scoping to the caller's current group: the response is
// metadata-only (group names + roles), and if we scoped it the
// modal would 404 on itself the moment an admin removes the
// target from the group they're viewing from. Super-users are
// treated as implicit members of every group and appear with
// `implicit: true` so the UI can render them as disabled-but-
// checked without having to know the rule.
usersRouter.get("/:id/groups", requireAdmin, async (req, res) => {
  const userId = String(req.params.id);

  const { rows: existingRows } = await query<UserRow>(
    `SELECT * FROM users WHERE id = $1`,
    [userId],
  );
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "user not found");

  if (existing.is_super_user) {
    // Super-users are implicit members of every group — enumerate
    // all groups and flag them accordingly.
    const { rows } = await query<{ group_id: string; group_name: string; group_color: string | null }>(
      `SELECT id AS group_id, name AS group_name, color AS group_color
         FROM groups ORDER BY name ASC`,
    );
    res.json(rows.map((r) => ({ ...r, role: "admin" as const, implicit: true })));
    return;
  }

  const { rows } = await query<{ group_id: string; group_name: string; group_color: string | null; role: Role }>(
    `SELECT g.id AS group_id, g.name AS group_name, g.color AS group_color, ug.role
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = $1
      ORDER BY g.name ASC`,
    [userId],
  );
  res.json(rows.map((r) => ({ ...r, implicit: false })));
});

// Add a user to the caller's current group. Used by the
// "Unassigned users" list in the admin tab, but generic enough
// that a super-admin could also use it to adopt a user from
// another tenant into the current one. Idempotent: if the user is
// already a member, we just update their role (matches the
// ON CONFLICT semantics of the create-user membership grant).
const addToGroupSchema = z.object({
  role: z.enum(["admin", "owner", "viewer"]).optional().default("owner"),
});
usersRouter.post("/:id/groups", groupScope, requireAdmin, async (req, res) => {
  const userId = String(req.params.id);
  const { role } = addToGroupSchema.parse(req.body);

  const { rows: existingRows } = await query<UserRow>(
    `SELECT * FROM users WHERE id = $1`,
    [userId],
  );
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "user not found");

  // Super-users are already implicit members of every group; adding
  // an explicit row would be a no-op and misleading in the UI.
  if (existing.is_super_user) {
    throw new HttpError(400, "super-users are implicit members of every group");
  }

  await query(
    `INSERT INTO user_groups (user_id, group_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, group_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, req.groupId!, role],
  );

  res.status(201).json({ user: scrubUser(existing), role });
});

// Mock-mode roster for the dev user switcher — no auth required so the
// frontend can populate the picker on first paint. Password-mode
// installs should NOT expose this (index.ts already gates the mount).
usersRouter.get("/mock-roster", async (_req, res) => {
  const { rows } = await query<UserRow>(`SELECT * FROM users ORDER BY role, name ASC`);
  res.json(scrubUsers(rows));
});

// -----------------------------------------------------------------
// Password preview — server-side generator so the client doesn't
// have to reinvent the crypto/policy dance
// -----------------------------------------------------------------

usersRouter.post("/password/generate", requireAdmin, (_req, res) => {
  res.json({ password: generatePassword() });
});

// -----------------------------------------------------------------
// Create user (admin) — optionally with a password. In password
// mode without a password the account is created "locked" (can't
// log in until admin sets one).
// -----------------------------------------------------------------

const roleEnum = z.enum(["admin", "owner", "viewer"]);

const createUserSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(1).max(120),
    role: roleEnum,
    color: z.string().max(32).optional(),
    capacity: z.number().int().min(1).max(1000).nullable().optional(),
    password: z.string().min(1).max(256).optional(),
    generate_password: z.boolean().optional(),
  })
  .refine((v) => !(v.password && v.generate_password), {
    message: "provide either `password` or `generate_password`, not both",
  });

usersRouter.post("/", groupScope, requireAdmin, async (req, res) => {
  const body = createUserSchema.parse(req.body);

  // Resolve the password up-front so we can validate before the
  // INSERT — the response echoes the plaintext exactly once when
  // requested by generate_password OR when the admin typed one; the
  // UI relies on this to show the RevealPasswordCard.
  let plaintext: string | null = null;
  let echo = false;
  if (body.generate_password) {
    plaintext = generatePassword();
    echo = true;
  } else if (body.password) {
    plaintext = body.password;
    echo = true;
  }

  if (plaintext) {
    const errs = validatePassword(plaintext, body.email);
    if (errs.length) {
      throw new HttpError(400, `password ${formatPasswordErrors(errs).join("; ")}`);
    }
  }

  const password_hash = plaintext ? await hashPassword(plaintext) : null;
  const capacity = body.capacity === undefined ? 3 : body.capacity;
  const color = body.color ?? "#64748B";

  let created: UserRow;
  try {
    // Wrap the insert + membership grant in a transaction so a
    // half-created user can never exist. The user is added to the
    // caller's current group with the same role they were assigned
    // — otherwise the row-level filter on GET /users would hide the
    // new account from the very admin who just created it, which
    // is a confusing UX regression.
    created = await withTransaction(async (client) => {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, name, role, color, capacity, password_hash, password_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
         RETURNING *`,
        [body.email, body.name, body.role, color, capacity, password_hash],
      );
      const user = rows[0]!;
      await client.query(
        `INSERT INTO user_groups (user_id, group_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, group_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.id, req.groupId!, body.role],
      );
      return user;
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      // Explain the two ways this can happen so the admin knows
      // whether to look in another group or in the Unassigned
      // list on this tab.
      const { rows: existingRows } = await query<{
        has_group_here: boolean;
        group_count: number;
      }>(
        `SELECT
           EXISTS(SELECT 1 FROM user_groups ug
                   WHERE ug.user_id = u.id AND ug.group_id = $2) AS has_group_here,
           (SELECT count(*)::int FROM user_groups ug2 WHERE ug2.user_id = u.id) AS group_count
         FROM users u WHERE lower(u.email) = lower($1)`,
        [body.email, req.groupId!],
      );
      const existing = existingRows[0];
      const detail = !existing
        ? "a user with that email already exists"
        : existing.has_group_here
        ? "a user with that email already exists in this group"
        : existing.group_count === 0
        ? "a user with that email already exists but isn't in any group — see the Unassigned users list below to add them here"
        : "a user with that email already exists in another group";
      throw new HttpError(409, detail);
    }
    throw err;
  }

  res.status(201).json({
    user: scrubUser(created),
    // Present only on the create-response so the admin gets one
    // last chance to copy the plaintext before it disappears
    // forever. Absent otherwise.
    ...(echo && plaintext ? { generated_password: plaintext } : {}),
  });
});

// -----------------------------------------------------------------
// Update user (admin)
// -----------------------------------------------------------------

const patchUserSchema = z.object({
  role: roleEnum.optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
});

usersRouter.patch("/:id", groupScope, requireAdmin, assertTargetInGroup, async (req, res) => {
  const body = patchUserSchema.parse(req.body);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  if (!sets.length) {
    // No changes requested — return the pre-loaded row untouched.
    res.json(scrubUser((req as Request & { targetUser: UserRow }).targetUser));
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "user not found");
  res.json(scrubUser(rows[0]));
});

// Back-compat wrapper: /users/:id/role → /users/:id { role }.
usersRouter.patch("/:id/role", groupScope, requireAdmin, assertTargetInGroup, async (req, res) => {
  const body = z.object({ role: roleEnum }).parse(req.body);
  const { rows } = await query<UserRow>(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [body.role, req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "user not found");
  res.json(scrubUser(rows[0]));
});

// -----------------------------------------------------------------
// Delete user (admin)
//
// Hard-deletes the row. FKs are set up so this is safe:
//   * projects.owner_id / created_by, comments, deadlines,
//     dependencies, audit events, weekly status, swim lanes, teams
//     — all SET NULL on delete, so historical data is preserved
//     but loses attribution.
//   * user_sessions and user_groups — CASCADE, so the user is
//     immediately signed out everywhere and their group
//     memberships vanish.
//   * kpis.created_by is NO ACTION, so we scrub it manually in
//     the same transaction to keep the delete atomic.
//
// Guardrails: admins may not delete themselves (footgun; leaves a
// dead session mid-request) and may not delete the bootstrapped
// super-admin (would just reappear on next boot from env vars,
// and losing it mid-session locks the tenant admin out).
// -----------------------------------------------------------------

usersRouter.delete("/:id", groupScope, requireAdmin, assertTargetInGroup, async (req, res) => {
  const userId = req.params.id!;

  if (req.user!.id === userId) {
    throw new HttpError(400, "you can't delete your own account");
  }

  const existing = (req as Request & { targetUser: UserRow }).targetUser;
  if (existing.is_super_user) {
    throw new HttpError(400, "the super-admin can't be deleted");
  }

  await withTransaction(async (client) => {
    // Scrub the one FK that doesn't have ON DELETE SET NULL so
    // the DELETE below doesn't fail on a stray reference.
    await client.query(
      `UPDATE kpis SET created_by = NULL WHERE created_by = $1`,
      [userId],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  res.status(204).end();
});

// -----------------------------------------------------------------
// Reset password (admin) — accepts a typed password or asks the
// server to generate one. In either case the plaintext is echoed
// exactly once. Invalidates every active session for the user so
// they get bounced back to the login screen everywhere.
// -----------------------------------------------------------------

const resetPasswordSchema = z
  .object({
    password: z.string().min(1).max(256).optional(),
    generate_password: z.boolean().optional(),
  })
  .refine((v) => !!v.password !== !!v.generate_password, {
    message: "provide exactly one of `password` or `generate_password`",
  });

usersRouter.post("/:id/password", groupScope, requireAdmin, assertTargetInGroup, async (req, res) => {
  if (config.authMode !== "password") {
    throw new HttpError(400, "auth mode does not use passwords");
  }
  const body = resetPasswordSchema.parse(req.body);
  const userId = req.params.id!;

  const existing = (req as Request & { targetUser: UserRow }).targetUser;

  const plaintext = body.generate_password ? generatePassword() : body.password!;
  const errs = validatePassword(plaintext, existing.email);
  if (errs.length) {
    throw new HttpError(400, `password ${formatPasswordErrors(errs).join("; ")}`);
  }

  const password_hash = await hashPassword(plaintext);
  const { rows } = await query<UserRow>(
    `UPDATE users
        SET password_hash = $1,
            password_updated_at = NOW(),
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [password_hash, userId],
  );

  await deleteSessionsForUser(userId);

  res.json({
    user: scrubUser(rows[0]!),
    generated_password: plaintext,
  });
});

// -----------------------------------------------------------------
// helpers
// -----------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "23505"
  );
}
