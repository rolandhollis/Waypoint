import type { PhaseDateKey, Project, ProjectDeadline, SwimLane } from "./types";

/**
 * A deadline plus its computed status against the project's
 * current phase date. `phaseDate` is the raw project date used
 * for comparison — null when the lane has no phase_date_key or
 * the project hasn't scheduled that phase yet.
 *
 * `severity`:
 *   * "violated" — phase date IS set and is strictly AFTER the
 *     deadline. The clear-cut miss case; surfaces as a red badge.
 *   * "ok" — everything else, including deadlines whose phase
 *     hasn't been scheduled yet. Product decision: unscheduled
 *     phases are the PM's problem to notice via other UI (empty
 *     dates on the item, no roadmap bar), not something a
 *     deadline warning should hijack. Only actual violations of a
 *     promised date fire the alert.
 */
export type DeadlineStatus = {
  deadline: ProjectDeadline;
  lane: SwimLane | null;
  phaseKey: PhaseDateKey | null;
  phaseDate: string | null;
  severity: "ok" | "violated";
};

/**
 * Compute a status row for each deadline on the project. Only
 * flags an actual miss (phase date strictly past the deadline);
 * unbound lanes, missing phase dates, and future deadlines all
 * stay "ok".
 */
export function computeDeadlineStatuses(
  project: Project,
  lanesById: Map<string, SwimLane>,
): DeadlineStatus[] {
  return (project.deadlines ?? []).map((deadline) => {
    const lane = lanesById.get(deadline.swim_lane_id) ?? null;
    const phaseKey = lane?.phase_date_key ?? null;
    const phaseDate = phaseKey
      ? ((project as unknown as Record<string, string | null>)[phaseKey] ?? null)
      : null;

    let severity: DeadlineStatus["severity"] = "ok";
    // Both are YYYY-MM-DD; string compare is date compare.
    if (phaseDate && phaseDate > deadline.deadline_date) severity = "violated";
    return { deadline, lane, phaseKey, phaseDate, severity };
  });
}

/** Convenience: the subset of statuses that are currently a miss. */
export function violatedDeadlines(statuses: DeadlineStatus[]): DeadlineStatus[] {
  return statuses.filter((s) => s.severity !== "ok");
}
