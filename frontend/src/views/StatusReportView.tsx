import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import {
  useCanWrite,
  useIsAdmin,
  useKpis,
  useMe,
  useProjects,
  useStatusReport,
  useSwimLanes,
  useTeams,
  useUsers,
} from "../lib/queries";
import { useViewStore, type GroupBy } from "../lib/viewState";
import { applyFilters } from "../lib/filtering";
import { cn } from "../lib/cn";
import {
  compareGroupBySortKey,
  compareSwimLaneReportSortKey,
  resolveProjectGroup,
  type ProjectGroupInfo,
} from "../lib/roadmapGrouping";
import { Collapsible } from "../components/Collapsible";
import { SubtaskStatusUpdatesDisplay } from "../components/EpicSubtaskStatusUpdates";
import { FilterBar } from "../components/FilterBar";
import { StatusPill } from "../components/StatusPill";
import type { StatusReportRow } from "../lib/types";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { StatusUpdateModal } from "../components/StatusUpdateModal";
import { ViewPageHeader } from "../components/ViewPageHeader";

type CompletionFilter = "all" | "needs_update" | "submitted";

type ReportGroupSection = {
  info: ProjectGroupInfo;
  rows: StatusReportRow[];
};

const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "swim_lane", label: "Swim lane" },
  { value: "owner", label: "Owner" },
  { value: "team", label: "Team" },
  { value: "tag", label: "Tag" },
  { value: "kpi", label: "KPI" },
  { value: "none", label: "None" },
];

function needsStatusSubmission(row: StatusReportRow): boolean {
  return !row.completed;
}

function hasUnsubmittedDraftContent(row: StatusReportRow): boolean {
  if (row.completed) return false;
  if (row.health_flag && row.health_flag !== "white") return true;
  if (row.executive_summary?.trim()) return true;
  const raw = row.detailed_update;
  if (Array.isArray(raw) && raw.some((b) => {
    if (typeof b === "string") return b.trim().length > 0;
    if (b && typeof b === "object" && "text" in b && typeof (b as { text: string }).text === "string") {
      return (b as { text: string }).text.trim().length > 0;
    }
    return false;
  })) {
    return true;
  }
  return (row.subtask_updates ?? []).length > 0;
}

function sortRowsWithinSection(rows: StatusReportRow[]): StatusReportRow[] {
  return rows.slice().sort((a, b) => {
    if (a.project_position !== b.project_position) return a.project_position - b.project_position;
    return a.project_title.localeCompare(b.project_title);
  });
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
  const users = useUsers();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const kpis = useKpis();
  const filters = useViewStore((s) => s.board.filters);
  const groupBy = useViewStore((s) => s.statusReportGroupBy);
  const setStatusReportGroupBy = useViewStore((s) => s.setStatusReportGroupBy);
  const isAdmin = useIsAdmin();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusModalId, setStatusModalId] = useState<string | null>(null);
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter | null>(null);
  const canWrite = useCanWrite();
  const me = useMe();

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
    const draftsWithContent = rows.filter(hasUnsubmittedDraftContent).length;
    const myDrafts = rows.filter(
      (r) => r.owner_id === me.data?.id && hasUnsubmittedDraftContent(r),
    ).length;
    return { total: rows.length, submitted, needsUpdate, draftsWithContent, myDrafts };
  }, [rows, me.data?.id]);

  const displayRows = useMemo(() => {
    if (activeCompletionFilter === "all") return rows;
    if (activeCompletionFilter === "submitted") return rows.filter((r) => r.completed);
    return rows.filter(needsStatusSubmission);
  }, [rows, activeCompletionFilter]);

  const groupSections = useMemo((): ReportGroupSection[] => {
    const projectById = new Map((projects.data ?? []).map((p) => [p.id, p]));
    const ctx = {
      users: users.data ?? [],
      lanes: lanes.data ?? [],
      teams: teams.data ?? [],
      kpis: kpis.data ?? [],
    };

    if (groupBy === "none") {
      return [{ info: { key: "all", label: "" }, rows: sortRowsWithinSection(displayRows) }];
    }

    const buckets = new Map<string, ReportGroupSection>();
    for (const row of displayRows) {
      const project = projectById.get(row.project_id);
      const info = project
        ? resolveProjectGroup(project, groupBy, ctx)
        : {
            key: row.swim_lane_id ?? "__unassigned",
            label: row.swim_lane_name ?? "Unassigned",
            sortKey: row.swim_lane_order ?? undefined,
          };
      const existing = buckets.get(info.key);
      if (existing) existing.rows.push(row);
      else buckets.set(info.key, { info, rows: [row] });
    }

    return Array.from(buckets.values())
      .map((section) => ({
        ...section,
        rows: sortRowsWithinSection(section.rows),
      }))
      .sort((a, b) =>
        groupBy === "swim_lane"
          ? compareSwimLaneReportSortKey(a.info, b.info)
          : compareGroupBySortKey(a.info, b.info),
      );
  }, [displayRows, groupBy, projects.data, users.data, lanes.data, teams.data, kpis.data]);

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
      <ViewPageHeader tabKey="status_report" />
      <FilterBar view="board" />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-wp-stone bg-white/60 px-4 py-2">
        <div className="text-sm text-wp-slate">
          <span>
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
            <label className="text-xs text-wp-slate">Group by</label>
            <select
              className="input w-36"
              value={groupBy}
              onChange={(e) => setStatusReportGroupBy(e.target.value as GroupBy)}
            >
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
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

      {!isPastWeek && canWrite && stats.myDrafts > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          You have <strong>{stats.myDrafts}</strong> draft
          {stats.myDrafts === 1 ? "" : "s"} saved but not submitted. Click{" "}
          <strong>Submit</strong> on each project so it counts as complete and appears in the
          Friday digest.
        </div>
      ) : null}

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
                Drafts count as incomplete until the owner clicks Submit
                {stats.draftsWithContent > 0
                  ? ` (${stats.draftsWithContent} saved draft${stats.draftsWithContent === 1 ? "" : "s"} won't appear in the Friday digest)`
                  : ""}
                . Unassigned projects have no owner to notify.
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
                              className="inline-flex items-center gap-1 rounded-full border border-current/30 bg-white/80 px-2 py-0.5 text-xs font-medium hover:underline"
                              onClick={() => setSelectedId(p.project_id)}
                            >
                              {p.is_new ? (
                                <span className="inline-flex shrink-0 items-center rounded border border-emerald-300 bg-emerald-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                                  NEW
                                </span>
                              ) : null}
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
            {groupSections.flatMap((section) => {
              const header =
                groupBy !== "none" && section.info.label
                  ? (
                    <tr key={`group-${section.info.key}`} className="bg-wp-stone/40">
                      <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-wp-slate">
                        {section.info.color ? (
                          <span
                            aria-hidden
                            className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                            style={{ background: section.info.color }}
                          />
                        ) : null}
                        {section.info.label}
                        <span className="ml-2 font-normal normal-case tracking-normal text-wp-slate/70">
                          {section.rows.length} project{section.rows.length === 1 ? "" : "s"}
                        </span>
                      </td>
                    </tr>
                  )
                  : null;

              const body = section.rows.flatMap((r) => {
                const key = r.id ?? r.project_id;
                const isOpen = expanded.has(key);
                const rowClickTitle = rowsAreEditable
                  ? "Click to enter/edit this week's status"
                  : isPastWeek
                    ? "Read-only (past week)"
                    : "Viewer access is read-only";
                return (
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
                          className="inline-flex items-center gap-1.5 text-left text-wp-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(r.project_id);
                          }}
                        >
                          {r.is_new ? (
                            <span
                              className="inline-flex shrink-0 items-center rounded border border-emerald-300 bg-emerald-100 px-1 py-px text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                              title="Created since the last status digest was sent"
                            >
                              NEW
                            </span>
                          ) : null}
                          <span>{r.project_title}</span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-wp-slate">
                        {r.owner_id ? (
                          <Link
                            to={`/users/${r.owner_id}`}
                            className="hover:text-wp-ink hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.owner_name ?? "—"}
                          </Link>
                        ) : (
                          <div>{r.owner_name ?? "—"}</div>
                        )}
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
                            <SubtaskStatusUpdatesDisplay
                              subtaskUpdates={r.subtask_updates ?? []}
                              projectTitleById={
                                new Map((projects.data ?? []).map((p) => [p.id, p.title]))
                              }
                            />
                          </div>
                        </Collapsible>
                      </td>
                    </tr>
                  </React.Fragment>
                );
              });

              return header ? [header, ...body] : body;
            })}
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

        {report.data ? (
          <section className="border-t border-wp-stone bg-white px-4 py-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
              New projects identified for backlog
            </h2>
            <p className="mt-1 text-xs text-wp-slate">
              Epics added since the last status digest was sent
              {report.data.new_backlog_since
                ? ` (${format(new Date(report.data.new_backlog_since), "MMM d, yyyy")})`
                : ""}
              {(report.data.new_backlog_projects?.length ?? 0) > 0
                ? ` · ${report.data.new_backlog_projects.length}`
                : ""}
            </p>
            {(report.data.new_backlog_projects?.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm italic text-wp-slate/70">
                No new projects since the last digest.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-wp-stone rounded-md border border-wp-stone">
                {(report.data.new_backlog_projects ?? []).map((p) => (
                  <li key={p.project_id}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 text-left text-sm hover:bg-wp-stone/30"
                      onClick={() => setSelectedId(p.project_id)}
                    >
                      <span
                        className="inline-flex shrink-0 items-center rounded border border-emerald-300 bg-emerald-100 px-1 py-px text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                        title="Created since the last status digest was sent"
                      >
                        NEW
                      </span>
                      <span className="font-medium text-wp-ink">{p.project_title}</span>
                      <span className="text-xs text-wp-slate">
                        {[p.swim_lane_name, p.owner_name].filter(Boolean).join(" · ") || "—"}
                      </span>
                      <span className="ml-auto text-xs text-wp-slate">
                        {format(new Date(p.created_at), "MMM d")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
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
