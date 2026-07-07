import { useMemo } from "react";
import { AlertCircle } from "lucide-react";
import type { Project, SwimLane, Team, User } from "../lib/types";

const EXCLUDED_LANE_NAMES = new Set(["parking lot"]);

export function UnscheduledList(props: {
  projects: Project[];
  lanes: SwimLane[];
  users: User[];
  teams: Team[];
  onOpen: (id: string) => void;
}) {
  const { projects, lanes, users, teams, onOpen } = props;

  const groups = useMemo(() => {
    // Bucket by lane id (null = unassigned) and drop excluded lanes entirely.
    const byLane = new Map<string | null, Project[]>();
    for (const p of projects) {
      const lane = lanes.find((l) => l.id === p.swim_lane_id);
      if (lane && EXCLUDED_LANE_NAMES.has(lane.name.toLowerCase())) continue;
      const key = p.swim_lane_id;
      const arr = byLane.get(key) ?? [];
      arr.push(p);
      byLane.set(key, arr);
    }

    // Descending by lane.order — so lanes closest to shipping (Ready for Dev,
    // In Dev, Complete) surface first, which is where unscheduled items are
    // most urgent to plan.
    const orderedLanes = [...lanes]
      .filter((l) => !EXCLUDED_LANE_NAMES.has(l.name.toLowerCase()))
      .sort((a, b) => b.order - a.order);

    const result: { lane: SwimLane | null; projects: Project[] }[] = [];
    for (const l of orderedLanes) {
      const ps = byLane.get(l.id);
      if (ps && ps.length) result.push({ lane: l, projects: ps });
    }
    // Anything currently sitting in the Unassigned holding area lands at the bottom.
    const unassigned = byLane.get(null);
    if (unassigned && unassigned.length) result.push({ lane: null, projects: unassigned });
    return result;
  }, [projects, lanes]);

  const total = groups.reduce((s, g) => s + g.projects.length, 0);

  return (
    <section className="border-t border-wp-stone bg-white/60 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-wp-ink">
        <AlertCircle size={16} className="text-amber-500" />
        Unscheduled ({total})
        <span className="ml-2 text-xs font-normal text-wp-slate">Needs start, target, dev end, and optimization end dates to appear on the timeline.</span>
      </div>

      {groups.length === 0 ? (
        <p className="mt-3 text-xs text-wp-slate">Nothing needing planning attention.</p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((g) => (
            <div key={g.lane?.id ?? "unassigned"}>
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: g.lane?.color ?? "#94a3b8" }}
                  aria-hidden
                />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
                  {g.lane?.name ?? "Unassigned"}
                </h3>
                <span className="text-xs text-wp-slate/70">{g.projects.length}</span>
              </div>
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
                {g.projects.map((p) => {
                  const owner = users.find((u) => u.id === p.owner_id);
                  const projectTeams = teams.filter((t) => p.teams.includes(t.id));
                  const missing: string[] = [];
                  if (!p.start_date) missing.push("start_date");
                  if (!p.target_date) missing.push("target_date");
                  if (!p.dev_end_date) missing.push("dev_end_date");
                  if (!p.optimization_end_date) missing.push("optimization_end_date");
                  return (
                    <li key={p.id}>
                      <button
                        className="card-surface w-full p-3 text-left hover:border-wp-red/40"
                        onClick={() => onOpen(p.id)}
                      >
                        <div className="text-sm font-medium text-wp-ink">{p.title}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-wp-slate">
                          {owner ? <span>{owner.name}</span> : null}
                          {projectTeams.length ? <span>· {projectTeams.map((t) => t.name).join(", ")}</span> : null}
                        </div>
                        <div className="mt-1 text-xs text-amber-700">missing: {missing.join(", ")}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
