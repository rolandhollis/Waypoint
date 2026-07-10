import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * Same-origin enforcement for state-changing requests. In password
 * mode the browser will send our HttpOnly session cookie on any
 * request the browser deems allowable — including cross-origin form
 * POSTs from an attacker's page. Requiring the Origin/Referer header
 * to match a trusted origin is a low-cost, well-understood CSRF
 * defense that doesn't need per-form tokens.
 *
 * In mock/okta modes there's no cookie riding along, so no CSRF
 * surface — this middleware becomes a no-op.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (config.authMode !== "password") return next();
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.header("origin") ?? deriveOriginFromReferer(req.header("referer"));

  // No Origin/Referer at all → suspicious for a browser POST. Native
  // clients (curl, mobile) also omit it, but they don't carry our
  // HttpOnly cookie unless they set it explicitly, so this is a
  // strictly-defensive rejection.
  if (!origin) {
    res.status(403).json({ error: "missing Origin header on state-changing request" });
    return;
  }

  // Allowed if either:
  //   (a) same host as the incoming request (same-origin Docker
  //       deploy where SPA + API share host), or
  //   (b) matches the configured CORS origin (dev server on 5173).
  const acceptable = candidateOrigins(req);
  if (!acceptable.some((a) => sameOrigin(a, origin))) {
    res.status(403).json({ error: "cross-origin request refused" });
    return;
  }

  next();
}

function candidateOrigins(req: Request): string[] {
  const out: string[] = [];
  const host = req.header("host");
  if (host) {
    // Behind a TLS-terminating proxy (Fly) the request appears as
    // HTTP but the browser sees HTTPS. Accept both schemes for the
    // request host — it's still same-host, which is what matters.
    out.push(`https://${host}`);
    out.push(`http://${host}`);
  }
  if (config.corsOrigin) out.push(config.corsOrigin);
  return out;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return a === b;
  }
}

function deriveOriginFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}
