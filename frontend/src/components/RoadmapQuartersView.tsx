import { useMemo } from "react";
import { Star } from "lucide-react";
import {
  addQuarters,
  endOfQuarter,
  format,
  getQuarter,
  getYear,
  parseISO,
  startOfQuarter,
} from "date-fns";
import { cn } from "../lib/cn";
import { readableOn, tint } from "../lib/colors";
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
   * When true, drop the per-column max-height / overflow-y-auto
   * constraints so the PDF exporter captures every item in every
   * column (no clipped bodies). The interactive view keeps the
   * caps so the page itself doesn't grow — matching the same
   * `pdfMode` bookend the Gantt uses.
   */
  pdfMode?: boolean;
}) {
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const kpisById = useMemo(() => new Map(kpis.map((k) => [k.id, k])), [kpis]);

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

  // -----------------------------------------------------------------
  // Ungrouped path — historical 4-column card layout, unchanged.
  // -----------------------------------------------------------------
  if (groupBy === "none" || groups === null) {
    return (
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
                  pdfMode
                    ? "overflow-visible"
                    : "max-h-[calc(100vh-320px)] overflow-hidden",
                )}
              >
                {/* Sticky header — pins to the top of the column so
                    the quarter label stays visible while the body
                    scrolls internally. */}
                <div className="sticky top-0 z-10 border-b border-wp-stone bg-white/95 px-3 py-2 backdrop-blur-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-wp-ink">{col.label}</div>
                    <div className="text-[11px] uppercase tracking-wide text-wp-slate">
                      {items.length} {items.length === 1 ? "item" : "items"}
                    </div>
                  </div>
                  <div className="text-[11px] text-wp-slate">{col.subline}</div>
                </div>
                <div
                  className={cn(
                    "flex-1 space-y-2 px-2 py-2",
                    pdfMode ? "overflow-visible" : "overflow-y-auto",
                  )}
                >
                  {items.length === 0 ? (
                    <div className="px-2 py-4 text-center text-[11px] italic text-wp-slate/70">
                      No items completing this quarter
                    </div>
                  ) : (
                    items.map((p) => (
                      <QuarterItemCard
                        key={p.id}
                        project={p}
                        team={p.teams[0] ? teamsById.get(p.teams[0]) : undefined}
                        owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                        onOpen={onOpen}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
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
                pdfMode={pdfMode}
                teamsById={teamsById}
                usersById={usersById}
                onOpen={onOpen}
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
                            team={p.teams[0] ? teamsById.get(p.teams[0]) : undefined}
                            owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                            onOpen={onOpen}
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
  pdfMode,
  teamsById,
  usersById,
  onOpen,
}: {
  group: GroupView;
  columns: { key: string }[];
  isLastRow: boolean;
  pdfMode: boolean;
  teamsById: Map<string, Team>;
  usersById: Map<string, User>;
  onOpen: (id: string) => void;
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
              "min-w-0 border-wp-stone px-2 py-2",
              cellBorder,
              border,
              pdfMode ? "" : "max-h-[220px] overflow-y-auto",
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
                    team={p.teams[0] ? teamsById.get(p.teams[0]) : undefined}
                    owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                    onOpen={onOpen}
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
 * detail modal without hunting for a specific affordance. Team
 * chip (primary team only), a star for `is_key_strategic`, and
 * an owner initial live in a single row below the title.
 */
function QuarterItemCard({
  project,
  team,
  owner,
  onOpen,
}: {
  project: Project;
  team: Team | undefined;
  owner: User | undefined;
  onOpen: (id: string) => void;
}) {
  const teamBg = team ? tint(team.color, 0.14) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(project.id)}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-md border border-wp-stone bg-white px-2.5 py-2 text-left transition",
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
        {project.is_key_strategic ? (
          <Star
            size={12}
            className="mt-0.5 shrink-0 fill-wp-red text-wp-red"
            aria-label="Key strategic"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-wp-slate">
        {team && teamBg ? (
          <span
            className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
            style={{ borderColor: team.color, background: teamBg, color: readableOn(teamBg) }}
            title={`Team: ${team.name}`}
          >
            {team.name}
          </span>
        ) : null}
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
    </button>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}
