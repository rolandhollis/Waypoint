import { useMemo } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import type { Project, SwimLane, Team, User } from "../lib/types";
import { useViewStore } from "../lib/viewState";
import { cn } from "../lib/cn";
import { Collapsible } from "./Collapsible";

const EXCLUDED_LANE_NAMES = new Set(["parking lot"]);

export function UnscheduledList(props: {
  projects: Project[];
  lanes: SwimLane[];
  users: User[];
  teams: Team[];
  onOpen: (id: string) => void;
}) {
  const { projects, lanes, users, teams, onOpen } = props;

  // Section-level open state is a shared roadmap UI pref persisted
  // in the zustand view store — mirrors RecentChanges so a user's
  // "keep it closed" preference survives a reload. Store default is
  // false so the section lands collapsed on first visit.
  const sectionOpen = useViewStore((s) => s.roadmapUnscheduledOpen);
  const setSectionOpen = useViewStore((s) => s.setRoadmapUnscheduledOpen);

  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

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
    <section className="border-t border-wp-stone bg-white/60 px-4 py-3">
      {/* Header row mirrors RecentChanges: chevron + title + count
          summary. Kept as a single button so the whole row is a hit
          target for expand/collapse. */}
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setSectionOpen(!sectionOpen)}
        aria-expanded={sectionOpen}
      >
        <ChevronRight
          size={14}
          className={cn(
            "text-wp-slate transition-transform duration-200 ease-out motion-reduce:transition-none",
            sectionOpen && "rotate-90",
          )}
        />
        <AlertCircle size={14} className="text-amber-500" />
        <h3 className="text-sm font-semibold text-wp-ink">Unscheduled</h3>
        <span className="text-xs text-wp-slate">
          — {total} item{total === 1 ? "" : "s"}
        </span>
        {sectionOpen ? (
          <span className="ml-2 text-xs font-normal text-wp-slate">
            Needs at least one phase with both a start and an end date to appear on the timeline.
          </span>
        ) : null}
      </button>

      <Collapsible open={sectionOpen}>
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
                <ul className="flex flex-col gap-2">
                  {g.projects.map((p) => {
                    const owner = users.find((u) => u.id === p.owner_id);
                    // Iterate `p.teams` in its stored order so the row
                    // preserves the PM's ranking — the primary team
                    // shows first in the comma-joined list.
                    const projectTeams = p.teams
                      .map((id) => teamsById.get(id))
                      .filter((t): t is Team => !!t);
                    const description = p.description?.trim();
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
                          {description ? (
                            <p className="mt-1 line-clamp-2 text-xs text-wp-slate" title={description}>
                              {description}
                            </p>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Collapsible>
    </section>
  );
}
