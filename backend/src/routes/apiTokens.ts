import { Router } from "express";
import { z } from "zod";
import {
  createApiToken,
  listApiTokensForUser,
  revokeApiToken,
} from "../auth/apiTokens.js";
import { query } from "../db/pool.js";
import { HttpError } from "../middleware/error.js";
import type { Role } from "../types.js";

/**
 * Self-serve personal API tokens.
 *
 *   GET    /api/api-tokens          — list my active tokens
 *   POST   /api/api-tokens          — mint (plaintext returned once)
 *   DELETE /api/api-tokens/:id      — revoke
 *
 * Mounted behind `authenticate` only (not groupScope) so a user can
 * mint a token for any tenant they belong to by passing `group_id`.
 * Defaults to their current navbar group when omitted.
 */
export const apiTokensRouter = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  group_id: z.string().uuid().optional(),
  /** ISO date or null. Omit for no expiry. */
  expires_at: z.string().datetime().nullable().optional(),
});

apiTokensRouter.get("/", async (req, res) => {
  const tokens = await listApiTokensForUser(req.user!.id);
  res.json(tokens);
});

apiTokensRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const groupId = body.group_id ?? req.user!.current_group_id;
  if (!groupId) {
    throw new HttpError(400, "group_id required (no active group selected)");
  }

  // Must be a member of the target tenant (or super-user).
  if (!req.user!.is_super_user) {
    const { rows } = await query<{ role: Role }>(
      `SELECT role FROM user_groups WHERE user_id = $1 AND group_id = $2`,
      [req.user!.id, groupId],
    );
    if (!rows[0]) {
      throw new HttpError(403, "you are not a member of that group");
    }
  }

  const { token, plaintext } = await createApiToken({
    userId: req.user!.id,
    groupId,
    name: body.name,
    expiresAt: body.expires_at ?? null,
  });

  res.status(201).json({
    ...token,
    // Shown once — never stored or returned again.
    token: plaintext,
  });
});

apiTokensRouter.delete("/:id", async (req, res) => {
  const ok = await revokeApiToken(req.user!.id, req.params.id!);
  if (!ok) throw new HttpError(404, "token not found");
  res.status(204).end();
});
