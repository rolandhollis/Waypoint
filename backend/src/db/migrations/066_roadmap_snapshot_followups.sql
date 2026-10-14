-- Queue a roadmap-snapshot email after a successful status digest
-- send. The admin UI (browser) drains this by capturing Compact PNGs
-- and POSTing /notifications/roadmap-snapshot/run — cron alone cannot
-- render the charts without a browser.

CREATE TABLE IF NOT EXISTS roadmap_snapshot_followups (
  group_id UUID PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  digest_week_of DATE NULL,
  source TEXT NOT NULL DEFAULT 'status_digest'
);

CREATE INDEX IF NOT EXISTS roadmap_snapshot_followups_requested_at_idx
  ON roadmap_snapshot_followups (requested_at);
