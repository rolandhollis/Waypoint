-- Generic per-field audit trail for projects. Complements the existing
-- `status_history` table (which tracks lane movements only) so the
-- detail-panel audit section can show *any* change a user made — title
-- edits, date shuffles, owner reassignment, team membership changes,
-- tag toggles, archive/restore, etc.
--
-- Design notes:
--   * One row per changed field. A PATCH touching three fields writes
--     three rows. Keeps individual entries small and rendering trivial.
--   * from_value / to_value are JSONB so we can uniformly stash strings,
--     arrays (teams/tags), or nulls without a discriminator column.
--   * `action` is a short string enum: 'create', 'edit', 'move',
--     'archive', 'restore'. Not a Postgres ENUM so we can add more
--     without a migration.

CREATE TABLE IF NOT EXISTS project_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  field TEXT,
  from_value JSONB,
  to_value JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_audit_events_project_ts_idx
  ON project_audit_events (project_id, "timestamp" DESC);
