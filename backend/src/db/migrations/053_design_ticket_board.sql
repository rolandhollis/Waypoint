-- Product Design Ticket Board (PRD): workflow status + Jira/links,
-- independent of assignee / Unassigned / Completed columns.
--
-- `status` remains the lifecycle bucket (next_up | in_design |
-- completed | deleted). `ticket_status` is the colored card pill
-- (Not started, On-track, At Risk, In Review, In Development, Completed).
-- Assignee stays on `assigned_to` so completing a ticket no longer
-- overwrites who owned it.

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS ticket_status TEXT NOT NULL DEFAULT 'not';

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS jira_key VARCHAR(64);

ALTER TABLE design_items
  ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill workflow status from existing lifecycle status.
UPDATE design_items
   SET ticket_status = CASE status
     WHEN 'next_up' THEN 'not'
     WHEN 'in_design' THEN 'on'
     WHEN 'completed' THEN 'done'
     ELSE 'not'
   END
 WHERE ticket_status = 'not'
   AND status IN ('in_design', 'completed');

-- Enforce allowlist (extensible: add new CHECK values in a later migration).
ALTER TABLE design_items
  DROP CONSTRAINT IF EXISTS design_items_ticket_status_check;

ALTER TABLE design_items
  ADD CONSTRAINT design_items_ticket_status_check
  CHECK (ticket_status IN ('not', 'on', 'risk', 'review', 'indev', 'done'));

CREATE INDEX IF NOT EXISTS design_items_group_assignee_idx
  ON design_items (group_id, assigned_to, status, position)
  WHERE status IN ('next_up', 'in_design');
