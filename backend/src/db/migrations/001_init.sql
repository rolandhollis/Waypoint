-- Schema for Backlog & Roadmap Management Tool (PRD §4)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'viewer')),
  avatar_url TEXT,
  color TEXT NOT NULL,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS swim_lanes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  color TEXT,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  requires_weekly_status BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS swim_lanes_order_idx ON swim_lanes ("order");

CREATE TABLE IF NOT EXISTS product_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  swim_lane_id UUID REFERENCES swim_lanes(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_area_id UUID REFERENCES product_areas(id) ON DELETE SET NULL,
  priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  start_date DATE,
  target_date DATE,
  estimated_dev_weeks INTEGER CHECK (estimated_dev_weeks BETWEEN 1 AND 12),
  estimated_optimization_weeks INTEGER CHECK (estimated_optimization_weeks BETWEEN 1 AND 12),
  actual_completion_date DATE,
  deleted_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS projects_swim_lane_idx ON projects (swim_lane_id);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id);
CREATE INDEX IF NOT EXISTS projects_product_area_idx ON projects (product_area_id);
CREATE INDEX IF NOT EXISTS projects_deleted_idx ON projects (deleted_at);

CREATE TABLE IF NOT EXISTS status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_swim_lane_id UUID REFERENCES swim_lanes(id) ON DELETE SET NULL,
  to_swim_lane_id UUID REFERENCES swim_lanes(id) ON DELETE SET NULL,
  moved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS status_history_project_idx ON status_history (project_id, "timestamp");
CREATE INDEX IF NOT EXISTS status_history_lane_idx ON status_history (to_swim_lane_id);

CREATE TABLE IF NOT EXISTS weekly_status_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  original_submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  week_of DATE NOT NULL,
  health_flag TEXT NOT NULL CHECK (health_flag IN ('white', 'green', 'yellow', 'red')) DEFAULT 'white',
  executive_summary TEXT NOT NULL DEFAULT '',
  detailed_update JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  due_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, week_of)
);

CREATE INDEX IF NOT EXISTS weekly_status_project_week_idx ON weekly_status_updates (project_id, week_of);
CREATE INDEX IF NOT EXISTS weekly_status_week_idx ON weekly_status_updates (week_of);
