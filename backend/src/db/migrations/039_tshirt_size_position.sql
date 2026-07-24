-- T-shirt sizes are no longer a fixed-cardinality ladder. The
-- Admin → T-Shirt Sizes tab now supports add / delete / drag-reorder
-- (see backend/src/routes/tshirtSizes.ts), which means position is a
-- sort key rather than a slot identifier. Migration 028 declared
-- UNIQUE (group_id, position) to enforce the fixed 0..4 slot layout;
-- that constraint conflicts with the reorder flow, which rewrites
-- every row's position sequentially inside one transaction and would
-- otherwise trip the unique index mid-statement.
--
-- Dropping the uniqueness lets reorder just `UPDATE ... SET position
-- = $1 WHERE id = $2` per row without a temp offset dance. Position
-- remains meaningful (`ORDER BY position ASC` on GET) but is now
-- allowed to be sparse (after deletes) or duplicated in transit
-- (during reorder). The router is the sole writer, so drift is not
-- an operational concern.
--
-- The UNIQUE (group_id, label) constraint stays put — labels still
-- need to be unique within a tenant so the picker doesn't render two
-- rows that look identical.

BEGIN;

ALTER TABLE tshirt_sizes
  DROP CONSTRAINT IF EXISTS tshirt_sizes_group_id_position_key;

COMMIT;
