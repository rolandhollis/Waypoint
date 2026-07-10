import { useMemo, useState } from "react";
import { Download, ListChecks, Search } from "lucide-react";
import { useKpis, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { defaultExportFilename, downloadCsv, projectsToCsv } from "../lib/csvExport";
import type { Project } from "../lib/types";

/**
 * Admin-only CSV export. Two-phase UX matching the importer:
 *
 *  1. Idle — a single button (`Load items to export`) so the tab
 *     lands quietly instead of dumping the full workspace inventory.
 *  2. Review — every project rendered as a checkable card; typing
 *     in the search box filters by title/description. The `Export N
 *     items` button generates a CSV of only the currently-checked
 *     rows and triggers a browser download.
 *
 * All processing is client-side; no round-trip to the backend. The
 * column set is a superset of the importer's, so an export can be
 * re-imported without edits — useful for "export → tweak in Excel
 * → re-import" bulk edits.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "reviewing"; checked: Set<string> };

export function CsvExportAdmin() {
  const projects = useProjects();
  const users = useUsers();
  const teams = useTeams();
  const kpis = useKpis();
  const lanes = useSwimLanes();

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [search, setSearch] = useState("");

  const allItems = useMemo(() => {
    // Sort by lane order → position → created_at so the export list
    // matches the visual reading order on the Board.
    const laneOrder = new Map((lanes.data ?? []).map((l) => [l.id, l.order]));
    return (projects.data ?? []).slice().sort((a, b) => {
      const la = a.swim_lane_id ? laneOrder.get(a.swim_lane_id) ?? 999 : 999;
      const lb = b.swim_lane_id ? laneOrder.get(b.swim_lane_id) ?? 999 : 999;
      if (la !== lb) return la - lb;
      if (a.position !== b.position) return a.position - b.position;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    });
  }, [projects.data, lanes.data]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [allItems, search]);

  const laneNameById = useMemo(
    () => new Map((lanes.data ?? []).map((l) => [l.id, l.name])),
    [lanes.data],
  );

  function beginReview() {
    // Default to every currently-loaded item checked, matching the
    // importer's "checked by default" convention.
    const checked = new Set<string>(allItems.map((p) => p.id));
    setPhase({ kind: "reviewing", checked });
    setSearch("");
  }

  function toggleRow(id: string) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set(prev.checked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, checked: next };
    });
  }

  function setAll(scope: "all" | "filtered", checked: boolean) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set(prev.checked);
      const targetIds = (scope === "all" ? allItems : filteredItems).map((p) => p.id);
      for (const id of targetIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return { ...prev, checked: next };
    });
  }

  function exportCsv() {
    if (phase.kind !== "reviewing") return;
    const selected = allItems.filter((p) => phase.checked.has(p.id));
    if (selected.length === 0) return;
    const csv = projectsToCsv(selected, {
      users: users.data ?? [],
      teams: teams.data ?? [],
      kpis: kpis.data ?? [],
      lanes: lanes.data ?? [],
    });
    downloadCsv(defaultExportFilename(), csv);
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Export CSV</h2>
      <p className="mt-1 text-xs text-wp-slate">
        Download a CSV snapshot of the current workspace. Columns are a superset of the
        importer's, so exports round-trip back through Import CSV without edits.
      </p>

      {phase.kind === "idle" ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            onClick={beginReview}
            disabled={projects.isLoading || allItems.length === 0}
          >
            <ListChecks size={14} />
            Load items to export
          </button>
          <div className="text-xs text-wp-slate">
            {projects.isLoading
              ? "Loading projects…"
              : `${allItems.length} item${allItems.length === 1 ? "" : "s"} available.`}
          </div>
        </div>
      ) : null}

      {phase.kind === "reviewing" ? (
        <ReviewList
          checked={phase.checked}
          allItems={allItems}
          filteredItems={filteredItems}
          laneNameById={laneNameById}
          search={search}
          onSearch={setSearch}
          onToggle={toggleRow}
          onSetAll={setAll}
          onExport={exportCsv}
          onCancel={() => setPhase({ kind: "idle" })}
        />
      ) : null}
    </section>
  );
}

function ReviewList(props: {
  checked: Set<string>;
  allItems: Project[];
  filteredItems: Project[];
  laneNameById: Map<string, string>;
  search: string;
  onSearch: (v: string) => void;
  onToggle: (id: string) => void;
  onSetAll: (scope: "all" | "filtered", checked: boolean) => void;
  onExport: () => void;
  onCancel: () => void;
}) {
  const { checked, allItems, filteredItems, laneNameById, search, onSearch, onToggle, onSetAll, onExport, onCancel } = props;
  const total = allItems.length;
  const filteredCount = filteredItems.length;
  const checkedCount = checked.size;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-wp-slate">
          <span className="font-medium text-wp-ink">{checkedCount}</span> of{" "}
          <span className="font-medium text-wp-ink">{total}</span> selected
          {search ? (
            <> — filter matches <span className="font-medium text-wp-ink">{filteredCount}</span></>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {search ? (
            <>
              <button
                type="button"
                className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
                onClick={() => onSetAll("filtered", true)}
              >
                Select filtered
              </button>
              <span aria-hidden className="text-wp-stone">|</span>
              <button
                type="button"
                className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
                onClick={() => onSetAll("filtered", false)}
              >
                Deselect filtered
              </button>
              <span aria-hidden className="text-wp-stone">|</span>
            </>
          ) : null}
          <button
            type="button"
            className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
            onClick={() => onSetAll("all", true)}
          >
            Select all
          </button>
          <span aria-hidden className="text-wp-stone">|</span>
          <button
            type="button"
            className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
            onClick={() => onSetAll("all", false)}
          >
            Deselect all
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-wp-slate" />
        <input
          type="search"
          className="input pl-7"
          placeholder="Filter by title or description…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <ul className="max-h-[420px] overflow-y-auto divide-y divide-wp-stone rounded-md border border-wp-stone bg-white">
        {filteredItems.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-wp-slate">
            No items match “{search}”.
          </li>
        ) : (
          filteredItems.map((p) => {
            const isChecked = checked.has(p.id);
            const laneName = p.swim_lane_id ? laneNameById.get(p.swim_lane_id) ?? "" : "";
            return (
              <li
                key={p.id}
                className="flex items-start gap-3 px-3 py-2 hover:bg-wp-cloud/40"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-wp-red"
                  checked={isChecked}
                  onChange={() => onToggle(p.id)}
                  aria-label={`Include ${p.title}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-wp-ink truncate">{p.title}</span>
                    {laneName ? (
                      <span className="rounded bg-wp-cloud px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-wp-slate">
                        {laneName}
                      </span>
                    ) : null}
                    {p.type === "subtask" ? (
                      <span className="rounded bg-wp-stone px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-wp-slate">
                        subtask
                      </span>
                    ) : null}
                  </div>
                  {p.description ? (
                    <div className="mt-0.5 text-xs text-wp-slate line-clamp-1">{p.description}</div>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-2"
          onClick={onExport}
          disabled={checkedCount === 0}
        >
          <Download size={14} />
          {`Export ${checkedCount} ${checkedCount === 1 ? "item" : "items"}`}
        </button>
      </div>
    </div>
  );
}
