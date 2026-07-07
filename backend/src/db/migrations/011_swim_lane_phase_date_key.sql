-- Bind a swim lane to a specific phase-date field so that dragging a
-- project into that lane can prompt the user "want to set this date
-- to today?". Nullable — most lanes carry no such association.
--
-- Values match the columns on `projects` that PMs realistically want
-- to stamp when a card lands in a lane:
--   target_date              → "Ready for dev" lanes
--   dev_start_date           → "In dev" / "In progress" lanes
--   dev_end_date             → "Dev done" / "QA" lanes
--   optimization_start_date  → "Optimization" lanes
--   optimization_end_date    → "Complete" / "Done" lanes
--
-- Backfill leverages the canonical seeded lane names so existing
-- installs get sensible defaults without an admin having to visit
-- Settings first. Admins can change any binding after the fact.

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS phase_date_key TEXT;

ALTER TABLE swim_lanes
  DROP CONSTRAINT IF EXISTS swim_lanes_phase_date_key_check;

ALTER TABLE swim_lanes
  ADD CONSTRAINT swim_lanes_phase_date_key_check
  CHECK (
    phase_date_key IS NULL
    OR phase_date_key IN (
      'target_date',
      'dev_start_date',
      'dev_end_date',
      'optimization_start_date',
      'optimization_end_date'
    )
  );

UPDATE swim_lanes SET phase_date_key = 'target_date'
 WHERE phase_date_key IS NULL AND lower(name) IN ('ready for dev', 'ready for development', 'dev ready');

UPDATE swim_lanes SET phase_date_key = 'dev_start_date'
 WHERE phase_date_key IS NULL AND lower(name) IN ('in dev', 'in development', 'development');

UPDATE swim_lanes SET phase_date_key = 'dev_end_date'
 WHERE phase_date_key IS NULL AND lower(name) IN ('dev done', 'qa', 'in qa');

UPDATE swim_lanes SET phase_date_key = 'optimization_start_date'
 WHERE phase_date_key IS NULL AND lower(name) IN ('optimization', 'post-dev optimization', 'in optimization');

UPDATE swim_lanes SET phase_date_key = 'optimization_end_date'
 WHERE phase_date_key IS NULL AND lower(name) IN ('complete', 'completed', 'done');
