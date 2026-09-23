-- Per-project "blocked" flag + free-text reason.
--
-- PMs can mark a roadmap item blocked from the detail panel
-- (stop-sign toggle). When blocked, the Gantt draws a small
-- stop-sign on the left edge of the development bar; hovering
-- it shows `blocked_reason`. Clearing the flag also clears the
-- reason on the write path (client sends null).

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS projects_blocked_idx
  ON projects (group_id, is_blocked)
  WHERE is_blocked = true;

COMMIT;
