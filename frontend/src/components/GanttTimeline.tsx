import { useMemo, useRef, useState } from "react";
import { addDays, addMonths, differenceInCalendarDays, endOfMonth, format, min, max, startOfMonth } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { computePhases } from "../lib/phaseCompute";
import { useMe } from "../lib/queries";
import type { ProductArea, Project, SwimLane, User } from "../lib/types";
import type { ColorBy, GroupBy } from "../lib/viewState";

type Zoom = "6mo" | "1yr";

type Props = {
  projects: Project[];
  lanes: SwimLane[];
  areas: ProductArea[];
  users: User[];
  colorBy: ColorBy;
  groupBy: GroupBy;
  zoom: Zoom;
  onOpen: (id: string) => void;
};

const TIMEFRAME_MONTHS: Record<Zoom, number> = { "6mo": 6, "1yr": 12 };
const DAY_PX: Record<Zoom, number> = { "6mo": 8, "1yr": 3.5 };

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 48;
const GROUP_HEADER_HEIGHT = 28;
const LEFT_LABEL_WIDTH = 220;
const BAR_PADDING = 6;
const CLICK_THRESHOLD_PX = 3;
const HANDLE_HITBOX_PX = 8;

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
  const { projects, lanes, areas, users, colorBy, groupBy, zoom, onOpen } = props;
  const me = useMe();
  const canEdit = me.data?.role !== "viewer";

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

  const groups = useMemo(() => groupProjects(projects, groupBy, users, lanes, areas), [projects, groupBy, users, lanes, areas]);

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
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["projects"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  function startDrag(e: React.PointerEvent, projectId: string, mode: DragMode) {
    if (!canEdit) return;
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return;
    e.stopPropagation();
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    setDrag({
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
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startClientX;
    // Every drag mode snaps to whole days now that phase lengths are
    // stored as explicit dates rather than integer week counts.
    const raw = dx / dayPx;
    const snapped = Math.round(raw);
    const clamped = clampDelta(d, snapped);
    if (clamped !== d.deltaDays || (!d.moved && Math.abs(dx) > CLICK_THRESHOLD_PX)) {
      setDrag({ ...d, deltaDays: clamped, moved: d.moved || Math.abs(dx) > CLICK_THRESHOLD_PX });
    }
  }

  function endDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    if (!d.moved) {
      // Treat as a click.
      onOpen(d.projectId);
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
      <div className="card-surface overflow-hidden">
        <div className="flex">
          <div className="shrink-0" style={{ width: LEFT_LABEL_WIDTH }}>
            <div className="border-b border-wp-stone bg-wp-stone/40" style={{ height: HEADER_HEIGHT }} />
            {groups.map((g) => (
              <div key={`labels-${g.key}`}>
                {g.label ? (
                  <div
                    className="flex items-center justify-between border-b border-wp-stone bg-wp-stone/30 px-3 text-xs font-semibold uppercase tracking-wide text-wp-slate"
                    style={{ height: GROUP_HEADER_HEIGHT }}
                  >
                    <span>{g.label}</span>
                    <span>{g.projects.length}</span>
                  </div>
                ) : null}
                {g.projects.map((p) => (
                  <div
                    key={`lbl-${p.id}`}
                    className="flex items-center border-b border-wp-stone px-3 text-xs"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span className="truncate text-wp-ink">{p.title}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="relative flex-1 overflow-x-auto">
            <svg
              width={chartWidth}
              height={HEADER_HEIGHT + groups.reduce((s, g) => s + (g.label ? GROUP_HEADER_HEIGHT : 0) + g.projects.length * ROW_HEIGHT, 0)}
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
                return groups.map((g) => {
                  const groupStartY = cursorY;
                  if (g.label) cursorY += GROUP_HEADER_HEIGHT;
                  const rows = g.projects.map((p, idx) => {
                    const rowY = cursorY + idx * ROW_HEIGHT;
                    const activeDrag = drag?.projectId === p.id ? drag : null;
                    const previewProject = activeDrag ? applyDragToProject(p, activeDrag) : p;
                    return (
                      <Bar
                        key={p.id}
                        project={previewProject}
                        y={rowY}
                        chartStart={start}
                        dayPx={dayPx}
                        lanes={lanes}
                        areas={areas}
                        users={users}
                        colorBy={colorBy}
                        canEdit={canEdit}
                        activeDrag={activeDrag}
                        onStartDrag={startDrag}
                      />
                    );
                  });
                  cursorY += g.projects.length * ROW_HEIGHT;
                  return (
                    <g key={`grp-${g.key}`}>
                      {g.label ? (
                        <rect x={0} y={groupStartY} width={chartWidth} height={GROUP_HEADER_HEIGHT} fill="#F2F4F7" />
                      ) : null}
                      {rows}
                    </g>
                  );
                });
              })()}

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
  areas: ProductArea[];
  users: User[];
  colorBy: ColorBy;
  canEdit: boolean;
  activeDrag: DragState | null;
  onStartDrag: (e: React.PointerEvent, projectId: string, mode: DragMode) => void;
}) {
  const { project: p, y, chartStart, dayPx, lanes, areas, users, colorBy, canEdit, activeDrag, onStartDrag } = props;
  const phases = computePhases(p);
  if (!phases.scheduled) return null;
  const lane = lanes.find((l) => l.id === p.swim_lane_id);
  const area = areas.find((a) => a.id === p.product_area_id);
  const owner = users.find((u) => u.id === p.owner_id);
  const base = pickBase(colorBy, lane, area, owner);

  const barY = y + BAR_PADDING;
  const barH = ROW_HEIGHT - BAR_PADDING * 2;

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
    </g>
  );
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

type Group = { key: string; label: string | null; projects: Project[] };

function groupProjects(projects: Project[], groupBy: GroupBy, users: User[], lanes: SwimLane[], areas: ProductArea[]): Group[] {
  if (groupBy === "none") {
    const sorted = [...projects].sort(byStart);
    return [{ key: "all", label: null, projects: sorted }];
  }

  const bucket = new Map<string, Project[]>();
  const labels = new Map<string, string>();

  for (const p of projects) {
    let key = "__unassigned";
    let label = "Unassigned";
    if (groupBy === "owner") {
      const u = users.find((x) => x.id === p.owner_id);
      key = u?.id ?? key;
      label = u?.name ?? label;
    } else if (groupBy === "swim_lane") {
      const l = lanes.find((x) => x.id === p.swim_lane_id);
      key = l?.id ?? key;
      label = l?.name ?? label;
    } else if (groupBy === "product_area") {
      const a = areas.find((x) => x.id === p.product_area_id);
      key = a?.id ?? key;
      label = a?.name ?? label;
    } else if (groupBy === "tag") {
      const primary = p.tags[0] ?? null;
      key = primary ?? key;
      label = primary ? `#${primary}` : "No tag";
    }
    labels.set(key, label);
    const arr = bucket.get(key) ?? [];
    arr.push(p);
    bucket.set(key, arr);
  }

  return Array.from(bucket.entries())
    .map(([k, ps]) => ({ key: k, label: labels.get(k) ?? k, projects: ps.slice().sort(byStart) }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
}

function byStart(a: Project, b: Project) {
  return (a.start_date ?? "").localeCompare(b.start_date ?? "");
}

function pickBase(colorBy: ColorBy, lane?: SwimLane, area?: ProductArea, owner?: User): string {
  if (colorBy === "product_area") return area?.color ?? "#94a3b8";
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
