import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { optionalAuthenticate } from "../middleware/optionalAuth.js";

/**
 * Host-owned experiment analytics.
 * Public write endpoints (no login required). Join key is ziffsplit_id.
 */
export const analyticsRouter = Router();

analyticsRouter.use(optionalAuthenticate);

const exposureSchema = z.object({
  ziffsplitId: z.string().min(1).max(200),
  experimentKey: z.string().min(1).max(200),
  variantKey: z.string().min(1).max(200),
  containerKey: z.string().min(1).max(200).optional(),
  siteKey: z.string().min(1).max(200),
  configVersion: z.number().int().nonnegative(),
  deliveryMode: z.enum(["embedded", "api", "dom"]),
  contentSource: z.enum(["authored", "code"]),
  primaryKpi: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
});

const eventSchema = z.object({
  ziffsplitId: z.string().min(1).max(200),
  eventName: z.string().min(1).max(200),
  properties: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
});

analyticsRouter.post("/exposures", async (req, res) => {
  const body = exposureSchema.parse(req.body);
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  const userId = req.user?.id ?? null;

  await query(
    `INSERT INTO analytics_exposures (
       ziffsplit_id, user_id, experiment_key, variant_key, container_key,
       site_key, config_version, delivery_mode, content_source, primary_kpi, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (ziffsplit_id, experiment_key, config_version) DO NOTHING`,
    [
      body.ziffsplitId,
      userId,
      body.experimentKey,
      body.variantKey,
      body.containerKey ?? null,
      body.siteKey,
      body.configVersion,
      body.deliveryMode,
      body.contentSource,
      body.primaryKpi ?? null,
      occurredAt,
    ],
  );

  res.status(204).end();
});

analyticsRouter.post("/events", async (req, res) => {
  const body = eventSchema.parse(req.body);
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  const userId = req.user?.id ?? null;

  await query(
    `INSERT INTO analytics_events (
       ziffsplit_id, user_id, event_name, properties, occurred_at
     ) VALUES ($1,$2,$3,$4,$5)`,
    [
      body.ziffsplitId,
      userId,
      body.eventName,
      JSON.stringify(body.properties ?? {}),
      occurredAt,
    ],
  );

  res.status(204).end();
});
