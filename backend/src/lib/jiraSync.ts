import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool, query, withTransaction } from "../db/pool.js";
import type { ProjectRow } from "../types.js";
import {
  deriveConstants,
  jiraBrandCodeForConstants,
} from "./groupConstants.js";
import {
  createEpic,
  getIssue,
  jiraBrowseUrl,
  jiraConfigured,
  JiraClientError,
  parseJiraKeyFromText,
  transitionEpic,
  updateEpic,
} from "./jiraClient.js";
import { resolveShopPods } from "./shopPod.js";

export type JiraSyncAction = "create" | "update" | "transition";

const MAX_ATTEMPTS = 8;

export function jiraSyncActive(): boolean {
  return jiraConfigured();
}

/** Enqueue an outbound sync job. No-op when sync is disabled. */
export async function enqueueJiraSync(
  client: PoolClient,
  args: {
    groupId: string;
    projectId: string;
    action: JiraSyncAction;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  if (!jiraSyncActive()) return;
  await client.query(
    `INSERT INTO jira_sync_outbox (group_id, project_id, action, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      args.groupId,
      args.projectId,
      args.action,
      JSON.stringify(args.payload ?? {}),
    ],
  );
}

type OutboxRow = {
  id: string;
  group_id: string;
  project_id: string;
  action: JiraSyncAction;
  payload: Record<string, unknown>;
  attempts: number;
};

type ProjectSyncRow = ProjectRow & {
  jira_key: string | null;
  jira_issue_id: string | null;
  swim_lane_is_terminal: boolean | null;
  swim_lane_is_archive: boolean | null;
};

async function loadProjectForSync(
  client: PoolClient,
  projectId: string,
): Promise<ProjectSyncRow | null> {
  const { rows } = await client.query<ProjectSyncRow>(
    `SELECT p.*,
            sl.is_terminal AS swim_lane_is_terminal,
            sl.is_archive AS swim_lane_is_archive
       FROM projects p
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
      WHERE p.id = $1
      FOR UPDATE OF p`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function markProjectSynced(
  client: PoolClient,
  projectId: string,
  ref: { key: string; id: string },
): Promise<void> {
  await client.query(
    `UPDATE projects
        SET jira_key = $2,
            jira_issue_id = $3,
            jira_synced_at = NOW(),
            jira_sync_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [projectId, ref.key, ref.id],
  );
  // Ensure a browseable project_links row exists (idempotent by URL).
  const url = jiraBrowseUrl(ref.key);
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM project_links
      WHERE project_id = $1 AND url = $2
      LIMIT 1`,
    [projectId, url],
  );
  if (!existing[0]) {
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM project_links WHERE project_id = $1`,
      [projectId],
    );
    await client.query(
      `INSERT INTO project_links (project_id, label, url, position)
       VALUES ($1, 'Jira', $2, $3)`,
      [projectId, url, maxRows[0]?.next ?? 0],
    );
  }
}

async function markProjectSyncError(
  client: PoolClient,
  projectId: string,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE projects
        SET jira_sync_error = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [projectId, error.slice(0, 1000)],
  );
}

function outboundFields(
  project: ProjectSyncRow,
  brandCode: string,
  podNames: string[],
) {
  return {
    summary: project.title,
    description: project.description ?? "",
    labels: Array.isArray(project.tags) ? project.tags : [],
    brandCode,
    podNames,
  };
}

async function loadBrandCodeForGroup(
  client: PoolClient,
  groupId: string,
): Promise<string> {
  const { rows } = await client.query<{ constants: unknown }>(
    `SELECT constants FROM groups WHERE id = $1`,
    [groupId],
  );
  return jiraBrandCodeForConstants(deriveConstants(rows[0]?.constants));
}

async function loadPodNamesForProject(
  client: PoolClient,
  projectId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT t.name
       FROM project_teams pt
       JOIN teams t ON t.id = pt.team_id
      WHERE pt.project_id = $1
      ORDER BY pt.position ASC`,
    [projectId],
  );
  return resolveShopPods(rows.map((r) => r.name));
}

async function processOne(row: OutboxRow): Promise<void> {
  await withTransaction(async (client) => {
    const project = await loadProjectForSync(client, row.project_id);
    if (!project || project.deleted_at) {
      await client.query(
        `UPDATE jira_sync_outbox
            SET processed_at = NOW(), updated_at = NOW(), last_error = $2
          WHERE id = $1`,
        [row.id, "project missing or deleted"],
      );
      return;
    }

    try {
      const brandCode = await loadBrandCodeForGroup(client, project.group_id);
      const podNames = await loadPodNamesForProject(client, project.id);
      const fields = outboundFields(project, brandCode, podNames);
      if (row.action === "create" || !project.jira_key) {
        if (project.jira_key) {
          await updateEpic(project.jira_key, fields);
          const issue = await getIssue(project.jira_key);
          await markProjectSynced(client, project.id, {
            key: issue.key,
            id: issue.id,
          });
        } else {
          const created = await createEpic(fields);
          await markProjectSynced(client, project.id, {
            key: created.key,
            id: created.id,
          });
        }
      } else if (row.action === "update") {
        await updateEpic(project.jira_key, fields);
        await markProjectSynced(client, project.id, {
          key: project.jira_key,
          id: project.jira_issue_id ?? project.jira_key,
        });
      } else if (row.action === "transition") {
        const target =
          typeof row.payload?.statusName === "string"
            ? row.payload.statusName
            : project.swim_lane_is_terminal || project.swim_lane_is_archive
              ? "Done"
              : null;
        if (target && project.jira_key) {
          await transitionEpic(project.jira_key, target);
        }
        await client.query(
          `UPDATE projects
              SET jira_synced_at = NOW(), jira_sync_error = NULL, updated_at = NOW()
            WHERE id = $1`,
          [project.id],
        );
      }

      await client.query(
        `UPDATE jira_sync_outbox
            SET processed_at = NOW(), updated_at = NOW(), last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
    } catch (err) {
      const message =
        err instanceof JiraClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      const attempts = row.attempts + 1;
      const delayMin = Math.min(60, 2 ** Math.min(attempts, 6));
      await markProjectSyncError(client, project.id, message);
      const giveUp = attempts >= MAX_ATTEMPTS;
      await client.query(
        `UPDATE jira_sync_outbox
            SET attempts = $2::int,
                last_error = $3::text,
                next_attempt_at = NOW() + ($4::int * interval '1 minute'),
                processed_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [row.id, attempts, message.slice(0, 1000), delayMin, giveUp],
      );
    }
  });
}

/** Drain due outbox rows. Safe to call from cron. */
export async function drainJiraSyncOutbox(limit = 25): Promise<number> {
  if (!jiraSyncActive()) return 0;
  const { rows } = await query<OutboxRow>(
    `SELECT id, group_id, project_id, action, payload, attempts
       FROM jira_sync_outbox
      WHERE processed_at IS NULL
        AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT $1`,
    [limit],
  );
  for (const row of rows) {
    // payload may arrive as object already from pg
    if (typeof row.payload === "string") {
      try {
        row.payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        row.payload = {};
      }
    }
    await processOne(row);
  }
  return rows.length;
}

/**
 * Apply inbound Jira status to a Waypoint project.
 * Only Done-like statuses move the card into the group's terminal lane.
 */
export async function applyInboundJiraStatus(args: {
  groupId?: string;
  jiraKey?: string | null;
  jiraIssueId?: string | null;
  statusName: string;
}): Promise<{ updated: boolean; projectId?: string }> {
  const status = args.statusName.trim().toLowerCase();
  const isDone =
    config.jira.doneStatuses.includes(status) || status === "done";

  if (!isDone) return { updated: false };

  return withTransaction(async (client) => {
    const clauses: string[] = ["p.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (args.jiraIssueId) {
      params.push(args.jiraIssueId);
      clauses.push(`p.jira_issue_id = $${params.length}`);
    } else if (args.jiraKey) {
      params.push(args.jiraKey.toUpperCase());
      clauses.push(`p.jira_key = $${params.length}`);
    } else {
      return { updated: false };
    }
    if (args.groupId) {
      params.push(args.groupId);
      clauses.push(`p.group_id = $${params.length}`);
    }

    const { rows } = await client.query<ProjectRow>(
      `SELECT p.* FROM projects p
        WHERE ${clauses.join(" AND ")}
        LIMIT 1
        FOR UPDATE`,
      params,
    );
    const project = rows[0];
    if (!project) return { updated: false };

    const { rows: terminal } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes
        WHERE group_id = $1 AND is_terminal = TRUE
        ORDER BY is_archive ASC, "order" ASC
        LIMIT 1
        FOR UPDATE`,
      [project.group_id],
    );
    const laneId = terminal[0]?.id;
    if (!laneId) return { updated: false, projectId: project.id };
    if (project.swim_lane_id === laneId && project.actual_completion_date) {
      return { updated: false, projectId: project.id };
    }

    await client.query(
      `UPDATE projects
          SET swim_lane_id = $2,
              actual_completion_date = COALESCE(actual_completion_date, CURRENT_DATE),
              jira_synced_at = NOW(),
              jira_sync_error = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [project.id, laneId],
    );
    return { updated: true, projectId: project.id };
  });
}

/** Parse project_links Jira URLs into jira_key for projects missing one. */
export async function backfillJiraKeysFromLinks(
  groupId?: string,
): Promise<{ scanned: number; linked: number }> {
  const params: unknown[] = [];
  let groupClause = "";
  if (groupId) {
    params.push(groupId);
    groupClause = `AND p.group_id = $${params.length}`;
  }
  const { rows } = await query<{
    project_id: string;
    group_id: string;
    url: string;
  }>(
    `SELECT p.id AS project_id, p.group_id, l.url
       FROM projects p
       JOIN project_links l ON l.project_id = p.id
      WHERE p.deleted_at IS NULL
        AND p.jira_key IS NULL
        AND (l.url ILIKE '%atlassian.net%' OR l.url ILIKE '%/browse/%' OR l.label ILIKE 'jira%')
        ${groupClause}`,
    params,
  );

  let linked = 0;
  for (const row of rows) {
    const key = parseJiraKeyFromText(row.url);
    if (!key) continue;
    try {
      let issueId: string | null = null;
      if (jiraSyncActive()) {
        try {
          const issue = await getIssue(key);
          issueId = issue.id;
        } catch {
          // Still store the key even if lookup fails (offline / wrong site).
        }
      }
      const { rowCount } = await pool.query(
        `UPDATE projects
            SET jira_key = $2,
                jira_issue_id = COALESCE($3, jira_issue_id),
                jira_sync_error = NULL,
                updated_at = NOW()
          WHERE id = $1 AND jira_key IS NULL`,
        [row.project_id, key, issueId],
      );
      if (rowCount && rowCount > 0) linked += 1;
    } catch (err) {
      console.warn(`[jira-sync] backfill skip ${row.project_id}:`, err);
    }
  }
  return { scanned: rows.length, linked };
}

/** Pull Jira status for linked projects and apply Done → terminal; re-queue outbound updates. */
export async function reconcileJiraProjects(limit = 100): Promise<number> {
  if (!jiraSyncActive()) return 0;
  const { rows } = await query<{
    id: string;
    group_id: string;
    jira_key: string;
  }>(
    `SELECT id, group_id, jira_key
       FROM projects
      WHERE deleted_at IS NULL
        AND jira_key IS NOT NULL
      ORDER BY jira_synced_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );

  let applied = 0;
  for (const row of rows) {
    try {
      const issue = await getIssue(row.jira_key);
      const result = await applyInboundJiraStatus({
        groupId: row.group_id,
        jiraKey: issue.key,
        jiraIssueId: issue.id,
        statusName: issue.statusName,
      });
      if (result.updated) applied += 1;
      else {
        await pool.query(
          `UPDATE projects
              SET jira_issue_id = COALESCE(jira_issue_id, $2),
                  jira_synced_at = NOW()
            WHERE id = $1`,
          [row.id, issue.id],
        );
      }
    } catch (err) {
      console.warn(`[jira-sync] reconcile failed for ${row.jira_key}:`, err);
    }
  }

  await withTransaction(async (client) => {
    for (const row of rows) {
      await enqueueJiraSync(client, {
        groupId: row.group_id,
        projectId: row.id,
        action: "update",
      });
    }
  });

  return applied;
}
