-- Originally added an A/B Testing "Parking Lot" lane. That approach was
-- dropped — new experiments go to the end of Backlog (ideas) instead.
-- This migration is intentionally a no-op so environments that already
-- applied the old insert keep a stable migration history; 063 cleans up.
SELECT 1;
