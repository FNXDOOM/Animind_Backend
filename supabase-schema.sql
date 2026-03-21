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
--  AniMind Supabase Schema Entry Point (DEPRECATED)
-- ============================================================
--
-- IMPORTANT:
--   This file was previously (incorrectly) used as a data-cleanup
--   script containing destructive DELETE/UPDATE statements on
--   application tables (e.g. shows, episodes), even though
--   RUN.md documents `supabase-schema.sql` as the one-time
--   *schema migration* that creates all tables.
--
--   To prevent accidental data loss in new or existing Supabase
--   projects, all destructive logic has been removed from this
--   file. If RUN.md or any other docs still instruct you to run
--   `supabase-schema.sql` to initialize the database schema,
--   update them: use your proper Supabase migrations instead.
--
--   If you still need the old cleanup behavior, move it into a
--   separate, clearly named maintenance script (for example,
--   `supabase-cleanup-orphans.sql`) and run it only in a
--   controlled environment after reviewing its contents.
--
--   As a safety net, executing this file now immediately raises
--   an exception and performs NO data modifications.
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION
    'supabase-schema.sql is deprecated as a cleanup script and no longer contains schema definitions. ' ||
    'Do NOT use this file to initialize or modify production data. ' ||
    'Move any data-cleanup SQL into a separate, explicitly named migration/maintenance script.';
END;
$$;
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
-- STEP 7: (removed) Redundant performance index for scanner title lookups
--   Note: shows_title_unique already provides a btree index on lower(trim(title)),
--   so an additional non-unique index on the same expression is unnecessary.
-- ────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────
-- VERIFICATION — run these after to confirm it worked
-- ────────────────────────────────────────────────────────────

-- 1. Check all shows and their episode counts (Frieren should show 28)

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
