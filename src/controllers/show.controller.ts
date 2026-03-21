import { Request, Response } from 'express';
import { supabase } from '../config/db.js';

/** GET /api/shows
 * Returns all shows, ordered by title.
 * Query params: ?limit=50&offset=0
 */
export async function getShows(req: Request, res: Response) {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 200);
  const offset = parseInt((req.query.offset as string) ?? '0', 10);

  const { data, error, count } = await supabase
    .from('shows')
    .select(
      'id, title, synopsis, cover_image_url, genres, rating, episode_count, studio, status, year, anilist_id, trailer_id, trailer_site, trailer_thumbnail',
      { count: 'exact' }
    )
    .order('title')
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[Shows] getShows error:', error.message);
    res.status(500).json({ error: 'Failed to fetch shows.' });
    return;
  }

  res.json({ data, total: count, limit, offset });
}

/** GET /api/shows/:id
 * Returns a show + its episodes ordered by episode_number.
 *
 * FIX: deduplicate episodes by episode_number before sending the response.
 * If the scanner created duplicate rows (e.g. due to the broken upsert conflict
 * key), the API would return the same episode dozens of times.  We keep only
 * the first occurrence of each episode_number so the frontend sidebar always
 * shows a clean list, even before the DB duplicates are pruned by the scanner.
 */
export async function getShowById(req: Request, res: Response) {
  const { id } = req.params;

  const { data: show, error: showError } = await supabase
    .from('shows')
    .select('*')
    .eq('id', id)
    .single();

  if (showError || !show) {
    res.status(404).json({ error: 'Show not found.' });
    return;
  }

  // Fetch episodes for this show ordered by episode number.
  // Explicit limit of 10000 — Supabase's default PostgREST page size is
  // 1000 rows, which would silently truncate shows with many episodes.
  const { data: episodesRaw, error: epError } = await supabase
    .from('episodes')
    .select('id, episode_number, title, duration, created_at')
    .eq('show_id', id)
    .order('episode_number', { ascending: true })
    .limit(10000);

  if (epError) {
    console.error('[Shows] getShowById episodes error:', epError.message);
    res.status(500).json({ error: 'Failed to fetch episodes.' });
    return;
  }

  // Normalise episode_number: Postgres numeric columns come back as floats
  // (e.g. 21.0). Strip the trailing .0 for whole numbers but preserve
  // genuine fractional episodes (e.g. 5.5 specials) without rounding them
  // into an adjacent episode. NULL episode_number is kept as-is (null)
  // rather than collapsed to 0, so those rows are not silently merged.
  const normalise = (n: number | null): number | null => {
    if (n === null || n === undefined) return null;
    // If it is already a whole number stored as float (21.0 → 21), truncate.
    // If it is genuinely fractional (5.5), preserve it.
    return Number.isInteger(n) || Math.trunc(n) === n ? Math.trunc(n) : n;
  };

  const seen = new Set<number | null>();
  const episodes = (episodesRaw ?? [])
    .map(ep => ({ ...ep, episode_number: normalise(ep.episode_number) }))
    .filter(ep => {
      // Skip rows with no episode number rather than merging them all at 0
      if (ep.episode_number === null) return false;
      if (seen.has(ep.episode_number)) return false;
      seen.add(ep.episode_number);
      return true;
    })
    .sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0));

  res.json({ ...show, episodes });
}
