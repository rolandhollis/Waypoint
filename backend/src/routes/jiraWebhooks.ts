import { createHmac, timingSafeEqual } from "crypto";
import { Router } from "express";
import { config } from "../config.js";
import { applyInboundJiraStatus } from "../lib/jiraSync.js";
import { HttpError } from "../middleware/error.js";

/**
 * Public Jira webhook ingress. Authenticated by shared secret
 * (query ?token= or X-Hub-Signature / X-Waypoint-Jira-Secret header).
 * CSRF-exempt — see middleware/csrf.ts.
 */
export const jiraWebhooksRouter = Router();

function secretOk(req: { header: (n: string) => string | undefined; query: Record<string, unknown> }): boolean {
  const expected = config.jira.webhookSecret;
  if (!expected) {
    // When no secret is configured, accept only if sync is enabled
    // (local sandbox convenience). Production should set a secret.
    return config.jira.syncEnabled;
  }
  const provided =
    (typeof req.query.token === "string" ? req.query.token : "") ||
    req.header("x-waypoint-jira-secret") ||
    "";
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

jiraWebhooksRouter.post("/", async (req, res) => {
  if (!secretOk(req)) throw new HttpError(401, "invalid webhook secret");

  const body = req.body as {
    webhookEvent?: string;
    issue?: {
      id?: string;
      key?: string;
      fields?: { status?: { name?: string } };
    };
  };

  const statusName = body.issue?.fields?.status?.name;
  const jiraKey = body.issue?.key ?? null;
  const jiraIssueId = body.issue?.id ?? null;

  if (!statusName || (!jiraKey && !jiraIssueId)) {
    res.json({ ok: true, ignored: true });
    return;
  }

  const result = await applyInboundJiraStatus({
    jiraKey,
    jiraIssueId,
    statusName,
  });

  res.json({ ok: true, updated: result.updated, project_id: result.projectId ?? null });
});

/** Optional HMAC helper for docs — not required by the default secret check. */
export function signJiraWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
