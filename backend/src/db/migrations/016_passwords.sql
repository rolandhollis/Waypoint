-- Real password-based auth. Two additive changes:
--
--   * users.password_hash + users.password_updated_at — bcrypt hash
--     (NULL = the user hasn't set a password yet and can't log in
--     in password mode; safe default that keeps mock-mode fully
--     functional).
--
--   * user_sessions — one row per active login. Session id lives in
--     an HttpOnly cookie; server-side lookup means admin can revoke
--     sessions instantly (e.g. after a password reset). Kept
--     purposely small — no device fingerprinting or geo data.
--
-- Both changes are optional at read time so mock mode keeps working
-- unchanged. The AUTH_MODE env var selects which flow the server
-- actually enforces.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions(expires_at);
