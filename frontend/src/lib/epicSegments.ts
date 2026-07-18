import { computePhases, type ProjectPhases } from "./phaseCompute";
import type { Project } from "./types";

/**
 * Aggregated-phase timeline for an epic bar on the roadmap. Instead of
 * rendering the epic's OWN discovery / dev / opt segments, we roll up
 * its descendants: for each day the epic covers, we ask "what phase
 * are the currently-running subtasks in?" and paint that day
 * accordingly.
 *
 *   * single phase (every active subtask in `discovery`, `development`,
 *     etc.) → paint that day in the phase's normal style
 *   * multiple phases active → paint with a distinctive dot pattern so
 *     PMs can see at a glance that the epic covers overlapping phases
 *   * no subtasks active → skip; the epic bar goes dark for that gap
 *
 * The five phase kinds map 1:1 to `ProjectPhases`:
 *   discovery, awaitingDev, development, awaitingOptimization, optimization
 * `mixed` is added for the multi-phase case.
 */

export type SubtaskPhaseKind =
  | "discovery"
  | "awaitingDev"
  | "development"
  | "awaitingOptimization"
  | "optimization";

export type EpicSubtaskSegment = {
  start: Date;
  end: Date;
  kind: SubtaskPhaseKind | "mixed";
};

/**
 * Which phase (if any) is the subtask in on `day`? Uses half-open
 * intervals [start, end) — the same convention `computePhases`
 * expresses (target_date is the last day of discovery AND the first
 * day of awaiting-dev, etc.). Returns null when the day falls outside
 * every phase (subtask isn't running yet or has finished).
 */
function phaseAt(phases: ProjectPhases, day: Date): SubtaskPhaseKind | null {
  if (!phases.scheduled) return null;
  const t = day.getTime();
  const inRange = (seg: { start: Date; end: Date } | null) =>
    !!seg && t >= seg.start.getTime() && t < seg.end.getTime();
  if (inRange(phases.discovery)) return "discovery";
  if (inRange(phases.awaitingDev)) return "awaitingDev";
  if (inRange(phases.development)) return "development";
  if (inRange(phases.awaitingOptimization)) return "awaitingOptimization";
  if (inRange(phases.optimization)) return "optimization";
  return null;
}

/**
 * Build the aggregated segment list for an epic. Pass ALL descendants
 * (subtasks, grand-subtasks, …) — the roll-up covers the whole tree
 * because a PM viewing an epic wants to see everything beneath it,
 * not just the direct children.
 *
 * Returns null when either:
 *   * the epic itself isn't fully scheduled (nothing to bracket the
 *     bar with), or
 *   * no descendant is fully scheduled (no roll-up to compute)
 * in which case callers should fall back to the epic's own per-phase
 * bar rendering.
 *
 * Algorithm: build a boundary set at every phase transition of every
 * subtask (plus the epic's own bookends), then walk pairs. Between
 * two adjacent boundaries no subtask's phase can change, so we sample
 * the midpoint of the window to classify. Adjacent segments with the
 * same kind are merged so consecutive runs render as a single rect.
 */
export function computeEpicSubtaskSegments(
  epic: Project,
  descendants: Project[],
): EpicSubtaskSegment[] | null {
  const epicPhases = computePhases(epic);
  if (!epicPhases.scheduled) return null;
  const subs = descendants
    .map((p) => computePhases(p))
    .filter((ph): ph is ProjectPhases => ph.scheduled);
  if (!subs.length) return null;

  // `firstStart`/`overallEnd` are always non-null when scheduled=true
  // — a plottable phase exists somewhere in the project. Using them
  // (not `discovery.start`) means an epic whose Discovery is null
  // still gets bracketed correctly by its earliest-existing phase.
  const epicStart = epicPhases.firstStart!.getTime();
  const epicEnd = epicPhases.overallEnd!.getTime();

  const boundarySet = new Set<number>([epicStart, epicEnd]);
  for (const ph of subs) {
    for (const seg of [
      ph.discovery,
      ph.awaitingDev,
      ph.development,
      ph.awaitingOptimization,
      ph.optimization,
    ]) {
      if (!seg) continue;
      boundarySet.add(seg.start.getTime());
      boundarySet.add(seg.end.getTime());
    }
  }
  const boundaries = [...boundarySet]
    .filter((t) => t >= epicStart && t <= epicEnd)
    .sort((a, b) => a - b);

  const out: EpicSubtaskSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startT = boundaries[i]!;
    const endT = boundaries[i + 1]!;
    if (startT === endT) continue;
    // Midpoint sample is safe because boundaries include every subtask
    // transition, so no subtask changes phase inside (startT, endT).
    const mid = new Date((startT + endT) / 2);
    const active = new Set<SubtaskPhaseKind>();
    for (const ph of subs) {
      const k = phaseAt(ph, mid);
      if (k) active.add(k);
    }
    if (active.size === 0) continue;
    const kind: SubtaskPhaseKind | "mixed" =
      active.size === 1 ? [...active][0]! : "mixed";
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.end.getTime() === startT) {
      last.end = new Date(endT);
    } else {
      out.push({ start: new Date(startT), end: new Date(endT), kind });
    }
  }
  return out.length ? out : null;
}
