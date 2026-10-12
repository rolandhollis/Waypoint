import { useMemo, useState } from "react";
import { format, parseISO, subDays, startOfDay } from "date-fns";
import { useProjects, useSwimLanes, useTeams } from "../lib/queries";
import { pillTextColor, tint } from "../lib/colors";
import type { Project, SwimLane, Team } from "../lib/types";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { ViewPageHeader } from "../components/ViewPageHeader";

const DAY_OPTIONS = [7, 30, 90] as const;

/**
 * Completed report: roadmap projects with an actual_completion_date
 * in the selected window (default 30 days), newest first. Same project
 * list as Board/Roadmap — completion is stamped when a card enters a
 * terminal swim lane.
 */
export function CompletedReportView() {
  const projects = useProjects();
  const teams = useTeams();
  const lanes = useSwimLanes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);
  const [teamFilter, setTeamFilter] = useState<string>("");

  const cutoff = useMemo(
    () => startOfDay(subDays(new Date(), days)),
    [days],
  );

  const completed = useMemo(() => {
    const rows = (projects.data ?? []).filter((p) => {
      if (p.deleted_at) return false;
      if (!p.actual_completion_date) return false;
      const completedOn = parseISO(`${p.actual_completion_date}T00:00:00`);
      if (Number.isNaN(completedOn.getTime()) || completedOn < cutoff) return false;
      if (teamFilter && !(p.teams ?? []).includes(teamFilter)) return false;
      return true;
    });
    rows.sort(byCompletionDateDesc);
    return rows;
  }, [projects.data, cutoff, teamFilter]);

  const siblingIds = useMemo(() => completed.map((p) => p.id), [completed]);

  if (projects.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading completed report…</div>;
  }

  const teamList = teams.data ?? [];
  const laneList = lanes.data ?? [];
  const rangeLabel = `${format(cutoff, "MMM d, yyyy")} – ${format(new Date(), "MMM d, yyyy")}`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="completed" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <p className="text-xs text-wp-slate">
              {completed.length} project{completed.length === 1 ? "" : "s"} completed
              {" · "}
              {rangeLabel}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs font-medium text-wp-slate" htmlFor="completed-days">
                  Window
                </label>
                <select
                  id="completed-days"
                  className="input mt-1 block min-w-[140px]"
                  value={days}
                  onChange={(e) =>
                    setDays(Number(e.target.value) as (typeof DAY_OPTIONS)[number])
                  }
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      Last {d} days
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-wp-slate" htmlFor="completed-team">
                  Team
                </label>
                <select
                  id="completed-team"
                  className="input mt-1 block min-w-[180px]"
                  value={teamFilter}
                  onChange={(e) => setTeamFilter(e.target.value)}
                >
                  <option value="">All teams</option>
                  {teamList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <section className="card-surface overflow-hidden">
            {completed.length === 0 ? (
              <p className="px-4 py-6 text-sm text-wp-slate">
                No roadmap projects completed in this window
                {teamFilter ? " for the selected team" : ""}.
              </p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead className="bg-wp-stone/30 text-xs uppercase tracking-wide text-wp-slate">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">Project</th>
                    <th className="px-4 py-2 text-left font-semibold">Teams</th>
                    <th className="px-4 py-2 text-left font-semibold">Completed</th>
                    <th className="px-4 py-2 text-left font-semibold">Swim lane</th>
                  </tr>
                </thead>
                <tbody>
                  {completed.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      teams={teamList}
                      lanes={laneList}
                      onOpen={() => setSelectedId(p.id)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      {selectedId ? (
        <ProjectDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenProject={setSelectedId}
          siblingIds={siblingIds}
        />
      ) : null}
    </div>
  );
}

function ProjectRow(props: {
  project: Project;
  teams: Team[];
  lanes: SwimLane[];
  onOpen: () => void;
}) {
  const { project, teams, lanes, onOpen } = props;
  const completedOn = project.actual_completion_date
    ? parseISO(`${project.actual_completion_date}T00:00:00`)
    : null;
  const lane = lanes.find((l) => l.id === project.swim_lane_id);
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const projectTeams = (project.teams ?? [])
    .map((id) => teamsById.get(id))
    .filter((t): t is Team => !!t);

  return (
    <tr
      className="cursor-pointer border-t border-wp-stone/60 hover:bg-wp-stone/20"
      onClick={onOpen}
    >
      <td className="px-4 py-2 font-medium text-wp-ink">{project.title}</td>
      <td className="px-4 py-2">
        {projectTeams.length ? (
          <div className="flex flex-wrap gap-1">
            {projectTeams.map((t) => {
              const bg = tint(t.color, 0.14);
              return (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
                  style={{
                    borderColor: t.color,
                    background: bg,
                    color: pillTextColor(t.color),
                  }}
                >
                  {t.name}
                </span>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-wp-slate">—</span>
        )}
      </td>
      <td className="px-4 py-2 text-sm text-wp-ink">
        {completedOn ? format(completedOn, "MMM d, yyyy") : "—"}
      </td>
      <td className="px-4 py-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: lane?.color ?? "#94a3b8" }}
          />
          {lane?.name ?? "—"}
        </span>
      </td>
    </tr>
  );
}

function byCompletionDateDesc(a: Project, b: Project): number {
  const ae = a.actual_completion_date ?? "";
  const be = b.actual_completion_date ?? "";
  if (ae !== be) return be.localeCompare(ae);
  return a.title.localeCompare(b.title);
}
