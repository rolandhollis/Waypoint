-- Per-project "Key strategic item" flag.
--
-- A boolean marker the user can toggle from the item detail modal,
-- from the Prioritization Column A row, or (read-only) see rendered
-- next to Column B rows and Roadmap labels. Roadmap gets a new
-- "Key strategic only" filter chip that hides everything with this
-- flag set to false when enabled.
--
-- Partial index only covers the true rows since the vast majority of
-- projects will remain unflagged; scoped by group_id to match the
-- multi-tenant read pattern.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_key_strategic BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS projects_key_strategic_idx
  ON projects (group_id, is_key_strategic)
  WHERE is_key_strategic = true;

COMMIT;
