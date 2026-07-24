-- @mentions on project comments and descriptions.
--
-- The mention itself lives INLINE in the parent text (comment.body /
-- projects.description) as a stable token — `@[Display Name](user:UUID)`
-- — so no data migration or offsets column is needed. This table is a
-- side-channel index of "who was tagged where", kept in sync by the
-- routes/comments.ts and routes/projects.ts handlers on every write.
--
-- Emails are sent only for *newly-added* mentions on each save (the
-- handler diffs the parsed mention set against the prior body); this
-- table gets a row per newly-added mention so support / audit / a
-- future in-app notification center can query historical tags without
-- re-parsing every comment body.
--
-- All FKs cascade to project / user / group so a deleted user or
-- project drops its mention trail with it; no orphan rows.

BEGIN;

CREATE TABLE IF NOT EXISTS mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mentioned_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentioning_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('comment','description')),
  -- Nullable so description mentions (which have no separate row id)
  -- can share the table with comment mentions cleanly.
  source_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed the "what was I tagged on lately" lookup (per-user timeline).
CREATE INDEX IF NOT EXISTS mentions_mentioned_user_idx
  ON mentions (mentioned_user_id, created_at DESC);

-- Feed the per-project "who has been tagged here" lookup, useful for
-- future in-app notification-center features + admin audits.
CREATE INDEX IF NOT EXISTS mentions_project_idx
  ON mentions (project_id);

COMMIT;
