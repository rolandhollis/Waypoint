import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { findSessionUser, readSessionCookie, touchSession } from "../auth/session.js";
import type { Role, UserRow } from "../types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

// One JWKS cache per issuer; the jose lib inside handles per-key rotation.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(issuer: string, path: string) {
  const key = `${issuer}${path}`;
  let existing = jwksCache.get(key);
  if (!existing) {
    existing = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}${path}`));
    jwksCache.set(key, existing);
  }
  return existing;
}

async function loadUserById(id: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

async function loadUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  return rows[0] ?? null;
}

/**
 * Attach `req.user` based on the configured AUTH_MODE:
 *   - mock              → dev-only "x-mock-user-id" header.
 *   - okta              → bearer ID token verified against OKTA_ISSUER/AUDIENCE.
 *   - cloudflare-access → CF_Authorization cookie or Cf-Access-Jwt-Assertion header
 *                         verified against the team's JWKS (CF Access fronts the app
 *                         and does the OIDC dance with the upstream IdP).
 * Missing/invalid credentials → 401; unknown-but-authenticated email → 403.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    if (config.authMode === "mock") {
      const id = req.header("x-mock-user-id");
      if (!id) {
        res.status(401).json({ error: "missing x-mock-user-id header" });
        return;
      }
      const user = await loadUserById(id);
      if (!user) {
        res.status(401).json({ error: "unknown mock user" });
        return;
      }
      req.user = user;
      next();
      return;
    }

    if (config.authMode === "password") {
      // Session cookie is set at POST /auth/login and touched here on
      // every hit to slide the expiry forward — a user who's
      // actively working never gets bounced mid-session.
      const sessionId = readSessionCookie(req);
      if (!sessionId) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const user = await findSessionUser(sessionId);
      if (!user) {
        res.status(401).json({ error: "session expired" });
        return;
      }
      // Fire-and-forget touch so the request path stays fast. If the
      // update fails the next request retries; no user-visible effect.
      touchSession(sessionId).catch((err) => console.error("touchSession failed", err));
      req.user = user;
      next();
      return;
    }

    if (config.authMode === "okta") {
      if (!config.okta.issuer) throw new Error("OKTA_ISSUER not set");
      const authz = req.header("authorization") ?? "";
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
      if (!token) {
        res.status(401).json({ error: "missing bearer token" });
        return;
      }
      const { payload } = await jwtVerify(token, getJwks(config.okta.issuer, "/v1/keys"), {
        issuer: config.okta.issuer,
        audience: config.okta.audience,
      });
      const email = (payload.email as string | undefined) ?? "";
      if (!email) {
        res.status(401).json({ error: "token missing email claim" });
        return;
      }
      const user = await loadUserByEmail(email);
      if (!user) {
        res.status(403).json({ error: "user not provisioned" });
        return;
      }
      req.user = user;
      next();
      return;
    }

    if (config.authMode === "cloudflare-access") {
      const cf = config.cloudflareAccess;
      if (!cf.teamDomain) throw new Error("CF_ACCESS_TEAM_DOMAIN not set");
      if (!cf.audience) throw new Error("CF_ACCESS_AUD not set");

      // CF Access forwards the JWT via both a cookie and a header; either
      // is acceptable. The header wins if both are present.
      const headerToken = req.header("cf-access-jwt-assertion") ?? "";
      const cookieHeader = req.header("cookie") ?? "";
      const cookieMatch = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookieHeader);
      const token = headerToken || (cookieMatch ? cookieMatch[1] : "");
      if (!token) {
        res.status(401).json({ error: "missing CF Access JWT" });
        return;
      }

      const issuer = `https://${cf.teamDomain}`;
      const { payload } = await jwtVerify(
        token,
        getJwks(issuer, "/cdn-cgi/access/certs"),
        { issuer, audience: cf.audience },
      );
      const email = (payload.email as string | undefined) ?? "";
      if (!email) {
        res.status(401).json({ error: "CF Access token missing email claim" });
        return;
      }
      const user = await loadUserByEmail(email);
      if (!user) {
        res.status(403).json({ error: "user not provisioned" });
        return;
      }
      req.user = user;
      next();
      return;
    }

    res.status(500).json({ error: `unknown AUTH_MODE: ${String(config.authMode)}` });
  } catch (err) {
    console.error("auth error", err);
    res.status(401).json({ error: "authentication failed" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `requires role: ${roles.join(" or ")}` });
      return;
    }
    next();
  };
}

/** Anything that writes: block Viewers hard. */
export const requireWrite = requireRole("admin", "owner");
/** Admin-only endpoints (swim lane admin, product area admin, role management). */
export const requireAdmin = requireRole("admin");
