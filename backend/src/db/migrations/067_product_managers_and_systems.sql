-- Product managers (per-tenant flag on user_groups) plus Systems catalog
-- and PM assignments for product areas (teams), KPIs, and systems.
--
--   user_groups.is_product_manager
--     Admin toggle. Only users with this flag appear on Plan → Team.
--
--   systems
--     Admin-managed catalog (same shape as kpis). product_manager_id
--     is at most one user — a system cannot be shared across PMs.
--
--   product_manager_teams / product_manager_kpis
--     Many-to-many. A KPI (or team/product area) may be owned by
--     multiple product managers.

ALTER TABLE user_groups
  ADD COLUMN IF NOT EXISTS is_product_manager BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#64748b',
  "order" INT NOT NULL DEFAULT 0,
  product_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS systems_group_id_idx ON systems (group_id);
CREATE INDEX IF NOT EXISTS systems_product_manager_id_idx
  ON systems (product_manager_id)
  WHERE product_manager_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_manager_teams (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

CREATE INDEX IF NOT EXISTS product_manager_teams_team_id_idx
  ON product_manager_teams (team_id);

CREATE TABLE IF NOT EXISTS product_manager_kpis (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kpi_id UUID NOT NULL REFERENCES kpis(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, kpi_id)
);

CREATE INDEX IF NOT EXISTS product_manager_kpis_kpi_id_idx
  ON product_manager_kpis (kpi_id);
