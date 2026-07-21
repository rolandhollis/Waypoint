import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { config } from "../config.js";
import {
  generateHeadline,
  HeadlineParseError,
  HEADLINE_DESCRIPTION_MAX_CHARS,
  type HeadlineGroup,
} from "../ai/roadmapHeadline.js";

/**
 * `POST /api/ai/roadmap-headline` — Claude-powered executive
 * summary of the currently-visible roadmap.
 *
 * Mounted under `/api/ai` behind `authenticate + groupScope` (see
 * backend/src/index.ts). Available to any authenticated group
 * member — the endpoint reads no data, it only forwards what the
 * caller already sees to Claude, so viewer-role users can generate
 * a headline over their own view without escalating privileges.
 *
 * Failure surface (mirrors the estimator's shape):
 *   * 503 — ANTHROPIC_API_KEY is unset. Operator remediation.
 *   * 429 — per-tenant rate limit tripped (20/min).
 *   * 502 — Anthropic call failed OR the response carried no text.
 *   * 400 — body failed zod validation.
 *
 * No DB writes. Caching is intentionally client-side only (per the
 * feature spec) so that switching filters back and forth doesn't
 * spend a fresh token every time.
 */

export const aiHeadlineRouter = Router();

/** Zod schema for one project's payload. Descriptions are
 *  truncated server-side to bound the token budget regardless of
 *  what the client sent. */
const projectSchema = z.object({
  title: z.string().min(1).max(400),
  description: z.string().max(50_000).optional().default(""),
  start: z.string().nullable().optional().default(null),
  end: z.string().nullable().optional().default(null),
  phase: z.string().max(200).optional().default(""),
  teamNames: z.array(z.string().max(200)).max(50).optional().default([]),
  ownerName: z.string().max(200).nullable().optional().default(null),
  kpiNames: z.array(z.string().max(200)).max(50).optional().default([]),
});

const groupSchema = z.object({
  label: z.string().min(1).max(400),
  projects: z.array(projectSchema).max(500),
});

const bodySchema = z.object({
  fingerprint: z.string().min(1).max(256),
  groupBy: z.enum(["none", "lane", "team", "owner", "kpi", "tag"]),
  timeframeLabel: z.string().min(1).max(120),
  groups: z.array(groupSchema).max(200),
});

/**
 * Per-tenant rate limiter. Fixed-window counter kept in process
 * memory — identical shape to the estimator limiter but at 1/3rd
 * the cap because headline prompts are ~10x larger and roadmap
 * summaries are far more expensive to compute.
 */
const HEADLINE_WINDOW_MS = 60_000;
const HEADLINE_MAX_PER_WINDOW = 20;
type HeadlineRateBucket = { count: number; resetAt: number };
const headlineRateBuckets = new Map<string, HeadlineRateBucket>();

function checkAndBumpRate(groupId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cur = headlineRateBuckets.get(groupId);
  if (!cur || cur.resetAt <= now) {
    headlineRateBuckets.set(groupId, { count: 1, resetAt: now + HEADLINE_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (cur.count >= HEADLINE_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: Math.max(0, cur.resetAt - now) };
  }
  cur.count++;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Look up the tenant's display name so the system prompt can
 * address the caller's workspace by name. Mirrors the private
 * `loadGroupName` helper in routes/projects.ts — kept inline
 * rather than shared because the fallback string is
 * feature-specific ("Retail team"'s "your" reads reasonably in a
 * PM-facing summary).
 */
async function loadGroupName(groupId: string): Promise<string> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM groups WHERE id = $1`,
    [groupId],
  );
  return rows[0]?.name ?? "your";
}

/**
 * Truncate every incoming description down to
 * HEADLINE_DESCRIPTION_MAX_CHARS BEFORE assembling the prompt.
 * The prompt builder does its own trim as a second belt-and-
 * suspenders pass, but doing it here keeps the total request
 * size predictable and prevents an oversized payload from
 * blowing the JSON parser's default 1MB limit before we even
 * hit Claude.
 */
function truncateGroupsForRequest(groups: HeadlineGroup[]): HeadlineGroup[] {
    return groups.map((g) => ({
    ...g,
    projects: g.projects.map((p) => ({
      ...p,
      description: (p.description ?? "").slice(0, HEADLINE_DESCRIPTION_MAX_CHARS),
    })),
  }));
}

aiHeadlineRouter.post("/roadmap-headline", async (req, res) => {
  if (!config.anthropic.apiKey) {
      res.status(503).json({
      error: "AI headline not configured — set ANTHROPIC_API_KEY in Fly secrets",
    });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid request body",
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return;
  }
  const body = parsed.data;

  const groupId = req.groupId!;
  const rate = checkAndBumpRate(groupId);
  if (!rate.allowed) {
    res.setHeader("Retry-After", Math.ceil(rate.retryAfterMs / 1000).toString());
    res.status(429).json({
      error: `AI headline rate limit reached for this workspace (${HEADLINE_MAX_PER_WINDOW}/min). Try again shortly.`,
    });
    return;
  }

  const tenantName = await loadGroupName(groupId);

  try {
    const result = await generateHeadline({
      tenantName,
      groupBy: body.groupBy,
      timeframeLabel: body.timeframeLabel,
      groups: truncateGroupsForRequest(body.groups),
    });
    res.json({
      fingerprint: body.fingerprint,
      headline: result.headline,
      model: result.model,
      generatedAt: new Date().toISOString(),
      });
  } catch (err) {
    const detail =
      err instanceof HeadlineParseError
        ? err.message
        : err instanceof Error
        ? err.message
        : "unknown error";
    console.error("[ai-headline] generation failed", err);
    res.status(502).json({ error: "headline generation failed", detail });
    }
});
