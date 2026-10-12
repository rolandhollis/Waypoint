-- Remove A/B Testing Parking Lot lanes. Move any cards into
-- Backlog (ideas) at the end of that column, then delete the lane.

-- Groups that have Parking Lot but no backlog-style lane: add Backlog first.
UPDATE ab_test_board_lanes l
   SET "order" = l."order" + 1,
       updated_at = NOW()
 WHERE EXISTS (
   SELECT 1 FROM ab_test_board_lanes p
    WHERE p.group_id = l.group_id AND lower(p.name) = 'parking lot'
 )
   AND NOT EXISTS (
   SELECT 1 FROM ab_test_board_lanes b
    WHERE b.group_id = l.group_id
      AND (lower(b.name) = 'backlog (ideas)' OR lower(b.name) LIKE 'backlog%')
 );

INSERT INTO ab_test_board_lanes (group_id, name, "order", is_terminal)
SELECT DISTINCT p.group_id, 'Backlog (ideas)', 0, FALSE
  FROM ab_test_board_lanes p
 WHERE lower(p.name) = 'parking lot'
   AND NOT EXISTS (
   SELECT 1 FROM ab_test_board_lanes b
    WHERE b.group_id = p.group_id
      AND (lower(b.name) = 'backlog (ideas)' OR lower(b.name) LIKE 'backlog%')
 );

-- Append active Parking Lot items onto Backlog.
WITH parking AS (
  SELECT id, group_id
    FROM ab_test_board_lanes
   WHERE lower(name) = 'parking lot'
),
backlog AS (
  SELECT DISTINCT ON (group_id) id, group_id
    FROM ab_test_board_lanes
   WHERE lower(name) = 'backlog (ideas)'
      OR lower(name) LIKE 'backlog%'
   ORDER BY group_id,
            CASE WHEN lower(name) = 'backlog (ideas)' THEN 0 ELSE 1 END,
            "order" ASC
),
base_pos AS (
  SELECT b.id AS backlog_id,
         b.group_id,
         COALESCE(
           (SELECT MAX(ai.position)
              FROM ab_test_items ai
             WHERE ai.group_id = b.group_id
               AND ai.lane_id = b.id
               AND ai.deleted_at IS NULL),
           -1
         ) AS max_pos
    FROM backlog b
),
moving AS (
  SELECT ai.id AS item_id,
         bp.backlog_id,
         bp.max_pos + ROW_NUMBER() OVER (
           PARTITION BY ai.group_id
           ORDER BY ai.position ASC, ai.created_at ASC
         ) AS new_pos
    FROM ab_test_items ai
    JOIN parking p ON p.id = ai.lane_id AND p.group_id = ai.group_id
    JOIN base_pos bp ON bp.group_id = ai.group_id
   WHERE ai.deleted_at IS NULL
)
UPDATE ab_test_items ai
   SET lane_id = m.backlog_id,
       position = m.new_pos,
       updated_at = NOW()
  FROM moving m
 WHERE ai.id = m.item_id;

-- Soft-deleted Parking Lot items: re-point so the lane can be dropped.
UPDATE ab_test_items ai
   SET lane_id = b.id,
       updated_at = NOW()
  FROM ab_test_board_lanes p,
       LATERAL (
         SELECT id
           FROM ab_test_board_lanes
          WHERE group_id = p.group_id
            AND (lower(name) = 'backlog (ideas)' OR lower(name) LIKE 'backlog%')
          ORDER BY CASE WHEN lower(name) = 'backlog (ideas)' THEN 0 ELSE 1 END,
                   "order" ASC
          LIMIT 1
       ) b
 WHERE ai.lane_id = p.id
   AND lower(p.name) = 'parking lot'
   AND ai.deleted_at IS NOT NULL;

DELETE FROM ab_test_board_lanes
 WHERE lower(name) = 'parking lot';
