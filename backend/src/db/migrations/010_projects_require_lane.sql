-- Every project must live in a swim lane. The board, roadmap, and
-- status-report views all key on `swim_lane_id`, and PMs previously
-- reported that the "Unassigned" column was confusing since it never
-- corresponded to a real bucket in their process.
--
-- 1. Backfill any historical NULL swim_lane_id to a sensible lane —
--    prefer the admin-picked default_new lane, else the first
--    non-terminal lane, else the first lane at all.
-- 2. Once the table is clean, add NOT NULL to prevent regressions.
--
-- If a workspace somehow has projects but zero swim lanes, this
-- migration will fail loudly on the NOT NULL step; an admin must
-- create at least one lane before it can complete.

UPDATE projects
   SET swim_lane_id = (
     SELECT id FROM swim_lanes
      ORDER BY is_default_new DESC,
               is_terminal ASC,
               "order" ASC
      LIMIT 1
   ),
   updated_at = NOW()
 WHERE swim_lane_id IS NULL
   AND EXISTS (SELECT 1 FROM swim_lanes);

ALTER TABLE projects
  ALTER COLUMN swim_lane_id SET NOT NULL;
