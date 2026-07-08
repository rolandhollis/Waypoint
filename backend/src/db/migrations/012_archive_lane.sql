-- Two orthogonal-ish swim-lane flags:
--
--   is_admin_only  Any lane can be marked hidden. Non-admins never see the
--                  lane in swim-lane responses, and projects that live in
--                  it are filtered out of project responses. Useful for
--                  scratch/experimental columns as well as the Archive.
--
--   is_archive     Exactly one lane at a time may carry this flag (partial
--                  unique index). It's the destination of the "Move to
--                  archive" button on the detail panel: the backend
--                  resolves it server-side so non-admins can archive
--                  without ever being able to see the lane's id.
--
-- A fresh Archive lane is inserted at the end for existing installs that
-- don't already have one. Idempotent — re-running is a no-op.

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS is_admin_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE swim_lanes
  ADD COLUMN IF NOT EXISTS is_archive BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS swim_lanes_one_archive
  ON swim_lanes ((is_archive))
  WHERE is_archive = TRUE;

INSERT INTO swim_lanes
  (name, description, "order", color,
   is_terminal, requires_weekly_status,
   is_default_new, is_admin_only, is_archive,
   phase_date_key)
SELECT
  'Archive',
  'Cards parked here are hidden from non-admin views. Move a card out of Archive (via the lane menu) to bring it back onto the board.',
  COALESCE((SELECT MAX("order") FROM swim_lanes), -1) + 1,
  '#475569',
  FALSE, FALSE,
  FALSE, TRUE, TRUE,
  NULL
WHERE NOT EXISTS (SELECT 1 FROM swim_lanes WHERE is_archive = TRUE);
