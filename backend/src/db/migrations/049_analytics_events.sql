-- Product analytics for experiment measurement (host-owned).
-- Join key is ziffsplit_id (SDK subject), not Waypoint login.
-- user_id is optional enrichment when the visitor is signed in.

CREATE TABLE IF NOT EXISTS analytics_exposures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ziffsplit_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  experiment_key TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  container_key TEXT,
  site_key TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 0,
  delivery_mode TEXT NOT NULL,
  content_source TEXT NOT NULL,
  primary_kpi TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One exposure row per subject × experiment × published config version.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_exposures_subject_exp_cfg_uidx
  ON analytics_exposures (ziffsplit_id, experiment_key, config_version);

CREATE INDEX IF NOT EXISTS analytics_exposures_experiment_idx
  ON analytics_exposures (experiment_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS analytics_exposures_ziffsplit_idx
  ON analytics_exposures (ziffsplit_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ziffsplit_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_events_name_idx
  ON analytics_events (event_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS analytics_events_ziffsplit_idx
  ON analytics_events (ziffsplit_id, occurred_at DESC);
