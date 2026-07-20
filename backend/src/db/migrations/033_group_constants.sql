-- Per-tenant runtime "constants" bag. A single JSONB column on the
-- `groups` table holds admin-editable values that used to be baked
-- into the frontend as hardcoded strings (starting with the app
-- name shown in the top navbar). Any group's admin can rebrand
-- their tenant without a redeploy.
--
-- Shape:
--   * Keys are app-defined; today only `app_name` (string, 1..60
--     chars) is recognized. The list will grow — favicon, tagline,
--     support email, etc. — as we peel more literals out of the UI.
--   * NO CHECK constraint on the shape. The router-layer zod schema
--     is the source of truth for what keys / values are accepted;
--     keeping the column loose lets us add new keys with a code
--     change alone, no migration cost per addition.
--   * Default `'{}'::jsonb` (not NULL) so every group is guaranteed
--     to return an object from `SELECT constants FROM groups`,
--     letting the router derive the stable-shape response with a
--     simple `... ?? null` per key rather than a NULL check first.
--
-- Why per-group (not a system-wide constants table): the app is
-- multi-tenant and each tenant may want its own branding. A
-- global constant table would require a "override per-group"
-- layer immediately, so we skip straight to the per-group model.
-- A system-wide default is fine as a code-level fallback (see the
-- `|| "Waypoint"` fallback in the frontend hook).

BEGIN;

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS constants JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
