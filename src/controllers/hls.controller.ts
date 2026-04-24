/**
 * hls.controller.ts
 *
 * HTTP endpoints for HLS segmented streaming.
 * Sessions are created when a user needs a non-default or non-browser-safe
 * audio track. The frontend uses hls.js to consume the playlist and segments.
 */

import { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { verifyToken } from '@clerk/backend';
import { supabase } from '../config/db.js';
import {
  createSession,
  getPlaylist,
  getSegmentPath,
  seekSession,
  destroySession,
  hasSession,
} from '../services/hlsSession.service.js';
import { getStreamInfo } from '../services/stream.service.js';
import { env } from '../config/env.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function verifyBearerAuth(authHeader?: string): Promise<string | null> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
  if (!token) return null;
  try {
    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * POST /api/episodes/:id/hls-session
 * Body: { audioTrackIndex: number, startTime?: number }
 * Returns: { sessionId, playlistUrl }
 */
export async function createHlsSessionHandler(req: Request, res: Response) {
  const userId = await verifyBearerAuth(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { id } = req.params;
  const { audioTrackIndex, startTime } = req.body as {
    audioTrackIndex?: number;
    startTime?: number;
  };

  if (typeof audioTrackIndex !== 'number' || !Number.isFinite(audioTrackIndex)) {
    res.status(400).json({ error: 'audioTrackIndex is required and must be a number.' });
    return;
  }

  // Fetch episode
  const { data: episode, error } = await supabase
    .from('episodes')
    .select('id, file_path, bucket_name')
    .eq('id', id)
    .single();

  if (error || !episode) {
    res.status(404).json({ error: 'Episode not found.' });
    return;
  }

  // HLS only supported for local storage
  if (env.STORAGE_MODE !== 'local') {
    res.status(400).json({ error: 'HLS streaming is only supported in local storage mode.' });
    return;
  }

  try {
    const streamInfo = await getStreamInfo(episode.file_path, episode.bucket_name);
    if (streamInfo.type !== 'proxy') {
      res.status(400).json({ error: 'HLS streaming requires local storage.' });
      return;
    }

    const sourcePath = streamInfo.url;
    const safeStartTime = typeof startTime === 'number' && Number.isFinite(startTime) ? Math.max(0, startTime) : 0;

    const result = await createSession(sourcePath, id, audioTrackIndex, safeStartTime);

    res.json({
      sessionId: result.sessionId,
      playlistUrl: result.playlistUrl,
    });
  } catch (err: any) {
    console.error('[HLS] Session creation failed:', err.message);
    res.status(500).json({ error: 'Failed to create HLS session.' });
  }
}

/**
 * GET /api/hls/:sessionId/playlist.m3u8
 * Serves the live HLS playlist.
 */
export async function serveHlsPlaylist(req: Request, res: Response) {
  const { sessionId } = req.params;

  if (!hasSession(sessionId)) {
    res.status(404).json({ error: 'HLS session not found or expired.' });
    return;
  }

  try {
    const content = await getPlaylist(sessionId);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');

    if (!content) {
      // Playlist not ready yet — serve a minimal EVENT playlist so hls.js
      // polls for updates instead of treating it as a fatal error.
      const segDuration = Math.max(2, Math.min(30, env.HLS_SEGMENT_DURATION));
      res.send(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${segDuration}\n#EXT-X-PLAYLIST-TYPE:EVENT\n`
      );
      return;
    }

    // Diagnostic: log first 5 lines so we can confirm segment paths are relative (not absolute OS paths)
    const preview = content.split('\n').filter(l => l.trim()).slice(0, 6).join(' | ');
    console.log(`[HLS][${sessionId.slice(0, 8)}] playlist preview: ${preview}`);

    res.send(content);
  } catch (err: any) {
    console.error('[HLS] Playlist serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve playlist.' });
  }
}

/**
 * GET /api/hls/:sessionId/:segment
 * Serves an individual .ts segment file.
 */
export async function serveHlsSegment(req: Request, res: Response) {
  const { sessionId, segment } = req.params;

  if (!hasSession(sessionId)) {
    res.status(404).json({ error: 'HLS session not found or expired.' });
    return;
  }

  try {
    const segPath = await getSegmentPath(sessionId, segment);
    if (!segPath) {
      res.status(404).json({ error: 'Segment not found.' });
      return;
    }

    const stats = await stat(segPath);

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache, no-store');

    createReadStream(segPath).pipe(res);
  } catch (err: any) {
    console.error('[HLS] Segment serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve segment.' });
  }
}

/**
 * POST /api/hls/:sessionId/seek
 * Body: { time: number }
 * Restarts ffmpeg from the specified time position.
 */
export async function seekHlsSessionHandler(req: Request, res: Response) {
  const userId = await verifyBearerAuth(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { time } = req.body as { time?: number };

  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    res.status(400).json({ error: 'time is required and must be a non-negative number.' });
    return;
  }

  if (!hasSession(sessionId)) {
    res.status(404).json({ error: 'HLS session not found or expired.' });
    return;
  }

  try {
    const success = await seekSession(sessionId, time);
    if (!success) {
      res.status(500).json({ error: 'Failed to seek.' });
      return;
    }
    res.json({ success: true, seekedTo: time });
  } catch (err: any) {
    console.error('[HLS] Seek failed:', err.message);
    res.status(500).json({ error: 'Failed to seek.' });
  }
}

/**
 * DELETE /api/hls/:sessionId
 * Destroys a session — kills ffmpeg and cleans up temp files.
 */
export async function destroyHlsSessionHandler(req: Request, res: Response) {
  const { sessionId } = req.params;

  try {
    await destroySession(sessionId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[HLS] Destroy failed:', err.message);
    res.status(500).json({ error: 'Failed to destroy session.' });
  }
}
