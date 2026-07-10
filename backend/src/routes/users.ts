import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import {
  formatPasswordErrors,
  generatePassword,
  hashPassword,
  validatePassword,
} from "../auth/password.js";
import { deleteSessionsForUser } from "../auth/session.js";
import type { UserRow } from "../types.js";
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
// Admin roster
// -----------------------------------------------------------------

usersRouter.get("/", requireAdmin, async (_req, res) => {
  const { rows } = await query<UserRow>(`SELECT * FROM users ORDER BY name ASC`);
  res.json(scrubUsers(rows));
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

usersRouter.post("/", requireAdmin, async (req, res) => {
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
    const { rows } = await query<UserRow>(
      `INSERT INTO users (email, name, role, color, capacity, password_hash, password_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
       RETURNING *`,
      [body.email, body.name, body.role, color, capacity, password_hash],
    );
    created = rows[0]!;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "a user with that email already exists");
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

usersRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = patchUserSchema.parse(req.body);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  if (!sets.length) {
    const { rows } = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, "user not found");
    res.json(scrubUser(rows[0]));
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
usersRouter.patch("/:id/role", requireAdmin, async (req, res) => {
  const body = z.object({ role: roleEnum }).parse(req.body);
  const { rows } = await query<UserRow>(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [body.role, req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "user not found");
  res.json(scrubUser(rows[0]));
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

usersRouter.post("/:id/password", requireAdmin, async (req, res) => {
  if (config.authMode !== "password") {
    throw new HttpError(400, "auth mode does not use passwords");
  }
  const body = resetPasswordSchema.parse(req.body);
  const userId = req.params.id!;

  const { rows: existingRows } = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "user not found");

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
