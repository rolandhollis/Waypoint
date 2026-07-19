-- Per-phase provenance columns so the EZEstimates row can show
-- "Updated <date> · <source>" at a glance and (on hover) break down
-- WHO last touched each of the three phase estimates and HOW.
--
-- Three phases × three fields = nine columns:
--   * <phase>_updated_at            — wall-clock of the last mutation
--   * <phase>_updated_by_user_id    — actor (nullable FK; users may be
--                                     deleted after making the edit)
--   * <phase>_updated_source        — one of 'user' | 'claude' | 'csv'
--                                     | 'cascade'. TEXT + CHECK, not a
--                                     PG ENUM, to keep future value
--                                     additions cheap (no ALTER TYPE
--                                     dance) — the router is the true
--                                     source of allowed values.
--
-- Why per-phase and not row-level:
--   * Estimates for the three phases move independently. Claude may
--     size Development while a PM manually sizes Discovery on the
--     same afternoon; a row-level pair would lose that.
--   * The EZEstimates row wants the MOST RECENT of the three plus a
--     per-phase breakdown on hover; both need the columns split.
--
-- Backfill policy: NONE. Legacy rows keep NULL across all nine
-- columns until their first update after this migration lands. The
-- UI treats NULL as "no update recorded yet" and hides the chip;
-- deriving provenance from `project_audit_events` was considered
-- and rejected — the misclassification risk (a `dev_start_date`
-- edit doesn't tell us WHICH ui path drove it) outweighs the
-- ~two-week gap where the chip stays blank for cards that already
-- had estimates set before this shipped.
--
-- ON DELETE SET NULL on the user FK matches the pattern used
-- everywhere else (project_audit_events.user_id, status_history.
-- moved_by_user_id, etc.): the audit fact survives the actor's
-- deletion; the actor label just falls back to "unknown user."

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS discovery_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discovery_updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discovery_updated_source TEXT
    CHECK (discovery_updated_source IS NULL
           OR discovery_updated_source IN ('user','claude','csv','cascade')),
  ADD COLUMN IF NOT EXISTS development_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS development_updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS development_updated_source TEXT
    CHECK (development_updated_source IS NULL
           OR development_updated_source IN ('user','claude','csv','cascade')),
  ADD COLUMN IF NOT EXISTS post_dev_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS post_dev_updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS post_dev_updated_source TEXT
    CHECK (post_dev_updated_source IS NULL
           OR post_dev_updated_source IN ('user','claude','csv','cascade'));

COMMIT;
