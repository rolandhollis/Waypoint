-- Add per-mention read tracking so the frontend nav-bar
-- notifications popover can distinguish unread from read entries
-- and cheaply count the current user's unread badge.
--
-- Storage decision: single nullable timestamp column on `mentions`
-- rather than a separate `mention_reads` (user, mention_id) join
-- table. Every mention already has exactly one `mentioned_user_id`
-- (see 040_mentions.sql — no fanout, one row per tag), so a
-- per-row read timestamp is 1:1 with the audience and needs no
-- extra join. NULL means unread; a set value means the mentioned
-- user cleared it (POST /api/mentions/:id/read).
--
-- Index rationale: the unread-count endpoint filters WHERE
-- `read_at IS NULL AND mentioned_user_id = $1` and the recent-list
-- endpoint always orders by `created_at DESC` for the same user;
-- the existing `mentions_mentioned_user_idx` covers the "recent"
-- read path already. The new *partial* index below is scoped to
-- rows where `read_at IS NULL` so it stays tiny (only ever holds
-- currently-unread rows) and delivers the count / latest-unread
-- lookup without scanning the full mention table.
--
-- Everything is IF NOT EXISTS / idempotent so re-running the
-- migrate script on an environment that's already at 041 is a
-- no-op.

BEGIN;

ALTER TABLE mentions ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mentions_unread_by_user_idx
  ON mentions (mentioned_user_id, created_at DESC)
  WHERE read_at IS NULL;

COMMIT;
