-- Editable display name for Design Tickets person swim lanes.
-- Defaults to the linked user's name; admins can rename the column
-- without changing the underlying assignee user.

ALTER TABLE design_board_lanes
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE design_board_lanes l
   SET name = u.name
  FROM users u
 WHERE u.id = l.user_id
   AND (l.name IS NULL OR btrim(l.name) = '');

ALTER TABLE design_board_lanes
  ALTER COLUMN name SET NOT NULL;
