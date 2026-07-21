import type React from "react";
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { addDays, addMonths, differenceInCalendarDays, format, parseISO, startOfMonth } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, Layers, Lock, Star } from "lucide-react";
import { api } from "../lib/api";
import { reindexAfterMove } from "../lib/boardReorder";
import { computeOverloads, overloadsForProject, projectSpan, type OverloadInterval } from "../lib/capacity";
import { computeDeadlineStatuses, type DeadlineStatus } from "../lib/deadlines";
import {
  computeDependencyStatuses,
  groupDependenciesByPhase,
  type DependencyStatus,
  type PhaseKey,
} from "../lib/dependencies";
import { computePhases } from "../lib/phaseCompute";
import { computeEpicSubtaskSegments, type EpicSubtaskSegment } from "../lib/epicSegments";
import { useCanWrite, useKpis, useProjects } from "../lib/queries";
import { childrenByParent, descendants, indexById, rootEpic } from "../lib/hierarchy";
import {
  ALL_ZOOM_FALLBACK_DAY_PX,
  DAY_PX,
  HALF_INCH_PX,
  ROADMAP_LABEL_RESIZER_WIDTH_PX,
  computeRoadmapChartRange,
  computeRoadmapFitDayPx,
  computeRoadmapPdfDayPx,
  type Zoom,
} from "../lib/roadmapViewport";
import type { Kpi, Project, SwimLane, Team, User } from "../lib/types";
import {
  ROADMAP_LABEL_COLUMN_DEFAULT_PX,
  ROADMAP_LABEL_COLUMN_MAX_PX,
  ROADMAP_LABEL_COLUMN_MIN_PX,
  useViewStore,
  type ColorBy,
  type GroupBy,
  type RoadmapSort,
} from "../lib/viewState";
import { ColumnResizer } from "./ColumnResizer";

type Props = {
  projects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  colorBy: ColorBy;
  groupBy: GroupBy;
  zoom: Zoom;
  onOpen: (id: string) => void;
  /**
   * When true, disables drag-to-edit and swallows all mutation
   * attempts. Used by the auto-schedule proposal preview which
   * wants to render bars but not actually change the DB.
   */
  readOnly?: boolean;
  /**
   * Optional replacement for the workspace-wide project list used
   * to resolve dependency arrows and capacity overloads. Defaults
   * to `useProjects()`. The proposal preview supplies a merged
   * list where batch items are substituted with their proposed
   * dates so violations reflect the hypothetical schedule rather
   * than the persisted one.
   */
  contextProjects?: Project[];
  /**
   * When true, render for a PDF snapshot: clamp the left edge of the
   * chart to `today - 30 days` (regardless of zoom) so the exported
   * artefact focuses on the future, and fade the leftmost pixels of
   * any bar whose real span begins earlier than that so PDF readers
   * can see "this item extends off the visible history". Runs
   * alongside — not in place of — the zoom's normal range logic; the
   * `pdfMode` branch just overrides the resulting `start` after the
   * per-zoom `end` has been derived.
   *
   * PDF-only. The interactive roadmap must never set this so the
   * on-screen viewport (with the today-anchored past-inch buffer,
   * zoom-driven forward window, and interactive scroll) stays
   * unchanged.
   */
  pdfMode?: boolean;
  /**
   * Width (in CSS px) the left label column should render at right
   * now. Kept as a prop rather than reading the store directly so
   * callers that embed a chart in a preview modal (auto-schedule
   * proposal) can render at a fixed default without their tweaks
   * accidentally persisting to the interactive roadmap.
   *
   * When omitted, falls back to `ROADMAP_LABEL_COLUMN_DEFAULT_PX`
   * and the resize divider is not rendered — same layout as before
   * the resizer landed.
   */
  labelColumnPx?: number;
  /**
   * Called on every pointermove during a divider drag with the
   * clamped live width. Together with `onLabelColumnPxCommit` this
   * splits "cheap in-memory update" from "persisted write" so the
   * zustand persist middleware doesn't fire 60 times a second. When
   * either callback is omitted the divider is not rendered.
   */
  onLabelColumnPxChange?: (px: number) => void;
  /**
   * Called once per successful drag (on pointerup) with the final
   * clamped width. Callers should route this to the persisted
   * roadmap store slot. Not invoked on drag cancel (Escape /
   * pointercancel) so an aborted drag doesn't overwrite the
   * previously-saved value.
   */
  onLabelColumnPxCommit?: (px: number) => void;
  /**
   * When false (or when `pdfMode` is on), the chart renders as a
   * single monolithic SVG with no bounded scroll and no `sticky
   * top-0` on the date header — matching the pre-sticky layout.
   * The RoadmapHelper's proposal preview sets this to false so the
   * modal's own scrollbar continues to be the only one; a nested
   * `overflow-auto` on the Gantt would compete with the modal's
   * body scroll and hide rows behind the double-scrollbar UX the
   * comment on that preview call site explicitly warns against.
   *
   * Defaults to true so the main Roadmap view (and anything else
   * that mounts a full-featured Gantt) gets the pinned date band
   * without opting in.
   */
  stickyHeader?: boolean;
  /**
   * When true, top-level rows are rendered in the caller-provided
   * `projects` order instead of the default chronological
   * (start_date-ascending) sort. Used by the auto-schedule
   * proposal preview so that the user's drag-to-rank order in the
   * modal remains visible on the timeline — otherwise an item the
   * user ranked #2 can appear halfway down the chart just because
   * capacity/dependency constraints pushed its start_date later
   * than four unranked items placed before it. When omitted,
   * behavior is unchanged (byStart sort, as callers like
   * RoadmapView have relied on since day one).
   *
   * Only affects the top-level (root) row order — descendants
   * shown when an epic is expanded still sort by start_date so
   * expanded subtasks read left-to-right in time. That matches
   * the "epic is the primary unit" mental model and the drag-
   * to-rank UX ranks epics, not their children.
   *
   * Only respected when `groupBy === "none"`. Any other grouping
   * imposes its own primary order (owner, swim lane, etc.) and
   * ranking within a group is not part of the current UX.
   */
  preserveInputOrder?: boolean;
  /**
   * Roadmap-only sort mode. When set, the chart's top-level rows
   * are ordered by:
   *   - "startDate": earliest phase start ascending, honoring any
   *     per-group override in `overrideByGroup` first.
   *   - "priority": swim_lane.order → projects.position →
   *     updated_at desc → id. Same composite the Board view drives.
   *
   * When undefined (or when `preserveInputOrder` is true), the
   * chart falls back to its historical byStart behavior with no
   * drag-reorder affordance — matching every non-Roadmap caller
   * (auto-schedule preview, unit tests) that never opts in.
   */
  sortMode?: RoadmapSort;
  /**
   * Per-group user-authored order (only consulted when
   * `sortMode === "startDate"`). Key = the group key GanttTimeline
   * emits ("all" for ungrouped, group id or "__unassigned" bucket
   * key when grouped). Value = ordered list of top-level project
   * ids. Projects present in the group but absent from the list
   * fall to the end in default chronological order.
   */
  overrideByGroup?: Record<string, string[]>;
  /**
   * Fired when the user drags-to-reorder while `sortMode ===
   * "startDate"`. `orderedRootIds` is the group's new top-level
   * order after the drop. Caller persists this into the Roadmap
   * view-state store; GanttTimeline does not touch backend state
   * on this path.
   */
  onReorderOverride?: (groupKey: string, orderedRootIds: string[]) => void;
  /**
   * Fired when the user tried to drop a row across swim lanes
   * while `sortMode === "priority"`. The drag is snapped back
   * (no backend write, no view-state change) and the caller is
   * expected to surface a small toast — the Roadmap owns the
   * toast slot so the message can render outside the SVG shell.
   */
  onReorderCrossLaneRejected?: () => void;
  /**
   * Master gate for every conflict/warning visual on the chart —
   * capacity overloads (top-axis strip + icons, per-row overlays,
   * per-group overlays), the deadline-alert red triangle icon, the
   * dependency-alert broken-chain icon, and the "violated" color
   * variants of dependency arrows / deadline tick marks / per-phase
   * dependency chain icons.
   *
   * Defaults to `true` so any caller that predates this prop keeps
   * the historical warning-heavy render. The main Roadmap wires
   * this to the persisted `showConflicts` view-state slot so the
   * user's checkbox controls both the interactive Gantt AND the
   * PDF export (same DOM path). The auto-schedule proposal preview
   * explicitly passes `true` because seeing conflicts is the whole
   * point of reviewing a proposal.
   *
   * Only rendering is gated — violation computation still runs so
   * flipping the toggle back on immediately restores the same
   * indicators without a recompute pass.
   */
  showConflicts?: boolean;
};

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 48;
const GROUP_HEADER_HEIGHT = 28;
// Blank strip between groups so each swim of bars reads as its own
// unit. Rendered as un-shaded space; the header of the *next* group
// sits below it, aligned between the label column and the SVG.
const GROUP_GAP = 12;
const BAR_PADDING = 6;
/**
 * Pointer travel (in CSS px) before we treat a bar interaction as a
 * drag instead of a click-to-open. Kept intentionally forgiving —
 * trackpad + tap-to-click surfaces routinely register 2–4px of
 * incidental movement between pointerdown and pointerup, and losing
 * click-to-open to noise is worse than snapping a drag with an extra
 * 2px of slop.
 */
const CLICK_THRESHOLD_PX = 6;
const HANDLE_HITBOX_PX = 8;
// Per-depth indentation for the tree label column. Epics sit at depth 0
// against the left edge; each subtask level nudges inward so the tree
// shape reads at a glance without a heavy nested container. Kept tight
// so deep trees still fit in the label column.
const DEPTH_INDENT_PX = 14;
// Width of the label-column resize divider (matches Tailwind `w-1.5`
// / 6px). Referenced when the auto-fit sizer needs to subtract chrome
// from the scroll container's clientWidth to compute the true chart
// area. Re-exported from `roadmapViewport` so the sizing helper +
// this component share a single source of truth for the divider
// width — a future ColumnResizer visual redesign updates it in one
// place.
const LABEL_RESIZER_WIDTH_PX = ROADMAP_LABEL_RESIZER_WIDTH_PX;

/** One rendered row in the tree — an epic or an expanded descendant. */
type TreeRow = {
  project: Project;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
};

type DragMode = "move" | "target" | "devStart" | "devEnd" | "optStart" | "optEnd";

type DateFields = Pick<
  Project,
  | "start_date"
  | "target_date"
  | "dev_start_date"
  | "dev_end_date"
  | "optimization_start_date"
  | "optimization_end_date"
>;

type DragState = {
  projectId: string;
  mode: DragMode;
  pointerId: number;
  startClientX: number;
  captureEl: SVGElement;
  initial: DateFields;
  deltaDays: number;
  moved: boolean;
};

export function GanttTimeline(props: Props) {
  const {
    projects, lanes, teams, users, colorBy, groupBy, zoom, onOpen,
    readOnly, contextProjects, pdfMode,
    labelColumnPx, onLabelColumnPxChange, onLabelColumnPxCommit,
    stickyHeader = true,
    preserveInputOrder = false,
    sortMode,
    overrideByGroup,
    onReorderOverride,
    onReorderCrossLaneRejected,
    showConflicts = true,
  } = props;
  // Row reorder is only wired up on the main Roadmap view: the
  // auto-schedule proposal preview passes `preserveInputOrder=true`
  // and no `sortMode`, so it keeps the exact byStart-free rendering
  // path it always had (its own dnd-kit context in RoadmapHelper
  // handles that modal's ranking UX). Callers that DO pass a
  // sortMode opt in to both the ordering logic AND the drag
  // affordance atomically — this flag gates both.
  const rowReorderEnabled = !preserveInputOrder && sortMode !== undefined;
  // Two rendering shells share the same paint code: a monolithic SVG
  // (pdfMode OR when the caller has opted out of the sticky header)
  // and the sticky-header split layout. Consolidating the branching
  // through one flag keeps the JSX below tidy — pdfMode still gates
  // paint-server / fill decisions inside Bar itself.
  const useMonolithic = Boolean(pdfMode) || !stickyHeader;
  // Resolve the label column width. The resizer only participates
  // when the parent has wired all three of `labelColumnPx` +
  // `onLabelColumnPxChange` + `onLabelColumnPxCommit`, so a caller
  // that embeds this chart without those props (e.g. the
  // auto-schedule preview) simply gets the historical fixed width
  // with no divider — no accidental persistence surface, and no new
  // failure modes for existing callers.
  const resolvedLabelColumnPx = labelColumnPx ?? ROADMAP_LABEL_COLUMN_DEFAULT_PX;
  const canResizeLabelColumn =
    typeof labelColumnPx === "number"
    && typeof onLabelColumnPxChange === "function"
    && typeof onLabelColumnPxCommit === "function";
  // Per-tenant write gate: a user who's owner in RMN but viewer in
  // VC loses drag-to-edit as soon as they switch groups.
  // `readOnly` short-circuits that so the auto-schedule preview
  // stays inert even for admins.
  const canEditRaw = useCanWrite();
  const canEdit = readOnly ? false : canEditRaw;
  const expandedEpicIds = useViewStore((s) => s.expandedEpicIds);
  const toggleEpicExpanded = useViewStore((s) => s.toggleEpicExpanded);
  const expandAllEpics = useViewStore((s) => s.expandAllEpics);
  const collapseAllEpics = useViewStore((s) => s.collapseAllEpics);
  const expandedSet = useMemo(() => new Set(expandedEpicIds), [expandedEpicIds]);

  // Horizontal-scroll container ref. In the sticky-header layout
  // this points at the OUTER card (whose overflow-auto scrolls both
  // axes), and its clientWidth spans the whole Gantt (label +
  // resizer + chart). In the monolithic layout it points at the
  // inner CHART COLUMN — matching the pre-sticky behavior the
  // auto-schedule preview relies on — so its clientWidth already
  // represents just the chart area. `dayPx` reads the two cases
  // differently below. The `useMonolithic` dep keeps the observer
  // pointed at whichever element the current layout actually
  // mounts (pdfMode toggles swap the whole subtree).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    // Fires on browser resize AND on label-column-resize drags (the
    // resizer changes the sibling label column's width which reflows
    // this element's own clientWidth). One observer, both signals.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [useMonolithic]);

  // Chart date bounds + forward-timeframe length. Shared between the
  // interactive chart width (chartStart..chartEnd) and the auto-fit
  // sizer (which fits forwardDays into the visible chart area).
  // computeRoadmapChartRange encapsulates the interactive / PDF fork:
  //   * Interactive: past extends back to the earliest scheduled
  //     item (so ongoing projects render their leading edge and the
  //     initial-scroll snap has real past chart to reveal), forward
  //     extends to max(today + timeframe, latest scheduled item)
  //     plus a small buffer.
  //   * PDF: past hard-trimmed to today − 30, forward end same as
  //     interactive so the exported artefact stays timeframe-focused.
  // See the helper for the full formula + rationale.
  const { start, end, forwardDays } = useMemo(() => {
    const range = computeRoadmapChartRange({
      projects,
      zoom,
      pdfMode: pdfMode ?? false,
    });
    return { start: range.chartStart, end: range.chartEnd, forwardDays: range.forwardDays };
  }, [projects, zoom, pdfMode]);
  const totalDays = Math.max(1, differenceInCalendarDays(end, start));
  const dayPx = useMemo(() => {
    // PDF snapshot: force a fixed, screen-size-independent width so
    // the exported artefact drops nicely into a Google Slide
    // regardless of what the user's browser happened to be sized at
    // when they clicked Export. See `computeRoadmapPdfDayPx` for
    // the target-width rationale.
    if (pdfMode) return computeRoadmapPdfDayPx(totalDays, resolvedLabelColumnPx);
    // The monolithic layout (auto-schedule preview modal) keeps the
    // historical static per-zoom densities for the fixed zooms —
    // the modal owns its own horizontal scroll and PMs expect the
    // "typical" bar widths there. "all" zoom still auto-fits to the
    // measured chart column so multi-year previews stay on-screen;
    // fit against the full totalDays because the modal shows the
    // batch end-to-end without a forward-focused viewport.
    if (useMonolithic) {
      if (zoom !== "all") return DAY_PX[zoom];
      const fit = computeRoadmapFitDayPx({
        containerWidth,
        spanDays: totalDays,
        labelColumnPx: resolvedLabelColumnPx,
        subtractLabel: false,
        includeResizer: false,
      });
      return fit ?? ALL_ZOOM_FALLBACK_DAY_PX;
    }
    // Sticky-header roadmap: auto-fit the FORWARD portion of the
    // timeframe into the visible chart area (not the full chartStart
    // → chartEnd span). The chart itself extends further so past
    // dates render and stay reachable by scroll — sizing to
    // forwardDays keeps the day-column density tuned to the
    // upcoming work the user picked (3/6/12 months or the "all"
    // clamped forward-projection), regardless of how far back
    // ongoing projects pull the chart's left edge. Fallback to the
    // static per-zoom density until the container is measured on
    // first paint.
    const fit = computeRoadmapFitDayPx({
      containerWidth,
      spanDays: forwardDays,
      labelColumnPx: resolvedLabelColumnPx,
      subtractLabel: true,
      includeResizer: canResizeLabelColumn,
    });
    if (fit != null) return fit;
    return zoom === "all" ? ALL_ZOOM_FALLBACK_DAY_PX : DAY_PX[zoom];
  }, [
    pdfMode, useMonolithic, zoom, containerWidth, totalDays, forwardDays,
    resolvedLabelColumnPx, canResizeLabelColumn,
  ]);
  const chartWidth = totalDays * dayPx;

  const months = useMemo(() => {
    const out: Date[] = [];
    let cursor = startOfMonth(start);
    while (cursor <= end) {
      out.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    return out;
  }, [start, end]);

  // Build the tree: which projects have subtasks (for the chevron
  // affordance), and which roots exist in the current filtered set.
  // `byId` / `kids` derive from the *scheduled* list only — a subtask
  // whose parent isn't scheduled won't render as a top-level fallback
  // because the roadmap deliberately anchors on epics.
  const byId = useMemo(() => indexById(projects), [projects]);
  const kids = useMemo(() => childrenByParent(projects), [projects]);
  const rootIdsInSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of projects) {
      const rooted = rootEpic(p, byId);
      if (rooted) s.add(rooted.id);
    }
    return s;
  }, [projects, byId]);

  // KPI catalog is only needed when grouping by KPI, but the hook is
  // cheap (single cached query) and calling it unconditionally keeps
  // hook order stable across groupBy switches. Empty list falls out
  // when the workspace has no KPIs defined yet.
  const kpisQuery = useKpis();
  const kpis = kpisQuery.data ?? [];

  const groups = useMemo(
    () => groupTreeRows(
      projects, byId, kids, rootIdsInSet, expandedSet, groupBy,
      users, lanes, teams, kpis, preserveInputOrder,
      sortMode, overrideByGroup,
    ),
    [
      projects, byId, kids, rootIdsInSet, expandedSet, groupBy,
      users, lanes, teams, kpis, preserveInputOrder,
      sortMode, overrideByGroup,
    ],
  );

  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  // Row positions map — projectId → top Y of that row within the
  // BODY SVG (y=0 is the first row-bearing pixel below the header).
  // In the interactive layout the body renders inside its own SVG
  // whose y=0 sits directly below the sticky header, so body-local
  // coordinates are what dependency arrows / row hitboxes actually
  // want. The PDF monolith wraps the body in a single
  // <g transform="translate(0, HEADER_HEIGHT)"> so these same
  // coordinates land at the correct absolute Y there. Keeping the
  // math in one system means we don't have to fork the render loop.
  const rowPositions = useMemo(() => {
    const out = new Map<string, { rowY: number; project: Project }>();
    let cursorY = 0;
    groups.forEach((g, gi) => {
      if (gi > 0 && g.label) cursorY += GROUP_GAP;
      if (g.label) cursorY += GROUP_HEADER_HEIGHT;
      g.rows.forEach((row, idx) => {
        out.set(row.project.id, { rowY: cursorY + idx * ROW_HEIGHT, project: row.project });
      });
      cursorY += g.rows.length * ROW_HEIGHT;
    });
    return out;
  }, [groups]);

  // Total pixel height of the body content (everything below the
  // header strip). Used to size the body SVG in interactive mode and
  // to size the monolith's inner group in pdfMode. Also drives the
  // full-height fills of the "today" line and month gridlines in the
  // body SVG so they don't have to reach for a magic 9999.
  const bodyHeight = useMemo(() => (
    groups.reduce((s, g, gi) => (
      s
      + (gi > 0 && g.label ? GROUP_GAP : 0)
      + (g.label ? GROUP_HEADER_HEIGHT : 0)
      + g.rows.length * ROW_HEIGHT
    ), 0)
  ), [groups]);

  // Capacity overloads are a workspace-level truth, not a filtered one:
  // Alice is still overloaded on Aug 12 even if the current filter
  // hides half her projects. Read the full project list from the
  // query cache directly so filters on the Roadmap page don't distort
  // the picture.
  // When the caller supplies `contextProjects` (auto-schedule
  // preview), skip the workspace query entirely and use the passed
  // list — otherwise fall back to the live cache. The union type
  // means downstream memos treat the two paths identically.
  const allProjectsQuery = useProjects();
  const allProjectsList = contextProjects ?? allProjectsQuery.data ?? [];
  const overloads = useMemo(
    () => computeOverloads(allProjectsList, users, teams),
    [allProjectsList, users, teams],
  );

  // Dependencies compute against the WHOLE workspace, not the
  // filtered `projects` — an upstream project may be off-screen
  // (filtered / archived) but its dates still determine violations.
  // Same rationale as `overloads`. Deadlines are self-contained per
  // project but memoized here too so the render pass doesn't
  // recompute for every row on every drag frame.
  const allProjectsById = useMemo(
    () => new Map(allProjectsList.map((p) => [p.id, p])),
    [allProjectsList],
  );
  const deadlineStatusByProject = useMemo(() => {
    const out = new Map<string, DeadlineStatus[]>();
    for (const p of projects) out.set(p.id, computeDeadlineStatuses(p, lanesById));
    return out;
  }, [projects, lanesById]);
  const dependencyStatusByProject = useMemo(() => {
    const out = new Map<string, DependencyStatus[]>();
    for (const p of projects) {
      out.set(p.id, computeDependencyStatuses(p, lanesById, allProjectsById));
    }
    return out;
  }, [projects, lanesById, allProjectsById]);
  // Group overloads by entity id so the group-render loop below can
  // do an O(1) lookup instead of scanning the full list per group.
  const overloadsByOwner = useMemo(() => bucketOverloads(overloads, "owner"), [overloads]);
  const overloadsByTeam = useMemo(() => bucketOverloads(overloads, "team"), [overloads]);
  const anyOverloadDays = useMemo(() => computeAnyOverloadDays(overloads), [overloads]);
  // Cluster the flat day list back into contiguous [from, to] ranges,
  // one per visible alert icon on the top axis. A single icon per
  // range keeps the header uncluttered even if a range spans weeks.
  const anyOverloadRanges = useMemo(() => contiguousRanges(anyOverloadDays), [anyOverloadDays]);

  // Enable / disable the "expand all" affordance based on how many
  // epics could actually reveal subtasks. Keeps the UI honest — no
  // teasing users with a button that does nothing.
  const expandableEpics = useMemo(
    () => [...rootIdsInSet].filter((id) => (kids.get(id) ?? []).length > 0),
    [rootIdsInSet, kids],
  );
  const allExpanded = expandableEpics.length > 0
    && expandableEpics.every((id) => expandedSet.has(id));

  const today = new Date();
  const todayX = differenceInCalendarDays(today, start) * dayPx;
  const showToday = today >= start && today <= end;

  // Imperative scroll snap: after the chart is measured we position
  // the scroll container so today's x-coordinate sits ~half an inch
  // (48px) from the visible left edge, giving PMs a "today-first"
  // default with a small strip of past chart peeking out (visual
  // "you can scroll left" cue) and the bulk of the viewport devoted
  // to the forward-looking timeframe. Uses useLayoutEffect so the
  // scroll lands BEFORE paint — no visible snap from scrollLeft=0
  // to the target.
  //
  // Snap policy: fire ONCE per (zoom) selection, on the first commit
  // after the chart area is measured. Subsequent re-renders — label-
  // column drags, browser resizes, drag-to-edit rerenders — leave
  // the user's manual scrollLeft alone. `snappedZoomRef` records
  // the zoom the last snap was for; when the user picks a new zoom
  // that ref goes stale and we snap again. Browser resize is
  // deliberately NOT a re-snap trigger (spec): the user's current
  // scroll offset persists as much as makes sense (browser auto-
  // clamps if maxScrollLeft shrinks).
  //
  // Guard rails:
  //   * `pdfMode` skips entirely — the exporter captures scrollWidth
  //     directly and any scroll change here would just risk a
  //     visible jump when pdfMode toggles with the component
  //     mounted.
  //   * `containerWidth == null` skips — the initial render (before
  //     ResizeObserver measures) uses the static per-zoom fallback
  //     dayPx, which is off enough from the fitted value that
  //     snapping now would land in the wrong place. The next commit
  //     (with the measured width) fires this effect again and lands
  //     the correct scroll.
  //   * scrollLeft clamped to [0, maxScrollLeft] so tiny chart
  //     widths (all-in-viewport) don't produce a negative target
  //     the browser silently zeroes out.
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
    // Intentional dep list: only re-check the ref gate when zoom /
    // containerWidth / pdfMode changes. `start` and `dayPx` are read
    // via closure — always the most-recent memoized values on the
    // render that fired the effect — but re-listing them would fire
    // the effect during label-column drags and bar edits (which
    // recompute dayPx / start without changing zoom), and the ref
    // gate would then be pointless because we'd still be re-snapping
    // on every intermediate render before it caught up. Any actual
    // snap only reads fresh values because it happens on a zoom
    // change or the first post-measurement commit, both of which
    // land in `[zoom, containerWidth, pdfMode]`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, containerWidth, pdfMode]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const qc = useQueryClient();

  const patchMutation = useMutation({
    mutationFn: (v: { id: string; body: Partial<Project> }) =>
      api<Project>(`/projects/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["projects"] });
      const prev = qc.getQueryData<Project[]>(["projects"]);
      if (prev) {
        qc.setQueryData<Project[]>(["projects"], prev.map((p) => (p.id === v.id ? { ...p, ...v.body } : p)));
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["projects"], ctx.prev);
      const msg = err instanceof Error ? err.message : "Roadmap change didn't save. Try again.";
      alert(msg);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  function startDrag(e: React.PointerEvent, projectId: string, mode: DragMode) {
    // Note: we enter this branch for BOTH editors and viewers. Viewers
    // can't actually edit dates (see onPointerMove below), but we still
    // need the pointer-capture + release plumbing so that a
    // pointerdown/pointerup with no movement in-between fires
    // onOpen(projectId). Early-returning here would silently swallow
    // click-to-open for viewers.
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return;
    // For viewers, only the whole-bar "move" gesture is meaningful as a
    // click target. Resize handles are hidden from them anyway, but
    // guard so a stray handle still can't wedge state.
    if (!canEdit && mode !== "move") return;
    e.stopPropagation();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    const next: DragState = {
      projectId,
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      captureEl: el,
      initial: {
        start_date: proj.start_date,
        target_date: proj.target_date,
        dev_start_date: proj.dev_start_date,
        dev_end_date: proj.dev_end_date,
        optimization_start_date: proj.optimization_start_date,
        optimization_end_date: proj.optimization_end_date,
      },
      deltaDays: 0,
      moved: false,
    };
    // Sync ref immediately so a fast pointerdown → pointerup (a
    // click, ~1 frame) can find the drag state in endDrag before
    // React has committed the render from setDrag. Without this the
    // click-to-open path silently drops onOpen on fast clicks.
    dragRef.current = next;
    setDrag(next);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    // Viewers only use the pointerdown/up bookends for click-to-open;
    // never mutate delta so the bar stays visually still while they
    // wiggle over it and endDrag's !moved branch still fires.
    if (!canEdit) return;
    const dx = e.clientX - d.startClientX;
    // Every drag mode snaps to whole days now that phase lengths are
    // stored as explicit dates rather than integer week counts.
    const raw = dx / dayPx;
    const snapped = Math.round(raw);
    const clamped = clampDelta(d, snapped);
    if (clamped !== d.deltaDays || (!d.moved && Math.abs(dx) > CLICK_THRESHOLD_PX)) {
      const next = { ...d, deltaDays: clamped, moved: d.moved || Math.abs(dx) > CLICK_THRESHOLD_PX };
      // Keep ref + state in lockstep — same rationale as startDrag.
      dragRef.current = next;
      setDrag(next);
    }
  }

  function endDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    // Clear ref before doing anything else so a synthetic click event
    // that fires later (React emits one after pointerup on the same
    // element) can't accidentally re-enter this handler with stale
    // state.
    dragRef.current = null;
    if (!d.moved) {
      onOpen(d.projectId);
      setDrag(null);
      return;
    }
    // Belt-and-suspenders: onPointerMove already returns early for
    // viewers, but if a viewer somehow ended up with moved=true (e.g.
    // future changes flip the guard), refuse to mutate.
    if (!canEdit) {
      setDrag(null);
      return;
    }
    const proj = projects.find((p) => p.id === d.projectId);
    if (proj) {
      const next = applyDragToProject(proj, d);
      const diff = diffProject(proj, next);
      if (Object.keys(diff).length > 0) {
        patchMutation.mutate({ id: d.projectId, body: diff });
      }
    }
    setDrag(null);
    void e; // no-op, keep signature aligned with pointer events
  }

  // Row-reorder mutation. Used only by the Priority-mode drag path
  // (see `handleReorderEnd`); Start-date mode routes to the parent's
  // `onReorderOverride` callback instead and never touches backend
  // state. Wire is deliberately identical to BoardView.tsx's
  // `moveMutation` — same endpoint, same optimistic-cache write via
  // the shared `reindexAfterMove` helper, same rollback-on-error
  // shape — so a Priority-mode drag on the Roadmap and a card drag
  // on the Board produce indistinguishable server side effects.
  const moveMutation = useMutation({
    mutationFn: (v: { id: string; swim_lane_id: string | null; position: number; _prev: Project[] | undefined }) =>
      api(`/projects/${v.id}/move`, {
        method: "POST",
        body: JSON.stringify({ swim_lane_id: v.swim_lane_id, position: v.position }),
      }),
    onError: (err, v) => {
      if (v._prev) qc.setQueryData(["projects"], v._prev);
      const msg = err instanceof Error ? err.message : "Reorder didn't save. Try again.";
      alert(msg);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
    },
  });

  // dnd-kit sensor for the label-column reorder handle. `distance: 4`
  // gives the user 4px of pointer slack before a drag starts so a
  // click on the grip (or accidental micro-movement while releasing
  // over the row) doesn't kick off a spurious reorder. Matches the
  // Board view's own PointerSensor config exactly.
  const reorderSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Chunk each group's flat `rows` list into per-root clusters —
  // each cluster is a top-level row plus any expanded subtask rows
  // underneath it. Sortable items are keyed by the root's project
  // id so the DndContext only ever moves root-level items; subtask
  // rows ride along inside their cluster and are not directly
  // reorderable. Recomputes on every render (cheap: single pass
  // over each group's rows), which keeps the label DOM in lockstep
  // with the current `groups` shape as filters / grouping change.
  const clustersByGroup = groups.map((g) => ({
    key: g.key,
    label: g.label,
    color: g.color,
    rowCount: g.rows.length,
    clusters: clusterRootsWithSubtasks(g.rows),
  }));

  function handleReorderEnd(e: DragEndEvent) {
    if (!rowReorderEnabled) return;
    if (!canEdit) return;
    // Sortable ids are `${groupKey}::${rootId}` — see
    // `makeSortableId` — so the same underlying project can
    // participate in multiple SortableContexts (team + kpi
    // groupings intentionally duplicate roots across groups)
    // without dnd-kit's droppable registry colliding. Decode
    // both endpoints before doing any group / project lookup.
    const activeParts = parseSortableId(String(e.active.id));
    const overParts = e.over ? parseSortableId(String(e.over.id)) : null;
    if (!activeParts || !overParts) return;
    if (e.active.id === e.over?.id) return;
    // Reject cross-group drops outright. Multi-value groupings
    // (team, kpi) duplicate the same project across groups, but a
    // reorder still only moves the project within a single group;
    // there's no coherent "cross-group" reorder for those cases.
    const activeGroupKey = activeParts.groupKey;
    const overGroupKey = overParts.groupKey;
    if (activeGroupKey !== overGroupKey) return;
    const cg = clustersByGroup.find((x) => x.key === activeGroupKey);
    if (!cg) return;
    const rootIds = cg.clusters.map((c) => c.rootId);
    const activeId = activeParts.rootId;
    const overId = overParts.rootId;
    const oldIndex = rootIds.indexOf(activeId);
    const newIndex = rootIds.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const nextOrder = arrayMove(rootIds, oldIndex, newIndex);

    if (sortMode === "priority") {
      const activeProject = byId.get(activeId);
      const overProject = byId.get(overId);
      if (!activeProject || !overProject) return;
      // Same-lane restriction: the priority rank is per swim lane
      // (matches the Board view's SortLane semantics), so a drop
      // that crosses swim lanes has no unambiguous per-lane
      // position to write. Reject the drop, snap back, and fire
      // the "cross-lane rejected" callback so the parent can
      // surface a small toast telling the user how to move
      // between lanes (which is a Board-view action).
      if (activeProject.swim_lane_id !== overProject.swim_lane_id) {
        onReorderCrossLaneRejected?.();
        return;
      }
      // Compute the new per-lane position from the FULL workspace
      // cache — not just the visible rootIds — so the target index
      // matches what the /projects/:id/move endpoint will clamp
      // against server-side. Uses the same reindex helper the
      // Board view drives, so priority-drag writes are byte-for-
      // byte identical to a card drag on the Board.
      const cacheSnapshot = qc.getQueryData<Project[]>(["projects"]);
      if (!cacheSnapshot) return;
      const laneItems = cacheSnapshot
        .filter((p) => p.swim_lane_id === activeProject.swim_lane_id && !p.deleted_at)
        .sort((a, b) => a.position - b.position);
      const laneIdxByProject = new Map(laneItems.map((p, i) => [p.id, i] as const));
      // Translate the visible-only new position into an absolute
      // per-lane position by inspecting the neighbour on either
      // side inside `nextOrder`. If the moved item now sits just
      // after some visible project X in the same lane, we place
      // it right after X in the cache; if it now sits just before
      // Y, we place it right before Y. Falls back to the target's
      // absolute position when both neighbours are unreachable.
      let targetPosition: number;
      if (newIndex === 0) {
        targetPosition = 0;
      } else {
        const beforeVisible = nextOrder[newIndex - 1];
        const beforeProject = beforeVisible ? byId.get(beforeVisible) : undefined;
        if (beforeProject && beforeProject.swim_lane_id === activeProject.swim_lane_id) {
          const beforeIdx = laneIdxByProject.get(beforeProject.id) ?? -1;
          // If moving down (past its old position), the array-move
          // math means we insert AT beforeIdx (since removing the
          // moved item shifts subsequent indices down by one).
          const oldAbs = laneIdxByProject.get(activeProject.id) ?? -1;
          targetPosition = beforeIdx >= oldAbs && oldAbs >= 0 ? beforeIdx : beforeIdx + 1;
        } else {
          targetPosition = laneIdxByProject.get(overProject.id) ?? 0;
        }
      }
      // Optimistic cache write + mutation fire. Matches the
      // BoardView pattern exactly.
      qc.cancelQueries({ queryKey: ["projects"] });
      const optimistic = reindexAfterMove(cacheSnapshot, activeProject.id, activeProject.swim_lane_id, targetPosition);
      qc.setQueryData<Project[]>(["projects"], optimistic);
      moveMutation.mutate({
        id: activeProject.id,
        swim_lane_id: activeProject.swim_lane_id,
        position: targetPosition,
        _prev: cacheSnapshot,
      });
      return;
    }

    // Start-date mode: record the group's manual order in the
    // view-state store. No backend call, no cache write — the
    // sort is purely view-local and the "Custom order" chip is
    // the user's visual confirmation that the natural
    // chronological sort has been overridden.
    onReorderOverride?.(activeGroupKey, nextOrder);
  }

  // Label column body — group headers + row labels. Shared between
  // the pdfMode monolith path and the interactive sticky-header
  // path so a change to the label-side visuals only has to be made
  // in one place.
  //
  // When `rowReorderEnabled` is true the whole label column is
  // wrapped in a DndContext that owns the drag handlers; individual
  // clusters register with a per-group SortableContext so drops
  // only reorder within their own group (cross-group drags snap
  // back). When reorder is disabled (auto-schedule preview / PDF
  // export / any caller that doesn't pass a `sortMode`) the same
  // DOM renders inside a no-op fragment — no dnd-kit listeners,
  // no grip handles, identical to the pre-feature layout.
  const labelBodyInner = clustersByGroup.map((cg, gi) => {
    const clusters = cg.clusters;
    const rootIds = clusters.map((c) => c.rootId);
    // Every cluster inside a group shares the same containerId so
    // the drag-end handler can cheaply reject drops that cross
    // group boundaries (see `data.current.groupKey`).
    const contextId = `roadmap-sort:${cg.key}`;
    const groupClusters = (
      <>
        {clusters.map((cluster) => (
          <SortableLabelCluster
            key={cluster.rootId}
            cluster={cluster}
            groupKey={cg.key}
            reorderEnabled={rowReorderEnabled && canEdit}
            onOpen={onOpen}
            onToggleExpand={toggleEpicExpanded}
          />
        ))}
      </>
    );
    return (
      <div key={`labels-${cg.key}`}>
        {/* Blank strip separating this group from the previous one.
            Matches the same-height gap in the SVG column so the
            labels and bars stay aligned row-for-row. */}
        {gi > 0 && cg.label ? <div style={{ height: GROUP_GAP }} /> : null}
        {cg.label ? (
          <div
            className="flex items-center justify-between border-b border-wp-stone bg-wp-stone/30 px-3 text-xs font-semibold uppercase tracking-wide text-wp-slate"
            style={{ height: GROUP_HEADER_HEIGHT }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {/* KPI grouping keys off the KPI's canonical color, so
                  we show the same swatch users see in the KPI report
                  / picker. Other groupings don't set g.color and
                  render label-only. */}
              {cg.color ? (
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: cg.color }}
                />
              ) : null}
              <span className="truncate">{cg.label}</span>
            </span>
            <span>{cg.rowCount}</span>
          </div>
        ) : null}
        {rowReorderEnabled ? (
          <SortableContext
            id={contextId}
            items={rootIds.map((rid) => makeSortableId(cg.key, rid))}
            strategy={verticalListSortingStrategy}
          >
            {groupClusters}
          </SortableContext>
        ) : (
          groupClusters
        )}
      </div>
    );
  });
  const labelBody = rowReorderEnabled ? (
    <DndContext
      sensors={reorderSensors}
      collisionDetection={closestCenter}
      onDragEnd={handleReorderEnd}
    >
      {labelBodyInner}
    </DndContext>
  ) : (
    labelBodyInner
  );

  // Shared paint-server definitions (phase hatch, awaiting-dev hatch,
  // mixed-phase polka, PDF fade). Both SVGs (pdfMode monolith AND
  // interactive body) need these because Bars are rendered in
  // whichever body context is active; the interactive header SVG
  // doesn't reference any url(#...) fills so it goes without its
  // own <defs>.
  const defsBlock = (
    <defs>
      <pattern id="phase-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="transparent" />
        <rect width="2" height="6" fill="rgba(255,255,255,0.55)" />
      </pattern>
      <pattern id="awaiting-dev-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="6" height="6" fill="transparent" />
        <rect width="1.25" height="6" fill="#94a3b8" />
      </pattern>
      {/* Polka dot overlay for epic bar days where subtasks span
          multiple phases at once. Chosen to look clearly distinct
          from the diagonal phase-hatch so "mixed" reads as
          different-from-any-single-phase at a glance. */}
      <pattern id="mixed-polka" width="7" height="7" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="transparent" />
        <circle cx="3.5" cy="3.5" r="1.4" fill="rgba(255,255,255,0.8)" />
      </pattern>
      {/* PDF-only left-edge fade. Overlaid as a white → transparent
          gradient on the leftmost ~16px of any bar whose real span
          extends earlier than the PDF viewport start (today - 30d),
          so readers see the bar visually dissolving into the page
          rather than a hard cut. Defined here rather than per-Bar
          so every affected row references the same gradient id.
          Interactive (non-PDF) rendering never references it, so
          its presence is a no-op cost. */}
      <linearGradient id="pdf-fade-left" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
    </defs>
  );

  // HEADER content — the month/tick strip, the "any overload" strip
  // on the top axis, and the header half of the today line. Renders
  // inside its own SVG in interactive mode (which is what stays
  // pinned via `sticky top-0`), and inline in the pdfMode monolith
  // path so the exporter still sees one continuous SVG.
  const headerBlock = (
    <>
      <g>
        {months.map((m, i) => {
          const x = differenceInCalendarDays(m, start) * dayPx;
          return (
            <g key={i}>
              <line x1={x} y1={0} x2={x} y2={HEADER_HEIGHT} stroke="#E4E7EB" />
              {/* Header labels compress as the timeframe widens.
                  "3mo" / "6mo" have room for "MMM d"; "1yr" is too
                  dense so we drop the day and add the year. "all"
                  also uses "MMM yyyy" because the span can easily
                  cover multiple years, and a bare "Jan" without a
                  year would be ambiguous. */}
              <text x={x + 4} y={18} fontSize={11} fill="#475467">
                {format(m, (zoom === "1yr" || zoom === "all") ? "MMM yyyy" : "MMM d")}
              </text>
              {zoom === "6mo" ? (
                <text x={x + 4} y={34} fontSize={9} fill="#98A2B3">
                  {format(m, "yyyy")}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* Global overload indicator on the top axis: continuous red
          strip along the affected days for glanceability + one
          alert icon per contiguous range that reveals a rich
          tooltip on hover ("Roland assigned 4 tasks, over maximum
          of 3"). Renders in every grouping mode so PMs never lose
          sight of a breach the current grouping happens to hide.
          Suppressed entirely when the parent has toggled
          `showConflicts` off — this is a capacity-conflict visual,
          exactly what that toggle exists to hide. */}
      {showConflicts && anyOverloadDays.length > 0 ? (
        <g>
          <g pointerEvents="none">
            {anyOverloadDays.map((iso, i) => (
              <rect
                key={`ov-day-${i}`}
                x={dayX(iso, start, dayPx)}
                y={HEADER_HEIGHT - 6}
                width={Math.max(1, dayPx)}
                height={6}
                fill="#DC2626"
                fillOpacity={0.9}
              />
            ))}
          </g>
          {anyOverloadRanges.map((rng, i) => {
            // Icon sits above the strip, centered over the range.
            // Clamp the range in chart-space so a range extending
            // off-chart still shows an icon near the edge instead
            // of vanishing.
            const x1 = dayX(rng.from, start, dayPx);
            const x2 = dayX(rng.to, start, dayPx) + dayPx;
            const cx = Math.max(10, Math.min(chartWidth - 10, (x1 + x2) / 2));
            const cy = HEADER_HEIGHT - 14;
            const relevant = overloads.filter(
              (iv) => !(iv.to < rng.from || iv.from > rng.to),
            );
            return (
              <OverloadTooltip
                key={`ov-cluster-${i}`}
                content={
                  <OverloadTooltipContent
                    title="Capacity overload"
                    range={rng}
                    entries={relevant}
                    users={users}
                    teams={teams}
                  />
                }
              >
                <g className="cursor-help">
                  {/* Larger transparent hit target so hover feels
                      forgiving even at r=6. */}
                  <circle cx={cx} cy={cy} r={11} fill="transparent" />
                  <circle cx={cx} cy={cy} r={7} fill="#DC2626" stroke="white" strokeWidth={1.5} />
                  <text
                    x={cx}
                    y={cy + 4}
                    fontSize={11}
                    fill="white"
                    textAnchor="middle"
                    fontWeight={700}
                    pointerEvents="none"
                  >
                    !
                  </text>
                </g>
              </OverloadTooltip>
            );
          })}
        </g>
      ) : null}

      {/* Today line — header half. Split from the body half so
          interactive mode can render each in its own SVG while
          keeping the pdfMode monolith visually identical (both
          halves live in the same SVG there). The "4 4" dash
          pattern tiles evenly across HEADER_HEIGHT=48px, so the
          join into the body's dashed line is seamless. */}
      {showToday ? (
        <g>
          <line
            x1={todayX}
            y1={0}
            x2={todayX}
            y2={HEADER_HEIGHT}
            stroke="#DC2626"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
          <text x={todayX + 4} y={12} fontSize={10} fill="#DC2626">Today</text>
        </g>
      ) : null}
    </>
  );

  // BODY content — vertical body gridlines, per-group row bars +
  // overloads, dependency arrows, and the body half of the today
  // line. All rendered with body-local coordinates (y=0 is the
  // first row-bearing pixel). In interactive mode this renders
  // inside its own SVG whose top edge sits directly under the
  // sticky header. In pdfMode the caller wraps it in
  // <g transform="translate(0, HEADER_HEIGHT)"> so it lands at the
  // correct absolute Y inside the monolith.
  const bodyBlock = (
    <>
      <g>
        {/* Body-only vertical gridlines at month boundaries. The
            darker top-strip lines are drawn in headerBlock; these
            are the lighter continuation that reaches the bottom of
            the chart. */}
        {months.map((m, i) => {
          const x = differenceInCalendarDays(m, start) * dayPx;
          return <line key={i} x1={x} y1={0} x2={x} y2={bodyHeight} stroke="#F2F4F7" />;
        })}
      </g>

      {(() => {
        let cursorY = 0;
        return groups.map((g, gi) => {
          // Insert the between-group blank strip before the header
          // of every group except the first. Skipped for
          // label-less renders (groupBy === "none").
          if (gi > 0 && g.label) cursorY += GROUP_GAP;
          const groupStartY = cursorY;
          if (g.label) cursorY += GROUP_HEADER_HEIGHT;
          const rowsTop = cursorY;
          // Per-row transparent rect stretching the full chart
          // width. Sits BEHIND the bar + overload overlays in paint
          // order so a click on empty row space (past the bar's
          // right edge, before its left edge, or in an
          // awaiting-dev / awaiting-opt gap that isn't covered by
          // the bar) opens the project detail panel. Bar clicks
          // are still handled by the bar's own pointer-up → onOpen
          // path so we don't double-fire; overload tooltips get
          // their own onClick further down to preserve the click
          // affordance where they paint over this rect.
          const rowHitRects: React.ReactNode[] = g.rows.map((row, idx) => {
            const p = row.project;
            const rowY = cursorY + idx * ROW_HEIGHT;
            return (
              <rect
                key={`row-hit-${p.id}`}
                x={0}
                y={rowY}
                width={chartWidth}
                height={ROW_HEIGHT}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onClick={() => onOpen(p.id)}
              />
            );
          });
          const rowOverloadOverlays: React.ReactNode[] = [];
          const rows = g.rows.map((row, idx) => {
            const p = row.project;
            const rowY = cursorY + idx * ROW_HEIGHT;
            const activeDrag = drag?.projectId === p.id ? drag : null;
            const previewProject = activeDrag ? applyDragToProject(p, activeDrag) : p;

            // Per-row hatches for the "other" dimension: when
            // grouped by team, per-group overlays only show TEAM
            // overloads — so the OWNER-overload signal is lost
            // unless we paint it on the row itself. Same in
            // reverse when grouped by owner. In non-entity grouping
            // (lane/tag/none) we paint both dimensions on the row.
            //
            // Suppressed wholesale when `showConflicts` is off:
            // per-row overload paint is a capacity-conflict indicator
            // by construction, so an empty rowIvs list drops it
            // cleanly without touching the computation upstream.
            const showOwnerOnRow = groupBy !== "owner";
            const showTeamOnRow = groupBy !== "team";
            const rowIvs = showConflicts
              ? overloadsForProject(overloads, previewProject).filter((iv) =>
                  (iv.kind === "owner" && showOwnerOnRow) || (iv.kind === "team" && showTeamOnRow)
                )
              : [];
            for (const iv of rowIvs) {
              const span = projectSpan(previewProject);
              if (!span) continue;
              const from = iv.from > span.start ? iv.from : span.start;
              const to = iv.to < span.end ? iv.to : span.end;
              if (from > to) continue;
              const x1 = dayX(from, start, dayPx);
              const x2 = dayX(to, start, dayPx) + dayPx;
              const w = Math.max(0, x2 - x1);
              if (w <= 0) continue;
              rowOverloadOverlays.push(
                <OverloadTooltip
                  key={`row-ov-${p.id}-${iv.kind}-${iv.entityId}-${iv.from}`}
                  content={
                    <OverloadTooltipContent
                      title="Capacity overload on this project"
                      range={{ from, to }}
                      entries={[iv]}
                      users={users}
                      teams={teams}
                    />
                  }
                >
                  <g className="cursor-help">
                    <rect x={x1} y={rowY + 2} width={w} height={ROW_HEIGHT - 4} fill="#DC2626" fillOpacity={0.06} />
                    <rect x={x1} y={rowY + ROW_HEIGHT - 3} width={w} height={2} fill="#DC2626" fillOpacity={0.7} />
                  </g>
                </OverloadTooltip>
              );
            }

            return (
              <Bar
                key={p.id}
                project={previewProject}
                y={rowY}
                chartStart={start}
                dayPx={dayPx}
                lanes={lanes}
                teams={teams}
                users={users}
                colorBy={colorBy}
                canEdit={canEdit}
                activeDrag={activeDrag}
                onStartDrag={startDrag}
                onOpen={onOpen}
                deadlineStatuses={deadlineStatusByProject.get(p.id) ?? []}
                dependencyStatuses={dependencyStatusByProject.get(p.id) ?? []}
                isSubtask={row.depth > 0}
                kids={kids}
                pdfMode={pdfMode ?? false}
                showConflicts={showConflicts}
              />
            );
          });
          cursorY += g.rows.length * ROW_HEIGHT;
          // Overload overlay: only meaningful when the group key IS
          // an entity id (owner or team mode). We paint a
          // translucent red band across the group's Y range for
          // each overloaded date interval, so PMs can see at a
          // glance which weeks the owner/team is over their cap.
          //
          // Suppressed wholesale when `showConflicts` is off — this
          // is a capacity-conflict visual, exactly what that toggle
          // exists to hide. Empty list flows through the map below
          // and paints nothing.
          const groupOverloads: OverloadInterval[] = !showConflicts
            ? []
            : groupBy === "owner"
              ? overloadsByOwner.get(g.key) ?? []
              : groupBy === "team"
              ? overloadsByTeam.get(g.key) ?? []
              : [];
          const overloadOverlays = groupOverloads.map((iv, ii) => {
            const x1 = dayX(iv.from, start, dayPx);
            // Right edge = end-of-day, so a single-day overload is
            // at least `dayPx` wide.
            const x2 = dayX(iv.to, start, dayPx) + dayPx;
            const w = Math.max(0, x2 - x1);
            if (w <= 0) return null;
            const y = groupStartY;
            const h = cursorY - groupStartY;
            return (
              <OverloadTooltip
                key={`ov-${g.key}-${ii}`}
                content={
                  <OverloadTooltipContent
                    title="Capacity overload"
                    range={{ from: iv.from, to: iv.to }}
                    entries={[iv]}
                    users={users}
                    teams={teams}
                  />
                }
              >
                <g className="cursor-help">
                  <rect x={x1} y={y} width={w} height={h} fill="#DC2626" fillOpacity={0.08} />
                  <rect x={x1} y={y} width={w} height={3} fill="#DC2626" fillOpacity={0.55} />
                </g>
              </OverloadTooltip>
            );
          });
          void rowsTop;
          return (
            <g key={`grp-${g.key}`}>
              {/* Hit rects go first so everything else paints (and
                  hit-tests) on top of them. Group header rows have
                  no project association, so they intentionally
                  have NO hit rect and stay non-interactive. */}
              {rowHitRects}
              {g.label ? (
                <rect x={0} y={groupStartY} width={chartWidth} height={GROUP_HEADER_HEIGHT} fill="#F2F4F7" />
              ) : null}
              {overloadOverlays}
              {rowOverloadOverlays}
              {rows}
            </g>
          );
        });
      })()}

      {/* Dependency arrows between visible pairs. Drawn AFTER bars
          so they sit on top of hatched phase fills, but before the
          today-line so today stays the most prominent vertical
          marker. Arrows only render when BOTH endpoints are in the
          current rowset (per product decision — off-chart arrows to
          nowhere are noisy). */}
      <g pointerEvents="none">
        {(() => {
          const arrows: React.ReactNode[] = [];
          const rowMid = ROW_HEIGHT / 2;
          for (const p of projects) {
            const from = rowPositions.get(p.id);
            if (!from) continue;
            const statuses = dependencyStatusByProject.get(p.id) ?? [];
            for (const s of statuses) {
              if (!s.otherProject || !s.thisStart || !s.otherEnd) continue;
              const other = rowPositions.get(s.otherProject.id);
              if (!other) continue;
              // Bar geometry: bar goes from dayX(phase.start) to
              // dayX(phase.end). NO +dayPx on the end — the bar's
              // right edge lands at the left edge of the end-date
              // day. Adding dayPx put the arrow's source one full
              // day past the visible bar, hence the misalignment.
              const x1 = dayX(dateOnly(s.otherEnd), start, dayPx);
              const y1 = other.rowY + rowMid;
              const x2 = dayX(dateOnly(s.thisStart), start, dayPx);
              const y2 = from.rowY + rowMid;
              arrows.push(
                <DependencyArrow
                  key={`arrow-${s.dep.id}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  // Force the arrow's informational (slate) styling
                  // when `showConflicts` is off — the dotted line
                  // stays visible as a wayfinding aid per the prior
                  // spec, only the red "violated" color variant is
                  // suppressed.
                  violated={showConflicts && s.severity === "violated"}
                />,
              );
            }
          }
          return arrows;
        })()}
      </g>

      {/* Today line — body half. Drawn in the body SVG so it stays
          in lockstep with the header half (both share the same
          chart's H-scroll offset because they're inside the same
          scroll container). The "Today" text label lives in the
          header only; here we just carry the dashed vertical line
          down through the row bars. */}
      {showToday ? (
        <line
          x1={todayX}
          y1={0}
          x2={todayX}
          y2={bodyHeight}
          stroke="#DC2626"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      ) : null}
    </>
  );

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-wp-slate">
        <button
          type="button"
          onClick={() => {
            if (allExpanded) collapseAllEpics();
            else expandAllEpics(expandableEpics);
          }}
          disabled={expandableEpics.length === 0}
          className="rounded border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink hover:border-wp-red/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {allExpanded ? "Collapse all subtasks" : "Expand all subtasks"}
        </button>
        <span>
          Epics only by default — click <ChevronRight size={11} className="inline align-[-2px]" /> next to an epic to reveal its subtasks.
        </span>
      </div>
      {/* Two rendering paths share the same paint code (labelBody,
          headerBlock, bodyBlock, defsBlock) but wire them into very
          different DOM shells:
            - useMonolithic (pdfMode OR stickyHeader=false):
              single monolithic SVG inside a plain flex row, matching
              the shape html-to-image's foreignObject clone and the
              auto-schedule preview's modal wrapper have always seen.
              pdfMode additionally drops the chart column's own
              overflow-x-auto so the exporter captures the SVG at its
              natural scrollWidth; the RoadmapHelper preview keeps
              the H-scroll on the chart column so the modal's outer
              scrollbar and the Gantt's inner one don't compete.
              Sticky positioning is deliberately absent here — an
              intermediate sticky ancestor has been observed to
              confuse Chromium's SVG raster in the exported PNG, and
              the preview's own modal body owns vertical scroll.
            - sticky-header layout: ONE scroll container handles BOTH
              axes. The header row is `sticky top-0` so it pins to
              the container's top as the user scrolls down. Because
              the header lives INSIDE the same H-scroll parent as
              the body, they share the horizontal scroll offset
              without a JS listener — CSS is enough. The label
              column inside each row uses `sticky left-0` so
              horizontal scroll doesn't orphan the project titles
              (matches the pre-refactor UX where the label sat
              OUTSIDE the chart's own overflow-x-auto pane).
          The scrollRef points at whichever element is the actual
          H-scroll parent in each path: the CHART COLUMN in the
          monolithic layout (matching pre-refactor behavior for the
          auto-schedule preview), and the OUTER card in the sticky
          layout (whose overflow-auto handles both axes). The
          `useLayoutEffect` that installs the ResizeObserver keeps
          `useMonolithic` in its dep list so a mode flip re-hooks
          onto the new element cleanly. */}
      <div
        ref={useMonolithic ? null : scrollRef}
        // `data-roadmap-capture-root` marks this element as the
        // capture target for the "Copy image to clipboard" button in
        // RoadmapView. It wraps both the label column and the chart
        // (via the sticky-layout branch) OR just the chart when the
        // monolithic path is active — in either case it's the outer
        // Gantt card, which is exactly what we want to hand to
        // `html-to-image`. Any callers that don't want their embed
        // to be discoverable by the roadmap copy button can override
        // via a wrapper of their own; the auto-schedule preview
        // renders its own toolbar so it doesn't share the button.
        data-roadmap-capture-root="true"
        className={useMonolithic
          ? (pdfMode ? "card-surface" : "card-surface overflow-hidden")
          : "card-surface max-h-[calc(100vh-240px)] overflow-auto"}
      >
        {useMonolithic ? (
          <div className="flex">
            <div className="shrink-0" style={{ width: resolvedLabelColumnPx }}>
              <div className="border-b border-wp-stone bg-wp-stone/40" style={{ height: HEADER_HEIGHT }} />
              {labelBody}
            </div>
            {/* Chart column carries the H-scroll in the monolithic
                layout so today-anchor scrollLeft targets the same
                element (via `scrollRef`) that pre-refactor code
                aimed at. pdfMode keeps it as a plain flex-1 so
                html-to-image captures the full scrollWidth without
                the wrapper clipping. */}
            <div
              ref={scrollRef}
              className={pdfMode ? "relative flex-1" : "relative flex-1 overflow-x-auto"}
            >
              <svg
                width={chartWidth}
                height={HEADER_HEIGHT + bodyHeight}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{ userSelect: "none", touchAction: "none" }}
              >
                {defsBlock}
                {headerBlock}
                <g transform={`translate(0, ${HEADER_HEIGHT})`}>
                  {bodyBlock}
                </g>
              </svg>
            </div>
          </div>
        ) : (
          <>
            {/* Sticky HEADER row — vertical scroll pins it to the
                scroll container's top edge; horizontal scroll moves
                it in lockstep with the body because they share a
                parent. Inside the row, the label side is itself
                `sticky left-0` so H-scroll keeps the header spacer
                and the resize divider aligned with the label
                column below.

                `min-w-max` on the row is what makes the horizontal
                sticky actually work: a plain block-level flex row
                takes its parent's width (100% of the card), which
                becomes the sticky child's containing block. Sticky
                left-0 can only offset a child within its containing
                block, so once the card is scrolled past
                (cardWidth - labelWidth) the sticky column runs into
                the containing block's right edge and starts riding
                off-screen with the row. Extending the row's used
                width to `max-content` (= labelColumnPx + chartWidth)
                gives sticky-left-0 room to travel across the entire
                horizontal scroll range. The chart SVG is `shrink-0`
                so `min-w-max` doesn't change the visible layout in
                the "fits without scroll" case — the row just matches
                the card width there. Same rationale applies to the
                body row below. */}
            <div className="sticky top-0 z-20 flex min-w-max bg-white">
              <div className="sticky left-0 z-30 flex bg-white shrink-0">
                <div
                  className="border-b border-wp-stone bg-wp-stone/40 shrink-0"
                  style={{ width: resolvedLabelColumnPx, height: HEADER_HEIGHT }}
                />
                {canResizeLabelColumn ? (
                  <ColumnResizer
                    currentWidth={resolvedLabelColumnPx}
                    minWidth={ROADMAP_LABEL_COLUMN_MIN_PX}
                    maxWidth={ROADMAP_LABEL_COLUMN_MAX_PX}
                    onWidthChange={onLabelColumnPxChange!}
                    onCommit={onLabelColumnPxCommit!}
                    ariaLabel="Resize roadmap label column"
                  />
                ) : null}
              </div>
              <svg
                className="block shrink-0"
                width={chartWidth}
                height={HEADER_HEIGHT}
              >
                {headerBlock}
              </svg>
            </div>

            {/* BODY row — labels + body SVG. Label side is
                `sticky left-0` so long project titles never scroll
                out of view horizontally. The body SVG carries all
                pointer handlers because every draggable Bar lives
                inside it; a drag started on a bar keeps firing
                move/up events on the bar's captured element even
                if the pointer physically wanders up into the
                sticky header, so the header SVG doesn't need its
                own handlers.

                `min-w-max` is needed here for the same containing-
                block reason as the header row above — see that
                comment. Without it, `sticky left-0` releases the
                label column once the card is scrolled past
                (cardWidth - labelWidth), which is exactly the
                "labels scroll off-screen" bug this row exhibited. */}
            <div className="flex min-w-max">
              <div className="sticky left-0 z-10 flex bg-white shrink-0">
                <div className="shrink-0" style={{ width: resolvedLabelColumnPx }}>
                  {labelBody}
                </div>
                {canResizeLabelColumn ? (
                  <ColumnResizer
                    currentWidth={resolvedLabelColumnPx}
                    minWidth={ROADMAP_LABEL_COLUMN_MIN_PX}
                    maxWidth={ROADMAP_LABEL_COLUMN_MAX_PX}
                    onWidthChange={onLabelColumnPxChange!}
                    onCommit={onLabelColumnPxCommit!}
                    ariaLabel="Resize roadmap label column"
                  />
                ) : null}
              </div>
              <svg
                className="block shrink-0"
                width={chartWidth}
                height={bodyHeight}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{ userSelect: "none", touchAction: "none" }}
              >
                {defsBlock}
                {bodyBlock}
              </svg>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Bar(props: {
  project: Project;
  y: number;
  chartStart: Date;
  dayPx: number;
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  colorBy: ColorBy;
  canEdit: boolean;
  activeDrag: DragState | null;
  onStartDrag: (e: React.PointerEvent, projectId: string, mode: DragMode) => void;
  onOpen: (projectId: string) => void;
  deadlineStatuses: DeadlineStatus[];
  dependencyStatuses: DependencyStatus[];
  isSubtask?: boolean;
  /**
   * Parent → direct children map from the currently rendered project
   * set. Bar walks it recursively (via `descendants`) to build the
   * subtask-aggregated timeline for epics. Optional — when omitted,
   * epic bars fall back to their own phase rendering.
   */
  kids?: Map<string, Project[]>;
  /**
   * PDF snapshot mode. When true and the bar's first plotted date is
   * earlier than `chartStart` (which the parent has already clamped
   * to today - 30d in PDF mode), Bar draws a soft left-edge fade +
   * chevron glyph so the exported artefact signals "this item
   * continues off the visible history". Interactive rendering must
   * always pass false — the fade would misrepresent bars in the
   * live view where the past is fully scrollable.
   */
  pdfMode?: boolean;
  /**
   * Master gate for the per-row conflict/warning glyphs — the
   * deadline-alert red triangle icon, the dependency-alert broken
   * chain icon, and the violated-color variants of deadline tick
   * marks / per-phase dependency chain icons. Defaults to `true`
   * to keep pre-toggle callers' visuals intact. When false, the
   * deadline flags/tick marks and per-phase chain icons still
   * render but always in their informational (slate) styling —
   * they read as "here's the shape of the plan" rather than
   * "here's what's broken."
   */
  showConflicts?: boolean;
}) {
  const {
    project: p, y, chartStart, dayPx, lanes, teams, users, colorBy,
    canEdit, activeDrag, onStartDrag, onOpen,
    deadlineStatuses, dependencyStatuses, isSubtask, kids, pdfMode,
    showConflicts = true,
  } = props;
  const phases = computePhases(p);
  if (!phases.scheduled) return null;
  const lane = lanes.find((l) => l.id === p.swim_lane_id);
  const primaryTeam = teams.find((t) => t.id === p.teams[0]);
  const owner = users.find((u) => u.id === p.owner_id);
  const base = pickBase(colorBy, lane, primaryTeam, owner);

  // Epic-with-subtasks: derive the bar's phase colouring from what its
  // descendants are doing on each day instead of from the epic's own
  // discovery/dev/opt breakdown. Falls back to null (→ per-phase
  // rendering below) when there are no scheduled descendants.
  const subtaskSegments: EpicSubtaskSegment[] | null =
    !isSubtask && p.type === "epic" && kids
      ? computeEpicSubtaskSegments(p, descendants(p.id, kids))
      : null;

  // Subtask bars sit a bit thinner so the epic stays visually dominant.
  // Same y-anchor so the row heights are constant and drag hitboxes
  // don't shift when you expand a tree.
  const extraPad = isSubtask ? 3 : 0;
  const barY = y + BAR_PADDING + extraPad;
  const barH = ROW_HEIGHT - BAR_PADDING * 2 - extraPad * 2;

  // Each phase is now independently nullable — a project with only
  // (say) post-dev dates renders just the Optimization segment. The
  // "geom" objects below carry the pixel positions for every phase
  // that IS plottable; missing phases stay null and their bar/handle
  // /segment-label render blocks simply short-circuit below.
  const disc = phases.discovery;
  const dev = phases.development;
  const opt = phases.optimization;
  const devGap = phases.awaitingDev;
  const optGap = phases.awaitingOptimization;

  const discGeom = disc ? {
    x: differenceInCalendarDays(disc.start, chartStart) * dayPx,
    w: Math.max(2, differenceInCalendarDays(disc.end, disc.start) * dayPx),
  } : null;
  const devGeom = dev ? {
    x: differenceInCalendarDays(dev.start, chartStart) * dayPx,
    w: Math.max(2, differenceInCalendarDays(dev.end, dev.start) * dayPx),
  } : null;
  const optGeom = opt ? {
    x: differenceInCalendarDays(opt.start, chartStart) * dayPx,
    w: Math.max(2, differenceInCalendarDays(opt.end, opt.start) * dayPx),
  } : null;
  const devGapGeom = devGap ? {
    x: differenceInCalendarDays(devGap.start, chartStart) * dayPx,
    w: Math.max(2, differenceInCalendarDays(devGap.end, devGap.start) * dayPx),
  } : null;
  const optGapGeom = optGap ? {
    x: differenceInCalendarDays(optGap.start, chartStart) * dayPx,
    w: Math.max(2, differenceInCalendarDays(optGap.end, optGap.start) * dayPx),
  } : null;

  // Right edge of the drawn bar — anchors the deadline / dependency
  // alert icons past the tail of whichever phase actually ends last.
  // `overallEnd` is guaranteed non-null when scheduled=true.
  const overallEndX = differenceInCalendarDays(phases.overallEnd!, chartStart) * dayPx;
  // Left edge of the drawn bar — anchors the move-drag tooltip.
  const firstStartX = differenceInCalendarDays(phases.firstStart!, chartStart) * dayPx;

  const dragMode = activeDrag?.mode;

  return (
    <g style={{ pointerEvents: "auto" }}>
      <title>{[
        `${p.title}${subtaskSegments ? "\n(Bar shows the roll-up of subtask phases — dotted sections span multiple phases at once.)" : ""}`,
        disc ? `Phase 1 (Discovery/Definition): ${format(disc.start, "MMM d")} → ${format(disc.end, "MMM d")}` : null,
        devGap ? `Awaiting Dev:                    ${format(devGap.start, "MMM d")} → ${format(devGap.end, "MMM d")}` : null,
        dev ? `Phase 2 (Development):          ${format(dev.start, "MMM d")} → ${format(dev.end, "MMM d")}` : null,
        optGap ? `Awaiting Optimization:          ${format(optGap.start, "MMM d")} → ${format(optGap.end, "MMM d")}` : null,
        opt ? `Phase 3 (Optimization):         ${format(opt.start, "MMM d")} → ${format(opt.end, "MMM d")}` : null,
      ].filter(Boolean).join("\n")}</title>

      {/* Bar body — captures move drags + click-to-open. Cursor set separately for view-only users. */}
      <g
        style={{ cursor: canEdit ? "grab" : "pointer" }}
        onPointerDown={(e) => onStartDrag(e, p.id, "move")}
      >
        {subtaskSegments ? (
          // Epic with scheduled subtasks: paint the bar from the
          // rolled-up subtask timeline. Each segment carries one of
          // the five single-phase kinds (styled like the per-phase
          // fallback below) or "mixed" (polka dot overlay).
          //
          // PDF mode drops every `url(#...)` pattern/gradient reference
          // and paints flat solids instead. html-to-image serialises
          // the captured DOM into a `<foreignObject>` inside a data:
          // URI, and Chromium's SVG renderer inside that context has
          // been observed to silently fail to resolve fragment
          // identifiers on `<pattern>` / `<linearGradient>` fills —
          // which drops the ENTIRE `<rect>` (not just the overlay),
          // leaving the exported chart blank. Solids capture reliably
          // and read cleanly in print, so PDF mode uses them exclusively.
          subtaskSegments.map((seg, i) => {
            const segX = differenceInCalendarDays(seg.start, chartStart) * dayPx;
            const segW = Math.max(2, differenceInCalendarDays(seg.end, seg.start) * dayPx);
            if (seg.kind === "awaitingDev" || seg.kind === "awaitingOptimization") {
              return (
                <g key={`seg-${i}`}>
                  {/* Interactive: light slate base + darker slate hatch overlay.
                      PDF: darker slate solid (matches the hatch tone so awaiting
                      periods read as "muted" against phase colors in print). */}
                  <rect x={segX} y={barY + barH / 2 - 2} width={segW} height={4} fill={pdfMode ? "#94A3B8" : "#CBD5E1"} rx={2} />
                  {pdfMode ? null : (
                    <rect x={segX} y={barY + barH / 2 - 2} width={segW} height={4} fill="url(#awaiting-dev-hatch)" rx={2} />
                  )}
                </g>
              );
            }
            if (seg.kind === "discovery") {
              return <rect key={`seg-${i}`} x={segX} y={barY} width={segW} height={barH} fill={base} rx={3} />;
            }
            if (seg.kind === "development") {
              return (
                <g key={`seg-${i}`}>
                  <rect x={segX} y={barY} width={segW} height={barH} fill={base} fillOpacity={0.55} rx={3} />
                  {pdfMode ? null : (
                    <rect x={segX} y={barY} width={segW} height={barH} fill="url(#phase-hatch)" rx={3} />
                  )}
                </g>
              );
            }
            if (seg.kind === "optimization") {
              return <rect key={`seg-${i}`} x={segX} y={barY} width={segW} height={barH} fill={base} fillOpacity={0.25} rx={3} />;
            }
            // seg.kind === "mixed"
            return (
              <g key={`seg-${i}`}>
                <rect x={segX} y={barY} width={segW} height={barH} fill={base} fillOpacity={0.5} rx={3} />
                {pdfMode ? null : (
                  <rect x={segX} y={barY} width={segW} height={barH} fill="url(#mixed-polka)" rx={3} />
                )}
              </g>
            );
          })
        ) : (
          <>
            {discGeom ? (
              <rect x={discGeom.x} y={barY} width={discGeom.w} height={barH} fill={base} rx={3} />
            ) : null}
            {devGapGeom ? (
              <g>
                <rect x={devGapGeom.x} y={barY + barH / 2 - 2} width={devGapGeom.w} height={4} fill={pdfMode ? "#94A3B8" : "#CBD5E1"} rx={2} />
                {pdfMode ? null : (
                  <rect x={devGapGeom.x} y={barY + barH / 2 - 2} width={devGapGeom.w} height={4} fill="url(#awaiting-dev-hatch)" rx={2} />
                )}
              </g>
            ) : null}
            {devGeom ? (
              <>
                <rect x={devGeom.x} y={barY} width={devGeom.w} height={barH} fill={base} fillOpacity={0.55} rx={3} />
                {pdfMode ? null : (
                  <rect x={devGeom.x} y={barY} width={devGeom.w} height={barH} fill="url(#phase-hatch)" rx={3} />
                )}
                {/* Unconfirmed dev estimate — dashed amber outline signals
                    that the segment's timing is a PM best-guess pending
                    engineering sign-off. Rendered above the fill layers so
                    the dashes stay legible against the hatched color.
                    Skipped in the subtask-rollup path because the epic's
                    own flag doesn't correspond to any single visible
                    segment there. Also skipped when there is no
                    Development phase to outline. */}
                {!p.dev_estimate_sourced_by_dev ? (
                  <rect
                    x={devGeom.x + 0.5}
                    y={barY + 0.5}
                    width={Math.max(0, devGeom.w - 1)}
                    height={barH - 1}
                    rx={3}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    pointerEvents="none"
                  />
                ) : null}
              </>
            ) : null}
            {optGapGeom ? (
              <g>
                <rect x={optGapGeom.x} y={barY + barH / 2 - 2} width={optGapGeom.w} height={4} fill={pdfMode ? "#94A3B8" : "#CBD5E1"} rx={2} />
                {pdfMode ? null : (
                  <rect x={optGapGeom.x} y={barY + barH / 2 - 2} width={optGapGeom.w} height={4} fill="url(#awaiting-dev-hatch)" rx={2} />
                )}
              </g>
            ) : null}
            {optGeom ? (
              <rect x={optGeom.x} y={barY} width={optGeom.w} height={barH} fill={base} fillOpacity={0.25} rx={3} />
            ) : null}
          </>
        )}
      </g>

      {/* Resize handles — positioned at each divider. Wider transparent hitbox for
          easier grabbing; a thin white line shows the exact snap point.
          Hidden in the subtask-rollup path: the epic's own phase
          boundaries no longer correspond to what's drawn, so exposing
          handles at those points would let a PM "drag" a segment
          divider that isn't visible. Move-drag on the bar body still
          works if they need to shift the whole epic. */}
      {canEdit && !subtaskSegments ? (
        <>
          {discGeom ? (
            <ResizeHandle x={discGeom.x + discGeom.w} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "target")} label="Ready for Dev" />
          ) : null}
          {devGapGeom && devGeom ? (
            <ResizeHandle x={devGeom.x} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "devStart")} label="Dev Begins" />
          ) : null}
          {devGeom ? (
            <ResizeHandle x={devGeom.x + devGeom.w} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "devEnd")} label="Dev Complete" />
          ) : null}
          {optGapGeom && optGeom ? (
            <ResizeHandle x={optGeom.x} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "optStart")} label="Optimization Begins" />
          ) : null}
          {optGeom ? (
            <ResizeHandle x={optGeom.x + optGeom.w} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "optEnd")} label="Optimization Complete" />
          ) : null}
        </>
      ) : null}

      {/* Live-drag labels — always centered inside the resizing segment.
          Falls back to a short form when the long label won't fit.
          Each label is gated on its phase actually existing so we
          don't render a preview for a phase the user isn't editing. */}
      {dragMode === "target" && disc && discGeom ? (
        <SegmentLabel
          x={discGeom.x} width={discGeom.w} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(disc.end, disc.start))}
          long={`${pluralDays(differenceInCalendarDays(disc.end, disc.start))} · Discovery`}
        />
      ) : null}
      {dragMode === "devStart" && devGap && devGapGeom ? (
        <SegmentLabel
          x={devGapGeom.x} width={devGapGeom.w} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(devGap.end, devGap.start))}
          long={`${pluralDays(differenceInCalendarDays(devGap.end, devGap.start))} · Awaiting Dev`}
        />
      ) : null}
      {dragMode === "devEnd" && dev && devGeom ? (
        <SegmentLabel
          x={devGeom.x} width={devGeom.w} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(dev.end, dev.start))}
          long={`${pluralDays(differenceInCalendarDays(dev.end, dev.start))} · Development`}
        />
      ) : null}
      {dragMode === "optStart" && optGap && optGapGeom ? (
        <SegmentLabel
          x={optGapGeom.x} width={optGapGeom.w} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(optGap.end, optGap.start))}
          long={`${pluralDays(differenceInCalendarDays(optGap.end, optGap.start))} · Awaiting Optimization`}
        />
      ) : null}
      {dragMode === "optEnd" && opt && optGeom ? (
        <SegmentLabel
          x={optGeom.x} width={optGeom.w} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(opt.end, opt.start))}
          long={`${pluralDays(differenceInCalendarDays(opt.end, opt.start))} · Optimization`}
        />
      ) : null}
      {dragMode === "move" && activeDrag ? (
        <g pointerEvents="none">
          <rect x={firstStartX - 2} y={barY - 16} width={70} height={14} rx={3} fill="#101828" opacity={0.9} />
          <text x={firstStartX + 2} y={barY - 5} fontSize={10} fill="#fff">
            {activeDrag.deltaDays > 0 ? "+" : ""}{activeDrag.deltaDays}d · {format(phases.firstStart!, "MMM d")}
          </text>
        </g>
      ) : null}

      {/* Hard-deadline tick marks + row-level alert icons.
          Deadline and dependency violations each get their own
          icon — a triangle for deadlines, a broken chain for
          dependencies — so PMs can tell at a glance which class
          of issue a row has just by scanning the right margin.
          Both icons render side-by-side when both are violated.
          When `showConflicts` is off, the red alert glyphs are
          suppressed and the deadline tick marks revert to their
          slate (informational) styling — the tick itself is a
          location marker, not a violation indicator, so keeping
          it visible in the neutral color reads as "there's a
          deadline here" without shouting a warning. */}
      {(() => {
        const anyDeadlineViolated = showConflicts && deadlineStatuses.some((s) => s.severity !== "ok");
        const anyDepViolated = showConflicts && dependencyStatuses.some((s) => s.severity === "violated");
        const nothingToRender = deadlineStatuses.length === 0 && !anyDeadlineViolated && !anyDepViolated;
        if (nothingToRender) return null;
        // Icon slot positions past the bar's right edge. Deadline
        // sits closer to the bar; dep alert sits further out so it
        // doesn't overlap when both are firing. Both clamp so they
        // don't render off-chart in an extreme case. `overallEndX`
        // (derived from `phases.overallEnd`) is the rightmost
        // plotted edge across whichever phases are populated.
        const deadlineIconX = Math.min(overallEndX + 6, chartStart ? 999999 : 0);
        const depIconX = Math.min(overallEndX + 26, chartStart ? 999999 : 0);
        return (
          <g pointerEvents="none">
            {deadlineStatuses.map((s) => {
              const tickX = dayX(s.deadline.deadline_date, chartStart, dayPx) + dayPx / 2;
              // Only paint the red "violated" variant when the
              // parent is actively surfacing conflicts. Otherwise
              // the tick reads as pure wayfinding.
              const violated = showConflicts && s.severity !== "ok";
              const color = violated ? "#DC2626" : "#94A3B8";
              const laneName = s.lane?.name ?? "(deleted lane)";
              const dl = format(parseISO(s.deadline.deadline_date), "MMM d, yyyy");
              return (
                <g key={s.deadline.id} pointerEvents="auto">
                  <title>
                    {`Deadline: ${laneName} by ${dl}${
                      violated
                        ? s.phaseDate
                          ? ` — currently ${format(parseISO(s.phaseDate), "MMM d, yyyy")}`
                          : " — phase not scheduled yet"
                        : ""
                    }${s.deadline.note ? `\n${s.deadline.note}` : ""}`}
                  </title>
                  <line
                    x1={tickX}
                    y1={barY - 3}
                    x2={tickX}
                    y2={barY + barH + 3}
                    stroke={color}
                    strokeWidth={2}
                  />
                  {/* Small flag marker at the top so the tick reads as a
                      deadline (rather than a today-line or gridline). */}
                  <polygon
                    points={`${tickX},${barY - 6} ${tickX + 6},${barY - 3} ${tickX},${barY}`}
                    fill={color}
                  />
                </g>
              );
            })}
            {anyDeadlineViolated ? (
              <DeadlineAlertTooltip statuses={deadlineStatuses}>
                {/* pointerEvents="auto" overrides the parent group's
                    "none" so Radix hover detection actually fires; the
                    transparent 18×18 rect gives the tiny 12px triangle
                    a forgiving hit target. Clicking the icon opens the
                    project detail panel — same target as the bar. */}
                <g
                  transform={`translate(${deadlineIconX}, ${barY + barH / 2 - 6})`}
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}
                >
                  <rect x={-3} y={-3} width={18} height={18} fill="transparent" />
                  {/* Inline triangle-with-! matches lucide's AlertTriangle. */}
                  <path
                    d="M12 2 L22 20 L2 20 Z"
                    transform="scale(0.55)"
                    fill="#DC2626"
                    stroke="#7F1D1D"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                  <text
                    x={3.6}
                    y={8.5}
                    fontSize={7}
                    fontWeight={700}
                    fill="#fff"
                    textAnchor="middle"
                  >!</text>
                </g>
              </DeadlineAlertTooltip>
            ) : null}
            {anyDepViolated ? (
              <DependencyAlertTooltip statuses={dependencyStatuses}>
                {/* Broken-chain glyph — distinct silhouette so PMs can
                    tell dependency alerts apart from deadline
                    triangles when both fire on the same row. */}
                <g
                  transform={`translate(${depIconX}, ${barY + barH / 2 - 6})`}
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}
                >
                  <rect x={-3} y={-3} width={18} height={18} fill="transparent" />
                  {/* Two link circles with a red diagonal slash across
                      them — reads clearly at 12px. Fill is red so it
                      matches the deadline triangle's severity weight. */}
                  <circle cx={2.5} cy={6} r={3.5} fill="#DC2626" stroke="#7F1D1D" strokeWidth={1} />
                  <circle cx={9.5} cy={6} r={3.5} fill="#DC2626" stroke="#7F1D1D" strokeWidth={1} />
                  <line x1={-1} y1={12.5} x2={13} y2={-0.5} stroke="#7F1D1D" strokeWidth={1.75} strokeLinecap="round" />
                  <line x1={-1} y1={12.5} x2={13} y2={-0.5} stroke="#fff" strokeWidth={0.9} strokeLinecap="round" />
                </g>
              </DependencyAlertTooltip>
            ) : null}
          </g>
        );
      })()}

      {/* Dependency link icons — one per phase-of-this-project that
          has at least one incoming dep. Placed just BELOW the bar at
          the phase's start X so it doesn't collide with the deadline
          flag markers above. Red when any dep on that phase is
          violated, slate otherwise. */}
      {(() => {
        if (dependencyStatuses.length === 0) return null;
        const byPhase = groupDependenciesByPhase(dependencyStatuses);
        if (byPhase.size === 0) return null;
        // Phase-start x positions on this bar. Only defined for
        // phases that are actually drawn — a dep on a phase that
        // isn't plotted (yet) simply has no icon slot, so we skip
        // it rather than render a floating chain in nowhere.
        const phaseStartX: Partial<Record<PhaseKey, number>> = {};
        if (discGeom) phaseStartX.discovery = discGeom.x;
        if (devGeom) phaseStartX.development = devGeom.x;
        if (optGeom) phaseStartX.optimization = optGeom.x;
        const phaseName: Record<PhaseKey, string> = {
          discovery: "Discovery",
          development: "Development",
          optimization: "Optimization",
        };
        const iconYOffset = barH + 3;
        return (
          <g>
            {Array.from(byPhase.entries()).map(([phase, ss]) => {
              const cx = phaseStartX[phase];
              if (cx === undefined) return null;
              // Per-phase chain icons stay visible as informational
              // "this phase has a dep" markers even when
              // `showConflicts` is off — only the red violated color
              // variant is suppressed. Same rationale as the
              // dependency arrows above: keep the wiring visible,
              // hide the alarm colouring.
              const violated = showConflicts && ss.some((s) => s.severity === "violated");
              const color = violated ? "#DC2626" : "#64748B";
              return (
                <DependencyPhaseTooltip
                  key={`dep-${p.id}-${phase}`}
                  phaseName={phaseName[phase]}
                  statuses={ss}
                >
                  <g
                    transform={`translate(${cx}, ${barY + iconYOffset})`}
                    style={{ pointerEvents: "auto", cursor: "pointer" }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}
                  >
                    {/* Larger transparent hit-target than the visible
                        glyph — the chain glyph is tiny. */}
                    <rect x={-6} y={-2} width={16} height={14} fill="transparent" />
                    {/* Chain-link glyph inspired by lucide's Link2.
                        Drawn small (~10px) so it doesn't crowd short
                        phase segments. */}
                    <circle cx={2} cy={5} r={4.5} fill="white" stroke={color} strokeWidth={1.6} />
                    <path
                      d="M-0.5 5 L4.5 5"
                      stroke={color}
                      strokeWidth={1.6}
                      strokeLinecap="round"
                    />
                    {ss.length > 1 ? (
                      <text
                        x={9.5}
                        y={7.5}
                        fontSize={8}
                        fontWeight={700}
                        fill={color}
                      >
                        {ss.length}
                      </text>
                    ) : null}
                  </g>
                </DependencyPhaseTooltip>
              );
            })}
          </g>
        );
      })()}

      {/* PDF-only left-edge fade. Only applies when:
            1. pdfMode is on (interactive view never renders this), AND
            2. the bar's earliest plotted date sits before the PDF's
               clamped left edge — i.e. `firstStartX < 0`, meaning
               the bar's real span extends off the visible history.
          The overlay is painted LAST inside the Bar's outer <g> so
          it sits above every phase segment, awaiting-dev hatch,
          dev-estimate outline, and drag preview label — those all
          need to be visually softened at the leftmost edge so the
          "continues earlier" message reads cleanly. Alerts / dep
          icons sit past `overallEndX` and are untouched.

          Width is clamped to the visible bar width so a very short
          tail (a bar that ends soon after today-30) doesn't spill
          past its own right edge. The chevron label is suppressed
          when the visible portion is narrower than the label would
          need, keeping the fade tidy for tail-end bars. */}
      {pdfMode && firstStartX < 0 && overallEndX > 0 ? (
        <g pointerEvents="none">
          {/* Opaque white rect (matches the chart's background) cleanly
              caps the past-extending bar at the visible left edge. The
              interactive path uses an SVG `<linearGradient>` for a
              softer fade, but html-to-image's foreignObject-to-canvas
              serialisation drops `url(#...)` fills in Chromium's export
              raster, so PDF mode uses a solid rect and lets the chevron
              carry the "continues earlier" affordance. */}
          <rect
            x={0}
            y={barY}
            width={Math.min(10, overallEndX)}
            height={barH}
            fill="#ffffff"
            rx={3}
          />
          {overallEndX >= 22 ? (
            <text
              x={2}
              y={barY + barH / 2 + 3}
              fontSize={9}
              fill="#475569"
              fontWeight={600}
            >
              ◄
            </text>
          ) : null}
        </g>
      ) : null}
    </g>
  );
}

/**
 * Dotted arrow between an upstream row's phase-end and a
 * dependent row's phase-start.
 *
 * Layout: two right-angle "elbow" segments — go out to the right
 * from the source, drop vertically to the target row, then come
 * back in from the left. Simple + readable, doesn't need path
 * math, and handles same-direction / reverse-direction / same-row
 * cases uniformly.
 *
 * Edge cases:
 *   * Source right of target (arrow goes "back in time") — still
 *     valid; the elbow just wraps around instead of continuing
 *     forward. This is exactly the visual we want for a violation
 *     where the dep's end is LATER than the dependent's start.
 *   * Same row — the vertical middle segment collapses to a
 *     zero-height line; still renders as a curved bow-tie via the
 *     small vertical offset we add.
 */
function DependencyArrow({
  x1, y1, x2, y2, violated,
}: {
  x1: number; y1: number; x2: number; y2: number; violated: boolean;
}) {
  // On-track arrows use slate-600 (not the older slate-400) with
  // the same stroke width as violated ones. Product decision: the
  // arrow's ORIENTATION is what tells the PM which direction the
  // dependency flows; the color only communicates whether it's a
  // problem. Making the on-track arrow near-invisible defeated
  // the "always show me the wiring" ask.
  const color = violated ? "#DC2626" : "#475569";
  const strokeWidth = 1.5;
  // Elbow x — halfway between the two endpoints. Clamped to a
  // minimum offset so short-horizontal-span arrows don't collapse
  // into a straight vertical line right on top of the bars.
  const midX = (x1 + x2) / 2;
  const path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
  // Arrowhead — small triangle pointing right at (x2, y2), rotated
  // via the segment coming in. Because the last segment is always
  // horizontal (elbow layout), we can hard-code a right-pointing
  // arrowhead without atan2 math.
  const ahSize = 4;
  return (
    <g>
      <path
        d={path}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray="3 3"
      />
      <polygon
        points={`${x2},${y2} ${x2 - ahSize},${y2 - ahSize} ${x2 - ahSize},${y2 + ahSize}`}
        fill={color}
      />
    </g>
  );
}

/**
 * Format a Date back to YYYY-MM-DD (local calendar day) for
 * feeding into `dayX`. We avoid `toISOString().slice(0,10)`
 * because that shifts to UTC and can jump a day for dates near
 * midnight on the "wrong" side of the TZ.
 */
function dateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ResizeHandle({ x, y, h, onDown, label }: {
  x: number; y: number; h: number; onDown: (e: React.PointerEvent) => void; label: string;
}) {
  return (
    <g style={{ cursor: "col-resize" }} onPointerDown={onDown}>
      <title>Drag to resize · {label}</title>
      <rect x={x - HANDLE_HITBOX_PX / 2} y={y - 4} width={HANDLE_HITBOX_PX} height={h + 8} fill="transparent" />
      <line x1={x} y1={y - 2} x2={x} y2={y + h + 2} stroke="#101828" strokeWidth={1.25} />
      <circle cx={x} cy={y + h + 4} r={2.75} fill="#101828" />
    </g>
  );
}

function SegmentLabel({ x, width, y, h, short, long }: {
  x: number; width: number; y: number; h: number;
  short: string; long: string;
}) {
  // Rough char-width estimate for 10px semibold sans; err on the side of
  // "too small to fit" (multiply by 6.2) so we don't overflow.
  const CHAR_PX = 6.2;
  const PADDING = 8;
  const usable = width - PADDING;
  const text = usable >= long.length * CHAR_PX ? long : short;
  return (
    <g pointerEvents="none">
      <text
        x={x + width / 2}
        y={y + h / 2 + 3}
        fontSize={10}
        fontWeight={600}
        textAnchor="middle"
        fill="#101828"
        paintOrder="stroke"
        stroke="#fff"
        strokeWidth={3}
      >
        {text}
      </text>
    </g>
  );
}

type Group = {
  key: string;
  label: string | null;
  rows: TreeRow[];
  /**
   * Optional accent color for the group header. Only populated by
   * groupings whose entities have a canonical color (currently just
   * KPI); other groupings leave it undefined and the header renders
   * label-only, matching the existing visual.
   */
  color?: string;
};

/**
 * Build the ordered list of rows for the roadmap. The top-level rows
 * are the roots of the currently-visible tree (epics and any orphan
 * subtasks whose parent isn't in the set). Under each root, if the
 * root is expanded, we recursively include its scheduled descendants
 * in depth-first order — this is what makes clicking an epic reveal
 * every subtask below it at once.
 *
 * Grouping keys always come from the ROOT, never from the descendant:
 * expanding an epic under Team A shows the whole tree under Team A
 * even if a subtask belongs to Team B. That matches the "epic is the
 * primary unit" mental model the user asked for.
 *
 * Multi-value groupings (team, kpi) intentionally duplicate a root
 * across every group it belongs to — so a project tagged with two
 * KPIs shows up under both KPI headers. Single-value groupings
 * (owner, swim_lane, tag-primary) put each root in exactly one
 * bucket.
 */
function groupTreeRows(
  projects: Project[],
  byId: Map<string, Project>,
  kids: Map<string, Project[]>,
  rootIdsInSet: Set<string>,
  expanded: Set<string>,
  groupBy: GroupBy,
  users: User[],
  lanes: SwimLane[],
  teams: Team[],
  kpis: Kpi[],
  preserveInputOrder: boolean,
  sortMode: RoadmapSort | undefined,
  overrideByGroup: Record<string, string[]> | undefined,
): Group[] {
  const lanesById = new Map(lanes.map((l) => [l.id, l] as const));
  // Composite comparator that ranks roots the same way the Board
  // view does: swim lane's own order first (lower = higher
  // priority), then per-lane `projects.position`, then a
  // stable-but-informative pair of tiebreakers (updated_at desc
  // to surface recent activity, id ascending to break the last
  // remaining tie deterministically). Roots without a swim lane
  // sort to the very end so an unassigned item can't sneak above
  // a properly-ranked pick just because its id sorts earlier.
  const byPriority = (a: Project, b: Project) => {
    const orderA = a.swim_lane_id ? lanesById.get(a.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const orderB = b.swim_lane_id ? lanesById.get(b.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.position !== b.position) return a.position - b.position;
    const updatedCmp = (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    if (updatedCmp !== 0) return updatedCmp;
    return a.id.localeCompare(b.id);
  };
  // Resolve the ordered root list for a given group key. Priority
  // mode ignores overrides entirely — the composite comparator IS
  // the source of truth there. Start-date mode consults the
  // per-group override first: any ids present in the override
  // survive in that order (dropping ones no longer visible), and
  // any roots missing from the override append at the end in
  // default chronological order so a newly-scheduled item joins
  // the list without disappearing until the user re-orders again.
  //
  // `preserveInputOrder` (auto-schedule preview) still short-
  // circuits both branches so its caller-supplied order wins.
  const orderRoots = (rs: Project[], groupKey: string): Project[] => {
    if (preserveInputOrder) return rs.slice();
    if (sortMode === "priority") return rs.slice().sort(byPriority);
    // startDate (default) with optional per-group override.
    const override = overrideByGroup?.[groupKey];
    if (!override || override.length === 0) return rs.slice().sort(byStart);
    const byIdLocal = new Map(rs.map((r) => [r.id, r] as const));
    const seen = new Set<string>();
    const ordered: Project[] = [];
    for (const id of override) {
      const p = byIdLocal.get(id);
      if (p) { ordered.push(p); seen.add(id); }
    }
    const trailing = rs.filter((r) => !seen.has(r.id)).sort(byStart);
    return [...ordered, ...trailing];
  };
  const inSet = new Set(projects.map((p) => p.id));

  // Roots = projects whose nearest ancestor in the current set is
  // themselves (so: an epic, OR a subtask whose ancestors were
  // filtered out — treat as an "orphan root" so its bar still renders).
  const roots = projects.filter((p) => {
    if (!p.parent_id) return true;
    // Walk up; if any ancestor is in the set, this project is a
    // descendant of that ancestor and should NOT be a root.
    let cursor: Project | undefined = byId.get(p.parent_id);
    let hops = 0;
    while (cursor && hops < 32) {
      if (inSet.has(cursor.id)) return false;
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
      hops++;
    }
    return true;
  });

  const rowsFor = (rootId: string): TreeRow[] => {
    const out: TreeRow[] = [];
    const walk = (p: Project, depth: number) => {
      const children = (kids.get(p.id) ?? []).filter((c) => inSet.has(c.id));
      const isExpanded = expanded.has(p.id);
      out.push({ project: p, depth, hasChildren: children.length > 0, isExpanded });
      if (isExpanded) {
        for (const c of children.slice().sort(byStart)) walk(c, depth + 1);
      }
    };
    const root = byId.get(rootId);
    if (root) walk(root, 0);
    return out;
  };

  if (groupBy === "none") {
    // `preserveInputOrder` is opt-in for callers that need the
    // caller-supplied `projects` array order to survive rendering —
    // currently only the auto-schedule proposal preview, which
    // hands us projects in the PM's drag-to-rank order so their #2
    // pick shouldn't slide to row #6 just because its `start_date`
    // ended up later than four other items. Default remains the
    // byStart sort the main Roadmap view expects when the user
    // picks "no grouping".
    const sorted = orderRoots(roots, "all");
    const flat = sorted.flatMap((r) => rowsFor(r.id));
    return [{ key: "all", label: null, rows: flat }];
  }

  const bucket = new Map<string, Project[]>();
  const labels = new Map<string, string>();
  const sortKeys = new Map<string, number>();
  const colors = new Map<string, string>();
  const UNASSIGNED_KEY = "__unassigned";
  const UNASSIGNED_SORT = Number.MAX_SAFE_INTEGER;

  const put = (
    key: string,
    label: string,
    sortKey: number | undefined,
    root: Project,
    color?: string,
  ) => {
    labels.set(key, label);
    if (sortKey !== undefined) sortKeys.set(key, sortKey);
    if (color) colors.set(key, color);
    const arr = bucket.get(key) ?? [];
    arr.push(root);
    bucket.set(key, arr);
  };

  // Group by ROOT's attributes so a whole tree lives under a single
  // heading. Suppress the void where root.rootIdsInSet check is
  // implicit because roots are already the top-of-tree elements.
  void rootIdsInSet;
  for (const p of roots) {
    if (groupBy === "owner") {
      const u = users.find((x) => x.id === p.owner_id);
      put(u?.id ?? UNASSIGNED_KEY, u?.name ?? "Unassigned", undefined, p);
    } else if (groupBy === "swim_lane") {
      const l = lanes.find((x) => x.id === p.swim_lane_id);
      put(l?.id ?? UNASSIGNED_KEY, l?.name ?? "Unassigned", l?.order, p);
    } else if (groupBy === "team") {
      if (p.teams.length === 0) {
        put(UNASSIGNED_KEY, "Unassigned", undefined, p);
      } else {
        for (const teamId of p.teams) {
          const t = teams.find((x) => x.id === teamId);
          if (!t) continue;
          put(t.id, t.name, t.order, p);
        }
      }
    } else if (groupBy === "tag") {
      const primary = p.tags[0] ?? null;
      put(primary ?? UNASSIGNED_KEY, primary ? `#${primary}` : "No tag", undefined, p);
    } else if (groupBy === "kpi") {
      // KPI is multi-value: a project with N KPIs shows up under all N
      // groups. Roots with zero KPIs land in the shared UNASSIGNED
      // bucket rendered at the bottom as "(no KPI)". Unknown KPI ids
      // on a project (e.g. a KPI deleted since the project was last
      // saved) are silently skipped; treating them as unassigned
      // would incorrectly merge them with projects that have no
      // KPIs at all.
      const known = (p.kpis ?? [])
        .map((kid) => kpis.find((x) => x.id === kid))
        .filter((k): k is Kpi => Boolean(k));
      if (known.length === 0) {
        put(UNASSIGNED_KEY, "(no KPI)", undefined, p);
      } else {
        for (const k of known) put(k.id, k.name, k.order, p, k.color);
      }
    }
  }

  return Array.from(bucket.entries())
    .map(([k, rs]) => ({
      key: k,
      label: labels.get(k) ?? k,
      rows: orderRoots(rs, k).flatMap((r) => rowsFor(r.id)),
      color: colors.get(k),
    }))
    .sort((a, b) => {
      const aw = a.key === UNASSIGNED_KEY ? UNASSIGNED_SORT : sortKeys.get(a.key);
      const bw = b.key === UNASSIGNED_KEY ? UNASSIGNED_SORT : sortKeys.get(b.key);
      if (aw !== undefined && bw !== undefined) return aw - bw;
      if (aw !== undefined) return -1;
      if (bw !== undefined) return 1;
      return (a.label ?? "").localeCompare(b.label ?? "");
    });
}

function byStart(a: Project, b: Project) {
  return (a.start_date ?? "").localeCompare(b.start_date ?? "");
}

/**
 * A "cluster" is a top-level row plus any of its expanded subtask
 * rows that should visually ride along when the user drags the
 * root to reorder. Since `groupTreeRows` already emits a flat
 * `rows` list where each root is immediately followed by its
 * (currently-expanded) descendants, chunking is a single linear
 * pass keyed off `row.depth === 0`.
 *
 * Orphan subtask rows (a subtask whose root got filtered out and
 * is now surfacing as its own root — see the "orphan root"
 * fallback in `groupTreeRows`) start their own cluster. The
 * `depth === 0` invariant that `rowsFor` guarantees for real
 * roots doesn't apply to those, so this guard preserves them
 * without inventing a synthetic parent.
 */
/**
 * Sortable-id encoding for dnd-kit. Multi-value groupings (team,
 * kpi) intentionally duplicate the same root project across
 * multiple groups; using the raw project id as the sortable id
 * would collide in dnd-kit's droppable registry (the same
 * `useDroppable({ id })` overwrites the previous one, so only the
 * last-mounted context would receive drop events for that id).
 *
 * We split on the LAST "::" so a user-authored tag containing
 * "::" (unusual but not impossible under tag-based grouping)
 * still decodes correctly — the root-id half is always a UUID
 * from the backend and never contains "::" itself, making the
 * final occurrence the unambiguous separator.
 */
function makeSortableId(groupKey: string, rootId: string): string {
  return `${groupKey}::${rootId}`;
}
function parseSortableId(id: string): { groupKey: string; rootId: string } | null {
  const idx = id.lastIndexOf("::");
  if (idx < 0) return null;
  return { groupKey: id.slice(0, idx), rootId: id.slice(idx + 2) };
}

function clusterRootsWithSubtasks(rows: TreeRow[]): LabelCluster[] {
  const out: LabelCluster[] = [];
  let current: LabelCluster | null = null;
  for (const row of rows) {
    if (row.depth === 0 || !current) {
      current = { rootId: row.project.id, rows: [row] };
      out.push(current);
    } else {
      current.rows.push(row);
    }
  }
  return out;
}

type LabelCluster = { rootId: string; rows: TreeRow[] };

/**
 * One root row (plus any expanded-subtask rows underneath it)
 * rendered as a single dnd-kit sortable item. Only the root row
 * exposes the drag grip; subtask rows render exactly as before
 * (no grip, no listeners) so users can't try to reorder a subtask
 * — the priority rank is a root-level concept and mixing subtask
 * reorder into the same UX would be ambiguous.
 *
 * The whole cluster shares one `useSortable` transform so a drag
 * lifts the root's title AND every visible subtask underneath it
 * in one visual chunk. Dropping the cluster commits a reorder of
 * roots within the group; the subtasks come along for the ride
 * because they always render under their root.
 *
 * `reorderEnabled` gates the grip: when false (viewer, PDF
 * export, auto-schedule preview) the row renders identically to
 * the pre-feature layout — no grip, no cursor-grab, no dnd-kit
 * hooks.
 */
function SortableLabelCluster(props: {
  cluster: LabelCluster;
  groupKey: string;
  reorderEnabled: boolean;
  onOpen: (id: string) => void;
  onToggleExpand: (id: string) => void;
}) {
  const { cluster, groupKey, reorderEnabled, onOpen, onToggleExpand } = props;
  const sortable = useSortable({
    // Sortable id is namespaced by group so multi-value
    // groupings (team, kpi) that duplicate the same project
    // across groups don't collide in dnd-kit's droppable
    // registry. The drag-end handler decodes this back into
    // (groupKey, rootId) via `parseSortableId`.
    id: makeSortableId(groupKey, cluster.rootId),
    disabled: !reorderEnabled,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    // Lift the dragged cluster above its neighbors so the grip and
    // truncated titles sit on top during the arm-out translation.
    zIndex: sortable.isDragging ? 10 : undefined,
    // Slight fade on the dragged item echoes the Board card drag —
    // makes it obvious which cluster the user is currently moving.
    opacity: sortable.isDragging ? 0.6 : 1,
    // Sortable items must be block-flow so the parent's vertical
    // stack still lays out at ROW_HEIGHT increments; a plain div
    // handles that naturally.
    position: "relative",
  };
  return (
    <div ref={sortable.setNodeRef} style={style}>
      {cluster.rows.map((row, idx) => {
        const p = row.project;
        const isRoot = idx === 0;
        return (
          <div
            key={`lbl-${p.id}`}
            role="button"
            tabIndex={0}
            aria-label={p.title}
            onClick={() => onOpen(p.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(p.id);
              }
            }}
            className="flex cursor-pointer items-center gap-1 border-b border-wp-stone bg-white px-2 text-left text-xs transition-colors hover:bg-wp-stone/30 focus:bg-wp-stone/40 focus:outline-none"
            style={{ height: ROW_HEIGHT }}
          >
            {/* Drag grip — only on the root row and only when
                reorder is enabled. Uses `stopPropagation` on
                click so tapping the grip (without dragging) can't
                accidentally open the detail panel; the same
                stopPropagation is applied to keyboard events so
                Enter / Space on the grip is a no-op instead of a
                second "open project" fire. */}
            {isRoot && reorderEnabled ? (
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded text-wp-slate/50 hover:bg-wp-stone/60 hover:text-wp-ink active:cursor-grabbing"
                aria-label={`Drag to reorder ${p.title}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                {...sortable.attributes}
                {...sortable.listeners}
              >
                <GripVertical size={12} />
              </button>
            ) : null}
            {/* Indent scales with depth so nesting is obvious. */}
            <div style={{ width: row.depth * DEPTH_INDENT_PX, flexShrink: 0 }} />
            {row.hasChildren ? (
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-wp-slate hover:bg-wp-stone/60 hover:text-wp-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(p.id);
                }}
                title={row.isExpanded ? "Hide subtasks" : "Show subtasks"}
                aria-label={row.isExpanded ? `Collapse ${p.title}` : `Expand ${p.title}`}
              >
                {row.isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <div className="w-4 shrink-0" />
            )}
            {row.project.type === "epic" ? (
              <Layers size={11} className="shrink-0 text-wp-red" aria-label="Epic" />
            ) : null}
            {p.dates_locked ? (
              <span
                className="inline-flex shrink-0 items-center text-wp-slate"
                title="Dates locked. Auto-scheduler will not change dates for this item."
                aria-label="Dates locked"
              >
                <Lock size={11} />
              </span>
            ) : null}
            {/* Subtle "★" prefix on the row label when the item is a
                key strategic bet (migration 038). Same red fill as
                the detail modal + Prioritization row so the accent
                is consistent across surfaces; small (12px) so it
                doesn't crowd the label column. */}
            {p.is_key_strategic ? (
              <Star
                size={12}
                className="shrink-0 fill-wp-red text-wp-red"
                aria-label="Key strategic item"
              />
            ) : null}
            <span
              className={`min-w-0 flex-1 truncate ${row.depth > 0 ? "text-wp-slate" : "text-wp-ink"}`}
              title={p.title}
            >
              {p.title}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function pickBase(colorBy: ColorBy, lane?: SwimLane, team?: Team, owner?: User): string {
  if (colorBy === "team") return team?.color ?? "#94a3b8";
  if (colorBy === "owner") return owner?.color ?? "#94a3b8";
  return lane?.color ?? "#94a3b8";
}

function shiftIso(iso: string | null, days: number): string | null {
  if (!iso) return iso;
  return addDays(new Date(`${iso}T00:00:00`), days).toISOString().slice(0, 10);
}

function daysBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return differenceInCalendarDays(new Date(`${b}T00:00:00`), new Date(`${a}T00:00:00`));
}

/**
 * Clamp the raw day-delta for a drag so the preview never violates the
 * phase-order constraints: start ≤ target ≤ effDevStart ≤ devEnd ≤
 * effOptStart ≤ optEnd. Each mode moves exactly one date and defends
 * only the boundary immediately upstream of that date (downstream
 * boundaries are handled by whichever mode owns them).
 */
function clampDelta(d: DragState, delta: number): number {
  const i = d.initial;
  const effDevStart = i.dev_start_date ?? i.target_date;
  // Mirrors `phaseCompute.ts`: opt falls back to dev_end and, if dev
  // is cleared, all the way to target_date. Keeping the two lookups
  // in sync means dragging the opt-end handle can't shrink past a
  // date the roadmap doesn't visually anchor on.
  const effOptStart = i.optimization_start_date ?? i.dev_end_date ?? i.target_date;
  switch (d.mode) {
    case "target": {
      // Moving target also shifts every explicit downstream date by the
      // same delta (see applyDragToProject), so the only constraint is
      // target >= start_date.
      const minDelta = i.start_date && i.target_date
        ? -daysBetween(i.start_date, i.target_date)
        : -Infinity;
      return Math.max(delta, minDelta);
    }
    case "devStart": {
      const minDelta = i.target_date && i.dev_start_date
        ? -daysBetween(i.target_date, i.dev_start_date)
        : 0;
      return Math.max(delta, minDelta);
    }
    case "devEnd": {
      const minDelta = effDevStart && i.dev_end_date
        ? -daysBetween(effDevStart, i.dev_end_date)
        : 0;
      return Math.max(delta, minDelta);
    }
    case "optStart": {
      const minDelta = i.dev_end_date && i.optimization_start_date
        ? -daysBetween(i.dev_end_date, i.optimization_start_date)
        : 0;
      return Math.max(delta, minDelta);
    }
    case "optEnd": {
      const minDelta = effOptStart && i.optimization_end_date
        ? -daysBetween(effOptStart, i.optimization_end_date)
        : 0;
      return Math.max(delta, minDelta);
    }
    case "move":
    default:
      return delta;
  }
}

function applyDragToProject(p: Project, d: DragState): Project {
  const delta = d.deltaDays;
  const i = d.initial;
  const next: Project = { ...p };
  switch (d.mode) {
    case "move":
      // Shift every date that's set by the same amount so all phase
      // lengths and gaps are preserved.
      next.start_date = shiftIso(i.start_date, delta);
      next.target_date = shiftIso(i.target_date, delta);
      next.dev_start_date = shiftIso(i.dev_start_date, delta);
      next.dev_end_date = shiftIso(i.dev_end_date, delta);
      next.optimization_start_date = shiftIso(i.optimization_start_date, delta);
      next.optimization_end_date = shiftIso(i.optimization_end_date, delta);
      break;
    case "target":
      // Move target; slide every downstream boundary by the same delta so
      // the awaiting-dev gap, dev length, awaiting-opt gap, and opt length
      // all stay constant.
      next.target_date = shiftIso(i.target_date, delta);
      next.dev_start_date = shiftIso(i.dev_start_date, delta);
      next.dev_end_date = shiftIso(i.dev_end_date, delta);
      next.optimization_start_date = shiftIso(i.optimization_start_date, delta);
      next.optimization_end_date = shiftIso(i.optimization_end_date, delta);
      break;
    case "devStart":
      next.dev_start_date = shiftIso(i.dev_start_date, delta);
      break;
    case "devEnd":
      next.dev_end_date = shiftIso(i.dev_end_date, delta);
      break;
    case "optStart":
      next.optimization_start_date = shiftIso(i.optimization_start_date, delta);
      break;
    case "optEnd":
      next.optimization_end_date = shiftIso(i.optimization_end_date, delta);
      break;
  }
  return next;
}

/** Produce a minimal PATCH body containing only fields that actually changed. */
function diffProject(a: Project, b: Project): Partial<Project> {
  const out: Partial<Project> = {};
  const keys: (keyof Project)[] = [
    "start_date", "target_date", "dev_start_date", "dev_end_date",
    "optimization_start_date", "optimization_end_date",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) (out as Record<string, unknown>)[k] = b[k];
  }
  return out;
}

function pluralDays(n: number): string {
  // Prefer "N week(s)" when it lands on a clean week boundary; otherwise days.
  if (n !== 0 && n % 7 === 0) return pluralWeeks(n / 7);
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function pluralWeeks(n: number): string {
  return `${n} ${n === 1 ? "week" : "weeks"}`;
}

/**
 * Convert an ISO date (YYYY-MM-DD) to a pixel X inside the chart.
 * Chart's own coordinate system: x=0 corresponds to `chartStart` at
 * 00:00 local time (which is what `startOfMonth` returns).
 */
function dayX(iso: string, chartStart: Date, dayPx: number): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  const days = differenceInCalendarDays(dt, chartStart);
  return days * dayPx;
}

/** Bucket overload intervals by entity id for O(1) group lookup. */
function bucketOverloads(
  intervals: OverloadInterval[],
  kind: "owner" | "team",
): Map<string, OverloadInterval[]> {
  const out = new Map<string, OverloadInterval[]>();
  for (const iv of intervals) {
    if (iv.kind !== kind) continue;
    const arr = out.get(iv.entityId) ?? [];
    arr.push(iv);
    out.set(iv.entityId, arr);
  }
  return out;
}

/**
 * Radix-Tooltip wrapper for SVG overload markers. Kept tiny because
 * the trigger is always an SVG element (`<g>` / `<rect>`); Radix
 * handles refs transparently through `asChild`. Delay is short so
 * hovering a red band feels responsive but not twitchy.
 */
/**
 * Focused tooltip for the row-level DEADLINE alert triangle. Lists
 * every missed deadline on the project. On-track ones filter out
 * because the trigger icon only renders when there IS a miss.
 */
function DeadlineAlertTooltip({
  children,
  statuses,
}: {
  children: ReactNode;
  statuses: DeadlineStatus[];
}) {
  const misses = statuses.filter((s) => s.severity !== "ok");
  return (
    <Tooltip.Root delayDuration={100}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-sm rounded-md border border-wp-stone bg-white px-3 py-2 text-xs leading-relaxed text-wp-ink shadow-lg"
        >
          <div className="flex items-center gap-1.5 font-semibold text-red-700">
            <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">!</span>
            {misses.length === 1 ? "Deadline missed" : `${misses.length} deadlines missed`}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {misses.map((s) => {
              const laneName = s.lane?.name ?? "(deleted lane)";
              const dl = format(parseISO(s.deadline.deadline_date), "MMM d, yyyy");
              const cur = s.phaseDate ? format(parseISO(s.phaseDate), "MMM d, yyyy") : null;
              return (
                <li key={s.deadline.id}>
                  <div>
                    <span className="font-medium">{laneName}</span> due <span className="tabular-nums">{dl}</span>
                  </div>
                  {cur ? (
                    <div className="text-wp-slate">Currently landing <span className="tabular-nums">{cur}</span></div>
                  ) : null}
                  {s.deadline.note ? (
                    <div className="italic text-wp-slate">&ldquo;{s.deadline.note}&rdquo;</div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 border-t border-wp-stone pt-1.5 text-[10px] text-wp-slate">
            Click the row to open the item and adjust dates.
          </div>
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Focused tooltip for the row-level DEPENDENCY alert (broken chain
 * glyph). Mirrors the deadline tooltip's structure so PMs get a
 * consistent read of "here's what's broken and how."
 */
function DependencyAlertTooltip({
  children,
  statuses,
}: {
  children: ReactNode;
  statuses: DependencyStatus[];
}) {
  const misses = statuses.filter((s) => s.severity === "violated");
  return (
    <Tooltip.Root delayDuration={100}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-sm rounded-md border border-wp-stone bg-white px-3 py-2 text-xs leading-relaxed text-wp-ink shadow-lg"
        >
          <div className="flex items-center gap-1.5 font-semibold text-red-700">
            <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">!</span>
            {misses.length === 1 ? "Dependency violated" : `${misses.length} dependencies violated`}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {misses.map((s) => (
              <li key={s.dep.id}>
                <div>
                  <span className="font-medium">{s.thisLane?.name ?? "(deleted lane)"}</span>
                  {" starts before "}
                  <span className="italic">{s.otherProject?.title ?? "(deleted project)"}</span>&rsquo;s{" "}
                  <span className="font-medium">{s.otherLane?.name ?? "(deleted lane)"}</span> ends
                </div>
                <div className="text-wp-slate">
                  Starts <span className="tabular-nums">{s.thisStart ? format(s.thisStart, "MMM d, yyyy") : "—"}</span>
                  {" · upstream ends "}
                  <span className="tabular-nums">{s.otherEnd ? format(s.otherEnd, "MMM d, yyyy") : "—"}</span>
                </div>
                {s.dep.note ? (
                  <div className="italic text-wp-slate">&ldquo;{s.dep.note}&rdquo;</div>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-wp-stone pt-1.5 text-[10px] text-wp-slate">
            Click the row to open the item and adjust dates.
          </div>
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Small hover-card that surfaces the deps on a single phase.
 * Attached to the little link icon we drop at each phase start
 * with deps. Includes both violated and on-track deps because the
 * icon renders whenever ANY dep exists, not just violations.
 */
function DependencyPhaseTooltip({
  children,
  phaseName,
  statuses,
}: {
  children: ReactNode;
  phaseName: string;
  statuses: DependencyStatus[];
}) {
  const anyViolated = statuses.some((s) => s.severity === "violated");
  return (
    <Tooltip.Root delayDuration={100}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-sm rounded-md border border-wp-stone bg-white px-3 py-2 text-xs leading-relaxed text-wp-ink shadow-lg"
        >
          <div className={"flex items-center gap-1.5 font-semibold " + (anyViolated ? "text-red-700" : "text-wp-ink")}>
            {anyViolated ? (
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">!</span>
            ) : (
              <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-slate-400" aria-hidden />
            )}
            {statuses.length === 1
              ? `${phaseName} depends on 1 upstream phase`
              : `${phaseName} depends on ${statuses.length} upstream phases`}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {statuses.map((s) => (
              <li key={s.dep.id} className={s.severity === "violated" ? "text-red-800" : ""}>
                <div>
                  <span className="italic">{s.otherProject?.title ?? "(deleted project)"}</span>
                  &rsquo;s{" "}
                  <span className="font-medium">{s.otherLane?.name ?? "(deleted lane)"}</span>{" "}
                  ends{" "}
                  <span className="tabular-nums">
                    {s.otherEnd ? format(s.otherEnd, "MMM d, yyyy") : "not scheduled"}
                  </span>
                </div>
                <div className={s.severity === "violated" ? "text-red-700" : "text-wp-slate"}>
                  This phase starts{" "}
                  <span className="tabular-nums">
                    {s.thisStart ? format(s.thisStart, "MMM d, yyyy") : "not scheduled"}
                  </span>
                  {s.severity === "violated" ? " — starts too early" : ""}
                </div>
                {s.dep.note ? (
                  <div className="italic text-wp-slate">&ldquo;{s.dep.note}&rdquo;</div>
                ) : null}
              </li>
            ))}
          </ul>
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function OverloadTooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={100}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-sm rounded-md border border-wp-stone bg-white px-3 py-2 text-xs leading-relaxed text-wp-ink shadow-lg"
        >
          {content}
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Rich hover-card body for capacity overloads. Renders one line per
 * overloaded entity in the range, phrased in plain product terms
 * ("Roland assigned 4 tasks, over maximum of 3") so PMs don't have
 * to interpret numeric peaks.
 */
function OverloadTooltipContent(props: {
  title: string;
  range: { from: string; to: string };
  entries: OverloadInterval[];
  users: User[];
  teams: Team[];
}) {
  const { title, range, entries, users, teams } = props;
  const userById = new Map(users.map((u) => [u.id, u]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  return (
    <div>
      <div className="flex items-center gap-1.5 font-semibold text-red-700">
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
          !
        </span>
        {title}
      </div>
      <div className="mt-0.5 text-wp-slate">{formatIsoRange(range.from, range.to)}</div>
      <ul className="mt-1.5 space-y-1">
        {entries.map((iv, i) => {
          const name = iv.kind === "owner"
            ? userById.get(iv.entityId)?.name ?? "unknown user"
            : teamById.get(iv.entityId)?.name ?? "unknown team";
          const kindLabel = iv.kind === "owner" ? "owner" : "team";
          return (
            <li key={`${iv.kind}-${iv.entityId}-${iv.from}-${i}`}>
              <span className="font-medium">{name}</span>
              <span className="text-wp-slate"> ({kindLabel})</span>
              {" — "}
              assigned {iv.peak} {iv.peak === 1 ? "task" : "tasks"}, over maximum of {iv.cap}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatIsoRange(fromIso: string, toIso: string): string {
  if (fromIso === toIso) return formatIso(fromIso);
  return `${formatIso(fromIso)} → ${formatIso(toIso)}`;
}

function formatIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return format(new Date(y, m - 1, d), "MMM d, yyyy");
}

/**
 * Collapse a sorted list of ISO days into an array of contiguous
 * [from, to] ranges. Used to paint one alert icon per overload
 * range on the top axis rather than one per day.
 */
function contiguousRanges(days: string[]): { from: string; to: string }[] {
  if (days.length === 0) return [];
  const out: { from: string; to: string }[] = [];
  let start = days[0]!;
  let prev = days[0]!;
  for (let i = 1; i < days.length; i++) {
    const cur = days[i]!;
    const nextAfterPrev = addDaysIso(prev, 1);
    if (cur === nextAfterPrev) {
      prev = cur;
    } else {
      out.push({ from: start, to: prev });
      start = cur;
      prev = cur;
    }
  }
  out.push({ from: start, to: prev });
  return out;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Flatten all overload intervals to the deduplicated set of ISO days
 * for the top-of-chart "any capacity issue today" strip. Iterates by
 * day so the caller doesn't have to walk each interval later.
 */
function computeAnyOverloadDays(intervals: OverloadInterval[]): string[] {
  const days = new Set<string>();
  for (const iv of intervals) {
    let cur = iv.from;
    while (cur <= iv.to) {
      days.add(cur);
      const [y, m, d] = cur.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + 1);
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      cur = `${yy}-${mm}-${dd}`;
    }
  }
  return Array.from(days).sort();
}
