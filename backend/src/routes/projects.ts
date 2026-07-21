import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { EstimateSource, ProjectAuditAction, ProjectDeadlineRow, ProjectRow, RecentAuditEventRow, SwimLaneRow, TimelineEntryRow, TshirtSizeRow } from "../types.js";
import { config } from "../config.js";
import {
  AiEstimatorParseError,
  buildUserPrompt,
  generateSuggestion,
  nearestSizeLabel,
  PHASE_KEYS,
  type AiSuggestion,
  type FewShotExample,
  type PhaseKey,
  type TshirtBucket,
} from "../ai/estimator.js";

/** Ordered phase-date fields, earliest → latest. Used by both the
 * internal-ordering validator and the forward-cascade helper. */
const PHASE_ORDER = [
  "start_date",
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
] as const;
type PhaseField = (typeof PHASE_ORDER)[number];

/** Only these three "end-of-phase" dates trigger cross-hierarchy
 * enforcement (parent must cover its subtasks; subtasks pushing out
 * automatically extend their ancestors). The start/mid dates were
 * deliberately left out — projects often have loose starts and the
 * user only cares that the shipping milestones stay consistent. */
const HIERARCHY_END_FIELDS = ["target_date", "dev_end_date", "optimization_end_date"] as const;
type HierarchyEndField = (typeof HIERARCHY_END_FIELDS)[number];

export const projectsRouter = Router();

/**
 * Fields we bother diffing into the audit trail on PATCH. Excludes
 * server-managed columns (id, timestamps, positional metadata) and
 * `swim_lane_id` (that goes through /move and is logged separately).
 */
const AUDITED_FIELDS = [
  "title",
  "description",
  "owner_id",
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
  "excluded_from_capacity",
  "dev_estimate_sourced_by_dev",
  "dates_locked",
  "hidden_from_roadmap",
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

/**
 * Write one audit-event row. Called from inside the same transaction
 * as the mutation so a failed mutation rolls back the audit entry too.
 */
export async function recordAudit(
  client: PoolClient,
  args: {
    projectId: string;
    userId: string | null;
    action: ProjectAuditAction;
    field?: string | null;
    from?: unknown;
    to?: unknown;
  },
) {
  await client.query(
    `INSERT INTO project_audit_events
       (project_id, user_id, action, field, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      args.projectId,
      args.userId,
      args.action,
      args.field ?? null,
      args.from === undefined ? null : JSON.stringify(args.from),
      args.to === undefined ? null : JSON.stringify(args.to),
    ],
  );
}

/**
 * Deep-ish equality check that treats arrays as unordered *sets* by
 * default (used for `tags` — order isn't semantically meaningful
 * there, so `["a","b"] === ["b","a"]` and no audit event is written).
 * Pass `ordered = true` for fields where reorder itself is a
 * meaningful change (e.g. `kpis` and `teams`, where the PM ranks
 * their contributor list).
 */
function valuesEqual(a: unknown, b: unknown, ordered = false): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (ordered) {
      return a.every((v, i) => String(v) === String(b[i]));
    }
    const sortedA = [...a].map(String).sort();
    const sortedB = [...b].map(String).sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return false;
}

/** Audited fields for which array *order* is meaningful.
 *
 * Both `kpis` and `teams` are ranked lists — PMs pick a primary team
 * (drives the roadmap accent color, appears first on the Board card,
 * etc.) then any number of secondary contributors, same as the KPI
 * ranking. Treating them as ordered here means a reorder-only PATCH
 * still writes a proper audit event; treating them as unordered would
 * silently swallow the change. */
const ORDERED_ARRAY_FIELDS = new Set<string>(["kpis", "teams"]);

/**
 * SELECT fragment that hydrates a project row with its `teams` and
 * `kpis` arrays. Both are ordered by the per-project `position`
 * column — the PM ranks each list left-to-right in the detail panel
 * and every renderer downstream (Board card, roadmap accent, KPI
 * report, status report) mirrors that order. The alias `p` must be
 * used for the FROM.
 */
const PROJECT_COLUMNS = `
  p.*,
  COALESCE(
    (SELECT array_agg(pt.team_id ORDER BY pt.position ASC)
       FROM project_teams pt WHERE pt.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS teams,
  COALESCE(
    (SELECT array_agg(pk.kpi_id ORDER BY pk.position ASC)
       FROM project_kpis pk WHERE pk.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS kpis,
  COALESCE(
    (SELECT jsonb_agg(
              jsonb_build_object(
                'id', pd.id,
                'swim_lane_id', pd.swim_lane_id,
                'deadline_date', to_char(pd.deadline_date, 'YYYY-MM-DD'),
                'note', pd.note
              )
              ORDER BY pd.deadline_date ASC, pd.created_at ASC
            )
       FROM project_deadlines pd WHERE pd.project_id = p.id),
    '[]'::jsonb
  ) AS deadlines,
  COALESCE(
    (SELECT jsonb_agg(
              jsonb_build_object(
                'id', pdep.id,
                'project_swim_lane_id', pdep.project_swim_lane_id,
                'depends_on_project_id', pdep.depends_on_project_id,
                'depends_on_swim_lane_id', pdep.depends_on_swim_lane_id,
                'note', pdep.note
              )
              ORDER BY pdep.created_at ASC
            )
       FROM project_dependencies pdep WHERE pdep.project_id = p.id),
    '[]'::jsonb
  ) AS dependencies
`;

/**
 * Replace the full ordered set of team memberships for a project.
 * Called from POST (initial set) and PATCH (when the client sends
 * a `teams` field). Order is derived from the array index — index
 * 0 → position 0 — mirroring replaceProjectKpis so the per-project
 * unique-position index stays gap-free after every write.
 */
export async function replaceProjectTeams(client: PoolClient, projectId: string, teamIds: string[]) {
  await client.query(`DELETE FROM project_teams WHERE project_id = $1`, [projectId]);
  if (teamIds.length === 0) return;
  const values = teamIds.map((_, i) => `($1, $${i + 2}, ${i})`).join(", ");
  await client.query(
    `INSERT INTO project_teams (project_id, team_id, position) VALUES ${values}`,
    [projectId, ...teamIds],
  );
}

/**
 * Replace the full ordered set of KPI assignments for a project. Order
 * is derived from the array index — index 0 → position 0 — so the
 * per-project unique-position index stays gap-free after every write.
 * Full-replace strategy mirrors replaceProjectTeams; keeps the mutation
 * surface predictable when the client sends the whole list.
 */
async function replaceProjectKpis(client: PoolClient, projectId: string, kpiIds: string[]) {
  await client.query(`DELETE FROM project_kpis WHERE project_id = $1`, [projectId]);
  if (kpiIds.length === 0) return;
  const values = kpiIds.map((_, i) => `($1, $${i + 2}, ${i})`).join(", ");
  await client.query(
    `INSERT INTO project_kpis (project_id, kpi_id, position) VALUES ${values}`,
    [projectId, ...kpiIds],
  );
}

/**
 * Enforce phase-boundary ordering across the six phase dates. Each
 * field is independently nullable ("not scheduled yet"). The only
 * invariant is that any pair of NON-NULL dates must be non-decreasing
 * left-to-right in PHASE_ORDER: start ≤ target ≤ devStart ≤ devEnd ≤
 * optStart ≤ optEnd. Null earlier fields are silently skipped — a PM
 * who only fills in post-dev dates (or only development) is a
 * supported flow, and clearing an earlier phase while a later phase
 * remains set must not fail validation.
 *
 * Within-phase invariants (end ≥ start on Discovery/Dev/Opt) fall
 * out of the chain automatically because each pair is adjacent in
 * PHASE_ORDER. Cross-phase ordering (target ≤ devEnd even without
 * dev_start; dev_end ≤ opt_end even without opt_start) also falls
 * out for the same reason.
 */
export function validatePhaseDates(p: {
  start_date?: string | null;
  target_date?: string | null;
  dev_start_date?: string | null;
  dev_end_date?: string | null;
  optimization_start_date?: string | null;
  optimization_end_date?: string | null;
}) {
  const chain: readonly [PhaseField, string | null][] = [
    ["start_date", p.start_date ?? null],
    ["target_date", p.target_date ?? null],
    ["dev_start_date", p.dev_start_date ?? null],
    ["dev_end_date", p.dev_end_date ?? null],
    ["optimization_start_date", p.optimization_start_date ?? null],
    ["optimization_end_date", p.optimization_end_date ?? null],
  ];
  // Walk left-to-right; each non-null date must be ≥ the last
  // non-null date we saw. Because ≤ is transitive, the pairwise
  // "current ≥ previous non-null" check implies the full chain is
  // non-decreasing across every present pair.
  let prevKey: PhaseField | null = null;
  let prevVal: string | null = null;
  for (const [key, val] of chain) {
    if (!val) continue;
    if (prevVal && val < prevVal) {
      throw new HttpError(
        400,
        `${key} (${val}) must be on or after ${prevKey} (${prevVal})`,
      );
    }
    prevKey = key;
    prevVal = val;
  }
}

/**
 * Validate a proposed (type, parent_id) pair against the current DB
 * state. Rejects self-parenting, parenting to a soft-deleted item,
 * parenting to a nonexistent item, and cycles (candidate parent must
 * not be a descendant of `selfId`). Called on both create and patch;
 * `selfId` is null when creating a brand-new row.
 */
async function validateHierarchy(
  client: PoolClient,
  selfId: string | null,
  nextType: "epic" | "subtask",
  nextParentId: string | null,
  groupId: string,
) {
  if (nextType === "epic") {
    if (nextParentId != null) {
      throw new HttpError(400, "epics cannot have a parent — clear parent_id or set type to 'subtask'");
    }
    return;
  }
  if (!nextParentId) {
    throw new HttpError(400, "subtasks require a parent_id");
  }
  if (nextParentId === selfId) {
    throw new HttpError(400, "a project cannot be its own parent");
  }
  // Parent must live in the SAME tenant. Filtering by group_id also
  // makes the "does not exist" branch fire for cross-tenant probes —
  // an attacker can't detect whether a UUID belongs to another
  // group's project vs is truly unknown.
  const { rows: parentRows } = await client.query<{ id: string; deleted_at: Date | null }>(
    `SELECT id, deleted_at FROM projects WHERE id = $1 AND group_id = $2`,
    [nextParentId, groupId],
  );
  const parent = parentRows[0];
  if (!parent) throw new HttpError(400, "parent project does not exist");
  if (parent.deleted_at) throw new HttpError(400, "cannot parent a subtask under a deleted project");

  // Cycle check: walk down from selfId (only meaningful on PATCH) and
  // make sure the candidate parent isn't in its subtree. Cheap even for
  // deep trees because we short-circuit on the first hit.
  if (selfId) {
    const { rows: descendants } = await client.query<{ id: string }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM projects WHERE parent_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT p.id FROM projects p JOIN tree t ON p.parent_id = t.id
          WHERE p.deleted_at IS NULL
       )
       SELECT id FROM tree WHERE id = $2 LIMIT 1`,
      [selfId, nextParentId],
    );
    if (descendants[0]) {
      throw new HttpError(400, "cannot move a project under one of its own descendants (would create a cycle)");
    }
  }
}

/**
 * Look up the maximum END-phase date across every descendant of
 * `projectId` (transitive; not just direct children). Returns null
 * for any field with no descendant contribution — treat null as "no
 * constraint from below". Used to reject a parent PATCH that would
 * shrink an end date past its subtasks.
 */
async function getDescendantMaxEnds(
  client: PoolClient,
  projectId: string,
): Promise<Record<HierarchyEndField, string | null>> {
  const { rows } = await client.query<{
    max_target: string | null;
    max_dev_end: string | null;
    max_opt_end: string | null;
  }>(
    `WITH RECURSIVE descendants AS (
       SELECT id, target_date, dev_end_date, optimization_end_date
         FROM projects
        WHERE parent_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT p.id, p.target_date, p.dev_end_date, p.optimization_end_date
         FROM projects p
         JOIN descendants d ON p.parent_id = d.id
        WHERE p.deleted_at IS NULL
     )
     SELECT MAX(target_date)::text        AS max_target,
            MAX(dev_end_date)::text       AS max_dev_end,
            MAX(optimization_end_date)::text AS max_opt_end
       FROM descendants`,
    [projectId],
  );
  const r = rows[0] ?? { max_target: null, max_dev_end: null, max_opt_end: null };
  return {
    target_date: r.max_target,
    dev_end_date: r.max_dev_end,
    optimization_end_date: r.max_opt_end,
  };
}

/**
 * Given a proposed set of end-date changes, throw if any descendant
 * would be left "sticking out" past the parent (i.e. the user tried
 * to shrink the parent below a child). Listing the offending fields
 * with actual dates makes it obvious what to fix. Called from PATCH
 * of any item — cheap when the item has no subtasks (single query).
 */
async function assertEndsCoverDescendants(
  client: PoolClient,
  projectId: string,
  proposed: Partial<Record<HierarchyEndField, string | null>>,
) {
  // Only bother querying if any HIERARCHY_END_FIELDS is being written.
  if (!HIERARCHY_END_FIELDS.some((f) => proposed[f] !== undefined)) return;
  const maxes = await getDescendantMaxEnds(client, projectId);
  for (const field of HIERARCHY_END_FIELDS) {
    const next = proposed[field];
    if (next === undefined) continue;
    const childMax = maxes[field];
    if (!childMax) continue;
    if (next === null) {
      throw new HttpError(400,
        `cannot clear ${field} because subtasks still have it set (latest is ${childMax}); update or archive those subtasks first`);
    }
    if (next < childMax) {
      throw new HttpError(400,
        `cannot set ${field} to ${next} — a subtask has it set to ${childMax}; extend the parent or adjust the subtask first`);
    }
  }
}

/**
 * Push the given END fields forward in the parent chain so every
 * ancestor's end dates cover the change. Called after a subtask's
 * dates are extended so the epic (and any intermediate parents)
 * stay consistent automatically. Each field is cascaded independently
 * and, on any ancestor whose end date is extended, we also push its
 * downstream phase dates forward to keep that ancestor internally
 * ordered (target must stay ≤ dev_end etc.). Writes audit rows so
 * the PM sees "extended dev_end_date because subtask X was pushed".
 */
async function cascadeEndsUpward(
  client: PoolClient,
  fromProjectId: string,
  extensions: Partial<Record<HierarchyEndField, string>>,
  userId: string,
) {
  if (Object.values(extensions).every((v) => v == null)) return;

  const { rows: selfRows } = await client.query<{ parent_id: string | null }>(
    `SELECT parent_id FROM projects WHERE id = $1`,
    [fromProjectId],
  );
  const parentId = selfRows[0]?.parent_id;
  if (!parentId) return;

  const { rows: parentRows } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE`,
    [parentId],
  );
  const parent = parentRows[0];
  if (!parent) return;

  // Start from parent's current dates; overlay extensions where they
  // extend the current value; then cascade FORWARD within the parent
  // (each end field pushes any later phase-date field that is set and
  // now trails behind).
  const proposed: Record<PhaseField, string | null> = {
    start_date: parent.start_date,
    target_date: parent.target_date,
    dev_start_date: parent.dev_start_date,
    dev_end_date: parent.dev_end_date,
    optimization_start_date: parent.optimization_start_date,
    optimization_end_date: parent.optimization_end_date,
  };

  const parentExtensions: Partial<Record<HierarchyEndField, string>> = {};

  for (const field of HIERARCHY_END_FIELDS) {
    const incoming = extensions[field];
    if (!incoming) continue;
    if (!proposed[field] || (proposed[field] as string) < incoming) {
      proposed[field] = incoming;
      parentExtensions[field] = incoming;
      // Ripple forward: any later phase date that's set and now sits
      // before `incoming` must be pushed to `incoming` too, otherwise
      // we'd break the parent's internal phase-order invariant.
      const startIdx = PHASE_ORDER.indexOf(field);
      for (let i = startIdx + 1; i < PHASE_ORDER.length; i++) {
        const later = PHASE_ORDER[i]!;
        if (proposed[later] && (proposed[later] as string) < incoming) {
          proposed[later] = incoming;
        }
      }
    }
  }

  const changed: PhaseField[] = PHASE_ORDER.filter((f) => proposed[f] !== parent[f]);
  if (changed.length === 0) return;

  const setFragments = changed.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
  const values = changed.map((k) => proposed[k]);
  await client.query(
    `UPDATE projects SET ${setFragments}, updated_at = NOW() WHERE id = $1`,
    [parentId, ...values],
  );

  for (const field of changed) {
    await recordAudit(client, {
      projectId: parentId,
      userId,
      action: "edit",
      field,
      from: parent[field] ?? null,
      to: proposed[field] ?? null,
    });
  }

  await cascadeEndsUpward(client, parentId, parentExtensions, userId);
}

/**
 * Reject the delete if the project still has any live subtasks. User
 * chose "block" over "auto-promote" or "cascade delete" so the
 * failure mode is clear rather than surprising.
 */
async function assertNoLiveSubtasks(client: PoolClient, projectId: string, verb: string) {
  const { rows } = await client.query<{ n: number; titles: string[] }>(
    `SELECT COUNT(*)::int AS n,
            COALESCE(array_agg(title) FILTER (WHERE title IS NOT NULL), ARRAY[]::text[]) AS titles
       FROM (
         SELECT title FROM projects
          WHERE parent_id = $1 AND deleted_at IS NULL
          LIMIT 3
       ) s`,
    [projectId],
  );
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    const preview = rows[0]!.titles.map((t) => `"${t}"`).join(", ");
    throw new HttpError(400,
      `cannot ${verb} this item because it still has ${n} live subtask${n === 1 ? "" : "s"} (${preview}). Re-parent or archive them first.`);
  }
}

const projectBaseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(50_000).optional(),
  swim_lane_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  teams: z.array(z.string().uuid()).max(10).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  /**
   * Ordered list of KPI ids this project contributes to. Order
   * carries meaning (primary → tertiary), so we treat writes as
   * full replacements — the client sends the whole array in the
   * order it wants persisted. Empty array clears all assignments.
   */
  kpis: z.array(z.string().uuid()).max(20).optional(),
  type: z.enum(["epic", "subtask"]).optional(),
  parent_id: z.string().uuid().nullable().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  dev_start_date: z.string().nullable().optional(),
  dev_end_date: z.string().nullable().optional(),
  optimization_start_date: z.string().nullable().optional(),
  optimization_end_date: z.string().nullable().optional(),
  /**
   * Per-item opt-out from capacity planning. When true this row is
   * skipped in the overload sweep and in the auto-scheduler; the
   * bar still draws on the roadmap. Default false at the DB level
   * so omitting the field on create means "counts."
   */
  excluded_from_capacity: z.boolean().optional(),
  /**
   * PM's flag: has the dev-phase estimate been vetted by an
   * engineer? Default false at the DB level; roadmap renders
   * unconfirmed dev segments with a dashed outline so viewers
   * can spot provisional timing at a glance.
   */
  dev_estimate_sourced_by_dev: z.boolean().optional(),
  /**
   * Persistent per-project auto-scheduler lock. When true, the
   * Auto-schedule modal treats this project as locked-permanent
   * and no automated run can change its dates. Manual edits
   * (detail panel, EZEstimates picker) are unaffected — this
   * only gates the automated Auto-schedule flow. Default false
   * at the DB level; toggled from the padlock icon in the
   * ProjectDetailPanel header (see migration 034).
   */
  dates_locked: z.boolean().optional(),
  /**
   * Per-project "hide from the Roadmap view" flag. When true the
   * project is unconditionally excluded from the Roadmap surface
   * (Gantt, Unscheduled list, Recent Changes, headline, PDF
   * export). No other view is affected. Default false at the DB
   * level; toggled from the checkbox in the ProjectDetailPanel
   * (see migration 035).
   */
  hidden_from_roadmap: z.boolean().optional(),
  /**
   * Per-phase estimate provenance metadata. Optional and out-of-band
   * (leading underscore) so it stays clearly distinct from the
   * persisted project columns above — it drives WHICH of the nine
   * `*_updated_*` columns get stamped by this write, not the row's
   * business fields.
   *
   *   * `source`        — one of 'user' | 'claude' | 'csv'. Defaults
   *                       to 'user' when omitted so pre-provenance
   *                       callers keep working. `'cascade'` is NOT
   *                       accepted from the wire — the router derives
   *                       that value for phases that were shifted by
   *                       upstream changes but not directly targeted.
   *   * `editedPhases`  — which of the three phases (`discovery`,
   *                       `development`, `post_dev`) the caller was
   *                       directly editing in this write. Any changed
   *                       phase NOT in this list is stamped
   *                       'cascade'. When the list is omitted the
   *                       server assumes every changed phase was a
   *                       direct edit (legacy PATCH callers).
   */
  _meta: z
    .object({
      source: z.enum(["user", "claude", "csv"]).optional(),
      editedPhases: z.array(z.enum(["discovery", "development", "post_dev"])).optional(),
    })
    .optional(),
});

/** Column names that live on the `projects` table itself (i.e. what the
 * projects UPDATE/INSERT can touch directly). `teams` is a virtual
 * column derived from the join, so it's excluded. */
const PROJECT_COLUMN_KEYS = [
  "title", "description", "swim_lane_id", "owner_id", "tags",
  "type", "parent_id",
  "start_date", "target_date", "dev_start_date", "dev_end_date",
  "optimization_start_date", "optimization_end_date",
  "excluded_from_capacity",
  "dev_estimate_sourced_by_dev",
  "dates_locked",
  "hidden_from_roadmap",
] as const;

/**
 * Provenance-phase → (start_field, end_field) map. Used both to
 * detect which phase's date pair changed on a PATCH and to build the
 * INSERT stamp on POST when a new project ships with phase dates.
 * Matches the same triad the frontend cascade helper uses so both
 * ends of the wire stamp the same buckets.
 */
type ProvenancePhaseKey = "discovery" | "development" | "post_dev";

const PHASE_PROVENANCE_FIELDS = {
  discovery: ["start_date", "target_date"] as const,
  development: ["dev_start_date", "dev_end_date"] as const,
  post_dev: ["optimization_start_date", "optimization_end_date"] as const,
} satisfies Record<ProvenancePhaseKey, readonly [string, string]>;

const PROVENANCE_PHASE_KEYS: readonly ProvenancePhaseKey[] = [
  "discovery",
  "development",
  "post_dev",
];

/**
 * Normalize an incoming date value to a bare ISO YYYY-MM-DD string
 * so we can compare "did this phase's date actually change?" without
 * tripping on `2026-08-15` vs `2026-08-15T00:00:00.000Z` vs a JS Date
 * object surfaced by node-postgres. The backend stores phase dates as
 * DATE (see migration 004) so anything but the calendar day is noise.
 */
function toIsoDay(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.slice(0, 10);
  return null;
}

const listSchema = z.object({
  include_deleted: z.enum(["true", "false"]).optional(),
});

/**
 * SQL fragment that hides projects in admin-only lanes from non-admin
 * requesters. Composed into the WHERE clause of both list and detail
 * reads so a non-admin can neither enumerate nor probe archived cards.
 */
const HIDDEN_LANE_CLAUSE = `
  NOT EXISTS (
    SELECT 1 FROM swim_lanes sl
    WHERE sl.id = p.swim_lane_id AND sl.is_admin_only = TRUE
  )
`;

projectsRouter.get("/", async (req, res) => {
  const q = listSchema.parse(req.query);
  const includeDeleted = q.include_deleted === "true";
  const isAdmin = req.userGroupRole === "admin";
  // group_id filter is always first so the query planner picks the
  // (group_id, position) composite index without extra hinting.
  const clauses: string[] = ["p.group_id = $1"];
  if (!includeDeleted) clauses.push("p.deleted_at IS NULL");
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p
       WHERE ${clauses.join(" AND ")}
       ORDER BY p.position ASC, p.created_at ASC`,
    [req.groupId!],
  );
  res.json(rows);
});

projectsRouter.get("/:id", async (req, res) => {
  const isAdmin = req.userGroupRole === "admin";
  const clauses = ["p.id = $1", "p.group_id = $2"];
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE ${clauses.join(" AND ")}`,
    [req.params.id, req.groupId!],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  res.json(rows[0]);
});

projectsRouter.post("/", requireWrite, async (req, res) => {
  const body = projectBaseSchema.parse(req.body);
  validatePhaseDates(body);
  const nextType = body.type ?? "epic";
  const nextParentId = body.parent_id ?? null;
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    // Every project must live in a lane in THIS tenant. Filter by
    // group_id when resolving both the caller-supplied lane (defensive
    // — client shouldn't be able to sneak a cross-tenant id in) and
    // the fallback default lane.
    let laneId = body.swim_lane_id ?? null;
    if (laneId) {
      const { rows: check } = await client.query<{ id: string }>(
        `SELECT id FROM swim_lanes WHERE id = $1 AND group_id = $2`,
        [laneId, groupId],
      );
      if (!check[0]) throw new HttpError(400, "swim_lane_id does not belong to the current group");
    } else {
      const { rows: laneRows } = await client.query<{ id: string }>(
        `SELECT id FROM swim_lanes
          WHERE group_id = $1
          ORDER BY is_default_new DESC,
                   is_terminal ASC,
                   "order" ASC
          LIMIT 1`,
        [groupId],
      );
      laneId = laneRows[0]?.id ?? null;
      if (!laneId) throw new HttpError(400, "cannot create a project: no swim lanes exist yet");
    }

    // Verify (type, parent_id) is legal — subtask needs a real parent
    // IN THE SAME GROUP, epic must not carry one.
    await validateHierarchy(client, null, nextType, nextParentId, groupId);

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
      [laneId],
    );
    const position = maxRows[0]?.next ?? 0;

    // Stamp per-phase provenance for any phase whose START or END
    // date is non-null in the create body. New projects have no
    // pre-existing dates to cascade off, so every stamped phase is
    // treated as a direct edit — `_meta.editedPhases` is ignored on
    // POST (the shape of an insert is unambiguous). Legacy callers
    // that don't send `_meta` fall through to source='user'.
    const createSource: EstimateSource = body._meta?.source ?? "user";
    const stampedAt = new Date();
    const userId = req.user!.id;
    const phaseStamps: Record<ProvenancePhaseKey, {
      at: Date | null;
      by: string | null;
      src: EstimateSource | null;
    }> = {
      discovery: { at: null, by: null, src: null },
      development: { at: null, by: null, src: null },
      post_dev: { at: null, by: null, src: null },
    };
    for (const phase of PROVENANCE_PHASE_KEYS) {
      const [sField, eField] = PHASE_PROVENANCE_FIELDS[phase];
      const sVal = body[sField as keyof typeof body];
      const eVal = body[eField as keyof typeof body];
      if (sVal == null && eVal == null) continue;
      phaseStamps[phase] = { at: stampedAt, by: userId, src: createSource };
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects
         (group_id, title, description, swim_lane_id, position, owner_id, tags,
          type, parent_id,
          start_date, target_date, dev_start_date, dev_end_date,
          optimization_start_date, optimization_end_date,
          excluded_from_capacity, dev_estimate_sourced_by_dev, dates_locked,
          hidden_from_roadmap, created_by,
          discovery_updated_at, discovery_updated_by_user_id, discovery_updated_source,
          development_updated_at, development_updated_by_user_id, development_updated_source,
          post_dev_updated_at, post_dev_updated_by_user_id, post_dev_updated_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [
        groupId,
        body.title,
        body.description ?? "",
        laneId,
        position,
        body.owner_id ?? req.user!.id,
        body.tags ?? [],
        nextType,
        nextParentId,
        body.start_date ?? null,
        body.target_date ?? null,
        body.dev_start_date ?? null,
        body.dev_end_date ?? null,
        body.optimization_start_date ?? null,
        body.optimization_end_date ?? null,
        body.excluded_from_capacity ?? false,
        body.dev_estimate_sourced_by_dev ?? false,
        body.dates_locked ?? false,
        body.hidden_from_roadmap ?? false,
        req.user!.id,
        phaseStamps.discovery.at,
        phaseStamps.discovery.by,
        phaseStamps.discovery.src,
        phaseStamps.development.at,
        phaseStamps.development.by,
        phaseStamps.development.src,
        phaseStamps.post_dev.at,
        phaseStamps.post_dev.by,
        phaseStamps.post_dev.src,
      ],
    );
    const projectId = rows[0]!.id;
    if (body.teams?.length) {
      await replaceProjectTeams(client, projectId, body.teams);
    }
    if (body.kpis?.length) {
      await replaceProjectKpis(client, projectId, body.kpis);
    }
    await client.query(
      `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
       VALUES ($1, NULL, $2, $3)`,
      [projectId, laneId, req.user!.id],
    );
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "create",
    });

    // If a subtask is created with end dates that push out the parent,
    // extend the parent chain immediately so the tree lands consistent.
    if (nextType === "subtask" && nextParentId) {
      const extensions: Partial<Record<HierarchyEndField, string>> = {};
      for (const field of HIERARCHY_END_FIELDS) {
        const v = body[field];
        if (v) extensions[field] = v;
      }
      if (Object.keys(extensions).length) {
        await cascadeEndsUpward(client, projectId, extensions, req.user!.id);
      }
    }

    const { rows: finalRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return finalRows[0];
  });
  res.status(201).json(result);
});

projectsRouter.patch("/:id", requireWrite, async (req, res) => {
  const body = projectBaseSchema.partial().parse(req.body);
  if (body.swim_lane_id !== undefined) {
    throw new HttpError(400, "use POST /projects/:id/move to change swim_lane_id");
  }
  const projectId = String(req.params.id);
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND p.group_id = $2 FOR UPDATE`,
      [projectId, groupId],
    );
    const existing = existingRows[0];
    if (!existing) throw new HttpError(404, "project not found");

    // Resolve the effective (type, parent_id) after the PATCH so we
    // can validate the pair as a whole. Changing type flips whether
    // parent_id is required — enforce that here rather than let the
    // DB CHECK be the messenger.
    const effectiveType = body.type ?? existing.type;
    let effectiveParent: string | null;
    if (body.parent_id !== undefined) {
      effectiveParent = body.parent_id;
    } else if (body.type === "epic") {
      // Type flipped epic → we intentionally clear any dangling parent.
      effectiveParent = null;
    } else if (body.type === "subtask" && !existing.parent_id) {
      throw new HttpError(400, "flipping type to 'subtask' also requires a parent_id");
    } else {
      effectiveParent = existing.parent_id;
    }
    // Normalize: clear parent when the effective type is epic even if
    // the caller forgot to. Keeps DB CHECK happy without extra hoops.
    if (effectiveType === "epic") effectiveParent = null;

    if (
      body.type !== undefined ||
      body.parent_id !== undefined
    ) {
      await validateHierarchy(client, projectId, effectiveType, effectiveParent, groupId);
    }

    // If any phase-date is being changed, revalidate the whole chain using
    // the incoming value where present, otherwise the persisted value. This
    // catches attempts to (say) push target_date past a persisted dev_start.
    const touchesPhaseDates =
      body.start_date !== undefined ||
      body.target_date !== undefined ||
      body.dev_start_date !== undefined ||
      body.dev_end_date !== undefined ||
      body.optimization_start_date !== undefined ||
      body.optimization_end_date !== undefined;
    if (touchesPhaseDates) {
      validatePhaseDates({
        start_date: body.start_date !== undefined ? body.start_date : existing.start_date,
        target_date: body.target_date !== undefined ? body.target_date : existing.target_date,
        dev_start_date: body.dev_start_date !== undefined ? body.dev_start_date : existing.dev_start_date,
        dev_end_date: body.dev_end_date !== undefined ? body.dev_end_date : existing.dev_end_date,
        optimization_start_date: body.optimization_start_date !== undefined ? body.optimization_start_date : existing.optimization_start_date,
        optimization_end_date: body.optimization_end_date !== undefined ? body.optimization_end_date : existing.optimization_end_date,
      });

      // Cross-hierarchy rule: on this item's PATCH, no end date may
      // be shrunk below any subtask that currently sits under it.
      // Only checks fields actually present in the body (undefined =
      // "not changing"; null / earlier date on an existing field is
      // where the violation shows up).
      const proposedEnds: Partial<Record<HierarchyEndField, string | null>> = {};
      for (const field of HIERARCHY_END_FIELDS) {
        if (body[field] !== undefined) proposedEnds[field] = body[field] ?? null;
      }
      await assertEndsCoverDescendants(client, projectId, proposedEnds);
    }

    // `teams` and `kpis` are join-table fields, not columns on projects.
    // Apply each separately as a full replacement (empty array = clear all).
    if (body.teams !== undefined) {
      await replaceProjectTeams(client, projectId, body.teams);
    }
    if (body.kpis !== undefined) {
      await replaceProjectKpis(client, projectId, body.kpis);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of PROJECT_COLUMN_KEYS) {
      if (key === "type") {
        if (body.type === undefined) continue;
        values.push(effectiveType);
        fields.push(`"type" = $${values.length}`);
        continue;
      }
      if (key === "parent_id") {
        // Only write parent_id when the *effective* parent differs from
        // what's persisted. Clearing happens both on explicit body.parent_id
        // = null and on an implicit "type flipped to epic" transition.
        const hasExplicitParent = body.parent_id !== undefined;
        const parentChangedImplicitly = body.type === "epic" && existing.parent_id !== null;
        if (!hasExplicitParent && !parentChangedImplicitly) continue;
        values.push(effectiveParent);
        fields.push(`"parent_id" = $${values.length}`);
        continue;
      }
      const v = (body as Record<string, unknown>)[key];
      if (v === undefined) continue;
      values.push(v);
      fields.push(`"${key}" = $${values.length}`);
    }

    // Per-phase provenance stamps for the three EZEstimates phases.
    // A phase is considered "changed" only when its ISO-date pair
    // moved — a client that echoes back the current dates unchanged
    // does NOT restamp provenance. When `_meta.editedPhases` is
    // supplied, phases NOT on that list get 'cascade' (the caller
    // signaled they were shifted by an upstream pick, not directly
    // touched); when omitted, all changed phases are treated as
    // direct edits so legacy PATCH callers keep working.
    if (touchesPhaseDates) {
      const metaSource: EstimateSource = body._meta?.source ?? "user";
      const editedList = body._meta?.editedPhases;
      const editedSet = editedList ? new Set<ProvenancePhaseKey>(editedList) : null;
      for (const phase of PROVENANCE_PHASE_KEYS) {
        const [sField, eField] = PHASE_PROVENANCE_FIELDS[phase];
        const sInBody = (body as Record<string, unknown>)[sField] !== undefined;
        const eInBody = (body as Record<string, unknown>)[eField] !== undefined;
        if (!sInBody && !eInBody) continue;
        // ISO-day compare on both endpoints. Undefined in body means
        // "not changing" — fall back to the existing value.
        const oldS = toIsoDay((existing as unknown as Record<string, unknown>)[sField]);
        const oldE = toIsoDay((existing as unknown as Record<string, unknown>)[eField]);
        const nextS = sInBody
          ? toIsoDay((body as Record<string, unknown>)[sField])
          : oldS;
        const nextE = eInBody
          ? toIsoDay((body as Record<string, unknown>)[eField])
          : oldE;
        if (nextS === oldS && nextE === oldE) continue;
        const phaseSource: EstimateSource =
          editedSet === null || editedSet.has(phase) ? metaSource : "cascade";
        fields.push(`"${phase}_updated_at" = NOW()`);
        values.push(req.user!.id);
        fields.push(`"${phase}_updated_by_user_id" = $${values.length}`);
        values.push(phaseSource);
        fields.push(`"${phase}_updated_source" = $${values.length}`);
      }
    }

    if (fields.length) {
      values.push(projectId);
      await client.query(
        `UPDATE projects SET ${fields.join(", ")}, updated_at = NOW()
           WHERE id = $${values.length} AND deleted_at IS NULL`,
        values,
      );
    }

    // Diff each audited field and write one event per actual change.
    // `existing` is the pre-mutation row we already fetched under FOR
    // UPDATE, so we compare against it (not against another SELECT).
    for (const field of AUDITED_FIELDS) {
      let incoming: unknown;
      if (field === "type") incoming = body.type;
      else if (field === "parent_id") {
        if (body.parent_id !== undefined) incoming = effectiveParent;
        else if (body.type === "epic" && existing.parent_id !== null) incoming = null;
        else incoming = undefined;
      } else {
        incoming = (body as Record<string, unknown>)[field];
      }
      if (incoming === undefined) continue;
      const before = (existing as unknown as Record<string, unknown>)[field];
      if (valuesEqual(before, incoming, ORDERED_ARRAY_FIELDS.has(field))) continue;
      await recordAudit(client, {
        projectId,
        userId: req.user!.id,
        action: "edit",
        field,
        from: before ?? null,
        to: incoming ?? null,
      });
    }

    // If any END dates were extended, ripple that change up the parent
    // chain — cascading is the "recommended" behavior the user picked.
    // Only cascades on positive extensions (child pushed past parent);
    // reductions are already blocked by assertEndsCoverDescendants
    // above so we never cascade a shrink.
    if (touchesPhaseDates) {
      const extensions: Partial<Record<HierarchyEndField, string>> = {};
      for (const field of HIERARCHY_END_FIELDS) {
        const incoming = body[field];
        if (!incoming) continue;
        const before = existing[field];
        if (!before || incoming > before) extensions[field] = incoming;
      }
      if (Object.keys(extensions).length) {
        await cascadeEndsUpward(client, projectId, extensions, req.user!.id);
      }
    }

    const { rows: finalRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return finalRows[0]!;
  });
  res.json(result);
});

const moveSchema = z.object({
  swim_lane_id: z.string().uuid(),
  position: z.number().int().min(0).optional(),
});

/**
 * Move a project into a new lane at an optional position. Extracted so
 * both `POST /:id/move` and `POST /:id/archive` share the same
 * side-effects (terminal-lane completion stamping, position compaction,
 * status_history entry, audit event) without duplicating the SQL.
 */
async function moveProjectImpl(
  client: PoolClient,
  args: {
    projectId: string;
    toLaneId: string;
    position?: number;
    userId: string;
    groupId: string;
  },
): Promise<ProjectRow> {
  const { rows: existingRows } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p
       WHERE p.id = $1 AND p.group_id = $2 AND p.deleted_at IS NULL FOR UPDATE`,
    [args.projectId, args.groupId],
  );
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "project not found");

  const from = existing.swim_lane_id;
  const to = args.toLaneId;

  // Destination lane must be in the same tenant. Prevents a client
  // from cross-tenant-moving a card by feeding a foreign lane id.
  const { rows: destCheck } = await client.query<{ id: string }>(
    `SELECT id FROM swim_lanes WHERE id = $1 AND group_id = $2`,
    [to, args.groupId],
  );
  if (!destCheck[0]) throw new HttpError(400, "destination swim lane is not in this group");

  // Terminal-lane side effect on `actual_completion_date`: auto-stamp on
  // entry into a terminal lane, auto-clear on exit. Only when the lane
  // actually changes so within-lane reorders never touch the field.
  let extraSet = "";
  if (from !== to) {
    if (to && !existing.actual_completion_date) {
      const { rows: laneRows } = await client.query<SwimLaneRow>(
        `SELECT * FROM swim_lanes WHERE id = $1`,
        [to],
      );
      if (laneRows[0]?.is_terminal) {
        extraSet = ", actual_completion_date = CURRENT_DATE";
      }
    } else if (existing.actual_completion_date) {
      const { rows: laneRows } = await client.query<SwimLaneRow>(
        `SELECT * FROM swim_lanes WHERE id = $1`,
        [to ?? "00000000-0000-0000-0000-000000000000"],
      );
      if (!laneRows[0]?.is_terminal) {
        extraSet = ", actual_completion_date = NULL";
      }
    }
  }

  // Build the destination lane's new order by fetching its current members
  // (minus the moved row) and splicing the moved id in at the requested
  // slot, defaulting to the end when no position is provided.
  const { rows: destRows } = await client.query<{ id: string }>(
    `SELECT id FROM projects
      WHERE swim_lane_id IS NOT DISTINCT FROM $1
        AND deleted_at IS NULL
        AND id <> $2
      ORDER BY position ASC, created_at ASC`,
    [to, existing.id],
  );
  const destIds = destRows.map((r) => r.id);
  const insertAt = args.position === undefined
    ? destIds.length
    : Math.max(0, Math.min(destIds.length, args.position));
  destIds.splice(insertAt, 0, existing.id);

  await client.query(
    `UPDATE projects
       SET swim_lane_id = $1, position = $2${extraSet}, updated_at = NOW()
      WHERE id = $3`,
    [to, insertAt, existing.id],
  );
  for (let i = 0; i < destIds.length; i++) {
    if (destIds[i] === existing.id) continue;
    await client.query(
      `UPDATE projects SET position = $1 WHERE id = $2 AND position <> $1`,
      [i, destIds[i]],
    );
  }

  if (from !== to) {
    // Compact positions in the source lane so removing a card doesn't
    // leave a gap in its former lane's ordering.
    const { rows: srcRows } = await client.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE swim_lane_id IS NOT DISTINCT FROM $1
          AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC`,
      [from],
    );
    for (let i = 0; i < srcRows.length; i++) {
      await client.query(
        `UPDATE projects SET position = $1 WHERE id = $2 AND position <> $1`,
        [i, srcRows[i]!.id],
      );
    }

    await client.query(
      `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [existing.id, from, to, args.userId],
    );
    await recordAudit(client, {
      projectId: existing.id,
      userId: args.userId,
      action: "move",
      field: "swim_lane_id",
      from,
      to,
    });
  }

  const { rows: updated } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
    [existing.id],
  );
  return updated[0]!;
}

projectsRouter.post("/:id/move", requireWrite, async (req, res) => {
  const body = moveSchema.parse(req.body);
  const groupId = req.groupId!;
  const result = await withTransaction((client) =>
    moveProjectImpl(client, {
      projectId: String(req.params.id),
      toLaneId: body.swim_lane_id,
      position: body.position,
      userId: req.user!.id,
      groupId,
    }),
  );
  res.json(result);
});

/**
 * Bulk-reorder every project in a single swim lane in one atomic
 * transaction.
 *
 * Callers use this from the Board's "Sort lane" modal — a full-lane
 * drag-and-drop reorder is a much better UX than firing N single
 * /:id/move calls (each of which does its own cross-lane rebalance and
 * status_history bookkeeping). This endpoint stays lane-local: swim
 * lane membership doesn't change, no terminal-lane stamping happens,
 * no status_history row is written. All that logic is only relevant to
 * *lane transitions*; a pure sort is not one.
 *
 * Request body:
 *   {
 *     swim_lane_id: string,     // the lane being sorted
 *     order: string[],          // project ids in their NEW order
 *   }
 *
 * Contract enforced server-side:
 *   * Every id in `order` must currently live in `swim_lane_id` for
 *     the caller's group (case: filtered subset from the client). Any
 *     that don't → 400. This is deliberately strict — the client only
 *     ever sends items it visually pulled from the lane, so a
 *     mismatch means the cache is stale or the request was crafted by
 *     hand, and we'd rather fail than silently move cards between
 *     lanes.
 *   * `order` may be a subset of the lane's members (the client passes
 *     the filtered subset). Missing members keep their relative order
 *     with each other and are appended after the sorted subset, so the
 *     visible portion always ends up in the user's chosen order
 *     without stomping on rows the user couldn't see in the modal.
 *
 * Positions are reindexed 0..n-1 in the final blended order so the
 * per-lane unique-position index stays gap-free.
 */
const reorderLaneSchema = z.object({
  swim_lane_id: z.string().uuid(),
  order: z.array(z.string().uuid()).min(1),
});

projectsRouter.post("/reorder-lane", requireWrite, async (req, res) => {
  const body = reorderLaneSchema.parse(req.body);
  const groupId = req.groupId!;

  await withTransaction(async (client) => {
    // Lane must belong to the caller's group. Blocks cross-tenant
    // access even for well-formed requests.
    const { rows: laneRows } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes WHERE id = $1 AND group_id = $2`,
      [body.swim_lane_id, groupId],
    );
    if (!laneRows[0]) throw new HttpError(404, "swim lane not found");

    // Snapshot the lane's current membership (order by position, then
    // created_at as a stable tiebreaker) so we can (a) verify the
    // sorted subset is legitimate and (b) blend it with the
    // un-sorted rows the caller couldn't see.
    const { rows: current } = await client.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE swim_lane_id = $1
          AND group_id = $2
          AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC
        FOR UPDATE`,
      [body.swim_lane_id, groupId],
    );
    const currentIds = current.map((r) => r.id);
    const currentSet = new Set(currentIds);

    // Every id the client sent must be in this lane right now.
    // Rejecting on drift beats silently discarding half the request.
    const foreign = body.order.filter((id) => !currentSet.has(id));
    if (foreign.length) {
      throw new HttpError(400, `ids not in this lane: ${foreign.join(", ")}`);
    }
    // Dedupe defensively — the client shouldn't send dupes but a
    // stray render bug shouldn't corrupt the position sequence.
    const seen = new Set<string>();
    const orderedSubset: string[] = [];
    for (const id of body.order) {
      if (seen.has(id)) continue;
      seen.add(id);
      orderedSubset.push(id);
    }

    // Blend the caller-sorted subset with the rows the caller
    // couldn't see (filtered out on the client). Keep the unfiltered
    // tail in its existing relative order — that's the least
    // surprising outcome for anyone who didn't participate in the
    // sort dialog.
    const tail = currentIds.filter((id) => !seen.has(id));
    const finalOrder = [...orderedSubset, ...tail];

    for (let i = 0; i < finalOrder.length; i++) {
      await client.query(
        `UPDATE projects SET position = $1, updated_at = NOW()
          WHERE id = $2 AND position <> $1`,
        [i, finalOrder[i]],
      );
    }

    // Deliberately NOT recording an audit event per project — this is
    // a positional sort, not a data change, and would drown the audit
    // trail with noise every time a PM tidies a lane. Lane MOVEMENT
    // (a card actually changing swim lanes) continues to be audited
    // by moveProjectImpl above.
  });

  res.json({ ok: true });
});

/**
 * Move a project into the workspace's archive lane. The lane's id is
 * resolved server-side so non-admins (who never see the lane in their
 * swim-lanes response) can still archive their own work with one click.
 */
projectsRouter.post("/:id/archive", requireWrite, async (req, res) => {
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const projectId = String(req.params.id);
    // Archive lane is per-tenant; find the one for THIS group.
    const { rows: laneRows } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes WHERE is_archive = TRUE AND group_id = $1 LIMIT 1`,
      [groupId],
    );
    const archiveLaneId = laneRows[0]?.id;
    if (!archiveLaneId) {
      throw new HttpError(400, "no archive lane is configured. Ask an admin to flag one in Admin → Swim lanes.");
    }
    // Block if any subtask lives outside the archive lane — the user
    // opted for "block, tell them to fix it" over "cascade the action
    // through the subtree". Children already sitting in Archive don't
    // count so bottom-up archiving works: archive leaves first, then
    // parents, then the epic.
    const { rows: openChildren } = await client.query<{ n: number; titles: string[] }>(
      `SELECT COUNT(*)::int AS n,
              COALESCE(array_agg(title) FILTER (WHERE title IS NOT NULL), ARRAY[]::text[]) AS titles
         FROM (
           SELECT p.title
             FROM projects p
             LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
            WHERE p.parent_id = $1
              AND p.deleted_at IS NULL
              AND (sl.is_archive IS DISTINCT FROM TRUE)
            LIMIT 3
         ) s`,
      [projectId],
    );
    const n = openChildren[0]?.n ?? 0;
    if (n > 0) {
      const preview = openChildren[0]!.titles.map((t) => `"${t}"`).join(", ");
      throw new HttpError(400,
        `cannot archive this item because ${n} subtask${n === 1 ? "" : "s"} still live outside Archive (${preview}). Archive those first.`);
    }
    return moveProjectImpl(client, {
      projectId,
      toLaneId: archiveLaneId,
      userId: req.user!.id,
      groupId,
    });
  });
  res.json(result);
});

projectsRouter.delete("/:id", requireWrite, async (req, res) => {
  const projectId = String(req.params.id);
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    await assertNoLiveSubtasks(client, projectId, "delete");
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL RETURNING id`,
      [projectId, groupId],
    );
    if (!updated[0]) throw new HttpError(404, "project not found or already deleted");
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "archive",
    });
    const { rows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return rows[0]!;
  });
  res.json(result);
});

projectsRouter.post("/:id/restore", requireWrite, async (req, res) => {
  const projectId = String(req.params.id);
  const groupId = req.groupId!;
  const result = await withTransaction(async (client) => {
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND group_id = $2 RETURNING id`,
      [projectId, groupId],
    );
    if (!updated[0]) throw new HttpError(404, "project not found");
    await recordAudit(client, {
      projectId,
      userId: req.user!.id,
      action: "restore",
    });
    const { rows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1`,
      [projectId],
    );
    return rows[0]!;
  });
  res.json(result);
});

/**
 * Tenant-wide "what changed recently" feed backing the Roadmap's
 * Recent-changes section. Merges `project_audit_events` (field edits,
 * creates, archives, restores) with `status_history` (lane movements)
 * across every non-deleted project in the caller's group, joined
 * with the caller-relevant metadata (project title/type, root-epic
 * rollup, actor display name, archived-lane flag) so the frontend
 * can render without a second round-trip.
 *
 * `?days` bounds the window (default 7, capped at 30). Results are
 * capped at 500 rows; `truncated` on the response flags when the cap
 * clipped older activity so the UI can hint that the view is partial.
 *
 * Move-audit rows are filtered out because every real lane move
 * already writes to `status_history` (rendered here as kind='move')
 * plus a duplicate `project_audit_events` row with action='move'.
 * Including both would double-count each move in the feed; the
 * status_history version carries the from/to lane ids in the shape
 * the shared audit renderer expects, so we keep that one and drop
 * the audit-events duplicate.
 */
const RECENT_EVENTS_CAP = 500;

projectsRouter.get("/audit/recent", async (req, res) => {
  const daysRaw = Number.parseInt(String(req.query.days ?? "7"), 10);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(30, daysRaw)) : 7;
  const groupId = req.groupId!;
  const isAdmin = req.userGroupRole === "admin";

  // Non-admins never see projects that live in admin-only lanes;
  // the same filter runs on GET /projects, so keep the feed
  // consistent with what those users see elsewhere.
  const hiddenLaneClause = isAdmin
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM swim_lanes sl2
          WHERE sl2.id = p.swim_lane_id AND sl2.is_admin_only = TRUE
       )`;

  const { rows } = await query<RecentAuditEventRow>(
    `WITH RECURSIVE walk AS (
       -- Base: every live project in the group is its own start.
       SELECT id AS start_id, id AS cur_id, parent_id, title AS cur_title, 0 AS depth
         FROM projects
        WHERE group_id = $1 AND deleted_at IS NULL
       UNION ALL
       -- Walk one hop up the parent chain; stop when the parent is
       -- missing or soft-deleted (deepest reachable ancestor becomes
       -- the effective root).
       SELECT w.start_id, p.id, p.parent_id, p.title, w.depth + 1
         FROM walk w
         JOIN projects p ON p.id = w.parent_id AND p.deleted_at IS NULL
     ),
     roots AS (
       -- Pick the deepest reachable row per start_id (the root epic,
       -- or the last still-alive ancestor if the true root was
       -- deleted). DISTINCT ON keeps one row per start_id keyed on
       -- depth so ordering is deterministic.
       SELECT DISTINCT ON (start_id) start_id AS project_id, cur_id AS root_id, cur_title AS root_title
         FROM walk
        ORDER BY start_id, depth DESC
     )
     SELECT * FROM (
       SELECT
         e.id::text AS id,
         'audit'::text AS kind,
         e.project_id,
         p.title AS project_title,
         p.type AS project_type,
         r.root_id AS root_epic_id,
         r.root_title AS root_epic_title,
         e.user_id,
         u.name AS user_name,
         e.action,
         e.field,
         e.from_value,
         e.to_value,
         e."timestamp" AS occurred_at,
         COALESCE(sl.is_archive, FALSE) AS in_archive
       FROM project_audit_events e
       JOIN projects p ON p.id = e.project_id
       JOIN roots r ON r.project_id = p.id
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND e."timestamp" >= NOW() - ($2::int * INTERVAL '1 day')
         AND e.action <> 'move'
         ${hiddenLaneClause}
       UNION ALL
       SELECT
         sh.id::text AS id,
         'move'::text AS kind,
         sh.project_id,
         p.title AS project_title,
         p.type AS project_type,
         r.root_id AS root_epic_id,
         r.root_title AS root_epic_title,
         sh.moved_by_user_id AS user_id,
         u.name AS user_name,
         'move'::text AS action,
         'swim_lane_id'::text AS field,
         to_jsonb(sh.from_swim_lane_id) AS from_value,
         to_jsonb(sh.to_swim_lane_id) AS to_value,
         sh."timestamp" AS occurred_at,
         COALESCE(sl.is_archive, FALSE) AS in_archive
       FROM status_history sh
       JOIN projects p ON p.id = sh.project_id
       JOIN roots r ON r.project_id = p.id
       LEFT JOIN users u ON u.id = sh.moved_by_user_id
       LEFT JOIN swim_lanes sl ON sl.id = p.swim_lane_id
       WHERE p.group_id = $1
         AND p.deleted_at IS NULL
         AND sh."timestamp" >= NOW() - ($2::int * INTERVAL '1 day')
         AND sh.from_swim_lane_id IS NOT NULL
         ${hiddenLaneClause}
     ) combined
     ORDER BY occurred_at DESC
     LIMIT $3`,
    [groupId, days, RECENT_EVENTS_CAP + 1],
  );

  const truncated = rows.length > RECENT_EVENTS_CAP;
  const events = truncated ? rows.slice(0, RECENT_EVENTS_CAP) : rows;
  res.json({ events, days, truncated });
});

/**
 * Unified timeline: lane movements (from `status_history`) merged with
 * per-field edits, creates, archives, and restores (from
 * `project_audit_events`), normalized to a single row shape and sorted
 * ascending. The frontend renders each row as one line in the audit
 * trail without caring which underlying table it came from.
 */
projectsRouter.get("/:id/history", async (req, res) => {
  // Verify the project actually belongs to this tenant BEFORE
  // dumping its timeline; without this check a stray UUID guess
  // would leak audit rows from another group.
  const { rows: ownership } = await query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND group_id = $2`,
    [req.params.id, req.groupId!],
  );
  if (!ownership[0]) throw new HttpError(404, "project not found");
  const { rows } = await query<TimelineEntryRow>(
    `SELECT id, project_id, moved_by_user_id AS user_id, "timestamp",
            'move'::text AS kind,
            from_swim_lane_id, to_swim_lane_id,
            NULL::text AS field, NULL::jsonb AS from_value, NULL::jsonb AS to_value
       FROM status_history
      WHERE project_id = $1
     UNION ALL
     SELECT id, project_id, user_id, "timestamp",
            action AS kind,
            NULL::uuid AS from_swim_lane_id, NULL::uuid AS to_swim_lane_id,
            field, from_value, to_value
       FROM project_audit_events
      WHERE project_id = $1
      ORDER BY "timestamp" ASC`,
    [req.params.id],
  );
  res.json(rows);
});

// -----------------------------------------------------------------
// AI phase-size estimator (Claude Sonnet 4.5 by default).
//
// GET  /projects/:id/ai-estimate  → cached suggestion (viewers OK)
// POST /projects/:id/ai-estimate  → generate a fresh one (writers only)
// GET  /projects/ai-estimator/health  → is the feature configured?
//
// The POST endpoint is the ONLY code path that touches Anthropic.
// No boot-time health check, no background pings — an unconfigured
// deploy stays quiet until a user clicks Suggest, at which point
// the endpoint returns 503 with a self-serve remediation hint.
// -----------------------------------------------------------------

/**
 * Per-tenant soft rate limit for the POST endpoint. Fixed-window
 * counter kept in process memory, same shape as the login limiter
 * in routes/auth.ts. 60 requests per minute is generous for
 * interactive use (a PM clicks Suggest a handful of times an hour)
 * and tight enough that a runaway client can't burn a workspace's
 * Anthropic budget in seconds.
 *
 * Deliberately per-machine: Fly runs a small number of instances
 * so a determined attacker can multiply the cap by machine count,
 * but that's still bounded and we get log-visible 429s well before
 * any real damage.
 */
const AI_WINDOW_MS = 60_000;
const AI_MAX_PER_WINDOW = 60;
type AiRateBucket = { count: number; resetAt: number };
const aiRateBuckets = new Map<string, AiRateBucket>();

function checkAndBumpAiRate(groupId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cur = aiRateBuckets.get(groupId);
  if (!cur || cur.resetAt <= now) {
    aiRateBuckets.set(groupId, { count: 1, resetAt: now + AI_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (cur.count >= AI_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: Math.max(0, cur.resetAt - now) };
  }
  cur.count++;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Difference in whole days between two YYYY-MM-DD ISO strings.
 * Returns null if either input is missing so the caller can skip
 * a phase whose bounds aren't both persisted.
 */
function daysBetweenIso(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Row shape returned by the few-shot SELECT. Kept local to the
 * ai-estimate endpoints since no other consumer needs it.
 */
type FewShotProjectRow = {
  id: string;
  title: string;
  description: string | null;
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
};

/** Cap on the combined curated + historical few-shot pool. Reference
 *  rows always land first; historical rows fill any remaining slots.
 *  30 keeps token cost bounded while still leaving room for a large
 *  curated catalog and a handful of engineer-confirmed analogs. */
const FEW_SHOT_TOTAL_CAP = 30;
/** Upper bound on historical rows considered before capping. */
const HISTORICAL_QUERY_LIMIT = 30;

/**
 * Load ALL curated reference estimates for the tenant, ordered by
 * position. Caller is responsible for capping the union of curated
 * + historical to FEW_SHOT_TOTAL_CAP.
 *
 * A curator's `notes` string is passed through so the prompt can
 * render it inline as a `# Notes:` hint — Claude weighs the
 * commentary alongside the numbers.
 */
async function loadCuratedReferenceExamples(
  groupId: string,
  tshirts: TshirtBucket[],
): Promise<FewShotExample[]> {
  const { rows } = await query<{
    title: string;
    description: string;
    discovery_days: number | null;
    development_days: number | null;
    post_dev_days: number | null;
    notes: string | null;
  }>(
    `SELECT title, description, discovery_days, development_days,
            post_dev_days, notes
       FROM ai_reference_estimates
      WHERE group_id = $1
      ORDER BY position ASC, created_at ASC`,
    [groupId],
  );

  return rows.map((r) => {
    const phases: FewShotExample["phases"] = {};
    if (r.discovery_days != null) {
      phases.discovery = {
        actual_days: r.discovery_days,
        nearest_size: nearestSizeLabel(r.discovery_days, tshirts),
      };
    }
    if (r.development_days != null) {
      phases.development = {
        actual_days: r.development_days,
        nearest_size: nearestSizeLabel(r.development_days, tshirts),
      };
    }
    if (r.post_dev_days != null) {
      phases.post_dev = {
        actual_days: r.post_dev_days,
        nearest_size: nearestSizeLabel(r.post_dev_days, tshirts),
      };
    }
    return {
      title: r.title,
      description: r.description ?? "",
      phases,
      notes: r.notes ?? null,
    };
  });
}

/**
 * Load up to HISTORICAL_QUERY_LIMIT recently-completed local
 * projects whose dev estimate was flagged as confirmed by
 * engineering. Selection criteria:
 *
 *   * Same tenant as the target.
 *   * NOT the target itself (excluded by id).
 *   * `dev_estimate_sourced_by_dev = TRUE` — only PMs+eng-vetted
 *     estimates make the prompt now; the previous "any completed
 *     project" heuristic pulled in a lot of stale guesses.
 *   * Not soft-deleted.
 *   * ALL of start_date, dev_end_date, optimization_end_date set
 *     — those three "end anchor" columns are the minimum coverage
 *     needed to say a project genuinely shipped. Missing
 *     intermediate columns don't disqualify the row; the matching
 *     phase is simply omitted from `phases` if its interior bound
 *     is null.
 *
 * Ordered by actual_completion_date DESC (falling back to
 * updated_at DESC) so the most recently-shipped work leads the
 * list — same mental model the PM has.
 */
async function loadHistoricalConfirmedExamples(
  groupId: string,
  excludeProjectId: string,
  tshirts: TshirtBucket[],
): Promise<FewShotExample[]> {
  const { rows } = await query<FewShotProjectRow>(
    `SELECT id, title, description,
            start_date::text, target_date::text,
            dev_start_date::text, dev_end_date::text,
            optimization_start_date::text, optimization_end_date::text
       FROM projects p
      WHERE p.group_id = $1
        AND p.id <> $2
        AND p.deleted_at IS NULL
        AND p.dev_estimate_sourced_by_dev = TRUE
        AND p.start_date IS NOT NULL
        AND p.dev_end_date IS NOT NULL
        AND p.optimization_end_date IS NOT NULL
      ORDER BY p.actual_completion_date DESC NULLS LAST,
               p.updated_at DESC
      LIMIT $3`,
    [groupId, excludeProjectId, HISTORICAL_QUERY_LIMIT],
  );

  return rows.map((r) => {
    const phases: FewShotExample["phases"] = {};

    const discoveryDays = daysBetweenIso(r.start_date, r.target_date);
    if (discoveryDays != null) {
      phases.discovery = {
        actual_days: discoveryDays,
        nearest_size: nearestSizeLabel(discoveryDays, tshirts),
      };
    }
    const devDays = daysBetweenIso(r.dev_start_date, r.dev_end_date);
    if (devDays != null) {
      phases.development = {
        actual_days: devDays,
        nearest_size: nearestSizeLabel(devDays, tshirts),
      };
    }
    const postDevDays = daysBetweenIso(
      r.optimization_start_date,
      r.optimization_end_date,
    );
    if (postDevDays != null) {
      phases.post_dev = {
        actual_days: postDevDays,
        nearest_size: nearestSizeLabel(postDevDays, tshirts),
      };
    }

    return {
      title: r.title,
      description: r.description ?? "",
      phases,
    };
  });
}

/**
 * Load the T-shirt catalog for the current tenant, sorted by
 * position. Used by both the estimator prompt and the response
 * validator. Reuses the same table the /tshirt-sizes router reads
 * from so a relabel/re-size in Admin → T-Shirt Sizes flows into
 * every future suggestion immediately.
 */
async function loadTshirtBuckets(groupId: string): Promise<TshirtBucket[]> {
  const { rows } = await query<TshirtSizeRow>(
    `SELECT * FROM tshirt_sizes WHERE group_id = $1 ORDER BY position ASC`,
    [groupId],
  );
  return rows.map((r) => ({ label: r.label, days: r.days }));
}

/**
 * Load the tenant's display name. Small enough to inline without a
 * dedicated helper elsewhere; used only by the estimator so the
 * system prompt reads "the {name} team's roadmap tool" rather
 * than the generic filler.
 */
async function loadGroupName(groupId: string): Promise<string> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM groups WHERE id = $1`,
    [groupId],
  );
  return rows[0]?.name ?? "your";
}

/**
 * Health-check: does the current deploy have an Anthropic key
 * configured? Intentionally does NOT probe Anthropic — a live
 * dependency check would add latency to every admin-page load and
 * count against the workspace's rate limit. Reads config only.
 */
projectsRouter.get("/ai-estimator/health", (_req, res) => {
  res.json({
    configured: !!config.anthropic.apiKey,
    model: config.anthropic.apiKey ? config.anthropic.model : null,
  });
});

/**
 * GET the cached AI suggestion (if any). Available to any role
 * with read access — viewers see whatever the last writer generated
 * without spending a token themselves. Returns `{ suggestion: null }`
 * when nothing has ever been generated for this project.
 */
projectsRouter.get("/:id/ai-estimate", async (req, res) => {
  const isAdmin = req.userGroupRole === "admin";
  const clauses = ["p.id = $1", "p.group_id = $2"];
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const { rows } = await query<{
    ai_suggestion: unknown | null;
    ai_suggested_at: Date | null;
  }>(
    `SELECT ai_suggestion, ai_suggested_at
       FROM projects p
      WHERE ${clauses.join(" AND ")}`,
    [req.params.id, req.groupId!],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  const row = rows[0];
  if (!row.ai_suggestion) {
    res.json({ suggestion: null, cached: true, generated_at: null });
    return;
  }
  res.json({
    suggestion: row.ai_suggestion,
    cached: true,
    generated_at: row.ai_suggested_at,
  });
});

/**
 * POST — generate a fresh Claude suggestion, persist it, return it.
 *
 * Failure surface (all with informative messages the popover can
 * render verbatim):
 *   * 503 — ANTHROPIC_API_KEY is not set on the server. Admin needs
 *          to `fly secrets set ANTHROPIC_API_KEY=...`.
 *   * 429 — per-tenant rate limit tripped (60/min).
 *   * 502 — Anthropic call failed (upstream 5xx / timeout) OR the
 *          response was successful but the payload was malformed.
 *          Nothing is persisted in either case so a stale-but-good
 *          cached suggestion isn't clobbered by junk.
 *   * 404 — project not found in this tenant (defensive; groupScope
 *          + soft-delete guard already narrows this).
 */
projectsRouter.post("/:id/ai-estimate", requireWrite, async (req, res) => {
  if (!config.anthropic.apiKey) {
    res.status(503).json({
      error: "AI estimator not configured — set ANTHROPIC_API_KEY in Fly secrets",
    });
    return;
  }

  const groupId = req.groupId!;
  const projectId = String(req.params.id);

  // Rate-limit BEFORE loading the target so a hostile client can't
  // burn DB time cycling on 429s. Emit Retry-After so browsers /
  // fetch retries pace themselves.
  const rate = checkAndBumpAiRate(groupId);
  if (!rate.allowed) {
    res.setHeader("Retry-After", Math.ceil(rate.retryAfterMs / 1000).toString());
    res.status(429).json({
      error: `AI estimator rate limit reached for this workspace (${AI_MAX_PER_WINDOW}/min). Try again shortly.`,
    });
    return;
  }

  // Target project must exist in the caller's tenant and not be
  // soft-deleted. Non-admins additionally can't estimate cards
  // living in admin-only lanes — matches the read visibility rules
  // used on GET /projects/:id.
  const isAdmin = req.userGroupRole === "admin";
  const targetClauses = ["p.id = $1", "p.group_id = $2", "p.deleted_at IS NULL"];
  if (!isAdmin) targetClauses.push(HIDDEN_LANE_CLAUSE);
  const { rows: targetRows } = await query<{
    id: string;
    title: string;
    description: string;
  }>(
    `SELECT id, title, description
       FROM projects p
      WHERE ${targetClauses.join(" AND ")}`,
    [projectId, groupId],
  );
  const target = targetRows[0];
  if (!target) throw new HttpError(404, "project not found");

  const [tshirts, groupName] = await Promise.all([
    loadTshirtBuckets(groupId),
    loadGroupName(groupId),
  ]);
  if (tshirts.length === 0) {
    res.status(502).json({
      error: "estimator failed",
      detail: "no T-shirt sizes are configured for this workspace",
    });
    return;
  }

  // Curated reference estimates land first (highest priority);
  // engineer-confirmed historical projects fill any remaining
  // slots up to FEW_SHOT_TOTAL_CAP. If BOTH sources are empty
  // buildUserPrompt still generates a valid prompt with a
  // "no historical data available — best-effort" note.
  const [curatedAll, historicalAll] = await Promise.all([
    loadCuratedReferenceExamples(groupId, tshirts),
    loadHistoricalConfirmedExamples(groupId, projectId, tshirts),
  ]);
  const curated = curatedAll.slice(0, FEW_SHOT_TOTAL_CAP);
  const historicalCap = Math.max(0, FEW_SHOT_TOTAL_CAP - curated.length);
  const historical = historicalAll.slice(0, historicalCap);

  let suggestion: AiSuggestion;
  try {
    suggestion = await generateSuggestion({
      tenantName: groupName,
      tshirts,
      curated,
      historical,
      target: { title: target.title, description: target.description },
    });
  } catch (err) {
    const detail =
      err instanceof AiEstimatorParseError
        ? err.message
        : err instanceof Error
        ? err.message
        : "unknown error";
    console.error("[ai-estimator] generation failed", err);
    res.status(502).json({ error: "estimator failed", detail });
    return;
  }

  await query(
    `UPDATE projects
        SET ai_suggestion = $1::jsonb,
            ai_suggested_at = NOW(),
            updated_at = NOW()
      WHERE id = $2 AND group_id = $3`,
    [JSON.stringify(suggestion), projectId, groupId],
  );

  res.json({ suggestion, cached: false });
});

// Re-export a couple of estimator helpers for tests / hand-inspection
// in local dev. Not part of the HTTP surface — imported directly by
// scripts that want to eyeball a prompt without spending a token.
export { buildUserPrompt, PHASE_KEYS };
export type { PhaseKey };
