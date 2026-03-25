-- SyncPlay TTL migration
-- Adds ended_at support so ended watch parties can be deleted after TTL.

ALTER TABLE watch_parties
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

CREATE INDEX IF NOT EXISTS watch_parties_status_ended_at_idx
  ON watch_parties (status, ended_at);

CREATE INDEX IF NOT EXISTS watch_party_participants_party_id_idx
  ON watch_party_participants (party_id);
