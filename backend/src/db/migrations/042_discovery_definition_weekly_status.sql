-- Require weekly status updates for projects in Discovery and Definition
-- lanes (same rule as Dev Ready / In Dev). Name-based so every tenant
-- group that uses those lane names picks up the change; VoucherCodes-style
-- workflows without those lanes are unaffected.

BEGIN;

UPDATE swim_lanes
   SET requires_weekly_status = TRUE,
       updated_at = NOW()
 WHERE name IN ('Discovery', 'Definition')
   AND requires_weekly_status = FALSE;

COMMIT;
