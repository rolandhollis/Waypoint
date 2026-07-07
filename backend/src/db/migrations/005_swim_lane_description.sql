-- Give each swim lane a longer-form description that admins can maintain.
-- Rendered on the new /phases reference page and in the board-column
-- header tooltip. Defaulting to empty string keeps the API contract
-- consistently non-null.

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
