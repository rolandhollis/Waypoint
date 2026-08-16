import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { findSessionUser, readSessionCookie, touchSession } from "../auth/session.js";
import type { UserRow } from "../types.js";

/**
 * Best-effort identity for public analytics endpoints.
 * Never 401s — attaches req.user when credentials are present and valid.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    if (config.authMode === "mock") {
      const id = req.header("x-mock-user-id");
      if (id) {
        const { rows } = await query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
        if (rows[0]) req.user = rows[0];
      }
      next();
      return;
    }

    if (config.authMode === "password") {
      const sessionId = readSessionCookie(req);
      if (sessionId) {
        const found = await findSessionUser(sessionId);
        if (found) {
          touchSession(sessionId, found.session.remember_me).catch(() => undefined);
          req.user = found.user;
          req.sessionId = sessionId;
        }
      }
      next();
      return;
    }

    // okta / cloudflare-access: skip enrichment on public analytics posts
    // (browser doesn't send those tokens on our beacon path).
    next();
  } catch {
    next();
  }
}
