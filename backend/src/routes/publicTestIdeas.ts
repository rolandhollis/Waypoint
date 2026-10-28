import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { resolveBacklogAbTestLane } from "../lib/abTestLanes.js";
import { resolvePublicIdeaGroup } from "../lib/publicIdeaSlug.js";
import { HttpError } from "../middleware/error.js";
import { notifyAdminsOfPublicTestIdea } from "../notifications/publicTestIdeaEmail.js";

/**
 * Public (unauthenticated) A/B test idea intake.
 *
 *   GET  /api/public/test-ideas/:slugOrId  — workspace label + teams
 *   POST /api/public/test-ideas/:slugOrId  — create card in Backlog (ideas)
 *
 * Lands on the A/B Testing board's backlog lane with created_by null.
 * Submitter contact is prefixed onto the description and emailed to
 * admins with a deep link to `/ab-testing?item=:id`.
 */

export const publicTestIdeasRouter = Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 8;
type FailBucket = { count: number; resetAt: number };
const buckets = new Map<string, FailBucket>();

function recordAttempt(key: string): void {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  cur.count++;
}

function isLocked(key: string): boolean {
  const cur = buckets.get(key);
  if (!cur) return false;
  if (cur.resetAt <= Date.now()) {
    buckets.delete(key);
    return false;
  }
  return cur.count >= MAX_REQUESTS;
}

const submitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).optional().default(""),
  team_id: z.string().uuid().nullable().optional().default(null),
  submitter_name: z.string().trim().min(1).max(120),
  submitter_email: z.string().email().max(254),
});

function sharePath(group: { id: string; public_slug: string | null }): string {
  return `/test-ideas/${group.public_slug ?? group.id}`;
}

publicTestIdeasRouter.get("/:slugOrId", async (req, res) => {
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

publicTestIdeasRouter.post("/:slugOrId", async (req, res) => {
  const group = await resolvePublicIdeaGroup(String(req.params.slugOrId));
  const body = submitSchema.parse(req.body);
  const rateKey = `${group.id}:${body.submitter_email.toLowerCase()}`;
  if (isLocked(rateKey)) {
    throw new HttpError(429, "too many submissions; try again later");
  }
  recordAttempt(rateKey);

  let teamId: string | null = null;
  let teamName: string | null = null;
  if (body.team_id) {
    const { rows: teamRows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM teams
        WHERE group_id = $1 AND id = $2`,
      [group.id, body.team_id],
    );
    if (!teamRows[0]) throw new HttpError(400, "team not found in this workspace");
    teamId = teamRows[0].id;
    teamName = teamRows[0].name;
  }

  const descriptionBody = body.description.trim();
  const attribution = `Submitted via public test idea form by ${body.submitter_name} <${body.submitter_email.toLowerCase()}>`;
  const description = descriptionBody
    ? `${attribution}\n\n${descriptionBody}`
    : attribution;

  const created = await withTransaction(async (client) => {
    const lane = await resolveBacklogAbTestLane(client, group.id);

    const { rows: posRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM ab_test_items
        WHERE group_id = $1
          AND deleted_at IS NULL
          AND lane_id = $2`,
      [group.id, lane.id],
    );
    const position = posRows[0]?.next ?? 0;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ab_test_items (
         group_id, name, description, team_id, lane_id,
         jira_key, links, due_date, is_blocked, blocked_reason,
         position, assigned_to, created_by, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         NULL, '[]'::jsonb, NULL, FALSE, NULL,
         $6, NULL, NULL, NULL
       )
       RETURNING id`,
      [group.id, body.title, description, teamId, lane.id, position],
    );
    const itemId = rows[0]!.id;

    await client.query(
      `INSERT INTO ab_test_item_audit_events
         (ab_test_item_id, user_id, action, field, from_value, to_value)
       VALUES ($1, NULL, 'create', 'public_test_idea', NULL, $2::jsonb)`,
      [
        itemId,
        JSON.stringify({
          submitter_name: body.submitter_name,
          submitter_email: body.submitter_email.toLowerCase(),
          team_id: teamId,
        }),
      ],
    );

    return { itemId };
  });

  const appUrl = config.publicAppUrl.replace(/\/+$/, "");
  const itemUrl = `${appUrl}/ab-testing?item=${created.itemId}`;

  void notifyAdminsOfPublicTestIdea({
    groupId: group.id,
    groupName: group.name,
    itemId: created.itemId,
    itemUrl,
    title: body.title,
    description: descriptionBody,
    teamName,
    submitterName: body.submitter_name,
    submitterEmail: body.submitter_email.toLowerCase(),
  }).catch((err) => console.error("[public-test-idea] notify failed", err));

  res.status(201).json({
    id: created.itemId,
    title: body.title,
    group_id: group.id,
    item_url: itemUrl,
  });
});
