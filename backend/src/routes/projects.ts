import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { ProjectAuditAction, ProjectRow, SwimLaneRow, TimelineEntryRow } from "../types.js";

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
 * Deep-ish equality check that treats arrays as unordered *sets* (used
 * for `teams` and `tags` — order isn't semantically meaningful there,
 * so `["a","b"] === ["b","a"]` and no audit event is written). Pass
 * `ordered = true` for fields where reorder itself is a meaningful
 * change (e.g. `kpis`, where the PM ranks their outcome buckets).
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

/** Audited fields for which array *order* is meaningful. */
const ORDERED_ARRAY_FIELDS = new Set<string>(["kpis"]);

/**
 * SELECT fragment that hydrates a project row with its `teams` and
 * `kpis` arrays. `teams` is unordered (order isn't meaningful there);
 * `kpis` is ordered by the per-project `position` column because the
 * PM ranks their KPI list left-to-right. The alias `p` must be used
 * for the FROM.
 */
const PROJECT_COLUMNS = `
  p.*,
  COALESCE(
    (SELECT array_agg(pt.team_id) FROM project_teams pt WHERE pt.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS teams,
  COALESCE(
    (SELECT array_agg(pk.kpi_id ORDER BY pk.position ASC)
       FROM project_kpis pk WHERE pk.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS kpis
`;

/**
 * Replace the full set of team memberships for a project. Used both by
 * POST (initial set) and PATCH (when the client sends a `teams` field).
 */
export async function replaceProjectTeams(client: PoolClient, projectId: string, teamIds: string[]) {
  await client.query(`DELETE FROM project_teams WHERE project_id = $1`, [projectId]);
  if (teamIds.length === 0) return;
  const values = teamIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO project_teams (project_id, team_id) VALUES ${values}`,
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
 * Enforce phase-boundary ordering across the four phase dates. Each field
 * is independently nullable ("not scheduled yet"), but any pair that IS
 * set must be non-decreasing left to right: start ≤ target ≤ devStart ≤
 * devEnd ≤ optStart ≤ optEnd. Missing intermediate anchors fall through
 * to whichever earlier field is available.
 */
export function validatePhaseDates(p: {
  start_date?: string | null;
  target_date?: string | null;
  dev_start_date?: string | null;
  dev_end_date?: string | null;
  optimization_start_date?: string | null;
  optimization_end_date?: string | null;
}) {
  const s = p.start_date ?? null;
  const t = p.target_date ?? null;
  const ds = p.dev_start_date ?? null;
  const de = p.dev_end_date ?? null;
  const os = p.optimization_start_date ?? null;
  const oe = p.optimization_end_date ?? null;

  if (s && t && t < s) throw new HttpError(400, "target_date must be on or after start_date");
  if (ds) {
    if (!t) throw new HttpError(400, "dev_start_date requires target_date to be set");
    if (ds < t) throw new HttpError(400, "dev_start_date must be on or after target_date");
  }
  if (de) {
    const anchor = ds ?? t;
    if (!anchor) throw new HttpError(400, "dev_end_date requires target_date to be set");
    if (de < anchor) throw new HttpError(400, "dev_end_date must be on or after the dev start");
  }
  if (os) {
    if (!de) throw new HttpError(400, "optimization_start_date requires dev_end_date to be set");
    if (os < de) throw new HttpError(400, "optimization_start_date must be on or after dev_end_date");
  }
  if (oe) {
    const anchor = os ?? de;
    if (!anchor) throw new HttpError(400, "optimization_end_date requires dev_end_date to be set");
    if (oe < anchor) throw new HttpError(400, "optimization_end_date must be on or after the optimization start");
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
) {
  if (nextType === "epic") {
    if (nextParentId != null) {
      throw new HttpError(400, "epics cannot have a parent — clear parent_id or set type to 'subtask'");
    }
    return;
  }
  // Subtask branch: must have a real, live parent that isn't itself
  // (direct self-loop caught here so error message is nice; the DB
  // CHECK is a redundant safety net).
  if (!nextParentId) {
    throw new HttpError(400, "subtasks require a parent_id");
  }
  if (nextParentId === selfId) {
    throw new HttpError(400, "a project cannot be its own parent");
  }
  const { rows: parentRows } = await client.query<{ id: string; deleted_at: Date | null }>(
    `SELECT id, deleted_at FROM projects WHERE id = $1`,
    [nextParentId],
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
});

/** Column names that live on the `projects` table itself (i.e. what the
 * projects UPDATE/INSERT can touch directly). `teams` is a virtual
 * column derived from the join, so it's excluded. */
const PROJECT_COLUMN_KEYS = [
  "title", "description", "swim_lane_id", "owner_id", "tags",
  "type", "parent_id",
  "start_date", "target_date", "dev_start_date", "dev_end_date",
  "optimization_start_date", "optimization_end_date",
] as const;

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
  const isAdmin = req.user?.role === "admin";
  const clauses: string[] = [];
  if (!includeDeleted) clauses.push("p.deleted_at IS NULL");
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p
       ${where}
       ORDER BY p.position ASC, p.created_at ASC`,
  );
  res.json(rows);
});

projectsRouter.get("/:id", async (req, res) => {
  const isAdmin = req.user?.role === "admin";
  const clauses = ["p.id = $1"];
  if (!isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
  const { rows } = await query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE ${clauses.join(" AND ")}`,
    [req.params.id],
  );
  if (!rows[0]) throw new HttpError(404, "project not found");
  res.json(rows[0]);
});

projectsRouter.post("/", requireWrite, async (req, res) => {
  const body = projectBaseSchema.parse(req.body);
  validatePhaseDates(body);
  const nextType = body.type ?? "epic";
  const nextParentId = body.parent_id ?? null;
  const result = await withTransaction(async (client) => {
    // Every project must live in a lane (migration 010 enforces this
    // at the DB level). If the client didn't pick one, fall back to
    // the admin-designated default_new lane; if no default is set
    // either, use the first non-terminal lane. Fail with a clear
    // 400 when the workspace has no lanes at all.
    let laneId = body.swim_lane_id ?? null;
    if (!laneId) {
      const { rows: laneRows } = await client.query<{ id: string }>(
        `SELECT id FROM swim_lanes
          ORDER BY is_default_new DESC,
                   is_terminal ASC,
                   "order" ASC
          LIMIT 1`,
      );
      laneId = laneRows[0]?.id ?? null;
      if (!laneId) throw new HttpError(400, "cannot create a project: no swim lanes exist yet");
    }

    // Verify (type, parent_id) is legal — subtask needs a real parent,
    // epic must not carry one. Runs before the INSERT so the DB CHECK
    // isn't the one surfacing errors to the user.
    await validateHierarchy(client, null, nextType, nextParentId);

    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
      [laneId],
    );
    const position = maxRows[0]?.next ?? 0;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects
         (title, description, swim_lane_id, position, owner_id, tags,
          type, parent_id,
          start_date, target_date, dev_start_date, dev_end_date,
          optimization_start_date, optimization_end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
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
        req.user!.id,
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
  // Movement is a separate endpoint that also writes status_history;
  // reject swim_lane_id changes here to keep the audit trail single-source.
  if (body.swim_lane_id !== undefined) {
    throw new HttpError(400, "use POST /projects/:id/move to change swim_lane_id");
  }
  const projectId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 FOR UPDATE`,
      [projectId],
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
      await validateHierarchy(client, projectId, effectiveType, effectiveParent);
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
  },
): Promise<ProjectRow> {
  const { rows: existingRows } = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE`,
    [args.projectId],
  );
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "project not found");

  const from = existing.swim_lane_id;
  const to = args.toLaneId;

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
  const result = await withTransaction((client) =>
    moveProjectImpl(client, {
      projectId: String(req.params.id),
      toLaneId: body.swim_lane_id,
      position: body.position,
      userId: req.user!.id,
    }),
  );
  res.json(result);
});

/**
 * Move a project into the workspace's archive lane. The lane's id is
 * resolved server-side so non-admins (who never see the lane in their
 * swim-lanes response) can still archive their own work with one click.
 */
projectsRouter.post("/:id/archive", requireWrite, async (req, res) => {
  const result = await withTransaction(async (client) => {
    const projectId = String(req.params.id);
    const { rows: laneRows } = await client.query<{ id: string }>(
      `SELECT id FROM swim_lanes WHERE is_archive = TRUE LIMIT 1`,
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
    });
  });
  res.json(result);
});

projectsRouter.delete("/:id", requireWrite, async (req, res) => {
  const projectId = String(req.params.id);
  const result = await withTransaction(async (client) => {
    // Block hard-delete of a parent that still has any live subtasks
    // — deleting the parent would either orphan or cascade, both of
    // which surprise. Force the caller to walk the tree bottom-up.
    await assertNoLiveSubtasks(client, projectId, "delete");
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [projectId],
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
  const result = await withTransaction(async (client) => {
    const { rows: updated } = await client.query<{ id: string }>(
      `UPDATE projects SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [projectId],
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
 * Unified timeline: lane movements (from `status_history`) merged with
 * per-field edits, creates, archives, and restores (from
 * `project_audit_events`), normalized to a single row shape and sorted
 * ascending. The frontend renders each row as one line in the audit
 * trail without caring which underlying table it came from.
 */
projectsRouter.get("/:id/history", async (req, res) => {
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
