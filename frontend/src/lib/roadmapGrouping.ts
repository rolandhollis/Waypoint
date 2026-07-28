import type { Kpi, Project, SwimLane, Team, User } from "./types";
import type { GroupBy } from "./viewState";

/**
 * Shared Roadmap grouping primitives.
 *
 * Both roadmap render styles (`GanttTimeline` "Rows" and
 * `RoadmapCompactView` "Compact") partition top-level items into the
 * same buckets under the same rules — same primary-team / primary-
 * KPI / primary-tag routing, same "Unassigned" fallback keys, same
 * group-header ordering. Historically the logic lived inline inside
 * `groupTreeRows` in GanttTimeline; extracting it here means:
 *
 *   1. Compact and Rows can't drift on the small edge cases
 *      (an item with no swim lane sinks to the same "Unassigned"
 *      bucket in both styles, tag-primary bucketing labels the
 *      "no tag" case the same way, etc.).
 *   2. Future callers (a hypothetical PDF-only renderer, a report
 *      export) can pick up the same rules for free.
 *
 * Nothing in this module walks the epic / subtask tree — that's
 * still Rows-view territory because Compact treats every item as
 * its own bar with no descendants. The helper only owns the
 * "resolve one project → one bucket" and "compare two buckets for
 * header order" decisions; each caller wraps those in whatever
 * outer loop makes sense for its own render pass.
 */

/** Bucket key used for items missing a resolvable group value
 *  (owner unset when grouping by owner, no primary team when
 *  grouping by team, etc.). Rows view and Compact view both
 *  render the corresponding section under a "sink to the end"
 *  header — see `compareGroupBySortKey`. */
export const UNASSIGNED_GROUP_KEY = "__unassigned";
/** Sort weight applied to the Unassigned bucket. `MAX_SAFE_INTEGER`
 *  guarantees the unassigned section renders after every
 *  well-formed group, regardless of the groupBy dimension's own
 *  `order` scale. */
export const UNASSIGNED_GROUP_SORT = Number.MAX_SAFE_INTEGER;

/**
 * Resolved group placement for one project under the current
 * `groupBy` dimension.
 *
 * `sortKey` is present when the groupBy dimension carries a
 * canonical numeric order (swim_lane.order, team.order, kpi.order).
 * Absent when the grouping is label-only (owner, tag) — the sort
 * comparator falls back to alphabetical label order for those.
 *
 * `color` is optional and only populated by groupings whose
 * entities have a canonical color that should surface on the
 * group header (currently only KPI). Other groupings render
 * label-only headers.
 */
export type ProjectGroupInfo = {
  key: string;
  label: string;
  sortKey?: number;
  color?: string;
};

/**
 * Resolve which group `project` belongs to under `groupBy`. Mirrors
 * the routing that `GanttTimeline.groupTreeRows` uses:
 *
 *   * owner       → owner_id (or "Unassigned")
 *   * swim_lane   → swim_lane_id (or "Unassigned"), sortKey = lane.order
 *   * team        → teams[0] (primary), sortKey = team.order (or "Unassigned")
 *   * tag         → tags[0] (primary), labeled "#<tag>" (or "No tag")
 *   * kpi         → kpis[0] (primary), sortKey = kpi.order,
 *                   color = kpi.color (or "(no KPI)")
 *   * none        → { key: "all", label: "" } — callers that pass
 *                   `"none"` are expected to route everything into
 *                   a single header-less section themselves.
 *
 * Multi-value dimensions (team, kpi) route each project to a
 * SINGLE bucket keyed on the primary value — PMs rank the teams /
 * KPIs on the project detail panel and the first entry is the
 * authoritative "this is where the item lives on the roadmap"
 * pick. Same convention Rows view has used since day one; Compact
 * inherits it via this helper.
 */
export function resolveProjectGroup(
  project: Project,
  groupBy: GroupBy,
  ctx: {
    users: User[];
    lanes: SwimLane[];
    teams: Team[];
    kpis: Kpi[];
  },
): ProjectGroupInfo {
  const { users, lanes, teams, kpis } = ctx;
  if (groupBy === "owner") {
    const u = users.find((x) => x.id === project.owner_id);
    return {
      key: u?.id ?? UNASSIGNED_GROUP_KEY,
      label: u?.name ?? "Unassigned",
    };
  }
  if (groupBy === "swim_lane") {
    const l = lanes.find((x) => x.id === project.swim_lane_id);
    return {
      key: l?.id ?? UNASSIGNED_GROUP_KEY,
      label: l?.name ?? "Unassigned",
      sortKey: l?.order,
    };
  }
  if (groupBy === "team") {
    const primaryId = project.teams[0] ?? null;
    const primary = primaryId ? teams.find((x) => x.id === primaryId) : undefined;
    if (primary) {
      return { key: primary.id, label: primary.name, sortKey: primary.order };
    }
    return { key: UNASSIGNED_GROUP_KEY, label: "Unassigned" };
  }
  if (groupBy === "tag") {
    const primary = project.tags[0] ?? null;
    return {
      key: primary ?? UNASSIGNED_GROUP_KEY,
      label: primary ? `#${primary}` : "No tag",
    };
  }
  if (groupBy === "kpi") {
    // Unknown KPI ids (deleted since the project was last saved)
    // fall through to the "(no KPI)" bucket rather than silently
    // promoting a secondary KPI — that promotion would be
    // invisible to the PM and hard to debug. Matches the Rows
    // view's inline routing.
    const primaryKpiId = (project.kpis ?? [])[0] ?? null;
    const primary = primaryKpiId ? kpis.find((x) => x.id === primaryKpiId) : undefined;
    if (primary) {
      return {
        key: primary.id,
        label: primary.name,
        sortKey: primary.order,
        color: primary.color,
      };
    }
    return { key: UNASSIGNED_GROUP_KEY, label: "(no KPI)" };
  }
  // groupBy === "none"
  return { key: "all", label: "" };
}

/**
 * Deterministic order for the group headers rendered above each
 * bucket. Groups with an explicit `sortKey` come first, sorted
 * ascending by that key (swim_lane.order, team.order, kpi.order —
 * lower value = higher priority, matching the drag-order the
 * admin sets in each entity's admin table). Groups without a
 * `sortKey` fall back to alphabetical label order (owner, tag).
 * The `__unassigned` bucket always sinks to the very end via
 * `UNASSIGNED_GROUP_SORT`.
 *
 * Mirrors the inline comparator inside `GanttTimeline.groupTreeRows`
 * so Rows and Compact stack their group headers in bit-identical
 * order for any (groupBy, workspace) pair.
 *
 * `pinnedKeys` (optional): group keys that should sort BEFORE every
 * non-pinned group, in the exact order they appear in the array.
 * Currently used by the Roadmap page to float the currently-filtered
 * team(s) to the top of the section list when Group by = Team —
 * PMs opening the roadmap already know which team they care about,
 * so surfacing that team's swim of bars first saves a scroll. Keys
 * not present in the pinned list retain their normal sortKey /
 * label ordering. Pinning is a no-op when the array is missing /
 * empty; when only one of the compared groups is pinned it always
 * wins. Unknown pinned keys (a filter targeting an entity with no
 * projects, so no matching group exists) are silently ignored —
 * `indexOf` returns -1 for both sides and the comparator falls
 * through to its default rules.
 *
 * Unassigned handling: `pinnedKeys` in practice only contains real
 * entity ids (team ids, etc.), never `__unassigned`, so the
 * "unassigned sinks last" fallback below still owns the unassigned
 * bucket's placement. The pin check runs first but is by
 * construction inert for the unassigned key.
 */
export function compareGroupBySortKey(
  a: { key: string; label: string; sortKey?: number },
  b: { key: string; label: string; sortKey?: number },
  pinnedKeys?: string[],
): number {
  if (pinnedKeys && pinnedKeys.length > 0) {
    const ai = pinnedKeys.indexOf(a.key);
    const bi = pinnedKeys.indexOf(b.key);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
  }
  const aw = a.key === UNASSIGNED_GROUP_KEY ? UNASSIGNED_GROUP_SORT : a.sortKey;
  const bw = b.key === UNASSIGNED_GROUP_KEY ? UNASSIGNED_GROUP_SORT : b.sortKey;
  if (aw !== undefined && bw !== undefined) return aw - bw;
  if (aw !== undefined) return -1;
  if (bw !== undefined) return 1;
  return a.label.localeCompare(b.label);
}
