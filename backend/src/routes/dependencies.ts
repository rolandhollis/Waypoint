import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { recordAudit } from "./projects.js";
import type { ProjectDependencyRow, SwimLaneRow } from "../types.js";

/**
 * Mounted at /api/projects/:id/dependencies. Same pattern as the
 * deadlines router:
 *   * Any write requires per-group owner+ role.
 *   * All four references (project, project_swim_lane_id,
 *     depends_on_project_id, depends_on_swim_lane_id) must resolve
 *     inside the caller's current tenant. Cross-tenant is 404 to
 *     avoid leaking cross-group ids.
 *   * Both swim lanes must have `phase_date_key` bound, since the
 *     violation calculator needs both dates to compare. Rejecting
 *     unbound lanes here is preferable to storing a dead dep that
 *     the UI would silently mark "ok".
 *   * Self-dependency is caught by both the CHECK constraint (belt)
 *     and an early 400 (suspenders) so the error message reads
 *     naturally instead of surfacing the raw constraint name.
 *   * Cycle detection (A depends on B, B depends on A) is
 *     intentionally NOT enforced — cycles will just render as
 *     violations on both sides, which is a valid signal to the PM.
 *
 * Audit trail: every create / patch / delete lands as `edit` with
 * `field = "dependency:<id>"`. Every field is patchable (lane
 * bindings, upstream project, note) so the detail-panel edit form
 * can support in-place changes without forcing a delete + recreate
 * round-trip. Same validation as create is applied to any bindings
 * that actually change.
 */
export const projectDependenciesRouter = Router({ mergeParams: true });

type Params = { id: string; depId?: string };

async function assertProjectInGroup(projectId: string, groupId: string) {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND group_id = $2`,
    [projectId, groupId],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
}

async function assertLaneEligible(laneId: string, groupId: string): Promise<SwimLaneRow> {
  const { rows } = await query<SwimLaneRow>(
    `SELECT * FROM swim_lanes WHERE id = $1 AND group_id = $2`,
    [laneId, groupId],
  );
  const lane = rows[0];
  if (!lane) throw new HttpError(400, "swim_lane does not belong to the current group");
  if (!lane.phase_date_key) {
    throw new HttpError(400,
      `swim lane "${lane.name}" has no phase date bound. Ask an admin to set a phase_date_key in Admin → Swim lanes before using it in a dependency.`);
  }
  return lane;
}

projectDependenciesRouter.get("/", async (req, res) => {
  const projectId = String((req.params as Params).id);
  await assertProjectInGroup(projectId, req.groupId!);
  const { rows } = await query<ProjectDependencyRow>(
    `SELECT id, project_id, project_swim_lane_id,
            depends_on_project_id, depends_on_swim_lane_id,
            note, created_by, created_at, updated_at
       FROM project_dependencies
      WHERE project_id = $1
      ORDER BY created_at ASC`,
    [projectId],
  );
  res.json(rows);
});

const createSchema = z.object({
  project_swim_lane_id: z.string().uuid(),
  depends_on_project_id: z.string().uuid(),
  depends_on_swim_lane_id: z.string().uuid(),
  note: z.string().max(500).optional(),
});

projectDependenciesRouter.post("/", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;

  if (projectId === body.depends_on_project_id) {
    throw new HttpError(400, "a project can't depend on itself");
  }

  // All four references must live in the caller's tenant.
  await assertProjectInGroup(projectId, groupId);
  await assertProjectInGroup(body.depends_on_project_id, groupId);
  await assertLaneEligible(body.project_swim_lane_id, groupId);
  await assertLaneEligible(body.depends_on_swim_lane_id, groupId);

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<ProjectDependencyRow>(
      `INSERT INTO project_dependencies
         (project_id, project_swim_lane_id, depends_on_project_id, depends_on_swim_lane_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, project_swim_lane_id,
                 depends_on_project_id, depends_on_swim_lane_id,
                 note, created_by, created_at, updated_at`,
      [projectId, body.project_swim_lane_id, body.depends_on_project_id, body.depends_on_swim_lane_id, body.note ?? "", req.user!.id],
    );
    const created = rows[0]!;
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `dependency:${created.id}`,
      from: null,
      to: {
        project_swim_lane_id: created.project_swim_lane_id,
        depends_on_project_id: created.depends_on_project_id,
        depends_on_swim_lane_id: created.depends_on_swim_lane_id,
        note: created.note,
      },
    });
    return created;
  });
  res.status(201).json(result);
});

// All four "shape" fields are optional so callers can PATCH just
// the note, just one lane, or all of them at once. Anything omitted
// is left untouched.
const patchSchema = z.object({
  project_swim_lane_id: z.string().uuid().optional(),
  depends_on_project_id: z.string().uuid().optional(),
  depends_on_swim_lane_id: z.string().uuid().optional(),
  note: z.string().max(500).optional(),
});

projectDependenciesRouter.patch("/:depId", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const depId = String((req.params as Params).depId);
  const body = patchSchema.parse(req.body);
  const groupId = req.groupId!;
  await assertProjectInGroup(projectId, groupId);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<ProjectDependencyRow>(
      `SELECT id, project_id, project_swim_lane_id,
              depends_on_project_id, depends_on_swim_lane_id,
              note, created_by, created_at, updated_at
         FROM project_dependencies
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [depId, projectId],
    );
    const before = existing[0];
    if (!before) throw new HttpError(404, "dependency not found");

    // Resolve effective values (body override or existing).
    const nextThisLane = body.project_swim_lane_id ?? before.project_swim_lane_id;
    const nextOtherProj = body.depends_on_project_id ?? before.depends_on_project_id;
    const nextOtherLane = body.depends_on_swim_lane_id ?? before.depends_on_swim_lane_id;
    const nextNote = body.note ?? before.note;

    // Re-run the same validation as create for any binding that
    // changed. Skipping the check when nothing changed keeps PATCHes
    // that only touch the note fast.
    if (nextOtherProj === projectId) {
      throw new HttpError(400, "a project can't depend on itself");
    }
    if (body.project_swim_lane_id && body.project_swim_lane_id !== before.project_swim_lane_id) {
      await assertLaneEligible(nextThisLane, groupId);
    }
    if (body.depends_on_project_id && body.depends_on_project_id !== before.depends_on_project_id) {
      await assertProjectInGroup(nextOtherProj, groupId);
    }
    if (body.depends_on_swim_lane_id && body.depends_on_swim_lane_id !== before.depends_on_swim_lane_id) {
      await assertLaneEligible(nextOtherLane, groupId);
    }

    const unchanged =
      nextThisLane === before.project_swim_lane_id &&
      nextOtherProj === before.depends_on_project_id &&
      nextOtherLane === before.depends_on_swim_lane_id &&
      nextNote === before.note;
    if (unchanged) return before;

    const { rows } = await client.query<ProjectDependencyRow>(
      `UPDATE project_dependencies
          SET project_swim_lane_id = $1,
              depends_on_project_id = $2,
              depends_on_swim_lane_id = $3,
              note = $4,
              updated_at = NOW()
        WHERE id = $5
        RETURNING id, project_id, project_swim_lane_id,
                  depends_on_project_id, depends_on_swim_lane_id,
                  note, created_by, created_at, updated_at`,
      [nextThisLane, nextOtherProj, nextOtherLane, nextNote, depId],
    );
    const after = rows[0]!;
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `dependency:${after.id}`,
      from: {
        project_swim_lane_id: before.project_swim_lane_id,
        depends_on_project_id: before.depends_on_project_id,
        depends_on_swim_lane_id: before.depends_on_swim_lane_id,
        note: before.note,
      },
      to: {
        project_swim_lane_id: after.project_swim_lane_id,
        depends_on_project_id: after.depends_on_project_id,
        depends_on_swim_lane_id: after.depends_on_swim_lane_id,
        note: after.note,
      },
    });
    return after;
  });
  res.json(result);
});

projectDependenciesRouter.delete("/:depId", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const depId = String((req.params as Params).depId);
  await assertProjectInGroup(projectId, req.groupId!);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<ProjectDependencyRow>(
      `SELECT id, project_id, project_swim_lane_id,
              depends_on_project_id, depends_on_swim_lane_id, note
         FROM project_dependencies
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [depId, projectId],
    );
    const before = existing[0];
    if (!before) throw new HttpError(404, "dependency not found");

    await client.query(`DELETE FROM project_dependencies WHERE id = $1`, [depId]);
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `dependency:${before.id}`,
      from: {
        project_swim_lane_id: before.project_swim_lane_id,
        depends_on_project_id: before.depends_on_project_id,
        depends_on_swim_lane_id: before.depends_on_swim_lane_id,
        note: before.note,
      },
      to: null,
    });
    return { deleted: depId };
  });
  res.json(result);
});
