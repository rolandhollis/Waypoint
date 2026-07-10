import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { recordAudit } from "./projects.js";
import type { ProjectDeadlineRow, SwimLaneRow } from "../types.js";

/**
 * Mounted at /api/projects/:id/deadlines (mergeParams pulls the
 * project id from the parent route).
 *
 * Behavior:
 *   * Any write requires per-group owner+ role (requireWrite).
 *   * The referenced project + swim lane must both live in the
 *     caller's current tenant; otherwise we 404 to avoid leaking
 *     cross-tenant ids.
 *   * A swim lane without a phase_date_key can't carry a
 *     deadline (the violation calculator would have nothing to
 *     compare against). Reject the create with a friendly 400 so
 *     the UI can surface the fix ("bind a phase date to this
 *     lane in Admin → Swim lanes").
 *   * Unique constraint on (project_id, swim_lane_id) means the
 *     PATCH path is the ONLY way to change a deadline's date /
 *     note; POSTing the same lane again returns 409.
 *   * Audit trail: create / update / delete each land as an
 *     `edit` event with `field = 'deadline:<lane_id>'` — the
 *     detail-panel timeline renders them alongside other edits.
 */
export const projectDeadlinesRouter = Router({ mergeParams: true });

type Params = { id: string; deadlineId?: string };

/**
 * Guard: verify the referenced project belongs to the caller's
 * current tenant. Consistent 404 (not 403) so an id-guessing
 * attacker can't distinguish "your group vs another group's".
 */
async function assertProjectInGroup(projectId: string, groupId: string) {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND group_id = $2`,
    [projectId, groupId],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
}

/**
 * Guard: verify a swim lane belongs to the tenant AND has a
 * phase_date_key so the deadline is enforceable. Returns the
 * hydrated lane so the caller can reference name / phase key in
 * error messages if it wants.
 */
async function assertLaneEligible(laneId: string, groupId: string): Promise<SwimLaneRow> {
  const { rows } = await query<SwimLaneRow>(
    `SELECT * FROM swim_lanes WHERE id = $1 AND group_id = $2`,
    [laneId, groupId],
  );
  const lane = rows[0];
  if (!lane) throw new HttpError(400, "swim_lane_id does not belong to the current group");
  if (!lane.phase_date_key) {
    throw new HttpError(400,
      `swim lane "${lane.name}" has no phase date bound. Ask an admin to set a phase_date_key in Admin → Swim lanes before adding a deadline.`);
  }
  return lane;
}

projectDeadlinesRouter.get("/", async (req, res) => {
  const projectId = String((req.params as Params).id);
  await assertProjectInGroup(projectId, req.groupId!);
  const { rows } = await query<ProjectDeadlineRow>(
    `SELECT id, project_id, swim_lane_id,
            to_char(deadline_date, 'YYYY-MM-DD') AS deadline_date,
            note, created_by, created_at, updated_at
       FROM project_deadlines
      WHERE project_id = $1
      ORDER BY deadline_date ASC, created_at ASC`,
    [projectId],
  );
  res.json(rows);
});

const createSchema = z.object({
  swim_lane_id: z.string().uuid(),
  // Accept plain YYYY-MM-DD; permissive on extra chars because the
  // <input type="date"> in some browsers appends time. Postgres
  // coerces on write.
  deadline_date: z.string().min(8).max(32),
  note: z.string().max(500).optional(),
});

projectDeadlinesRouter.post("/", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const body = createSchema.parse(req.body);
  const groupId = req.groupId!;
  await assertProjectInGroup(projectId, groupId);
  await assertLaneEligible(body.swim_lane_id, groupId);

  const result = await withTransaction(async (client) => {
    // Explicit uniqueness check before the INSERT so we can return
    // a nicer 409 than the raw pg constraint-violation error.
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM project_deadlines WHERE project_id = $1 AND swim_lane_id = $2`,
      [projectId, body.swim_lane_id],
    );
    if (existing[0]) {
      throw new HttpError(409, "this project already has a deadline for that swim lane — update it instead");
    }
    const { rows } = await client.query<ProjectDeadlineRow>(
      `INSERT INTO project_deadlines (project_id, swim_lane_id, deadline_date, note, created_by)
       VALUES ($1, $2, $3::date, $4, $5)
       RETURNING id, project_id, swim_lane_id,
                 to_char(deadline_date, 'YYYY-MM-DD') AS deadline_date,
                 note, created_by, created_at, updated_at`,
      [projectId, body.swim_lane_id, body.deadline_date, body.note ?? "", req.user!.id],
    );
    const created = rows[0]!;
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `deadline:${body.swim_lane_id}`,
      from: null,
      to: { deadline_date: created.deadline_date, note: created.note },
    });
    return created;
  });
  res.status(201).json(result);
});

const patchSchema = z.object({
  deadline_date: z.string().min(8).max(32).optional(),
  note: z.string().max(500).optional(),
});

projectDeadlinesRouter.patch("/:deadlineId", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const deadlineId = String((req.params as Params).deadlineId);
  const body = patchSchema.parse(req.body);
  await assertProjectInGroup(projectId, req.groupId!);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<ProjectDeadlineRow>(
      `SELECT id, project_id, swim_lane_id,
              to_char(deadline_date, 'YYYY-MM-DD') AS deadline_date,
              note, created_by, created_at, updated_at
         FROM project_deadlines
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [deadlineId, projectId],
    );
    const before = existing[0];
    if (!before) throw new HttpError(404, "deadline not found");

    const nextDate = body.deadline_date ?? before.deadline_date;
    const nextNote = body.note ?? before.note;
    if (nextDate === before.deadline_date && nextNote === before.note) {
      return before; // no-op — don't emit an audit event
    }

    const { rows } = await client.query<ProjectDeadlineRow>(
      `UPDATE project_deadlines
          SET deadline_date = $1::date,
              note = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, project_id, swim_lane_id,
                  to_char(deadline_date, 'YYYY-MM-DD') AS deadline_date,
                  note, created_by, created_at, updated_at`,
      [nextDate, nextNote, deadlineId],
    );
    const after = rows[0]!;
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `deadline:${after.swim_lane_id}`,
      from: { deadline_date: before.deadline_date, note: before.note },
      to: { deadline_date: after.deadline_date, note: after.note },
    });
    return after;
  });
  res.json(result);
});

projectDeadlinesRouter.delete("/:deadlineId", requireWrite, async (req, res) => {
  const projectId = String((req.params as Params).id);
  const deadlineId = String((req.params as Params).deadlineId);
  await assertProjectInGroup(projectId, req.groupId!);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query<ProjectDeadlineRow>(
      `SELECT id, project_id, swim_lane_id,
              to_char(deadline_date, 'YYYY-MM-DD') AS deadline_date,
              note
         FROM project_deadlines
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [deadlineId, projectId],
    );
    const before = existing[0];
    if (!before) throw new HttpError(404, "deadline not found");

    await client.query(`DELETE FROM project_deadlines WHERE id = $1`, [deadlineId]);
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "edit",
      field: `deadline:${before.swim_lane_id}`,
      from: { deadline_date: before.deadline_date, note: before.note },
      to: null,
    });
    return { deleted: deadlineId };
  });
  res.json(result);
});
