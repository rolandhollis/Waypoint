-- Product areas (teams) own KPIs + systems. PMs are assigned to areas;
-- KPIs/systems hang off the area, not the PM directly.
--
--   teams.description          Shown on Plan → Team under the area name.
--   team_kpis                  Many-to-many (a KPI can sit on multiple areas).
--   systems.team_id            At most one area per system (replaces product_manager_id).

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS team_kpis (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kpi_id  UUID NOT NULL REFERENCES kpis(id)  ON DELETE CASCADE,
  PRIMARY KEY (team_id, kpi_id)
);

CREATE INDEX IF NOT EXISTS team_kpis_kpi_id_idx ON team_kpis (kpi_id);

-- Move systems from PM ownership → area ownership.
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS systems_team_id_idx
  ON systems (team_id)
  WHERE team_id IS NOT NULL;

-- Drop the old PM-direct links (data was experimental / easy to re-assign).
DROP TABLE IF EXISTS product_manager_kpis;

ALTER TABLE systems DROP COLUMN IF EXISTS product_manager_id;
DROP INDEX IF EXISTS systems_product_manager_id_idx;
