import type { Project } from "./types";

export type ProjectPhases = {
  scheduled: boolean;
  discovery: { start: Date; end: Date } | null;
  /** Gap between discovery end (target_date) and the PM-picked dev_start_date, if any. */
  awaitingDev: { start: Date; end: Date } | null;
  development: { start: Date; end: Date } | null;
  /** Gap between dev_end_date and the PM-picked optimization_start_date, if any. */
  awaitingOptimization: { start: Date; end: Date } | null;
  optimization: { start: Date; end: Date } | null;
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

  const scheduled = !!(start && target && devEnd && optEnd);
  if (!scheduled) {
    return {
      scheduled: false,
      discovery: null,
      awaitingDev: null,
      development: null,
      awaitingOptimization: null,
      optimization: null,
      overallEnd: null,
    };
  }

  const discovery = { start: start!, end: target! };

  const effectiveDevStart = devStart ?? target!;
  const awaitingDev =
    devStart && devStart.getTime() > target!.getTime()
      ? { start: target!, end: devStart }
      : null;
  const development = { start: effectiveDevStart, end: devEnd! };

  const effectiveOptStart = optStart ?? devEnd!;
  const awaitingOptimization =
    optStart && optStart.getTime() > devEnd!.getTime()
      ? { start: devEnd!, end: optStart }
      : null;
  const optimization = { start: effectiveOptStart, end: optEnd! };

  return {
    scheduled: true,
    discovery,
    awaitingDev,
    development,
    awaitingOptimization,
    optimization,
    overallEnd: optEnd!,
  };
}
