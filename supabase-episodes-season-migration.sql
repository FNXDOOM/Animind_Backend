-- Episodes season-aware identity migration
-- Prevents collisions like S01E01 vs S03E01 for the same show.

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS season_number integer;

UPDATE episodes
SET season_number = 1
WHERE season_number IS NULL OR season_number < 1;

ALTER TABLE episodes
  ALTER COLUMN season_number SET DEFAULT 1;

ALTER TABLE episodes
  ALTER COLUMN season_number SET NOT NULL;

ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_show_id_episode_number_key;

ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_show_id_season_number_episode_number_key;

ALTER TABLE episodes
  ADD CONSTRAINT episodes_show_id_season_number_episode_number_key
  UNIQUE (show_id, season_number, episode_number);

CREATE INDEX IF NOT EXISTS episodes_show_season_episode_idx
  ON episodes (show_id, season_number, episode_number);
