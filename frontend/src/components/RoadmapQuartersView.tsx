import { useMemo } from "react";
import { Star } from "lucide-react";
import {
  addQuarters,
  endOfQuarter,
  format,
  getQuarter,
  getYear,
  parseISO,
  startOfQuarter,
} from "date-fns";
import { cn } from "../lib/cn";
import { readableOn, tint } from "../lib/colors";
import type { Project, SwimLane, Team, User } from "../lib/types";

/**
 * "By Quarter" roadmap layout. Renders as a horizontal set of
 * columns — one per rolling quarter — with items placed in the
 * column that matches their completion quarter (derived from
 * `optimization_end_date`). This is a wholly different surface
 * from the Gantt: no bars, no dates, no dependencies — just a
 * priority-ordered list of what completes in each quarter.
 *
 * Column window: **current quarter + next 3 (total 4)**. Anything
 * completing before the current quarter (in the past) or after
 * the fourth column (too far future) is dropped. This aligns with
 * a rolling 12-month outlook and gives a clean 4-column layout on
 * desktop, degrading to 2 columns on `md` and 1 on mobile.
 *
 * Ordering inside a column is the roadmap priority composite —
 * `global_priority` first (with 0 treated as Infinity so unranked
 * items fall to the bottom), then swim-lane order, then
 * per-lane `projects.position`, then `updated_at DESC` for
 * recency, then `id` as a stable final tiebreaker.
 *
 * Filtering is entirely the caller's responsibility: the same
 * `applyFilters`-filtered set the Gantt receives feeds in here
 * (including the "Key strategic only" chip). Archive / Parking
 * Lot / hidden-from-roadmap items are also already dropped
 * upstream by `RoadmapView.visibleProjects`.
 */
export function RoadmapQuartersView({
  projects,
  lanes,
  teams,
  users,
  onOpen,
  now = new Date(),
  pdfMode = false,
}: {
  projects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  /** Fires with the clicked project id — opens the detail modal. */
  onOpen: (id: string) => void;
  /**
   * Test hook: override "today" so the column set is deterministic
   * in unit tests / snapshot fixtures. Production always uses the
   * live wall clock.
   */
  now?: Date;
  /**
   * When true, drop the per-column max-height / overflow-y-auto
   * constraints so the PDF exporter captures every item in every
   * column (no clipped bodies). The interactive view keeps the
   * caps so the page itself doesn't grow — matching the same
   * `pdfMode` bookend the Gantt uses.
   */
  pdfMode?: boolean;
}) {
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  // Build the four-quarter window anchored on today. `startOfQuarter`
  // hands us the first day of the current quarter; each subsequent
  // column is `+1 quarter`. Labels use `getQuarter` + `getYear` for
  // the header (`Q3 2026`) and `format(..., "MMM")` on the start /
  // end for the subline (`Jul – Sep`).
  const columns = useMemo(() => {
    const cols: {
      key: string;
      label: string;
      subline: string;
      start: Date;
      end: Date;
    }[] = [];
    for (let i = 0; i < 4; i++) {
      const anchor = addQuarters(startOfQuarter(now), i);
      const start = startOfQuarter(anchor);
      const end = endOfQuarter(anchor);
      cols.push({
        key: `${getYear(start)}-Q${getQuarter(start)}`,
        label: `Q${getQuarter(start)} ${getYear(start)}`,
        subline: `${format(start, "MMM")} – ${format(end, "MMM")}`,
        start,
        end,
      });
    }
    return cols;
  }, [now]);

  // Priority composite matching the spec:
  //   1) global_priority ASC (0 → Infinity so unranked lands last)
  //   2) swim_lane.order ASC (unassigned → Infinity)
  //   3) projects.position ASC
  //   4) updated_at DESC
  //   5) id ASC (deterministic final tiebreaker)
  const byPriority = useMemo(
    () => (a: Project, b: Project) => {
      const gpA = a.global_priority === 0 ? Number.POSITIVE_INFINITY : a.global_priority;
      const gpB = b.global_priority === 0 ? Number.POSITIVE_INFINITY : b.global_priority;
      if (gpA !== gpB) return gpA - gpB;
      const laneA = a.swim_lane_id ? lanesById.get(a.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const laneB = b.swim_lane_id ? lanesById.get(b.swim_lane_id)?.order ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      if (laneA !== laneB) return laneA - laneB;
      if (a.position !== b.position) return a.position - b.position;
      const updatedCmp = (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      if (updatedCmp !== 0) return updatedCmp;
      return a.id.localeCompare(b.id);
    },
    [lanesById],
  );

  // Bucket each eligible project into the matching column.
  //   * `optimization_end_date` missing → drop (spec: same
  //     eligibility as the roadmap; needs the completion date to
  //     resolve a quarter).
  //   * completion before the earliest visible quarter → drop
  //     (item is in the past).
  //   * completion after the latest visible quarter → drop
  //     (too far future for the 4-column rolling window).
  const bucketed = useMemo(() => {
    const buckets: Project[][] = columns.map(() => []);
    if (columns.length === 0) return buckets;
    const first = columns[0];
    const last = columns[columns.length - 1];
    if (!first || !last) return buckets;
    const firstStart = first.start.getTime();
    const lastEnd = last.end.getTime();
    for (const p of projects) {
      if (!p.optimization_end_date) continue;
      const completion = parseISO(`${p.optimization_end_date}T00:00:00`).getTime();
      if (Number.isNaN(completion)) continue;
      if (completion < firstStart || completion > lastEnd) continue;
      // Linear scan is fine — always 4 columns.
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const bucket = buckets[i];
        if (!col || !bucket) continue;
        if (completion <= col.end.getTime()) {
          bucket.push(p);
          break;
        }
      }
    }
    for (const b of buckets) b.sort(byPriority);
    return buckets;
  }, [projects, columns, byPriority]);

  const totalCount = bucketed.reduce((n, list) => n + list.length, 0);

  return (
    <div className="p-4" data-roadmap-capture-root="true">
      {totalCount === 0 ? (
        <div className="mb-3 rounded-md border border-dashed border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
          No initiatives complete in the next four quarters with the current filters.
        </div>
      ) : null}
      <div
        className={cn(
          "grid gap-4",
          "grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
        )}
      >
        {columns.map((col, colIdx) => {
          const items = bucketed[colIdx] ?? [];
          return (
            <div
              key={col.key}
              className={cn(
                "flex flex-col rounded-lg border border-wp-stone bg-white shadow-sm",
                pdfMode
                  ? "overflow-visible"
                  : "max-h-[calc(100vh-320px)] overflow-hidden",
              )}
            >
              {/* Sticky header — pins to the top of the column so
                  the quarter label stays visible while the body
                  scrolls internally. */}
              <div className="sticky top-0 z-10 border-b border-wp-stone bg-white/95 px-3 py-2 backdrop-blur-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-semibold text-wp-ink">{col.label}</div>
                  <div className="text-[11px] uppercase tracking-wide text-wp-slate">
                    {items.length} {items.length === 1 ? "item" : "items"}
                  </div>
                </div>
                <div className="text-[11px] text-wp-slate">{col.subline}</div>
              </div>
              <div
                className={cn(
                  "flex-1 space-y-2 px-2 py-2",
                  pdfMode ? "overflow-visible" : "overflow-y-auto",
                )}
              >
                {items.length === 0 ? (
                  <div className="px-2 py-4 text-center text-[11px] italic text-wp-slate/70">
                    No items completing this quarter
                  </div>
                ) : (
                  items.map((p) => (
                    <QuarterItemCard
                      key={p.id}
                      project={p}
                      team={p.teams[0] ? teamsById.get(p.teams[0]) : undefined}
                      owner={p.owner_id ? usersById.get(p.owner_id) : undefined}
                      onOpen={onOpen}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Compact per-item card rendered inside a quarter column. Whole
 * card is the click target so PMs can drill straight into the
 * detail modal without hunting for a specific affordance. Team
 * chip (primary team only), a star for `is_key_strategic`, and
 * an owner initial live in a single row below the title.
 */
function QuarterItemCard({
  project,
  team,
  owner,
  onOpen,
}: {
  project: Project;
  team: Team | undefined;
  owner: User | undefined;
  onOpen: (id: string) => void;
}) {
  const teamBg = team ? tint(team.color, 0.14) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(project.id)}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-md border border-wp-stone bg-white px-2.5 py-2 text-left transition",
        "hover:border-wp-red/40 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red/40",
      )}
      title={project.title}
      aria-label={`Open ${project.title}`}
    >
      <div className="flex items-start gap-1.5">
        <div
          className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-wp-ink"
        >
          {project.title}
        </div>
        {project.is_key_strategic ? (
          <Star
            size={12}
            className="mt-0.5 shrink-0 fill-wp-red text-wp-red"
            aria-label="Key strategic"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-wp-slate">
        {team && teamBg ? (
          <span
            className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
            style={{ borderColor: team.color, background: teamBg, color: readableOn(teamBg) }}
            title={`Team: ${team.name}`}
          >
            {team.name}
          </span>
        ) : null}
        {owner ? (
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
            style={{ background: owner.color }}
            title={owner.name}
          >
            {initials(owner.name)}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}
