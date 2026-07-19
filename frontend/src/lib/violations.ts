import { computeDeadlineStatuses, type DeadlineStatus } from "./deadlines";
import { computeDependencyStatuses, type DependencyStatus } from "./dependencies";
import type { Project, SwimLane } from "./types";

/**
 * Roll-up of a single project's currently-violated deadlines and
 * dependencies. The two upstream libraries (`deadlines.ts` and
 * `dependencies.ts`) already know how to compute per-item status;
 * this module composes them into "the set of things that are
 * broken RIGHT NOW on this project" plus a diff helper so the
 * EZEstimates view can decide whether a mutation made things
 * worse.
 *
 * Only the "violated" subset is retained — on-track statuses are
 * useful to the roadmap tooltip but noise for our
 * chip/toast surface, which only shows problems.
 */
export type ViolationSet = {
  deadlines: DeadlineStatus[];
  dependencies: DependencyStatus[];
};

export function computeProjectViolations(
  project: Project,
  lanesById: Map<string, SwimLane>,
  projectsById: Map<string, Project>,
): ViolationSet {
  const deadlineStatuses = computeDeadlineStatuses(project, lanesById);
  const depStatuses = computeDependencyStatuses(project, lanesById, projectsById);
  return {
    deadlines: deadlineStatuses.filter((s) => s.severity === "violated"),
    dependencies: depStatuses.filter((s) => s.severity === "violated"),
  };
}

export function hasAnyViolation(v: ViolationSet): boolean {
  return v.deadlines.length > 0 || v.dependencies.length > 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many days past the deadline this phase currently lands.
 * Always non-negative (the caller has already filtered to the
 * violated subset, so `phaseDate > deadline_date`). Used as the
 * "severity depth" the diff compares before-vs-after.
 */
function deadlineOverrunDays(s: DeadlineStatus): number {
  if (!s.phaseDate) return 0;
  const dl = new Date(`${s.deadline.deadline_date}T00:00:00`).getTime();
  const pd = new Date(`${s.phaseDate}T00:00:00`).getTime();
  return Math.max(0, Math.round((pd - dl) / MS_PER_DAY));
}

/**
 * How many days THIS project's phase start precedes the upstream
 * project's phase end. Always non-negative because the caller has
 * already filtered to violated statuses (`thisStart < otherEnd`).
 */
function dependencyOverrunDays(s: DependencyStatus): number {
  if (!s.thisStart || !s.otherEnd) return 0;
  return Math.max(0, Math.round((s.otherEnd.getTime() - s.thisStart.getTime()) / MS_PER_DAY));
}

export type ViolationDelta = {
  /**
   * Deadlines that are newly violated OR whose overrun grew
   * relative to `before`. Same shape as ViolationSet.deadlines so
   * the toast renderer can share the tooltip formatter.
   */
  worsenedDeadlines: DeadlineStatus[];
  /** Same rules for dependencies. */
  worsenedDependencies: DependencyStatus[];
};

/**
 * Compare a project's before/after violation sets and return only
 * the entries that are either NEW (absent in `before`) or WORSER
 * (present in both but the overrun day count grew).
 *
 * Deliberately excludes equivalent or improved entries — the
 * product decision is that a mutation which merely maintains a
 * pre-existing violation should NOT re-nag the user, and a
 * mutation which improves things (smaller overrun, or fully
 * resolved) is the happy path.
 */
export function diffViolations(before: ViolationSet, after: ViolationSet): ViolationDelta {
  const beforeDeadlineById = new Map<string, number>();
  for (const s of before.deadlines) beforeDeadlineById.set(s.deadline.id, deadlineOverrunDays(s));
  const beforeDepById = new Map<string, number>();
  for (const s of before.dependencies) beforeDepById.set(s.dep.id, dependencyOverrunDays(s));

  const worsenedDeadlines = after.deadlines.filter((s) => {
    const prev = beforeDeadlineById.get(s.deadline.id);
    if (prev === undefined) return true;
    return deadlineOverrunDays(s) > prev;
  });
  const worsenedDependencies = after.dependencies.filter((s) => {
    const prev = beforeDepById.get(s.dep.id);
    if (prev === undefined) return true;
    return dependencyOverrunDays(s) > prev;
  });

  return { worsenedDeadlines, worsenedDependencies };
}

export function hasDelta(d: ViolationDelta): boolean {
  return d.worsenedDeadlines.length > 0 || d.worsenedDependencies.length > 0;
}
