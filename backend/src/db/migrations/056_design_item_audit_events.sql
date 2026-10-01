-- Per-field audit trail for Product Design Tickets.
-- Mirrors project_audit_events so the design detail panel can show
-- create / edit / complete / delete history for each card.

CREATE TABLE IF NOT EXISTS design_item_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_item_id UUID NOT NULL REFERENCES design_items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  field TEXT,
  from_value JSONB,
  to_value JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS design_item_audit_events_item_ts_idx
  ON design_item_audit_events (design_item_id, "timestamp" DESC);
