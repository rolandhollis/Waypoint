BEGIN;

-- Per-user opt-out for the weekly "your status reports are due"
-- email. Default TRUE so existing users are opted in on the first
-- deploy — they can flip it off from the profile dialog or via the
-- one-click unsubscribe link in the email footer.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_reminders_enabled BOOLEAN NOT NULL DEFAULT true;

-- Idempotency log for outbound notification emails. Every job
-- writes here BEFORE hitting the provider; the composite unique
-- key on (kind, user_id, week_of) makes double-sends impossible
-- even if the cron misfires or the job is retried. The
-- provider_message_id column captures Resend's returned id so a
-- delivery investigation can be traced back to a specific send.
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Bucket the notification belongs to. For status reminders this
  -- is the ISO week_of; other kinds may leave it NULL. NULL bucket
  -- means "one-off" and is not covered by the uniqueness guard.
  week_of DATE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_message_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_bucket_uniq
  ON notification_log (kind, user_id, week_of)
  WHERE week_of IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_log_user_sent
  ON notification_log (user_id, sent_at DESC);

COMMIT;
