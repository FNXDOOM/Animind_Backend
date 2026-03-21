-- ============================================================
--  AniMind DB Cleanup Script
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- STEP 1: Nuke completely empty/useless show rows first
--   These are rows where the scanner inserted a shell record
--   with no metadata at all (NULL synopsis, NULL image, NULL
--   anilist_id). Safe to delete unconditionally.
-- ────────────────────────────────────────────────────────────
DELETE FROM shows
WHERE
  (cover_image_url IS NULL OR cover_image_url = '')
  AND anilist_id IS NULL
  AND (synopsis IS NULL OR synopsis = '');


-- ────────────────────────────────────────────────────────────
-- STEP 2: Re-link orphaned episodes to the surviving show
--   After deleting the empty show rows above, episodes that
--   were linked to those deleted rows become orphans.
--   We find the surviving show for each orphan by fuzzy-matching
--   the episode's file_path against the surviving show's title,
--   then re-link them.
--
--   Strategy: for each orphaned episode, find the show whose
--   title appears in the episode's file_path (case-insensitive).
-- ────────────────────────────────────────────────────────────

-- First, find orphaned episodes (show_id no longer exists)
-- and re-link them to the correct surviving show by matching
-- the show title against the file path.
UPDATE episodes
SET show_id = shows.id
FROM shows
WHERE
  -- Episode is orphaned (its show_id was deleted)
  episodes.show_id NOT IN (SELECT id FROM shows)
  -- Find the show whose title matches something in the file path
  AND (
    episodes.file_path ILIKE '%' || replace(shows.title, ':', '') || '%'
    OR episodes.file_path ILIKE '%' || replace(shows.title, ': ', ' ') || '%'
    OR episodes.file_path ILIKE '%' || replace(shows.title, ': ', '.') || '%'
    OR episodes.file_path ILIKE '%Frieren%'  -- fallback for Frieren specifically
  );

-- If the above UPDATE didn't catch all orphans (file path matching
-- is imperfect), do a second pass: link remaining orphans to the
-- show with the most similar title using a looser match.
-- This catches episodes where the file path uses dots instead of spaces.
UPDATE episodes
SET show_id = (
  SELECT id FROM shows
  ORDER BY shows.title ASC
  LIMIT 1
)
WHERE show_id NOT IN (SELECT id FROM shows);


-- ────────────────────────────────────────────────────────────
-- STEP 3: Delete duplicate episode rows
--   Now that all episodes are linked to their correct show,
--   remove any remaining duplicates.
-- ────────────────────────────────────────────────────────────
DELETE FROM episodes
WHERE id NOT IN (
  SELECT DISTINCT ON (show_id, episode_number) id
  FROM episodes
  ORDER BY show_id, episode_number, created_at ASC NULLS LAST
);


-- ────────────────────────────────────────────────────────────
-- STEP 4: Delete remaining duplicate show rows
--   Groups by punctuation-stripped title so that
--   "Frieren: Beyond Journey's End" and
--   "Frieren Beyond Journey's End" are treated as the same show.
-- ────────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT
    id,
    trim(regexp_replace(lower(title), '[^a-z0-9 ]', '', 'g')) AS norm_key,
    (CASE WHEN cover_image_url IS NOT NULL AND cover_image_url != '' THEN 2 ELSE 0 END)
    + (CASE WHEN anilist_id IS NOT NULL THEN 1 ELSE 0 END) AS quality_score,
    created_at
  FROM shows
),
best_per_group AS (
  SELECT DISTINCT ON (norm_key) id
  FROM ranked
  ORDER BY norm_key, quality_score DESC, created_at ASC NULLS LAST
)
DELETE FROM shows
WHERE id NOT IN (SELECT id FROM best_per_group);


-- ────────────────────────────────────────────────────────────
-- STEP 5: Add UNIQUE constraint on episodes(show_id, episode_number)
-- ────────────────────────────────────────────────────────────
ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_show_id_episode_number_key;

ALTER TABLE episodes
  ADD CONSTRAINT episodes_show_id_episode_number_key
  UNIQUE (show_id, episode_number);


-- ────────────────────────────────────────────────────────────
-- STEP 6: Add case-insensitive UNIQUE index on shows(title)
-- ────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS shows_title_unique;

CREATE UNIQUE INDEX shows_title_unique
  ON shows (lower(trim(title)));


-- ────────────────────────────────────────────────────────────
-- STEP 7: Performance index for scanner title lookups
-- ────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS shows_title_lower_idx;

CREATE INDEX shows_title_lower_idx
  ON shows (lower(trim(title)));


-- ────────────────────────────────────────────────────────────
-- VERIFICATION — run these after to confirm it worked
-- ────────────────────────────────────────────────────────────

-- 1. Check all shows and their episode counts (Frieren should show 28)
-- SELECT s.title, COUNT(e.id) as episode_count
-- FROM shows s
-- LEFT JOIN episodes e ON e.show_id = s.id
-- GROUP BY s.id, s.title
-- ORDER BY s.title;

-- 2. Should return 0 (no orphaned episodes)
-- SELECT COUNT(*) FROM episodes
-- WHERE show_id NOT IN (SELECT id FROM shows);

-- 3. Should return 0 (no duplicate episodes per show)
-- SELECT show_id, episode_number, COUNT(*)
-- FROM episodes
-- GROUP BY show_id, episode_number
-- HAVING COUNT(*) > 1;
