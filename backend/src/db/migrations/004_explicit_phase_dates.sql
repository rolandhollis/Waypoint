-- Replace week-count estimates with explicit start/end dates for Development
-- and Post-Dev Optimization. Discovery already carries explicit dates
-- (start_date, target_date); the Immediately/Custom toggle for dev_start_date
-- is now handled purely in the UI defaults, so dev_start_date semantics are
-- unchanged (null still means "same day discovery ends").

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dev_end_date DATE,
  ADD COLUMN IF NOT EXISTS optimization_start_date DATE,
  ADD COLUMN IF NOT EXISTS optimization_end_date DATE;

-- Backfill from the deprecated week columns so existing rows remain
-- plottable on the roadmap. Postgres treats DATE + INTEGER as add-N-days
-- and returns DATE.
UPDATE projects
   SET dev_end_date = COALESCE(dev_start_date, target_date) + (estimated_dev_weeks * 7)
 WHERE dev_end_date IS NULL
   AND target_date IS NOT NULL
   AND estimated_dev_weeks IS NOT NULL;

UPDATE projects
   SET optimization_end_date = dev_end_date + (estimated_optimization_weeks * 7)
 WHERE optimization_end_date IS NULL
   AND dev_end_date IS NOT NULL
   AND estimated_optimization_weeks IS NOT NULL;

ALTER TABLE projects
  DROP COLUMN IF EXISTS estimated_dev_weeks,
  DROP COLUMN IF EXISTS estimated_optimization_weeks;

-- Ordering guards. Every subsequent phase's boundary must be on or after
-- the effective start of the previous phase (falling back through the
-- COALESCE chain when the intermediate anchor is null).
ALTER TABLE projects
  ADD CONSTRAINT dev_end_after_dev_start CHECK (
    dev_end_date IS NULL
    OR (
      (dev_start_date IS NOT NULL AND dev_end_date >= dev_start_date)
      OR (dev_start_date IS NULL AND target_date IS NOT NULL AND dev_end_date >= target_date)
      OR (dev_start_date IS NULL AND target_date IS NULL)
    )
  );

ALTER TABLE projects
  ADD CONSTRAINT opt_start_after_dev_end CHECK (
    optimization_start_date IS NULL
    OR dev_end_date IS NULL
    OR optimization_start_date >= dev_end_date
  );

ALTER TABLE projects
  ADD CONSTRAINT opt_end_after_opt_start CHECK (
    optimization_end_date IS NULL
    OR (
      (optimization_start_date IS NOT NULL AND optimization_end_date >= optimization_start_date)
      OR (optimization_start_date IS NULL AND dev_end_date IS NOT NULL AND optimization_end_date >= dev_end_date)
      OR (optimization_start_date IS NULL AND dev_end_date IS NULL)
    )
  );
