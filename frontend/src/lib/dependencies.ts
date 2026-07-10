import { computePhases, type ProjectPhases } from "./phaseCompute";
import type { PhaseDateKey, Project, ProjectDependency, SwimLane } from "./types";

/**
 * Every swim lane's `phase_date_key` names a single project date
 * field, but the dependency semantic needs both a "phase START"
 * and "phase END" per lane. We collapse the six phase_date_key
 * values down to one of three phase intervals and read the
 * appropriate boundary off `computePhases`. Lanes with no
 * phase_date_key can't participate in dependencies at all (the
 * server enforces this on create).
 *
 * Mapping (phase_date_key doesn't include `start_date` — lanes
 * can't bind to that field, discovery start is always implicit):
 *   target_date                                    → discovery
 *   dev_start_date, dev_end_date                   → development
 *   optimization_start_date, optimization_end_date → optimization
 */
type PhaseKey = "discovery" | "development" | "optimization";

function phaseKeyForLane(lane: SwimLane | null | undefined): PhaseKey | null {
  const k: PhaseDateKey | null = lane?.phase_date_key ?? null;
  if (!k) return null;
  if (k === "target_date") return "discovery";
  if (k === "dev_start_date" || k === "dev_end_date") return "development";
  return "optimization";
}

function phaseInterval(phases: ProjectPhases, key: PhaseKey): { start: Date; end: Date } | null {
  if (!phases.scheduled) return null;
  if (key === "discovery") return phases.discovery;
  if (key === "development") return phases.development;
  return phases.optimization;
}

/** Start of this lane's phase on this project, if computable. */
export function laneStartOn(project: Project, lane: SwimLane | null): Date | null {
  const key = phaseKeyForLane(lane);
  if (!key) return null;
  return phaseInterval(computePhases(project), key)?.start ?? null;
}

/** End of this lane's phase on this project, if computable. */
export function laneEndOn(project: Project, lane: SwimLane | null): Date | null {
  const key = phaseKeyForLane(lane);
  if (!key) return null;
  return phaseInterval(computePhases(project), key)?.end ?? null;
}

/**
 * A dependency resolved against the current data + its computed
 * status. Callers use the resolved objects to render tooltips /
 * arrows without repeating lookups.
 *
 * `severity`:
 *   * "violated" — both sides scheduled and this project's phase
 *     start falls strictly BEFORE the upstream phase end. Real
 *     miss; renders red.
 *   * "ok" — everything else. Includes "either side unscheduled"
 *     because you can't miss a promise nobody has made yet, matches
 *     the deadline model. Also "upstream project deleted" — the
 *     stale dep is still visible but not treated as a violation.
 */
export type DependencyStatus = {
  dep: ProjectDependency;
  thisLane: SwimLane | null;
  otherProject: Project | null;
  otherLane: SwimLane | null;
  thisStart: Date | null;
  otherEnd: Date | null;
  severity: "ok" | "violated";
};

export function computeDependencyStatuses(
  project: Project,
  lanesById: Map<string, SwimLane>,
  projectsById: Map<string, Project>,
): DependencyStatus[] {
  return (project.dependencies ?? []).map((dep) => {
    const thisLane = lanesById.get(dep.project_swim_lane_id) ?? null;
    const otherProject = projectsById.get(dep.depends_on_project_id) ?? null;
    const otherLane = lanesById.get(dep.depends_on_swim_lane_id) ?? null;
    const thisStart = laneStartOn(project, thisLane);
    const otherEnd = otherProject ? laneEndOn(otherProject, otherLane) : null;
    let severity: DependencyStatus["severity"] = "ok";
    if (thisStart && otherEnd && thisStart.getTime() < otherEnd.getTime()) {
      severity = "violated";
    }
    return { dep, thisLane, otherProject, otherLane, thisStart, otherEnd, severity };
  });
}

/**
 * Grouping helper for the roadmap indicator icon. Returns one
 * entry per phase that has at least one dependency, so we can
 * render one icon per phase segment instead of one-per-dep.
 */
export function groupDependenciesByPhase(
  statuses: DependencyStatus[],
): Map<PhaseKey, DependencyStatus[]> {
  const out = new Map<PhaseKey, DependencyStatus[]>();
  for (const s of statuses) {
    const key = phaseKeyForLane(s.thisLane);
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(s);
    else out.set(key, [s]);
  }
  return out;
}

export type { PhaseKey };
