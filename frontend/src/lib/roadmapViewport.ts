import { addDays, addMonths } from "date-fns";

import { projectSpan } from "./capacity";
import type { Project } from "./types";

/**
 * Roadmap Gantt "zoom" (timeframe) options. The three fixed windows
 * anchor a fresh view around today; "all" is a dynamic window that
 * spans from the earliest scheduled item to the latest so PMs can
 * see everything on one screen.
 */
export type Zoom = "3mo" | "6mo" | "1yr" | "all";

/**
 * Fixed timeframe length (in months, forward-from-today) for each
 * non-"all" zoom. "all" is derived from the visible project set and
 * therefore has no fixed value here — callers that need a numeric
 * width should special-case zoom === "all".
 */
export const TIMEFRAME_MONTHS: Record<Exclude<Zoom, "all">, number> = {
  "3mo": 3,
  "6mo": 6,
  "1yr": 12,
};

/**
 * Static pixels-per-day for the three fixed zooms. "all" is computed
 * dynamically inside `GanttTimeline` from the scroll container's
 * measured width divided by the total span (clamped to [0.5, 8] so
 * bars never disappear or become impossibly wide); a static fallback
 * is used until the container has been measured.
 */
export const DAY_PX: Record<Exclude<Zoom, "all">, number> = {
  "3mo": 16,
  "6mo": 8,
  "1yr": 3.5,
};

/**
 * Approximate CSS-inch of past chart room we always keep to the left
 * of today, both when computing the chart's left bound (so the
 * scroll position we set on mount / zoom-change is actually
 * reachable) and when placing "today" horizontally inside the
 * viewport. 96px ≈ 1in because CSS defines 1in = 96px regardless of
 * the physical display.
 */
export const TODAY_LEFT_OFFSET_PX = 96;

/**
 * Fallback pixels-per-day used for "all" zoom on the first render,
 * before the scroll container has been measured. Small enough that
 * multi-year spans still fit on a laptop screen; the ResizeObserver
 * kicks in on the next paint and replaces this with the measured
 * width / total span (clamped) so the fallback is essentially
 * transient.
 */
export const ALL_ZOOM_FALLBACK_DAY_PX = 1.5;

/** Lower / upper clamps for the dynamic `dayPx` used by "all" zoom. */
export const ALL_ZOOM_MIN_DAY_PX = 0.5;
export const ALL_ZOOM_MAX_DAY_PX = 8;

/**
 * Parse a `YYYY-MM-DD` string into a local-midnight `Date`. Kept
 * timezone-free so a project dated `2026-07-20` compares equal on
 * the "20th" regardless of the user's TZ. Matches the private
 * helper `GanttTimeline` uses for `dayX`.
 */
function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * Predicate used by the Roadmap to hide rows whose entire span sits
 * outside the currently-visible timeframe. Reduces vertical noise
 * — a project scheduled 18 months out shouldn't occupy a row on the
 * 3-month view.
 *
 * `viewportStart` is today minus the "past inch" buffer derived
 * from `TODAY_LEFT_OFFSET_PX / dayPx` for the current zoom — same
 * heuristic `computeRange` uses to widen the chart so today can
 * always land 1in from the left. `viewportEnd` is today +
 * `TIMEFRAME_MONTHS[zoom]` months forward (via `addMonths`, so
 * calendar-correct rather than a naive 30-day approximation).
 *
 * When `zoom` is "all", every scheduled project is in range by
 * definition — the viewport spans the whole project set — and the
 * function short-circuits to `true`. Projects without a plottable
 * span (i.e. `projectSpan` returns null) are treated as out of
 * range; the roadmap already routes those to the Unscheduled list
 * so the Gantt shouldn't see them, but we guard anyway.
 */
export function isProjectInRoadmapViewport(
  project: Project,
  zoom: Zoom,
  today: Date = new Date(),
): boolean {
  if (zoom === "all") return true;
  const span = projectSpan(project);
  if (!span) return false;
  const dayPx = DAY_PX[zoom];
  const pastDaysBuffer = Math.ceil(TODAY_LEFT_OFFSET_PX / dayPx);
  const viewportStart = addDays(today, -pastDaysBuffer);
  const viewportEnd = addMonths(today, TIMEFRAME_MONTHS[zoom]);
  const projStart = isoToLocalDate(span.start);
  const projEnd = isoToLocalDate(span.end);
  return projEnd >= viewportStart && projStart <= viewportEnd;
}
