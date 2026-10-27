-- Pretty, shareable slug for the public idea form (/ideas/<slug>).
-- Unique when set; UUIDs still work as a fallback lookup.

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS public_slug TEXT;

-- Backfill from the group name (lowercase kebab). Collision-safe:
-- if two groups slugify the same, append a short id suffix.
WITH candidates AS (
  SELECT
    id,
    NULLIF(
      trim(both '-' FROM lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))),
      ''
    ) AS base_slug
  FROM groups
  WHERE public_slug IS NULL
),
ranked AS (
  SELECT
    id,
    COALESCE(base_slug, 'workspace') AS base_slug,
    row_number() OVER (
      PARTITION BY COALESCE(base_slug, 'workspace')
      ORDER BY id
    ) AS rn
  FROM candidates
)
UPDATE groups g
   SET public_slug = CASE
         WHEN r.rn = 1 THEN left(r.base_slug, 60)
         ELSE left(r.base_slug, 50) || '-' || substr(replace(g.id::text, '-', ''), 1, 6)
       END,
       updated_at = NOW()
  FROM ranked r
 WHERE g.id = r.id
   AND g.public_slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS groups_public_slug_uidx
  ON groups (public_slug)
  WHERE public_slug IS NOT NULL;

ALTER TABLE groups
  DROP CONSTRAINT IF EXISTS groups_public_slug_format;
ALTER TABLE groups
  ADD CONSTRAINT groups_public_slug_format
  CHECK (
    public_slug IS NULL
    OR public_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  );
