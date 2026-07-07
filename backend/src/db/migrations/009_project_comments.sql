-- Free-form comment thread per project. Complements `project_audit_events`
-- (which captures the *what* of edits) with a human-authored *why* /
-- discussion channel visible in the detail panel.
--
-- Any authenticated user (including viewers) may post; only the author
-- or an admin may edit or delete. Comments cascade with the project
-- (hard delete → thread evaporates); users softly detach on deletion so
-- the thread keeps its content but shows "system" for missing authors.

CREATE TABLE IF NOT EXISTS project_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_comments_project_created_idx
  ON project_comments (project_id, created_at DESC);
