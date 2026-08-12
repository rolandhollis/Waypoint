import { subDays } from "date-fns";
import type { Project, RecentAuditEvent, SwimLane, Team } from "./types";

export type DeckColumnKey = "development" | "design" | "discovery";

export type DeckItemLine = {
  project_id: string;
  title: string;
  /** Optional one-line blurb (description first sentence / truncated). */
  detail?: string;
};

export type TeamDeckSection = {
  team: Team;
  development: DeckItemLine[];
  design: DeckItemLine[];
  discovery: DeckItemLine[];
  newBacklog: DeckItemLine[];
  delivered: DeckItemLine[];
  /** Scheduled epics for the roadmap slide (title + date span). */
  roadmapItems: Array<{
    project_id: string;
    title: string;
    start: string | null;
    end: string | null;
  }>;
  /** PNG data URL of the 6-month Rows Gantt for this team (optional). */
  roadmapSnapshotDataUrl?: string | null;
};

export type RoadmapUpdateDeck = {
  generatedAt: Date;
  titleDateLabel: string;
  monthLabel: string;
  workspaceName: string;
  sections: TeamDeckSection[];
};

const MS_DAY = 86_400_000;

function laneName(lane: SwimLane | undefined): string {
  return (lane?.name ?? "").trim().toLowerCase();
}

/** Map a swim lane into a status-slide column, or null if it doesn't fit. */
export function classifyLane(lane: SwimLane | undefined): DeckColumnKey | "exclude" | null {
  if (!lane) return null;
  if (lane.is_archive || lane.is_terminal) return "exclude";
  const n = laneName(lane);
  if (n === "parking lot") return "exclude";

  if (lane.add_to_design_queue || /\bdesign\b/.test(n)) return "design";
  if (/\b(discover|definition|research|ideation)\b/.test(n)) return "discovery";
  if (/\b(dev|development|engineering|build)\b/.test(n) || n.includes("in dev") || n.includes("dev ready")) {
    return "development";
  }
  // Heuristic: phase_date_key bindings used by the board
  if (lane.phase_date_key === "dev_start_date" || lane.phase_date_key === "dev_end_date") {
    return "development";
  }
  if (lane.phase_date_key === "target_date") {
    return "discovery";
  }
  return null;
}

function isDeliveryLane(lane: SwimLane | undefined): boolean {
  if (!lane) return false;
  if (lane.is_archive || lane.is_terminal) return true;
  const n = laneName(lane);
  return /\b(done|deliver|complete|archive|shipped|launched|live)\b/.test(n);
}

function primaryTeamId(project: Project): string | null {
  return project.teams[0] ?? null;
}

function blurb(description: string, max = 80): string | undefined {
  const trimmed = description.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function toLine(p: Project, withDetail = false): DeckItemLine {
  return {
    project_id: p.id,
    title: p.title,
    detail: withDetail ? blurb(p.description) : undefined,
  };
}

function withinLastDays(iso: string | null | undefined, days: number, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= days * MS_DAY && t <= now.getTime();
}

function asMaybeString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;
  // jsonb uuid often arrives as a quoted JSON string already parsed
  if (typeof value === "object" && value !== null && "toString" in value) {
    const s = String(value);
    return s === "[object Object]" ? null : s;
  }
  return null;
}

/**
 * Build the roadmap-update deck model from live Waypoint data.
 *
 * Product areas = Admin Teams order. Column buckets use lane-name /
 * flag heuristics. New backlog = created in last 30 days. Delivered =
 * moved into a terminal/archive/done-like lane in the last 30 days
 * (plus actual_completion_date in that window).
 */
export function buildRoadmapUpdateDeck(opts: {
  teams: Team[];
  lanes: SwimLane[];
  projects: Project[];
  recentEvents: RecentAuditEvent[];
  workspaceName: string;
  now?: Date;
  newBacklogDays?: number;
  deliveredDays?: number;
}): RoadmapUpdateDeck {
  const now = opts.now ?? new Date();
  const newBacklogDays = opts.newBacklogDays ?? 30;
  const deliveredDays = opts.deliveredDays ?? 30;
  const lanesById = new Map(opts.lanes.map((l) => [l.id, l] as const));

  const teams = [...opts.teams].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const activeProjects = opts.projects.filter((p) => !p.deleted_at);

  // Delivered: unique projects that moved into a delivery lane recently
  const deliveredIds = new Set<string>();
  const deliveredAt = new Map<string, number>();
  for (const ev of opts.recentEvents) {
    if (ev.kind !== "move" && ev.action !== "move") continue;
    if (!withinLastDays(ev.occurred_at, deliveredDays, now)) continue;
    const toId = asMaybeString(ev.to_value);
    const toLane = toId ? lanesById.get(toId) : undefined;
    if (!isDeliveryLane(toLane)) continue;
    deliveredIds.add(ev.project_id);
    const ts = Date.parse(ev.occurred_at);
    const prev = deliveredAt.get(ev.project_id) ?? 0;
    if (ts > prev) deliveredAt.set(ev.project_id, ts);
  }
  for (const p of activeProjects) {
    if (withinLastDays(p.actual_completion_date, deliveredDays, now)) {
      deliveredIds.add(p.id);
      const ts = Date.parse(p.actual_completion_date!);
      const prev = deliveredAt.get(p.id) ?? 0;
      if (ts > prev) deliveredAt.set(p.id, ts);
    }
  }

  const projectById = new Map(activeProjects.map((p) => [p.id, p] as const));

  const cutoffNew = subDays(now, newBacklogDays);

  const sections: TeamDeckSection[] = teams.map((team) => {
    const forTeam = activeProjects.filter((p) => primaryTeamId(p) === team.id);

    const development: DeckItemLine[] = [];
    const design: DeckItemLine[] = [];
    const discovery: DeckItemLine[] = [];

    for (const p of forTeam) {
      if (p.type !== "epic") continue;
      const lane = p.swim_lane_id ? lanesById.get(p.swim_lane_id) : undefined;
      const bucket = classifyLane(lane);
      if (bucket === "development") development.push(toLine(p));
      else if (bucket === "design") design.push(toLine(p));
      else if (bucket === "discovery") discovery.push(toLine(p));
    }

    const newBacklog = forTeam
      .filter((p) => p.type === "epic" && Date.parse(p.created_at) >= cutoffNew.getTime())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((p) => toLine(p));

    const delivered = [...deliveredIds]
      .map((id) => projectById.get(id))
      .filter((p): p is Project => !!p && primaryTeamId(p) === team.id)
      .sort((a, b) => (deliveredAt.get(b.id) ?? 0) - (deliveredAt.get(a.id) ?? 0))
      .map((p) => toLine(p, true));

    const roadmapItems = forTeam
      .filter((p) => {
        if (p.type !== "epic") return false;
        if (p.hidden_from_roadmap) return false;
        const lane = p.swim_lane_id ? lanesById.get(p.swim_lane_id) : undefined;
        if (lane?.is_archive) return false;
        if (laneName(lane) === "parking lot") return false;
        return !!(p.start_date || p.dev_start_date || p.target_date || p.dev_end_date || p.optimization_end_date);
      })
      .map((p) => ({
        project_id: p.id,
        title: p.title,
        start: p.start_date ?? p.dev_start_date,
        end: p.optimization_end_date ?? p.dev_end_date ?? p.target_date,
      }))
      .sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999"));

    return {
      team,
      development,
      design,
      discovery,
      newBacklog,
      delivered,
      roadmapItems,
    };
  });

  const titleDateLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(now);

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "America/Chicago",
  })
    .format(now)
    .toUpperCase();

  return {
    generatedAt: now,
    titleDateLabel,
    monthLabel,
    workspaceName: opts.workspaceName,
    sections,
  };
}
