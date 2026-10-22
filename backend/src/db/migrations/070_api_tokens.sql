-- Personal API tokens for machine access (Claude MCP connector, scripts).
-- The plaintext token is shown once at creation; only a SHA-256 hash is stored.
-- Each token is pinned to a single tenant (group_id) so Claude/static
-- credentials always act inside one workspace.

CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- First 12 chars of the public token (including "wp_") for list UI.
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- Reserved for future write scopes; today every token is read-only.
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_tokens_name_nonempty CHECK (char_length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx
  ON api_tokens (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS api_tokens_hash_idx
  ON api_tokens (token_hash)
  WHERE revoked_at IS NULL;
