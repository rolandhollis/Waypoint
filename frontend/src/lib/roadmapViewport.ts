import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  max as maxDate,
  min as minDate,
  startOfMonth,
} from "date-fns";

import { projectSpan } from "./capacity";
import { computePhases } from "./phaseCompute";
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
 * Half-inch of CSS pixels (96px/in ÷ 2 = 48px). Used as the initial
 * horizontal offset of today's x-coordinate from the visible chart's
 * left edge on mount / zoom change: the user should always see a
 * small sliver of past dates (a "you can scroll left" visual cue)
 * with the bulk of the chart devoted to the forward-looking
 * timeframe they picked.
 */
export const HALF_INCH_PX = 48;

/**
 * Horizontal safety padding (in CALENDAR DAYS) added to both edges
 * of the interactive chart so bars near the very earliest / latest
 * dates don't butt against the chart border. Also gives the initial
 * scroll snap and the far-right scroll cursor a small runway of
 * empty chart to reveal past-boundary movement (e.g. drag-editing
 * a bar past the current max end).
 */
export const ROADMAP_CHART_EDGE_BUFFER_DAYS = 7;

/**
 * Number of past days included in the PDF snapshot. The exported
 * artefact is timeframe-focused: it captures roughly the same
 * forward span the user picked (3/6/12 months or "all") plus a
 * fixed one-month look-back so partially-elapsed projects still
 * render their leading edge. Deliberately shorter than the
 * interactive past extension (which can span many months back to
 * include long-running projects) so the PDF stays legible when
 * dropped into a slide.
 */
export const ROADMAP_PDF_PAST_TRIM_DAYS = 30;

/**
 * Lower / upper clamps on the "forward days" derived from the "all"
 * zoom. `MIN` keeps day columns wide enough to read when the
 * workspace is empty or every item is already in the past;
 * `MAX` prevents an outlier project years out from crushing the
 * chart into sub-pixel columns.
 */
export const ALL_ZOOM_MIN_FORWARD_DAYS = 90;
export const ALL_ZOOM_MAX_FORWARD_DAYS = 5 * 365;

/**
 * Fallback pixels-per-day used for "all" zoom on the first render,
 * before the scroll container has been measured. Small enough that
 * multi-year spans still fit on a laptop screen; the ResizeObserver
 * kicks in on the next paint and replaces this with the measured
 * width / forward span (clamped) so the fallback is essentially
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
 * whatever ratio fits the FORWARD portion of the selected timeframe
 * inside the available chart area, then clamps into this range so:
 *   * `MIN` (0.4px) prevents multi-year edge cases from producing
 *     sub-pixel columns whose month labels crash into each other.
 *   * `MAX` (12px) prevents a very narrow date span on a very wide
 *     monitor from stretching every bar across the whole viewport
 *     (the 3-month view on a 1440px laptop naturally lands around
 *     11–12px/day at the default label column, so this ceiling is
 *     effectively "don't get any wider than the 3-mo default").
 * Chosen so a typical 1440–1680px laptop screen fits any of the
 * fixed zooms' forward window end-to-end without horizontal scroll,
 * and so an ultrawide monitor doesn't produce absurdly wide bars.
 */
export const ROADMAP_FIT_MIN_DAY_PX = 0.4;
export const ROADMAP_FIT_MAX_DAY_PX = 12;

/**
 * Small horizontal safety padding (CSS px) subtracted from the
 * container width before dividing by the forward span. Keeps the
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
 * that's the "paste into a Google Slide" promise. Divides the total
 * PDF-chart span (past-trim + forward + edge buffer) into the
 * target width, then clamps into the same range as the interactive
 * auto-fit so absurdly wide spans stay legible and single-project
 * spans don't produce mile-wide bars.
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
 * Compute the pixels-per-day that fits the given day span into the
 * currently-measured chart area. Same clamp-range as the PDF variant
 * so switching between interactive and export produces visually
 * consistent bar widths.
 *
 * The main interactive Roadmap passes `spanDays = forwardDays` here
 * — the fit target is the FORWARD portion of the selected timeframe
 * only, not the full chart width. The chart itself extends further
 * (see `computeRoadmapChartRange`) so past dates render and remain
 * reachable by horizontal scroll, but the day-column density is
 * chosen so the forward slice matches the viewport. That means:
 * loading a 3-month view on a 1440px laptop always fits ~3 months
 * ahead of today into the visible area, even if a scheduled item
 * carries the chart back six months of past history.
 *
 * The auto-schedule preview modal (a monolithic, non-sticky layout)
 * passes `spanDays = totalDays` instead — its full chart is meant
 * to fit end-to-end inside the modal's chart column, since the
 * modal owns its own scroll and PMs review the whole batch as a
 * single frame.
 *
 * Returns `null` if `containerWidth` isn't measured yet (initial
 * paint) so callers can fall back to a per-zoom static default
 * without a visible layout jump.
 */
export function computeRoadmapFitDayPx(opts: {
  containerWidth: number | null;
  spanDays: number;
  labelColumnPx: number;
  subtractLabel: boolean;
  includeResizer: boolean;
}): number | null {
  const { containerWidth, spanDays, labelColumnPx, subtractLabel, includeResizer } = opts;
  if (containerWidth == null || containerWidth <= 0) return null;
  const chrome = (subtractLabel ? labelColumnPx : 0)
    + (includeResizer ? ROADMAP_LABEL_RESIZER_WIDTH_PX : 0)
    + ROADMAP_FIT_CHART_PADDING_PX;
  const chartArea = Math.max(0, containerWidth - chrome);
  if (chartArea <= 0) return null;
  const raw = chartArea / Math.max(1, spanDays);
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
 * Earliest / latest computable bar edge across a project set. Falls
 * back to `{null, null}` when nothing is scheduled — callers then
 * treat the range as "no project data, anchor purely on today".
 * Only scheduled items contribute; anything computePhases marks
 * unschedulable is ignored (it wouldn't render a bar anyway).
 */
function computeProjectDateBounds(
  projects: Project[],
): { earliest: Date | null; latest: Date | null } {
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const p of projects) {
    const phases = computePhases(p);
    if (!phases.scheduled || !phases.firstStart || !phases.overallEnd) continue;
    if (!earliest || phases.firstStart.getTime() < earliest.getTime()) {
      earliest = phases.firstStart;
    }
    if (!latest || phases.overallEnd.getTime() > latest.getTime()) {
      latest = phases.overallEnd;
    }
  }
  return { earliest, latest };
}

/**
 * Forward-looking span (in whole days from `today`) that the
 * interactive auto-fit sizer targets. Fixed zooms are exactly N
 * calendar months of days ahead of today (via `addMonths`, so
 * DST + short-month correct rather than a naive 30-day
 * approximation). "all" scales to the latest scheduled item,
 * clamped so the workspace-is-empty and outlier-project-far-in-
 * future cases don't produce unreadable columns.
 */
export function computeRoadmapForwardDays(
  zoom: Zoom,
  latestProjectEnd: Date | null,
  today: Date = new Date(),
): number {
  if (zoom !== "all") {
    return Math.max(
      1,
      differenceInCalendarDays(addMonths(today, TIMEFRAME_MONTHS[zoom]), today),
    );
  }
  const raw = latestProjectEnd
    ? Math.max(0, differenceInCalendarDays(latestProjectEnd, today))
    : ALL_ZOOM_MIN_FORWARD_DAYS;
  return Math.max(ALL_ZOOM_MIN_FORWARD_DAYS, Math.min(ALL_ZOOM_MAX_FORWARD_DAYS, raw));
}

/**
 * Compute the chart's left / right date bounds and the forward-span
 * length in a single pass. Shared between the interactive Gantt and
 * the RoadmapView filter so both surfaces agree on what "in the
 * chart" means.
 *
 * Interactive mode (`pdfMode: false`):
 *   * `chartStart` = min(earliestScheduledStart, today), pulled back
 *     `ROADMAP_CHART_EDGE_BUFFER_DAYS` and snapped to month start so
 *     month labels line up. The past extension gives ongoing
 *     projects a place to render their leading edge; the initial-
 *     scroll snap in GanttTimeline lands today ~half an inch from
 *     the visible left, leaving a small strip of past chart
 *     reachable by scroll-left (visual "you can go back" cue).
 *   * `chartEnd` = max(latestScheduledEnd, today + forwardDays),
 *     pushed forward by the same buffer and snapped to month end.
 *     Projects that extend past the selected timeframe still appear
 *     on the chart and are reachable by scroll-right.
 *
 * PDF mode (`pdfMode: true`): the same forward end as interactive
 * (so nothing past the timeframe gets cut off), but the left bound
 * is trimmed to exactly `today - ROADMAP_PDF_PAST_TRIM_DAYS`. We
 * deliberately do NOT extend chartStart back to the earliest
 * scheduled item — the exported artefact should be timeframe-
 * focused, not a long-tail history dump. The 30-day past window is
 * enough to show partially-elapsed projects entering the frame
 * without dominating the slide.
 *
 * `forwardDays` is returned alongside so callers that also need to
 * size the day-column density (interactive dayPx auto-fit) can do
 * so without re-deriving it.
 */
export function computeRoadmapChartRange(opts: {
  projects: Project[];
  zoom: Zoom;
  today?: Date;
  pdfMode?: boolean;
}): { chartStart: Date; chartEnd: Date; forwardDays: number } {
  const { projects, zoom, pdfMode = false } = opts;
  const today = opts.today ?? new Date();
  const { earliest, latest } = computeProjectDateBounds(projects);
  const forwardDays = computeRoadmapForwardDays(zoom, latest, today);
  const forwardEnd = addDays(today, forwardDays);

  const endAnchor = latest ? maxDate([forwardEnd, latest]) : forwardEnd;
  const chartEnd = endOfMonth(addDays(endAnchor, ROADMAP_CHART_EDGE_BUFFER_DAYS));

  if (pdfMode) {
    // PDF: hard past trim, no month snap on the left so the leftmost
    // visible date is EXACTLY `today - 30`. Earlier month labels
    // render at negative x and are clipped by the SVG viewport —
    // matches the pre-refactor PDF export behavior.
    const chartStart = addDays(today, -ROADMAP_PDF_PAST_TRIM_DAYS);
    return { chartStart, chartEnd, forwardDays };
  }

  const startAnchor = earliest ? minDate([earliest, today]) : today;
  const chartStart = startOfMonth(addDays(startAnchor, -ROADMAP_CHART_EDGE_BUFFER_DAYS));
  return { chartStart, chartEnd, forwardDays };
}

/**
 * Predicate used by the Roadmap to hide rows whose entire span sits
 * outside the current chart range. Because the interactive chart
 * range is derived from the SAME scheduled set the predicate filters
 * (see `computeRoadmapChartRange`), this reduces to a near-tautology
 * for anything with a computable span: every scheduled item's span
 * falls inside `[chartStart, chartEnd]` by construction. The check
 * is kept for two reasons:
 *
 *   1. Anything without a plottable span (`projectSpan` returns
 *      null) is dropped — the Gantt shouldn't try to render bars
 *      for items the roadmap has already routed to the Unscheduled
 *      list.
 *   2. Future callers that pre-compute a custom range (e.g. a
 *      cropped snapshot mode) can still use this predicate to
 *      trim their input set without duplicating the interval-
 *      overlap math.
 */
export function isProjectInRoadmapViewport(
  project: Project,
  chartStart: Date,
  chartEnd: Date,
): boolean {
  const span = projectSpan(project);
  if (!span) return false;
  const projStart = isoToLocalDate(span.start);
  const projEnd = isoToLocalDate(span.end);
  return projEnd >= chartStart && projStart <= chartEnd;
}
