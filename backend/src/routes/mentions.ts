import { Router } from "express";
import { query } from "../db/pool.js";
import { HttpError } from "../middleware/error.js";
import { renderMentionsAsPlain } from "../lib/mentions.js";

/**
 * @mention notifications for the current user in the current
 * tenant. Backs the navbar avatar's hover popover — a tiny surface
 * that answers three questions cheaply:
 *
 *   1. how many unread mentions do I have right now? (badge dot)
 *   2. what were the last N of them? (popover body)
 *   3. which have I now seen? (mark read on click)
 *
 * All routes are mounted behind `authenticate + groupScope` in
 * index.ts, so `req.user` and `req.groupId` are always populated.
 *
 * Every read + write is filtered by BOTH `mentioned_user_id =
 * req.user.id` AND `group_id = req.groupId` — a super-user hopping
 * groups doesn't accidentally see mentions from a tenant they're
 * not currently in, and a hostile client can't mark someone
 * else's mention as read by guessing its id.
 */

export const mentionsRouter = Router();

/**
 * Small numeric cap so a runaway mention count on the client can't
 * request a huge slice by tweaking the query string. The popover
 * only ever renders 10; even the "See all" future path won't need
 * more than a page or two before paging kicks in.
 */
const RECENT_LIMIT_MAX = 50;
const RECENT_LIMIT_DEFAULT = 10;

/**
 * ~120-char snippet cap for the popover row. Mentions inside the
 * body are rewritten to their plain-language form (`@Name`) before
 * clipping so a truncated snippet never cuts through a
 * `@[Name](user:UUID)` token and leaves half of it visible.
 */
const SNIPPET_MAX = 120;

function makeSnippet(text: string | null | undefined): string {
  if (!text) return "";
  const plain = renderMentionsAsPlain(text).replace(/\s+/g, " ").trim();
  if (plain.length <= SNIPPET_MAX) return plain;
  const clip = plain.slice(0, SNIPPET_MAX);
  const lastSpace = clip.lastIndexOf(" ");
  const cut = lastSpace > SNIPPET_MAX - 30 ? clip.slice(0, lastSpace) : clip;
  return `${cut.trimEnd()}\u2026`;
}

mentionsRouter.get("/unread-count", async (req, res) => {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM mentions
      WHERE mentioned_user_id = $1
        AND group_id = $2
        AND read_at IS NULL`,
    [req.user!.id, req.groupId!],
  );
  const count = Number(rows[0]?.count ?? "0");
  res.json({ count });
});

/**
 * The `?limit=` query param is parsed with `Number(...)` rather
 * than a full zod schema because it's a single scalar with a
 * simple clamp — any bogus / negative / NaN value collapses to
 * the default. The response is ordered newest-first so the
 * popover renders in "most recent at the top" order without any
 * client-side sort.
 *
 * Snippet source: for a comment mention we quote the current body
 * of the referenced comment (may have been edited since the
 * mention fired); for a description mention we quote the
 * project's current description. In both cases mention tokens are
 * rewritten to `@Name` so the snippet is human-readable.
 */
mentionsRouter.get("/recent", async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), RECENT_LIMIT_MAX)
    : RECENT_LIMIT_DEFAULT;

  const { rows } = await query<{
    id: string;
    project_id: string;
    project_title: string;
    mentioning_user_id: string;
    mentioning_user_name: string;
    mentioning_user_color: string;
    source_type: "comment" | "description";
    source_id: string | null;
    comment_body: string | null;
    description_body: string | null;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT m.id,
            m.project_id,
            p.title AS project_title,
            m.mentioning_user_id,
            u.name AS mentioning_user_name,
            u.color AS mentioning_user_color,
            m.source_type,
            m.source_id,
            c.body AS comment_body,
            p.description AS description_body,
            m.created_at,
            m.read_at
       FROM mentions m
       JOIN projects p ON p.id = m.project_id
       JOIN users u ON u.id = m.mentioning_user_id
       LEFT JOIN project_comments c ON c.id = m.source_id
      WHERE m.mentioned_user_id = $1
        AND m.group_id = $2
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [req.user!.id, req.groupId!, limit],
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      project_title: r.project_title,
      mentioning_user: {
        id: r.mentioning_user_id,
        name: r.mentioning_user_name,
        color: r.mentioning_user_color,
      },
      source_type: r.source_type,
      source_id: r.source_id,
      snippet: makeSnippet(
        r.source_type === "comment" ? r.comment_body : r.description_body,
      ),
      created_at: r.created_at,
      read_at: r.read_at,
    })),
  );
});

/**
 * Mark a single mention as read. Idempotent: the WHERE clause
 * scopes to (mention id, current user, current group) AND
 * `read_at IS NULL` so a second click after the first one landed
 * is a no-op — no double-timestamp write. Silently succeeds when
 * the id belongs to a different user (or doesn't exist) so a
 * hostile client can't probe id existence via the response code.
 */
mentionsRouter.post("/:id/read", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!id) throw new HttpError(400, "missing mention id");
  await query(
    `UPDATE mentions
        SET read_at = NOW()
      WHERE id = $1
        AND mentioned_user_id = $2
        AND group_id = $3
        AND read_at IS NULL`,
    [id, req.user!.id, req.groupId!],
  );
  res.status(204).end();
});

/**
 * Bulk-clear every unread mention for the current user in the
 * current tenant. Useful for a "mark all read" affordance on the
 * popover footer; the endpoint exists even though the current UI
 * doesn't wire it up yet so the affordance can land as a small
 * follow-up without another migration/router pass.
 */
mentionsRouter.post("/mark-all-read", async (req, res) => {
  await query(
    `UPDATE mentions
        SET read_at = NOW()
      WHERE mentioned_user_id = $1
        AND group_id = $2
        AND read_at IS NULL`,
    [req.user!.id, req.groupId!],
  );
  res.status(204).end();
});
