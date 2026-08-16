-- Optional ZiffSplit assignment snapshot stamped onto audit rows when
-- EXPERIMENT_AUDIT_CONTEXT is enabled. Host-owned; not required by ZiffSplit.
ALTER TABLE project_audit_events
  ADD COLUMN IF NOT EXISTS experiment_context JSONB;

CREATE INDEX IF NOT EXISTS project_audit_events_experiment_context_gin
  ON project_audit_events USING GIN (experiment_context);
