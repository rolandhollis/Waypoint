import { useMemo, useRef, useState, useEffect } from "react";
import { Star } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addQuarters,
  endOfQuarter,
  format,
  getQuarter,
  getYear,
  parseISO,
  startOfQuarter,
} from "date-fns";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { pillTextColor, tint } from "../lib/colors";
import { useCanWrite } from "../lib/queries";
import type { Kpi, Project, SwimLane, Team, User } from "../lib/types";
import type { GroupBy } from "../lib/viewState";

/**
 * "By Quarter" roadmap layout. Renders as a horizontal set of
 * columns — one per rolling quarter — with items placed in the
 * column that matches their completion quarter (derived from
 * `optimization_end_date`). This is a wholly different surface
 * from the Gantt: no bars, no dates, no dependencies — just a
 * priority-ordered list of what completes in each quarter.
 *
 * Column window: **current quarter + next 3 (total 4)**. Anything
 * completing before the current quarter (in the past) or after
 * the fourth column (too far future) is dropped. This aligns with
 * a rolling 12-month outlook and gives a clean 4-column layout on
 * desktop, degrading to 2 columns on `md` and 1 on mobile.
 *
 * Ordering inside a column is the roadmap priority composite —
 * `global_priority` first (with 0 treated as Infinity so unranked
 * items fall to the bottom), then swim-lane order, then
 * per-lane `projects.position`, then `updated_at DESC` for
 * recency, then `id` as a stable final tiebreaker.
 *
 * Filtering is entirely the caller's responsibility: the same
 * `applyFilters`-filtered set the Gantt receives feeds in here
 * (including the "Key strategic only" chip). Archive / Parking
 * Lot / hidden-from-roadmap items are also already dropped
 * upstream by `RoadmapView.visibleProjects`.
 *
 * Grouping (`groupBy` prop) mirrors the Gantt's Group-by dropdown
 * exactly — same values, same duplication semantics, same sort
 * keys. When `groupBy !== "none"` the layout switches to a grid
 * with a fixed-width group label column on the left and the four
 * quarter columns to its right; each group is a single row and
 * each cell in that row is the priority-sorted list of items in
 * that group whose completion quarter matches the column.
 */
export function RoadmapQuartersView({
  projects,
  lanes,
  teams,
  users,
  kpis,
  groupBy = "none",
  onOpen,
  now = new Date(),
  pdfMode = false,
  keyStrategicFilterActive = false,
}: {
  projects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  kpis: Kpi[];
  /**
   * Group-by dimension. Mirrors the Gantt's Group-by dropdown so a
   * user flipping between Gantt and Quarters keeps the same grouping.
   * `"none"` renders the historical 4-column ungrouped layout.
   */
  groupBy?: GroupBy;
  /** Fires with the clicked project id — opens the detail modal. */
  onOpen: (id: string) => void;
  /**
   * Test hook: override "today" so the column set is deterministic
   * in unit tests / snapshot fixtures. Production always uses the
   * live wall clock.
   */
  now?: Date;
  /**
   * PDF-mode flag threaded from `RoadmapView` for parity with the
   * Gantt exporter. Historically switched the per-column and
   * per-cell overflow behavior so the exporter captured every
   * item, but the interactive view now *also* renders every item
   * (no per-cell max-height / scroll — the outer roadmap area
   * scrolls the document instead), so this prop is currently a
   * no-op inside the Quarters view. Retained for API stability
   * with the caller in `RoadmapView` and in case a future
   * PDF-only bookend re-uses it.
   */
  pdfMode?: boolean;
  /**
   * Mirror of the caller's `roadmap.filters.keyStrategicOnly` chip
   * state. When true AND the user clicks the star to *un-mark* an
   * item as key strategic, we intercept the click with a confirm
   * modal — otherwise the toggle would silently vanish the card
   * from the current (key-strategic-only) view with no undo path.
   * The `false → true` direction always fires silently regardless
   * of this flag; adding a star can never remove an item from the
   * filtered set.
   */
  keyStrategicFilterActive?: boolean;
}) {
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const kpisById = useMemo(() => new Map(kpis.map((k) => [k.id, k])), [kpis]);

  // The Quarters view is the ONLY roadmap surface where the strategic-
  // star affordance is interactive: clicking a card's star flips
  // `is_key_strategic` with an optimistic PATCH that mirrors the
  // GanttTimeline `patchMutation` pattern (cache snapshot + rollback
  // on error, invalidate on settle). Every other star render site on
  // the roadmap (Gantt row label, Prioritization Column B, detail
  // header title) stays display-only.
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const strategicToggle = useMutation({
    mutationFn: (v: { id: string; next: boolean }) =>
      api<Project>(`/projects/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_key_strategic: v.next }),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["projects"] });
      const prev = qc.getQueryData<Project[]>(["projects"]);
      if (prev) {
        qc.setQueryData<Project[]>(
          ["projects"],
          prev.map((p) => (p.id === v.id ? { ...p, is_key_strategic: v.next } : p)),
        );
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["projects"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  // When the "Key strategic only" chip is on, un-starring an item
  // would silently remove it from the current view — one-click,
  // no undo. Intercept that specific transition with a confirm
  // modal; every other path (marking as strategic, or unstarring
  // with the filter off) fires the mutation immediately, matching
  // the pre-existing behavior.
  const [confirmingUnstar, setConfirmingUnstar] = useState<Project | null>(null);
  const onToggleKeyStrategic = canWrite
    ? (p: Project) => {
        if (p.is_key_strategic && keyStrategicFilterActive) {
          setConfirmingUnstar(p);
          return;
        }
        strategicToggle.mutate({ id: p.id, next: !p.is_key_strategic });
      }
    : null;

  // Build the four-quarter window anchored on today. `startOfQuarter`
  // hands us the first day of the current quarter; each subsequent
  // column is `+1 quarter`. Labels use `getQuarter` + `getYear` for
  // the header (`Q3 2026`) and `format(..., "MMM")` on the start /
  // end for the subline (`Jul – Sep`).
  const columns = useMemo(() => {
    const cols: {
      key: string;
      label: string;
      subline: string;
      start: Date;
      end: Date;
    }[] = [];
    for (let i = 0; i < 4; i++) {
      const anchor = addQuarters(startOfQuarter(now), i);
      const start = startOfQuarter(anchor);
      const end = endOfQuarter(anchor);
      cols.push({
        key: `${getYear(start)}-Q${getQuarter(start)}`,
        label: `Q${getQuarter(start)} ${getYear(start)}`,
        subline: `${format(start, "MMM")} – ${format(end, "MMM")}`,
        start,
        end,
      });
    }
    return cols;
  }, [now]);

  // Priority composite matching the spec:
  //   1) global_priority ASC (0 → Infinity so unranked lands last)
  //   2) swim_lane.order ASC (unassigned → Infinity)
  //   3) projects.position ASC
  //   4) updated_at DESC
  //   5) id ASC (deterministic final tiebreaker)
  const byPriority = useMemo(
    () => (a: Project, b: Project) => {
      const gpA = a.global_priority === 0 ? Number.POSITIVE_INFINITY : a.global_priority;
      const gpB = b.global_priority === 0 ? Number.POSITIVE_INFINITY : b.global_priority;
      if (gpA !== gpB) return gpA - gpB;
      const laneA = a.swim_lane_id ? lanesById.get(a.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const laneB = b.swim_lane_id ? lanesById.get(b.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      if (laneA !== laneB) return laneA - laneB;
      if (a.position !== b.position) return a.position - b.position;
      const updatedCmp = (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      if (updatedCmp !== 0) return updatedCmp;
      return a.id.localeCompare(b.id);
    },
    [lanesById],
  );

  // Bucket each eligible project into the matching column.
  //   * `optimization_end_date` missing → drop (spec: same
  //     eligibility as the roadmap; needs the completion date to
  //     resolve a quarter).
  //   * completion before the earliest visible quarter → drop
  //     (item is in the past).
  //   * completion after the latest visible quarter → drop
  //     (too far future for the 4-column rolling window).
  //
  // Result: `bucketed[i]` is the priority-sorted list of every
  // project whose completion quarter matches `columns[i]`. Feeds
  // both the ungrouped rendering (as-is) and the grouped rendering
  // (further split by group keys, sort preserved).
  const bucketed = useMemo(() => {
    const buckets: Project[][] = columns.map(() => []);
    if (columns.length === 0) return buckets;
    const first = columns[0];
    const last = columns[columns.length - 1];
    if (!first || !last) return buckets;
    const firstStart = first.start.getTime();
    const lastEnd = last.end.getTime();
    for (const p of projects) {
      if (!p.optimization_end_date) continue;
      const completion = parseISO(`${p.optimization_end_date}T00:00:00`).getTime();
      if (Number.isNaN(completion)) continue;
      if (completion < firstStart || completion > lastEnd) continue;
      // Linear scan is fine — always 4 columns.
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const bucket = buckets[i];
        if (!col || !bucket) continue;
        if (completion <= col.end.getTime()) {
          bucket.push(p);
          break;
        }
      }
    }
    for (const b of buckets) b.sort(byPriority);
    return buckets;
  }, [projects, columns, byPriority]);

  // Grouped view: split each per-quarter bucket further by group
  // key using the same duplication semantics as the Gantt's
  // `groupTreeRows`. Multi-value groupings (team, kpi) fan an item
  // out across every group it belongs to; single-value groupings
  // (owner, swim_lane, tag-primary) put it in exactly one bucket.
  //
  // Group ENUMERATION comes from the full `projects` set — not from
  // `bucketed` — so a group whose items all fall outside the
  // rolling 4-quarter window (e.g. Team A only has projects
  // completing next year) still renders as an all-empty row. That
  // matches the spec's "don't hide a group just because it has no
  // scheduled work in the visible quarters" requirement. Groups
  // that don't appear on any project in `projects` at all are
  // omitted — showing every team/KPI/owner in the workspace when
  // none of them are active on the roadmap would be more noise
  // than signal.
  //
  // Group ordering matches the Gantt exactly:
  //   * team / swim_lane / kpi → admin-managed `order` ascending
  //   * owner / tag → alphabetical by label
  //   * "Unassigned" / "(no KPI)" bucket always last
  const groups = useMemo(() => {
    if (groupBy === "none") return null;

    const UNASSIGNED_KEY = "__unassigned";
    type GroupAcc = {
      key: string;
      label: string;
      color: string | null;
      sortKey: number | null;
      alphaKey: string;
      buckets: Project[][];
    };
    const byKey = new Map<string, GroupAcc>();
    const ensure = (
      key: string,
      label: string,
      color: string | null,
      sortKey: number | null,
    ): GroupAcc => {
      const existing = byKey.get(key);
      if (existing) return existing;
      const created: GroupAcc = {
        key,
        label,
        color,
        sortKey,
        alphaKey: label.toLowerCase(),
        buckets: columns.map(() => []),
      };
      byKey.set(key, created);
      return created;
    };

    // Resolve the (label, color, sortKey) tuples this project
    // belongs to. Multi-value groupings return more than one entry;
    // "unassigned" is a shared sentinel so items with e.g. no team
    // pool into one row rather than fragmenting per-project.
    const groupsFor = (p: Project): {
      key: string;
      label: string;
      color: string | null;
      sortKey: number | null;
    }[] => {
      if (groupBy === "owner") {
        const u = p.owner_id ? usersById.get(p.owner_id) : undefined;
        if (u) return [{ key: u.id, label: u.name, color: u.color ?? null, sortKey: null }];
        return [{ key: UNASSIGNED_KEY, label: "Unassigned", color: null, sortKey: null }];
      }
      if (groupBy === "swim_lane") {
        const l = p.swim_lane_id ? lanesById.get(p.swim_lane_id) : undefined;
        if (l) return [{ key: l.id, label: l.name, color: l.color, sortKey: l.order }];
        return [{ key: UNASSIGNED_KEY, label: "Unassigned", color: null, sortKey: null }];
      }
      if (groupBy === "team") {
        // Multi-value dimension routed to a SINGLE bucket keyed on
        // the primary (index 0) team. Matches the Gantt's
        // `groupTreeRows` behavior — the PM ranks `teams` in the
        // detail panel and index 0 is the authoritative slot on
        // the roadmap. Secondary teams still surface as chips on
        // the per-item card, and team filtering still matches any
        // team anywhere in the array (see filtering.ts).
        const primaryId = p.teams[0] ?? null;
        const primaryTeam = primaryId ? teamsById.get(primaryId) : undefined;
        if (primaryTeam) {
          return [{ key: primaryTeam.id, label: primaryTeam.name, color: primaryTeam.color, sortKey: primaryTeam.order }];
        }
        return [{ key: UNASSIGNED_KEY, label: "Unassigned", color: null, sortKey: null }];
      }
      if (groupBy === "tag") {
        // Gantt uses the primary (first) tag only — single-value.
        const primary = p.tags[0] ?? null;
        if (primary) return [{ key: primary, label: `#${primary}`, color: null, sortKey: null }];
        return [{ key: UNASSIGNED_KEY, label: "No tag", color: null, sortKey: null }];
      }
      if (groupBy === "kpi") {
        // Multi-value dimension routed to a SINGLE bucket keyed on
        // the primary (index 0) KPI. Same rationale as team grouping
        // — each item appears exactly once, under its highest-ranked
        // KPI. Unknown KPI ids (deleted since save) fall through to
        // "(no KPI)" so a secondary KPI is never silently promoted.
        const primaryKpiId = p.kpis[0] ?? null;
        const primaryKpi = primaryKpiId ? kpisById.get(primaryKpiId) : undefined;
        if (primaryKpi) {
          return [{ key: primaryKpi.id, label: primaryKpi.name, color: primaryKpi.color, sortKey: primaryKpi.order }];
        }
        return [{ key: UNASSIGNED_KEY, label: "(no KPI)", color: null, sortKey: null }];
      }
      return [];
    };

    // Pass 1 — enumerate every group that has at least one project
    // in the (filtered) source set, regardless of whether that
    // project lands inside the visible 4-quarter window. This is
    // what preserves the "all-empty row" case.
    for (const p of projects) {
      for (const g of groupsFor(p)) ensure(g.key, g.label, g.color, g.sortKey);
    }

    // Pass 2 — walk the already-priority-sorted per-quarter buckets
    // and drop each project into the matching group cell(s). Iterating
    // `bucketed` (not `projects`) is what carries the priority
    // ordering into each cell without a second sort pass.
    for (let colIdx = 0; colIdx < bucketed.length; colIdx++) {
      const cell = bucketed[colIdx];
      if (!cell) continue;
      for (const p of cell) {
        for (const g of groupsFor(p)) {
          const acc = byKey.get(g.key);
          if (!acc) continue;
          acc.buckets[colIdx]?.push(p);
        }
      }
    }

    // Sort groups: admin-managed order for team / swim_lane / kpi,
    // alphabetical for owner / tag. Unassigned always last.
    const list = Array.from(byKey.values());
    const useAdminOrder = groupBy === "team" || groupBy === "swim_lane" || groupBy === "kpi";
    list.sort((a, b) => {
      const aUn = a.key === UNASSIGNED_KEY;
      const bUn = b.key === UNASSIGNED_KEY;
      if (aUn !== bUn) return aUn ? 1 : -1;
      if (useAdminOrder) {
        const aw = a.sortKey ?? Number.MAX_SAFE_INTEGER;
        const bw = b.sortKey ?? Number.MAX_SAFE_INTEGER;
        if (aw !== bw) return aw - bw;
      }
      return a.alphaKey.localeCompare(b.alphaKey);
    });
    return list;
  }, [groupBy, projects, bucketed, columns, teamsById, usersById, lanesById, kpisById]);

  const totalCount = bucketed.reduce((n, list) => n + list.length, 0);
  const emptyMessage = (
    <div className="mb-3 rounded-md border border-dashed border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
      No initiatives complete in the next four quarters with the current filters.
    </div>
  );

  // Rendered in both the ungrouped and grouped return paths so a
  // click on any card's star — no matter which layout is active —
  // routes through the same confirmation. Node is a no-op when
  // `confirmingUnstar` is null (Radix skips the portal entirely).
  const confirmDialog = (
    <UnstarConfirmDialog
      project={confirmingUnstar}
      onCancel={() => setConfirmingUnstar(null)}
      onConfirm={() => {
        if (confirmingUnstar) {
          strategicToggle.mutate({ id: confirmingUnstar.id, next: false });
        }
        setConfirmingUnstar(null);
      }}
    />
  );

  // -----------------------------------------------------------------
  // Ungrouped path — historical 4-column card layout, unchanged.
  // -----------------------------------------------------------------
  if (groupBy === "none" || groups === null) {
    return (
      <>
      <div className="p-4" data-roadmap-capture-root="true">
        {totalCount === 0 ? emptyMessage : null}
        <div
          className={cn(
            "grid gap-4",
            "grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
          )}
        >
          {columns.map((col, colIdx) => {
            const items = bucketed[colIdx] ?? [];
            return (
              <div
                key={col.key}
                className={cn(
                  "flex flex-col rounded-lg border border-wp-stone bg-white shadow-sm",
                )}
              >
                {/* Sticky header — pins to the top of the column so
                    the quarter label stays visible while the outer
                    roadmap scroller (`RoadmapView`) scrolls the
                    document. The column itself no longer has an
                    internal scroller: every item in every quarter
                    renders in full and the column grows to fit. */}
                <div className="sticky top-0 z-10 border-b border-wp-stone bg-white/95 px-3 py-2 backdrop-blur-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-wp-ink">{col.label}</div>
                    <div className="text-[11px] uppercase tracking-wide text-wp-slate">
                      {items.length} {items.length === 1 ? "item" : "items"}
                    </div>
                  </div>
                  <div className="text-[11px] text-wp-slate">{col.subline}</div>
                </div>
                <div className="flex-1 space-y-2 px-2 py-2">
                  {items.length === 0 ? (
                    <div className="px-2 py-4 text-center text-[11px] italic text-wp-slate/70">
                      No items completing this quarter
                    </div>
                  ) : (
                    items.map((p) => (
                      <QuarterItemCard
                        key={p.id}
                        project={p}
                        teams={resolveTeams(p, teamsById)}
                        owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                        onOpen={onOpen}
                        onToggleKeyStrategic={onToggleKeyStrategic}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {confirmDialog}
      </>
    );
  }

  // -----------------------------------------------------------------
  // Grouped path — CSS grid with a group-label column on the left
  // and the four quarter columns to its right. Mobile falls back to
  // stacked sections (one per group) so the same content stays
  // readable on narrow screens without horizontal scrolling.
  // -----------------------------------------------------------------
  const groupColumnLabel =
    groupBy === "team"
      ? "Team"
      : groupBy === "owner"
        ? "Owner"
        : groupBy === "swim_lane"
          ? "Swim Lane"
          : groupBy === "kpi"
            ? "KPI"
            : groupBy === "tag"
              ? "Tag"
              : "Group";

  return (
    <>
    <div className="p-4" data-roadmap-capture-root="true">
      {totalCount === 0 ? emptyMessage : null}

      {/* ---------- Desktop / tablet (md+) ---------- */}
      {/* Single CSS grid: leftmost 200px column for the group label,
          then 4 equal-width quarter columns. `minmax(0, 1fr)` on the
          quarter columns lets `min-w-0` cells shrink instead of
          forcing horizontal overflow. */}
      <div className="hidden md:block">
        <div
          className={cn(
            "grid overflow-hidden rounded-lg border border-wp-stone bg-white shadow-sm",
            "grid-cols-[200px_repeat(4,minmax(0,1fr))]",
          )}
        >
          {/* Header row: [group column label] | Q1 | Q2 | Q3 | Q4.
              Sticky within the outer scroll container so the quarter
              labels stay visible while the user scrolls the roadmap
              tab downward. */}
          <div
            className={cn(
              "sticky top-0 z-20 border-b border-r border-wp-stone bg-white/95 px-3 py-2 backdrop-blur-sm",
              "text-[11px] font-semibold uppercase tracking-wide text-wp-slate",
            )}
          >
            {groupColumnLabel}
          </div>
          {columns.map((col, colIdx) => {
            const items = bucketed[colIdx] ?? [];
            return (
              <div
                key={col.key}
                className={cn(
                  "sticky top-0 z-20 border-b border-wp-stone bg-white/95 px-3 py-2 backdrop-blur-sm",
                  colIdx < columns.length - 1 ? "border-r" : "",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-semibold text-wp-ink">{col.label}</div>
                  <div className="text-[11px] uppercase tracking-wide text-wp-slate">
                    {items.length} {items.length === 1 ? "item" : "items"}
                  </div>
                </div>
                <div className="text-[11px] text-wp-slate">{col.subline}</div>
              </div>
            );
          })}

          {/* One row per group. Empty rows still render — the user
              needs to see that a team / KPI has no scheduled work
              in the rolling window rather than having the row
              silently disappear. */}
          {groups.map((group, rowIdx) => {
            const isLastRow = rowIdx === groups.length - 1;
            return (
              <GroupRow
                key={group.key}
                group={group}
                columns={columns}
                isLastRow={isLastRow}
                teamsById={teamsById}
                usersById={usersById}
                onOpen={onOpen}
                onToggleKeyStrategic={onToggleKeyStrategic}
              />
            );
          })}
        </div>
      </div>

      {/* ---------- Mobile (<md) ---------- */}
      {/* Grid doesn't scale to phone widths (200px label + 4 cells
          would push the item cards into unreadable slivers), so on
          narrow screens each group becomes its own stacked section
          matching the current ungrouped mobile layout. */}
      <div className="space-y-4 md:hidden">
        {groups.map((group) => (
          <div
            key={group.key}
            className="rounded-lg border border-wp-stone bg-white shadow-sm"
          >
            <div className="border-b border-wp-stone px-3 py-2">
              <GroupLabel group={group} usersById={usersById} />
            </div>
            <div className="space-y-3 p-3">
              {columns.map((col, colIdx) => {
                const items = group.buckets[colIdx] ?? [];
                return (
                  <div key={col.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <div className="text-xs font-semibold text-wp-ink">
                        {col.label}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-wp-slate">
                        {col.subline}
                      </div>
                    </div>
                    {items.length === 0 ? (
                      <div className="rounded border border-dashed border-wp-stone px-2 py-2 text-center text-[11px] italic text-wp-slate/70">
                        —
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {items.map((p) => (
                          <QuarterItemCard
                            key={p.id}
                            project={p}
                            teams={resolveTeams(p, teamsById)}
                            owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                            onOpen={onOpen}
                            onToggleKeyStrategic={onToggleKeyStrategic}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
    {confirmDialog}
    </>
  );
}

/** Shape shared between the desktop grid row and the mobile section header. */
type GroupView = {
  key: string;
  label: string;
  color: string | null;
  buckets: Project[][];
};

/**
 * One row of the desktop grouped grid. Rendered as (1 + N columns)
 * grid CHILDREN — the outer grid is what actually lays them out,
 * so this component emits siblings rather than a wrapping element.
 * A React Fragment gives us the grouping-in-source without adding
 * a DOM node that would break the grid layout.
 */
function GroupRow({
  group,
  columns,
  isLastRow,
  teamsById,
  usersById,
  onOpen,
  onToggleKeyStrategic,
}: {
  group: GroupView;
  columns: { key: string }[];
  isLastRow: boolean;
  teamsById: Map<string, Team>;
  usersById: Map<string, User>;
  onOpen: (id: string) => void;
  /**
   * Non-null on the Quarters view when the caller can write — see
   * the parent `RoadmapQuartersView` mutation. `null` when the user
   * is a viewer OR when the star should stay non-interactive; the
   * card renders a plain read-only star in that case.
   */
  onToggleKeyStrategic: ((p: Project) => void) | null;
}) {
  const border = isLastRow ? "" : "border-b";
  return (
    <>
      {/* Left group label cell. `sticky left-0` keeps the label
          pinned when a narrow viewport forces the row to scroll
          horizontally; on wider viewports the grid fits and the
          sticky is a no-op. `min-w-0` on the neighboring cells
          keeps the layout from overflowing. */}
      <div
        className={cn(
          "sticky left-0 z-10 flex items-start gap-2 border-r border-wp-stone bg-white px-3 py-2",
          border,
        )}
      >
        <GroupLabel group={group} usersById={usersById} />
      </div>
      {columns.map((col, colIdx) => {
        const items = group.buckets[colIdx] ?? [];
        const cellBorder = colIdx < columns.length - 1 ? "border-r" : "";
        return (
          <div
            key={col.key}
            className={cn(
              // Cells grow to fit their items — no fixed max-height,
              // no per-cell scroller. The outer roadmap area
              // (`RoadmapView`) is what actually scrolls when the
              // grid runs long, so a PM sees every item in every
              // team-row without hunting inside a nested scroller.
              "min-w-0 border-wp-stone px-2 py-2",
              cellBorder,
              border,
            )}
          >
            {items.length === 0 ? (
              <div className="px-1 py-2 text-center text-[11px] italic text-wp-slate/60">
                —
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((p) => (
                  <QuarterItemCard
                    key={p.id}
                    project={p}
                    teams={resolveTeams(p, teamsById)}
                    owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                    onOpen={onOpen}
                    onToggleKeyStrategic={onToggleKeyStrategic}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Group name + optional color chip. Shared between the desktop
 * grid's left column and the mobile stacked section headers so
 * the two surfaces present the same identifying affordances.
 * Chip semantics mirror the Gantt / Board:
 *   - team / swim_lane / kpi → filled color square
 *   - owner → circular initials avatar tinted with owner.color
 *   - tag / unassigned → no chip
 */
function GroupLabel({
  group,
  usersById,
}: {
  group: GroupView;
  usersById: Map<string, User>;
}) {
  // Owner grouping renders an initials avatar instead of a plain
  // square so a viewer scanning the label column recognises the
  // person before reading the name (Board / detail-panel affordance).
  const owner = usersById.get(group.key);
  const isOwnerChip = owner !== undefined && group.color !== null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {isOwnerChip && owner ? (
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ background: owner.color }}
          aria-hidden
        >
          {initials(owner.name)}
        </span>
      ) : group.color ? (
        <span
          className="inline-block h-3 w-3 shrink-0 rounded-sm border"
          style={{ background: group.color, borderColor: group.color }}
          aria-hidden
        />
      ) : null}
      <span
        className="truncate text-sm font-semibold text-wp-ink"
        title={group.label}
      >
        {group.label}
      </span>
    </div>
  );
}

/**
 * Compact per-item card rendered inside a quarter cell. Whole
 * card is the click target so PMs can drill straight into the
 * detail modal without hunting for a specific affordance. All
 * assigned teams render as pills in the item's team order
 * (primary first, then secondaries as ranked in the detail modal);
 * a star for `is_key_strategic` and an owner initial share the
 * same row below the title, wrapping if the pill list is long.
 *
 * The outer element is a `div[role="button"]` rather than a real
 * `<button>` so the strategic-star toggle can nest as its own
 * `<button>` without violating "no interactive-in-interactive"
 * HTML. Enter / Space are wired through by hand to match native
 * button keyboard activation.
 */
function QuarterItemCard({
  project,
  teams,
  owner,
  onOpen,
  onToggleKeyStrategic,
}: {
  project: Project;
  /**
   * Ordered list of teams assigned to the project — primary (index
   * 0) first, then secondaries in the order the PM set on the
   * detail modal. Deleted-team ids are filtered out upstream by
   * `resolveTeams` so this array only ever holds live teams.
   */
  teams: Team[];
  owner: User | undefined;
  onOpen: (id: string) => void;
  /**
   * When non-null the star renders as a clickable button that flips
   * `is_key_strategic`; when null (viewer role, or any surface that
   * wants to keep the star display-only) it renders as a plain icon
   * with the same fill/outline styling.
   */
  onToggleKeyStrategic: ((p: Project) => void) | null;
}) {
  const canToggleStar = onToggleKeyStrategic !== null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(project.id);
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer flex-col gap-1.5 rounded-md border border-wp-stone bg-white px-2.5 py-2 text-left transition",
        "hover:border-wp-red/40 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red/40",
      )}
      title={project.title}
      aria-label={`Open ${project.title}`}
    >
      <div className="flex items-start gap-1.5">
        <div
          className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-wp-ink"
        >
          {project.title}
        </div>
        {canToggleStar ? (
          <button
            type="button"
            onClick={(e) => {
              // Row-open sits on the outer div; stop the star click
              // from bubbling up so the detail modal doesn't fire on
              // a toggle.
              e.stopPropagation();
              onToggleKeyStrategic!(project);
            }}
            onKeyDown={(e) => {
              // Same reason as above for keyboard activation — the
              // outer div's onKeyDown also opens the modal on
              // Enter / Space, which we don't want when focus is on
              // the star.
              e.stopPropagation();
            }}
            aria-label={
              project.is_key_strategic
                ? "Unmark as key strategic"
                : "Mark as key strategic"
            }
            aria-pressed={project.is_key_strategic}
            title={
              project.is_key_strategic
                ? "Key strategic \u2014 click to unmark"
                : "Mark as key strategic"
            }
            className={cn(
              "mt-0.5 inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 transition hover:bg-wp-stone/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red/40",
              project.is_key_strategic
                ? "text-wp-red hover:text-wp-red/80"
                : "text-wp-slate/40 hover:text-wp-slate",
            )}
          >
            <Star
              size={12}
              className={project.is_key_strategic ? "fill-wp-red" : ""}
            />
          </button>
        ) : (
          <Star
            size={12}
            className={cn(
              "mt-0.5 shrink-0",
              project.is_key_strategic
                ? "fill-wp-red text-wp-red"
                : "text-wp-slate/40",
            )}
            aria-label={
              project.is_key_strategic ? "Key strategic" : "Not key strategic"
            }
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-wp-slate">
        {teams.map((t) => (
          <span
            key={t.id}
            // `max-w-full truncate` keeps a single very long team name
            // from blowing out the (narrow) card width — it ellipsizes
            // inside the pill instead of overflowing horizontally. Every
            // other pill wraps to the next line naturally via the
            // parent's `flex-wrap`.
            className="inline-flex max-w-full items-center truncate rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
            style={{
              borderColor: t.color,
              background: tint(t.color, 0.14),
              color: pillTextColor(t.color),
            }}
            title={`Team: ${t.name}`}
          >
            {t.name}
          </span>
        ))}
        {owner ? (
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
            style={{ background: owner.color }}
            title={owner.name}
          >
            {initials(owner.name)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Resolve `project.teams` (an ordered array of team ids — primary
 * first, secondaries in the order the PM set on the detail modal)
 * into an ordered array of live `Team` records. Ids that aren't in
 * `teamsById` (deleted teams that haven't been cleaned up from the
 * project row yet) are silently dropped so the pill row on the
 * card never renders a broken chip.
 *
 * Order preservation is load-bearing: the Quarters card is the one
 * roadmap surface where a PM can see the full team assignment
 * without opening the detail modal, and "primary team leftmost"
 * matches the same ranking the detail modal, filters, and Gantt
 * grouping already use.
 */
function resolveTeams(
  project: Project,
  teamsById: Map<string, Team>,
): Team[] {
  const out: Team[] = [];
  for (const id of project.teams) {
    const t = teamsById.get(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Confirm dialog surfaced when the user clicks the strategic-star
 * to *un-mark* an item while the roadmap's "Key strategic only"
 * filter is active. Without this interstitial the click would
 * silently drop the card out of the current view — one accidental
 * click, no undo. Cancel gets autofocus and is styled as the
 * primary path so a stray Enter closes without mutating.
 *
 * Uses the same Radix Dialog primitive the rest of the app
 * standardizes on (see `PhaseDatePromptModal`, `StatusUpdateModal`).
 * The component is unmounted entirely when `project === null`;
 * Radix handles the portal / overlay lifecycle.
 */
function UnstarConfirmDialog({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Cancel button ref for explicit programmatic focus. Radix
  // Dialog's default is to focus the first focusable descendant,
  // which would be the Radix-injected close (X) button if we had
  // one — we don't, so the default lands on Cancel already, but
  // pinning it explicitly via `onOpenAutoFocus` keeps the focus
  // target stable if we later add a close button in the header.
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Keep the last non-null project so the modal content doesn't
  // flash to empty during Radix's exit animation frame — the
  // parent nulls `project` synchronously on confirm/cancel, but
  // Radix keeps the DOM mounted for a beat afterward.
  const [snapshot, setSnapshot] = useState<Project | null>(project);
  useEffect(() => {
    if (project) setSnapshot(project);
  }, [project]);

  const open = project !== null;
  const displayed = project ?? snapshot;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-base font-semibold text-wp-ink">
            Remove from key-strategic filter?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-wp-slate">
            You're viewing a report filtered to key-strategic items. Removing the star from{" "}
            <span className="font-medium text-wp-ink">
              &ldquo;{displayed?.title ?? ""}&rdquo;
            </span>{" "}
            will hide it from this view.
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              className="btn-primary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={onConfirm}
            >
              Remove star
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
