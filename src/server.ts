import http from 'http';
import cron from 'node-cron';
import app from './app.js';
import { env } from './config/env.js';
import { initSyncPlay } from './sockets/syncplay.handler.js';
import { runScan } from './services/scanner.service.js';

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

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(env.PORT, () => {
  console.log(`\n🚀 Animind Backend running on port ${env.PORT}`);
  console.log(`   Environment : ${env.NODE_ENV}`);
  console.log(`   CORS origin : ${env.FRONTEND_URL}`);
  console.log(`   Storage mode: ${env.STORAGE_MODE}`);
  console.log(`   Health check: http://localhost:${env.PORT}/health\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  httpServer.close(() => process.exit(0));
});

export { io };
