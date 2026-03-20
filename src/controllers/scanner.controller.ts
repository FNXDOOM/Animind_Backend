import { Request, Response } from 'express';
import { runScan } from '../services/scanner.service.js';
import { supabase } from '../config/db.js';

/**
 * POST /api/rescan
 * Triggers a manual library scan and returns the updated show list.
 * This is what the frontend's "Scan Cloud Storage" button calls.
 */
export async function rescanLibrary(req: Request, res: Response) {
  try {
    console.log('[Rescan] Manual scan triggered.');
    const scanResult = await runScan();

    // Return the updated show list so the frontend can refresh immediately
    const { data: shows } = await supabase
      .from('shows')
      .select('id, title, synopsis, cover_image_url, genres, rating, episode_count, studio, status, year, trailer_id, trailer_site, trailer_thumbnail')
      .order('title');

    // Map to the Anime shape the frontend expects
    const mapped = (shows ?? []).map((s: any) => ({
      id: s.id,
      title: s.title,
      synopsis: s.synopsis ?? '',
      imageUrl: s.cover_image_url ?? '',
      rating: s.rating ?? 0,
      genres: s.genres ?? [],
      episodes: s.episode_count ?? 0,
      studio: s.studio ?? '',
      status: s.status ?? '',
      year: s.year ?? '',
      reason: 'From your cloud library',
      trailer: s.trailer_id
        ? { id: s.trailer_id, site: s.trailer_site ?? 'youtube', thumbnail: s.trailer_thumbnail }
        : undefined,
    }));

    res.json(mapped);

    // Log scan stats (non-blocking)
    console.log(`[Rescan] Completed. Scanned: ${scanResult.scanned}, Inserted: ${scanResult.inserted}, Errors: ${scanResult.errors.length}, Time: ${scanResult.durationMs}ms`);
  } catch (err: any) {
    console.error('[Rescan] Error:', err.message);
    res.status(500).json({ error: 'Scan failed.', details: err.message });
  }
}

/**
 * POST /api/webhooks/storage
 * Triggered automatically by S3 event notifications when a file is uploaded.
 * This should be protected by a secret header in production.
 */
export async function storageWebhook(req: Request, res: Response) {
  const secret = req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid webhook secret.' });
    return;
  }

  // Acknowledge immediately, then scan in background
  res.json({ received: true });
  runScan().catch(err => console.error('[Webhook] Background scan failed:', err.message));
}
