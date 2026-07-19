-- Curated "gold-standard" phase-size examples that seed Claude's
-- few-shot pool on the EZEstimates suggester. Distinct from real
-- projects — an admin uploads a CSV of hand-vetted title +
-- description + per-phase-day rows to teach the model what a good
-- estimate looks like for THIS tenant's work.
--
-- The union of this table + historical projects where
-- projects.dev_estimate_sourced_by_dev = TRUE replaces the previous
-- "last 15 completed projects" few-shot heuristic. Curated rows are
-- presented FIRST in the prompt (highest priority) and the loader
-- caps the total at 30 examples so token cost stays bounded.
--
-- Design choices:
--   * Per-group like every other catalog table (swim lanes, teams,
--     KPIs, t-shirt sizes). Rows cascade on group delete.
--   * At least ONE of the three *_days columns must be non-null —
--     a curator may only feel confident sizing e.g. Development but
--     want to leave Discovery / Post-Dev out. The loader tolerates
--     the missing phases the same way it does for historical rows
--     with incomplete date coverage.
--   * Day values must be >= 0 (mirrors the just-relaxed t-shirt
--     size constraint in 030 — zero is a legitimate phase length
--     when a phase is expected to be a no-op).
--   * `position` is per-group and starts at max(position)+1 on
--     insert; drag-reorder rewrites the whole set in one txn.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_reference_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  discovery_days INTEGER,
  development_days INTEGER,
  post_dev_days INTEGER,
  notes TEXT,
  source_label TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ai_reference_estimates_days_present_check
    CHECK (
      discovery_days IS NOT NULL
      OR development_days IS NOT NULL
      OR post_dev_days IS NOT NULL
    ),
  CONSTRAINT ai_reference_estimates_days_nonneg_check
    CHECK (
      (discovery_days IS NULL OR discovery_days >= 0)
      AND (development_days IS NULL OR development_days >= 0)
      AND (post_dev_days IS NULL OR post_dev_days >= 0)
    )
);

CREATE INDEX IF NOT EXISTS ai_reference_estimates_group_idx
  ON ai_reference_estimates (group_id);

CREATE INDEX IF NOT EXISTS ai_reference_estimates_group_position_idx
  ON ai_reference_estimates (group_id, position);

COMMIT;
