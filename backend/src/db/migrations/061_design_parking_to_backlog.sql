-- Move existing Parking Lot tickets (in_design + no assignee) into
-- Backlog (next_up + no assignee). New tickets still create in Parking Lot;
-- this is a one-time cutover for items already on the board.

UPDATE design_items
   SET status = 'next_up',
       updated_at = NOW()
 WHERE status = 'in_design'
   AND assigned_to IS NULL
   AND deleted_at IS NULL;
