BEGIN;

-- Self-serve "forgot password" flow.
--
-- A user hits POST /api/auth/forgot-password with their email; the
-- server mints a high-entropy token, mails a one-time link, and
-- stores ONLY the SHA-256 hash of the token here. When the user
-- lands on /reset-password?token=… we hash the incoming plaintext
-- and look up by hash — so a DB dump doesn't let anyone log in via
-- an unused reset link.
--
-- Design notes:
--   * `token_hash` is the SHA-256 hex digest of the URL-safe base64
--     token. Fast to look up (indexed via UNIQUE), no bcrypt cost
--     — a 32-byte random token has ~2^256 preimages so brute-force
--     is not a concern. UNIQUE prevents accidental collisions and
--     the exceedingly rare "same random bytes twice" case.
--   * `expires_at` is stamped at insert (30 min after creation).
--     Enforced in the consume path — no partial index needed
--     because tokens are consumed at most once and volume is
--     tiny.
--   * `used_at` marks a successful redemption. We keep the row (not
--     DELETE) so audit / support can see "yes, someone reset via
--     this token at X" without needing a separate log.
--   * `requested_ip` / `requested_user_agent` are best-effort
--     context — helpful for support ("was this actually me?") and
--     for spotting abuse patterns. Nullable because upstream proxy
--     configuration can strip either.
--   * ON DELETE CASCADE from users so deleting a user cleans up any
--     dangling tokens (harmless, but keeps the table tidy).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_ip TEXT,
  requested_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at);

COMMIT;
