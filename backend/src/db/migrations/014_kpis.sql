-- KPIs (Key Performance Indicators): a workspace-level list of
-- outcome buckets that the admin curates. Projects can subscribe to
-- any number of KPIs to signal which outcome(s) they contribute to.
--
--   kpis            Admin-managed catalog. Same shape as teams — name,
--                   description, color, and an admin-drag "order" — so
--                   the existing admin patterns (SortableRow +
--                   reorder endpoint) drop straight in.
--
--   project_kpis    Many-to-many join. Unlike project_teams, the join
--                   carries a `position` because the PM cares about the
--                   order of KPIs on their own project (e.g. "primary
--                   KPI is Revenue, secondary is Retention"). Uniqueness
--                   is enforced two ways: PK (project_id, kpi_id) so a
--                   project can't list the same KPI twice, plus a
--                   partial unique index on (project_id, position) so
--                   the frontend can rely on gaps-free integer
--                   ordering.
--
-- Delete of a KPI cascades through the join so the KPI catalog stays
-- clean when an admin retires an outcome bucket. Delete of a project
-- also cascades so archived cards don't leave dangling links.

CREATE TABLE IF NOT EXISTS kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#64748b',
  "order" INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_kpis (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kpi_id     UUID NOT NULL REFERENCES kpis(id)     ON DELETE CASCADE,
  position   INT  NOT NULL,
  PRIMARY KEY (project_id, kpi_id)
);

-- Fast "give me every project tagged with this KPI" lookup — used by
-- the new KPI report view.
CREATE INDEX IF NOT EXISTS project_kpis_kpi_idx ON project_kpis (kpi_id);

-- Per-project position must be unique so the client can rely on
-- gaps-free ordering when it renders + reorders.
CREATE UNIQUE INDEX IF NOT EXISTS project_kpis_project_position_idx
  ON project_kpis (project_id, position);
