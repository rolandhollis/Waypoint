BEGIN;

-- Per-project position on the project_teams join table.
--
-- Until now the join carried only (project_id, team_id) and every
-- caller that rendered team chips fell back to the workspace-level
-- team `"order"` for display ordering. PMs asked for the ability to
-- rank the teams *on their own project* the way they can rank KPIs
-- ("Martech is the primary team on this initiative; Growth is a
-- secondary contributor") and to have that ordering reflected on
-- the Board card, roadmap accent, KPI report, sort-lane modal, etc.
--
-- Mirrors the `project_kpis.position` design in migration 014:
--   * `position` is a per-project sequence used to ORDER BY when
--     hydrating a project's `teams` array.
--   * A UNIQUE index on (project_id, position) keeps any two rows
--     in the same project from claiming the same slot.
--   * The application layer (replaceProjectTeams) full-replaces the
--     set on every write, so gaps introduced by an admin deleting
--     a team (CASCADE removes the rows) heal the next time a PM
--     saves that project. `array_agg ... ORDER BY position` produces
--     the correct visible order either way.
--
-- Backfill picks a deterministic starting order: sort by the team's
-- catalog `"order"` (then name as tiebreaker) so the initial ranking
-- matches what users saw before this migration ran — no visible
-- reshuffle on deploy. From that point on, PMs own the order.

ALTER TABLE project_teams
  ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT pt.project_id,
         pt.team_id,
         ROW_NUMBER() OVER (
           PARTITION BY pt.project_id
           ORDER BY t."order" ASC, t.name ASC, pt.team_id ASC
         ) - 1 AS pos
    FROM project_teams pt
    JOIN teams t ON t.id = pt.team_id
)
UPDATE project_teams pt
   SET position = ranked.pos
  FROM ranked
 WHERE pt.project_id = ranked.project_id
   AND pt.team_id    = ranked.team_id;

-- Once positions are backfilled, drop the temporary DEFAULT so
-- future INSERTs must supply a position explicitly (matches
-- project_kpis and prevents accidental "everyone's at 0" writes).
ALTER TABLE project_teams
  ALTER COLUMN position DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS project_teams_project_position_idx
  ON project_teams (project_id, position);

COMMIT;
