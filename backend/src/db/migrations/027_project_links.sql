-- Per-project external links.
--
-- Projects routinely have supplemental URLs — a Jira epic, a
-- Confluence page, a Figma file, a Notion runbook. Previously the
-- PM shoved these into the description as raw text; a dedicated
-- section keeps them one click away from the detail panel with a
-- label + href pair.
--
-- Design choices:
--   * `label` is stored per-link (denormalized string), NOT
--     normalized into a separate label catalog. Users freely rename
--     a single link's label without cascading edits. Cross-project
--     "suggested labels" are derived at query time from DISTINCT
--     labels within the caller's group — cheap because there will
--     never be many links per tenant, and it keeps the schema simple.
--   * `position` mirrors the design used on project_kpis (mig 014)
--     and project_teams (mig 026): a per-project sequence enforced
--     by a UNIQUE index so drag-to-reorder can land as an atomic
--     full-replace without gaps. No reorder UI ships in this pass,
--     but adding the column now avoids a follow-up migration.
--   * No group_id column here: the parent project_id already scopes
--     to a tenant via projects.group_id, and every route filters on
--     the caller's current group before reading/writing.
--   * Cross-tenant label suggestions can't leak because the DISTINCT
--     query is scoped to project_links rows whose parent project
--     belongs to the caller's group.
--   * No seed for "Jira" / "Confluence" — those defaults live in the
--     frontend suggestion list and are only inserted here when a
--     user actually creates a link carrying that label.

BEGIN;

CREATE TABLE IF NOT EXISTS project_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  position INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, position)
);

CREATE INDEX IF NOT EXISTS project_links_project_idx
  ON project_links (project_id);

COMMIT;
