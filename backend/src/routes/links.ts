import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { recordAudit } from "./projects.js";
import type { ProjectLinkRow } from "../types.js";

/**
 * External-URL "links" attached to a project — Jira ticket,
 * Confluence page, Figma, etc. Two routers because the URL surface
 * splits naturally on whether the caller already knows the parent
 * project id or is addressing a link by its own id:
 *
 *   * `projectLinksRouter` — mounted at
 *     /api/projects/:id/links. Handles list + create. mergeParams
 *     pulls the project id from the parent route. Reads require
 *     authentication + groupScope (both applied by index.ts);
 *     writes additionally require requireWrite.
 *   * `linksRouter` — mounted at /api/links. Handles by-link-id
 *     endpoints (PATCH, DELETE) and the group-scoped
 *     label-suggestions discovery endpoint. Same auth + group
 *     scoping applied by index.ts.
 *
 * Audit trail: every create/update/delete lands as an `edit` event
 * with `field = "link:<link_id>"` and a `{label, url}` payload,
 * mirroring how deadlines and dependencies are logged. The
 * detail-panel timeline renders them via the same field-prefix
 * dispatch as those other kinds.
 *
 * Label catalog: labels are denormalized (a plain string per row),
 * not normalized into a separate catalog table. The "suggested
 * labels" list surfaced to the picker is derived here at query
 * time from DISTINCT labels across every project_links row whose
 * parent project belongs to the caller's group. Cross-tenant leak
 * is impossible because the join filters by projects.group_id.
 */
export const projectLinksRouter = Router({ mergeParams: true });
export const linksRouter = Router();

type ProjectParams = { id: string };
type LinkParams = { linkId: string };

/** URL-validation shared between POST and PATCH so both paths reject the
 * same shapes with the same message. Zod's `.url()` already covers
 * "is a valid URL" but is permissive about schemes; we insist on
 * http(s) so a mailto:/javascript:/file: string can't sneak in and
 * render as a clickable anchor. */
const httpUrl = z
  .string()
  .trim()
  .max(2048, "url too long (max 2048 chars)")
  .url("url must be a valid URL")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "url must start with http:// or https://");

const labelSchema = z
  .string()
  .trim()
  .min(1, "label cannot be empty")
  .max(64, "label too long (max 64 chars)");

/** Confirm the referenced project exists in the caller's tenant.
 * Cross-tenant probes get an indistinguishable 404 rather than
 * leaking that the id belongs to a different group. */
async function assertProjectInGroup(projectId: string, groupId: string) {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND group_id = $2`,
    [projectId, groupId],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
}

/** Fetch the link + its parent project's group_id in one round trip
 * so the tenant guard on write endpoints can 404 without a second
 * query. Returns null when the link doesn't exist at all. */
async function loadLinkWithGroup(
  linkId: string,
): Promise<(ProjectLinkRow & { group_id: string }) | null> {
  const { rows } = await query<ProjectLinkRow & { group_id: string }>(
    `SELECT l.id, l.project_id, l.label, l.url, l.position,
            l.created_at, l.updated_at, p.group_id
       FROM project_links l
       JOIN projects p ON p.id = l.project_id
      WHERE l.id = $1`,
    [linkId],
  );
  return rows[0] ?? null;
}

projectLinksRouter.get("/", async (req, res) => {
  const projectId = String((req.params as ProjectParams).id);
  await assertProjectInGroup(projectId, req.groupId!);
  const { rows } = await query<ProjectLinkRow>(
    `SELECT id, project_id, label, url, position, created_at, updated_at
       FROM project_links
      WHERE project_id = $1
      ORDER BY position ASC, created_at ASC`,
    [projectId],
  );
  res.json(rows);
});

const createSchema = z.object({
  label: labelSchema,
  url: httpUrl,
});

projectLinksRouter.post("/", requireWrite, async (req, res) => {
  const projectId = String((req.params as ProjectParams).id);
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  await assertProjectInGroup(projectId, groupId);

  const result = await withTransaction(async (client) => {
    // Position = max + 1 so the (project_id, position) UNIQUE index
    // stays gap-free. COALESCE handles the empty-list case where MAX
    // returns NULL.
    const { rows: posRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM project_links WHERE project_id = $1`,
      [projectId],
    );
    const position = posRows[0]?.next ?? 0;

    const { rows } = await client.query<ProjectLinkRow>(
      `INSERT INTO project_links (project_id, label, url, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, label, url, position, created_at, updated_at`,
      [projectId, body.label, body.url, position],
    );
    const created = rows[0]!;
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `link:${created.id}`,
      from: null,
      to: { label: created.label, url: created.url },
    });
    return created;
  });
  res.status(201).json(result);
});

const patchSchema = z
  .object({
    label: labelSchema.optional(),
    url: httpUrl.optional(),
  })
  .refine((v) => v.label !== undefined || v.url !== undefined, {
    message: "PATCH body must include at least one of: label, url",
  });

linksRouter.patch("/:linkId", requireWrite, async (req, res) => {
  const linkId = String((req.params as LinkParams).linkId);
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;

  const existing = await loadLinkWithGroup(linkId);
  // Cross-tenant probe -> 404 regardless of whether the id is real.
  if (!existing || existing.group_id !== groupId) {
    throw new HttpError(404, "link not found");
  }

  const result = await withTransaction(async (client) => {
    const nextLabel = body.label ?? existing.label;
    const nextUrl = body.url ?? existing.url;
    if (nextLabel === existing.label && nextUrl === existing.url) {
      // No-op — return the row unchanged and skip the audit event.
      return existing;
    }
    const { rows } = await client.query<ProjectLinkRow>(
      `UPDATE project_links
          SET label = $1, url = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING id, project_id, label, url, position, created_at, updated_at`,
      [nextLabel, nextUrl, linkId],
    );
    const after = rows[0]!;
    await recordAudit(client, {
      projectId: existing.project_id,
      userId: req.user!.id,
      action: "edit",
      field: `link:${after.id}`,
      from: { label: existing.label, url: existing.url },
      to: { label: after.label, url: after.url },
    });
    return after;
  });
  res.json(result);
});

linksRouter.delete("/:linkId", requireWrite, async (req, res) => {
  const linkId = String((req.params as LinkParams).linkId);
  const groupId = req.groupId!;
  const existing = await loadLinkWithGroup(linkId);
  if (!existing || existing.group_id !== groupId) {
    throw new HttpError(404, "link not found");
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM project_links WHERE id = $1`, [linkId]);
    await recordAudit(client, {
      projectId: existing.project_id,
      userId: req.user!.id,
      action: "edit",
      field: `link:${existing.id}`,
      from: { label: existing.label, url: existing.url },
      to: null,
    });
  });
  res.json({ deleted: linkId });
});

/**
 * Label discovery: DISTINCT `label` across every project_links row
 * whose parent project belongs to the caller's group, sorted
 * case-insensitively. The frontend unions this with the built-in
 * defaults (`Jira`, `Confluence`) so both surface even before any
 * link has been created in the tenant. Cross-tenant labels can't
 * leak because the join filters by projects.group_id.
 *
 * Path MUST come before `/:linkId` on this router would be a
 * concern, but Express matches static segments before dynamic ones
 * so ordering isn't a problem here — nonetheless we register it
 * explicitly last so a future refactor doesn't break by reordering.
 */
linksRouter.get("/label-suggestions", async (req, res) => {
  const groupId = req.groupId!;
  const { rows } = await query<{ label: string }>(
    `SELECT DISTINCT l.label
       FROM project_links l
       JOIN projects p ON p.id = l.project_id
      WHERE p.group_id = $1
      ORDER BY lower(l.label) ASC`,
    [groupId],
  );
  res.json({ labels: rows.map((r) => r.label) });
});
