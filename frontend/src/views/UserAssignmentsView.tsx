import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronRight } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Collapsible } from "../components/Collapsible";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { StatusPill } from "../components/StatusPill";
import { StatusUpdateModal } from "../components/StatusUpdateModal";
import { SubtaskStatusUpdatesDisplay } from "../components/EpicSubtaskStatusUpdates";
import { UserAvatar } from "../components/UserAvatar";
import { cn } from "../lib/cn";
import {
  useCanWrite,
  useIsAdmin,
  useMentionableUsers,
  useProjects,
  useStatusReport,
  useSwimLanes,
  useTeams,
} from "../lib/queries";
import {
  isCompleteLane,
  isHiddenFromUserAssignments,
  laneRequiresWeeklyStatus,
} from "../lib/statusEligibility";
import type { Project, StatusReportRow, SwimLane } from "../lib/types";

type AssignmentRow = {
  project: Project;
  lane: SwimLane;
  status: StatusReportRow | null;
  teamNames: string[];
};

type LaneSection = {
  laneId: string;
  laneName: string;
  laneColor: string | null;
  laneOrder: number;
  isComplete: boolean;
  rows: AssignmentRow[];
};

function sortAssignmentRows(rows: AssignmentRow[]): AssignmentRow[] {
  return rows.slice().sort((a, b) => {
    if (a.project.position !== b.project.position) {
      return a.project.position - b.project.position;
    }
    return a.project.title.localeCompare(b.project.title);
  });
}

function buildLaneSections(
  projects: Project[],
  laneById: Map<string, SwimLane>,
  statusByProjectId: Map<string, StatusReportRow>,
  teamNameById: Map<string, string>,
): { active: LaneSection[]; complete: LaneSection | null } {
  const activeBuckets = new Map<string, LaneSection>();
  let completeSection: LaneSection | null = null;

  for (const project of projects) {
    if (project.deleted_at) continue;
    if (!project.swim_lane_id) continue;
    const lane = laneById.get(project.swim_lane_id);
    if (!lane || isHiddenFromUserAssignments(lane)) continue;

    const row: AssignmentRow = {
      project,
      lane,
      status: statusByProjectId.get(project.id) ?? null,
      teamNames: project.teams
        .map((id) => teamNameById.get(id))
        .filter((name): name is string => !!name),
    };

    if (isCompleteLane(lane)) {
      if (!completeSection) {
        completeSection = {
          laneId: lane.id,
          laneName: lane.name,
          laneColor: lane.color,
          laneOrder: lane.order,
          isComplete: true,
          rows: [],
        };
      }
      completeSection.rows.push(row);
      continue;
    }

    const existing = activeBuckets.get(lane.id);
    if (existing) {
      existing.rows.push(row);
    } else {
      activeBuckets.set(lane.id, {
        laneId: lane.id,
        laneName: lane.name,
        laneColor: lane.color,
        laneOrder: lane.order,
        isComplete: false,
        rows: [row],
      });
    }
  }

  const active = Array.from(activeBuckets.values())
    .map((section) => ({ ...section, rows: sortAssignmentRows(section.rows) }))
    .sort((a, b) => a.laneOrder - b.laneOrder || a.laneName.localeCompare(b.laneName));

  if (completeSection) {
    completeSection = {
      ...completeSection,
      rows: sortAssignmentRows(completeSection.rows),
    };
  }

  return { active, complete: completeSection };
}

export function UserAssignmentsView() {
  const { userId } = useParams<{ userId: string }>();
  const users = useMentionableUsers();
  const projects = useProjects();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const report = useStatusReport();
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusModalId, setStatusModalId] = useState<string | null>(null);

  const user = useMemo(
    () => (users.data ?? []).find((u) => u.id === userId) ?? null,
    [users.data, userId],
  );

  const { activeSections, completeSection, totalCount } = useMemo(() => {
    const laneById = new Map((lanes.data ?? []).map((l) => [l.id, l]));
    const teamNameById = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
    const statusByProjectId = new Map(
      (report.data?.rows ?? []).map((row) => [row.project_id, row]),
    );
    const owned = (projects.data ?? []).filter((p) => p.owner_id === userId);
    const grouped = buildLaneSections(owned, laneById, statusByProjectId, teamNameById);
    const completeCount = grouped.complete?.rows.length ?? 0;
    const activeCount = grouped.active.reduce((sum, s) => sum + s.rows.length, 0);
    return {
      activeSections: grouped.active,
      completeSection: grouped.complete,
      totalCount: activeCount + completeCount,
    };
  }, [projects.data, lanes.data, teams.data, report.data?.rows, userId]);

  const allProjectIds = useMemo(() => {
    const ids: string[] = [];
    for (const section of activeSections) {
      for (const row of section.rows) ids.push(row.project.id);
    }
    for (const row of completeSection?.rows ?? []) ids.push(row.project.id);
    return ids;
  }, [activeSections, completeSection]);

  const loading =
    users.isLoading || projects.isLoading || lanes.isLoading || teams.isLoading;
  const errored = users.isError || projects.isError || lanes.isError;

  function toggleSection(laneId: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  }

  function toggleRow(projectId: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function renderSection(section: LaneSection) {
    const isCollapsed = collapsedSections.has(section.laneId);
    return (
      <section key={section.laneId} className="border-b border-wp-stone last:border-b-0">
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-wp-stone/40 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-wp-slate hover:bg-wp-stone/55"
          onClick={() => toggleSection(section.laneId)}
          aria-expanded={!isCollapsed}
        >
          <ChevronRight
            size={14}
            className={cn(
              "shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none",
              !isCollapsed && "rotate-90",
            )}
          />
          {section.laneColor ? (
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: section.laneColor }}
            />
          ) : null}
          <span className="min-w-0 truncate">{section.laneName}</span>
          <span className="font-normal normal-case tracking-normal text-wp-slate/70">
            {section.rows.length} item{section.rows.length === 1 ? "" : "s"}
          </span>
        </button>
        <Collapsible open={!isCollapsed}>
          <table className="w-full text-sm">
            <tbody>
              {section.rows.flatMap(({ project, lane, status, teamNames }) => {
                const isOpen = expandedRows.has(project.id);
                const statusEditable = canWrite && laneRequiresWeeklyStatus(lane) && project.type === "epic";
                const health = status?.health_flag ?? "white";
                const completed = !!status?.completed;
                const rowClickTitle = statusEditable
                  ? "Click to enter/edit this week's status"
                  : canWrite
                    ? "Status updates apply to epics in weekly-status lanes"
                    : "Viewer access is read-only";

                return (
                  <React.Fragment key={project.id}>
                    <tr
                      onClick={() => statusEditable && setStatusModalId(project.id)}
                      className={cn(
                        "border-b border-wp-stone hover:bg-wp-bg",
                        statusEditable && "cursor-pointer",
                      )}
                      title={rowClickTitle}
                    >
                      <td className="w-8 px-2 py-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(project.id);
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
                      <td className="w-24 px-3 py-2">
                        <StatusPill flag={health} completed={completed} size="md" />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 text-left text-wp-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(project.id);
                          }}
                        >
                          {status?.is_new ? (
                            <span className="inline-flex shrink-0 items-center rounded border border-emerald-300 bg-emerald-100 px-1 py-px text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                              NEW
                            </span>
                          ) : null}
                          {project.type === "subtask" ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate">
                              Subtask
                            </span>
                          ) : null}
                          <span>{project.title}</span>
                        </button>
                      </td>
                      <td className="w-48 px-3 py-2 text-wp-slate">
                        {teamNames.length ? teamNames.join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-wp-slate">
                        {status?.executive_summary || (
                          <span className="italic text-wp-slate/60">no update</span>
                        )}
                      </td>
                      <td className="w-40 px-3 py-2 text-xs text-wp-slate">
                        {status?.submitted_at
                          ? format(new Date(status.submitted_at), "MMM d, h:mm a")
                          : "—"}
                      </td>
                    </tr>
                    <tr className={isOpen ? "border-b border-wp-stone bg-wp-bg" : ""}>
                      <td colSpan={6} className="p-0">
                        <Collapsible open={isOpen}>
                          <div className="px-8 py-3">
                            {status?.detailed_update?.length ? (
                              <ul className="ml-4 list-disc space-y-1 text-sm text-wp-slate">
                                {status.detailed_update.map((b, i) => (
                                  <li key={i}>{b}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-sm italic text-wp-slate/60">
                                No detailed bullets submitted for this week.
                              </span>
                            )}
                            <SubtaskStatusUpdatesDisplay
                              subtaskUpdates={status?.subtask_updates ?? []}
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
              })}
            </tbody>
          </table>
        </Collapsible>
      </section>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-wp-stone bg-white px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-wp-red">
          People
        </p>
        {loading ? (
          <h1 className="mt-0.5 text-xl font-semibold text-wp-ink">Loading…</h1>
        ) : user ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <UserAvatar name={user.name} color={user.color} size={40} />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-wp-ink">{user.name}</h1>
              {isAdmin ? (
                <a
                  href={`mailto:${user.email}`}
                  className="text-sm text-wp-slate hover:underline"
                >
                  {user.email}
                </a>
              ) : (
                <p className="text-sm text-wp-slate">
                  {totalCount} assigned item{totalCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
            {isAdmin ? (
              <p className="text-sm text-wp-slate">
                {totalCount} assigned item{totalCount === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-0.5">
            <h1 className="text-xl font-semibold text-wp-ink">User not found</h1>
            <p className="mt-1 text-sm text-wp-slate">
              This person is not in the current workspace roster.
            </p>
            <Link to="/" className="mt-2 inline-block text-sm text-wp-red hover:underline">
              Back to home
            </Link>
          </div>
        )}
        {user ? (
          <p className="mt-2 text-sm text-wp-slate">
            Assigned items grouped by swim lane. Parking lot and archive are omitted.
          </p>
        ) : null}
      </header>

      <div className="flex-1 overflow-auto">
        {errored ? (
          <p className="p-6 text-sm text-wp-red">Couldn&apos;t load assignments.</p>
        ) : loading ? (
          <p className="p-6 text-sm text-wp-slate">Loading…</p>
        ) : !user ? null : totalCount === 0 ? (
          <p className="p-6 text-sm text-wp-slate">No assigned items in listed swim lanes.</p>
        ) : (
          <>
            <table className="sticky top-0 z-10 w-full bg-wp-stone/50 text-xs uppercase tracking-wide text-wp-slate">
              <thead>
                <tr>
                  <th className="w-8"></th>
                  <th className="w-24 px-3 py-2 text-left">Health</th>
                  <th className="px-3 py-2 text-left">Project</th>
                  <th className="w-48 px-3 py-2 text-left">Teams</th>
                  <th className="px-3 py-2 text-left">Executive summary</th>
                  <th className="w-40 px-3 py-2 text-left">Submitted</th>
                </tr>
              </thead>
            </table>
            {activeSections.map((section) => renderSection(section))}
            {completeSection ? renderSection(completeSection) : null}
          </>
        )}
      </div>

      {selectedId ? (
        <ProjectDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenProject={setSelectedId}
          siblingIds={allProjectIds}
        />
      ) : null}
      {statusModalId ? (
        <StatusUpdateModal projectId={statusModalId} onClose={() => setStatusModalId(null)} />
      ) : null}
    </div>
  );
}
