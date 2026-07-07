import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { dueAtForWeek, weekOfMonday } from "../lib/time.js";
import { addDays } from "date-fns";
import type { WeeklyStatusUpdateRow } from "../types.js";

export const statusUpdatesRouter = Router();

/**
 * Eligibility query — PRD §5.5 rule.
 * A project is eligible for `week_of` if EITHER:
 *   (a) it currently sits in a lane flagged `requires_weekly_status`, or
 *   (b) at any point during the week it moved into a lane flagged that way.
 * Implementation uses status_history joined against lanes for the week's range,
 * union'd with projects currently sitting in a flagged lane.
 */
async function eligibleProjects(weekOf: Date): Promise<Array<{ project_id: string; owner_id: string | null }>> {
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
       AND (
             cur.requires_weekly_status = TRUE
          OR to_lane.requires_weekly_status = TRUE
       )
    `,
    [weekStart, weekEnd],
  );
  return rows;
}

/** GET /status-updates/pending?user_id=me → this week's incomplete eligible projects for the current user. */
statusUpdatesRouter.get("/pending", async (req, res) => {
  const userId = req.query.user_id === "me" ? req.user!.id : String(req.query.user_id ?? req.user!.id);
  const week = weekOfMonday(new Date());
  const eligible = await eligibleProjects(week);
  const myEligible = eligible.filter((e) => e.owner_id === userId);

  const projectIds = myEligible.map((e) => e.project_id);
  if (!projectIds.length) {
    res.json({ week_of: week.toISOString().slice(0, 10), due_at: dueAtForWeek(week).toISOString(), pending: [] });
    return;
  }
  const { rows: updates } = await query<WeeklyStatusUpdateRow>(
    `SELECT * FROM weekly_status_updates
       WHERE week_of = $1::date AND project_id = ANY($2::uuid[])`,
    [week.toISOString().slice(0, 10), projectIds],
  );
  const byPid = new Map(updates.map((u) => [u.project_id, u]));

  const pending = myEligible
    .filter((e) => !byPid.get(e.project_id)?.completed)
    .map((e) => ({
      project_id: e.project_id,
      existing_update: byPid.get(e.project_id) ?? null,
    }));

  res.json({
    week_of: week.toISOString().slice(0, 10),
    due_at: dueAtForWeek(week).toISOString(),
    pending,
  });
});

/** GET /status-updates/report?week_of=YYYY-MM-DD → all eligible projects + their status update for the given week. */
statusUpdatesRouter.get("/report", async (req, res) => {
  const weekParam = req.query.week_of ? String(req.query.week_of) : null;
  const week = weekParam ? weekOfMonday(new Date(`${weekParam}T12:00:00Z`)) : weekOfMonday(new Date());
  const eligible = await eligibleProjects(week);
  const projectIds = eligible.map((e) => e.project_id);

  if (!projectIds.length) {
    res.json({ week_of: week.toISOString().slice(0, 10), rows: [] });
    return;
  }

  const { rows } = await query<
    WeeklyStatusUpdateRow & {
      project_title: string;
      owner_name: string | null;
      team_names: string[];
      swim_lane_id: string | null;
      swim_lane_name: string | null;
      swim_lane_order: number | null;
      project_position: number;
    }
  >(
    `
    SELECT wsu.*,
           p.title    AS project_title,
           p.position AS project_position,
           u.name     AS owner_name,
           COALESCE(
             (SELECT array_agg(t.name ORDER BY t."order", t.name)
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
    [week.toISOString().slice(0, 10), projectIds],
  );

  // Order primarily by swim lane (matching the Board's left-to-right lane
  // order), then by each project's within-lane position. This lets the
  // client group by swim lane while preserving the exact drag-and-drop
  // ordering users established on the Board.
  const shaped = rows
    .map((r) => ({ ...r, health_flag: r.health_flag ?? "white" }))
    .sort((a, b) => {
      const laneA = a.swim_lane_order ?? Number.MAX_SAFE_INTEGER;
      const laneB = b.swim_lane_order ?? Number.MAX_SAFE_INTEGER;
      if (laneA !== laneB) return laneA - laneB;
      if (a.project_position !== b.project_position) return a.project_position - b.project_position;
      return a.project_title.localeCompare(b.project_title);
    });

  res.json({ week_of: week.toISOString().slice(0, 10), rows: shaped });
});

/** GET /projects/:id/status-updates — mounted under the projects namespace below. */
export const projectStatusUpdatesRouter = Router({ mergeParams: true });

type ProjectIdParam = { id: string };

projectStatusUpdatesRouter.get<ProjectIdParam>("/", async (req, res) => {
  const { rows } = await query<WeeklyStatusUpdateRow>(
    `SELECT * FROM weekly_status_updates WHERE project_id = $1 ORDER BY week_of DESC`,
    [req.params.id],
  );
  res.json(rows);
});

const upsertSchema = z.object({
  week_of: z.string().optional(), // ISO date; defaults to current week
  health_flag: z.enum(["white", "green", "yellow", "red"]).optional(),
  executive_summary: z.string().max(2000).optional(),
  detailed_update: z.array(z.string().max(1000)).min(0).max(10).optional(),
  completed: z.boolean().optional(),
});

projectStatusUpdatesRouter.post<ProjectIdParam>("/", requireWrite, async (req, res) => {
  const body = upsertSchema.parse(req.body);
  const week = body.week_of ? weekOfMonday(new Date(`${body.week_of}T12:00:00Z`)) : weekOfMonday(new Date());
  const weekIso = week.toISOString().slice(0, 10);
  const due = dueAtForWeek(week);

  if (body.completed) {
    if (!body.health_flag || body.health_flag === "white") {
      throw new HttpError(400, "health_flag must be green/yellow/red when completing");
    }
  }

  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<WeeklyStatusUpdateRow>(
      `SELECT * FROM weekly_status_updates WHERE project_id = $1 AND week_of = $2 FOR UPDATE`,
      [req.params.id, weekIso],
    );
    const existing = existingRows[0];
    const nowIso = new Date().toISOString();

    if (!existing) {
      const { rows } = await client.query<WeeklyStatusUpdateRow>(
        `INSERT INTO weekly_status_updates
           (project_id, submitted_by_user_id, original_submitted_by_user_id, week_of, health_flag,
            executive_summary, detailed_update, completed, due_at, submitted_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
        [
          req.params.id,
          req.user!.id,
          weekIso,
          body.health_flag ?? "white",
          body.executive_summary ?? "",
          JSON.stringify(body.detailed_update ?? []),
          !!body.completed,
          due.toISOString(),
          body.completed ? nowIso : null,
        ],
      );
      return rows[0];
    }

    // Preserve original submitter even if an admin overwrites (PRD §9 Q10).
    const originalSubmitter = existing.original_submitted_by_user_id ?? existing.submitted_by_user_id ?? req.user!.id;
    const { rows } = await client.query<WeeklyStatusUpdateRow>(
      `UPDATE weekly_status_updates
          SET submitted_by_user_id = $1,
              original_submitted_by_user_id = $2,
              health_flag = COALESCE($3, health_flag),
              executive_summary = COALESCE($4, executive_summary),
              detailed_update = COALESCE($5::jsonb, detailed_update),
              completed = COALESCE($6, completed),
              submitted_at = CASE WHEN $6 IS TRUE AND submitted_at IS NULL THEN $7 ELSE submitted_at END,
              updated_at = NOW()
        WHERE id = $8 RETURNING *`,
      [
        req.user!.id,
        originalSubmitter,
        body.health_flag ?? null,
        body.executive_summary ?? null,
        body.detailed_update ? JSON.stringify(body.detailed_update) : null,
        body.completed ?? null,
        nowIso,
        existing.id,
      ],
    );
    return rows[0];
  });

  res.status(201).json(result);
});
