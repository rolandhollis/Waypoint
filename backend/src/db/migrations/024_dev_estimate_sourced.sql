BEGIN;

-- Flag: was the current dev-phase estimate confirmed by an
-- engineer, or is it still a PM/best-guess placeholder?
--
-- Default FALSE ("unconfirmed") on every existing row is
-- deliberate — the field didn't exist before, so we have no
-- reason to assume any past estimate has been validated. PMs
-- flip it on once dev signs off. Roadmap renders unconfirmed
-- dev segments with a distinctive dashed outline so viewers
-- can tell at a glance which sections of the timeline are
-- provisional.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dev_estimate_sourced_by_dev BOOLEAN NOT NULL DEFAULT false;

COMMIT;
