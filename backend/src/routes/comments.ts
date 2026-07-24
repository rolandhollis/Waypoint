import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../middleware/error.js";
import type { ProjectCommentRow } from "../types.js";
import { newlyAddedMentionIds } from "../lib/mentions.js";
import { fireMentionEmail } from "../notifications/mentionEmail.js";

/**
 * Nested under /api/projects/:id/comments (see index.ts).
 * mergeParams so we can read the project id from the parent path.
 *
 * Read + write here are open to any authenticated user — comments are
 * an informal discussion channel, not part of the write-gated data
 * model. Editing / deleting is limited to the author or an admin.
 */
export const projectCommentsRouter = Router({ mergeParams: true });

const bodySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "comment cannot be empty")
    .max(4000, "comment too long (max 4000 chars)"),
});

type CommentParams = { id: string; commentId?: string };

/**
 * Confirm the referenced project both exists AND belongs to the
 * caller's tenant. Every endpoint below funnels through this so a
 * cross-tenant probe (guessing a project id from another group)
 * gets an indistinguishable 404 rather than leaking the comment
 * thread.
 */
async function assertProjectInGroup(projectId: string, groupId: string, requireLive = false) {
  const clauses = ["id = $1", "group_id = $2"];
  if (requireLive) clauses.push("deleted_at IS NULL");
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE ${clauses.join(" AND ")}`,
    [projectId, groupId],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
}

/**
 * Filter a list of candidate user ids down to those that (a) exist
 * and (b) are actually members of the current tenant. Super-users
 * count as implicit members of every group. Any id that fails either
 * check is silently dropped — the token stays in the text as-is, but
 * we neither insert a mentions row nor fire an email for it.
 *
 * Silent drop (rather than error) is deliberate: a hostile client
 * could otherwise probe user-id existence by watching for 400 vs 201
 * on mention-carrying comments, and a benign client racing a
 * user-removal shouldn't see its comment save fail either.
 */
async function filterMembersOfGroup(
  client: PoolClient,
  candidateUserIds: string[],
  groupId: string,
): Promise<string[]> {
  if (candidateUserIds.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT u.id
       FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND (u.is_super_user = TRUE
             OR EXISTS (SELECT 1 FROM user_groups ug
                          WHERE ug.user_id = u.id AND ug.group_id = $2))`,
    [candidateUserIds, groupId],
  );
  return rows.map((r) => r.id);
}

/**
 * Insert a batch of `mentions` rows in one round-trip, one per
 * (mentioned_user_id, source). Called from inside the same
 * transaction as the comment write so the mention index rolls back
 * cleanly if the comment insert / update fails.
 */
async function insertMentionsRows(
  client: PoolClient,
  args: {
    groupId: string;
    projectId: string;
    mentioningUserId: string;
    sourceType: "comment" | "description";
    sourceId: string | null;
    mentionedUserIds: string[];
  },
) {
  if (args.mentionedUserIds.length === 0) return;
  const values: unknown[] = [];
  const rowSql: string[] = [];
  for (const uid of args.mentionedUserIds) {
    const base = values.length;
    values.push(
      args.groupId,
      args.projectId,
      uid,
      args.mentioningUserId,
      args.sourceType,
      args.sourceId,
    );
    rowSql.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
  }
  await client.query(
    `INSERT INTO mentions
       (group_id, project_id, mentioned_user_id, mentioning_user_id, source_type, source_id)
     VALUES ${rowSql.join(", ")}`,
    values,
  );
}

projectCommentsRouter.get("/", async (req, res) => {
  const projectId = String((req.params as CommentParams).id);
  await assertProjectInGroup(projectId, req.groupId!);
  const { rows } = await query<ProjectCommentRow>(
    `SELECT * FROM project_comments
      WHERE project_id = $1
      ORDER BY created_at DESC`,
    [projectId],
  );
  res.json(rows);
});

projectCommentsRouter.post("/", async (req, res) => {
  const { body } = bodySchema.parse(req.body);
  const projectId = String((req.params as CommentParams).id);
  const groupId = req.groupId!;
  const userId = req.user!.id;
  await assertProjectInGroup(projectId, groupId, true);

  // Insert the comment and, in the same transaction, index every
  // *new* @mention. Diffing against no prior body means every parsed
  // mention counts as newly-added.
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<ProjectCommentRow>(
      `INSERT INTO project_comments (project_id, author_user_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [projectId, userId, body],
    );
    const comment = rows[0]!;
    const parsedIds = newlyAddedMentionIds(null, body);
    // Drop self-mentions and any id that isn't actually a group
    // member (see `filterMembersOfGroup` above for why we silently
    // filter rather than reject the comment).
    const memberIds = (await filterMembersOfGroup(client, parsedIds, groupId))
      .filter((uid) => uid !== userId);
    if (memberIds.length > 0) {
      await insertMentionsRows(client, {
        groupId,
        projectId,
        mentioningUserId: userId,
        sourceType: "comment",
        sourceId: comment.id,
        mentionedUserIds: memberIds,
      });
    }
    return { comment, notifyUserIds: memberIds };
  });

  // Email fires OUTSIDE the transaction (fire-and-forget): a delivery
  // hiccup must not undo the comment write.
  for (const uid of result.notifyUserIds) {
    fireMentionEmail({
      mentionedUserId: uid,
      mentioningUserId: userId,
      projectId,
      sourceType: "comment",
      bodyText: body,
    });
  }

  res.status(201).json(result.comment);
});

projectCommentsRouter.patch("/:commentId", async (req, res) => {
  const { body } = bodySchema.parse(req.body);
  const params = req.params as CommentParams;
  const projectId = String(params.id);
  const commentId = String(params.commentId);
  const groupId = req.groupId!;
  const userId = req.user!.id;
  await assertProjectInGroup(projectId, groupId);

  // Look up the pre-edit row before locking so we can diff mentions
  // (only NEWLY-added ones should trigger a fresh email). FOR UPDATE
  // inside the transaction below prevents a concurrent patch from
  // slipping in between diff-and-write.
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<ProjectCommentRow>(
      `SELECT * FROM project_comments WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [commentId, projectId],
    );
    const comment = existing[0];
    if (!comment) throw new HttpError(404, "comment not found");

    const isAuthor = comment.author_user_id === userId;
    // Use the per-group role that groupScope populated; falls back
    // to the deprecated global role for compatibility, matching the
    // pattern in middleware/auth.ts requireRole().
    const isAdmin = (req.userGroupRole ?? req.user!.role) === "admin";
    if (!isAuthor && !isAdmin) throw new HttpError(403, "only the author or an admin may edit");

    const { rows: updated } = await client.query<ProjectCommentRow>(
      `UPDATE project_comments
          SET body = $1, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [body, commentId],
    );

    const newlyAdded = newlyAddedMentionIds(comment.body, body);
    const memberIds = (await filterMembersOfGroup(client, newlyAdded, groupId))
      .filter((uid) => uid !== userId);
    if (memberIds.length > 0) {
      await insertMentionsRows(client, {
        groupId,
        projectId,
        mentioningUserId: userId,
        sourceType: "comment",
        sourceId: comment.id,
        mentionedUserIds: memberIds,
      });
    }

    return { comment: updated[0]!, notifyUserIds: memberIds };
  });

  for (const uid of result.notifyUserIds) {
    fireMentionEmail({
      mentionedUserId: uid,
      mentioningUserId: userId,
      projectId,
      sourceType: "comment",
      bodyText: body,
    });
  }

  res.json(result.comment);
});

projectCommentsRouter.delete("/:commentId", async (req, res) => {
  const params = req.params as CommentParams;
  const projectId = String(params.id);
  const commentId = String(params.commentId);
  await assertProjectInGroup(projectId, req.groupId!);

  const { rows: existing } = await query<ProjectCommentRow>(
    `SELECT * FROM project_comments WHERE id = $1 AND project_id = $2`,
    [commentId, projectId],
  );
  const comment = existing[0];
  if (!comment) throw new HttpError(404, "comment not found");

  const isAuthor = comment.author_user_id === req.user!.id;
  const isAdmin = (req.userGroupRole ?? req.user!.role) === "admin";
  if (!isAuthor && !isAdmin) throw new HttpError(403, "only the author or an admin may delete");

  await query(`DELETE FROM project_comments WHERE id = $1`, [commentId]);
  res.status(204).end();
});
