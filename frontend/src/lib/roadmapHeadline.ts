import { computePhases } from "./phaseCompute";
import type { AiHeadlineGroupPayload, AiHeadlineProjectPayload, Kpi, Project, SwimLane, Team, User } from "./types";
import type { GroupBy } from "./viewState";

/**
 * Client-side helpers for the AI Roadmap Headline feature. Two
 * concerns live here:
 *
 *   1. Building the pre-grouped `groups` payload the endpoint
 *      expects (Loyalty / Discovery / Owner: Alex / …), with
 *      team / owner / KPI ids resolved to display names.
 *   2. Deriving a stable fingerprint over the current view state
 *      so the client cache can detect a "filters changed since
 *      generated" state without a server round-trip.
 *
 * Kept out of the RoadmapHeadline component itself so both bits
 * are unit-testable in isolation and so RoadmapView can compute
 * the fingerprint inputs alongside its existing filtering.
 */

export type HeadlineGroupBy = AiHeadlineGroupPayload extends { label: string; projects: infer _P }
  ? "none" | "lane" | "team" | "owner" | "kpi" | "tag"
  : never;

/**
 * Human phase label the client uses in the prompt for each
 * project. Derived from `computePhases` + today's date so Claude
 * has a clean "what stage is this in right now?" hint without
 * needing to reason about the six raw date fields itself.
 */
export function phaseLabelForProject(project: Project, now: Date = new Date()): string {
  const phases = computePhases(project);
  if (!phases.scheduled) return "Not scheduled";
  const t = now.getTime();
  if (phases.firstStart && t < phases.firstStart.getTime()) return "Not yet started";
  if (phases.discovery && t <= phases.discovery.end.getTime()) return "Discovery";
  if (phases.awaitingDev && t <= phases.awaitingDev.end.getTime()) return "Awaiting development";
  if (phases.development && t <= phases.development.end.getTime()) return "Development";
  if (phases.awaitingOptimization && t <= phases.awaitingOptimization.end.getTime()) {
    return "Awaiting post-dev";
  }
  if (phases.optimization && t <= phases.optimization.end.getTime()) return "Post-dev";
  return "Complete";
}

/**
 * Map the client's zustand `GroupBy` union onto the wire enum the
 * backend accepts. The two aren't identical because the client's
 * label for the "swim lane" axis is `swim_lane` (matches the DB
 * column) while the wire calls it `lane` (matches the spec).
 */
export function toWireGroupBy(groupBy: GroupBy): HeadlineGroupBy {
  switch (groupBy) {
    case "swim_lane": return "lane";
    case "owner": return "owner";
    case "team": return "team";
    case "kpi": return "kpi";
    case "tag": return "tag";
    case "none":
    default:
     return "none";
  }
}

/**
 * Timeframe label from the roadmap's zoom control. Mirrors the
 * user-visible chip text so the prompt reads naturally ("in the
 * next 3 months") without asking Claude to translate an internal
 * code.
 */
export function timeframeLabelFor(zoom: "3mo" | "6mo" | "1yr" | "all" | "quarters"): string {
    switch (zoom) {
    case "3mo": return "3 months";
    case "6mo": return "6 months";
    case "1yr": return "1 year";
    case "all": return "All";
    // "quarters" surfaces a wholly different layout (RoadmapQuartersView)
    // but the AI Roadmap Headline still asks for a text label; use the
    // next-four-quarters window the view actually renders so the prompt
    // reads naturally ("in the next four quarters …").
    case "quarters": return "Next four quarters";
  }
}

/** One entry in the base project bag we feed into the grouper. */
type ProjectMaps = {
  usersById: Map<string, User>;
  teamsById: Map<string, Team>;
  kpisById: Map<string, Kpi>;
  lanesById: Map<string, SwimLane>;
};

const UNASSIGNED_KEY = "__unassigned";

function toPayload(p: Project, maps: ProjectMaps): AiHeadlineProjectPayload {
  const owner = p.owner_id ? maps.usersById.get(p.owner_id) : null;
  const teamNames = p.teams
    .map((id) => maps.teamsById.get(id)?.name)
    .filter((n): n is string => Boolean(n));
  const kpiNames = (p.kpis ?? [])
    .map((id) => maps.kpisById.get(id)?.name)
    .filter((n): n is string => Boolean(n));
  const phases = computePhases(p);
  const start = phases.firstStart
    ? phases.firstStart.toISOString().slice(0, 10)
    : p.start_date;
    const end = phases.overallEnd
    ? phases.overallEnd.toISOString().slice(0, 10)
    : p.optimization_end_date ?? p.dev_end_date ?? p.target_date;
  return {
    title: p.title,
    description: p.description ?? "",
    start: start ?? null,
    end: end ?? null,
    phase: phaseLabelForProject(p),
    teamNames,
    ownerName: owner?.name ?? null,
    kpiNames,
  };
}

/**
 * Build the pre-grouped `groups` payload the AI Roadmap Headline
 * endpoint expects. Grouping mirrors the Gantt's own
 * `groupTreeRows` semantics (team / kpi are multi-value and can
 * duplicate a project across buckets; owner / lane / tag put each
 * project in exactly one bucket).
 *
 * Callers pass the ALREADY-filtered set of visible scheduled
 * projects — this function does no phase-computation filtering
 * beyond dropping unscheduled rows (which shouldn't be in the
 * input anyway, but defends against future callers).
 */
export function computeHeadlineGroups(
  projects: Project[],
  groupBy: GroupBy,
  maps: ProjectMaps,
): AiHeadlineGroupPayload[] {
  const scheduled = projects.filter((p) => computePhases(p).scheduled);
  if (scheduled.length === 0) return [];

  if (groupBy === "none") {
    return [{
      label: "All scheduled projects",
      projects: scheduled.map((p) => toPayload(p, maps)),
    }];
  }

  const bucket = new Map<string, { label: string; sort: number; projects: Project[] }>();
  const put = (key: string, label: string, sort: number, p: Project) => {
    const cur = bucket.get(key);
    if (cur) {
      cur.projects.push(p);
    } else {
      bucket.set(key, { label, sort, projects: [p] });
    }
  };

  for (const p of scheduled) {
    if (groupBy === "owner") {
      const u = p.owner_id ? maps.usersById.get(p.owner_id) : null;
      put(u?.id ?? UNASSIGNED_KEY, u?.name ?? "Unassigned", Number.MAX_SAFE_INTEGER, p);
    } else if (groupBy === "swim_lane") {
      const l = p.swim_lane_id ? maps.lanesById.get(p.swim_lane_id) : null;
      put(l?.id ?? UNASSIGNED_KEY, l?.name ?? "Unassigned", l?.order ?? Number.MAX_SAFE_INTEGER, p);
    } else if (groupBy === "team") {
      if (p.teams.length === 0) {
        put(UNASSIGNED_KEY, "Unassigned", Number.MAX_SAFE_INTEGER, p);
        } else {
        for (const teamId of p.teams) {
          const t = maps.teamsById.get(teamId);
          if (!t) continue;
          put(t.id, t.name, t.order ?? Number.MAX_SAFE_INTEGER, p);
        }
      }
    } else if (groupBy === "tag") {
      const primary = p.tags[0] ?? null;
      put(primary ?? UNASSIGNED_KEY, primary ? `#${primary}` : "No tag", Number.MAX_SAFE_INTEGER, p);
      } else if (groupBy === "kpi") {
      const known = (p.kpis ?? [])
        .map((id) => maps.kpisById.get(id))
        .filter((k): k is Kpi => Boolean(k));
      if (known.length === 0) {
        put(UNASSIGNED_KEY, "(no KPI)", Number.MAX_SAFE_INTEGER, p);
      } else {
        for (const k of known) put(k.id, k.name, k.order ?? Number.MAX_SAFE_INTEGER, p);
      }
    }
  }

  return Array.from(bucket.entries())
    .sort((a, b) => {
      if (a[1].sort !== b[1].sort) return a[1].sort - b[1].sort;
      return a[1].label.localeCompare(b[1].label);
    })
    .map(([, v]) => ({
      label: v.label,
      projects: v.projects.map((p) => toPayload(p, maps)),
      }));
}

/**
 * Canonical shape used to derive the fingerprint. Every array is
 * pre-sorted so two views with the same content but different
 * order (e.g. filter picks made in a different sequence) hash to
 * the same fingerprint.
 */
export type HeadlineFingerprintInputs = {
  groupBy: GroupBy;
  zoom: "3mo" | "6mo" | "1yr" | "all" | "quarters";
  filters: {
    ownerIds: string[];
    teamIds: string[];
    swimLaneIds: string[];
    tags: string[];
    dateFrom: string | null;
    dateTo: string | null;
    search: string;
  };
  visibleProjectIds: string[];
};

/**
 * Deterministic canonical string for the fingerprint. Uses sorted
 * arrays and stringifies via JSON — good enough because every leaf
 * value is a scalar string / null.
 */
function canonicalizeFingerprintInputs(inputs: HeadlineFingerprintInputs): string {
  const canonical = {
    groupBy: inputs.groupBy,
    zoom: inputs.zoom,
    filters: {
      ownerIds: [...inputs.filters.ownerIds].sort(),
      teamIds: [...inputs.filters.teamIds].sort(),
      swimLaneIds: [...inputs.filters.swimLaneIds].sort(),
      tags: [...inputs.filters.tags].sort(),
      dateFrom: inputs.filters.dateFrom,
      dateTo: inputs.filters.dateTo,
      search: inputs.filters.search.trim(),
    },
    visibleProjectIds: [...inputs.visibleProjectIds].sort(),
  };
  return JSON.stringify(canonical);
}

/**
 * Deterministic SHA-256 fingerprint of the current view state.
 *
 * Uses `crypto.subtle.digest` when available (all supported
 * browsers under HTTPS + the Vite dev server on localhost) and
 * falls back to a lightweight FNV-1a-ish string hash otherwise so
 * the feature keeps working in edge environments (older iframes,
 * tests without a web crypto shim, etc.). The exact algorithm
 * doesn't leak beyond the client — the server treats
 * `fingerprint` as an opaque echo — so a fallback hash is safe.
 */
export async function computeHeadlineFingerprint(inputs: HeadlineFingerprintInputs): Promise<string> {
  const canonical = canonicalizeFingerprintInputs(inputs);
  if (typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function") {
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return fallbackHash(canonical);
}

/**
 * FNV-1a-style hash fallback used when `crypto.subtle.digest` is
 * unavailable. Produces a stable 128-bit hex string by running two
 * offset FNV-1a passes and concatenating them — the collision
 * resistance isn't cryptographically meaningful but is plenty for
 * a "did the view change?" signal.
 */
function fallbackHash(input: string): string {
  const a = fnv1a(input, 2166136261);
  const b = fnv1a(input, 1099511628211 >>> 0);
  return [a, b].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("").padStart(32, "0");
}

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
