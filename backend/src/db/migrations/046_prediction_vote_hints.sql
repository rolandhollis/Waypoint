BEGIN;

ALTER TABLE prediction_questions
  ADD COLUMN IF NOT EXISTS vote_yes_hint TEXT NOT NULL DEFAULT 'Happens as scheduled tonight.',
  ADD COLUMN IF NOT EXISTS vote_no_hint TEXT NOT NULL DEFAULT 'Does not happen that way tonight.';

COMMIT;
