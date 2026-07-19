-- Allow t-shirt sizes to carry a zero-day duration. The original
-- migration (028) enforced `CHECK (days > 0)` on the theory that a
-- fractional / negative / zero preset didn't correspond to anything a
-- PM could schedule. In practice tenants do want a 0-day preset — the
-- canonical example is a Post-Dev Optimization row on a trivial task
-- where no post-dev work is expected. Picking a 0-day size sets
-- phase_end = phase_start (a same-day window), which is a legitimate
-- schedule state, not a "clear the phase" signal.
--
-- We keep the non-negative guard so a stray negative value can't
-- sneak through the API. Postgres names inline column checks
-- `<table>_<column>_check`, so the constraint dropped here matches
-- what 028 created.

BEGIN;

ALTER TABLE tshirt_sizes
  DROP CONSTRAINT IF EXISTS tshirt_sizes_days_check;

ALTER TABLE tshirt_sizes
  ADD CONSTRAINT tshirt_sizes_days_check
  CHECK (days >= 0);

COMMIT;
