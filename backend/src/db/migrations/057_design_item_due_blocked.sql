-- Due date + blocked flag for Product Design Tickets.
-- Mirrors projects.target_date (list calendar) and projects.is_blocked
-- (stop-sign indicator) so design cards can show the same markers.

BEGIN;

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS due_date DATE;

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS design_items_blocked_idx
  ON design_items (group_id, is_blocked)
  WHERE is_blocked = true;

COMMIT;
