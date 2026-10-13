import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { config } from "../config.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import {
  backfillJiraKeysFromLinks,
  drainJiraSyncOutbox,
  enqueueJiraSync,
  jiraSyncActive,
  reconcileJiraProjects,
} from "../lib/jiraSync.js";
import { getIssue, jiraBrowseUrl, jiraConfigured, parseJiraKeyFromText } from "../lib/jiraClient.js";

/**
 * Admin controls for Jira sync: status, force sync one project,
 * backfill keys from project_links, drain outbox / reconcile now.
 */
export const jiraSyncAdminRouter = Router();

// Status is readable by any workspace member so the detail panel can
// build browse URLs; mutating endpoints below stay admin-only.
jiraSyncAdminRouter.get("/status", async (_req, res) => {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM jira_sync_outbox WHERE processed_at IS NULL`,
  );
  res.json({
    enabled: config.jira.syncEnabled,
    configured: jiraConfigured(),
    active: jiraSyncActive(),
    project_key: config.jira.projectKey || null,
    base_url: config.jira.baseUrl || null,
    pending_outbox: Number(rows[0]?.n ?? 0),
    done_statuses: config.jira.doneStatuses,
  });
});

jiraSyncAdminRouter.post("/drain", requireAdmin, async (_req, res) => {
  if (!jiraSyncActive()) throw new HttpError(400, "Jira sync is not active");
  const n = await drainJiraSyncOutbox(50);
  res.json({ drained: n });
});

jiraSyncAdminRouter.post("/reconcile", requireAdmin, async (_req, res) => {
  if (!jiraSyncActive()) throw new HttpError(400, "Jira sync is not active");
  const applied = await reconcileJiraProjects(200);
  res.json({ applied });
});

jiraSyncAdminRouter.post("/backfill-links", requireAdmin, async (req, res) => {
  const result = await backfillJiraKeysFromLinks(req.groupId);
  res.json(result);
});

const syncNowSchema = z.object({
  jira_key: z.string().trim().max(64).optional(),
});

jiraSyncAdminRouter.post("/projects/:id/sync", requireAdmin, async (req, res) => {
  const projectId = String(req.params.id);
  const groupId = req.groupId!;
  const body = syncNowSchema.parse(req.body ?? {});

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      jira_key: string | null;
      type: string;
    }>(
      `SELECT id, jira_key, type FROM projects
        WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [projectId, groupId],
    );
    const project = rows[0];
    if (!project) throw new HttpError(404, "project not found");

    if (body.jira_key) {
      const key = parseJiraKeyFromText(body.jira_key) ?? body.jira_key.toUpperCase();
      let issueId: string | null = null;
      if (jiraSyncActive()) {
        try {
          const issue = await getIssue(key);
          issueId = issue.id;
        } catch {
          /* store key anyway */
        }
      }
      await client.query(
        `UPDATE projects
            SET jira_key = $2,
                jira_issue_id = COALESCE($3, jira_issue_id),
                jira_sync_error = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [projectId, key, issueId],
      );
    }

    await enqueueJiraSync(client, {
      groupId,
      projectId,
      action: project.jira_key || body.jira_key ? "update" : "create",
    });

    const { rows: out } = await client.query(
      `SELECT id, jira_key, jira_issue_id, jira_synced_at, jira_sync_error
         FROM projects WHERE id = $1`,
      [projectId],
    );
    return out[0];
  });

  if (jiraSyncActive()) {
    await drainJiraSyncOutbox(5);
  }

  const { rows } = await query(
    `SELECT id, title, jira_key, jira_issue_id, jira_synced_at, jira_sync_error
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = rows[0] as {
    jira_key: string | null;
  } & Record<string, unknown>;
  res.json({
    ...row,
    jira_url: row.jira_key ? jiraBrowseUrl(row.jira_key) : null,
    queued: result,
  });
});
