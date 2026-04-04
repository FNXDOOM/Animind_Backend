import http from 'http';
import cron from 'node-cron';
import app from './app.js';
import { env } from './config/env.js';
import { initSyncPlay } from './sockets/syncplay.handler.js';
import { runScan } from './services/scanner.service.js';
import { cleanupEndedWatchParties } from './services/syncplayCleanup.service.js';
import { destroyAllSessions } from './services/hlsSession.service.js';
import { cleanupLegacyAudioCache } from './services/audioCacheCleanup.service.js';

// ── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

// ── Socket.IO / SyncPlay ──────────────────────────────────────────────────────
const io = initSyncPlay(httpServer);
console.log('[Server] Socket.IO (SyncPlay) attached.');

// ── Cron Scanner ──────────────────────────────────────────────────────────────
if (cron.validate(env.SCANNER_CRON)) {
  cron.schedule(env.SCANNER_CRON, async () => {
    console.log('[Cron] Starting scheduled library scan...');
    try {
      await runScan();
    } catch (err: any) {
      console.error('[Cron] Scan failed:', err.message);
    }
  });
  console.log(`[Server] Scanner cron scheduled: "${env.SCANNER_CRON}"`);
} else {
  console.warn(`[Server] Invalid SCANNER_CRON expression: "${env.SCANNER_CRON}". Cron not scheduled.`);
}

// ── Cron SyncPlay Cleanup ───────────────────────────────────────────────────
if (env.SYNCPLAY_ENDED_CLEANUP_ENABLED) {
  const runSyncPlayCleanup = async () => {
    try {
      const cleanup = await cleanupEndedWatchParties(env.SYNCPLAY_ENDED_TTL_MINUTES);
      if (cleanup.deletedRooms > 0 || cleanup.deletedParticipantRows > 0) {
        console.log(
          `[SyncPlay Cleanup] Removed ${cleanup.deletedRooms}/${cleanup.expiredRooms} ended room(s) and ${cleanup.deletedParticipantRows} participant row(s).`
        );
      }
    } catch (err: any) {
      console.error('[SyncPlay Cleanup] Failed:', err.message);
    }
  };

  // One immediate pass on startup so already-expired rooms are cleaned quickly.
  void runSyncPlayCleanup();

  if (cron.validate(env.SYNCPLAY_CLEANUP_CRON)) {
    cron.schedule(env.SYNCPLAY_CLEANUP_CRON, runSyncPlayCleanup);
    console.log(
      `[Server] SyncPlay cleanup cron scheduled: "${env.SYNCPLAY_CLEANUP_CRON}" (TTL ${env.SYNCPLAY_ENDED_TTL_MINUTES}m)`
    );
  } else {
    console.warn(
      `[Server] Invalid SYNCPLAY_CLEANUP_CRON expression: "${env.SYNCPLAY_CLEANUP_CRON}". SyncPlay cleanup cron not scheduled.`
    );
  }
}

// ── Legacy Audio Cache Cleanup ────────────────────────────────────────────────
if (env.AUDIO_CACHE_CLEANUP_ON_STARTUP) {
  void cleanupLegacyAudioCache().then(result => {
    if (result.deleted) {
      console.log(`[Server] ${result.message}`);
    }
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(env.PORT, () => {
  console.log(`\n🚀 Animind Backend running on port ${env.PORT}`);
  console.log(`   Environment : ${env.NODE_ENV}`);
  console.log(`   CORS origin : ${env.FRONTEND_URL}`);
  console.log(`   Storage mode: ${env.STORAGE_MODE}`);
  console.log(`   Health check: http://localhost:${env.PORT}/health\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down...');
  await destroyAllSessions();
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down...');
  await destroyAllSessions();
  httpServer.close(() => process.exit(0));
});

export { io };
