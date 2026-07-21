import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireWrite } from "../middleware/auth.js";

/**
 * `/api/roadmap-overviews/:fingerprint` — small key/value store for
 * the PM-authored overview text shown at the top of the Roadmap
 * view.
 *
 * The `:fingerprint` path parameter is a stable per-view key derived
 * on the frontend (see `frontend/src/lib/roadmapHeadline.ts` — the
 * same hash the AI Roadmap Headline feature uses so both features
 * key off the exact same "view state"). The server treats it as
 * opaque: any changes to what goes into the hash are a
 * frontend-only concern.
 *
 * Group scope is resolved from the caller's active group by the
 * `groupScope` middleware that mounts this router (see
 * backend/src/index.ts) — no group id in the URL because a user
 * can only see the overview for the group they're currently in.
 *
 *   * GET  — any authenticated group member. Returns the row for
 *           the current (group, fingerprint) pair, or an "empty"
 *           envelope when no overview has been saved yet.
 *   * PUT  — write-role only (owner/admin). Upserts the body; if
 *           the body trims to an empty string, the row is deleted
 *           so "absent === empty" is the invariant the GET handler
 *           can lean on.
 *
 * There's no audit trail on this table (see migration 036) — the
 * overview isn't a project field, and the `updated_by` /
 * `updated_at` columns on the row itself are the full change
 * record the UI needs.
 */
export const roadmapOverviewsRouter = Router();

const putSchema = z.object({
  body: z.string().max(20_000),
});

const fingerprintSchema = z.string().min(1).max(256);

type OverviewResponse = {
  body: string;
  updated_at: string | null;
  updated_by_name: string | null;
};

const EMPTY_RESPONSE: OverviewResponse = {
  body: "",
  updated_at: null,
  updated_by_name: null,
};

type OverviewRow = {
  body: string;
  updated_at: Date;
  updated_by_name: string | null;
};

async function loadOverview(
  groupId: string,
  fingerprint: string,
): Promise<OverviewResponse> {
  const { rows } = await query<OverviewRow>(
    `SELECT o.body,
            o.updated_at,
            u.name AS updated_by_name
       FROM roadmap_overviews o
       LEFT JOIN users u ON u.id = o.updated_by
      WHERE o.group_id = $1 AND o.fingerprint = $2`,
    [groupId, fingerprint],
  );
  const row = rows[0];
  if (!row) return EMPTY_RESPONSE;
  return {
    body: row.body,
    updated_at: row.updated_at.toISOString(),
    updated_by_name: row.updated_by_name,
  };
}

roadmapOverviewsRouter.get("/:fingerprint", async (req, res) => {
  const parsed = fingerprintSchema.safeParse(req.params.fingerprint);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid fingerprint" });
    return;
  }
  const overview = await loadOverview(req.groupId!, parsed.data);
  res.json(overview);
});

roadmapOverviewsRouter.put("/:fingerprint", requireWrite, async (req, res) => {
  const parsedFp = fingerprintSchema.safeParse(req.params.fingerprint);
  if (!parsedFp.success) {
    res.status(400).json({ error: "invalid fingerprint" });
    return;
  }
  const fingerprint = parsedFp.data;
  const groupId = req.groupId!;
  const body = putSchema.parse(req.body).body.trim();

  if (body === "") {
    // Empty body === "no overview saved for this fingerprint". We
    // delete the row so the GET handler's "absent === empty"
    // invariant stays true without a `WHERE body <> ''` on every
    // read.
    await query(
      `DELETE FROM roadmap_overviews WHERE group_id = $1 AND fingerprint = $2`,
      [groupId, fingerprint],
    );
    res.json(EMPTY_RESPONSE);
    return;
  }

  // Upsert on the (group_id, fingerprint) unique constraint from
  // migration 036. `updated_at` is stamped explicitly so a re-save
  // of an unchanged body still moves the timestamp forward (the
  // UI's "Updated by X · 3m ago" footer would otherwise stall).
  await query(
    `INSERT INTO roadmap_overviews (group_id, fingerprint, body, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (group_id, fingerprint)
     DO UPDATE SET body = EXCLUDED.body,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
    [groupId, fingerprint, body, req.user!.id],
  );
  const overview = await loadOverview(groupId, fingerprint);
  res.json(overview);
});
