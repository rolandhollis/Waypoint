import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { UserRow } from "../types.js";

export const usersRouter = Router();

usersRouter.get("/me", (req, res) => {
  res.json(req.user);
});

usersRouter.patch("/me/prefs", async (req, res) => {
  const body = z.record(z.unknown()).parse(req.body);
  const merged = { ...(req.user!.prefs ?? {}), ...body };
  const { rows } = await query<UserRow>(
    `UPDATE users SET prefs = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(merged), req.user!.id],
  );
  res.json(rows[0]);
});

usersRouter.get("/", requireAdmin, async (_req, res) => {
  const { rows } = await query<UserRow>(`SELECT * FROM users ORDER BY name ASC`);
  res.json(rows);
});

// Mock-mode roster for the dev user switcher — no auth required so the
// frontend can populate the picker on first paint.
usersRouter.get("/mock-roster", async (_req, res) => {
  const { rows } = await query<UserRow>(`SELECT * FROM users ORDER BY role, name ASC`);
  res.json(rows);
});

usersRouter.patch("/:id/role", requireAdmin, async (req, res) => {
  const body = z.object({ role: z.enum(["admin", "owner", "viewer"]) }).parse(req.body);
  const { rows } = await query<UserRow>(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [body.role, req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "user not found");
  res.json(rows[0]);
});

/**
 * General-purpose admin edit for a user: currently role + capacity.
 * Kept separate from /me/prefs (which any user can call for their own
 * settings). Capacity of `null` means "no cap"; a positive integer is
 * the soft max-concurrent-projects for the client-side warning.
 */
const patchUserSchema = z.object({
  role: z.enum(["admin", "owner", "viewer"]).optional(),
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
    res.json(rows[0]);
    return;
  }
  values.push(req.params.id);
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "user not found");
  res.json(rows[0]);
});
