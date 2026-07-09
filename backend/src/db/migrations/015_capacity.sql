-- Capacity planning: each user and each team gets a maximum-concurrent-
-- projects cap. A project counts against an entity on every calendar
-- day covered by its roadmap bar (start_date … optimization_end_date).
-- The client warns the PM when a save would push an owner or team past
-- their cap, and the Roadmap draws an overload indicator on the
-- affected rows. The cap is a soft signal, not a server-enforced block
-- — PMs can override with eyes-open.
--
-- Nullable so admins can turn a cap OFF entirely (interpretation:
-- unbounded). Default = 3 matches the product spec's default and gets
-- backfilled onto every existing row via PostgreSQL's ADD COLUMN
-- semantics.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS capacity INT DEFAULT 3
    CHECK (capacity IS NULL OR capacity >= 1);

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS capacity INT DEFAULT 3
    CHECK (capacity IS NULL OR capacity >= 1);
