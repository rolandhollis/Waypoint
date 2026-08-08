BEGIN;

-- Daily prediction game: one yes/no question per group per calendar day
-- (America/Chicago). Voting closes at 5:00pm CT on game_date.

CREATE TABLE IF NOT EXISTS prediction_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_date DATE NOT NULL,
  question_text TEXT NOT NULL,
  event_summary TEXT NOT NULL,
  event_time_hint TEXT,
  cutoff_at TIMESTAMPTZ NOT NULL,
  outcome BOOLEAN,
  outcome_note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  llm_model TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (group_id, game_date)
);

CREATE INDEX IF NOT EXISTS prediction_questions_group_date
  ON prediction_questions (group_id, game_date DESC);

CREATE TABLE IF NOT EXISTS prediction_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES prediction_questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prediction BOOLEAN NOT NULL,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, user_id)
);

CREATE INDEX IF NOT EXISTS prediction_votes_question
  ON prediction_votes (question_id);

COMMIT;
