-- Replace `product_area_id` (single-select FK) with a many-to-many
-- `project_teams` join. Teammate feedback: real work sometimes spans
-- multiple pods (e.g. a Loyalty email initiative built by the Martech
-- pod belongs to both). `product_areas` is renamed to `teams` — same
-- shape, different mental model. Existing single assignments migrate
-- into the join as one row per project.

-- 1. Rename the table (constraints and PK follow automatically).
ALTER TABLE product_areas RENAME TO teams;

-- 2. Create the join table.
CREATE TABLE IF NOT EXISTS project_teams (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES teams(id)    ON DELETE CASCADE,
  PRIMARY KEY (project_id, team_id)
);

CREATE INDEX IF NOT EXISTS project_teams_team_idx ON project_teams (team_id);

-- 3. Backfill from existing single-assignment column, then drop it.
INSERT INTO project_teams (project_id, team_id)
  SELECT id, product_area_id
    FROM projects
   WHERE product_area_id IS NOT NULL
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS projects_product_area_idx;
ALTER TABLE projects DROP COLUMN IF EXISTS product_area_id;
