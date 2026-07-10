import type { Kpi, Project, SwimLane, Team, User } from "./types";

/**
 * Client-side CSV exporter for backlog items.
 *
 * The export columns are a **superset** of what the CSV importer
 * accepts, so any file produced here can be re-imported unchanged:
 * import-recognised columns round-trip and admin-only metadata
 * columns (id, swim_lane, kpis, parent_id, timestamps) are silently
 * ignored by the importer. This keeps "export → edit in Excel →
 * re-import" viable as a bulk-edit workflow.
 */

/** Column order the file is written in. Human-friendly first, then
 *  metadata / references at the tail. */
const COLUMNS = [
  "id",
  "title",
  "description",
  "swim_lane",
  "owner_email",
  "teams",
  "tags",
  "kpis",
  "type",
  "parent_id",
  "start_date",
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
  "created_at",
  "updated_at",
] as const;

/**
 * Serialize `projects` to a CSV string using the shared column order.
 * Owner / team / KPI ids are resolved to human-readable
 * emails/names so the file is legible when opened in a spreadsheet;
 * ids stay in dedicated columns for machine round-trips.
 */
export function projectsToCsv(
  projects: Project[],
  lookups: {
    users: User[];
    teams: Team[];
    kpis: Kpi[];
    lanes: SwimLane[];
  },
): string {
  const userById = new Map(lookups.users.map((u) => [u.id, u]));
  const teamById = new Map(lookups.teams.map((t) => [t.id, t]));
  const kpiById = new Map(lookups.kpis.map((k) => [k.id, k]));
  const laneById = new Map(lookups.lanes.map((l) => [l.id, l]));

  const rows: string[][] = [];
  rows.push([...COLUMNS]);
  for (const p of projects) {
    rows.push(COLUMNS.map((col) => cellFor(col, p, { userById, teamById, kpiById, laneById })));
  }
  return rows.map(toCsvRow).join("\r\n") + "\r\n";
}

/**
 * Kick off a browser download for `content` under `filename`. Uses
 * an object URL + anchor click so the download works without
 * navigation and gets a proper filename in every major browser.
 */
export function downloadCsv(filename: string, content: string): void {
  // BOM lets Excel auto-detect UTF-8; harmless everywhere else.
  const blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the object URL a tick later so the browser has time to
  // start the download; instant revoke can cancel it on some
  // Chromium versions.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** ISO date used in the default export filename. Local time is fine
 *  since this is a UI-facing label, not a machine key. */
export function defaultExportFilename(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `waypoint-export-${y}-${m}-${d}.csv`;
}

// -------- private --------

type Lookups = {
  userById: Map<string, User>;
  teamById: Map<string, Team>;
  kpiById: Map<string, Kpi>;
  laneById: Map<string, SwimLane>;
};

function cellFor(col: typeof COLUMNS[number], p: Project, l: Lookups): string {
  switch (col) {
    case "id":
      return p.id;
    case "title":
      return p.title;
    case "description":
      return p.description ?? "";
    case "swim_lane":
      return p.swim_lane_id ? l.laneById.get(p.swim_lane_id)?.name ?? "" : "";
    case "owner_email":
      return p.owner_id ? l.userById.get(p.owner_id)?.email ?? "" : "";
    case "teams":
      return p.teams
        .map((id) => l.teamById.get(id)?.name)
        .filter((n): n is string => !!n)
        .join(", ");
    case "tags":
      return (p.tags ?? []).join(", ");
    case "kpis":
      return (p.kpis ?? [])
        .map((id) => l.kpiById.get(id)?.name)
        .filter((n): n is string => !!n)
        .join(", ");
    case "type":
      return p.type;
    case "parent_id":
      return p.parent_id ?? "";
    case "start_date":
      return p.start_date ?? "";
    case "target_date":
      return p.target_date ?? "";
    case "dev_start_date":
      return p.dev_start_date ?? "";
    case "dev_end_date":
      return p.dev_end_date ?? "";
    case "optimization_start_date":
      return p.optimization_start_date ?? "";
    case "optimization_end_date":
      return p.optimization_end_date ?? "";
    case "created_at":
      return p.created_at ?? "";
    case "updated_at":
      return p.updated_at ?? "";
    default: {
      const _exhaustive: never = col;
      return _exhaustive;
    }
  }
}

/** Serialize one row honouring RFC-4180 quoting: cells containing
 *  `,`, `"`, `\r`, or `\n` are wrapped in quotes with internal `"`
 *  doubled. Cheap, allocation-light, no library required. */
function toCsvRow(cells: string[]): string {
  return cells.map(quoteCell).join(",");
}

function quoteCell(cell: string): string {
  if (cell === "") return "";
  const needsQuoting = /[",\r\n]/.test(cell);
  if (!needsQuoting) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}
