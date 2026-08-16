import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import {
  parseExperimentContextHeader,
  runWithExperimentContext,
} from "../lib/experimentContext.js";

/**
 * When enabled, reads X-ZiffSplit-Context from the client and scopes it
 * for the request so recordAudit can stamp experiment_context.
 */
export function experimentContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (!config.experimentAuditContext) {
    next();
    return;
  }
  const ctx = parseExperimentContextHeader(req.header("x-ziffsplit-context") ?? undefined);
  runWithExperimentContext(ctx, next);
}
