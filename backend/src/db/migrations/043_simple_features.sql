-- Small initiatives (<16h) tracked outside the roadmap board.
-- Two active buckets (next_up, in_development) with manual ordering;
-- completed and deleted rows are soft-archived for audit.

CREATE TABLE IF NOT EXISTS simple_features (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name         VARCHAR(256) NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  team_id      UUID REFERENCES teams(id) ON DELETE SET NULL,
  needs_design BOOLEAN NOT NULL DEFAULT false,
  status       TEXT NOT NULL CHECK (status IN ('next_up', 'in_development', 'completed', 'deleted')),
  position     INTEGER NOT NULL DEFAULT 0,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS simple_features_group_status_idx
  ON simple_features (group_id, status, position);

CREATE INDEX IF NOT EXISTS simple_features_group_completed_idx
  ON simple_features (group_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS simple_features_group_deleted_idx
  ON simple_features (group_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
