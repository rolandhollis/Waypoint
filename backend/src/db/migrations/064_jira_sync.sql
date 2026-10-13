-- Automatic Waypoint ↔ Jira Software epic sync.
-- Structured Jira identity on projects + durable outbox for outbound writes.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS jira_key TEXT,
  ADD COLUMN IF NOT EXISTS jira_issue_id TEXT,
  ADD COLUMN IF NOT EXISTS jira_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS jira_sync_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS projects_jira_key_uidx
  ON projects (group_id, jira_key)
  WHERE jira_key IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_jira_issue_id_uidx
  ON projects (group_id, jira_issue_id)
  WHERE jira_issue_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS jira_sync_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'transition')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jira_sync_outbox_due_idx
  ON jira_sync_outbox (next_attempt_at ASC)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS jira_sync_outbox_project_idx
  ON jira_sync_outbox (project_id)
  WHERE processed_at IS NULL;
