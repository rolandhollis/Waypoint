-- Allow public (unauthenticated) A/B test idea submissions with no
-- Waypoint user. created_by stays set for in-app creates.

ALTER TABLE ab_test_items
  ALTER COLUMN created_by DROP NOT NULL;
