import { computePhases } from "./phaseCompute";
import { laneEndOn, laneStartOn } from "./dependencies";
import type { PhaseDateKey, Project, SwimLane, Team, User } from "./types";

/**
 * Automated roadmap scheduler.
 *
 * INPUT: a batch of scheduled projects (all four phase dates set)
 * chosen by the PM plus lane/user/team metadata for constraint
 * lookups. Every batch item is either LOCKED (dates unchanged) or
 * UNLOCKED (algorithm may shift the whole span forward or backward,
 * preserving every internal phase duration and gap).
 *
 * OUTPUT: one proposal per batch item with the proposed dates, a
 * diff flag, and any residual warnings the algorithm couldn't
 * eliminate.
 *
 * SHIFT SEMANTICS (product decision, confirmed with the PM before
 * writing this file): unlocked items shift as a UNIT — every phase
 * moves by the same integer-day delta, so discovery / dev / opt
 * durations AND the awaiting-dev / awaiting-opt gaps between them
 * are all preserved. This matches "the Sep 1–14 dev phase can move
 * to Sep 15–29" from the spec and keeps the mental model simple.
 *
 * EARLIEST START (also confirmed with the PM): no item may be
 * scheduled to start before TODAY. Items whose current start_date
 * is already in the past can only be delayed further — the
 * scheduler will never rewrite history.
 *
 * PRIORITY: swim lane order ASC, then position within lane ASC.
 * Earlier == higher priority (placed first, gets the best slot).
 *
 * ORDERING: topological sort on intra-batch dependencies (upstream
 * before downstream) with priority breaking ties. Deps on items
 * outside the batch use those items' current dates as fixed
 * lower-bound constraints. Dependency cycles are detected and the
 * cycle members are appended at the end in priority order (the
 * algorithm can't satisfy an impossible constraint, so we give up
 * gracefully and let the user see the resulting warnings).
 *
 * CONSTRAINT HANDLING per unlocked item:
 *   1. Hard: dep upstream ends. Algorithm always respects these —
 *      the earliest valid offset is the max of dep-derived lower
 *      bounds and today.
 *   2. Soft: hard deadlines. Algorithm prefers offsets that
 *      satisfy deadlines but falls back to the earliest offset
 *      if none in the search window does.
 *   3. Soft: owner + team capacity. Same treatment — searched
 *      first, warned if impossible.
 *
 * SEARCH: linear scan of offsets, day by day, starting at the
 * dep-derived floor and going forward up to SEARCH_WINDOW_DAYS
 * (365). First offset with zero soft violations wins; else the
 * earliest offset with the fewest violations wins.
 */

export type SchedulerInputItem = {
  project: Project;
  locked: boolean;
};

export type SchedulerInput = {
  items: SchedulerInputItem[];
  /** ALL projects in the workspace — used to seed capacity load
   *  from projects NOT in the batch and to look up out-of-batch
   *  dependency upstreams. Batch items are subtracted before
   *  scheduling starts and re-added at their proposed positions. */
  allProjects: Project[];
  lanes: SwimLane[];
  users: User[];
  teams: Team[];
  today: Date;
};

/** ISO date fields the scheduler reads and writes. */
export type PhaseDates = {
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
};

export type CapacityWarning = {
  kind: "owner" | "team";
  entityId: string;
  entityName: string;
  cap: number;
  peak: number;
  /** ISO YYYY-MM-DD range where the overload persists (inclusive). */
  from: string;
  to: string;
};

export type ItemProposal = {
  projectId: string;
  title: string;
  locked: boolean;
  /** Offset applied to every phase date, in days. Zero for locked
   *  items and for unlocked items that were already optimal. */
  offsetDays: number;
  originalDates: PhaseDates;
  proposedDates: PhaseDates;
  changed: boolean;
  /** Human-readable summaries of residual issues after placement. */
  deadlineViolations: string[];
  dependencyViolations: string[];
  capacityWarnings: CapacityWarning[];
};

export type SchedulerResult = {
  proposals: ItemProposal[];
  /** True iff no proposal has any warning of any kind. */
  clean: boolean;
};

const SEARCH_WINDOW_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* --- Date helpers (timezone-free, YYYY-MM-DD in / out) --- */

function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return dateToIso(d);
}

function diffDaysIso(a: string, b: string): number {
  return Math.round((isoToDate(a).getTime() - isoToDate(b).getTime()) / MS_PER_DAY);
}

function todayIso(today: Date): string {
  return dateToIso(today);
}

/* --- Extraction / application of phase dates --- */

function extractDates(p: Project): PhaseDates {
  return {
    start_date: p.start_date,
    target_date: p.target_date,
    dev_start_date: p.dev_start_date,
    dev_end_date: p.dev_end_date,
    optimization_start_date: p.optimization_start_date,
    optimization_end_date: p.optimization_end_date,
  };
}

/**
 * Apply an integer day offset to every non-null phase date. Null
 * dates stay null (should never happen for scheduler-eligible
 * items — they're required to have all four core dates — but we
 * defend against a partially-populated draft anyway).
 */
function shiftDates(d: PhaseDates, days: number): PhaseDates {
  const shift = (v: string | null): string | null => (v ? addDaysIso(v, days) : null);
  return {
    start_date: shift(d.start_date),
    target_date: shift(d.target_date),
    dev_start_date: shift(d.dev_start_date),
    dev_end_date: shift(d.dev_end_date),
    optimization_start_date: shift(d.optimization_start_date),
    optimization_end_date: shift(d.optimization_end_date),
  };
}

/**
 * Overall span [start_date, optimization_end_date] under a
 * proposed offset — same rule the capacity module uses (only these
 * two anchors matter; dev / opt anchors fall between them). Only
 * defined for eligible items.
 */
function overallSpan(base: PhaseDates, offsetDays: number): { start: string; end: string } {
  return {
    start: addDaysIso(base.start_date!, offsetDays),
    end: addDaysIso(base.optimization_end_date!, offsetDays),
  };
}

/* --- Capacity load map --- */

/**
 * Sparse per-day counter keyed by entity id (owner or team). We
 * increment for every day covered by every project spanning that
 * entity, then query "peak in [from, to]" during scheduling.
 */
type LoadMap = Map<string, Map<string, number>>;

function bumpLoad(load: LoadMap, entityId: string, from: string, to: string, delta: number) {
  let inner = load.get(entityId);
  if (!inner) {
    inner = new Map();
    load.set(entityId, inner);
  }
  let cursor = from;
  while (cursor <= to) {
    inner.set(cursor, (inner.get(cursor) ?? 0) + delta);
    cursor = addDaysIso(cursor, 1);
  }
}

/**
 * Walk [from, to] and record every day where the load would
 * exceed `cap` if this project were placed. Used to build the
 * ranges shown in the residual capacity warnings.
 */
function overloadRange(
  load: LoadMap,
  entityId: string,
  from: string,
  to: string,
  cap: number,
): { from: string; to: string; peak: number } | null {
  const inner = load.get(entityId);
  if (!inner) return null;
  let first: string | null = null;
  let last: string | null = null;
  let peak = 0;
  let cursor = from;
  while (cursor <= to) {
    const projected = (inner.get(cursor) ?? 0) + 1;
    if (projected > cap) {
      if (first == null) first = cursor;
      last = cursor;
      if (projected > peak) peak = projected;
    }
    cursor = addDaysIso(cursor, 1);
  }
  if (first == null || last == null) return null;
  return { from: first, to: last, peak };
}

/* --- Root-project counting rule (mirrors capacity.ts) --- */

function countsForCapacity(p: Project): boolean {
  if (p.deleted_at) return false;
  if (!p.start_date || !p.optimization_end_date) return false;
  if (p.parent_id) return false;
  return true;
}

/* --- Warning label helpers --- */

function fieldLabel(key: PhaseDateKey | null): string {
  if (!key) return "phase";
  switch (key) {
    case "target_date": return "discovery end";
    case "dev_start_date": return "dev start";
    case "dev_end_date": return "dev end";
    case "optimization_start_date": return "optimization start";
    case "optimization_end_date": return "optimization end";
  }
}

/* --- Main entry point --- */

export function scheduleRoadmap(input: SchedulerInput): SchedulerResult {
  const { items, allProjects, lanes, users, teams, today } = input;

  const todayStr = todayIso(today);
  const lanesById = new Map(lanes.map((l) => [l.id, l] as const));
  const usersById = new Map(users.map((u) => [u.id, u] as const));
  const teamsById = new Map(teams.map((t) => [t.id, t] as const));
  const projectsById = new Map(allProjects.map((p) => [p.id, p] as const));

  const batchIds = new Set(items.map((it) => it.project.id));

  // 1. Seed capacity load from every root, scheduled, non-batch
  //    project. Batch projects will be added as we place them.
  const load: LoadMap = new Map();
  for (const p of allProjects) {
    if (batchIds.has(p.id)) continue;
    if (!countsForCapacity(p)) continue;
    const span = { start: p.start_date!, end: p.optimization_end_date! };
    if (p.owner_id) bumpLoad(load, p.owner_id, span.start, span.end, +1);
    for (const tid of p.teams ?? []) bumpLoad(load, tid, span.start, span.end, +1);
  }

  // 2. Topological sort within the batch. Nodes are batch ids; a
  //    directed edge upstream -> downstream means downstream depends
  //    on upstream. We process in Kahn order, breaking ties by
  //    priority (swim lane order, then position). Cycle members
  //    (rare) fall out at the end, sorted by priority alone.
  const priority = (p: Project): [number, number] => {
    const lane = p.swim_lane_id ? lanesById.get(p.swim_lane_id) : null;
    return [lane?.order ?? Number.MAX_SAFE_INTEGER, p.position ?? Number.MAX_SAFE_INTEGER];
  };
  const cmpPriority = (a: Project, b: Project): number => {
    const [al, ap] = priority(a);
    const [bl, bp] = priority(b);
    if (al !== bl) return al - bl;
    return ap - bp;
  };

  const inDegree = new Map<string, number>();
  const successors = new Map<string, Set<string>>();
  for (const it of items) inDegree.set(it.project.id, 0);
  for (const it of items) {
    for (const dep of it.project.dependencies ?? []) {
      // Only in-batch edges affect ordering — out-of-batch upstreams
      // are treated as fixed constraints later.
      if (!batchIds.has(dep.depends_on_project_id)) continue;
      if (dep.depends_on_project_id === it.project.id) continue;
      const succs = successors.get(dep.depends_on_project_id) ?? new Set();
      if (!succs.has(it.project.id)) {
        succs.add(it.project.id);
        successors.set(dep.depends_on_project_id, succs);
        inDegree.set(it.project.id, (inDegree.get(it.project.id) ?? 0) + 1);
      }
    }
  }
  const itemsById = new Map(items.map((it) => [it.project.id, it] as const));
  const ready: Project[] = items
    .filter((it) => (inDegree.get(it.project.id) ?? 0) === 0)
    .map((it) => it.project);
  ready.sort(cmpPriority);
  const order: string[] = [];
  const visited = new Set<string>();
  while (ready.length) {
    const p = ready.shift()!;
    if (visited.has(p.id)) continue;
    visited.add(p.id);
    order.push(p.id);
    const succs = successors.get(p.id);
    if (!succs) continue;
    for (const sid of succs) {
      const remaining = (inDegree.get(sid) ?? 1) - 1;
      inDegree.set(sid, remaining);
      if (remaining === 0) {
        const succProj = itemsById.get(sid)?.project;
        if (!succProj) continue;
        // Insert while preserving priority order.
        let i = 0;
        while (i < ready.length && cmpPriority(ready[i]!, succProj) < 0) i++;
        ready.splice(i, 0, succProj);
      }
    }
  }
  // Cycle survivors — append in priority order so the algorithm at
  // least tries to place them (the cyclic dep will show up as a
  // warning on whichever member is placed second).
  const remaining = items
    .filter((it) => !visited.has(it.project.id))
    .map((it) => it.project);
  remaining.sort(cmpPriority);
  for (const p of remaining) order.push(p.id);

  // 3. Place each item in order.
  const placedDates = new Map<string, PhaseDates>();
  const proposals: ItemProposal[] = [];

  // Add a project's proposed span to the running load map.
  const addToLoad = (p: Project, dates: PhaseDates) => {
    if (!countsForCapacity({ ...p, ...dates })) return;
    const span = { start: dates.start_date!, end: dates.optimization_end_date! };
    if (p.owner_id) bumpLoad(load, p.owner_id, span.start, span.end, +1);
    for (const tid of p.teams ?? []) bumpLoad(load, tid, span.start, span.end, +1);
  };

  for (const id of order) {
    const it = itemsById.get(id);
    if (!it) continue;
    const p = it.project;
    const original = extractDates(p);

    if (it.locked) {
      placedDates.set(p.id, original);
      addToLoad(p, original);
      proposals.push({
        projectId: p.id,
        title: p.title,
        locked: true,
        offsetDays: 0,
        originalDates: original,
        proposedDates: original,
        changed: false,
        deadlineViolations: [],
        dependencyViolations: [],
        capacityWarnings: [],
      });
      continue;
    }

    // Compute dep-derived lower bounds. Each dep says: THIS lane's
    // phase START must be >= the upstream lane's phase END. Under
    // unit-shift, phase_start_new = phase_start_original + offset,
    // so the constraint becomes offset >= depDate - phase_start_original.
    // The "phase start" here is what `laneStartOn` returns — NOT
    // the phase_date_key field directly (which might name the phase
    // END for lanes like "In Dev" bound to dev_end_date).
    let depFloorOffset = 0;
    for (const dep of p.dependencies ?? []) {
      const thisLane = lanesById.get(dep.project_swim_lane_id) ?? null;
      const otherLane = lanesById.get(dep.depends_on_swim_lane_id) ?? null;
      const otherProj = projectsById.get(dep.depends_on_project_id);
      if (!otherProj) continue;
      // Use the upstream's placed dates if we already scheduled it
      // in this batch; otherwise fall back to its current dates.
      const placed = placedDates.get(dep.depends_on_project_id);
      const upstreamForRead: Project = placed
        ? { ...otherProj, ...placed }
        : otherProj;
      const upstreamEndDate = laneEndOn(upstreamForRead, otherLane);
      const thisStartDate = laneStartOn(p, thisLane);
      if (!upstreamEndDate || !thisStartDate) continue;
      const needed = diffDaysIso(
        dateToIso(upstreamEndDate),
        dateToIso(thisStartDate),
      );
      if (needed > depFloorOffset) depFloorOffset = needed;
    }

    // Enforce today floor on start_date.
    const startFloorOffset = diffDaysIso(todayStr, original.start_date!);
    // Also allow going backward if deps + today permit (algorithm
    // may pull an item earlier than its current date to fit better
    // ahead of higher-priority items). Overall lower bound:
    let floorOffset = Math.max(startFloorOffset, depFloorOffset);
    // If the item's current start_date is in the past AND deps
    // don't push us forward, we still can't schedule before today.
    // startFloorOffset handles that.

    const evaluate = (offsetDays: number): {
      deadlineHits: number;
      capacityHits: number;
    } => {
      const dates = shiftDates(original, offsetDays);
      // Deadlines: violated iff phase date > deadline_date.
      let deadlineHits = 0;
      for (const d of p.deadlines ?? []) {
        const lane = lanesById.get(d.swim_lane_id);
        const phaseKey = lane?.phase_date_key ?? null;
        if (!phaseKey) continue;
        const phaseDate = dates[phaseKey];
        if (phaseDate && phaseDate > d.deadline_date) deadlineHits++;
      }
      // Capacity: only root scheduled items count.
      let capacityHits = 0;
      if (countsForCapacity({ ...p, ...dates })) {
        const span = overallSpan(original, offsetDays);
        if (p.owner_id) {
          const u = usersById.get(p.owner_id);
          if (u?.capacity != null) {
            const ov = overloadRange(load, p.owner_id, span.start, span.end, u.capacity);
            if (ov) capacityHits++;
          }
        }
        for (const tid of p.teams ?? []) {
          const t = teamsById.get(tid);
          if (t?.capacity != null) {
            const ov = overloadRange(load, tid, span.start, span.end, t.capacity);
            if (ov) capacityHits++;
          }
        }
      }
      return { deadlineHits, capacityHits };
    };

    // Linear scan starting at the dep+today floor, going forward
    // one day at a time. First "0 hits" offset wins; else remember
    // the offset with the fewest total hits.
    let bestOffset = floorOffset;
    let bestScore = evaluate(bestOffset);
    let bestHits = bestScore.deadlineHits + bestScore.capacityHits;
    if (bestHits > 0) {
      for (let step = 1; step <= SEARCH_WINDOW_DAYS; step++) {
        const trial = floorOffset + step;
        const score = evaluate(trial);
        const hits = score.deadlineHits + score.capacityHits;
        if (hits === 0) {
          bestOffset = trial;
          bestScore = score;
          bestHits = 0;
          break;
        }
        // Prefer strictly fewer hits; ties go to the earlier offset
        // we already have.
        if (hits < bestHits) {
          bestOffset = trial;
          bestScore = score;
          bestHits = hits;
        }
      }
    }

    const proposedDates = shiftDates(original, bestOffset);

    // Recompute the human-readable warnings at the winning offset.
    const deadlineViolations: string[] = [];
    for (const d of p.deadlines ?? []) {
      const lane = lanesById.get(d.swim_lane_id);
      const phaseKey = lane?.phase_date_key ?? null;
      if (!phaseKey) continue;
      const phaseDate = proposedDates[phaseKey];
      if (phaseDate && phaseDate > d.deadline_date) {
        deadlineViolations.push(
          `${fieldLabel(phaseKey)} (${phaseDate}) misses deadline ${d.deadline_date}${d.note ? ` — ${d.note}` : ""}`,
        );
      }
    }

    // Dep violations at the winning offset (should generally be
    // zero since deps set the floor, but a cycle survivor may show
    // one here). Uses the same phase-start / phase-end semantics as
    // lib/dependencies.ts — this lane's phase START must be >= the
    // upstream lane's phase END.
    const dependencyViolations: string[] = [];
    for (const dep of p.dependencies ?? []) {
      const thisLane = lanesById.get(dep.project_swim_lane_id) ?? null;
      const otherLane = lanesById.get(dep.depends_on_swim_lane_id) ?? null;
      const otherProj = projectsById.get(dep.depends_on_project_id);
      if (!otherProj) continue;
      const placed = placedDates.get(dep.depends_on_project_id);
      const upstreamShifted: Project = placed
        ? { ...otherProj, ...placed }
        : otherProj;
      const upstreamEndDate = laneEndOn(upstreamShifted, otherLane);
      const thisShifted: Project = { ...p, ...proposedDates };
      const thisStartDate = laneStartOn(thisShifted, thisLane);
      if (!upstreamEndDate || !thisStartDate) continue;
      if (thisStartDate.getTime() < upstreamEndDate.getTime()) {
        const upstreamTitle = otherProj.title;
        dependencyViolations.push(
          `${thisLane?.name ?? "phase"} start (${dateToIso(thisStartDate)}) begins before ${upstreamTitle} finishes ${otherLane?.name ?? "its phase"} (${dateToIso(upstreamEndDate)})`,
        );
      }
    }

    // Capacity warnings at the winning offset — compute BEFORE
    // adding this project to `load` so peak-with-us math is
    // meaningful.
    const capacityWarnings: CapacityWarning[] = [];
    if (countsForCapacity({ ...p, ...proposedDates })) {
      const span = overallSpan(original, bestOffset);
      if (p.owner_id) {
        const u = usersById.get(p.owner_id);
        if (u?.capacity != null) {
          const ov = overloadRange(load, p.owner_id, span.start, span.end, u.capacity);
          if (ov) {
            capacityWarnings.push({
              kind: "owner",
              entityId: p.owner_id,
              entityName: u.name,
              cap: u.capacity,
              peak: ov.peak,
              from: ov.from,
              to: ov.to,
            });
          }
        }
      }
      for (const tid of p.teams ?? []) {
        const t = teamsById.get(tid);
        if (t?.capacity != null) {
          const ov = overloadRange(load, tid, span.start, span.end, t.capacity);
          if (ov) {
            capacityWarnings.push({
              kind: "team",
              entityId: tid,
              entityName: t.name,
              cap: t.capacity,
              peak: ov.peak,
              from: ov.from,
              to: ov.to,
            });
          }
        }
      }
    }

    placedDates.set(p.id, proposedDates);
    addToLoad(p, proposedDates);

    proposals.push({
      projectId: p.id,
      title: p.title,
      locked: false,
      offsetDays: bestOffset,
      originalDates: original,
      proposedDates,
      changed: bestOffset !== 0,
      deadlineViolations,
      dependencyViolations,
      capacityWarnings,
    });
  }

  // Preserve the original items order for the UI (so users see the
  // list in the same order they picked it) rather than dep-order.
  const orderIndex = new Map(items.map((it, i) => [it.project.id, i] as const));
  proposals.sort((a, b) => (orderIndex.get(a.projectId) ?? 0) - (orderIndex.get(b.projectId) ?? 0));

  const clean = proposals.every(
    (p) =>
      p.deadlineViolations.length === 0 &&
      p.dependencyViolations.length === 0 &&
      p.capacityWarnings.length === 0,
  );

  return { proposals, clean };
}

/**
 * True for items the scheduler is willing to consider. Mirrors the
 * "would show on roadmap" rule the PM described in the spec.
 */
export function isSchedulable(project: Project, lanesById: Map<string, SwimLane>): boolean {
  if (project.deleted_at) return false;
  if (!computePhases(project).scheduled) return false;
  const lane = project.swim_lane_id ? lanesById.get(project.swim_lane_id) : null;
  if (lane?.is_terminal || lane?.is_archive) return false;
  return true;
}

/** Just the phase-date fields, for building the PATCH payload. */
export function toPatchBody(dates: PhaseDates): PhaseDates {
  return {
    start_date: dates.start_date,
    target_date: dates.target_date,
    dev_start_date: dates.dev_start_date,
    dev_end_date: dates.dev_end_date,
    optimization_start_date: dates.optimization_start_date,
    optimization_end_date: dates.optimization_end_date,
  };
}
