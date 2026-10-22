-- Per-KPI impact SWAG on project assignments.
--
-- Stores the tenant t-shirt-size *label* (e.g. S/M/L/XL/XXL from
-- tshirt_sizes), not a day count — KPI SWAG is ordinal impact, not
-- calendar length. Nullable so existing assignments stay valid.

ALTER TABLE project_kpis
  ADD COLUMN IF NOT EXISTS impact_swag TEXT NULL;

COMMENT ON COLUMN project_kpis.impact_swag IS
  'Optional t-shirt label (from tshirt_sizes) for estimated impact on this KPI.';
