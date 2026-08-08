BEGIN;

ALTER TABLE prediction_questions
  ADD COLUMN IF NOT EXISTS kalshi_market_ticker TEXT,
  ADD COLUMN IF NOT EXISTS kalshi_yes_price NUMERIC(5, 4);

COMMIT;
