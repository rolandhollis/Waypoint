-- Manageable A/B Testing swim lanes (add / rename / delete / reorder).
-- Replaces the hardcoded lane_key enum on ab_test_items.

CREATE TABLE IF NOT EXISTS ab_test_board_lanes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name         VARCHAR(256) NOT NULL,
  "order"      INTEGER NOT NULL DEFAULT 0,
  is_terminal  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ab_test_board_lanes_group_order_idx
  ON ab_test_board_lanes (group_id, "order");

-- Seed the default pipeline for every existing group.
INSERT INTO ab_test_board_lanes (group_id, name, "order", is_terminal)
SELECT g.id, d.name, d.ord, d.is_terminal
  FROM groups g
  CROSS JOIN (
    VALUES
      ('Backlog (ideas)', 0, FALSE),
      ('Prioritized (next in the queue for Scoping & Hypothesis)', 1, FALSE),
      ('Design', 2, FALSE),
      ('Ready to build', 3, FALSE),
      ('In Development', 4, FALSE),
      ('Live', 5, FALSE),
      ('End', 6, FALSE),
      ('Analysis', 7, FALSE),
      ('Cross-team signoffs', 8, FALSE),
      ('Complete/Archive', 9, TRUE)
  ) AS d(name, ord, is_terminal)
 WHERE NOT EXISTS (
   SELECT 1 FROM ab_test_board_lanes l WHERE l.group_id = g.id
 );

ALTER TABLE ab_test_items
  ADD COLUMN IF NOT EXISTS lane_id UUID REFERENCES ab_test_board_lanes(id) ON DELETE RESTRICT;

-- Map leftover enum keys onto the new named columns.
UPDATE ab_test_items i
   SET lane_id = l.id
  FROM ab_test_board_lanes l
 WHERE i.group_id = l.group_id
   AND i.lane_id IS NULL
   AND (
     (i.lane_key = 'backlog' AND l.name = 'Backlog (ideas)')
     OR (i.lane_key = 'discovery_design' AND l.name = 'Design')
     OR (i.lane_key = 'ready' AND l.name = 'Ready to build')
     OR (i.lane_key = 'in_test' AND l.name = 'In Development')
     OR (i.lane_key = 'complete' AND l.name = 'Complete/Archive')
   );

-- Anything still unmapped lands in the group's first column.
UPDATE ab_test_items i
   SET lane_id = (
     SELECT l.id FROM ab_test_board_lanes l
      WHERE l.group_id = i.group_id
      ORDER BY l."order" ASC
      LIMIT 1
   )
 WHERE i.lane_id IS NULL;

ALTER TABLE ab_test_items
  ALTER COLUMN lane_id SET NOT NULL;

DROP INDEX IF EXISTS ab_test_items_group_lane_idx;

CREATE INDEX IF NOT EXISTS ab_test_items_group_lane_id_idx
  ON ab_test_items (group_id, lane_id, position)
  WHERE deleted_at IS NULL;

ALTER TABLE ab_test_items DROP COLUMN IF EXISTS lane_key;
