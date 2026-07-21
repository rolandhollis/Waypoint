-- Persistent per-project "dates locked" flag. When TRUE, no
-- auto-scheduler run (present or future) may change this item's
-- phase dates. Manual date edits (detail panel, EZEstimates
-- picker) are unaffected — the flag only gates the automated
-- Auto-schedule flow, which uses this column as the initial
-- value of its per-run `locked` toggle and refuses to let the
-- user override it from the picker.
--
-- Distinct from `excluded_from_capacity`: excluded items still
-- get their dates recomputed by the scheduler; locked items keep
-- their exact dates but are still counted for capacity load.
--
-- Default FALSE so existing rows behave exactly as they did
-- pre-migration (auto-schedule may move them). Toggled from the
-- padlock icon in the ProjectDetailPanel header; audited via the
-- existing `project_audit_events` pipeline (see AUDITED_FIELDS
-- in routes/projects.ts).

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dates_locked BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
