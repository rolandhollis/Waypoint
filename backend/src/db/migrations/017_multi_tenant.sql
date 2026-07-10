-- Multi-tenant workspaces ("groups").
--
-- Every project, swim lane, team, and KPI now belongs to exactly
-- one group. A user can belong to multiple groups and holds a
-- different per-group role in each. Group switching happens
-- server-side via users.current_group_id; the client just fires
-- a PATCH when the user picks a new one from the navbar dropdown.
--
-- SuperUser is a global role that lives outside the per-group
-- membership table. Only the env-bootstrapped account gets it;
-- regular admins can't grant it. It unlocks the Groups admin
-- section (create/rename groups, add/remove members) — nothing
-- else. Business-role permissions (edit/create/etc.) always come
-- from the per-group role.
--
-- Backfill strategy:
--   * seed "RetailMeNot" — inherits every existing row (projects,
--     lanes, teams, KPIs)
--   * seed "VoucherCodes" — new group, populated with its own copy
--     of the default swim lanes so it's usable immediately
--   * every existing user is enrolled in RetailMeNot with their
--     current users.role — nobody loses access
--   * the super-admin (matched by email) is enrolled as admin in
--     BOTH groups and flagged is_super_user=true
--
-- users.role is intentionally kept for now (backwards compat +
-- disaster recovery); nothing reads it anymore, but nulling it
-- would make the seeder/importer more painful with no upside.

BEGIN;

-- -----------------------------------------------------------------
-- Groups
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------
-- User <-> Group membership with per-group role
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_groups (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','owner','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS user_groups_group_idx ON user_groups(group_id);

-- -----------------------------------------------------------------
-- User-level flags: SuperUser + current group pointer
-- -----------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_user BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_group_id UUID REFERENCES groups(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------
-- Add nullable group_id to every scoped table; backfill; enforce
-- NOT NULL after. Kept nullable-first so the backfill is safe
-- against any partially-written rows.
-- -----------------------------------------------------------------
ALTER TABLE projects   ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE swim_lanes ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE teams      ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE kpis       ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------
-- Seed the two initial groups
-- -----------------------------------------------------------------
INSERT INTO groups (name, color) VALUES
  ('RetailMeNot',  '#DC2626'),
  ('VoucherCodes', '#0EA5E9')
ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------------------------
-- Backfill: everything existing → RetailMeNot
-- (safe because RMN is what the app was built for)
-- -----------------------------------------------------------------
UPDATE projects   SET group_id = (SELECT id FROM groups WHERE name = 'RetailMeNot') WHERE group_id IS NULL;
UPDATE swim_lanes SET group_id = (SELECT id FROM groups WHERE name = 'RetailMeNot') WHERE group_id IS NULL;
UPDATE teams      SET group_id = (SELECT id FROM groups WHERE name = 'RetailMeNot') WHERE group_id IS NULL;
UPDATE kpis       SET group_id = (SELECT id FROM groups WHERE name = 'RetailMeNot') WHERE group_id IS NULL;

-- Every existing user → RetailMeNot member (with their old role).
INSERT INTO user_groups (user_id, group_id, role)
SELECT u.id, g.id, u.role
  FROM users u
  CROSS JOIN groups g
  WHERE g.name = 'RetailMeNot'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------
-- Now that data is backfilled, lock down NOT NULL on group_id.
-- -----------------------------------------------------------------
ALTER TABLE projects   ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE swim_lanes ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE teams      ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE kpis       ALTER COLUMN group_id SET NOT NULL;

-- Index the scope columns so per-group SELECTs stay cheap even as
-- data grows across multiple tenants.
CREATE INDEX IF NOT EXISTS projects_group_idx   ON projects(group_id);
CREATE INDEX IF NOT EXISTS swim_lanes_group_idx ON swim_lanes(group_id);
CREATE INDEX IF NOT EXISTS teams_group_idx      ON teams(group_id);
CREATE INDEX IF NOT EXISTS kpis_group_idx       ON kpis(group_id);

-- Partial-unique constraints that used to be global — "only one
-- default-new lane in the whole system" — must now be per-group,
-- so each tenant gets its own default-new + archive lane.
DROP INDEX IF EXISTS swim_lanes_one_default_new;
CREATE UNIQUE INDEX swim_lanes_one_default_new_per_group
  ON swim_lanes (group_id) WHERE is_default_new = TRUE;

DROP INDEX IF EXISTS swim_lanes_one_archive;
CREATE UNIQUE INDEX swim_lanes_one_archive_per_group
  ON swim_lanes (group_id) WHERE is_archive = TRUE;

-- Note: lane/team/kpi ORDER columns weren't globally unique before
-- either, so no partial-unique index rewrites needed. Ordering is
-- naturally per-group now because every ORDER BY joins on group_id.

-- -----------------------------------------------------------------
-- Seed VoucherCodes with the default swim lanes so admins can
-- start dropping items into it right away. Descriptions kept short;
-- the phases page will render them.
-- -----------------------------------------------------------------
INSERT INTO swim_lanes (group_id, name, description, "order", color, is_terminal, requires_weekly_status, is_default_new, phase_date_key, is_admin_only, is_archive)
SELECT
  g.id,
  x.name,
  x.description,
  x."order",
  x.color,
  x.is_terminal,
  x.requires_weekly_status,
  x.is_default_new,
  x.phase_date_key::TEXT,
  x.is_admin_only,
  x.is_archive
FROM groups g,
LATERAL (VALUES
  ('Backlog',        'Ideas parked for later triage.',            0, '#94A3B8', FALSE, FALSE, TRUE,  NULL,                      FALSE, FALSE),
  ('Ready for Dev',  'Scoped, sized, and approved to build.',     1, '#3B82F6', FALSE, FALSE, FALSE, 'target_date',             FALSE, FALSE),
  ('In Dev',         'Actively being built.',                     2, '#F59E0B', FALSE, TRUE,  FALSE, 'dev_start_date',          FALSE, FALSE),
  ('Complete',       'Shipped and live.',                         3, '#10B981', TRUE,  FALSE, FALSE, 'optimization_end_date',   FALSE, FALSE),
  ('Archive',        'Retired / cancelled — hidden from board.',  4, '#64748B', TRUE,  FALSE, FALSE, NULL,                      TRUE,  TRUE)
) AS x(name, description, "order", color, is_terminal, requires_weekly_status, is_default_new, phase_date_key, is_admin_only, is_archive)
WHERE g.name = 'VoucherCodes'
  AND NOT EXISTS (
    SELECT 1 FROM swim_lanes sl WHERE sl.group_id = g.id
  );

-- -----------------------------------------------------------------
-- Default each user's current_group_id to their first membership
-- so the very first request after this migration lands somewhere.
-- Runs AFTER user_groups is populated above.
-- -----------------------------------------------------------------
UPDATE users u
   SET current_group_id = ug.group_id
  FROM (
    SELECT DISTINCT ON (user_id) user_id, group_id
      FROM user_groups
      ORDER BY user_id, created_at ASC
  ) ug
  WHERE ug.user_id = u.id
    AND u.current_group_id IS NULL;

COMMIT;
