-- Hard-deadline feature.
--
-- A "deadline" pins a promised date to one of a project's swim
-- lanes — read as "the phase this lane represents must complete
-- no later than <deadline_date>". At most one deadline per
-- (project, swim_lane) pair, enforced by the unique index.
--
-- We do NOT enforce lane-must-have-phase_date_key at the DB level
-- because a lane can gain/lose that binding after a deadline is
-- already set (admin edits the lane, deadline shouldn't get
-- silently deleted). The route layer refuses to CREATE a deadline
-- against a lane without phase_date_key, and the client hides such
-- lanes from the picker; the violation calculation just returns
-- "no violation" when phase_date_key is currently null.
--
-- No group_id column: swim_lane_id already scopes to a tenant via
-- swim_lanes.group_id, and the route layer filters on the caller's
-- current group when listing / mutating.

BEGIN;

CREATE TABLE IF NOT EXISTS project_deadlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  swim_lane_id UUID NOT NULL REFERENCES swim_lanes(id) ON DELETE CASCADE,
  deadline_date DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_deadlines_project_lane_key
  ON project_deadlines (project_id, swim_lane_id);

CREATE INDEX IF NOT EXISTS project_deadlines_project_idx
  ON project_deadlines (project_id);

COMMIT;
