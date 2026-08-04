import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useCanWrite, useIsAdmin, useProjects, useStatusReport } from "../lib/queries";
import { useViewStore } from "../lib/viewState";
import { applyFilters } from "../lib/filtering";
import { cn } from "../lib/cn";
import { Collapsible } from "../components/Collapsible";
import { FilterBar } from "../components/FilterBar";
import { StatusPill } from "../components/StatusPill";
import type { StatusReportRow } from "../lib/types";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { StatusUpdateModal } from "../components/StatusUpdateModal";

const UNASSIGNED_LANE_KEY = "__unassigned__";

type CompletionFilter = "all" | "needs_update" | "submitted";

function needsStatusSubmission(row: StatusReportRow): boolean {
  return !row.completed;
}

type OwnerPendingGroup = {
  key: string;
  ownerName: string;
  ownerEmail: string | null;
  projects: StatusReportRow[];
};

export function StatusReportView() {
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  const report = useStatusReport(weekOf);
  const projects = useProjects();
  const filters = useViewStore((s) => s.board.filters);
  const isAdmin = useIsAdmin();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusModalId, setStatusModalId] = useState<string | null>(null);
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter | null>(null);
  const canWrite = useCanWrite();

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

  const isPastWeek = !!(weekOf && report.data?.week_of && weekOf !== report.data.week_of);
  const activeCompletionFilter: CompletionFilter =
    completionFilter ?? (isAdmin && !isPastWeek ? "needs_update" : "all");

  const stats = useMemo(() => {
    const submitted = rows.filter((r) => r.completed).length;
    const needsUpdate = rows.filter(needsStatusSubmission).length;
    return { total: rows.length, submitted, needsUpdate };
  }, [rows]);

  const displayRows = useMemo(() => {
    if (activeCompletionFilter === "all") return rows;
    if (activeCompletionFilter === "submitted") return rows.filter((r) => r.completed);
    return rows.filter(needsStatusSubmission);
  }, [rows, activeCompletionFilter]);

  const ownerPendingGroups = useMemo((): OwnerPendingGroup[] => {
    if (!isAdmin || isPastWeek) return [];
    const incomplete = rows.filter(needsStatusSubmission);
    const byOwner = new Map<string, OwnerPendingGroup>();
    for (const r of incomplete) {
      const key = r.owner_id ?? `__unassigned__:${r.owner_name ?? "none"}`;
      const existing = byOwner.get(key);
      if (existing) {
        existing.projects.push(r);
      } else {
        byOwner.set(key, {
          key,
          ownerName: r.owner_name ?? "Unassigned",
          ownerEmail: r.owner_email,
          projects: [r],
        });
      }
    }
    return Array.from(byOwner.values()).sort((a, b) => {
      if (a.key.startsWith("__unassigned__")) return 1;
      if (b.key.startsWith("__unassigned__")) return -1;
      return a.ownerName.localeCompare(b.ownerName);
    });
  }, [rows, isAdmin, isPastWeek]);

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

  const rowsAreEditable = canWrite && !isPastWeek;
  const dueAt = report.data?.due_at ? new Date(report.data.due_at) : null;
  const overdue = dueAt ? dueAt < new Date() && stats.needsUpdate > 0 : false;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="board" />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-wp-stone bg-white/60 px-4 py-2">
        <div className="text-sm">
          <span className="font-semibold text-wp-ink">Weekly Status Report</span>
          <span className="ml-2 text-xs text-wp-slate">
            Week of {report.data?.week_of ?? "…"}
            {stats.total > 0 ? (
              <>
                · {stats.submitted} submitted
                · {stats.needsUpdate} need update
              </>
            ) : (
              <> · {rows.length} eligible project(s)</>
            )}
          </span>
          {dueAt && !isPastWeek ? (
            <span className="ml-2 text-xs text-wp-slate">
              (due {format(dueAt, "EEE MMM d, h:mm a")})
            </span>
          ) : null}
          {isPastWeek ? (
            <span className="ml-2 chip !border-slate-300 !text-slate-600">read-only (past week)</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded border border-wp-stone p-0.5 text-xs">
            <span className="px-2 text-wp-slate">Show</span>
            {(
              [
                { id: "needs_update" as const, label: "Needs update" },
                { id: "submitted" as const, label: "Submitted" },
                { id: "all" as const, label: "All" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={cn(
                  "rounded px-2 py-1 font-medium transition",
                  activeCompletionFilter === opt.id
                    ? "bg-wp-red text-white"
                    : "text-wp-slate hover:bg-wp-stone/40",
                )}
                onClick={() => setCompletionFilter(opt.id)}
              >
                {opt.label}
                {opt.id === "needs_update" && stats.needsUpdate > 0 ? ` (${stats.needsUpdate})` : ""}
                {opt.id === "submitted" && stats.submitted > 0 ? ` (${stats.submitted})` : ""}
              </button>
            ))}
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
      </div>

      {isAdmin && !isPastWeek && stats.needsUpdate > 0 ? (
        <div
          className={cn(
            "border-b px-4 py-3 text-sm",
            overdue ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900",
          )}
        >
          <div className="flex items-start gap-2">
            {overdue ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : null}
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {overdue ? "Status updates overdue" : "Still waiting on status updates"}
                — {stats.needsUpdate} project{stats.needsUpdate === 1 ? "" : "s"} not submitted
              </p>
              <p className="mt-1 text-xs opacity-80">
                Drafts count as incomplete until the owner clicks Submit. Unassigned projects have no owner to notify.
              </p>
              {ownerPendingGroups.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {ownerPendingGroups.map((g) => (
                    <li key={g.key} className="rounded-md border border-current/20 bg-white/60 px-3 py-2">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-semibold text-wp-ink">{g.ownerName}</span>
                        {g.ownerEmail ? (
                          <a
                            href={`mailto:${g.ownerEmail}?subject=${encodeURIComponent(
                              `Waypoint status update — week of ${report.data?.week_of ?? ""}`,
                            )}`}
                            className="text-xs underline underline-offset-2"
                          >
                            {g.ownerEmail}
                          </a>
                        ) : (
                          <span className="text-xs opacity-70">no owner email</span>
                        )}
                        <span className="text-xs opacity-70">
                          · {g.projects.length} project{g.projects.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {g.projects.map((p) => (
                          <li key={p.project_id}>
                            <button
                              type="button"
                              className="rounded-full border border-current/30 bg-white/80 px-2 py-0.5 text-xs font-medium hover:underline"
                              onClick={() => setSelectedId(p.project_id)}
                            >
                              {p.project_title}
                              {p.health_flag !== "white" && !p.completed ? (
                                <span className="ml-1 opacity-70">(draft)</span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

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
              displayRows.forEach((r, idx) => {
                const laneKey = r.swim_lane_id ?? UNASSIGNED_LANE_KEY;
                if (laneKey !== currentLaneKey) {
                  currentLaneKey = laneKey;
                  let count = 0;
                  for (let j = idx; j < displayRows.length; j++) {
                    const k = displayRows[j]!.swim_lane_id ?? UNASSIGNED_LANE_KEY;
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
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            setExpanded(next);
                          }}
                          aria-label={isOpen ? "Collapse" : "Expand"}
                          aria-expanded={isOpen}
                          className="btn-ghost !p-0.5"
                        >
                          <ChevronRight
                            size={14}
                            className={cn(
                              "transition-transform duration-200 ease-out motion-reduce:transition-none",
                              isOpen && "rotate-90",
                            )}
                          />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill flag={r.health_flag ?? "white"} completed={!!r.completed} size="md" />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          className="text-left text-wp-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(r.project_id);
                          }}
                        >
                          {r.project_title}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-wp-slate">
                        <div>{r.owner_name ?? "—"}</div>
                        {isAdmin && r.owner_email ? (
                          <a
                            href={`mailto:${r.owner_email}`}
                            className="text-[11px] text-wp-slate/80 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.owner_email}
                          </a>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-wp-slate">
                        {r.team_names?.length ? r.team_names.join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-wp-slate">{r.swim_lane_name ?? "—"}</td>
                      <td className="px-3 py-2 text-wp-slate">
                        {r.executive_summary || <span className="italic text-wp-slate/60">no update</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-wp-slate">
                        {r.submitted_at ? format(new Date(r.submitted_at), "MMM d, h:mm a") : "—"}
                      </td>
                    </tr>
                    <tr className={isOpen ? "border-b border-wp-stone bg-wp-bg" : ""}>
                      <td colSpan={8} className="p-0">
                        <Collapsible open={isOpen}>
                          <div className="px-8 py-3">
                            {r.detailed_update && r.detailed_update.length ? (
                              <ul className="ml-4 list-disc space-y-1 text-sm text-wp-slate">
                                {r.detailed_update.map((b, i) => <li key={i}>{b}</li>)}
                              </ul>
                            ) : (
                              <span className="text-sm italic text-wp-slate/60">
                                No detailed bullets submitted for this week.
                              </span>
                            )}
                          </div>
                        </Collapsible>
                      </td>
                    </tr>
                  </React.Fragment>,
                );
              });
              return out;
            })()}
            {displayRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-sm text-wp-slate">
                  {rows.length === 0
                    ? "No eligible projects for this week."
                    : activeCompletionFilter === "needs_update"
                      ? "Everyone has submitted — nothing left to chase."
                      : activeCompletionFilter === "submitted"
                        ? "No submitted updates match the current filters."
                        : "No projects match the current filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedId ? (
        <ProjectDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenProject={setSelectedId}
          siblingIds={displayRows.map((r) => r.project_id)}
        />
      ) : null}
      {statusModalId ? (
        <StatusUpdateModal projectId={statusModalId} onClose={() => setStatusModalId(null)} />
      ) : null}
    </div>
  );
}
