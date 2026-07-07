export type ProjectPhaseInput = {
  start_date: Date | string | null;
  target_date: Date | string | null;
  dev_start_date: Date | string | null;
  dev_end_date: Date | string | null;
  optimization_start_date: Date | string | null;
  optimization_end_date: Date | string | null;
};

export type ProjectPhases = {
  scheduled: boolean;
  discovery: { start: Date; end: Date } | null;
  /**
   * Gap between discovery end (target_date) and the day dev actually
   * begins (dev_start_date). Non-null only when the PM has explicitly
   * picked a later dev_start_date; when dev is immediate, this is null
   * and Development starts on target_date.
   */
  awaitingDev: { start: Date; end: Date } | null;
  development: { start: Date; end: Date } | null;
  /**
   * Analogous gap between dev end and optimization start. Non-null only
   * when the PM has explicitly picked a later optimization_start_date.
   */
  awaitingOptimization: { start: Date; end: Date } | null;
  optimization: { start: Date; end: Date } | null;
  overallEnd: Date | null;
};

function toDate(v: Date | string | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export function computePhases(input: ProjectPhaseInput): ProjectPhases {
  const start = toDate(input.start_date);
  const target = toDate(input.target_date);
  const devStart = toDate(input.dev_start_date);
  const devEnd = toDate(input.dev_end_date);
  const optStart = toDate(input.optimization_start_date);
  const optEnd = toDate(input.optimization_end_date);

  // Every phase needs both ends anchored (with the "start" of dev/opt
  // implicitly derived if not explicitly set) for the project to render
  // on the roadmap.
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
