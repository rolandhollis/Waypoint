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
