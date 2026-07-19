-- Cache the most recent AI-generated phase-size suggestion per
-- project so the EZEstimates popover can show yesterday's answer
-- immediately (without a second call to Anthropic) and let the PM
-- choose whether to regenerate. The column is intentionally JSONB
-- rather than a normalized child table because:
--
--   * The shape may evolve as we tune the prompt / add fields
--     (token counts, model slug, per-phase alternate sizes) and
--     JSONB lets us iterate without a migration for each tweak.
--   * There is only ever ONE current suggestion per project — the
--     latest one wins; we don't keep history here. If we ever want
--     history it goes in a dedicated `ai_suggestion_history` table
--     with an FK back to projects.
--
-- Default NULL for both columns means "no suggestion has ever been
-- generated." The frontend treats that as "greenfield" and lets the
-- user press [Suggest] to generate the first one.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS ai_suggestion JSONB,
  ADD COLUMN IF NOT EXISTS ai_suggested_at TIMESTAMPTZ;

COMMIT;
