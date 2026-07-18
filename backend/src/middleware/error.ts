import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(req: Request, res: Response) {
  // Include method + path so a mistyped or un-restarted route is
  // self-diagnosing: the frontend banner surfaces this verbatim, and
  // a bare "not found" on the wire is indistinguishable from an
  // in-handler HttpError(404) with the same message.
  res.status(404).json({ error: `route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_failed", details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal_error" });
}
