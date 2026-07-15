BEGIN;

-- Weekly status-report digest recipients.
--
-- The Friday afternoon digest is sent to a group-scoped roster
-- of people who want the update — some are Waypoint users
-- (dropdown pick in admin) and some are ad-hoc addresses
-- (arbitrary email, e.g. execs or contractors without an account).
--
-- Design choices:
--   * `user_id` nullable: NULL rows are ad-hoc addresses; non-NULL
--     rows track the linked user so the send picks up their
--     current email even if they later change it.
--   * `email` denormalized as a fallback: for user-linked rows the
--     runtime send prefers users.email over this column, but we
--     keep the address the admin picked at add-time to display in
--     the list without joining and to serve as the record if the
--     user is later deleted.
--   * Uniqueness on (group_id, LOWER(email)): prevents duplicate
--     sends to the same address within a group; case-insensitive
--     because email addresses are.
--   * ON DELETE CASCADE from groups: when a tenant is deleted the
--     digest list dies with it.
--   * ON DELETE CASCADE from users for user_id: if the linked user
--     is deleted the row goes too (rather than silently becoming
--     ad-hoc, which would be confusing in the admin UI).

CREATE TABLE IF NOT EXISTS status_digest_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS status_digest_recipients_group_email_uniq
  ON status_digest_recipients (group_id, LOWER(email));

CREATE INDEX IF NOT EXISTS status_digest_recipients_group
  ON status_digest_recipients (group_id);

-- Widen notification_log to support recipients that aren't a
-- registered user (i.e. ad-hoc email addresses on the digest list).
-- Adds a nullable recipient_email column and a group_id column
-- (digests are per-tenant, unlike reminders which are per-user
-- globally). The old uniqueness guard on (kind, user_id, week_of)
-- stays intact for existing kinds; a NEW partial index covers the
-- digest bucket so double-sends to the same email inside the same
-- (group, week) are impossible.
ALTER TABLE notification_log
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS recipient_email TEXT,
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_digest_bucket_uniq
  ON notification_log (kind, group_id, LOWER(recipient_email), week_of)
  WHERE kind = 'status_report_digest' AND recipient_email IS NOT NULL AND group_id IS NOT NULL;

COMMIT;
