import type { Project } from "./types";

export type PhaseInterval = { start: Date; end: Date };

export type ProjectPhases = {
  /**
   * True when the project has at least one plottable phase (Discovery,
   * Development, or Post-Dev Optimization). A single filled-in phase
   * — including a post-dev-only project — is enough to land the item
   * on the Roadmap timeline; the phases that were left blank simply
   * don't render.
   *
   * When false the project has no plottable phase and belongs on the
   * Unscheduled list. `firstStart` and `overallEnd` are then null and
   * every per-phase interval is null.
   */
  scheduled: boolean;
  /** Discovery — plottable when both start_date and target_date are set. */
  discovery: PhaseInterval | null;
  /** Gap between discovery end (target_date) and the PM-picked
   * dev_start_date, if any. Only surfaces when BOTH dates are set and
   * dev_start_date is strictly after target_date. */
  awaitingDev: PhaseInterval | null;
  /**
   * Development — plottable when dev_end_date is set AND either
   * dev_start_date (explicit) or target_date (implicit) provides the
   * left anchor. A project with only dev_end_date but no upstream
   * anchor at all leaves this null (there's no start to draw a bar
   * from).
   */
  development: PhaseInterval | null;
  /** Gap between dev_end_date and the PM-picked
   * optimization_start_date. Only surfaces when both are set and
   * optimization_start_date is strictly after dev_end_date. */
  awaitingOptimization: PhaseInterval | null;
  /**
   * Post-Dev Optimization — plottable when optimization_end_date is
   * set AND either optimization_start_date (explicit) or dev_end_date
   * (implicit) provides the left anchor.
   */
  optimization: PhaseInterval | null;
  /**
   * Earliest resolved start across the plotted phases. Non-null iff
   * `scheduled` is true. Used by the Gantt range calculator and the
   * epic-subtask roll-up to bracket the bar.
   */
  firstStart: Date | null;
  /**
   * Latest resolved end across the plotted phases. Non-null iff
   * `scheduled` is true. Used by the Gantt range calculator, the
   * capacity sweep (via `projectSpan`), and the KPI report ordering.
   */
  overallEnd: Date | null;
};

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  return new Date(`${v}T00:00:00`);
}

export function computePhases(
  p: Pick<
    Project,
    "start_date"
    | "target_date"
    | "dev_start_date"
    | "dev_end_date"
    | "optimization_start_date"
    | "optimization_end_date"
  >,
): ProjectPhases {
  const start = toDate(p.start_date);
  const target = toDate(p.target_date);
  const devStart = toDate(p.dev_start_date);
  const devEnd = toDate(p.dev_end_date);
  const optStart = toDate(p.optimization_start_date);
  const optEnd = toDate(p.optimization_end_date);

  const discovery: PhaseInterval | null =
    start && target ? { start, end: target } : null;

  // Development inherits `target` as its start when `dev_start_date`
  // is null — matches the "Development picks up where Discovery
  // ended" default the PM sees in the phase editor. When neither
  // upstream anchor exists there's no meaningful left edge, so the
  // phase drops out even if dev_end_date is set.
  const devEffStart = devStart ?? target;
  const development: PhaseInterval | null =
    devEffStart && devEnd ? { start: devEffStart, end: devEnd } : null;

  // Post-Dev Optimization walks back through the preceding phase's
  // end for its start anchor: explicit opt_start > dev_end > target.
  // Extending the fallback past dev_end matters after the PM clears
  // dev_end while leaving opt_end set — the roadmap should still
  // draw an Optimization segment (from Discovery's end) instead of
  // silently dropping it. Symmetric with `devEffStart`, which
  // already falls back to target.
  const optEffStart = optStart ?? devEnd ?? target;
  const optimization: PhaseInterval | null =
    optEffStart && optEnd ? { start: optEffStart, end: optEnd } : null;

  const awaitingDev: PhaseInterval | null =
    target && devStart && devStart.getTime() > target.getTime()
      ? { start: target, end: devStart }
      : null;
  const awaitingOptimization: PhaseInterval | null =
    devEnd && optStart && optStart.getTime() > devEnd.getTime()
      ? { start: devEnd, end: optStart }
      : null;

  const scheduled = !!(discovery || development || optimization);
  const firstStart = earliest([
    discovery?.start ?? null,
    development?.start ?? null,
    optimization?.start ?? null,
  ]);
  const overallEnd = latest([
    optimization?.end ?? null,
    development?.end ?? null,
    discovery?.end ?? null,
  ]);

  return {
    scheduled,
    discovery,
    awaitingDev,
    development,
    awaitingOptimization,
    optimization,
    firstStart,
    overallEnd,
  };
}

function earliest(dates: (Date | null)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!out || d.getTime() < out.getTime()) out = d;
  }
  return out;
}

function latest(dates: (Date | null)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!out || d.getTime() > out.getTime()) out = d;
  }
  return out;
}
