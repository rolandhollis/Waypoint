-- Per-workspace SHOP Brand code for Jira sync / JPD CSV export.
-- Stored in groups.constants.jira_brand_code (no new column).
-- Seed known tenants; admins can edit via Admin → Constants.

UPDATE groups
   SET constants = jsonb_set(
         COALESCE(constants, '{}'::jsonb),
         '{jira_brand_code}',
         '"RMN"'::jsonb,
         true
       ),
       updated_at = NOW()
 WHERE name = 'RetailMeNot'
   AND COALESCE(constants->>'jira_brand_code', '') = '';

UPDATE groups
   SET constants = jsonb_set(
         COALESCE(constants, '{}'::jsonb),
         '{jira_brand_code}',
         '"VC"'::jsonb,
         true
       ),
       updated_at = NOW()
 WHERE name = 'VoucherCodes'
   AND COALESCE(constants->>'jira_brand_code', '') = '';
