import { useMemo, useState } from "react";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Search,
  Star,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "../lib/cn";
import { pillTextColor, tint } from "../lib/colors";
import {
  useProjects,
  useSwimLanes,
  useUsers,
  type PrioritizationRow,
} from "../lib/queries";
import { MultiSelect } from "./MultiSelect";

/**
 * Prefix applied to every draggable id inside the finder panel
 * (Column B). The parent DndContext splits column-B drags from
 * column-A drags by this prefix so the same underlying project id
 * can appear as a sortable in both columns without dnd-kit
 * complaining about duplicate ids — and so the drop-decision
 * matrix in `PrioritizationView.handleDragEnd` can tell where the
 * drag originated.
 *
 * Exported so the parent view can decode `active.id` at drop time.
 * Keep in lock-step with anywhere else that peels the prefix off.
 */
export const FINDER_PREFIX = "finder:";

export type FinderSortKey =
  | "rank"
  | "title"
  | "start"
  | "end"
  | "team";

const SORT_LABELS: Record<FinderSortKey, string> = {
  rank: "Rank",
  title: "Title (A→Z)",
  start: "Start date (earliest)",
  end: "End date (earliest)",
  team: "Team (A→Z)",
};

/**
 * Column B of the Prioritization view — a compact "finder" panel
 * that lets the user search, filter, and re-sort the same set of
 * eligible items shown in Column A so they can drag a specific
 * item into an exact position on the left. Column B does NOT
 * filter Column A; A always shows the full ordered list. Rows
 * here are draggable and their onDragEnd is handled by the parent
 * — dropping onto A splices the item to that new global rank.
 * Dropping within B, or dropping A → B, is a no-op (the parent
 * enforces this).
 */
export function PrioritizationFinderPanel({
  rows,
  teamsById,
  canWrite,
  activeDragId,
}: {
  rows: PrioritizationRow[];
  teamsById: Map<string, { color: string; name: string }>;
  canWrite: boolean;
  /** Currently-dragging id (raw project id if from A, `finder:<id>` if from B). Used to dim the source row. */
  activeDragId: string | null;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<FinderSortKey>("rank");
  const [teamFilter, setTeamFilter] = useState<string[]>([]);
  const [laneFilter, setLaneFilter] = useState<string[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);

  // Per-row expand state for the finder. Local-only (not
  // persisted, not stored in zustand) so a page refresh or tab
  // switch resets — the finder is a scan surface, not an editing
  // surface, and expanded descriptions are cheap to re-open.
  // Multiple rows can be open at once so users can compare
  // descriptions side-by-side before deciding which to drag over.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const projects = useProjects();
  const users = useUsers();
  const lanes = useSwimLanes();

  // Owner id is not part of the trimmed PrioritizationRow shape, so
  // enrich it here from the full projects payload rather than
  // widening the /prioritization endpoint. The two queries are both
  // on the same POLL_MS cadence so drift is bounded.
  const ownerIdByProject = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of projects.data ?? []) m.set(p.id, p.owner_id);
    return m;
  }, [projects.data]);

  const userNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users.data ?? []) m.set(u.id, u.name);
    return m;
  }, [users.data]);

  const laneNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lanes.data ?? []) m.set(l.id, l.name);
    return m;
  }, [lanes.data]);

  // The rank badge always reflects the global order in A. Compute
  // once from the ordered `rows` prop; when A reorders (optimistic
  // update or refetch), this map falls back into sync.
  const rankByProject = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.id, i + 1));
    return m;
  }, [rows]);

  // Only surface filter options that actually exist in the
  // eligible set — no dead options like a team with no eligible
  // rows. Sorted alphabetically to match the FilterBar convention.
  const teamOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      r.team_ids.forEach((id, i) => {
        if (!seen.has(id)) seen.set(id, r.team_names[i] ?? id);
      });
    }
    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const laneOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) if (r.swim_lane_id) seen.add(r.swim_lane_id);
    return Array.from(seen)
      .map((id) => ({ id, label: laneNameById.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, laneNameById]);

  const ownerOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const ownerId = ownerIdByProject.get(r.id) ?? null;
      if (ownerId) seen.add(ownerId);
    }
    return Array.from(seen)
      .map((id) => ({ id, label: userNameById.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, ownerIdByProject, userNameById]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const teamSet = teamFilter.length ? new Set(teamFilter) : null;
    const laneSet = laneFilter.length ? new Set(laneFilter) : null;
    const ownerSet = ownerFilter.length ? new Set(ownerFilter) : null;

    const matches = rows.filter((r) => {
      if (q) {
        // Title match takes precedence; description is a low-priority
        // fallback so a search for "billing" still finds an item
        // titled "Payments" whose description mentions billing.
        const inTitle = r.title.toLowerCase().includes(q);
        const inDesc = !inTitle && r.description.toLowerCase().includes(q);
        if (!inTitle && !inDesc) return false;
      }
      if (teamSet && !r.team_ids.some((id) => teamSet.has(id))) return false;
      if (laneSet && (!r.swim_lane_id || !laneSet.has(r.swim_lane_id))) return false;
      if (ownerSet) {
        const ownerId = ownerIdByProject.get(r.id) ?? null;
        if (!ownerId || !ownerSet.has(ownerId)) return false;
      }
      return true;
    });

    const sorted = matches.slice();
    switch (sortKey) {
      case "rank":
        // `rows` is already in rank order (parent passes localOrder).
        break;
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "start":
        sorted.sort((a, b) => a.start_date.localeCompare(b.start_date));
        break;
      case "end":
        sorted.sort((a, b) =>
          a.optimization_end_date.localeCompare(b.optimization_end_date),
        );
        break;
      case "team":
        sorted.sort((a, b) => {
          const aName = a.team_names[0] ?? "";
          const bName = b.team_names[0] ?? "";
          const cmp = aName.localeCompare(bName);
          if (cmp !== 0) return cmp;
          return a.title.localeCompare(b.title);
        });
        break;
    }
    return sorted;
  }, [rows, search, sortKey, teamFilter, laneFilter, ownerFilter, ownerIdByProject]);

  const total = rows.length;
  const shown = filtered.length;

  const anyFilterActive =
    search.length > 0 ||
    sortKey !== "rank" ||
    teamFilter.length > 0 ||
    laneFilter.length > 0 ||
    ownerFilter.length > 0;

  function resetAll() {
    setSearch("");
    setSortKey("rank");
    setTeamFilter([]);
    setLaneFilter([]);
    setOwnerFilter([]);
  }

  const itemIds = useMemo(() => filtered.map((r) => FINDER_PREFIX + r.id), [filtered]);

  return (
    <aside className="flex min-h-0 flex-col rounded-md border border-wp-stone bg-white">
      <div className="border-b border-wp-stone px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
            Find an item
          </div>
          <div className="text-[11px] text-wp-slate">
            Showing {shown} of {total} item{total === 1 ? "" : "s"}
          </div>
        </div>
        <div className="mt-1 space-y-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-wp-slate"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title / description…"
              className="input pl-7 pr-8"
              aria-label="Search items"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-wp-slate hover:bg-wp-stone/40"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-wp-slate" htmlFor="finder-sort">
              Sort
            </label>
            <select
              id="finder-sort"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as FinderSortKey)}
              className="input !py-1 text-xs"
            >
              {(Object.keys(SORT_LABELS) as FinderSortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <MultiSelect
              label="Team"
              options={teamOptions}
              value={teamFilter}
              onChange={setTeamFilter}
              emptyMessage="No teams on eligible items"
            />
            <MultiSelect
              label="Swim lane"
              options={laneOptions}
              value={laneFilter}
              onChange={setLaneFilter}
              emptyMessage="No lanes on eligible items"
            />
            <MultiSelect
              label="Owner"
              options={ownerOptions}
              value={ownerFilter}
              onChange={setOwnerFilter}
              emptyMessage="No owners on eligible items"
            />
            {anyFilterActive ? (
              <button
                type="button"
                onClick={resetAll}
                className="btn-ghost !py-0.5 text-xs"
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-xs text-wp-slate">
            {total === 0
              ? "No eligible items yet."
              : "No items match the current search / filters."}
          </div>
        ) : (
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-wp-stone/70">
              {filtered.map((row) => (
                <FinderRow
                  key={row.id}
                  row={row}
                  rank={rankByProject.get(row.id) ?? 0}
                  primaryTeam={
                    row.team_ids[0] ? teamsById.get(row.team_ids[0]) ?? null : null
                  }
                  primaryTeamName={row.team_names[0] ?? null}
                  canWrite={canWrite}
                  activeDragId={activeDragId}
                  isExpanded={expanded.has(row.id)}
                  onToggleExpanded={() => toggleExpanded(row.id)}
                />
              ))}
            </ul>
          </SortableContext>
        )}
      </div>
    </aside>
  );
}

function FinderRow(props: {
  row: PrioritizationRow;
  rank: number;
  primaryTeam: { color: string; name: string } | null;
  primaryTeamName: string | null;
  canWrite: boolean;
  activeDragId: string | null;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const {
    row,
    rank,
    primaryTeam,
    primaryTeamName,
    canWrite,
    activeDragId,
    isExpanded,
    onToggleExpanded,
  } = props;
  const sortableId = FINDER_PREFIX + row.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });

  // Dim the finder row while:
  //   (a) it's the drag source in B (isDragging), or
  //   (b) the same underlying project is being dragged from A —
  //       because it's the same item in the same list, showing it
  //       "left behind" in B while it's flying above A is
  //       distracting.
  const dimForA = activeDragId === row.id;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging || dimForA ? 0.4 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  const dateRange = formatFinderDateRange(row.start_date, row.optimization_end_date);
  const chipColor = primaryTeam?.color ?? null;
  const chipBg = chipColor ? tint(chipColor, 0.16) : null;
  // `pillTextColor(chipColor)` — not `readableOn(chipColor)` — is what
  // clears WCAG AA on the pale-tint bg. The older call passed the raw
  // team color and got back near-white text for any dark-saturated hue
  // (magenta / purple / blue), which then vanished on the pale tint.
  const chipFg = chipColor ? pillTextColor(chipColor) : null;
  const chipBorder = chipColor ? tint(chipColor, 0.4) : null;

  return (
    <li ref={setNodeRef} style={style} className="bg-white">
      {/*
        Row header. Click / Enter / Space anywhere in this region
        toggles the description preview (same UX as Column A).
        The drag handle below stops event propagation so grabbing
        the grip doesn't also flip the expanded state, and dnd-kit's
        4px pointer-activation on the parent DndContext means a
        stray click on the grip won't fire a drag. Because
        `useSortable`'s `listeners` are attached to the grip button
        only (not this container), clicking the title / caret /
        empty space never initiates a drag.
      */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.title}`}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-wp-stone/30"
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${row.title} onto the ranked list`}
          title={canWrite ? "Drag onto the ranked list" : "Read-only — viewers cannot rerank"}
          disabled={!canWrite}
          // Stop propagation so grabbing the handle (or a stray
          // click on it) doesn't also toggle the row expand.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "shrink-0 rounded p-1 text-wp-slate",
            canWrite
              ? "cursor-grab touch-none hover:bg-wp-stone/50 active:cursor-grabbing"
              : "cursor-not-allowed opacity-40",
          )}
        >
          <GripVertical size={14} />
        </button>
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-wp-stone/60 text-[10px] font-semibold text-wp-slate"
          title={`Global rank ${rank}`}
        >
          {rank}
        </span>
        {primaryTeamName ? (
          <span
            className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            style={
              chipColor
                ? {
                    backgroundColor: chipBg ?? undefined,
                    color: chipFg ?? undefined,
                    borderColor: chipBorder ?? undefined,
                  }
                : undefined
            }
            title={primaryTeamName}
          >
            {primaryTeamName}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-xs font-medium text-wp-ink" title={row.title}>
            {/* Read-only star cue for key strategic items — the
                toggle lives in Column A and the detail modal; here
                it's purely informational so the finder stays a
                finder, not another editing surface. Rendered for
                every row (filled / red when set, outline / muted
                slate when not) so the strategic vs. non-strategic
                state is visible at a glance without hovering. */}
            <Star
              size={11}
              className={
                row.is_key_strategic
                  ? "shrink-0 fill-wp-red text-wp-red"
                  : "shrink-0 text-wp-slate/40"
              }
              aria-label={
                row.is_key_strategic ? "Key strategic item" : "Not key strategic"
              }
            />
            <span className="truncate">{row.title}</span>
          </div>
          <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-wp-slate">
            <Calendar size={10} />
            {dateRange}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center text-wp-slate" aria-hidden>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>
      {isExpanded ? (
        <div className="border-t border-wp-stone/60 bg-wp-stone/10 px-2 py-2">
          {row.description?.trim() ? (
            <div className="whitespace-pre-wrap text-sm text-wp-slate">
              {row.description}
            </div>
          ) : (
            <div className="text-sm italic text-wp-slate/70">No description.</div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function formatFinderDateRange(startIso: string, endIso: string): string {
  const start = safeDate(startIso);
  const end = safeDate(endIso);
  if (!start || !end) return `${startIso} → ${endIso}`;
  return `${format(start, "MMM d")} → ${format(end, "MMM d")}`;
}

function safeDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
