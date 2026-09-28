-- Explicit person columns on the Design Tickets board.
-- Unassigned / Completed stay fixed; these rows are the admin-
-- managed swim lanes (one per user), ordered by "order".

CREATE TABLE IF NOT EXISTS design_board_lanes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "order" INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS design_board_lanes_group_order_idx
  ON design_board_lanes (group_id, "order");

-- Seed from anyone who currently has (or had) a design ticket assigned.
INSERT INTO design_board_lanes (group_id, user_id, "order")
SELECT
  d.group_id,
  d.assigned_to,
  (ROW_NUMBER() OVER (
     PARTITION BY d.group_id
     ORDER BY MIN(COALESCE(u.name, '')) ASC, d.assigned_to ASC
   ) - 1)::int AS "order"
FROM design_items d
JOIN users u ON u.id = d.assigned_to
WHERE d.assigned_to IS NOT NULL
  AND d.status <> 'deleted'
GROUP BY d.group_id, d.assigned_to
ON CONFLICT (group_id, user_id) DO NOTHING;
