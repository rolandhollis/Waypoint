import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { loadGroupWeeklyStatusSchedule } from "../lib/groupConstants.js";
import {
  parseSubtaskStatusUpdates,
  parseSubtaskStatusUpdatesForForm,
  type SubtaskStatusUpdateEntry,
} from "../lib/subtaskStatusUpdates.js";
import { dueAtForWeek, weekOfMonday } from "../lib/time.js";
import { weekOfMondayForSchedule } from "../lib/weeklyStatusSchedule.js";
import { compareSwimLaneReportOrder } from "../lib/statusReportOrder.js";
import { addDays } from "date-fns";
import type { WeeklyStatusUpdateRow } from "../types.js";

export const statusUpdatesRouter = Router();

/**
 * Eligibility — epics only (subtasks roll into the parent epic update).
 * A project is eligible for `week_of` if EITHER:
 *   (a) it currently sits in a lane flagged `requires_weekly_status`, or
 *   (b) at any point during the week it moved into a lane flagged that way,
 * …AND its *current* lane is not the backlog / default-new landing lane.
 * Backlog is pre-discovery: cards there should never prompt for a
 * weekly status update, even if the lane flag was toggled on by mistake.
 * (Frontend mirror: `frontend/src/lib/statusEligibility.ts`.)
 */
export async function eligibleProjects(
  weekOf: Date,
  groupId: string,
): Promise<Array<{ project_id: string; owner_id: string | null }>> {
  const weekStart = weekOf.toISOString();
  const weekEnd = addDays(weekOf, 7).toISOString();
  const { rows } = await query<{ project_id: string; owner_id: string | null }>(
    `
    SELECT DISTINCT p.id AS project_id, p.owner_id AS owner_id
      FROM projects p
      LEFT JOIN swim_lanes cur ON cur.id = p.swim_lane_id
      LEFT JOIN status_history h ON h.project_id = p.id
        AND h."timestamp" >= $1 AND h."timestamp" < $2
      LEFT JOIN swim_lanes to_lane ON to_lane.id = h.to_swim_lane_id
     WHERE p.deleted_at IS NULL
       AND p.group_id = $3
       AND p.type = 'epic'
       AND COALESCE(cur.is_default_new, FALSE) = FALSE
       AND lower(trim(COALESCE(cur.name, ''))) <> 'backlog'
       AND (
             cur.requires_weekly_status = TRUE
          OR to_lane.requires_weekly_status = TRUE
       )
    `,
    [weekStart, weekEnd, groupId],
  );
  return rows;
}

function parseDetailedUpdate(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && "text" in b && typeof (b as { text: string }).text === "string") {
        return (b as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean);
}

function mapWeeklyStatusRow(row: Record<string, unknown>): WeeklyStatusUpdateRow {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    submitted_by_user_id: row.submitted_by_user_id ? String(row.submitted_by_user_id) : null,
    original_submitted_by_user_id: row.original_submitted_by_user_id
      ? String(row.original_submitted_by_user_id)
      : null,
    week_of:
      typeof row.week_of === "string"
        ? row.week_of.slice(0, 10)
        : (row.week_of as Date).toISOString().slice(0, 10),
    health_flag: row.health_flag as WeeklyStatusUpdateRow["health_flag"],
    executive_summary: String(row.executive_summary ?? ""),
    detailed_update: parseDetailedUpdate(row.detailed_update),
    subtask_updates: parseSubtaskStatusUpdatesForForm(row.subtask_updates),
    completed: Boolean(row.completed),
    due_at: row.due_at as Date,
    submitted_at: (row.submitted_at as Date | null) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

statusUpdatesRouter.get("/pending", async (req, res) => {
  const userId = req.query.user_id === "me" ? req.user!.id : String(req.query.user_id ?? req.user!.id);
  const schedule = await loadGroupWeeklyStatusSchedule(req.groupId!);
  const week = weekOfMondayForSchedule(new Date(), schedule);
  const eligible = await eligibleProjects(week, req.groupId!);
  const myEligible = eligible.filter((e) => e.owner_id === userId);

  const projectIds = myEligible.map((e) => e.project_id);
  if (!projectIds.length) {
    res.json({
      week_of: week.toISOString().slice(0, 10),
      due_at: dueAtForWeek(week, schedule).toISOString(),
      pending: [],
    });
    return;
  }
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM weekly_status_updates
       WHERE week_of = $1::date AND project_id = ANY($2::uuid[])`,
    [week.toISOString().slice(0, 10), projectIds],
  );
  const byPid = new Map(rows.map((r) => [String(r.project_id), mapWeeklyStatusRow(r)]));

  const pending = myEligible
    .filter((e) => !byPid.get(e.project_id)?.completed)
    .map((e) => ({
      project_id: e.project_id,
      existing_update: byPid.get(e.project_id) ?? null,
    }));

  res.json({
    week_of: week.toISOString().slice(0, 10),
    due_at: dueAtForWeek(week, schedule).toISOString(),
    pending,
  });
});

/** GET /status-updates/report?week_of=YYYY-MM-DD → all eligible projects + their status update for the given week. */
statusUpdatesRouter.get("/report", async (req, res) => {
  const weekParam = req.query.week_of ? String(req.query.week_of) : null;
  const schedule = await loadGroupWeeklyStatusSchedule(req.groupId!);
  const week = weekParam
    ? weekOfMonday(new Date(`${weekParam}T12:00:00Z`), schedule.timezone)
    : weekOfMondayForSchedule(new Date(), schedule);
  const eligible = await eligibleProjects(week, req.groupId!);
  const projectIds = eligible.map((e) => e.project_id);

  const dueAt = dueAtForWeek(week, schedule);
  const weekIso = week.toISOString().slice(0, 10);

  if (!projectIds.length) {
    res.json({ week_of: weekIso, due_at: dueAt.toISOString(), rows: [] });
    return;
  }

  const { rows } = await query<
    Record<string, unknown> & {
      p_project_id: string;
      project_title: string;
      owner_id: string | null;
      owner_name: string | null;
      owner_email: string | null;
      team_names: string[];
      swim_lane_id: string | null;
      swim_lane_name: string | null;
      swim_lane_order: number | null;
      project_position: number;
    }
  >(
    `
    SELECT wsu.*,
           p.id       AS p_project_id,
           p.title    AS project_title,
           p.position AS project_position,
           p.owner_id AS owner_id,
           u.name     AS owner_name,
           u.email    AS owner_email,
           COALESCE(
             (SELECT array_agg(t.name ORDER BY pt.position ASC)
                FROM project_teams pt
                JOIN teams t ON t.id = pt.team_id
               WHERE pt.project_id = p.id),
             ARRAY[]::TEXT[]
           ) AS team_names,
           sl.id      AS swim_lane_id,
           sl.name    AS swim_lane_name,
           sl."order" AS swim_lane_order
      FROM projects p
      LEFT JOIN weekly_status_updates wsu
        ON wsu.project_id = p.id AND wsu.week_of = $1::date
      LEFT JOIN users u ON u.id = p.owner_id
      LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
     WHERE p.id = ANY($2::uuid[])
    `,
    [weekIso, projectIds],
  );

  const shaped = rows
    .map((r) => {
      const mapped = r.id ? mapWeeklyStatusRow(r) : null;
      return {
        ...(mapped ?? {
          id: null,
          project_id: r.p_project_id,
          submitted_by_user_id: null,
          original_submitted_by_user_id: null,
          week_of: weekIso,
          health_flag: "white" as const,
          executive_summary: "",
          detailed_update: [],
          subtask_updates: [],
          completed: false,
          due_at: dueAt,
          submitted_at: null,
          created_at: null,
          updated_at: null,
        }),
        project_id: mapped?.project_id ?? r.p_project_id,
        project_title: r.project_title,
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        owner_email: r.owner_email,
        team_names: r.team_names,
        swim_lane_id: r.swim_lane_id,
        swim_lane_name: r.swim_lane_name,
        swim_lane_order: r.swim_lane_order,
        project_position: r.project_position,
        health_flag: mapped?.health_flag ?? "white",
      };
    })
    .sort((a, b) => {
      const laneCmp = compareSwimLaneReportOrder(
        a.swim_lane_order,
        b.swim_lane_order,
        a.swim_lane_name ?? "",
        b.swim_lane_name ?? "",
      );
      if (laneCmp !== 0) return laneCmp;
      if (a.project_position !== b.project_position) return a.project_position - b.project_position;
      return a.project_title.localeCompare(b.project_title);
    });

  res.json({ week_of: weekIso, due_at: dueAt.toISOString(), rows: shaped });
});

/** GET /projects/:id/status-updates — mounted under the projects namespace below. */
export const projectStatusUpdatesRouter = Router({ mergeParams: true });

type ProjectIdParam = { id: string };

async function assertEpicProject(projectId: string, groupId: string): Promise<void> {
  const { rows } = await query<{ type: string }>(
    `SELECT type FROM projects WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
    [projectId, groupId],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  if (rows[0].type !== "epic") {
    throw new HttpError(400, "only epics require weekly status updates");
  }
}

async function validateSubtaskUpdates(
  epicId: string,
  groupId: string,
  entries: SubtaskStatusUpdateEntry[],
): Promise<void> {
  if (!entries.length) return;
  const ids = [...new Set(entries.map((e) => e.project_id))];

  const { rows } = await query<{ id: string; parent_id: string | null; type: string }>(
    `SELECT id, parent_id, type
       FROM projects
      WHERE group_id = $1 AND deleted_at IS NULL`,
    [groupId],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  function isDescendantSubtaskOfEpic(subtaskId: string): boolean {
    let cursor = byId.get(subtaskId);
    if (!cursor || cursor.type !== "subtask") return false;
    let hops = 0;
    while (cursor?.parent_id && hops < 32) {
      if (cursor.parent_id === epicId) return true;
      cursor = byId.get(cursor.parent_id);
      hops += 1;
    }
    return false;
  }

  for (const id of ids) {
    if (!isDescendantSubtaskOfEpic(id)) {
      throw new HttpError(400, "subtask_updates must reference subtasks under this epic");
    }
  }
}

projectStatusUpdatesRouter.get<ProjectIdParam>("/", async (req, res) => {
  const { rows: proj } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
    [req.params.id, req.groupId!],
  );
  if (!proj[0]) throw new HttpError(404, "project not found");

  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM weekly_status_updates WHERE project_id = $1 ORDER BY week_of DESC`,
    [req.params.id],
  );
  res.json(rows.map(mapWeeklyStatusRow));
});

const subtaskUpdateEntrySchema = z.object({
  project_id: z.string().uuid(),
  update_text: z.string().max(2000),
});

const upsertSchema = z.object({
  week_of: z.string().optional(),
  health_flag: z.enum(["white", "green", "yellow", "red"]).optional(),
  executive_summary: z.string().max(2000).optional(),
  detailed_update: z.array(z.string().max(1000)).min(0).max(10).optional(),
  subtask_updates: z.array(subtaskUpdateEntrySchema).max(20).optional(),
  completed: z.boolean().optional(),
});

projectStatusUpdatesRouter.post<ProjectIdParam>("/", requireWrite, async (req, res) => {
  await assertEpicProject(req.params.id, req.groupId!);
  const body = upsertSchema.parse(req.body);
  const schedule = await loadGroupWeeklyStatusSchedule(req.groupId!);
  const week = body.week_of
    ? weekOfMonday(new Date(`${body.week_of}T12:00:00Z`), schedule.timezone)
    : weekOfMondayForSchedule(new Date(), schedule);
  const weekIso = week.toISOString().slice(0, 10);
  const due = dueAtForWeek(week, schedule);

  if (body.completed) {
    if (!body.health_flag || body.health_flag === "white") {
      throw new HttpError(400, "health_flag must be green/yellow/red when completing");
    }
  }

  const subtaskUpdates = body.subtask_updates ?? undefined;
  if (subtaskUpdates) {
    await validateSubtaskUpdates(req.params.id, req.groupId!, subtaskUpdates);
  }

  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM weekly_status_updates WHERE project_id = $1 AND week_of = $2 FOR UPDATE`,
      [req.params.id, weekIso],
    );
    const existing = existingRows[0];
    const nowIso = new Date().toISOString();
    const subtaskJson = subtaskUpdates ? JSON.stringify(subtaskUpdates) : null;

    if (!existing) {
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO weekly_status_updates
           (project_id, submitted_by_user_id, original_submitted_by_user_id, week_of, health_flag,
            executive_summary, detailed_update, subtask_updates, completed, due_at, submitted_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING *`,
        [
          req.params.id,
          req.user!.id,
          weekIso,
          body.health_flag ?? "white",
          body.executive_summary ?? "",
          JSON.stringify(body.detailed_update ?? []),
          subtaskJson ?? "[]",
          !!body.completed,
          due.toISOString(),
          body.completed ? nowIso : null,
        ],
      );
      return mapWeeklyStatusRow(rows[0]!);
    }

    const originalSubmitter =
      existing.original_submitted_by_user_id ?? existing.submitted_by_user_id ?? req.user!.id;
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE weekly_status_updates
          SET submitted_by_user_id = $1,
              original_submitted_by_user_id = $2,
              health_flag = COALESCE($3, health_flag),
              executive_summary = COALESCE($4, executive_summary),
              detailed_update = COALESCE($5::jsonb, detailed_update),
              subtask_updates = COALESCE($6::jsonb, subtask_updates),
              completed = COALESCE($7, completed),
              submitted_at = CASE WHEN $7 IS TRUE AND submitted_at IS NULL THEN $8 ELSE submitted_at END,
              updated_at = NOW()
        WHERE id = $9 RETURNING *`,
      [
        req.user!.id,
        originalSubmitter,
        body.health_flag ?? null,
        body.executive_summary ?? null,
        body.detailed_update ? JSON.stringify(body.detailed_update) : null,
        subtaskJson,
        body.completed ?? null,
        nowIso,
        existing.id,
      ],
    );
    return mapWeeklyStatusRow(rows[0]!);
  });

  res.status(201).json(result);
});
