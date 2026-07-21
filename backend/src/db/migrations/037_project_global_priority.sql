-- Per-project global priority rank for the Prioritization view.
--
-- Adds a single INTEGER column on projects that carries the user's
-- explicit 1..N ordering of everything eligible for the Roadmap
-- (across teams / owners / swim lanes). Lower value = higher
-- priority. Multiple rows may share a value; ties break by
-- updated_at DESC then id ASC everywhere the column is read.
--
-- Default 0 so every existing row lands "unranked" -- the frontend
-- treats a group whose eligible items all share global_priority = 0
-- as "no ranking yet" and offers a one-shot seed from the current
-- display order. No backfill migration re-numbers old rows.
--
-- The Prioritization PUT endpoint additionally cascades the new
-- global order onto per-swim-lane `projects.position` values so
-- the Board's per-lane order and the Roadmap's Priority sort
-- (which reads swim_lane.order + projects.position) reflect the
-- user's global choice. See routes/prioritization.ts for the
-- cascade implementation.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS global_priority INTEGER NOT NULL DEFAULT 0;

-- Composite index matches the read pattern in GET /api/prioritization:
-- filter by group_id, order by global_priority ASC (then tiebreakers
-- served from the row body).
CREATE INDEX IF NOT EXISTS projects_global_priority_idx
  ON projects (group_id, global_priority);

COMMIT;
