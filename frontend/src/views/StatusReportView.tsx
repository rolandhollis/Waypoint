import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMe, useProjects, useStatusReport } from "../lib/queries";
import { useViewStore } from "../lib/viewState";
import { applyFilters } from "../lib/filtering";
import { FilterBar } from "../components/FilterBar";
import { StatusPill } from "../components/StatusPill";
import type { StatusReportRow } from "../lib/types";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { StatusUpdateModal } from "../components/StatusUpdateModal";

const UNASSIGNED_LANE_KEY = "__unassigned__";

export function StatusReportView() {
  const me = useMe();
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  const report = useStatusReport(weekOf);
  const projects = useProjects();
  const filters = useViewStore((s) => s.board.filters); // reuse the board's filter set for continuity
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusModalId, setStatusModalId] = useState<string | null>(null);
  const canWrite = me.data?.role !== "viewer";

  const filteredIds = useMemo(() => {
    if (!projects.data) return null;
    const set = new Set(applyFilters(projects.data, filters).map((p) => p.id));
    return set;
  }, [projects.data, filters]);

  const rows = useMemo(() => {
    if (!report.data) return [] as StatusReportRow[];
    if (!filteredIds) return report.data.rows;
    return report.data.rows.filter((r) => filteredIds.has(r.project_id));
  }, [report.data, filteredIds]);

  // Collect week options: current week (from server) + last 8 weeks Monday-anchored.
  const weekOptions = useMemo(() => {
    const list: string[] = [];
    const current = report.data?.week_of;
    if (current) list.push(current);
    if (current) {
      const anchor = new Date(`${current}T00:00:00`);
      for (let i = 1; i <= 8; i++) {
        const d = new Date(anchor);
        d.setDate(d.getDate() - 7 * i);
        list.push(d.toISOString().slice(0, 10));
      }
    }
    return list;
  }, [report.data?.week_of]);

  const isPastWeek = !!(weekOf && report.data?.week_of && weekOf !== report.data.week_of);
  const rowsAreEditable = canWrite && !isPastWeek;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="board" />

      <div className="flex items-center justify-between border-b border-wp-stone bg-white/60 px-4 py-2">
        <div className="text-sm">
          <span className="font-semibold text-wp-ink">Weekly Status Report</span>
          <span className="ml-2 text-xs text-wp-slate">
            Week of {report.data?.week_of ?? "…"} · {rows.length} eligible project(s)
          </span>
          {isPastWeek ? <span className="ml-2 chip !border-slate-300 !text-slate-600">read-only (past week)</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-wp-slate">Week</label>
          <select
            className="input w-40"
            value={weekOf ?? report.data?.week_of ?? ""}
            onChange={(e) => setWeekOf(e.target.value || undefined)}
          >
            {weekOptions.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-wp-stone/50 text-xs uppercase tracking-wide text-wp-slate">
            <tr>
              <th className="w-8"></th>
              <th className="w-24 px-3 py-2 text-left">Health</th>
              <th className="px-3 py-2 text-left">Project</th>
              <th className="w-40 px-3 py-2 text-left">Owner</th>
              <th className="w-40 px-3 py-2 text-left">Teams</th>
              <th className="w-32 px-3 py-2 text-left">Lane</th>
              <th className="px-3 py-2 text-left">Executive summary</th>
              <th className="w-40 px-3 py-2 text-left">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const out: React.ReactNode[] = [];
              let currentLaneKey: string | null = null;
              rows.forEach((r, idx) => {
                const laneKey = r.swim_lane_id ?? UNASSIGNED_LANE_KEY;
                if (laneKey !== currentLaneKey) {
                  currentLaneKey = laneKey;
                  // Count how many consecutive rows belong to this lane so
                  // the header can show a live count for the group.
                  let count = 0;
                  for (let j = idx; j < rows.length; j++) {
                    const k = rows[j]!.swim_lane_id ?? UNASSIGNED_LANE_KEY;
                    if (k !== laneKey) break;
                    count++;
                  }
                  out.push(
                    <tr key={`lane-${laneKey}`} className="bg-wp-stone/40">
                      <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-wp-slate">
                        {r.swim_lane_name ?? "Unassigned"}
                        <span className="ml-2 font-normal normal-case tracking-normal text-wp-slate/70">
                          {count} project{count === 1 ? "" : "s"}
                        </span>
                      </td>
                    </tr>,
                  );
                }
                const key = r.id ?? r.project_id;
                const isOpen = expanded.has(key);
                const rowClickTitle = rowsAreEditable
                  ? "Click to enter/edit this week's status"
                  : isPastWeek
                    ? "Read-only (past week)"
                    : "Viewer access is read-only";
                out.push(
                  <React.Fragment key={key}>
                    <tr
                      onClick={() => rowsAreEditable && setStatusModalId(r.project_id)}
                      className={`border-b border-wp-stone hover:bg-wp-bg ${rowsAreEditable ? "cursor-pointer" : ""}`}
                      title={rowClickTitle}
                    >
                      <td className="px-2 py-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const next = new Set(expanded);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            setExpanded(next);
                          }}
                          aria-label={isOpen ? "Collapse" : "Expand"}
                          className="btn-ghost !p-0.5"
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-2"><StatusPill flag={r.health_flag ?? "white"} completed={!!r.completed} size="md" /></td>
                      <td className="px-3 py-2">
                        <button
                          className="text-left text-wp-ink hover:underline"
                          onClick={(e) => { e.stopPropagation(); setSelectedId(r.project_id); }}
                        >
                          {r.project_title}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-wp-slate">{r.owner_name ?? "—"}</td>
                      <td className="px-3 py-2 text-wp-slate">{r.team_names?.length ? r.team_names.join(", ") : "—"}</td>
                      <td className="px-3 py-2 text-wp-slate">{r.swim_lane_name ?? "—"}</td>
                      <td className="px-3 py-2 text-wp-slate">{r.executive_summary || <span className="italic text-wp-slate/60">no update</span>}</td>
                      <td className="px-3 py-2 text-xs text-wp-slate">
                        {r.submitted_at ? format(new Date(r.submitted_at), "MMM d, h:mm a") : "—"}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-wp-stone bg-wp-bg">
                        <td colSpan={8} className="px-8 py-3">
                          {r.detailed_update && r.detailed_update.length ? (
                            <ul className="ml-4 list-disc space-y-1 text-sm text-wp-slate">
                              {r.detailed_update.map((b, i) => <li key={i}>{b}</li>)}
                            </ul>
                          ) : (
                            <span className="text-sm italic text-wp-slate/60">No detailed bullets submitted for this week.</span>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>,
                );
              });
              return out;
            })()}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-sm text-wp-slate">
                  No eligible projects for this week.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedId ? <ProjectDetailPanel id={selectedId} onClose={() => setSelectedId(null)} onOpenProject={setSelectedId} /> : null}
      {statusModalId ? <StatusUpdateModal projectId={statusModalId} onClose={() => setStatusModalId(null)} /> : null}
    </div>
  );
}
