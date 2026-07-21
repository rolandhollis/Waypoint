import { useEffect, useMemo } from "react";
import { Star, X } from "lucide-react";
import { cn } from "../lib/cn";
import { useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { countActiveFilters } from "../lib/filtering";
import { emptyFilters, useViewStore, type ColorBy, type GroupBy, type ViewKey } from "../lib/viewState";
import { MultiSelect } from "./MultiSelect";

export function FilterBar({
  view,
  showGrouping = false,
  showColorBy = false,
  showSwimLaneFilter = true,
  showKeyStrategicToggle = false,
}: {
  view: ViewKey;
  showGrouping?: boolean;
  /**
   * Color-by only makes sense on views that actually paint bars/legends
   * from it (currently just the Roadmap). Hidden by default so the
   * Board and Status Report don't show a control that has no visible
   * effect there.
   */
  showColorBy?: boolean;
  /**
   * Filter-by-swim-lane is redundant on views that already lay items
   * out by lane (e.g. the Board's columns *are* the lanes). Hidden on
   * those; any previously-persisted lane filter for that view is also
   * cleared so it can't apply invisibly.
   */
  showSwimLaneFilter?: boolean;
  /**
   * When true, render the "Key strategic only" star toggle chip
   * (migration 038). Only the Roadmap surface uses it today —
   * hiding on Board / EZEstimates keeps the flag purely a Roadmap
   * lens. Any previously-persisted keyStrategicOnly filter is also
   * cleared on views that hide the control so it can't apply
   * invisibly.
   */
  showKeyStrategicToggle?: boolean;
}) {
  const filters = useViewStore((s) => s[view].filters);
  const colorBy = useViewStore((s) => s[view].colorBy);
  const groupBy = useViewStore((s) => s[view].groupBy);
  const setFilters = useViewStore((s) => s.setFilters);
  const setColorBy = useViewStore((s) => s.setColorBy);
  const setGroupBy = useViewStore((s) => s.setGroupBy);
  const clear = useViewStore((s) => s.clear);

  // If the swim-lane filter is hidden for this view but a previous
  // session persisted lane ids into zustand, they'd silently filter
  // items with no visible control to undo it. Clear once on mount.
  useEffect(() => {
    if (!showSwimLaneFilter && filters.swimLaneIds.length) {
      setFilters(view, { ...filters, swimLaneIds: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSwimLaneFilter, view]);

  // Same defensive clear for the Key-strategic-only chip: if the
  // caller hid the control on this view, wipe any stale persisted
  // pick so a returning user isn't left with an invisible filter.
  useEffect(() => {
    if (!showKeyStrategicToggle && filters.keyStrategicOnly) {
      setFilters(view, { ...filters, keyStrategicOnly: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showKeyStrategicToggle, view]);

  const users = useUsers();
  const teams = useTeams();
  const lanes = useSwimLanes();
  const projects = useProjects();

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects.data ?? []) for (const t of p.tags) set.add(t);
    return Array.from(set).sort();
  }, [projects.data]);

  const activeCount = countActiveFilters(filters);

  return (
    <div className="border-b border-wp-stone bg-white/60">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <input
          className="input w-56"
          type="search"
          placeholder="Search title / description…"
          value={filters.search}
          onChange={(e) => setFilters(view, { ...filters, search: e.target.value })}
        />
        <MultiSelect
          label="Owner"
          options={(users.data ?? []).map((u) => ({ id: u.id, label: u.name }))}
          value={filters.ownerIds}
          onChange={(v) => setFilters(view, { ...filters, ownerIds: v })}
        />
        <MultiSelect
          label="Team"
          options={(teams.data ?? []).map((t) => ({ id: t.id, label: t.name }))}
          value={filters.teamIds}
          onChange={(v) => setFilters(view, { ...filters, teamIds: v })}
        />
        {showSwimLaneFilter ? (
          <MultiSelect
            label="Swim Lane"
            options={(lanes.data ?? []).map((l) => ({ id: l.id, label: l.name }))}
            value={filters.swimLaneIds}
            onChange={(v) => setFilters(view, { ...filters, swimLaneIds: v })}
          />
        ) : null}
        <MultiSelect
          label="Tag"
          options={allTags.map((t) => ({ id: t, label: `#${t}` }))}
          value={filters.tags}
          onChange={(v) => setFilters(view, { ...filters, tags: v })}
        />
        {showKeyStrategicToggle ? (
          <button
            type="button"
            aria-pressed={filters.keyStrategicOnly}
            onClick={() =>
              setFilters(view, {
                ...filters,
                keyStrategicOnly: !filters.keyStrategicOnly,
              })
            }
            title={
              filters.keyStrategicOnly
                ? "Showing only key strategic items \u2014 click to include everything"
                : "Show only key strategic items"
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
              filters.keyStrategicOnly
                ? "border-wp-red/60 bg-wp-red/5 text-wp-red hover:bg-wp-red/10"
                : "border-wp-stone bg-white text-wp-slate hover:bg-wp-stone/40",
            )}
          >
            <Star
              size={12}
              className={filters.keyStrategicOnly ? "fill-wp-red" : ""}
            />
            Key strategic only
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {showColorBy ? (
            <>
              <label className="text-xs text-wp-slate">Color by</label>
              <select
                className="input w-40"
                value={colorBy}
                onChange={(e) => setColorBy(view, e.target.value as ColorBy)}
              >
                <option value="swim_lane">Swim Lane</option>
                <option value="team">Team</option>
                <option value="owner">Owner</option>
              </select>
            </>
          ) : null}
          {showGrouping ? (
            <>
              <label className="text-xs text-wp-slate">Group by</label>
              <select
                className="input w-40"
                value={groupBy}
                onChange={(e) => setGroupBy(view, e.target.value as GroupBy)}
              >
                <option value="none">None</option>
                <option value="owner">Owner</option>
                <option value="swim_lane">Swim Lane</option>
                <option value="team">Team</option>
                <option value="tag">Tag</option>
                <option value="kpi">KPI</option>
              </select>
            </>
          ) : null}
        </div>
      </div>
      {activeCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
          {renderChips(filters, users.data ?? [], teams.data ?? [], lanes.data ?? [], (patch) => setFilters(view, { ...filters, ...patch }))}
          <button
            className="btn-ghost !py-0.5 text-xs"
            onClick={() => setFilters(view, emptyFilters)}
          >
            Clear all
          </button>
          <span className="ml-auto">
            <button className="btn-ghost !py-0.5 text-xs" onClick={() => clear(view)}>Reset view</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function renderChips(
  filters: ReturnType<typeof useViewStore.getState>["board"]["filters"],
  users: { id: string; name: string }[],
  teams: { id: string; name: string }[],
  lanes: { id: string; name: string }[],
  patch: (p: Partial<typeof filters>) => void,
) {
  const chips: React.ReactNode[] = [];
  const chip = (key: string, label: string, onRemove: () => void) => (
    <span key={key} className="chip !border-wp-red/40 !text-wp-red">
      {label}
      <button className="ml-0.5" onClick={onRemove} aria-label={`Remove ${label}`}>
        <X size={10} />
      </button>
    </span>
  );

  for (const id of filters.ownerIds) {
    const u = users.find((x) => x.id === id);
    chips.push(chip(`o-${id}`, `Owner: ${u?.name ?? id}`, () => patch({ ownerIds: filters.ownerIds.filter((x) => x !== id) })));
  }
  for (const id of filters.teamIds) {
    const t = teams.find((x) => x.id === id);
    chips.push(chip(`t-${id}`, `Team: ${t?.name ?? id}`, () => patch({ teamIds: filters.teamIds.filter((x) => x !== id) })));
  }
  for (const id of filters.swimLaneIds) {
    const l = lanes.find((x) => x.id === id);
    chips.push(chip(`l-${id}`, `Lane: ${l?.name ?? id}`, () => patch({ swimLaneIds: filters.swimLaneIds.filter((x) => x !== id) })));
  }
  for (const t of filters.tags) chips.push(chip(`tg-${t}`, `#${t}`, () => patch({ tags: filters.tags.filter((x) => x !== t) })));
  if (filters.keyStrategicOnly) {
    chips.push(chip("ks", "Key strategic only", () => patch({ keyStrategicOnly: false })));
  }
  return chips;
}
