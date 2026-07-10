import type React from "react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { addDays, addMonths, differenceInCalendarDays, endOfMonth, format, min, max, parseISO, startOfMonth } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { api } from "../lib/api";
import { computeOverloads, overloadsForProject, projectSpan, type OverloadInterval } from "../lib/capacity";
import { computeDeadlineStatuses, type DeadlineStatus } from "../lib/deadlines";
import {
  computeDependencyStatuses,
  groupDependenciesByPhase,
  type DependencyStatus,
  type PhaseKey,
} from "../lib/dependencies";
import { computePhases } from "../lib/phaseCompute";
import { useCanWrite, useProjects } from "../lib/queries";
import { childrenByParent, indexById, rootEpic } from "../lib/hierarchy";
import type { Project, SwimLane, Team, User } from "../lib/types";
import { useViewStore, type ColorBy, type GroupBy } from "../lib/viewState";

type Zoom = "6mo" | "1yr";

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
};

const TIMEFRAME_MONTHS: Record<Zoom, number> = { "6mo": 6, "1yr": 12 };
const DAY_PX: Record<Zoom, number> = { "6mo": 8, "1yr": 3.5 };

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 48;
const GROUP_HEADER_HEIGHT = 28;
// Blank strip between groups so each swim of bars reads as its own
// unit. Rendered as un-shaded space; the header of the *next* group
// sits below it, aligned between the label column and the SVG.
const GROUP_GAP = 12;
const LEFT_LABEL_WIDTH = 260;
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
  const { projects, lanes, teams, users, colorBy, groupBy, zoom, onOpen, readOnly, contextProjects } = props;
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

  const { start, end } = useMemo(() => computeRange(projects, TIMEFRAME_MONTHS[zoom]), [projects, zoom]);
  const totalDays = Math.max(1, differenceInCalendarDays(end, start));
  const dayPx = DAY_PX[zoom];
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

  const groups = useMemo(
    () => groupTreeRows(projects, byId, kids, rootIdsInSet, expandedSet, groupBy, users, lanes, teams),
    [projects, byId, kids, rootIdsInSet, expandedSet, groupBy, users, lanes, teams],
  );

  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  // Row positions map — projectId → top Y of that row on the SVG.
  // Kept in sync with the render-loop cursor math below (both derive
  // from the same `groups` layout). The dependency-arrow layer walks
  // this to draw dotted links between visible pairs.
  const rowPositions = useMemo(() => {
    const out = new Map<string, { rowY: number; project: Project }>();
    let cursorY = HEADER_HEIGHT;
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
      <div className="card-surface overflow-hidden">
        <div className="flex">
          <div className="shrink-0" style={{ width: LEFT_LABEL_WIDTH }}>
            <div className="border-b border-wp-stone bg-wp-stone/40" style={{ height: HEADER_HEIGHT }} />
            {groups.map((g, gi) => (
              <div key={`labels-${g.key}`}>
                {/* Blank strip separating this group from the previous one.
                    Matches the same-height gap in the SVG column so the
                    labels and bars stay aligned row-for-row. */}
                {gi > 0 && g.label ? <div style={{ height: GROUP_GAP }} /> : null}
                {g.label ? (
                  <div
                    className="flex items-center justify-between border-b border-wp-stone bg-wp-stone/30 px-3 text-xs font-semibold uppercase tracking-wide text-wp-slate"
                    style={{ height: GROUP_HEADER_HEIGHT }}
                  >
                    <span>{g.label}</span>
                    <span>{g.rows.length}</span>
                  </div>
                ) : null}
                {g.rows.map((row) => {
                  const p = row.project;
                  return (
                    <div
                      key={`lbl-${p.id}`}
                      className="flex items-center gap-1 border-b border-wp-stone px-2 text-xs"
                      style={{ height: ROW_HEIGHT }}
                    >
                      {/* Indent scales with depth so nesting is obvious. */}
                      <div style={{ width: row.depth * DEPTH_INDENT_PX, flexShrink: 0 }} />
                      {row.hasChildren ? (
                        <button
                          type="button"
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-wp-slate hover:bg-wp-stone/60 hover:text-wp-ink"
                          onClick={() => toggleEpicExpanded(p.id)}
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
            ))}
          </div>

          <div className="relative flex-1 overflow-x-auto">
            <svg
              width={chartWidth}
              height={HEADER_HEIGHT + groups.reduce((s, g, gi) => (
                s
                + (gi > 0 && g.label ? GROUP_GAP : 0)
                + (g.label ? GROUP_HEADER_HEIGHT : 0)
                + g.rows.length * ROW_HEIGHT
              ), 0)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ userSelect: "none", touchAction: "none" }}
            >
              <defs>
                <pattern id="phase-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill="transparent" />
                  <rect width="2" height="6" fill="rgba(255,255,255,0.55)" />
                </pattern>
                <pattern id="awaiting-dev-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                  <rect width="6" height="6" fill="transparent" />
                  <rect width="1.25" height="6" fill="#94a3b8" />
                </pattern>
              </defs>

              <g>
                {months.map((m, i) => {
                  const x = differenceInCalendarDays(m, start) * dayPx;
                  return (
                    <g key={i}>
                      <line x1={x} y1={0} x2={x} y2={HEADER_HEIGHT} stroke="#E4E7EB" />
                      <text x={x + 4} y={18} fontSize={11} fill="#475467">
                        {format(m, zoom === "1yr" ? "MMM yyyy" : "MMM d")}
                      </text>
                      {zoom === "6mo" ? (
                        <text x={x + 4} y={34} fontSize={9} fill="#98A2B3">
                          {format(m, "yyyy")}
                        </text>
                      ) : null}
                      <line x1={x} y1={HEADER_HEIGHT} x2={x} y2={9999} stroke="#F2F4F7" />
                    </g>
                  );
                })}
              </g>

              {(() => {
                let cursorY = HEADER_HEIGHT;
                return groups.map((g, gi) => {
                  // Insert the between-group blank strip before the
                  // header of every group except the first. Skipped
                  // for label-less renders (groupBy === "none").
                  if (gi > 0 && g.label) cursorY += GROUP_GAP;
                  const groupStartY = cursorY;
                  if (g.label) cursorY += GROUP_HEADER_HEIGHT;
                  const rowsTop = cursorY;
                  const rowOverloadOverlays: React.ReactNode[] = [];
                  const rows = g.rows.map((row, idx) => {
                    const p = row.project;
                    const rowY = cursorY + idx * ROW_HEIGHT;
                    const activeDrag = drag?.projectId === p.id ? drag : null;
                    const previewProject = activeDrag ? applyDragToProject(p, activeDrag) : p;

                    // Per-row hatches for the "other" dimension:
                    // when grouped by team, per-group overlays only
                    // show TEAM overloads — so the OWNER-overload
                    // signal is lost unless we paint it on the row
                    // itself. Same in reverse when grouped by owner.
                    // In non-entity grouping (lane/tag/none) we paint
                    // both dimensions on the row.
                    const showOwnerOnRow = groupBy !== "owner";
                    const showTeamOnRow = groupBy !== "team";
                    const rowIvs = overloadsForProject(overloads, previewProject).filter((iv) =>
                      (iv.kind === "owner" && showOwnerOnRow) || (iv.kind === "team" && showTeamOnRow)
                    );
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
                      />
                    );
                  });
                  cursorY += g.rows.length * ROW_HEIGHT;
                  // Overload overlay: only meaningful when the group
                  // key IS an entity id (owner or team mode). We paint
                  // a translucent red band across the group's Y
                  // range for each overloaded date interval, so PMs
                  // can see at a glance which weeks the owner/team is
                  // over their cap.
                  const groupOverloads: OverloadInterval[] =
                    groupBy === "owner"
                      ? overloadsByOwner.get(g.key) ?? []
                      : groupBy === "team"
                      ? overloadsByTeam.get(g.key) ?? []
                      : [];
                  const overloadOverlays = groupOverloads.map((iv, ii) => {
                    const x1 = dayX(iv.from, start, dayPx);
                    // Right edge = end-of-day, so a single-day overload
                    // is at least `dayPx` wide.
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

              {/* Global overload indicator on the top axis:
                  continuous red strip along the affected days for
                  glanceability + one alert icon per contiguous range
                  that reveals a rich tooltip on hover ("Roland
                  assigned 4 tasks, over maximum of 3"). Renders in
                  every grouping mode so PMs never lose sight of a
                  breach the current grouping happens to hide. */}
              {anyOverloadDays.length > 0 ? (
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
                    // Icon sits above the strip, centered over the
                    // range. Clamp the range in chart-space so a
                    // range extending off-chart still shows an icon
                    // near the edge instead of vanishing.
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
                          {/* Larger transparent hit target so hover
                              feels forgiving even at r=6. */}
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

              {/* Dependency arrows between visible pairs. Drawn AFTER
                  bars so they sit on top of hatched phase fills, but
                  before the today-line so today stays the most
                  prominent vertical marker. Arrows only render when
                  BOTH endpoints are in the current rowset (per product
                  decision — off-chart arrows to nowhere are noisy). */}
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
                          violated={s.severity === "violated"}
                        />,
                      );
                    }
                  }
                  return arrows;
                })()}
              </g>

              {showToday ? (
                <g>
                  <line x1={todayX} y1={0} x2={todayX} y2={9999} stroke="#DC2626" strokeWidth={1.5} strokeDasharray="4 4" />
                  <text x={todayX + 4} y={12} fontSize={10} fill="#DC2626">Today</text>
                </g>
              ) : null}
            </svg>
          </div>
        </div>
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
}) {
  const {
    project: p, y, chartStart, dayPx, lanes, teams, users, colorBy,
    canEdit, activeDrag, onStartDrag, onOpen,
    deadlineStatuses, dependencyStatuses, isSubtask,
  } = props;
  const phases = computePhases(p);
  if (!phases.scheduled) return null;
  const lane = lanes.find((l) => l.id === p.swim_lane_id);
  const primaryTeam = teams.find((t) => t.id === p.teams[0]);
  const owner = users.find((u) => u.id === p.owner_id);
  const base = pickBase(colorBy, lane, primaryTeam, owner);

  // Subtask bars sit a bit thinner so the epic stays visually dominant.
  // Same y-anchor so the row heights are constant and drag hitboxes
  // don't shift when you expand a tree.
  const extraPad = isSubtask ? 3 : 0;
  const barY = y + BAR_PADDING + extraPad;
  const barH = ROW_HEIGHT - BAR_PADDING * 2 - extraPad * 2;

  const disc = phases.discovery!;
  const dev = phases.development!;
  const opt = phases.optimization!;
  const devGap = phases.awaitingDev;
  const optGap = phases.awaitingOptimization;

  const discX = differenceInCalendarDays(disc.start, chartStart) * dayPx;
  const discW = Math.max(2, differenceInCalendarDays(disc.end, disc.start) * dayPx);
  const devGapX = devGap ? differenceInCalendarDays(devGap.start, chartStart) * dayPx : 0;
  const devGapW = devGap ? Math.max(2, differenceInCalendarDays(devGap.end, devGap.start) * dayPx) : 0;
  const devX = differenceInCalendarDays(dev.start, chartStart) * dayPx;
  const devW = Math.max(2, differenceInCalendarDays(dev.end, dev.start) * dayPx);
  const optGapX = optGap ? differenceInCalendarDays(optGap.start, chartStart) * dayPx : 0;
  const optGapW = optGap ? Math.max(2, differenceInCalendarDays(optGap.end, optGap.start) * dayPx) : 0;
  const optX = differenceInCalendarDays(opt.start, chartStart) * dayPx;
  const optW = Math.max(2, differenceInCalendarDays(opt.end, opt.start) * dayPx);
  const optEndX = optX + optW;

  const dragMode = activeDrag?.mode;

  return (
    <g style={{ pointerEvents: "auto" }}>
      <title>{`${p.title}
Phase 1 (Discovery/Definition): ${format(disc.start, "MMM d")} → ${format(disc.end, "MMM d")}${
        devGap ? `\nAwaiting Dev:                    ${format(devGap.start, "MMM d")} → ${format(devGap.end, "MMM d")}` : ""
      }
Phase 2 (Development):          ${format(dev.start, "MMM d")} → ${format(dev.end, "MMM d")}${
        optGap ? `\nAwaiting Optimization:          ${format(optGap.start, "MMM d")} → ${format(optGap.end, "MMM d")}` : ""
      }
Phase 3 (Optimization):         ${format(opt.start, "MMM d")} → ${format(opt.end, "MMM d")}`}</title>

      {/* Bar body — captures move drags + click-to-open. Cursor set separately for view-only users. */}
      <g
        style={{ cursor: canEdit ? "grab" : "pointer" }}
        onPointerDown={(e) => onStartDrag(e, p.id, "move")}
      >
        <rect x={discX} y={barY} width={discW} height={barH} fill={base} rx={3} />
        {devGap ? (
          <g>
            <rect x={devGapX} y={barY + barH / 2 - 2} width={devGapW} height={4} fill="#CBD5E1" rx={2} />
            <rect x={devGapX} y={barY + barH / 2 - 2} width={devGapW} height={4} fill="url(#awaiting-dev-hatch)" rx={2} />
          </g>
        ) : null}
        <rect x={devX} y={barY} width={devW} height={barH} fill={base} fillOpacity={0.55} rx={3} />
        <rect x={devX} y={barY} width={devW} height={barH} fill="url(#phase-hatch)" rx={3} />
        {optGap ? (
          <g>
            <rect x={optGapX} y={barY + barH / 2 - 2} width={optGapW} height={4} fill="#CBD5E1" rx={2} />
            <rect x={optGapX} y={barY + barH / 2 - 2} width={optGapW} height={4} fill="url(#awaiting-dev-hatch)" rx={2} />
          </g>
        ) : null}
        <rect x={optX} y={barY} width={optW} height={barH} fill={base} fillOpacity={0.25} rx={3} />
      </g>

      {/* Resize handles — positioned at each divider. Wider transparent hitbox for
          easier grabbing; a thin white line shows the exact snap point. */}
      {canEdit ? (
        <>
          <ResizeHandle x={discX + discW} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "target")} label="Ready for Dev" />
          {devGap ? (
            <ResizeHandle x={devX} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "devStart")} label="Dev Begins" />
          ) : null}
          <ResizeHandle x={devX + devW} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "devEnd")} label="Dev Complete" />
          {optGap ? (
            <ResizeHandle x={optX} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "optStart")} label="Optimization Begins" />
          ) : null}
          <ResizeHandle x={optEndX} y={barY} h={barH} onDown={(e) => onStartDrag(e, p.id, "optEnd")} label="Optimization Complete" />
        </>
      ) : null}

      {/* Live-drag labels — always centered inside the resizing segment.
          Falls back to a short form when the long label won't fit. */}
      {dragMode === "target" ? (
        <SegmentLabel
          x={discX} width={discW} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(disc.end, disc.start))}
          long={`${pluralDays(differenceInCalendarDays(disc.end, disc.start))} · Discovery`}
        />
      ) : null}
      {dragMode === "devStart" && devGap ? (
        <SegmentLabel
          x={devGapX} width={devGapW} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(devGap.end, devGap.start))}
          long={`${pluralDays(differenceInCalendarDays(devGap.end, devGap.start))} · Awaiting Dev`}
        />
      ) : null}
      {dragMode === "devEnd" ? (
        <SegmentLabel
          x={devX} width={devW} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(dev.end, dev.start))}
          long={`${pluralDays(differenceInCalendarDays(dev.end, dev.start))} · Development`}
        />
      ) : null}
      {dragMode === "optStart" && optGap ? (
        <SegmentLabel
          x={optGapX} width={optGapW} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(optGap.end, optGap.start))}
          long={`${pluralDays(differenceInCalendarDays(optGap.end, optGap.start))} · Awaiting Optimization`}
        />
      ) : null}
      {dragMode === "optEnd" ? (
        <SegmentLabel
          x={optX} width={optW} y={barY} h={barH}
          short={pluralDays(differenceInCalendarDays(opt.end, opt.start))}
          long={`${pluralDays(differenceInCalendarDays(opt.end, opt.start))} · Optimization`}
        />
      ) : null}
      {dragMode === "move" && activeDrag ? (
        <g pointerEvents="none">
          <rect x={discX - 2} y={barY - 16} width={70} height={14} rx={3} fill="#101828" opacity={0.9} />
          <text x={discX + 2} y={barY - 5} fontSize={10} fill="#fff">
            {activeDrag.deltaDays > 0 ? "+" : ""}{activeDrag.deltaDays}d · {format(disc.start, "MMM d")}
          </text>
        </g>
      ) : null}

      {/* Hard-deadline tick marks + row-level alert icons.
          Deadline and dependency violations each get their own
          icon — a triangle for deadlines, a broken chain for
          dependencies — so PMs can tell at a glance which class
          of issue a row has just by scanning the right margin.
          Both icons render side-by-side when both are violated. */}
      {(() => {
        const anyDeadlineViolated = deadlineStatuses.some((s) => s.severity !== "ok");
        const anyDepViolated = dependencyStatuses.some((s) => s.severity === "violated");
        const nothingToRender = deadlineStatuses.length === 0 && !anyDeadlineViolated && !anyDepViolated;
        if (nothingToRender) return null;
        // Icon slot positions past the bar's right edge. Deadline
        // sits closer to the bar; dep alert sits further out so it
        // doesn't overlap when both are firing. Both clamp so they
        // don't render off-chart in an extreme case.
        const deadlineIconX = Math.min(optEndX + 6, chartStart ? 999999 : 0);
        const depIconX = Math.min(optEndX + 26, chartStart ? 999999 : 0);
        return (
          <g pointerEvents="none">
            {deadlineStatuses.map((s) => {
              const tickX = dayX(s.deadline.deadline_date, chartStart, dayPx) + dayPx / 2;
              const violated = s.severity !== "ok";
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
        // Phase-start x positions on this bar. Matches the phase
        // segment origins computed above; keeping the mapping local so
        // future segment tweaks don't drift the icons.
        const phaseStartX: Record<PhaseKey, number> = {
          discovery: discX,
          development: devX,
          optimization: optX,
        };
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
              const violated = ss.some((s) => s.severity === "violated");
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

function computeRange(projects: Project[], timeframeMonths: number) {
  const dates: Date[] = [];
  for (const p of projects) {
    const phases = computePhases(p);
    if (phases.scheduled) {
      dates.push(phases.discovery!.start, phases.overallEnd!);
    }
  }
  // Anchor the visible window to the selected timeframe starting today, then
  // widen if any project falls outside so bars are never clipped.
  const today = new Date();
  const minStart = startOfMonth(today);
  const minEnd = endOfMonth(addMonths(minStart, timeframeMonths - 1));
  const allDates = [minStart, minEnd, ...dates];
  const start = startOfMonth(min(allDates));
  const end = endOfMonth(max(allDates));
  return { start, end };
}

type Group = { key: string; label: string | null; rows: TreeRow[] };

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
): Group[] {
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
    const sorted = roots.slice().sort(byStart);
    const flat = sorted.flatMap((r) => rowsFor(r.id));
    return [{ key: "all", label: null, rows: flat }];
  }

  const bucket = new Map<string, Project[]>();
  const labels = new Map<string, string>();
  const sortKeys = new Map<string, number>();
  const UNASSIGNED_KEY = "__unassigned";
  const UNASSIGNED_SORT = Number.MAX_SAFE_INTEGER;

  const put = (key: string, label: string, sortKey: number | undefined, root: Project) => {
    labels.set(key, label);
    if (sortKey !== undefined) sortKeys.set(key, sortKey);
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
    }
  }

  return Array.from(bucket.entries())
    .map(([k, rs]) => ({
      key: k,
      label: labels.get(k) ?? k,
      rows: rs.slice().sort(byStart).flatMap((r) => rowsFor(r.id)),
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
  const effOptStart = i.optimization_start_date ?? i.dev_end_date;
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
