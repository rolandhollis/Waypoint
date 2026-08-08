-- Design queue: kanban for design work, fed by the Design tab, roadmap
-- lanes flagged add_to_design_queue, and Simple Features with needs_design.

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS add_to_design_queue BOOLEAN NOT NULL DEFAULT FALSE;

-- Flag the canonical "Design" lane when present (case-insensitive).
UPDATE swim_lanes
   SET add_to_design_queue = TRUE
 WHERE name ILIKE 'design';

CREATE TABLE IF NOT EXISTS design_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name              VARCHAR(256) NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  team_id           UUID REFERENCES teams(id) ON DELETE SET NULL,
  source            VARCHAR(256) NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('next_up', 'in_design', 'completed', 'deleted')),
  position          INTEGER NOT NULL DEFAULT 0,
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
  simple_feature_id UUID REFERENCES simple_features(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS design_items_project_unique
  ON design_items (group_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS design_items_simple_feature_unique
  ON design_items (group_id, simple_feature_id)
  WHERE simple_feature_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS design_items_group_status_idx
  ON design_items (group_id, status, position);

CREATE INDEX IF NOT EXISTS design_items_group_completed_idx
  ON design_items (group_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS design_items_group_deleted_idx
  ON design_items (group_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
