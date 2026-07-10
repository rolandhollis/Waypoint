-- Project dependencies.
--
-- A dependency says: this project's phase START (project_swim_lane)
-- cannot begin until another project's phase END
-- (depends_on_swim_lane) has completed.
--
-- Multiple deps are allowed per (project, lane) — a lane can be
-- blocked by many upstream items — and a project can have deps on
-- any number of lanes. No unique constraint.
--
-- No group_id column: swim_lane_id already scopes to a tenant via
-- swim_lanes.group_id, and the route layer refuses to create a dep
-- where any of the four (project, lane, other project, other lane)
-- straddles groups.
--
-- Self-dependency (project depending on itself) is rejected by
-- CHECK. Product decision: intra-project phase ordering is already
-- enforced by the phase-date validation on projects.patch, so a
-- cross-lane self-dep would just be duplicate machinery.
--
-- Cycle detection (A→B and B→A) is NOT enforced at the DB level;
-- the UI will simply show violations on both sides until the PM
-- breaks the cycle. Cheap and correct — no runtime hot path is
-- affected.

BEGIN;

CREATE TABLE IF NOT EXISTS project_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_swim_lane_id UUID NOT NULL REFERENCES swim_lanes(id) ON DELETE CASCADE,
  depends_on_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_swim_lane_id UUID NOT NULL REFERENCES swim_lanes(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_dependencies_no_self CHECK (project_id <> depends_on_project_id)
);

CREATE INDEX IF NOT EXISTS project_dependencies_project_idx
  ON project_dependencies (project_id);
CREATE INDEX IF NOT EXISTS project_dependencies_depends_on_idx
  ON project_dependencies (depends_on_project_id);

COMMIT;
