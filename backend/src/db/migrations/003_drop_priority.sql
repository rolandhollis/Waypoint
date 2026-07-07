-- Priority is now expressed by card order within each swim lane, so the
-- explicit priority field is no longer needed.

ALTER TABLE projects DROP COLUMN IF EXISTS priority;
