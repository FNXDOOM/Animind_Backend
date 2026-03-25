-- One-time cleanup for duplicate shows.
-- Handles:
-- 1) direct identity duplicates (same anilist_id OR same normalized title when anilist_id is null)
-- 2) practical duplicates that share the same top-level episode folder root
--
-- Run inside a transaction in Supabase SQL editor if you want easy rollback:
-- BEGIN;
--   ...script...
-- COMMIT;

-- A. Build mapping duplicate_show_id -> canonical_show_id using two signals:
--    identity_key and folder_root.
WITH episode_roots AS (
  SELECT
    e.show_id,
    split_part(replace(e.file_path, '\\', '/'), '/', 1) AS folder_root,
    COUNT(*) AS ep_count
  FROM episodes e
  GROUP BY e.show_id, split_part(replace(e.file_path, '\\', '/'), '/', 1)
),
show_quality AS (
  SELECT
    s.id,
    s.title,
    s.anilist_id,
    s.created_at,
    COALESCE('anilist:' || s.anilist_id::text, 'title:' || trim(regexp_replace(lower(s.title), '[^a-z0-9]+', ' ', 'g'))) AS identity_key,
    (
      CASE WHEN s.anilist_id IS NOT NULL THEN 8 ELSE 0 END +
      CASE WHEN s.cover_image_url IS NOT NULL AND s.cover_image_url <> '' THEN 4 ELSE 0 END +
      CASE WHEN s.synopsis IS NOT NULL AND s.synopsis <> '' THEN 2 ELSE 0 END +
      CASE WHEN s.genres IS NOT NULL AND cardinality(s.genres) > 0 THEN 1 ELSE 0 END +
      CASE WHEN s.rating IS NOT NULL THEN 1 ELSE 0 END
    ) AS quality_score
  FROM shows s
),
identity_ranked AS (
  SELECT
    sq.id,
    sq.identity_key,
    ROW_NUMBER() OVER (
      PARTITION BY sq.identity_key
      ORDER BY sq.quality_score DESC, sq.created_at ASC NULLS LAST, sq.id
    ) AS rn
  FROM show_quality sq
),
identity_map AS (
  SELECT d.id AS duplicate_show_id, c.id AS canonical_show_id
  FROM identity_ranked d
  JOIN identity_ranked c
    ON c.identity_key = d.identity_key
   AND c.rn = 1
  WHERE d.rn > 1
),
root_ranked AS (
  SELECT
    er.folder_root,
    sq.id AS show_id,
    sq.quality_score,
    sq.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY er.folder_root
      ORDER BY sq.quality_score DESC, er.ep_count DESC, sq.created_at ASC NULLS LAST, sq.id
    ) AS rn
  FROM episode_roots er
  JOIN show_quality sq ON sq.id = er.show_id
  WHERE er.folder_root IS NOT NULL AND er.folder_root <> ''
),
root_map AS (
  SELECT d.show_id AS duplicate_show_id, c.show_id AS canonical_show_id
  FROM root_ranked d
  JOIN root_ranked c
    ON c.folder_root = d.folder_root
   AND c.rn = 1
  WHERE d.rn > 1
),
combined_map AS (
  SELECT duplicate_show_id, canonical_show_id FROM identity_map
  UNION
  SELECT duplicate_show_id, canonical_show_id FROM root_map
),
final_map AS (
  SELECT cm.duplicate_show_id, MIN(cm.canonical_show_id) AS canonical_show_id
  FROM combined_map cm
  WHERE cm.duplicate_show_id <> cm.canonical_show_id
  GROUP BY cm.duplicate_show_id
)
-- B. Repoint episodes.
UPDATE episodes e
SET show_id = fm.canonical_show_id
FROM final_map fm
WHERE e.show_id = fm.duplicate_show_id;

-- C. Remove duplicate episodes produced by repointing.
DELETE FROM episodes e
USING (
  SELECT
    show_id,
    COALESCE(season_number, 1) AS season_number,
    episode_number,
    MIN(id) AS keep_id
  FROM episodes
  GROUP BY show_id, COALESCE(season_number, 1), episode_number
  HAVING COUNT(*) > 1
) dup
WHERE e.show_id = dup.show_id
  AND COALESCE(e.season_number, 1) = dup.season_number
  AND e.episode_number = dup.episode_number
  AND e.id <> dup.keep_id;

-- D. Delete shows that have no episodes anymore (orphans).
DELETE FROM shows s
WHERE NOT EXISTS (
  SELECT 1
  FROM episodes e
  WHERE e.show_id = s.id
);

-- E. Optional verification helpers.
-- 1) Remaining duplicate keys
-- SELECT identity_key, COUNT(*)
-- FROM (
--   SELECT COALESCE('anilist:' || anilist_id::text, 'title:' || trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))) AS identity_key
--   FROM shows
-- ) t
-- GROUP BY identity_key
-- HAVING COUNT(*) > 1;

-- 2) Remaining duplicate folder roots across shows
-- SELECT folder_root, COUNT(DISTINCT show_id)
-- FROM (
--   SELECT split_part(replace(file_path, '\\', '/'), '/', 1) AS folder_root, show_id
--   FROM episodes
-- ) x
-- GROUP BY folder_root
-- HAVING COUNT(DISTINCT show_id) > 1;
