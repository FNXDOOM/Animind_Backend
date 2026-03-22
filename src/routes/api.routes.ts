import { Router } from 'express';
import { getShows, getShowById } from '../controllers/show.controller.js';
import { streamEpisode, getEpisodeSubtitles, getEpisodeStreamTicket, getEpisodeAudioTracks } from '../controllers/episode.controller.js';
import { rescanLibrary, storageWebhook } from '../controllers/scanner.controller.js';
import { listUsers, setAdminStatus, deleteShow, triggerAdminScan } from '../controllers/admin.controller.js';
import { deleteMyAccount } from '../controllers/account.controller.js';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth.middleware.js';
import { createIpRateLimiter } from '../middleware/rateLimit.middleware.js';

const router = Router();
const rescanRateLimit = createIpRateLimiter(3, 60 * 1000);
const webhookRateLimit = createIpRateLimiter(30, 60 * 1000);

// ── Public (no auth required) ────────────────────────────────────────────────
// Shows — frontend fetches these for the "My Cloud Shows" view
router.get('/shows', getShows);
router.get('/shows/:id', getShowById);

// Manual library rescan — called by "Scan Cloud Storage" button in App.tsx
router.post('/rescan', rescanRateLimit as any, requireAuth as any, requireAdmin as any, rescanLibrary);

// S3 webhook — called by bucket event notifications (protect with WEBHOOK_SECRET)
router.post('/webhooks/storage', webhookRateLimit as any, storageWebhook);

// ── Auth-protected ───────────────────────────────────────────────────────────
// Stream endpoint — frontend VideoModal fetches this for the actual video URL
router.get('/episodes/:id/stream-ticket', requireAuth as any, getEpisodeStreamTicket);
router.get('/episodes/:id/stream', streamEpisode);
router.get('/episodes/:id/subtitles', requireAuth as any, getEpisodeSubtitles);
router.get('/episodes/:id/audio-tracks', requireAuth as any, getEpisodeAudioTracks);
router.delete('/account', requireAuth as any, deleteMyAccount as any);

// ── Admin-only ───────────────────────────────────────────────────────────────
router.get('/admin/users', requireAuth as any, requireAdmin as any, listUsers);
router.patch('/admin/users/:id', requireAuth as any, requireAdmin as any, setAdminStatus);
router.delete('/admin/shows/:id', requireAuth as any, requireAdmin as any, deleteShow);
router.post('/admin/scan', requireAuth as any, requireAdmin as any, triggerAdminScan);

export default router;
