import { Router } from 'express';
import { getShows, getShowById } from '../controllers/show.controller.js';
import { streamEpisode, getEpisodeSubtitles, getEpisodeStreamTicket, getEpisodeAudioTracks } from '../controllers/episode.controller.js';
import {
  createHlsSessionHandler,
  serveHlsPlaylist,
  serveHlsSegment,
  seekHlsSessionHandler,
  destroyHlsSessionHandler,
} from '../controllers/hls.controller.js';
import { rescanLibrary, storageWebhook } from '../controllers/scanner.controller.js';
import { listUsers, setAdminStatus, deleteShow, triggerAdminScan } from '../controllers/admin.controller.js';
import { deleteMyAccount } from '../controllers/account.controller.js';
import { signUpWithServiceRole, loginWithPassword, getGoogleAuthUrl } from '../controllers/auth.controller.js';
import {
  exchangeClerkForDesktopSession,
  refreshDesktopSession,
  revokeDesktopSession,
} from '../controllers/desktopAuth.controller.js';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth.middleware.js';
import { createIpRateLimiter } from '../middleware/rateLimit.middleware.js';

const router = Router();
const rescanRateLimit = createIpRateLimiter(3, 60 * 1000);
const webhookRateLimit = createIpRateLimiter(30, 60 * 1000);
const signupRateLimit = createIpRateLimiter(10, 60 * 1000);
const loginRateLimit = createIpRateLimiter(20, 60 * 1000);
const publicReadRateLimit = createIpRateLimiter(120, 60 * 1000);
const streamTicketRateLimit = createIpRateLimiter(120, 60 * 1000);
const mediaStreamRateLimit = createIpRateLimiter(600, 60 * 1000);
const hlsSessionRateLimit = createIpRateLimiter(60, 60 * 1000);
const hlsSegmentRateLimit = createIpRateLimiter(1200, 60 * 1000);
const accountRateLimit = createIpRateLimiter(5, 60 * 1000);
const adminRateLimit = createIpRateLimiter(60, 60 * 1000);

// ── Public (no auth required) ────────────────────────────────────────────────
// Shows — frontend fetches these for the "My Cloud Shows" view
router.get('/shows', publicReadRateLimit as any, getShows);
router.get('/shows/:id', publicReadRateLimit as any, getShowById);
router.post('/auth/signup', signupRateLimit as any, signUpWithServiceRole);
router.post('/auth/login', loginRateLimit as any, loginWithPassword);
router.get('/auth/google-url', loginRateLimit as any, getGoogleAuthUrl);
router.post('/auth/desktop/exchange', loginRateLimit as any, exchangeClerkForDesktopSession);
router.post('/auth/desktop/refresh', loginRateLimit as any, refreshDesktopSession);
router.post('/auth/desktop/revoke', loginRateLimit as any, revokeDesktopSession);

// Manual library rescan — called by "Scan Cloud Storage" button in App.tsx
router.post('/rescan', rescanRateLimit as any, requireAuth as any, requireAdmin as any, rescanLibrary);

// S3 webhook — called by bucket event notifications (protect with WEBHOOK_SECRET)
router.post('/webhooks/storage', webhookRateLimit as any, storageWebhook);

// ── Auth-protected ───────────────────────────────────────────────────────────
// Stream endpoint — frontend VideoModal fetches this for the actual video URL
router.get('/episodes/:id/stream-ticket', streamTicketRateLimit as any, requireAuth as any, getEpisodeStreamTicket);
router.get('/episodes/:id/stream', mediaStreamRateLimit as any, streamEpisode);
router.post('/episodes/:id/hls-session', hlsSessionRateLimit as any, createHlsSessionHandler);
router.get('/hls/:sessionId/playlist.m3u8', hlsSegmentRateLimit as any, serveHlsPlaylist);
router.get('/hls/:sessionId/:segment', hlsSegmentRateLimit as any, serveHlsSegment);
router.post('/hls/:sessionId/seek', hlsSessionRateLimit as any, seekHlsSessionHandler);
router.delete('/hls/:sessionId', hlsSessionRateLimit as any, destroyHlsSessionHandler);
router.get('/episodes/:id/subtitles', publicReadRateLimit as any, requireAuth as any, getEpisodeSubtitles);
router.get('/episodes/:id/audio-tracks', publicReadRateLimit as any, requireAuth as any, getEpisodeAudioTracks);
router.delete('/account', accountRateLimit as any, requireAuth as any, deleteMyAccount as any);

// ── Admin-only ───────────────────────────────────────────────────────────────
router.get('/admin/users', adminRateLimit as any, requireAuth as any, requireAdmin as any, listUsers);
router.patch('/admin/users/:id', adminRateLimit as any, requireAuth as any, requireAdmin as any, setAdminStatus);
router.delete('/admin/shows/:id', adminRateLimit as any, requireAuth as any, requireAdmin as any, deleteShow);
router.post('/admin/scan', adminRateLimit as any, requireAuth as any, requireAdmin as any, triggerAdminScan);

export default router;
