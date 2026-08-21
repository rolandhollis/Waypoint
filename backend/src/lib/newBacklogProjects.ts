import { addDays } from "date-fns";
import { query } from "../db/pool.js";

/**
 * Epics created between the previous status-report digest send and
 * (for a past week) this week's digest send, or now / end-of-week if
 * this week's digest has not gone out yet. Powers the "New projects
 * identified for backlog" section on the Status Report page and
 * digest email.
 *
 * Cutoffs come from `notification_log` (`kind = status_report_digest`,
 * successful rows only). If no prior digest exists, we fall back to
 * seven days before the report week's Monday so the section still
 * has a sensible window on a brand-new workspace.
 */
export type NewBacklogProject = {
  project_id: string;
  project_title: string;
  created_at: string;
  owner_name: string | null;
  swim_lane_name: string | null;
  team_names: string[];
};

export type NewBacklogWindow = {
  since: string;
  until: string;
  projects: NewBacklogProject[];
};

/** True when `createdAt` falls in the same window as new-backlog items. */
export function isNewSinceDigest(
  createdAt: string | Date | null | undefined,
  sinceIso: string,
  untilIso: string,
): boolean {
  if (createdAt == null) return false;
  const t =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
  if (!Number.isFinite(t)) return false;
  const since = Date.parse(sinceIso);
  const until = Date.parse(untilIso);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return false;
  return t > since && t <= until;
}

export async function loadNewBacklogSinceLastDigest(
  groupId: string,
  weekOf: Date,
): Promise<NewBacklogWindow> {
  const weekIso = weekOf.toISOString().slice(0, 10);

  const { rows: boundRows } = await query<{
    since_at: Date | null;
    until_at: Date | null;
  }>(
    `SELECT
       (
         SELECT MAX(sent_at)
           FROM notification_log
          WHERE kind = 'status_report_digest'
            AND group_id = $1
            AND provider_message_id IS NOT NULL
            AND week_of < $2::date
       ) AS since_at,
       (
         SELECT MIN(sent_at)
           FROM notification_log
          WHERE kind = 'status_report_digest'
            AND group_id = $1
            AND provider_message_id IS NOT NULL
            AND week_of = $2::date
       ) AS until_at`,
    [groupId, weekIso],
  );

  const sinceAt =
    boundRows[0]?.since_at ??
    new Date(weekOf.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = addDays(weekOf, 7);
  const now = new Date();
  // Prefer the recorded digest send for this week. Otherwise clamp to
  // the earlier of "end of week" and "now" so a past week without a
  // digest doesn't pull in later creates, and the current week still
  // includes everything up to this moment.
  const untilAt =
    boundRows[0]?.until_at ?? (weekEnd.getTime() < now.getTime() ? weekEnd : now);

  const { rows } = await query<{
    project_id: string;
    project_title: string;
    created_at: Date;
    owner_name: string | null;
    swim_lane_name: string | null;
    team_names: string[];
  }>(
    `SELECT
        p.id AS project_id,
        p.title AS project_title,
        p.created_at,
        u.name AS owner_name,
        sl.name AS swim_lane_name,
        COALESCE(
          (SELECT array_agg(t.name ORDER BY pt.position ASC)
             FROM project_teams pt
             JOIN teams t ON t.id = pt.team_id
            WHERE pt.project_id = p.id),
          ARRAY[]::TEXT[]
        ) AS team_names
       FROM projects p
       LEFT JOIN users u ON u.id = p.owner_id
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
      WHERE p.group_id = $1
        AND p.deleted_at IS NULL
        AND p.type = 'epic'
        AND p.created_at > $2
        AND p.created_at <= $3
      ORDER BY p.created_at ASC, p.title ASC`,
    [groupId, sinceAt, untilAt],
  );

  return {
    since: sinceAt.toISOString(),
    until: untilAt.toISOString(),
    projects: rows.map((r) => ({
      project_id: r.project_id,
      project_title: r.project_title,
      created_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
      owner_name: r.owner_name,
      swim_lane_name: r.swim_lane_name,
      team_names: r.team_names ?? [],
    })),
  };
}
