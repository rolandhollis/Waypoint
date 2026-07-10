BEGIN;

-- Persist whether a session was created with "remember me" checked so
-- middleware/touchSession knows which TTL to slide the expiry by. Old
-- rows default to false (the pre-flag behavior), matching the 7-day
-- policy they were created under.
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT false;

COMMIT;
