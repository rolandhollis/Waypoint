-- Project hierarchy: every card is either an epic (top-level) or a
-- subtask (child of another card, potentially nested to arbitrary
-- depth). Enforced by:
--
--   type           NOT NULL, one of ('epic', 'subtask').
--   parent_id      NOT NULL when type='subtask'; NULL when type='epic'
--                  (CHECK below). References projects(id); we do not
--                  ON DELETE CASCADE because the route layer blocks
--                  deletes of parents with active children so the
--                  intent is always explicit.
--
-- Cycle prevention (a project cannot be a descendant of itself) is
-- enforced in the write path — plain SQL FKs can't express the
-- transitive constraint cheaply and a trigger would silently accept
-- a stale write on rollback. See moveProjectImpl / patch in projects.ts.
--
-- All existing rows are backfilled as epics (parent_id = NULL). The
-- CHECK constraint is added after the backfill so the ALTER doesn't
-- reject legacy data with no `type` column value.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS parent_id UUID;

UPDATE projects SET type = 'epic' WHERE type IS NULL;

ALTER TABLE projects
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN type SET DEFAULT 'epic';

ALTER TABLE projects
  ADD CONSTRAINT projects_type_valid CHECK (type IN ('epic', 'subtask'));

ALTER TABLE projects
  ADD CONSTRAINT projects_parent_matches_type CHECK (
    (type = 'epic'    AND parent_id IS NULL) OR
    (type = 'subtask' AND parent_id IS NOT NULL)
  );

ALTER TABLE projects
  ADD CONSTRAINT projects_parent_fk
    FOREIGN KEY (parent_id) REFERENCES projects(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;

-- A subtask cannot be its own parent. Cheap CHECK; the deep-cycle
-- case (grandchild-of-self) still needs the app-level guard.
ALTER TABLE projects
  ADD CONSTRAINT projects_parent_not_self CHECK (parent_id IS DISTINCT FROM id);

-- Fast lookup for "give me all direct children of this project" —
-- the roadmap tree renders that query per epic, so an index pays off.
CREATE INDEX IF NOT EXISTS projects_parent_id_idx ON projects (parent_id);
