import { serializeCsvRow } from "./csvExport";
import type { Kpi, Project, SwimLane, Team, User } from "./types";

/**
 * CSV shape for Jira Product Discovery (Polaris) import.
 *
 * JPD has no Waypoint connector. The documented path is CSV via
 * Create → Import CSV (or Settings → System → Import external data).
 * Column names below are chosen so the JPD wizard can map them:
 *
 *   Summary         → idea title (required)
 *   Description     → idea description
 *   Issue Type      → always "Idea"
 *   Assignee        → owner email (must match a Jira account to apply)
 *   Labels          → Waypoint tags (space-separated; Jira CSV convention)
 *   SHOP Pod        → Waypoint team → SHOP Pod select option (else blank).
 *                     Named "SHOP Pod" (not "Pod"/"Team") so the importer
 *                     does not auto-map onto Atlassian Teams.
 *   Brand           → always "RMN" (SHOP custom field)
 *   Start date      → start_date (Jira CSV: dd/MMM/yy h:mm a)
 *   Project target  → target_date / end date (same pattern; SHOP field name)
 *
 * Extra "Waypoint *" columns are metadata. Map them to SHOP custom
 * fields if those exist, or skip them during import.
 */

export const JPD_COLUMNS = [
  "Summary",
  "Description",
  "Issue Type",
  "Assignee",
  "Labels",
  "SHOP Pod",
  "Brand",
  "Start date",
  "Project target",
  "Waypoint ID",
  "Waypoint type",
  "Waypoint parent",
  "Waypoint swim lane",
  // Named to avoid Jira auto-mapping this column onto the Atlassian "Team"
  // field (which rejects unknown org teams with "non-existing team").
  "Waypoint team names",
  "Waypoint KPIs",
] as const;

export type JpdLookups = {
  users: User[];
  teams: Team[];
  kpis: Kpi[];
  lanes: SwimLane[];
  /** Used to resolve parent titles when the parent is not in the export set. */
  allProjects?: Project[];
};

const ISSUE_TYPE_IDEA = "Idea";
const BRAND_RMN = "RMN";

/**
 * Exact SHOP "Pod" select-option labels (production Waypoint teams).
 * Pod is only written when a Waypoint team resolves to one of these
 * (case-insensitive), using the spelling below so Jira's Map values
 * step can match existing options.
 */
export const SHOP_POD_OPTIONS = [
  "Agentic Search",
  "Core",
  "Data",
  "Extensions",
  "Loyalty",
  "MarTech",
  "Merchandising",
  "Mobile App",
  "Personalization",
  "Product Deals",
] as const;

/**
 * Waypoint team name → SHOP Pod when the labels differ.
 * Keys are lowercased Waypoint team names.
 */
const WAYPOINT_TEAM_TO_POD: Record<string, (typeof SHOP_POD_OPTIONS)[number]> = {
  // Local / legacy spellings → production SHOP Pod labels
  martech: "MarTech",
  "data eng": "Data",
};

export function projectsToJpdCsv(projects: Project[], lookups: JpdLookups): string {
  const userById = new Map(lookups.users.map((u) => [u.id, u]));
  const teamById = new Map(lookups.teams.map((t) => [t.id, t]));
  const kpiById = new Map(lookups.kpis.map((k) => [k.id, k]));
  const laneById = new Map(lookups.lanes.map((l) => [l.id, l]));
  const projectById = new Map((lookups.allProjects ?? projects).map((p) => [p.id, p]));

  const rows: string[][] = [[...JPD_COLUMNS]];
  for (const p of projects) {
    rows.push(
      JPD_COLUMNS.map((col) =>
        jpdCell(col, p, { userById, teamById, kpiById, laneById, projectById }),
      ),
    );
  }
  return rows.map(serializeCsvRow).join("\r\n") + "\r\n";
}

export function defaultJpdExportFilename(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `waypoint-jpd-${y}-${m}-${d}.csv`;
}

/**
 * Three fake ideas with no Waypoint ids. Use this to dry-run the
 * JPD importer before touching real backlog rows.
 */
export function jpdSampleCsv(): string {
  const rows: string[][] = [
    [...JPD_COLUMNS],
    [
      "JPD import smoke test A",
      "Dummy idea from Waypoint. Safe to delete after the import test.",
      ISSUE_TYPE_IDEA,
      "",
      "waypoint-test smoke",
      "Data",
      BRAND_RMN,
      "",
      "",
      "sample-a",
      "epic",
      "",
      "Backlog",
      "Data",
      "",
    ],
    [
      "JPD import smoke test B",
      "Second dummy idea. Includes a comma, and \"quotes\", to verify CSV quoting.",
      ISSUE_TYPE_IDEA,
      "",
      "waypoint-test",
      "Personalization",
      BRAND_RMN,
      "15/Oct/26 12:00 AM",
      "31/Dec/26 12:00 AM",
      "sample-b",
      "epic",
      "",
      "In progress",
      "Personalization",
      "Conversion",
    ],
    [
      "JPD import smoke test C (child-shaped)",
      "Third dummy. Waypoint parent column is informational only; JPD will import this as a standalone Idea.",
      ISSUE_TYPE_IDEA,
      "",
      "waypoint-test child",
      "Product Deals",
      BRAND_RMN,
      "",
      "",
      "sample-c",
      "subtask",
      "JPD import smoke test A",
      "Backlog",
      "Product Deals",
      "",
    ],
  ];
  return rows.map(serializeCsvRow).join("\r\n") + "\r\n";
}

export function defaultJpdSampleFilename(): string {
  return "waypoint-jpd-sample.csv";
}

type Maps = {
  userById: Map<string, User>;
  teamById: Map<string, Team>;
  kpiById: Map<string, Kpi>;
  laneById: Map<string, SwimLane>;
  projectById: Map<string, Project>;
};

function teamNames(p: Project, m: Maps): string[] {
  return p.teams
    .map((id) => m.teamById.get(id)?.name)
    .filter((n): n is string => !!n);
}

const SHOP_POD_BY_LOWER = new Map(
  SHOP_POD_OPTIONS.map((pod) => [pod.toLowerCase(), pod] as const),
);

/**
 * First Waypoint team that maps to an existing SHOP Pod option.
 * Unmatched teams leave Pod blank so the importer does not invent options.
 */
export function resolveShopPod(teamNamesForItem: string[]): string {
  for (const name of teamNamesForItem) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    const aliased = WAYPOINT_TEAM_TO_POD[key];
    if (aliased) return aliased;
    const exact = SHOP_POD_BY_LOWER.get(key);
    if (exact) return exact;
  }
  return "";
}

function jpdCell(col: (typeof JPD_COLUMNS)[number], p: Project, m: Maps): string {
  switch (col) {
    case "Summary":
      return p.title;
    case "Description":
      return p.description ?? "";
    case "Issue Type":
      return ISSUE_TYPE_IDEA;
    case "Assignee":
      return p.owner_id ? m.userById.get(p.owner_id)?.email ?? "" : "";
    case "Labels":
      return (p.tags ?? []).map(toJiraLabel).filter(Boolean).join(" ");
    case "SHOP Pod":
      return resolveShopPod(teamNames(p, m));
    case "Brand":
      return BRAND_RMN;
    case "Start date":
      return jiraCsvDateTime(p.start_date);
    case "Project target":
      return jiraCsvDateTime(p.target_date);
    case "Waypoint ID":
      return p.id;
    case "Waypoint type":
      return p.type;
    case "Waypoint parent":
      return p.parent_id ? m.projectById.get(p.parent_id)?.title ?? p.parent_id : "";
    case "Waypoint swim lane":
      return p.swim_lane_id ? m.laneById.get(p.swim_lane_id)?.name ?? "" : "";
    case "Waypoint team names":
      return teamNames(p, m).join(", ");
    case "Waypoint KPIs":
      return (p.kpis ?? [])
        .map((id) => m.kpiById.get(id)?.name)
        .filter((n): n is string => !!n)
        .join(", ");
    default: {
      const _exhaustive: never = col;
      return _exhaustive;
    }
  }
}

/** Jira labels cannot contain spaces; collapse internal whitespace. */
function toJiraLabel(tag: string): string {
  return tag.trim().replace(/\s+/g, "-");
}

const JIRA_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Jira's CSV wizard default date pattern is `dd/MMM/yy h:mm a`
 * (e.g. `15/Oct/26 12:00 AM`). ISO `YYYY-MM-DD` fails validation.
 */
function jiraCsvDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const dd = String(day).padStart(2, "0");
  const yy = String(year % 100).padStart(2, "0");
  return `${dd}/${JIRA_MONTHS[month - 1]}/${yy} 12:00 AM`;
}
