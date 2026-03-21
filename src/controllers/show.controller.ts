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

  // Fetch ALL episodes for this show — no limit, ordered by episode number.
  // episode_number is stored as numeric/float in Postgres (e.g. 21.0) so we
  // cast it to int for reliable dedup and sorting.
  const { data: episodesRaw, error: epError } = await supabase
    .from('episodes')
    .select('id, episode_number, title, duration, created_at')
    .eq('show_id', id)
    .order('episode_number', { ascending: true })
    .limit(10000); // explicit high limit — Supabase default is 1000

  if (epError) {
    console.error('[Shows] getShowById episodes error:', epError.message);
    res.status(500).json({ error: 'Failed to fetch episodes.' });
    return;
  }

  // Deduplicate by episode_number — cast to integer first so that 1.0 and 1
  // are treated as the same episode (Postgres numeric columns may return floats).
  const seen = new Set<number>();
  const episodes = (episodesRaw ?? [])
    .map(ep => ({ ...ep, episode_number: Math.round(ep.episode_number ?? 0) }))
    .filter(ep => {
      if (seen.has(ep.episode_number)) return false;
      seen.add(ep.episode_number);
      return true;
    })
    .sort((a, b) => a.episode_number - b.episode_number);

  res.json({ ...show, episodes });
}
