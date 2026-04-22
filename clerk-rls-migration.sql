-- ============================================================
-- Clerk + Supabase RLS Integration
--
-- Run this entire script in Supabase → SQL Editor.
--
-- How it works:
-- The frontend sends the default Clerk session token as the
-- Bearer token on every Supabase request. Supabase reads the
-- JWT and extracts auth.jwt() ->> 'sub' which is the Clerk
-- user ID. RLS policies check this against the user_id column.
--
-- No custom JWT template or signing key is needed in Clerk.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- WATCHLIST
-- ────────────────────────────────────────────────────────────
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own watchlist" ON watchlist;
DROP POLICY IF EXISTS "Users can insert own watchlist" ON watchlist;
DROP POLICY IF EXISTS "Users can update own watchlist" ON watchlist;
DROP POLICY IF EXISTS "Users can delete own watchlist" ON watchlist;

CREATE POLICY "Users can view own watchlist"
  ON watchlist FOR SELECT
  USING (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can insert own watchlist"
  ON watchlist FOR INSERT
  WITH CHECK (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can update own watchlist"
  ON watchlist FOR UPDATE
  USING (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can delete own watchlist"
  ON watchlist FOR DELETE
  USING (user_id = (auth.jwt() ->> 'sub'));


-- ────────────────────────────────────────────────────────────
-- PROGRESS
-- ────────────────────────────────────────────────────────────
ALTER TABLE progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own progress" ON progress;
DROP POLICY IF EXISTS "Users can insert own progress" ON progress;
DROP POLICY IF EXISTS "Users can update own progress" ON progress;
DROP POLICY IF EXISTS "Users can delete own progress" ON progress;

CREATE POLICY "Users can view own progress"
  ON progress FOR SELECT
  USING (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can insert own progress"
  ON progress FOR INSERT
  WITH CHECK (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can update own progress"
  ON progress FOR UPDATE
  USING (user_id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can delete own progress"
  ON progress FOR DELETE
  USING (user_id = (auth.jwt() ->> 'sub'));


-- ────────────────────────────────────────────────────────────
-- VERIFY — run this after to confirm policies exist
-- ────────────────────────────────────────────────────────────
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE tablename IN ('watchlist', 'progress')
-- ORDER BY tablename, cmd;
