import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { addMonths, differenceInCalendarDays, format, startOfMonth } from "date-fns";

import { computePhases } from "../lib/phaseCompute";
import { readableOn } from "../lib/colors";
import {
  compareGroupBySortKey,
  resolveProjectGroup,
} from "../lib/roadmapGrouping";
import {
  ALL_ZOOM_FALLBACK_DAY_PX,
  DAY_PX,
  HALF_INCH_PX,
  computeRoadmapChartRange,
  computeRoadmapFitDayPx,
  computeRoadmapPdfDayPx,
  type Zoom,
} from "../lib/roadmapViewport";
import type { Kpi, Project, SwimLane, Team, User } from "../lib/types";
import type { ColorBy, GroupBy } from "../lib/viewState";

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
 * and epic-subtask roll-ups — Compact is a "clean-presentation"
 * layout by design; the Rows view keeps every one of those
 * affordances.
 *
 * Grouping: honors the FilterBar's `Group by` dropdown identically
 * to the Rows view. `groupBy === "none"` renders one packed pool;
 * every other dimension partitions items via `resolveProjectGroup`
 * (shared helper), packs each partition independently so no bar
 * from group A ever shares a row with a bar from group B, and
 * stacks the resulting sections vertically with a small vertical
 * gap between them. Section ordering mirrors the Rows view (same
 * `compareGroupBySortKey` comparator). Deliberately does NOT
 * render a visible header strip per section — Compact optimises
 * for vertical density and the color / spatial cues from the
 * grouped packing are usually enough to read which items belong
 * together; users who need labeled groupings switch to Rows.
 */

/** Row height in the packed layout.
 *
 *  Tight enough that consecutive bars sit close together while
 *  still fitting two lines of `text-xs` (12px font) title text at
 *  `leading-tight` (line-height 1.25 → 15px per line = 30px for
 *  two lines) inside the bar body without the text kissing the
 *  top / bottom edges.
 *
 *  Bar body height = ROW_HEIGHT - BAR_PADDING * 2 = 38px, which
 *  fits the 30px two-line clamp with ~4px of vertical padding
 *  above and below via `items-center`. Inter-row gap = BAR_PADDING
 *  * 2 = 4px (2px below one bar + 2px above the next).
 *
 *  Changing this constant cascades through every rendered surface:
 *  the packer measures placed-bar y-positions in ROW_HEIGHT units,
 *  the body sizes itself as `rowCount * ROW_HEIGHT` per section,
 *  and each bar's `top` / `height` derive from the same value. */
const ROW_HEIGHT = 42;
/** Vertical breathing room above / below each bar within a row.
 *  Kept minimal (2px above + 2px below = 4px inter-row gap) so a
 *  dense packed layout doesn't waste vertical real estate between
 *  bars; the 38px bar body still comfortably fits the 30px
 *  two-line title clamp with a 4px top + 4px bottom text padding
 *  via `items-center`. */
const BAR_PADDING = 2;
/** Height of the sticky month-label header. Matches
 *  `GanttTimeline`'s `HEADER_HEIGHT` so pdfMode / capture geometry
 *  read consistently across styles. */
const HEADER_HEIGHT = 48;
/** Minimum bar width in CSS px so a single-day item stays visible
 *  at long timeframes. Same 2px floor `GanttTimeline` uses when
 *  computing per-phase geometry. */
const MIN_BAR_WIDTH_PX = 2;
/** Minimum horizontal room the label container tries to hold onto
 *  when the visible-slice clamp would otherwise crush the label
 *  into a strip too narrow to read.
 *
 *  Sized to fit roughly two lines of a medium-length title at the
 *  `text-xs leading-tight` scale (~11-13 chars per line = enough
 *  for "Coupon detail page redesign" style titles without
 *  degenerating to "Cou..."). When today falls inside a bar's span
 *  but the today→barRight slice is narrower than this value, the
 *  label is allowed to extend LEFTWARD past the today marker into
 *  the past portion of the same bar (never past the bar's own left
 *  edge) so the title stays legible. Bars narrower than this value
 *  overall get the whole bar as label real estate — same as before
 *  this floor landed — because there's simply no wider slice to
 *  reach for.
 *
 *  Trade-off: text may partially cover the today marker for the
 *  bars this rule affects. That's an intentional compromise —
 *  the today line still paints at its correct x-coordinate; only
 *  the label crosses it. Better than a title truncated to nonsense
 *  (see bug repro: red "Coupon detail —.." bars adjacent to today
 *  on 6-month zoom). */
const MIN_LABEL_WIDTH_PX = 140;
/** Solid fallback fill for items missing a resolvable colorBy
 *  value (e.g. no swim lane assignment when grouped by lane). Same
 *  neutral slate `GanttTimeline`'s `pickBase` falls back to. */
const FALLBACK_BAR_COLOR = "#94a3b8";
/** Vertical gap between adjacent group sections. Small on
 *  purpose — since we no longer render a visible header strip for
 *  each group (Compact is optimised for density; the color /
 *  spatial cues from the grouped packing are usually enough to
 *  read group boundaries), this gap is the only visual separator
 *  between consecutive groups. Sized at ~2× the inter-row gap
 *  (BAR_PADDING * 2 = 4px) so an inter-group gap reads as clearly
 *  bigger than an inter-row gap without stealing meaningful
 *  vertical space in many-group layouts. */
const SECTION_GAP = 8;

/**
 * One placed bar in the compact layout. `rowIndex` is the greedy
 * packer's assigned row (0-indexed from the top of the enclosing
 * section — when grouping is active every section restarts row
 * numbering at 0 so bars in section B never collide with bars in
 * section A).
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

/**
 * One packed section = one group's worth of packed bars plus the
 * metadata the section-ordering comparator needs. `label === null`
 * means the section is the single pool that renders when
 * `groupBy === "none"` (no partition needed). Section headers are
 * intentionally not rendered in Compact — the label / sortKey
 * fields exist only to order sections consistently with the Rows
 * view via `compareGroupBySortKey`.
 */
type PackedSection = {
  key: string;
  label: string | null;
  /** Sort key from `resolveProjectGroup` (swim_lane.order,
   *  team.order, kpi.order — undefined for owner / tag which sort
   *  alphabetically by label). Kept on the section so the section
   *  ordering pass can consult it without re-resolving. */
  sortKey?: number;
  bars: PlacedBar[];
  /** Number of rows the greedy packer needed for this section. */
  rowCount: number;
};

export function RoadmapCompactView({
  projects,
  lanes,
  teams,
  users,
  kpis,
  colorBy,
  groupBy,
  zoom,
  onOpen,
  pdfMode,
}: {
  projects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  /**
   * Full KPI catalog. Only consulted when `groupBy === "kpi"` (to
   * look up label + color for the primary KPI of each item);
   * passed unconditionally so a group-by flip doesn't require a
   * parent re-render to plumb the array through.
   */
  kpis: Kpi[];
  colorBy: ColorBy;
  /**
   * Selected group-by dimension. `"none"` renders a single
   * header-less packed pool (legacy behavior); every other value
   * partitions items by `resolveProjectGroup` and packs each
   * partition independently with a group header above.
   */
  groupBy: GroupBy;
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
  // effect can position `scrollLeft`. Compact intentionally has no
  // internal VERTICAL scroll — the card grows to fit its packed
  // content and lets the parent RoadmapView pane (which already
  // owns an `overflow-auto` wrapper around the whole roadmap
  // subtree) handle page-level vertical scrolling. The card
  // itself only owns horizontal scroll (`overflow-x-auto`) since
  // the chart width can exceed the viewport at short zooms.
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

  // Greedy interval packer, partitioned per group.
  //
  // Step 1 — build the candidate bar list. Every project with a
  // plottable date range enters exactly once; projects without
  // a resolvable start/end are silently skipped (same policy as
  // the Rows view).
  //
  // Step 2 — bucket candidates by group. `groupBy === "none"`
  // pours everything into a single "all" bucket so the resulting
  // section renders header-less (label = null). Every other
  // `groupBy` value calls `resolveProjectGroup` — the shared
  // helper that both roadmap styles now consume — so bucketing
  // rules stay bit-identical with Rows: multi-value teams / kpis
  // route to their primary; missing values sink to an
  // "Unassigned" (or "(no KPI)" / "No tag") bucket.
  //
  // Step 3 — pack each bucket. Sort ascending by earliest plotted
  // start date; ties broken by `global_priority` ascending (lower
  // number = higher priority, matches the composite the Board /
  // Rows priority sort consumes) so a higher-priority item lands
  // in a top row when two items start on the same day. For each
  // item, walk the current row set and place it in the first row
  // whose most-recently-placed bar ends STRICTLY BEFORE the new
  // item's start (day-level comparison; same-day adjacency counts
  // as an overlap for readability). If no row qualifies, open a
  // new row at the bottom. Row numbering restarts at 0 per
  // bucket — a bar in section B can never share a row with a bar
  // in section A because the two sections stack vertically in
  // the render pass rather than sharing the packer's row space.
  //
  // Step 4 — order the sections. `groupBy === "none"` returns the
  // single "all" section unchanged (nothing to sort). Every other
  // value delegates to `compareGroupBySortKey` — same comparator
  // Rows uses — so both styles' group headers appear in the same
  // order for any (groupBy, workspace) pair. Buckets with zero
  // packable items never enter the map in the first place so
  // "empty groups render as nothing" falls out for free.
  const packedSections = useMemo<PackedSection[]>(() => {
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

    type Bucket = {
      key: string;
      label: string | null;
      sortKey?: number;
      bars: PlacedBar[];
    };
    const buckets = new Map<string, Bucket>();
    const ctx = { users, lanes, teams, kpis };
    for (const bar of candidates) {
      if (groupBy === "none") {
        let bucket = buckets.get("all");
        if (!bucket) {
          bucket = { key: "all", label: null, bars: [] };
          buckets.set("all", bucket);
        }
        bucket.bars.push(bar);
        continue;
      }
      const info = resolveProjectGroup(bar.project, groupBy, ctx);
      let bucket = buckets.get(info.key);
      if (!bucket) {
        bucket = {
          key: info.key,
          label: info.label,
          sortKey: info.sortKey,
          bars: [],
        };
        buckets.set(info.key, bucket);
      }
      bucket.bars.push(bar);
    }

    const sections: PackedSection[] = [];
    for (const bucket of buckets.values()) {
      const sortedBars = bucket.bars.slice().sort((a, b) => {
        const dt = a.startDate.getTime() - b.startDate.getTime();
        if (dt !== 0) return dt;
        const pa = a.project.global_priority ?? Number.MAX_SAFE_INTEGER;
        const pb = b.project.global_priority ?? Number.MAX_SAFE_INTEGER;
        return pa - pb;
      });
      const rowEnds: Date[] = [];
      for (const bar of sortedBars) {
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
      sections.push({
        key: bucket.key,
        label: bucket.label,
        sortKey: bucket.sortKey,
        bars: sortedBars,
        rowCount: rowEnds.length,
      });
    }

    if (groupBy !== "none") {
      sections.sort((a, b) =>
        compareGroupBySortKey(
          { key: a.key, label: a.label ?? "", sortKey: a.sortKey },
          { key: b.key, label: b.label ?? "", sortKey: b.sortKey },
        ),
      );
    }

    return sections;
  }, [projects, colorBy, groupBy, users, lanes, teams, kpis, laneById, teamById, userById]);

  // Per-section vertical geometry. Computed alongside `bodyHeight`
  // so the render pass can look up each section's `barsTop`
  // without re-walking the section list. The map is keyed by
  // section key; the accompanying `bodyHeight` is the total
  // content height including the inter-section gaps.
  //
  // No header height is reserved — group section headers were
  // removed in favor of maximum vertical density. `SECTION_GAP`
  // between consecutive sections is the only visual separator
  // between groups now (subtle but bigger than the inter-row gap
  // so the boundary still reads). `groupBy === "none"` only ever
  // has one section, so the gap never triggers.
  const { sectionLayouts, bodyHeight, totalBarCount } = useMemo(() => {
    const layouts = new Map<string, { barsTop: number; height: number }>();
    let cursorY = 0;
    let bars = 0;
    for (let i = 0; i < packedSections.length; i++) {
      const section = packedSections[i]!;
      if (i > 0) cursorY += SECTION_GAP;
      const barsTop = cursorY;
      const barsHeight = section.rowCount * ROW_HEIGHT;
      layouts.set(section.key, { barsTop, height: barsHeight });
      cursorY = barsTop + barsHeight;
      bars += section.bars.length;
    }
    // Guarantee at least one row of body height so the empty-state
    // paint doesn't collapse the scroll container. The parent
    // renders a distinct empty-state block when there are no
    // bars, but the ResizeObserver still needs something to
    // measure.
    return {
      sectionLayouts: layouts,
      bodyHeight: Math.max(ROW_HEIGHT, cursorY),
      totalBarCount: bars,
    };
  }, [packedSections]);

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

  if (totalBarCount === 0) {
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
          : "card-surface overflow-x-auto overflow-y-clip"
      }
    >
      {/* Inner sizer defines the horizontal chart extent. The
          month header + the absolutely-positioned bar body both
          live inside so the single H-scroll on the parent moves
          them in lockstep — no JS listeners needed. Vertical
          content flows freely; the card grows to fit all packed
          sections and the parent RoadmapView pane handles page-
          level V scroll. */}
      <div style={{ width: chartWidth, position: "relative" }}>
        {/* MONTH HEADER — dark cells with month labels, matching
            the reference image. `sticky top-0` is kept in the
            markup as a graceful-degradation hint (harmless when
            the card no longer establishes its own vertical scroll
            container). Because `overflow-x: auto` on the card
            still makes it a scroll container per CSS, the header
            effectively pins to the card's own top rather than the
            outer page viewport — but since the card itself
            scrolls with the page there's no jarring detached
            behavior; the header simply scrolls off with the rest
            of the compact card once the user scrolls the page
            far enough. That's the accepted trade-off vs. a bigger
            refactor to detach the header from the H-scroll
            container and sync its `scrollLeft` via JS. */}
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

          {/* Bars only — group section headers were removed to keep
              the layout as vertically dense as possible. Groups
              still partition and pack independently; the only
              visual group separator is `SECTION_GAP` px of
              empty space between one section's last row and the
              next section's first row. */}
          {packedSections.flatMap((section) => {
            const layout = sectionLayouts.get(section.key);
            if (!layout) return [];
            return section.bars.map((bar) => {
              const p = bar.project;
              const x = differenceInCalendarDays(bar.startDate, start) * dayPx;
              const rawWidth = differenceInCalendarDays(bar.endDate, bar.startDate) * dayPx;
              const width = Math.max(MIN_BAR_WIDTH_PX, rawWidth);
              // Bar Y offsets are relative to the section's
              // `barsTop` — the packer numbers rows starting at 0
              // per section, and each section stacks below the
              // previous one plus its own header + inter-section
              // gap. See `sectionLayouts` for the accumulator.
              const top = layout.barsTop + bar.rowIndex * ROW_HEIGHT + BAR_PADDING;
              const height = ROW_HEIGHT - BAR_PADDING * 2;
              const textColor = readableOn(bar.color);

              // Visible-slice label offsets, in bar-relative pixel
              // coordinates.
              //
              // The bar rectangle keeps its full geometric span
              // (start_date → end_date) so the colored strip lines up
              // with the timeline exactly. The label, however, centers
              // within the ON-SCREEN portion of the bar so a project
              // whose start date is far in the past (bar left edge
              // scrolled off-screen to the left) still shows its
              // title in the visible right-hand slice. Without this,
              // long-running items rendered as invisible titles
              // anchored to the off-screen left edge (see bug repro
              // screenshot with "Ledger Service Re-Platform").
              //
              // `rawClampLeft` moves the label away from the bar's
              // own left edge only when today falls inside the bar's
              // span AND is itself on the chart — the same predicate
              // that gates the today marker line above, so the label
              // centering degrades gracefully when there's no today
              // line to anchor to (today off the right edge of the
              // chart, or bar entirely in the past). `clampRight` is
              // a symmetric defensive clamp against the chart's right
              // edge; in practice the chart range is derived from
              // bar spans so no bar overflows chartWidth, but the
              // check keeps the label anchored to the visible slice
              // if a future caller ever clips the chart tighter than
              // the placed bars.
              //
              // Second-pass adjustment: if the today-clamped slice
              // ends up narrower than `MIN_LABEL_WIDTH_PX`, expand
              // the label leftward (back into the past portion of
              // the bar) until we hit either the target width OR the
              // bar's own left edge — whichever comes first. Keeps
              // titles like "Coupon detail page redesign" legible on
              // bars that end just past today; without this, the
              // ~50-80px today→end slice truncated them to "Cou d..."
              // Bars wider than MIN_LABEL_WIDTH_PX overall retain the
              // visible-slice-centered behavior; bars narrower than
              // MIN_LABEL_WIDTH_PX overall keep the pre-floor
              // "whole bar is label" behavior because there's simply
              // no wider slice to reach for.
              const barLeft = x;
              const barRight = x + width;
              const barWidth = width;
              const rawClampLeft =
                showToday && todayX > barLeft && todayX < barRight
                  ? todayX - barLeft
                  : 0;
              const clampRight = barRight > chartWidth ? barRight - chartWidth : 0;
              const rawInnerWidth = barWidth - rawClampLeft - clampRight;
              let clampLeft = rawClampLeft;
              if (rawInnerWidth < MIN_LABEL_WIDTH_PX) {
                const deficit = MIN_LABEL_WIDTH_PX - rawInnerWidth;
                clampLeft = Math.max(0, rawClampLeft - deficit);
              }

              return (
                <button
                  type="button"
                  key={`${section.key}-${p.id}`}
                  onClick={() => onOpen(p.id)}
                  title={`${p.title}\n${format(bar.startDate, "MMM d, yyyy")} → ${format(bar.endDate, "MMM d, yyyy")}`}
                  className="absolute overflow-hidden rounded-md text-xs font-medium shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red focus-visible:ring-offset-1"
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
                  {/* Label container. Absolutely positioned inside
                      the button so the visible-slice clamp math can
                      move the label independently of the bar's
                      colored strip. `pointer-events-none` lets
                      clicks / hovers fall through to the button
                      (which owns onClick + title). `inset-y-0`
                      stretches the container to the full bar height
                      so `items-center` gives us vertical centering
                      at both the single-line and two-line-clamp
                      extremes; `justify-center` + `text-center`
                      center the title horizontally within the
                      visible slice.
                      Two-line title clamp:
                      `min-w-0 flex-1` is what lets the child shrink
                      inside the container's flex row — without it
                      the flex item's implicit minimum content width
                      would keep the title at its intrinsic length
                      and clip via the container's overflow rule
                      instead of ellipsizing at the end of line 2.
                      `line-clamp-2` is the Tailwind utility (built-
                      in in v3.3+, no plugin needed) that expands to
                      the canonical `-webkit-line-clamp: 2; display:
                      -webkit-box; -webkit-box-orient: vertical;
                      overflow: hidden;` combo. `leading-tight`
                      (1.25) tunes per-line height so two lines fit
                      in the 38px inner bar height with roughly
                      equal vertical padding above and below. */}
                  <div
                    className="pointer-events-none absolute inset-y-0 flex items-center justify-center overflow-hidden px-2"
                    style={{ left: clampLeft, right: clampRight }}
                  >
                    <span className="min-w-0 flex-1 text-center leading-tight line-clamp-2">
                      {p.title}
                    </span>
                  </div>
                </button>
              );
            });
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
