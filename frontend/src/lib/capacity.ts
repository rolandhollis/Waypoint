import type { Project, Team, User } from "./types";

/**
 * Client-side capacity planner.
 *
 * A project counts against an entity (owner user or member team) on
 * every calendar day covered by its roadmap bar — start_date through
 * optimization_end_date, matching what the Roadmap draws. Only
 * "scheduled" projects (all four phase dates set) count.
 *
 * COUNTING RULE — only **root** projects count (`parent_id === null`,
 * which equals `type === 'epic'` today). Rationale:
 *   • The Roadmap default view shows exactly the root rows;
 *     subtasks are hidden until an epic is expanded. So counting
 *     roots matches what a PM literally sees on screen — no more
 *     "I see 4 concurrent epics but the cap says I'm fine."
 *   • Epics own the umbrella; subtasks are usually delegated
 *     implementation work whose load is tracked elsewhere. Counting
 *     the epic against its owner captures the "on-the-hook" load
 *     that matters for capacity planning.
 *   • Avoids double-counting when an epic + its subtasks all share
 *     the same owner (common) or the same team (very common).
 *
 * The result is a list of [from, to] date intervals per entity where
 * the concurrent-project count strictly exceeds the entity's cap. A
 * null cap disables checking for that entity.
 */

export type EntityKind = "owner" | "team";

export type OverloadInterval = {
  kind: EntityKind;
  entityId: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  from: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  to: string;
  /** Peak concurrent count reached during the interval. */
  peak: number;
  cap: number;
  /** Ids of projects contributing to the overload at its peak day. */
  projectIds: string[];
};

/**
 * A project's roadmap-bar span, if the project is scheduled. Matches
 * the "scheduled = has all four phase dates" rule enforced elsewhere.
 */
export function projectSpan(p: Project): { start: string; end: string } | null {
  if (!p.start_date) return null;
  // overallEnd mirrors phaseCompute.ts's rule for the bar's right edge.
  const end = p.optimization_end_date ?? p.dev_end_date ?? p.target_date;
  if (!end) return null;
  return { start: p.start_date, end };
}

/**
 * Returns true if project `p` should count against capacity — i.e.
 * it's a scheduled root (no parent). Deleted rows never count. See
 * the module-level doc-comment for the reasoning behind counting
 * roots rather than leaves or every node.
 */
export function countsForCapacity(p: Project): boolean {
  if (p.deleted_at) return false;
  if (!projectSpan(p)) return false;
  if (p.parent_id) return false;
  return true;
}

/**
 * Core sweep. For a given entity + list of scheduled bars, returns
 * the intervals where the running concurrent count exceeds `cap`.
 *
 * Uses the classic "sort events, sweep counter" technique: each bar
 * yields a +1 event on `start` and a -1 event on the day AFTER `end`,
 * so the running count on any given day includes bars that start on
 * that day and excludes bars that ended the day before. Overload
 * intervals are collected as contiguous runs of "count > cap".
 */
function sweep(
  bars: { start: string; end: string; projectId: string }[],
  cap: number,
): { from: string; to: string; peak: number; projectIds: string[] }[] {
  if (bars.length === 0) return [];

  type Ev = { day: string; delta: number; projectId: string };
  const events: Ev[] = [];
  for (const b of bars) {
    events.push({ day: b.start, delta: +1, projectId: b.projectId });
    events.push({ day: addDaysIso(b.end, 1), delta: -1, projectId: b.projectId });
  }
  // Process ALL events on the same day before evaluating, so an end
  // and a start on the same day don't double-count. Ordering within a
  // day doesn't matter for the running count once we batch-collapse.
  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const out: { from: string; to: string; peak: number; projectIds: string[] }[] = [];
  const active = new Set<string>();
  let cursor = 0;
  let count = 0;
  let overloadStart: string | null = null;
  let overloadPeak = 0;
  let overloadPeakSet = new Set<string>();

  const days: string[] = Array.from(new Set(events.map((e) => e.day))).sort();

  for (const day of days) {
    // Apply every event happening on `day` before deciding.
    while (cursor < events.length && events[cursor]!.day === day) {
      const e = events[cursor]!;
      count += e.delta;
      if (e.delta > 0) active.add(e.projectId);
      else active.delete(e.projectId);
      cursor++;
    }
    // `count` now represents the number of active bars STARTING today.
    if (count > cap) {
      if (overloadStart == null) {
        overloadStart = day;
        overloadPeak = count;
        overloadPeakSet = new Set(active);
      } else if (count > overloadPeak) {
        overloadPeak = count;
        overloadPeakSet = new Set(active);
      }
    } else if (overloadStart != null) {
      // Overload ended yesterday.
      out.push({
        from: overloadStart,
        to: addDaysIso(day, -1),
        peak: overloadPeak,
        projectIds: Array.from(overloadPeakSet),
      });
      overloadStart = null;
      overloadPeak = 0;
      overloadPeakSet = new Set();
    }
  }
  // Should never end with an open overload since we emit a -1 event
  // for every +1, but guard anyway.
  if (overloadStart != null) {
    out.push({
      from: overloadStart,
      to: overloadStart,
      peak: overloadPeak,
      projectIds: Array.from(overloadPeakSet),
    });
  }
  return out;
}

/**
 * Compute all overload intervals across all users and teams. Cheap
 * enough to re-run on every draft edit — O((users + teams) * scheduled
 * projects) which is a few tens of thousands of ops in the worst
 * realistic case.
 *
 * `overrideProject` lets callers preview a proposed change (unsaved
 * draft) by substituting a project in the list before running the
 * sweep. If `overrideProject.deleted_at` is set the row is dropped.
 */
export function computeOverloads(
  projects: Project[],
  users: User[],
  teams: Team[],
  overrideProject?: Project,
): OverloadInterval[] {
  const merged = overrideProject
    ? [
        overrideProject,
        ...projects.filter((p) => p.id !== overrideProject.id),
      ]
    : projects;

  const owningBars = new Map<string, { start: string; end: string; projectId: string }[]>();
  const teamBars = new Map<string, { start: string; end: string; projectId: string }[]>();

  for (const p of merged) {
    if (!countsForCapacity(p)) continue;
    const span = projectSpan(p)!;
    if (p.owner_id) {
      const arr = owningBars.get(p.owner_id) ?? [];
      arr.push({ ...span, projectId: p.id });
      owningBars.set(p.owner_id, arr);
    }
    for (const tid of p.teams ?? []) {
      const arr = teamBars.get(tid) ?? [];
      arr.push({ ...span, projectId: p.id });
      teamBars.set(tid, arr);
    }
  }

  const out: OverloadInterval[] = [];
  for (const u of users) {
    if (u.capacity == null) continue;
    const bars = owningBars.get(u.id) ?? [];
    for (const iv of sweep(bars, u.capacity)) {
      out.push({ kind: "owner", entityId: u.id, cap: u.capacity, ...iv });
    }
  }
  for (const t of teams) {
    if (t.capacity == null) continue;
    const bars = teamBars.get(t.id) ?? [];
    for (const iv of sweep(bars, t.capacity)) {
      out.push({ kind: "team", entityId: t.id, cap: t.capacity, ...iv });
    }
  }
  return out;
}

/**
 * Filter overloads to those touching a particular project — i.e. the
 * overload interval is on an entity this project belongs to AND the
 * interval overlaps the project's roadmap span. Used to focus the
 * "your save is causing this" warning on the current edit.
 */
export function overloadsForProject(
  all: OverloadInterval[],
  project: Project,
): OverloadInterval[] {
  const span = projectSpan(project);
  if (!span) return [];
  const teamIds = new Set(project.teams ?? []);
  return all.filter((iv) => {
    if (iv.kind === "owner" && iv.entityId !== project.owner_id) return false;
    if (iv.kind === "team" && !teamIds.has(iv.entityId)) return false;
    // Interval overlap: !(iv.to < span.start || iv.from > span.end)
    if (iv.to < span.start) return false;
    if (iv.from > span.end) return false;
    return true;
  });
}

/** ISO date arithmetic (`YYYY-MM-DD`), timezone-free. */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
