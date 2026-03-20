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

  const { data: episodes, error: epError } = await supabase
    .from('episodes')
    .select('id, episode_number, title, duration, created_at')
    .eq('show_id', id)
    .order('episode_number');

  if (epError) {
    console.error('[Shows] getShowById episodes error:', epError.message);
    res.status(500).json({ error: 'Failed to fetch episodes.' });
    return;
  }

  res.json({ ...show, episodes: episodes ?? [] });
}
