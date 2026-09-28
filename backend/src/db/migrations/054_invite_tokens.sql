-- Invite tokens share password_reset_tokens with a purpose discriminator.
-- `reset`  — forgot-password / self-serve reset (30 min TTL)
-- `invite` — admin-created user, set-password welcome link (7 day TTL)

ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'reset';

ALTER TABLE password_reset_tokens
  DROP CONSTRAINT IF EXISTS password_reset_tokens_purpose_check;

ALTER TABLE password_reset_tokens
  ADD CONSTRAINT password_reset_tokens_purpose_check
  CHECK (purpose IN ('reset', 'invite'));

CREATE INDEX IF NOT EXISTS password_reset_tokens_purpose_idx
  ON password_reset_tokens (purpose)
  WHERE used_at IS NULL;
