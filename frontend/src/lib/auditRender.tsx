import type { Project, ProjectTimelineEntry, RecentAuditEvent, Team } from "./types";

/**
 * Shared audit-event renderer used by both the project detail panel's
 * per-project timeline and the Roadmap's tenant-wide Recent Changes
 * section. Kept as pure prop-driven components so callers control
 * how the surrounding lookups (users, lanes, teams, etc.) are
 * fetched and cached — no hooks live in here.
 */

type LaneLookup = { id: string; name: string };
type TeamLookup = Pick<Team, "id" | "name">;
type UserLookup = { id: string; name: string };
type KpiLookup = { id: string; name: string };

/**
 * Loose shape covering every audit-like row this module can render:
 *   * `ProjectTimelineEntry`   — GET /projects/:id/history
 *   * `RecentAuditEvent`       — GET /projects/audit/recent
 * Both agree on `kind`, `field`, `from_value`, `to_value`; the
 * per-project entry additionally carries `from_swim_lane_id` /
 * `to_swim_lane_id` for lane moves.
 */
export type AuditRenderEntry = {
  kind: string;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  from_swim_lane_id?: string | null;
  to_swim_lane_id?: string | null;
};

/**
 * Render the "body" of a single audit event — the human-readable
 * "changed X from A to B" phrase, without the leading timestamp or
 * user. Callers wrap this with whatever chrome they want.
 *
 * Move events use the `from_swim_lane_id` / `to_swim_lane_id` fields
 * when present (per-project history rows). Recent-changes rows carry
 * the lane ids in `from_value` / `to_value` instead — the renderer
 * accepts both, falling back to the JSONB payload when the dedicated
 * columns are absent.
 */
export function AuditEventBody({
  entry,
  lanes,
  teams,
  users,
  kpis,
  projectsById,
}: {
  entry: AuditRenderEntry;
  lanes: LaneLookup[];
  teams: TeamLookup[];
  users: UserLookup[];
  kpis: KpiLookup[];
  projectsById?: Map<string, Project>;
}) {
  const strong = (s: string) => <b className="text-wp-ink">{s}</b>;

  if (entry.kind === "create") return <>created this item.</>;
  if (entry.kind === "archive") return <>archived this item.</>;
  if (entry.kind === "restore") return <>restored this item.</>;

  if (entry.kind === "move") {
    // Per-project history rows carry the lane ids in dedicated
    // columns; the tenant-wide Recent Changes feed stores them in
    // from_value / to_value so the row shape stays flat. Prefer the
    // dedicated column when present, fall back to the JSONB payload.
    const fromId = entry.from_swim_lane_id ?? asMaybeString(entry.from_value);
    const toId = entry.to_swim_lane_id ?? asMaybeString(entry.to_value);
    const from = lanes.find((l) => l.id === fromId)?.name ?? "—";
    const to = lanes.find((l) => l.id === toId)?.name ?? "—";
    return <>moved from {strong(from)} → {strong(to)}</>;
  }

  const field = entry.field ?? "";
  const label = FIELD_LABELS[field] ?? field;
  const from = entry.from_value;
  const to = entry.to_value;

  // KPIs are ordered: an ADD/REMOVE diff would lose the ranking
  // change, so render the full before/after name list. Falls back to
  // the raw id when a KPI was deleted since the event landed.
  if (field === "kpis") {
    const before = toStrArray(from).map((id) => kpis.find((k) => k.id === id)?.name ?? id);
    const after = toStrArray(to).map((id) => kpis.find((k) => k.id === id)?.name ?? id);
    if (before.length === 0 && after.length === 0) return <>touched {label}.</>;
    if (before.length === 0) return <>set {label} to {strong(after.join(" › "))}.</>;
    if (after.length === 0) return <>cleared {label} (was {strong(before.join(" › "))}).</>;
    return <>changed {label} from {strong(before.join(" › "))} to {strong(after.join(" › "))}.</>;
  }

  // Nice-to-read array diffs for teams and tags: show what was added
  // and removed rather than dumping both full arrays. For teams, an
  // order-only change (same set, different sequence) reads better as
  // the full ordered before/after list — same treatment as KPIs above.
  if (field === "teams" || field === "tags") {
    const before = toStrArray(from);
    const after = toStrArray(to);
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    const format = (id: string) =>
      field === "teams" ? teams.find((t) => t.id === id)?.name ?? id : `#${id}`;
    // Teams-only: pure reorder of an unchanged set. Render the full
    // ordered rank so the audit trail shows exactly what the PM did.
    if (
      field === "teams" &&
      added.length === 0 &&
      removed.length === 0 &&
      before.length > 1
    ) {
      return (
        <>reordered {label} to {strong(after.map(format).join(" › "))}.</>
      );
    }
    const parts: React.ReactNode[] = [];
    if (added.length) {
      parts.push(
        <span key="add">
          added {strong(added.map(format).join(", "))}
        </span>,
      );
    }
    if (removed.length) {
      parts.push(
        <span key="rm">
          removed {strong(removed.map(format).join(", "))}
        </span>,
      );
    }
    if (!parts.length) return <>touched {label}.</>;
    return (
      <>
        {label}: {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? "; " : ""}
            {p}
          </span>
        ))}
      </>
    );
  }

  if (field === "description") {
    if (isBlank(to)) return <>cleared {label}.</>;
    if (isBlank(from)) return <>set {label}.</>;
    return <>edited {label}.</>;
  }

  if (field === "owner_id") {
    const fromName = isBlank(from) ? null : users.find((u) => u.id === from)?.name ?? String(from);
    const toName = isBlank(to) ? null : users.find((u) => u.id === to)?.name ?? String(to);
    if (fromName == null && toName != null) return <>set {label} to {strong(toName)}.</>;
    if (fromName != null && toName == null) return <>cleared {label}.</>;
    return <>changed {label} from {strong(fromName ?? "—")} to {strong(toName ?? "—")}.</>;
  }

  if (field === "parent_id") {
    const nameFor = (v: unknown) => {
      if (isBlank(v)) return null;
      return projectsById?.get(String(v))?.title ?? String(v);
    };
    const fromName = nameFor(from);
    const toName = nameFor(to);
    if (fromName == null && toName != null) return <>re-parented under {strong(toName)}.</>;
    if (fromName != null && toName == null) return <>promoted to a top-level epic (was under {strong(fromName)}).</>;
    return <>moved from {strong(fromName ?? "—")} to {strong(toName ?? "—")}.</>;
  }

  if (field.startsWith("deadline:")) {
    const laneId = field.slice("deadline:".length);
    const laneName = lanes.find((l) => l.id === laneId)?.name ?? "(deleted lane)";
    const fromD = deadlineValue(from);
    const toD = deadlineValue(to);
    if (!fromD && toD) return <>added {strong(laneName)} deadline on {strong(toD.deadline_date)}.</>;
    if (fromD && !toD) return <>removed the {strong(laneName)} deadline (was {strong(fromD.deadline_date)}).</>;
    if (fromD && toD) {
      const parts: React.ReactNode[] = [];
      if (fromD.deadline_date !== toD.deadline_date) {
        parts.push(<span key="d">date from {strong(fromD.deadline_date)} to {strong(toD.deadline_date)}</span>);
      }
      if ((fromD.note ?? "") !== (toD.note ?? "")) {
        parts.push(<span key="n">updated the note</span>);
      }
      if (!parts.length) return <>touched the {strong(laneName)} deadline.</>;
      return (
        <>
          {strong(laneName)} deadline: {parts.map((p, i) => (
            <span key={i}>{i > 0 ? "; " : ""}{p}</span>
          ))}.
        </>
      );
    }
    return <>touched a deadline.</>;
  }

  if (field.startsWith("dependency:")) {
    const fromD = dependencyValue(from);
    const toD = dependencyValue(to);
    const summarize = (d: NonNullable<ReturnType<typeof dependencyValue>>) => {
      const thisLane = d.project_swim_lane_id
        ? lanes.find((l) => l.id === d.project_swim_lane_id)?.name ?? "(deleted lane)"
        : null;
      const otherName = d.depends_on_project_id
        ? projectsById?.get(d.depends_on_project_id)?.title ?? "(deleted project)"
        : null;
      const otherLane = d.depends_on_swim_lane_id
        ? lanes.find((l) => l.id === d.depends_on_swim_lane_id)?.name ?? "(deleted lane)"
        : null;
      if (!thisLane || !otherName || !otherLane) return null;
      return { thisLane, otherName, otherLane };
    };
    const summarizedTo = toD ? summarize(toD) : null;
    const summarizedFrom = fromD ? summarize(fromD) : null;

    if (!fromD && summarizedTo) {
      return (
        <>added dependency: {strong(summarizedTo.thisLane)} blocked by {strong(summarizedTo.otherName)}&rsquo;s {strong(summarizedTo.otherLane)}.</>
      );
    }
    if (summarizedFrom && !toD) {
      return (
        <>removed dependency: {strong(summarizedFrom.thisLane)} blocked by {strong(summarizedFrom.otherName)}&rsquo;s {strong(summarizedFrom.otherLane)}.</>
      );
    }
    if (fromD && toD && "note" in fromD && "note" in toD && (fromD.note ?? "") !== (toD.note ?? "")) {
      return <>updated a dependency note.</>;
    }
    return <>touched a dependency.</>;
  }

  if (field.startsWith("link:")) {
    const fromL = linkValue(from);
    const toL = linkValue(to);
    if (!fromL && toL) {
      return <>added link {strong(toL.label)} → {strong(shortenUrl(toL.url))}.</>;
    }
    if (fromL && !toL) {
      return <>removed link {strong(fromL.label)} (was {shortenUrl(fromL.url)}).</>;
    }
    if (fromL && toL) {
      const labelChanged = fromL.label !== toL.label;
      const urlChanged = fromL.url !== toL.url;
      if (labelChanged && urlChanged) {
        return (
          <>
            renamed link {strong(fromL.label)} to {strong(toL.label)} and changed its URL to {strong(shortenUrl(toL.url))}.
          </>
        );
      }
      if (labelChanged) {
        return <>renamed link {strong(fromL.label)} to {strong(toL.label)}.</>;
      }
      if (urlChanged) {
        return <>changed URL for {strong(toL.label)} to {strong(shortenUrl(toL.url))}.</>;
      }
    }
    return <>touched a link.</>;
  }

  if (isBlank(to)) return <>cleared {label}.</>;
  if (isBlank(from)) return <>set {label} to {strong(String(to))}.</>;
  return <>changed {label} from {strong(String(from))} to {strong(String(to))}.</>;
}

/** Human-readable display name for `user_id` on an audit row.
 *  Prefers the joined `user_name` (present on Recent Changes rows),
 *  falls back to a users-list lookup by id (for per-project history),
 *  and finally "system" for null user ids or unresolved rows. */
export function auditActorLabel(
  entry: { user_id: string | null; user_name?: string | null },
  users: UserLookup[],
): string {
  if (entry.user_name) return entry.user_name;
  if (!entry.user_id) return "system";
  const found = users.find((u) => u.id === entry.user_id);
  return found?.name ?? "(deleted user)";
}

export const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  owner_id: "owner",
  teams: "teams",
  tags: "tags",
  kpis: "KPIs",
  type: "type",
  parent_id: "parent",
  start_date: "discovery start",
  target_date: "discovery target",
  dev_start_date: "development start",
  dev_end_date: "development end",
  optimization_start_date: "post-dev start",
  optimization_end_date: "post-dev end",
  swim_lane_id: "swim lane",
  excluded_from_capacity: "capacity opt-out",
  dev_estimate_sourced_by_dev: "dev estimate confirmed",
  dates_locked: "dates locked",
  hidden_from_roadmap: "hidden from roadmap",
  is_key_strategic: "key strategic",
  global_priority: "global priority",
};

function isBlank(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String);
}

function asMaybeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function dependencyValue(v: unknown):
  | {
      project_swim_lane_id?: string;
      depends_on_project_id?: string;
      depends_on_swim_lane_id?: string;
      note?: string;
    }
  | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const asStr = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  return {
    project_swim_lane_id: asStr("project_swim_lane_id"),
    depends_on_project_id: asStr("depends_on_project_id"),
    depends_on_swim_lane_id: asStr("depends_on_swim_lane_id"),
    note: asStr("note"),
  };
}

/** Extract a `{label, url}` payload from a `link:*` audit row.
 *  Returns null on shape mismatch so callers can distinguish a
 *  create (from=null) from a malformed row. */
function linkValue(v: unknown): { label: string; url: string } | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const label = obj.label;
  const url = obj.url;
  if (typeof label !== "string" || typeof url !== "string") return null;
  return { label, url };
}

/** Trim `https?://` for display in audit rows so long URLs don't
 *  overflow the timeline. Purely cosmetic — the full URL is still
 *  reachable via any surrounding link chrome. */
function shortenUrl(u: string): string {
  return u.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function deadlineValue(v: unknown): { deadline_date: string; note: string } | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const d = obj.deadline_date;
  if (typeof d !== "string") return null;
  return { deadline_date: d, note: typeof obj.note === "string" ? obj.note : "" };
}

/**
 * Bridge from a `RecentAuditEvent` (tenant-wide feed shape) into the
 * loose shape the `AuditEventBody` renderer accepts. Lets callers
 * pass a `RecentAuditEvent` straight through without repackaging.
 */
export function recentEventToRenderEntry(e: RecentAuditEvent): AuditRenderEntry {
  return {
    kind: e.kind === "move" ? "move" : e.action,
    field: e.field,
    from_value: e.from_value,
    to_value: e.to_value,
    // status_history rows aren't present in the recent feed's flat
    // shape, but AuditEventBody's move renderer already falls back
    // to from_value/to_value when these are absent. Leave undefined.
    from_swim_lane_id: null,
    to_swim_lane_id: null,
  };
}

/**
 * Bridge from a `ProjectTimelineEntry` into the loose shape the
 * `AuditEventBody` renderer accepts. Trivial passthrough today
 * (the two shapes are structurally identical) but kept as a
 * dedicated helper so future changes to either shape stay
 * localized here.
 */
export function timelineEntryToRenderEntry(e: ProjectTimelineEntry): AuditRenderEntry {
  return {
    kind: e.kind,
    field: e.field,
    from_value: e.from_value,
    to_value: e.to_value,
    from_swim_lane_id: e.from_swim_lane_id,
    to_swim_lane_id: e.to_swim_lane_id,
  };
}
