import { startOfDay } from "date-fns";
import { computePhases } from "./phaseCompute";
import type { Project } from "./types";

/**
 * Whether a project is currently in flight or not-yet-started.
 * Used to decide default expand/collapse of Roadmap team (and other
 * labeled) group sections — sections with only completed work start
 * collapsed.
 */
export function projectIsActiveOrUpcoming(
  project: Project,
  today: Date = new Date(),
): boolean {
  const phases = computePhases(project);
  if (!phases.scheduled || !phases.firstStart || !phases.overallEnd) {
    return false;
  }
  const t0 = startOfDay(today).getTime();
  const fs = phases.firstStart.getTime();
  const oe = phases.overallEnd.getTime();
  const startsInFuture = fs > t0;
  const inProgress = fs <= t0 && oe >= t0;
  return startsInFuture || inProgress;
}

/** True when the section should be open by default (no user override). */
export function defaultGroupExpanded(
  projectsInGroup: Project[],
  today: Date = new Date(),
): boolean {
  return projectsInGroup.some((p) => projectIsActiveOrUpcoming(p, today));
}

/**
 * Resolve expand state for a labeled Roadmap group.
 * Sparse overrides: `true` force open, `false` force closed, missing
 * → default from project activity.
 */
export function resolveGroupExpanded(
  groupKey: string,
  projectsInGroup: Project[],
  overrides: Record<string, boolean>,
  today: Date = new Date(),
): boolean {
  if (Object.prototype.hasOwnProperty.call(overrides, groupKey)) {
    return overrides[groupKey]!;
  }
  return defaultGroupExpanded(projectsInGroup, today);
}
