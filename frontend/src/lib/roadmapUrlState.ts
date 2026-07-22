import {
  emptyFilters,
  type ColorBy,
  type FilterState,
  type GroupBy,
  type RoadmapSort,
} from "./viewState";
import type { Zoom } from "./roadmapViewport";

/**
 * Shareable-URL contract for the Roadmap view.
 *
 * Every user-tweakable knob on the Roadmap surface that changes what
 * gets rendered gets mirrored into `?...` on `/roadmap`, so Alice can
 * copy her URL, send it to Bob, and Bob (after signing in) lands on
 * the exact same view. All params are OPTIONAL and are OMITTED when
 * the value equals the store default; a bare `/roadmap` therefore
 * encodes the "everything default" view. Unknown / malformed values
 * are silently ignored so a stale bookmark can't wedge the page.
 *
 * URL parameter reference (all optional):
 *
 *   Timeframe / layout:
 *     zoom      "3mo" | "6mo" | "1yr" | "all" | "quarters"    (default "6mo")
 *     group     "none" | "owner" | "swim_lane" | "team" | "tag" | "kpi"  (default "team")
 *     color     "swim_lane" | "team" | "owner"                (default "swim_lane")
 *     sort      "startDate" | "priority"                      (default "startDate")
 *
 *   Boolean toggles (encoded ONLY when non-default, always as "1"):
 *     hideConflicts=1     Show-conflicts is default ON — encode when OFF.
 *     keyStrategic=1      Key-strategic-only is default OFF — encode when ON.
 *
 *   Multi-select filters (comma-joined ids; empty ⇒ param omitted):
 *     owners, teams, lanes, tags
 *
 *   Free-text / date filters (omitted when empty / null):
 *     q          Search string.
 *     dateFrom   YYYY-MM-DD.
 *     dateTo     YYYY-MM-DD.
 *
 * Example (Alice's filtered 1-year owner-grouped view):
 *   /roadmap?zoom=1yr&group=owner&teams=t1,t2&q=deploy&keyStrategic=1
 *
 * Kept intentionally standalone (no React / router imports) so the
 * helpers can be unit-tested in isolation and reused if the roadmap
 * ever grows a second entry point (e.g. an embedded modal preview).
 */

const DEFAULT_ZOOM: Zoom = "6mo";
const DEFAULT_GROUP: GroupBy = "team";
const DEFAULT_COLOR: ColorBy = "swim_lane";
const DEFAULT_SORT: RoadmapSort = "startDate";
const DEFAULT_SHOW_CONFLICTS = true;

const VALID_ZOOMS: readonly Zoom[] = ["3mo", "6mo", "1yr", "all", "quarters"] as const;
const VALID_GROUPS: readonly GroupBy[] = [
  "none",
  "owner",
  "swim_lane",
  "team",
  "tag",
  "kpi",
] as const;
const VALID_COLORS: readonly ColorBy[] = ["swim_lane", "team", "owner"] as const;
const VALID_SORTS: readonly RoadmapSort[] = ["startDate", "priority"] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Snapshot of every roadmap-affecting slice the URL mirrors. Callers
 * assemble this from the view store before encoding; a decode
 * produces a partial version (see `RoadmapUrlDecoded`) so absent
 * params can be distinguished from present-but-default.
 */
export type RoadmapUrlState = {
  filters: FilterState;
  colorBy: ColorBy;
  groupBy: GroupBy;
  roadmapSort: RoadmapSort;
  showConflicts: boolean;
  roadmapTimeframe: Zoom;
};

/**
 * Decoded URL payload. Top-level scalar fields are `undefined` when
 * the URL didn't carry a valid value; `filters` is ALWAYS provided
 * (built on top of `emptyFilters`) because the URL is authoritative
 * over the whole filter slice when any roadmap param is present —
 * missing filter params mean "cleared", not "keep persisted."
 */
export type RoadmapUrlDecoded = {
  filters: FilterState;
  colorBy?: ColorBy;
  groupBy?: GroupBy;
  roadmapSort?: RoadmapSort;
  showConflicts?: boolean;
  roadmapTimeframe?: Zoom;
};

/**
 * Every param name this module owns. Kept as a single source of
 * truth so the "any roadmap param present?" probe stays in lockstep
 * with the encoder / decoder.
 */
export const ROADMAP_URL_PARAM_KEYS = [
  "zoom",
  "group",
  "color",
  "sort",
  "hideConflicts",
  "owners",
  "teams",
  "lanes",
  "tags",
  "dateFrom",
  "dateTo",
  "q",
  "keyStrategic",
] as const;

function isZoom(v: string): v is Zoom {
  return (VALID_ZOOMS as readonly string[]).includes(v);
}
function isGroupBy(v: string): v is GroupBy {
  return (VALID_GROUPS as readonly string[]).includes(v);
}
function isColorBy(v: string): v is ColorBy {
  return (VALID_COLORS as readonly string[]).includes(v);
}
function isRoadmapSort(v: string): v is RoadmapSort {
  return (VALID_SORTS as readonly string[]).includes(v);
}

function splitCsv(v: string | null): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v.split(",")) {
    const s = raw.trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * True when at least one roadmap-owned param is present in the
 * given search string. Drives the mount-time "URL wins vs.
 * persist wins" decision inside RoadmapView.
 */
export function hasAnyRoadmapUrlParam(params: URLSearchParams): boolean {
  for (const key of ROADMAP_URL_PARAM_KEYS) {
    if (params.has(key)) return true;
  }
  return false;
}

/**
 * Serialize the roadmap slice to URL params, omitting any field
 * that matches the store default (and every empty multi-select /
 * empty string). The returned `URLSearchParams` is ready to hand
 * to `.toString()` for a query string, or to iterate over.
 */
export function encodeRoadmapState(state: RoadmapUrlState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.roadmapTimeframe !== DEFAULT_ZOOM) p.set("zoom", state.roadmapTimeframe);
  if (state.groupBy !== DEFAULT_GROUP) p.set("group", state.groupBy);
  if (state.colorBy !== DEFAULT_COLOR) p.set("color", state.colorBy);
  if (state.roadmapSort !== DEFAULT_SORT) p.set("sort", state.roadmapSort);
  if (state.showConflicts !== DEFAULT_SHOW_CONFLICTS) p.set("hideConflicts", "1");
  const f = state.filters;
  if (f.ownerIds.length) p.set("owners", f.ownerIds.join(","));
  if (f.teamIds.length) p.set("teams", f.teamIds.join(","));
  if (f.swimLaneIds.length) p.set("lanes", f.swimLaneIds.join(","));
  if (f.tags.length) p.set("tags", f.tags.join(","));
  if (f.dateFrom) p.set("dateFrom", f.dateFrom);
  if (f.dateTo) p.set("dateTo", f.dateTo);
  const search = f.search.trim();
  if (search) p.set("q", f.search);
  if (f.keyStrategicOnly) p.set("keyStrategic", "1");
  return p;
}

/**
 * Parse the given URL params into a hydration payload. Only known
 * keys with valid values contribute — everything else is dropped
 * silently so a mangled `?zoom=banana` or `?dateFrom=yesterday`
 * degrades to "no override" rather than throwing or wedging state.
 *
 * `filters` is always returned (built on `emptyFilters`). Callers
 * hydrating the store should treat the returned object as
 * authoritative over the roadmap slice: absent filter params mean
 * "cleared", not "keep whatever was persisted."
 */
export function decodeRoadmapState(params: URLSearchParams): RoadmapUrlDecoded {
  const filters: FilterState = { ...emptyFilters };
  const out: RoadmapUrlDecoded = { filters };

  const zoom = params.get("zoom");
  if (zoom && isZoom(zoom)) out.roadmapTimeframe = zoom;

  const group = params.get("group");
  if (group && isGroupBy(group)) out.groupBy = group;

  const color = params.get("color");
  if (color && isColorBy(color)) out.colorBy = color;

  const sort = params.get("sort");
  if (sort && isRoadmapSort(sort)) out.roadmapSort = sort;

  if (params.get("hideConflicts") === "1") out.showConflicts = false;

  const owners = splitCsv(params.get("owners"));
  if (owners.length) filters.ownerIds = owners;

  const teams = splitCsv(params.get("teams"));
  if (teams.length) filters.teamIds = teams;

  const lanes = splitCsv(params.get("lanes"));
  if (lanes.length) filters.swimLaneIds = lanes;

  const tags = splitCsv(params.get("tags"));
  if (tags.length) filters.tags = tags;

  const dateFrom = params.get("dateFrom");
  if (dateFrom && ISO_DATE_RE.test(dateFrom)) filters.dateFrom = dateFrom;

  const dateTo = params.get("dateTo");
  if (dateTo && ISO_DATE_RE.test(dateTo)) filters.dateTo = dateTo;

  const q = params.get("q");
  if (q) filters.search = q;

  if (params.get("keyStrategic") === "1") filters.keyStrategicOnly = true;

  return out;
}
