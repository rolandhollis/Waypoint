-- Feature groups: stakeholder-facing ranked feature lists for proposed projects.

CREATE TABLE IF NOT EXISTS feature_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name         VARCHAR(256) NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feature_groups_group_position_idx
  ON feature_groups (group_id, position);

CREATE TABLE IF NOT EXISTS feature_group_features (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_group_id  UUID NOT NULL REFERENCES feature_groups(id) ON DELETE CASCADE,
  name              VARCHAR(256) NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  priority_tier     TEXT NOT NULL CHECK (priority_tier IN ('P0', 'P1', 'P2', 'P3')),
  position          INTEGER NOT NULL DEFAULT 0,
  rank              INTEGER NOT NULL DEFAULT 0,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feature_group_features_group_tier_idx
  ON feature_group_features (feature_group_id, priority_tier, position);
