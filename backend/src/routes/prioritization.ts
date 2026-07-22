import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { recordAudit } from "./projects.js";

/**
 * Global 1..N prioritization surface. Backs the "Prioritization"
 * top-level tab in the frontend.
 *
 * Eligibility ("qualifies for view on a roadmap") mirrors the
 * roadmap-inclusion predicate the RoadmapView / RoadmapHelper use:
 *
 *   * NOT soft-deleted (`deleted_at IS NULL`).
 *   * NOT in a swim lane flagged `is_archive`.
 *   * NOT in a swim lane whose name matches "parking lot" case-
 *     insensitively -- the same soft convention the roadmap /
 *     board / EZEstimates surfaces treat as "won't ship, don't
 *     rank".
 *   * NOT `hidden_from_roadmap` (the per-project opt-out
 *     migration 035 introduced).
 *   * Has all six phase dates set -- start_date, target_date,
 *     dev_start_date, dev_end_date, optimization_start_date,
 *     optimization_end_date. A partial-phase item shows up in the
 *     Roadmap's Unscheduled list, not on the timeline; the
 *     Prioritization tab is meant for properly-planned work, so
 *     the stricter "all six" gate is enforced here even though
 *     the RoadmapView's timeline draw predicate is more permissive.
 *
 * The PUT endpoint atomically rewrites `global_priority` for the
 * caller-supplied ordered id list AND cascades the resulting
 * order onto per-swim-lane `position` values so:
 *
 *   * Board (per-lane order) matches the user's global ranking
 *     within each lane.
 *   * Roadmap Priority-sort mode (swim_lane.order + position)
 *     tracks the user's global choice without a second write.
 *
 * See migration 037 for the column definition.
 */
export const prioritizationRouter = Router();

/**
 * SQL fragment that expresses roadmap-eligibility. Reused by both
 * GET (list eligible rows) and PUT (verify the caller's ordered
 * ids are still eligible before rewriting priorities). Aliased on
 * the `projects` table as `p`; the caller controls the JOIN on
 * swim_lanes if it needs one.
 *
 * IMPORTANT: keep this in lock-step with the frontend eligibility
 * filter in views/PrioritizationView.tsx. A drift here silently
 * lets rows slip in or out of the ranked list; the client-side
 * check is a UX affordance, this SQL is the source of truth.
 */
const ELIGIBILITY_FRAGMENT = `
  p.group_id = $1
  AND p.deleted_at IS NULL
  AND p.hidden_from_roadmap = FALSE
  AND p.start_date IS NOT NULL
  AND p.target_date IS NOT NULL
  AND p.dev_start_date IS NOT NULL
  AND p.dev_end_date IS NOT NULL
  AND p.optimization_start_date IS NOT NULL
  AND p.optimization_end_date IS NOT NULL
  AND (
    p.swim_lane_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM swim_lanes sl
      WHERE sl.id = p.swim_lane_id
        AND (sl.is_archive = TRUE OR LOWER(TRIM(sl.name)) = 'parking lot')
    )
  )
`;

/**
 * Row shape returned by GET /api/prioritization. Trimmed to the
 * fields the Prioritization view actually needs -- the ranked list
 * doesn't need the whole ProjectRow payload, and returning less
 * keeps the wire slim (this endpoint may be re-queried after every
 * drag, and the list can grow to hundreds of rows in a mature
 * workspace).
 */
export type PrioritizationRow = {
  id: string;
  title: string;
  description: string;
  team_ids: string[];
  team_names: string[];
  start_date: string;
  optimization_end_date: string;
  swim_lane_id: string | null;
  global_priority: number;
  position: number;
  is_key_strategic: boolean;
};

/**
 * Deterministic fingerprint of the current global ranking for a
 * group. Hashed in JS from `(id, global_priority)` pairs sorted by
 * `(global_priority ASC, id ASC)` so the value is stable across
 * concurrent reads and independent of any row's `updated_at` or
 * team-array shape.
 *
 * Both GET (unlocked read) and PUT (inside the FOR UPDATE
 * transaction) use this helper -- the PUT feeds it the just-locked
 * eligible rows so the version it recomputes is guaranteed to
 * match the state it's about to overwrite.
 */
function fingerprintEligible(
  pairs: ReadonlyArray<{ id: string; global_priority: number }>,
): string {
  const sorted = [...pairs].sort((a, b) => {
    if (a.global_priority !== b.global_priority) {
      return a.global_priority - b.global_priority;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const canonical = sorted.map((p) => `${p.id}:${p.global_priority}`).join(",");
  return createHash("sha1").update(canonical).digest("hex");
}

/**
 * Load `(id, global_priority)` for the FULL eligible set (no admin
 * filter) so GET and PUT compute the same fingerprint regardless of
 * caller role -- the admin-only-lane hiding rule affects what the
 * list renders, not what the ranking tracks. Called only from GET;
 * the PUT computes its fingerprint directly from the FOR UPDATE
 * result set so the read is consistent with the locked snapshot.
 */
async function loadEligibleForFingerprint(
  groupId: string,
): Promise<Array<{ id: string; global_priority: number }>> {
  const { rows } = await query<{ id: string; global_priority: number }>(
    `SELECT p.id, p.global_priority FROM projects p WHERE ${ELIGIBILITY_FRAGMENT}`,
    [groupId],
  );
  return rows;
}

prioritizationRouter.get("/", async (req, res) => {
  const groupId = req.groupId!;
  const isAdmin = req.userGroupRole === "admin";
  // Non-admins still can't see rows in admin-only lanes -- matches
  // the visibility rule GET /projects and GET /projects/:id enforce.
  const hiddenLaneClause = isAdmin
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM swim_lanes sl2
          WHERE sl2.id = p.swim_lane_id AND sl2.is_admin_only = TRUE
       )`;

  const { rows } = await query<PrioritizationRow>(
    `SELECT
        p.id,
        p.title,
        p.description,
        p.swim_lane_id,
        p.global_priority,
        p.position,
        p.is_key_strategic,
        to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
        to_char(p.optimization_end_date, 'YYYY-MM-DD') AS optimization_end_date,
        COALESCE(
          (SELECT array_agg(pt.team_id ORDER BY pt.position ASC)
             FROM project_teams pt WHERE pt.project_id = p.id),
          ARRAY[]::UUID[]
        ) AS team_ids,
        COALESCE(
          (SELECT array_agg(t.name ORDER BY pt.position ASC)
             FROM project_teams pt
             JOIN teams t ON t.id = pt.team_id
            WHERE pt.project_id = p.id),
          ARRAY[]::TEXT[]
        ) AS team_names
      FROM projects p
     WHERE ${ELIGIBILITY_FRAGMENT}
       ${hiddenLaneClause}
     ORDER BY p.global_priority ASC, p.updated_at DESC, p.id ASC`,
    [groupId],
  );
  // Version fingerprints the FULL eligible set (unaffected by the
  // admin-only-lane filter above) so GET and PUT always agree on
  // what "the ranking" is regardless of who's polling. A tiny race
  // window between the two SELECTs on GET is harmless -- the next
  // poll converges, and the PUT-side check is authoritative for
  // stale-write prevention.
  const fingerprintPairs = await loadEligibleForFingerprint(groupId);
  const version = fingerprintEligible(fingerprintPairs);
  res.json({ rows, version });
});

/**
 * PUT /api/prioritization
 *
 * Body: `{ ordered_ids: string[] }`. Ids MUST be a permutation of
 * the currently-eligible set for the caller's group -- a drift
 * check runs inside the transaction and 400s if the client is
 * working from a stale list (so a concurrent create/edit that
 * newly-adds or removes an eligible item is caught rather than
 * silently corrupting the rank). To recover, the client refetches
 * `["prioritization"]` and lets the user re-drop.
 *
 * Side effects, all in one transaction:
 *   1. `global_priority` on each row is set to its 1-based rank
 *      in `ordered_ids`.
 *   2. `position` within each swim lane is renumbered 0..k-1 in
 *      the order those lane members appear in the global list,
 *      so the Board's per-lane rank tracks the user's global
 *      choice.
 *   3. A single "global_priority" audit row is written per
 *      project whose `global_priority` actually changed. Uses the
 *      existing `project_audit_events` pipeline via recordAudit()
 *      so the timeline renderer picks the events up for free.
 */
const putSchema = z.object({
  ordered_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(10_000),
  /**
   * Fingerprint of the ranking the client believes it's editing.
   * Obtained from the last GET /api/prioritization response. If
   * this doesn't match the just-locked eligible set the PUT
   * aborts with 409 (STALE_PRIORITY_VERSION) and the client
   * refetches instead of overwriting a concurrent PM's work.
   */
  expected_version: z.string().min(1).max(128),
});

type PutOk = {
  kind: "ok";
  updated: number;
  audited: number;
  version: string;
};
type PutStale = {
  kind: "stale";
  currentVersion: string;
};

prioritizationRouter.put("/", requireWrite, async (req, res) => {
  const body = putSchema.parse(req.body);
  const groupId = req.groupId!;
  const userId = req.user!.id;

  const result = await withTransaction<PutOk | PutStale>(async (client) => {
    // Snapshot the currently-eligible set inside the same
    // transaction so a concurrent edit that flips eligibility
    // can't race the reorder. Lock the eligible rows FOR UPDATE
    // so a concurrent PUT is serialized on the same rows -- the
    // second writer sees the first's committed order before
    // running its drift check.
    const { rows: eligible } = await client.query<{
      id: string;
      swim_lane_id: string | null;
      global_priority: number;
    }>(
      `SELECT p.id, p.swim_lane_id, p.global_priority
         FROM projects p
        WHERE ${ELIGIBILITY_FRAGMENT}
        ORDER BY p.id ASC
        FOR UPDATE`,
      [groupId],
    );
    const eligibleById = new Map(eligible.map((r) => [r.id, r] as const));

    // Version check runs INSIDE the transaction against the
    // just-locked rows so a concurrent committed PUT is caught
    // before we overwrite it. Mismatch → return a `stale` sentinel
    // so the router can emit the documented 409 envelope; the
    // transaction commits harmlessly (no writes were issued yet)
    // and the FOR UPDATE locks release for the next writer.
    const currentVersion = fingerprintEligible(eligible);
    if (currentVersion !== body.expected_version) {
      return { kind: "stale", currentVersion };
    }

    // Dedupe defensively -- a stray render loop shouldn't corrupt
    // the sequence. First occurrence wins so the caller's
    // intended rank is preserved.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of body.ordered_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }

    // Every id the client sent must currently be eligible AND
    // every currently-eligible id must appear in the client's
    // list. Reject on drift -- the client refetches and retries.
    const foreign = ordered.filter((id) => !eligibleById.has(id));
    if (foreign.length) {
      throw new HttpError(
        400,
        `ids not in the current eligible set (may have been archived, hidden, or lost a phase date): ${foreign.join(", ")}`,
      );
    }
    const missing = eligible.filter((r) => !seen.has(r.id));
    if (missing.length) {
      throw new HttpError(
        400,
        `client list is missing ${missing.length} newly-eligible project${missing.length === 1 ? "" : "s"}; refetch and retry`,
      );
    }

    // Assign new global_priority (1..N) and cascade per-lane
    // position at the same time. We iterate the ordered list
    // once, keeping a per-lane nextPos counter so the k-th item
    // within its lane gets position=k-1. Unassigned-lane items
    // get no position write (they have no lane to sort within
    // on the Board).
    const lanePos = new Map<string, number>();
    let auditWrites = 0;
    for (let i = 0; i < ordered.length; i++) {
      const projectId = ordered[i]!;
      const newPriority = i + 1;
      const prior = eligibleById.get(projectId)!;
      const laneId = prior.swim_lane_id;
      const nextPos = laneId ? (lanePos.get(laneId) ?? 0) : null;
      if (laneId) lanePos.set(laneId, (lanePos.get(laneId) ?? 0) + 1);

      // Write global_priority and (when the row lives in a lane)
      // the cascaded position in a single UPDATE. `updated_at` is
      // NOT bumped here -- this is a pure ordering write; treating
      // it as a content change would make every drag noisy in the
      // Recent-changes feed. The audit event (below) is the
      // canonical record of the rank change.
      if (laneId) {
        await client.query(
          `UPDATE projects
              SET global_priority = $1,
                  position = $2
            WHERE id = $3`,
          [newPriority, nextPos, projectId],
        );
      } else {
        await client.query(
          `UPDATE projects SET global_priority = $1 WHERE id = $2`,
          [newPriority, projectId],
        );
      }

      if (prior.global_priority !== newPriority) {
        await recordAudit(client, {
          projectId,
          userId,
          action: "edit",
          field: "global_priority",
          from: prior.global_priority,
          to: newPriority,
        });
        auditWrites++;
      }
    }

    // Fresh fingerprint over the just-written eligible set. The
    // client caches this as its next `expected_version` so the
    // very next reorder (before a poll refetch lands) can still
    // race-check without a round-trip.
    const nextPairs = ordered.map((id, i) => ({ id, global_priority: i + 1 }));
    const newVersion = fingerprintEligible(nextPairs);
    return {
      kind: "ok",
      updated: ordered.length,
      audited: auditWrites,
      version: newVersion,
    };
  });

  if (result.kind === "stale") {
    res.status(409).json({
      code: "STALE_PRIORITY_VERSION",
      error: "ranking was updated by someone else; refetch and retry",
      currentVersion: result.currentVersion,
    });
    return;
  }
  res.json({
    ok: true,
    updated: result.updated,
    audited: result.audited,
    version: result.version,
  });
});
