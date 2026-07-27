import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { addMonths, differenceInCalendarDays, format, startOfMonth } from "date-fns";

import { computePhases } from "../lib/phaseCompute";
import { readableOn } from "../lib/colors";
import {
  ALL_ZOOM_FALLBACK_DAY_PX,
  DAY_PX,
  HALF_INCH_PX,
  computeRoadmapChartRange,
  computeRoadmapFitDayPx,
  computeRoadmapPdfDayPx,
  type Zoom,
} from "../lib/roadmapViewport";
import type { Project, SwimLane, Team, User } from "../lib/types";
import type { ColorBy } from "../lib/viewState";

/**
 * Compact roadmap render — the second Roadmap style option.
 *
 * Drops the left label column entirely and packs items into a
 * minimum number of rows so no two visible bars overlap
 * horizontally within the same row. Each item is a single solid
 * rectangle spanning its earliest → latest plotted date; the item
 * title is rendered inside the bar (centered vertically, truncated
 * with ellipsis when the bar is too narrow). Key-strategic items
 * get a 2px red outline to match the "star" indicator the Rows
 * view surfaces in the label column and Quarters view exposes as a
 * click affordance.
 *
 * The date-math (chart start/end, day-pixel density, today marker,
 * month header) reuses the same helpers `GanttTimeline` uses so
 * the timeframe segmented control keeps working identically in
 * either style. This component intentionally omits the
 * capacity / deadline / dependency indicators, drag-to-reschedule,
 * epic-subtask roll-ups, and group headers — Compact is a
 * "clean-presentation" layout by design; the Rows view keeps every
 * one of those affordances.
 */

/** Row height in the packed layout.
 *
 *  Sized to comfortably fit two lines of `text-xs` (12px font) title
 *  text at `leading-tight` (line-height 1.25 → 15px per line = 30px
 *  for two lines), plus ~10px of vertical padding INSIDE the bar so
 *  the text doesn't kiss the top / bottom edges, plus `BAR_PADDING`
 *  above and below the bar so consecutive rows read as distinct
 *  units. Intentionally taller than `GanttTimeline`'s `ROW_HEIGHT`
 *  (34px) because the Compact style renders the title inside the
 *  bar — the Rows style renders titles in the label column beside
 *  bars, which needs less bar height.
 *
 *  Changing this constant cascades through every rendered surface:
 *  the packer measures placed-bar y-positions in ROW_HEIGHT units,
 *  the body SVG sizes itself as `rowCount * ROW_HEIGHT`, and each
 *  bar's `top` / `height` derive from the same value. */
const ROW_HEIGHT = 52;
/** Vertical breathing room above / below each bar within a row.
 *  Slightly larger than `GanttTimeline`'s `BAR_PADDING` (6px) to
 *  match the taller row height — keeps the ratio of bar-height /
 *  row-height similar, so packed Compact rows read at roughly the
 *  same visual density as Rows-view bars despite fitting twice as
 *  much title text. Bar body height = ROW_HEIGHT - BAR_PADDING * 2
 *  = 40px, which fits the 30px two-line clamp with ~5px of
 *  vertical padding above and below via `items-center`. */
const BAR_PADDING = 6;
/** Height of the sticky month-label header. Matches
 *  `GanttTimeline`'s `HEADER_HEIGHT` so pdfMode / capture geometry
 *  read consistently across styles. */
const HEADER_HEIGHT = 48;
/** Minimum bar width in CSS px so a single-day item stays visible
 *  at long timeframes. Same 2px floor `GanttTimeline` uses when
 *  computing per-phase geometry. */
const MIN_BAR_WIDTH_PX = 2;
/** Solid fallback fill for items missing a resolvable colorBy
 *  value (e.g. no swim lane assignment when grouped by lane). Same
 *  neutral slate `GanttTimeline`'s `pickBase` falls back to. */
const FALLBACK_BAR_COLOR = "#94a3b8";

/**
 * One placed bar in the compact layout. `rowIndex` is the greedy
 * packer's assigned row (0-indexed from the top).
 */
type PlacedBar = {
  project: Project;
  /** Earliest plotted phase start — used for x-axis positioning. */
  startDate: Date;
  /** Latest plotted phase end — used for x-axis width. */
  endDate: Date;
  /** Base bar background color, resolved from the current
   *  `colorBy` dimension. Falls back to a neutral slate when the
   *  entity that would supply the color isn't available on the
   *  project (e.g. no primary team when colorBy === "team"). */
  color: string;
  rowIndex: number;
};

export function RoadmapCompactView({
  projects,
  lanes,
  teams,
  users,
  colorBy,
  zoom,
  onOpen,
  pdfMode,
}: {
  projects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  colorBy: ColorBy;
  zoom: Zoom;
  onOpen: (id: string) => void;
  /**
   * PDF snapshot mode. Drops the outer `overflow-auto` so
   * html-to-image captures the full chart width without the
   * wrapper clipping — mirrors the analogous branch in
   * `GanttTimeline`. Interactive rendering must always pass
   * false so the on-screen viewport keeps its bounded scroll.
   */
  pdfMode?: boolean;
}) {
  // Ref-bound to the horizontal scroll container so the today-snap
  // effect can position `scrollLeft`. Same pattern GanttTimeline
  // uses for its outer scroll card; both views should land users
  // with today ~half an inch from the visible left edge on
  // mount / zoom change.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdfMode]);

  // Reuse the exact date-range helper GanttTimeline uses so both
  // styles agree on what "in the chart" means — including the
  // pdfMode past-trim and the interactive past-extension for
  // ongoing projects.
  const { start, end, forwardDays } = useMemo(() => {
    const range = computeRoadmapChartRange({
      projects,
      zoom,
      pdfMode: pdfMode ?? false,
    });
    return { start: range.chartStart, end: range.chartEnd, forwardDays: range.forwardDays };
  }, [projects, zoom, pdfMode]);
  const totalDays = Math.max(1, differenceInCalendarDays(end, start));

  // Compact has no label column, so the auto-fit sizer targets the
  // full container width. The three fixed zooms still fit their
  // FORWARD portion into the visible area (matching the Rows
  // view's on-screen density), while "all" fits its total span to
  // the container end-to-end. pdfMode uses the same static PDF
  // day-pixel calc as GanttTimeline for cross-style consistency;
  // the label-column input is passed as 0 since Compact has none.
  const dayPx = useMemo(() => {
    if (pdfMode) return computeRoadmapPdfDayPx(totalDays, 0);
    const spanDays = zoom === "all" ? totalDays : forwardDays;
    const fit = computeRoadmapFitDayPx({
      containerWidth,
      spanDays,
      labelColumnPx: 0,
      subtractLabel: false,
      includeResizer: false,
    });
    if (fit != null) return fit;
    if (zoom === "all" || zoom === "quarters") return ALL_ZOOM_FALLBACK_DAY_PX;
    return DAY_PX[zoom];
  }, [pdfMode, zoom, containerWidth, totalDays, forwardDays]);
  const chartWidth = totalDays * dayPx;

  // Month tick anchors for the header + body gridlines. Same
  // start-of-month walk `GanttTimeline` uses.
  const months = useMemo(() => {
    const out: Date[] = [];
    let cursor = startOfMonth(start);
    while (cursor <= end) {
      out.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    return out;
  }, [start, end]);

  // Fast lookups for the color-resolution step. Built once per
  // input change so the per-item loop below is O(1) per entry.
  const laneById = useMemo(
    () => new Map(lanes.map((l) => [l.id, l] as const)),
    [lanes],
  );
  const teamById = useMemo(
    () => new Map(teams.map((t) => [t.id, t] as const)),
    [teams],
  );
  const userById = useMemo(
    () => new Map(users.map((u) => [u.id, u] as const)),
    [users],
  );

  // Greedy interval packer.
  //
  // Sort items ascending by earliest plotted start date; ties are
  // broken by `global_priority` ascending (lower number = higher
  // priority, matches the composite the Board / Rows priority sort
  // consumes) so a higher-priority item lands in a top row when
  // two items start on the same day. Missing priority values are
  // sunk to the end of any tie group.
  //
  // For each item, walk the current row set and place it in the
  // first row whose most-recently-placed bar ends STRICTLY BEFORE
  // the new item's start (day-level comparison; a same-day
  // adjacency counts as an overlap for readability). If no row
  // qualifies, open a new row at the bottom. Result is the
  // minimum number of rows for this input under the strict-
  // adjacency rule, which is exactly what the reference image
  // shows — no wasted vertical space, but no touching bars either.
  const placedBars = useMemo<PlacedBar[]>(() => {
    const candidates: PlacedBar[] = [];
    for (const p of projects) {
      const phases = computePhases(p);
      if (!phases.scheduled || !phases.firstStart || !phases.overallEnd) continue;
      candidates.push({
        project: p,
        startDate: phases.firstStart,
        endDate: phases.overallEnd,
        color: resolveBarColor(p, colorBy, laneById, teamById, userById),
        rowIndex: -1,
      });
    }
    candidates.sort((a, b) => {
      const dt = a.startDate.getTime() - b.startDate.getTime();
      if (dt !== 0) return dt;
      const pa = a.project.global_priority ?? Number.MAX_SAFE_INTEGER;
      const pb = b.project.global_priority ?? Number.MAX_SAFE_INTEGER;
      return pa - pb;
    });
    const rowEnds: Date[] = [];
    for (const bar of candidates) {
      let placed = -1;
      for (let i = 0; i < rowEnds.length; i++) {
        if (rowEnds[i]!.getTime() < bar.startDate.getTime()) {
          placed = i;
          break;
        }
      }
      if (placed === -1) {
        placed = rowEnds.length;
        rowEnds.push(bar.endDate);
      } else {
        rowEnds[placed] = bar.endDate;
      }
      bar.rowIndex = placed;
    }
    return candidates;
  }, [projects, colorBy, laneById, teamById, userById]);

  const rowCount = placedBars.reduce((n, b) => Math.max(n, b.rowIndex + 1), 0);
  // Guarantee at least one row of body height so the empty-state
  // paint doesn't collapse the scroll container. The parent
  // renders a distinct empty-state block when placedBars.length is
  // zero, but the ResizeObserver still needs something to measure.
  const bodyHeight = Math.max(1, rowCount) * ROW_HEIGHT;

  const today = new Date();
  const todayX = differenceInCalendarDays(today, start) * dayPx;
  const showToday = today >= start && today <= end;

  // Today-snap: fires once per zoom pick after the container has
  // been measured. Same policy GanttTimeline's snap uses so a
  // style flip lands the same "today ~half an inch from the left
  // edge" default. pdfMode skips entirely — the exporter captures
  // the natural scrollLeft and any imperative change here risks a
  // visible jump on toggle.
  const snappedZoomRef = useRef<Zoom | null>(null);
  useLayoutEffect(() => {
    if (pdfMode) return;
    const el = scrollRef.current;
    if (!el) return;
    if (containerWidth == null) return;
    if (snappedZoomRef.current === zoom) return;
    const todayXpx = differenceInCalendarDays(new Date(), start) * dayPx;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    el.scrollLeft = Math.max(0, Math.min(maxScroll, todayXpx - HALF_INCH_PX));
    snappedZoomRef.current = zoom;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, containerWidth, pdfMode]);

  if (placedBars.length === 0) {
    return (
      <div
        className="card-surface p-6 text-sm text-wp-slate"
        data-roadmap-capture-root="true"
      >
        No scheduled projects fall inside this timeframe. Widen the zoom
        (or pick All) to see items outside the current window.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-roadmap-capture-root="true"
      className={
        pdfMode
          ? "card-surface"
          : "card-surface max-h-[calc(100vh-240px)] overflow-auto"
      }
    >
      {/* Inner sizer defines the horizontal chart extent. The
          sticky month header + the absolutely-positioned bar body
          both live inside so a single H+V scroll on the parent
          moves them in lockstep — no JS listeners needed. */}
      <div style={{ width: chartWidth, position: "relative" }}>
        {/* MONTH HEADER — dark cells with month labels, matching
            the reference image. `sticky top-0` pins it to the
            scroll container's top; because the header lives inside
            the same H-scroll parent as the body they naturally
            share the horizontal offset. */}
        <div
          className="sticky top-0 z-20 border-b border-wp-stone bg-wp-ink"
          style={{ height: HEADER_HEIGHT, width: chartWidth }}
        >
          {months.map((m, i) => {
            const x = differenceInCalendarDays(m, start) * dayPx;
            const nextX = i + 1 < months.length
              ? differenceInCalendarDays(months[i + 1]!, start) * dayPx
              : chartWidth;
            const w = Math.max(0, nextX - x);
            return (
              <div
                key={`hdr-${i}`}
                className="absolute inset-y-0 flex items-center overflow-hidden border-r border-white/10 px-2 text-xs font-semibold uppercase tracking-wide text-white"
                style={{ left: x, width: w }}
                title={format(m, "MMMM yyyy")}
              >
                {/* Label compresses when the timeframe widens: the
                    fixed zooms (3mo / 6mo) have room for "MMM";
                    "1yr" / "all" append the year so a bare "Jan"
                    isn't ambiguous across a multi-year span. */}
                {format(m, zoom === "1yr" || zoom === "all" ? "MMM yyyy" : "MMM")}
              </div>
            );
          })}
        </div>

        {/* BODY — vertical month gridlines, today marker, and the
            packed bars. Absolute positioning inside a
            `position: relative` container gives us clean
            per-pixel control without an SVG paint pass; each bar
            is a plain button so keyboard focus + native click
            handling come for free. */}
        <div
          style={{ position: "relative", height: bodyHeight, width: chartWidth }}
        >
          {months.map((m, i) => {
            const x = differenceInCalendarDays(m, start) * dayPx;
            return (
              <div
                key={`grid-${i}`}
                className="pointer-events-none absolute top-0 bg-wp-stone/60"
                style={{ left: x, width: 1, height: bodyHeight }}
              />
            );
          })}

          {showToday ? (
            <div
              className="pointer-events-none absolute top-0"
              style={{
                left: todayX,
                width: 0,
                height: bodyHeight,
                // Dashed red vertical rule via a border so DOM
                // capture (html-to-image) reliably serialises the
                // dash pattern; a `background: repeating-linear-
                // gradient` on a 1px div has been observed to
                // rasterise to a solid line under Chromium's
                // foreignObject clone.
                borderLeft: "1.5px dashed #DC2626",
              }}
              aria-hidden
            />
          ) : null}

          {placedBars.map((bar) => {
            const p = bar.project;
            const x = differenceInCalendarDays(bar.startDate, start) * dayPx;
            const rawWidth = differenceInCalendarDays(bar.endDate, bar.startDate) * dayPx;
            const width = Math.max(MIN_BAR_WIDTH_PX, rawWidth);
            const top = bar.rowIndex * ROW_HEIGHT + BAR_PADDING;
            const height = ROW_HEIGHT - BAR_PADDING * 2;
            const textColor = readableOn(bar.color);
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => onOpen(p.id)}
                title={`${p.title}\n${format(bar.startDate, "MMM d, yyyy")} → ${format(bar.endDate, "MMM d, yyyy")}`}
                className="absolute flex items-center overflow-hidden rounded-md px-2 py-1 text-left text-xs font-medium shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red focus-visible:ring-offset-1"
                style={{
                  left: x,
                  top,
                  width,
                  height,
                  backgroundColor: bar.color,
                  color: textColor,
                  // Key-strategic items get a 2px red outline per
                  // the reference image — same "star" indicator
                  // the Rows view surfaces in the label column.
                  // Rendered as `outline` (not `border`) so it
                  // doesn't consume the bar's inner width and
                  // shift the title away from the geometric
                  // pixel span; the -2px offset keeps the outline
                  // aligned with the bar's visual edge.
                  outline: p.is_key_strategic ? "2px solid #E01F2D" : undefined,
                  outlineOffset: p.is_key_strategic ? "-2px" : undefined,
                }}
              >
                {/* Two-line title clamp.
                    `min-w-0 flex-1` is what lets the child shrink
                    inside the button's flex row — without it the
                    flex item's implicit minimum content width would
                    keep the title at its intrinsic length and clip
                    via the button's overflow rule instead of
                    ellipsizing at the end of line 2.
                    `line-clamp-2` is the Tailwind utility (built-in
                    in v3.3+, no plugin needed) that expands to the
                    canonical `-webkit-line-clamp: 2; display:
                    -webkit-box; -webkit-box-orient: vertical;
                    overflow: hidden;` combo — chosen over the raw
                    CSS spelling because it composes cleanly with
                    the other Tailwind utilities already on this
                    element and matches the rest of the codebase's
                    utility-first styling convention. `leading-tight`
                    (1.25) tunes per-line height so two lines fit in
                    the 40px inner bar height with roughly equal
                    vertical padding above and below via the parent
                    button's `items-center` flex alignment; the
                    single-line case stays vertically centered too
                    because the clamp gives the span its natural
                    single-line height in that case. */}
                <span className="min-w-0 flex-1 line-clamp-2 leading-tight">
                  {p.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Resolve the solid bar color for one item under the current
 * `colorBy` dimension. Mirrors `GanttTimeline`'s `pickBase`
 * decision tree so both styles paint the same color for the same
 * (colorBy, project) pair — the Rows view uses this color for the
 * discovery / opt-gradient bar body, and Compact uses it flat.
 *
 * Falls back to a neutral slate when the resolved entity is missing
 * (e.g. no primary team when `colorBy === "team"`, no assigned lane
 * when `colorBy === "swim_lane"`). Same fallback the Rows view
 * lands on, so a project with no team assignment renders as slate
 * in both styles rather than being invisible in one and colored
 * in the other.
 */
function resolveBarColor(
  project: Project,
  colorBy: ColorBy,
  laneById: Map<string, SwimLane>,
  teamById: Map<string, Team>,
  userById: Map<string, User>,
): string {
  if (colorBy === "team") {
    const teamId = project.teams[0];
    const team = teamId ? teamById.get(teamId) : null;
    return team?.color ?? FALLBACK_BAR_COLOR;
  }
  if (colorBy === "owner") {
    const owner = project.owner_id ? userById.get(project.owner_id) : null;
    return owner?.color ?? FALLBACK_BAR_COLOR;
  }
  const lane = project.swim_lane_id ? laneById.get(project.swim_lane_id) : null;
  return lane?.color ?? FALLBACK_BAR_COLOR;
}
