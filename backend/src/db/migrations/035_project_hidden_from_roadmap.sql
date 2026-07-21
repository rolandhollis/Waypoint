-- Per-project "hide from Roadmap" flag. When TRUE, the project is
-- unconditionally excluded from the Roadmap view — regardless of
-- filters, dates, group-by, sort order, timeframe, or PDF export.
-- Every other view (Board, Status Report, EZEstimates, admin lists)
-- still shows the item; the flag ONLY narrows the Roadmap surface.
--
-- Distinct from `excluded_from_capacity` (which only opts out of the
-- overload sweep and auto-scheduler load) and `dates_locked` (which
-- freezes phase dates against the auto-scheduler). Hidden items keep
-- their dates, still count for capacity by default, and still audit
-- normally — they simply don't render on the Roadmap.
--
-- Default FALSE so every existing row keeps rendering on the Roadmap
-- exactly as it did pre-migration. Toggled from the checkbox in the
-- ProjectDetailPanel's Timelines-and-Estimates section; audited via
-- the existing `project_audit_events` pipeline (see AUDITED_FIELDS
-- in routes/projects.ts).

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS hidden_from_roadmap BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
