import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { HttpError } from "../middleware/error.js";
import type { ProjectCommentRow } from "../types.js";

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
  await assertProjectInGroup(projectId, req.groupId!, true);

  const { rows } = await query<ProjectCommentRow>(
    `INSERT INTO project_comments (project_id, author_user_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [projectId, req.user!.id, body],
  );
  res.status(201).json(rows[0]);
});

projectCommentsRouter.patch("/:commentId", async (req, res) => {
  const { body } = bodySchema.parse(req.body);
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
  // Use the per-group role that groupScope populated; falls back
  // to the deprecated global role for compatibility, matching the
  // pattern in middleware/auth.ts requireRole().
  const isAdmin = (req.userGroupRole ?? req.user!.role) === "admin";
  if (!isAuthor && !isAdmin) throw new HttpError(403, "only the author or an admin may edit");

  const { rows } = await query<ProjectCommentRow>(
    `UPDATE project_comments
        SET body = $1, updated_at = NOW()
      WHERE id = $2 RETURNING *`,
    [body, commentId],
  );
  res.json(rows[0]);
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
