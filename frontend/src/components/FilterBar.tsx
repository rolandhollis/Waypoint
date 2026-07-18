import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { countActiveFilters } from "../lib/filtering";
import { emptyFilters, useViewStore, type ColorBy, type GroupBy, type ViewKey } from "../lib/viewState";
import { cn } from "../lib/cn";

export function FilterBar({
  view,
  showGrouping = false,
  showColorBy = false,
  showSwimLaneFilter = true,
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

type MultiOption = { id: string; label: string };

/**
 * Multi-select popover with an internal scroll list.
 *
 * The popover is rendered via a portal into <body> with `position:
 * fixed`, anchored to the trigger's bounding rect. This is
 * deliberate: an earlier `<details>` + `absolute` implementation was
 * clipped on the Roadmap tab because the RoadmapView root uses
 * `overflow-hidden` (needed for the horizontal Gantt scroller), and
 * an absolutely-positioned descendant whose containing block sits
 * inside an overflow-hidden ancestor gets clipped at that
 * ancestor's border box — so the popover's internal scroll gutter
 * lost its bottom rows.
 *
 * Portalling to <body> and using `position: fixed` puts the popover
 * outside every ancestor's overflow/stacking context, so it never
 * gets clipped or painted-under regardless of which view hosts the
 * FilterBar.
 */
function MultiSelect({ label, options, value, onChange }: { label: string; options: MultiOption[]; value: string[]; onChange: (v: string[]) => void }) {
  const selected = new Set(value);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Recompute the popover's fixed-position coordinates whenever it
  // opens, on scroll, and on resize. Kept in a layout effect so the
  // first paint after `open` flips already has the correct top/left
  // — otherwise there's a one-frame flash at (0,0).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const GAP = 4;
      const VIEWPORT_MARGIN = 8;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      // Cap by both a UX ceiling (256px) and the actual space below
      // the trigger — the popover always fits and always scrolls
      // internally when there's more content than room.
      const maxHeight = Math.max(160, Math.min(256, spaceBelow));
      setPos({ top: rect.bottom + GAP, left: rect.left, maxHeight });
    }
    place();
    window.addEventListener("resize", place);
    // `true` so we catch scrolls in ANY scroll container between the
    // trigger and the viewport (the RoadmapView root, main, etc.),
    // not just the window itself.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside pointerdown / Escape, matching the rest of the
  // app's popover semantics. Outside = not the trigger AND not the
  // popover surface (in the portal).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const popover = open && pos ? createPortal(
    <div
      ref={popoverRef}
      // z-40 keeps it above the app's usual chrome (banners,
      // sticky headers) but below modal dialogs (z-50+), matching
      // how the rest of the app layers popovers.
      className="fixed z-40 w-56 overflow-y-auto rounded-md border border-wp-stone bg-white p-1 shadow-md"
      style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
    >
      {options.length === 0 ? (
        <div className="px-2 py-1 text-xs text-wp-slate">None available</div>
      ) : null}
      {options.map((o) => (
        <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-wp-stone/40">
          <input
            type="checkbox"
            checked={selected.has(o.id)}
            onChange={() => {
              const next = new Set(selected);
              if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
              onChange(Array.from(next));
            }}
          />
          <span className="truncate text-wp-ink">{o.label}</span>
        </label>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "cursor-pointer select-none rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-xs text-wp-slate",
          value.length ? "text-wp-ink" : "",
        )}
      >
        {label}{value.length ? ` · ${value.length}` : ""}
      </button>
      {popover}
    </>
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
  return chips;
}
