-- Per-(group, filter-fingerprint) roadmap overview text.
--
-- Adds a small piece of PM-authored commentary that renders at the
-- top of the Roadmap view. Every user in a group sees the same
-- overview when they load the same filtered slice of the roadmap
-- (same filters + timeframe + group-by + sort mode + visible
-- project set), so this is stored server-side rather than in
-- per-browser localStorage.
--
-- The `fingerprint` column is the SHA-256 (or FNV-1a fallback) the
-- frontend already computes for the AI Roadmap Headline feature —
-- see frontend/src/lib/roadmapHeadline.ts. The backend treats the
-- value as an opaque per-view key; changes to what goes into the
-- hash are a frontend-only concern.
--
-- Empty bodies are never stored. When a save trims to "", the
-- route deletes the row so "absent === empty" is the invariant the
-- GET handler leans on.
--
-- No project-level audit trail: the overview isn't a project
-- field. `updated_at` + `updated_by` on the row itself is the full
-- change record the UI needs.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap_overviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (group_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS roadmap_overviews_group_id_idx ON roadmap_overviews(group_id);

COMMIT;
