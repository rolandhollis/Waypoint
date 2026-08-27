import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useMentionableUsers, useProjects, useSwimLanes } from "../lib/queries";
import { laneRequiresWeeklyStatus } from "../lib/statusEligibility";

/** Plot area for bars (px). Match AbHomeActivityChart. */
const BAR_MAX_PX = 180;

type OwnerBar = {
  ownerId: string;
  ownerName: string;
  count: number;
};

function formatLaneList(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names.at(0) ?? "";
  if (names.length === 2) return `${names.at(0)} and ${names.at(1)}`;
  const last = names.at(-1) ?? "";
  return `${names.slice(0, -1).join(", ")}, and ${last}`;
}

/**
 * Homepage bar chart: active assignments per product manager.
 *
 * Counts epics currently in a lane that would surface on the Status
 * Report (`requires_weekly_status`, excluding backlog / default-new),
 * grouped by owner. Ranked highest → lowest left to right; owners
 * with zero eligible items are omitted.
 */
export function HomeStatusLoadChart() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const users = useMentionableUsers();

  const eligibleLaneNames = useMemo(() => {
    return (lanes.data ?? [])
      .filter((lane) => laneRequiresWeeklyStatus(lane))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((lane) => lane.name);
  }, [lanes.data]);

  const bars = useMemo((): OwnerBar[] => {
    const list = projects.data ?? [];
    const laneById = new Map((lanes.data ?? []).map((l) => [l.id, l]));
    const nameById = new Map((users.data ?? []).map((u) => [u.id, u.name]));

    const counts = new Map<string, number>();
    for (const p of list) {
      if (p.deleted_at) continue;
      if (p.type !== "epic") continue;
      if (!p.owner_id) continue;
      if (!p.swim_lane_id) continue;
      const lane = laneById.get(p.swim_lane_id);
      if (!laneRequiresWeeklyStatus(lane)) continue;
      counts.set(p.owner_id, (counts.get(p.owner_id) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([ownerId, count]) => ({
        ownerId,
        ownerName: nameById.get(ownerId)?.trim() || "Unknown",
        count,
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.ownerName.localeCompare(b.ownerName);
      });
  }, [projects.data, lanes.data, users.data]);

  const loading = projects.isLoading || lanes.isLoading || users.isLoading;
  const errored = projects.isError || lanes.isError || users.isError;
  const total = bars.reduce((sum, b) => sum + b.count, 0);
  const maxCount = Math.max(1, ...bars.map((b) => b.count));
  const laneSubtitle =
    eligibleLaneNames.length > 0
      ? `Owned epics in ${formatLaneList(eligibleLaneNames)} — the swim lanes that appear on the weekly status report.`
      : "Owned epics in swim lanes that appear on the weekly status report.";

  return (
    <section className="card-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-wp-ink">Active Assignments by PM</h2>
          <p className="mt-0.5 text-xs text-wp-slate">{laneSubtitle}</p>
        </div>
        <p className="text-xs text-wp-slate">
          {loading
            ? "Loading…"
            : `${total} item${total === 1 ? "" : "s"} · ${bars.length} PM${
                bars.length === 1 ? "" : "s"
              }`}
        </p>
      </div>

      {errored ? (
        <p className="mt-6 text-sm text-wp-red">Couldn’t load active assignments.</p>
      ) : loading ? (
        <p className="mt-6 text-sm text-wp-slate">Loading…</p>
      ) : bars.length === 0 ? (
        <p className="mt-6 text-sm text-wp-slate">
          No owned items currently in these swim lanes.
        </p>
      ) : (
        <div className="mt-6">
          <div
            className="flex h-56 items-end gap-2 border-b border-wp-stone px-1"
            role="img"
            aria-label={`Bar chart of ${total} active assignments across ${bars.length} product managers`}
          >
            {bars.map((b) => {
              const heightPx = Math.max(8, Math.round((b.count / maxCount) * BAR_MAX_PX));
              return (
                <div
                  key={b.ownerId}
                  className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                >
                  <span className="text-[11px] font-medium tabular-nums text-wp-ink">
                    {b.count}
                  </span>
                  <div
                    className="w-full max-w-[3.5rem] rounded-t-md bg-wp-red/85 transition-[height]"
                    style={{ height: `${heightPx}px` }}
                    title={`${b.ownerName}: ${b.count}`}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2 px-1">
            {bars.map((b) => (
              <div
                key={`${b.ownerId}-lbl`}
                className="min-w-0 flex-1 truncate text-center text-[10px] leading-tight text-wp-slate"
                title={b.ownerName}
              >
                <Link
                  to={`/users/${b.ownerId}`}
                  className="hover:text-wp-ink hover:underline"
                >
                  {b.ownerName}
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
