import { useMemo } from "react";
import {
  useProjects,
  useSwimLanes,
} from "../lib/queries";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { AbHomeActivityChart } from "../components/AbHomeActivityChart";
import type { SwimLane } from "../lib/types";

function laneNameKey(lane: Pick<SwimLane, "name">): string {
  return lane.name.trim().toLowerCase();
}

/** Lanes that are not active delivery work (backlog, complete, parking lot, archive). */
function isNonActiveLane(lane: SwimLane): boolean {
  const name = laneNameKey(lane);
  if (lane.is_archive) return true;
  if (lane.is_terminal) return true;
  if (lane.is_default_new) return true;
  if (name === "backlog") return true;
  if (name === "parking lot") return true;
  return false;
}

/**
 * Workspace homepage — project counts + ZiffSplit activity chart slot.
 * Reachable from the brand icon only (not a primary nav tab).
 */
export function HomeView() {
  const projects = useProjects();
  const lanes = useSwimLanes();

  const projectCounts = useMemo(() => {
    const list = projects.data ?? [];
    const laneById = new Map((lanes.data ?? []).map((l) => [l.id, l]));
    let inProgress = 0;
    for (const p of list) {
      if (!p.swim_lane_id) continue;
      const lane = laneById.get(p.swim_lane_id);
      if (!lane) continue;
      if (!isNonActiveLane(lane)) inProgress += 1;
    }
    return { total: list.length, inProgress };
  }, [projects.data, lanes.data]);

  const countsLoading = projects.isLoading || lanes.isLoading;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="home" />
      <div className="flex-1 overflow-auto p-5">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Column A — 4/12 */}
          <div className="lg:col-span-4">
            <section className="card-surface p-4">
              <h2 className="text-base font-semibold text-wp-ink">Projects</h2>
              <p className="mt-1 text-xs text-wp-slate">
                In progress excludes backlog, complete, parking lot, and archive.
              </p>
              {countsLoading ? (
                <p className="mt-6 text-sm text-wp-slate">Loading…</p>
              ) : projects.isError || lanes.isError ? (
                <p className="mt-6 text-sm text-wp-red">Couldn’t load project counts.</p>
              ) : (
                <dl className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-wp-slate">
                      Total
                    </dt>
                    <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
                      {projectCounts.total}
                    </dd>
                  </div>
                  <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-wp-slate">
                      In progress
                    </dt>
                    <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
                      {projectCounts.inProgress}
                    </dd>
                  </div>
                </dl>
              )}
            </section>
          </div>

          {/* Column B — 8/12 · ZiffSplit container `home_activity_chart` */}
          <div className="lg:col-span-8">
            <AbHomeActivityChart />
          </div>
        </div>
      </div>
    </div>
  );
}
