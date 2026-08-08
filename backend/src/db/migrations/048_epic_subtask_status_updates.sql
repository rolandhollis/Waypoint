-- Optional subtask notes attached to an epic's weekly status update.
ALTER TABLE weekly_status_updates
  ADD COLUMN IF NOT EXISTS subtask_updates JSONB NOT NULL DEFAULT '[]'::jsonb;
