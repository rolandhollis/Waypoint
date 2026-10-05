-- A/B Testing board: kanban with fixed workflow stages (not person columns).
-- Stages: backlog → discovery_design → ready → in_test → complete.

CREATE TABLE IF NOT EXISTS ab_test_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name              VARCHAR(256) NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  team_id           UUID REFERENCES teams(id) ON DELETE SET NULL,
  lane_key          TEXT NOT NULL DEFAULT 'backlog'
                    CHECK (lane_key IN (
                      'backlog',
                      'discovery_design',
                      'ready',
                      'in_test',
                      'complete'
                    )),
  jira_key          VARCHAR(64),
  links             JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_date          DATE,
  is_blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason    TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ab_test_items_group_lane_idx
  ON ab_test_items (group_id, lane_key, position)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ab_test_items_group_deleted_idx
  ON ab_test_items (group_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ab_test_item_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ab_test_item_id UUID NOT NULL REFERENCES ab_test_items(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  field           TEXT,
  from_value      JSONB,
  to_value        JSONB,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ab_test_item_audit_item_idx
  ON ab_test_item_audit_events (ab_test_item_id, timestamp DESC);
