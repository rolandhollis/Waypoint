-- Add dev_start_date: nullable date the PM expects Development (Phase 2) to
-- actually begin. NULL means "immediately when ready for dev" (i.e., dev
-- starts on target_date). When set, it must be >= target_date.

ALTER TABLE projects
  ADD COLUMN dev_start_date DATE;

ALTER TABLE projects
  ADD CONSTRAINT projects_dev_start_after_target
  CHECK (
    dev_start_date IS NULL
    OR (target_date IS NOT NULL AND dev_start_date >= target_date)
  );
