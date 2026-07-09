import { useMemo, useState } from "react";
import { differenceInCalendarDays, format } from "date-fns";
import { useKpis, useProjects, useSwimLanes, useTeams } from "../lib/queries";
import { computePhases } from "../lib/phaseCompute";
import type { Project, SwimLane, Team } from "../lib/types";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";

/**
 * KPI report: one section per admin-defined KPI, showing every
 * roadmap-visible ("scheduled") project assigned to it, sorted by
 * end date (soonest → latest). Same visibility rule as the Roadmap
 * so this reads as the outcome-focused slice of that same picture.
 */
export function KpiReportView() {
  const kpis = useKpis();
  const projects = useProjects();
  const teams = useTeams();
  const lanes = useSwimLanes();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scheduled = useMemo(() => {
    return (projects.data ?? []).filter((p) => computePhases(p).scheduled && !p.deleted_at);
  }, [projects.data]);

  // Group scheduled projects by KPI id up-front so each section render is
  // an O(1) lookup + sort. `undefined-KPI` bucket isn't needed here — the
  // report is keyed off the KPI catalog, not the projects.
  const projectsByKpi = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of scheduled) {
      for (const kid of p.kpis ?? []) {
        const arr = map.get(kid) ?? [];
        arr.push(p);
        map.set(kid, arr);
      }
    }
    return map;
  }, [scheduled]);

  if (kpis.isLoading || projects.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading KPI report…</div>;
  }

  const kpiList = kpis.data ?? [];
  const teamList = teams.data ?? [];
  const laneList = lanes.data ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <header className="mb-4">
          <h1 className="text-xl font-semibold text-wp-ink">KPIs</h1>
          <p className="mt-1 text-sm text-wp-slate">
            Every KPI and the roadmap-visible projects contributing to it, sorted by upcoming end date.
            Projects can appear under more than one KPI.
          </p>
        </header>

        {kpiList.length === 0 ? (
          <div className="card-surface p-6 text-sm text-wp-slate">
            No KPIs defined yet. Admins can create them under <span className="font-medium text-wp-ink">Admin → KPIs</span>.
          </div>
        ) : (
          <div className="space-y-6">
            {kpiList.map((k) => {
              const rows = (projectsByKpi.get(k.id) ?? [])
                .slice()
                .sort(byEndDate);
              return (
                <KpiSection
                  key={k.id}
                  name={k.name}
                  color={k.color}
                  description={k.description}
                  projects={rows}
                  teams={teamList}
                  lanes={laneList}
                  onOpen={setSelectedId}
                />
              );
            })}
          </div>
        )}
      </div>

      {selectedId ? (
        <ProjectDetailPanel id={selectedId} onClose={() => setSelectedId(null)} onOpenProject={setSelectedId} />
      ) : null}
    </div>
  );
}

function KpiSection(props: {
  name: string;
  color: string;
  description: string;
  projects: Project[];
  teams: Team[];
  lanes: SwimLane[];
  onOpen: (id: string) => void;
}) {
  const { name, color, description, projects, teams, lanes, onOpen } = props;
  return (
    <section className="card-surface overflow-hidden">
      <header
        className="flex items-start gap-3 border-l-4 px-4 py-3"
        style={{ borderLeftColor: color, background: `${color}10` }}
      >
        <span
          aria-hidden
          className="mt-1 inline-block h-3 w-3 rounded-full"
          style={{ background: color }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-baseline gap-2 text-base font-semibold text-wp-ink">
            {name}
            <span className="text-xs font-normal text-wp-slate">
              {projects.length} active project{projects.length === 1 ? "" : "s"}
            </span>
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-wp-slate">{description}</p>
          ) : null}
        </div>
      </header>

      {projects.length === 0 ? (
        <p className="px-4 py-3 text-xs text-wp-slate">
          No active projects tracked for this KPI yet.
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead className="bg-wp-stone/30 text-xs uppercase tracking-wide text-wp-slate">
            <tr>
              <th className="px-4 py-2 text-left font-semibold">Project</th>
              <th className="px-4 py-2 text-left font-semibold">Teams</th>
              <th className="px-4 py-2 text-left font-semibold">End date</th>
              <th className="px-4 py-2 text-left font-semibold">Swim lane</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                teams={teams}
                lanes={lanes}
                onOpen={() => onOpen(p.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ProjectRow(props: {
  project: Project;
  teams: Team[];
  lanes: SwimLane[];
  onOpen: () => void;
}) {
  const { project, teams, lanes, onOpen } = props;
  const end = endDateOf(project);
  const lane = lanes.find((l) => l.id === project.swim_lane_id);
  const projectTeams = teams.filter((t) => project.teams.includes(t.id));
  // Overdue / imminent styling — helps a PM scan for "what's about to
  // slip" without staring at the dates. Neutral if the project is
  // more than two weeks out.
  const daysOut = end ? differenceInCalendarDays(end, new Date()) : null;
  const overdue = daysOut !== null && daysOut < 0;
  const imminent = daysOut !== null && daysOut >= 0 && daysOut <= 14;

  return (
    <tr
      className="cursor-pointer border-t border-wp-stone/60 hover:bg-wp-stone/20"
      onClick={onOpen}
    >
      <td className="px-4 py-2 font-medium text-wp-ink">{project.title}</td>
      <td className="px-4 py-2">
        {projectTeams.length ? (
          <div className="flex flex-wrap gap-1">
            {projectTeams.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
                style={{ borderColor: t.color, color: t.color, background: `${t.color}18` }}
              >
                {t.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-wp-slate">—</span>
        )}
      </td>
      <td className={`px-4 py-2 text-sm ${overdue ? "text-red-600 font-semibold" : imminent ? "text-amber-700" : "text-wp-ink"}`}>
        {end ? format(end, "MMM d, yyyy") : "—"}
        {end && daysOut !== null ? (
          <span className="ml-1.5 text-[11px] font-normal text-wp-slate/80">
            ({overdue ? `${Math.abs(daysOut)}d overdue` : `${daysOut}d out`})
          </span>
        ) : null}
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

/** End-date used for sorting / display: matches the Roadmap bar tip.
 *  optimization_end_date is guaranteed non-null for "scheduled"
 *  projects (see computePhases), so we can rely on it here. */
function endDateOf(p: Project): Date | null {
  const iso = p.optimization_end_date ?? p.dev_end_date ?? p.target_date;
  return iso ? new Date(`${iso}T00:00:00`) : null;
}

function byEndDate(a: Project, b: Project): number {
  const ae = endDateOf(a);
  const be = endDateOf(b);
  if (ae && be) return ae.getTime() - be.getTime();
  if (ae) return -1;
  if (be) return 1;
  return a.title.localeCompare(b.title);
}
