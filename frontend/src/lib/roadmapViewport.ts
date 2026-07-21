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
 * Static pixels-per-day for the three fixed zooms. Used in two
 * places:
 *   * As the actual (non-auto-fit) density inside the auto-schedule
 *     preview modal, which owns its own `overflow-x-auto` and
 *     therefore wants a stable, screen-size-independent bar width.
 *   * As the first-paint fallback inside the main Roadmap view,
 *     for the one frame before the ResizeObserver latches onto the
 *     card's measured width. Auto-fit takes over on the next commit.
 * Values chosen historically to keep the preview modal's bars
 * readable at typical modal widths (~700–900px chart column).
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
 * Lower / upper clamps for the dynamic `dayPx` used by the fixed
 * zooms (3mo / 6mo / 1yr) when the chart is auto-sized to the
 * scroll container's measured width. The chart shrinks columns to
 * whatever ratio fits `totalDaysInTimeframe` inside the available
 * chart area, then clamps into this range so:
 *   * `MIN` (0.4px) prevents multi-year edge cases from producing
 *     sub-pixel columns whose month labels crash into each other.
 *   * `MAX` (12px) prevents a very narrow date span on a very wide
 *     monitor from stretching every bar across the whole viewport
 *     (the 3-month view on a 1440px laptop naturally lands around
 *     11–12px/day at the default label column, so this ceiling is
 *     effectively "don't get any wider than the 3-mo default").
 * Chosen so a typical 1440–1680px laptop screen fits any of the
 * fixed zooms end-to-end without horizontal scroll, and so an
 * ultrawide monitor doesn't produce absurdly wide bars.
 */
export const ROADMAP_FIT_MIN_DAY_PX = 0.4;
export const ROADMAP_FIT_MAX_DAY_PX = 12;

/**
 * Small horizontal safety padding (CSS px) subtracted from the
 * container width before dividing by `totalDays`. Keeps the
 * computed chart width strictly less than the container so a
 * rounding-driven off-by-one pixel can't trigger a horizontal
 * scrollbar to appear-then-disappear on every ResizeObserver tick.
 */
export const ROADMAP_FIT_CHART_PADDING_PX = 4;

/**
 * Width (CSS px) of the label-column resize divider. Kept next to
 * the fit-to-viewport constants because the auto-sizer subtracts
 * it from the container width alongside the label column itself.
 * The divider glyph is rendered by `ColumnResizer` (Tailwind
 * `w-1.5` = 6px); duplicated here so the sizing math has a
 * single, statically-typed source of truth rather than a magic
 * number sprinkled through GanttTimeline.
 */
export const ROADMAP_LABEL_RESIZER_WIDTH_PX = 6;

/**
 * Target total artefact width (label column + chart) for the PDF
 * export. Chosen to land nicely inside a Google-Slide 16:9 layout
 * when the user drops the exported PNG into a slide: 1600 CSS px
 * scales down to fit a standard 13.33in slide comfortably while
 * still leaving day columns wide enough that phase text remains
 * legible at slide-size. Combined with the exporter's
 * `pixelRatio: 2` this produces a 3200px-wide raster that stays
 * crisp when the slide is projected.
 */
export const ROADMAP_PDF_TARGET_TOTAL_WIDTH_PX = 1600;

/**
 * Compute the pixels-per-day for a PDF snapshot. Independent of the
 * interactive container width so a screenshot / PDF always renders
 * the same absolute size regardless of the user's browser window —
 * that's the "paste into a Google Slide" promise. Result is clamped
 * into the same range as the interactive auto-fit so absurdly wide
 * spans stay legible and single-project spans don't produce
 * mile-wide bars.
 */
export function computeRoadmapPdfDayPx(
  totalDays: number,
  labelColumnPx: number,
): number {
  const span = Math.max(1, totalDays);
  const chartArea = Math.max(
    100,
    ROADMAP_PDF_TARGET_TOTAL_WIDTH_PX - labelColumnPx,
  );
  const raw = chartArea / span;
  return Math.max(ROADMAP_FIT_MIN_DAY_PX, Math.min(ROADMAP_FIT_MAX_DAY_PX, raw));
}

/**
 * Compute the pixels-per-day that fits the given timeframe span into
 * the currently-measured chart area. Same clamp-range as the PDF
 * variant so switching between interactive and export produces
 * visually consistent bar widths. Callers pass:
 *   * `containerWidth`: the outer element's clientWidth (in the
 *     sticky-header layout this is the whole card; in the
 *     monolithic layout it's the chart column directly).
 *   * `totalDays`: `differenceInCalendarDays(rangeEnd, rangeStart)`
 *     — includes any past-inch buffer widening the range added.
 *   * `labelColumnPx`: the resolved label column width; only
 *     subtracted when `subtractLabel` is true (sticky layout).
 *   * `includeResizer`: whether the resize divider is currently in
 *     the DOM (adds `ROADMAP_LABEL_RESIZER_WIDTH_PX` to the chrome
 *     subtracted from the container width).
 *
 * Returns `null` if `containerWidth` isn't measured yet (initial
 * paint) so callers can fall back to a per-zoom static default
 * without a visible layout jump.
 */
export function computeRoadmapFitDayPx(opts: {
  containerWidth: number | null;
  totalDays: number;
  labelColumnPx: number;
  subtractLabel: boolean;
  includeResizer: boolean;
}): number | null {
  const { containerWidth, totalDays, labelColumnPx, subtractLabel, includeResizer } = opts;
  if (containerWidth == null || containerWidth <= 0) return null;
  const chrome = (subtractLabel ? labelColumnPx : 0)
    + (includeResizer ? ROADMAP_LABEL_RESIZER_WIDTH_PX : 0)
    + ROADMAP_FIT_CHART_PADDING_PX;
  const chartArea = Math.max(0, containerWidth - chrome);
  if (chartArea <= 0) return null;
  const raw = chartArea / Math.max(1, totalDays);
  return Math.max(ROADMAP_FIT_MIN_DAY_PX, Math.min(ROADMAP_FIT_MAX_DAY_PX, raw));
}

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
