-- T-shirt size catalog, per tenant, used by the EZEstimates view to
-- rapidly size a project's Discovery / Development / Post-Dev phases.
--
-- Design choices:
--   * Per-group like every other tenant-scoped catalog (swim lanes,
--     teams, KPIs). Rows cascade on group delete.
--   * FIXED cardinality of 5 rows per group (S/M/L/XL/XXL). No add /
--     delete UI — the admin can only relabel and re-size. Enforced
--     softly by the UNIQUE (group_id, position) index (positions
--     0..4) and by never exposing POST/DELETE on the router.
--   * `days` must be a positive integer. Fractional / negative day
--     counts don't correspond to anything a PM can actually schedule.
--   * `label` is per-tenant unique so a group can't have two rows
--     called "M". The seed defaults (S/M/L/XL/XXL) satisfy this.
--
-- Seed strategy: pre-populate every existing group with the standard
-- ladder. New groups created after this migration get their seed via
-- backend/src/routes/groups.ts (same place swim lanes are seeded).

BEGIN;

CREATE TABLE IF NOT EXISTS tshirt_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  days INT NOT NULL CHECK (days > 0),
  position INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, label),
  UNIQUE (group_id, position)
);

CREATE INDEX IF NOT EXISTS tshirt_sizes_group_idx ON tshirt_sizes (group_id);

-- Seed every existing group with the standard ladder. ON CONFLICT so
-- re-running the migration (or applying it to a partially-seeded
-- environment) is idempotent.
INSERT INTO tshirt_sizes (group_id, label, days, position)
SELECT g.id, v.label, v.days, v.position
  FROM groups g
  CROSS JOIN (VALUES
    ('S',    3,  0),
    ('M',    7,  1),
    ('L',    14, 2),
    ('XL',   30, 3),
    ('XXL',  90, 4)
  ) AS v(label, days, position)
ON CONFLICT (group_id, position) DO NOTHING;

COMMIT;
