BEGIN;

-- Per-item opt-out from capacity planning. The previous rule
-- silently excluded every subtask (any row with a parent) from
-- both the roadmap overload sweep and the auto-scheduler; that
-- was fine as a heuristic but hid genuine load when a subtask
-- had its own owner/team distinct from the epic.
--
-- This flag flips the model: every scheduled item counts by
-- default; PMs opt individual items out via the checkbox in the
-- detail panel / new-item dialog. Old rows all default to FALSE
-- (i.e. everything starts counting on deploy), which is the
-- explicit intent — surface load that was previously invisible.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS excluded_from_capacity BOOLEAN NOT NULL DEFAULT false;

COMMIT;
