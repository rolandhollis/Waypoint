import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { resolvePublicIdeaGroup } from "../lib/publicIdeaSlug.js";
import { HttpError } from "../middleware/error.js";
import { notifyAdminsOfPublicIdea } from "../notifications/publicIdeaEmail.js";
import { replaceProjectTeams } from "./projects.js";

/**
 * Public (unauthenticated) idea intake.
 *
 *   GET  /api/public/ideas/:slugOrId  — workspace label + teams + share URL
 *   POST /api/public/ideas/:slugOrId  — create an epic in the default lane
 *
 * `:slugOrId` accepts the pretty `public_slug` (preferred) or the
 * group UUID. Creates land with owner/created_by null; submitter
 * contact is prefixed onto the description and emailed to admins
 * with a deep link to `/projects/:id`.
 */

export const publicIdeasRouter = Router();

const IDEA_WINDOW_MS = 15 * 60 * 1000;
const IDEA_MAX_REQUESTS = 8;
type FailBucket = { count: number; resetAt: number };
const ideaBuckets = new Map<string, FailBucket>();

function recordIdeaAttempt(key: string): void {
  const now = Date.now();
  const cur = ideaBuckets.get(key);
  if (!cur || cur.resetAt <= now) {
    ideaBuckets.set(key, { count: 1, resetAt: now + IDEA_WINDOW_MS });
    return;
  }
  cur.count++;
}

function isIdeaLocked(key: string): boolean {
  const cur = ideaBuckets.get(key);
  if (!cur) return false;
  if (cur.resetAt <= Date.now()) {
    ideaBuckets.delete(key);
    return false;
  }
  return cur.count >= IDEA_MAX_REQUESTS;
}

const submitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).optional().default(""),
  teams: z.array(z.string().uuid()).max(10).optional().default([]),
  submitter_name: z.string().trim().min(1).max(120),
  submitter_email: z.string().email().max(254),
});

function sharePath(group: { id: string; public_slug: string | null }): string {
  return `/ideas/${group.public_slug ?? group.id}`;
}

publicIdeasRouter.get("/:slugOrId", async (req, res) => {
  const group = await resolvePublicIdeaGroup(String(req.params.slugOrId));
  const { rows: teams } = await query<{
    id: string;
    name: string;
    color: string | null;
    order: number;
  }>(
    `SELECT id, name, color, "order"
       FROM teams
      WHERE group_id = $1
      ORDER BY "order" ASC, name ASC`,
    [group.id],
  );

  const appUrl = config.publicAppUrl.replace(/\/+$/, "");
  const path = sharePath(group);
  res.json({
    group_id: group.id,
    group_name: group.name,
    public_slug: group.public_slug,
    share_path: path,
    share_url: `${appUrl}${path}`,
    teams,
  });
});

publicIdeasRouter.post("/:slugOrId", async (req, res) => {
  const group = await resolvePublicIdeaGroup(String(req.params.slugOrId));
  const body = submitSchema.parse(req.body);
  const rateKey = `${group.id}:${body.submitter_email.toLowerCase()}`;
  if (isIdeaLocked(rateKey)) {
    throw new HttpError(429, "too many submissions; try again later");
  }
  recordIdeaAttempt(rateKey);

  let teamIds: string[] = [];
  let teamNames: string[] = [];
  if (body.teams.length) {
    const { rows: teamRows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM teams
        WHERE group_id = $1 AND id = ANY($2::uuid[])
        ORDER BY "order" ASC, name ASC`,
      [group.id, body.teams],
    );
    teamIds = teamRows.map((t) => t.id);
    teamNames = teamRows.map((t) => t.name);
  }

  const descriptionBody = body.description.trim();
  const attribution = `Submitted via public idea form by ${body.submitter_name} <${body.submitter_email.toLowerCase()}>`;
  const description = descriptionBody
    ? `${attribution}\n\n${descriptionBody}`
    : attribution;

  const created = await withTransaction(async (client) => {
    const { rows: laneRows } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes
        WHERE group_id = $1
          AND COALESCE(is_archive, FALSE) = FALSE
          AND COALESCE(is_admin_only, FALSE) = FALSE
        ORDER BY is_default_new DESC, is_terminal ASC, "order" ASC
        LIMIT 1`,
      [group.id],
    );
    const laneId = laneRows[0]?.id;
    if (!laneId) {
      throw new HttpError(400, "this workspace has no open swim lanes yet");
    }

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
      [laneId],
    );
    const position = maxRows[0]?.next ?? 0;

    const { rows: gpRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(global_priority), 0) + 1 AS next
         FROM projects
        WHERE group_id = $1 AND deleted_at IS NULL`,
      [group.id],
    );
    const globalPriority = gpRows[0]?.next ?? 1;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects
         (group_id, title, description, swim_lane_id, position, owner_id, tags,
          type, parent_id, excluded_from_capacity, global_priority, created_by)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'epic',NULL,FALSE,$7,NULL)
       RETURNING id`,
      [group.id, body.title, description, laneId, position, [], globalPriority],
    );
    const projectId = rows[0]!.id;

    if (teamIds.length) {
      await replaceProjectTeams(client, projectId, teamIds);
    }

    await client.query(
      `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
       VALUES ($1, NULL, $2, NULL)`,
      [projectId, laneId],
    );
    await client.query(
      `INSERT INTO project_audit_events
         (project_id, user_id, action, field, from_value, to_value)
       VALUES ($1, NULL, 'create', 'public_idea', NULL, $2::jsonb)`,
      [
        projectId,
        JSON.stringify({
          submitter_name: body.submitter_name,
          submitter_email: body.submitter_email.toLowerCase(),
          teams: teamIds,
        }),
      ],
    );

    return { projectId };
  });

  const appUrl = config.publicAppUrl.replace(/\/+$/, "");
  const projectUrl = `${appUrl}/projects/${created.projectId}`;

  void notifyAdminsOfPublicIdea({
    groupId: group.id,
    groupName: group.name,
    projectId: created.projectId,
    projectUrl,
    title: body.title,
    description: descriptionBody,
    teamNames,
    submitterName: body.submitter_name,
    submitterEmail: body.submitter_email.toLowerCase(),
  }).catch((err) => console.error("[public-idea] notify failed", err));

  res.status(201).json({
    id: created.projectId,
    title: body.title,
    group_id: group.id,
    project_url: projectUrl,
  });
});
