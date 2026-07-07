-- Add an admin-controlled "which lane do new items land in?" flag.
-- Only one lane may carry it at a time; the partial unique index makes
-- that a hard database-level invariant so a race can't leave two lanes
-- marked. Backend PATCH clears any prior default in the same
-- transaction before setting a new one.

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS is_default_new BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS swim_lanes_one_default_new
  ON swim_lanes ((is_default_new))
  WHERE is_default_new = TRUE;

-- Seed a sensible starting choice for existing installs so the new
-- "Add new item" CTA on the board isn't a black hole on first render:
-- pick the first non-terminal lane (typically "Backlog" or similar),
-- if any exist and none has been marked yet.
UPDATE swim_lanes
   SET is_default_new = TRUE
 WHERE id = (
   SELECT id
     FROM swim_lanes
    WHERE is_terminal = FALSE
      AND NOT EXISTS (SELECT 1 FROM swim_lanes WHERE is_default_new = TRUE)
    ORDER BY "order" ASC
    LIMIT 1
 );
