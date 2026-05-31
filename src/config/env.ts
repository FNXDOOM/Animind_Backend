import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

export const env = {
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:3000,http://localhost:5173',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? 'dev-secret',

  // Clerk secret key — used by auth middleware to verify JWTs
  CLERK_SECRET_KEY: requireEnv('CLERK_SECRET_KEY'),
  DESKTOP_TOKEN_SIGNING_KEY: requireEnv('DESKTOP_TOKEN_SIGNING_KEY'),

  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),

  STORAGE_MODE: (process.env.STORAGE_MODE ?? 's3') as 's3' | 'local',

  // S3
  S3_BUCKET_NAME: process.env.S3_BUCKET_NAME ?? '',
  S3_REGION: process.env.S3_REGION ?? 'auto',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? '',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? '',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? '',
  S3_PRESIGN_EXPIRES: parseInt(process.env.S3_PRESIGN_EXPIRES ?? '14400', 10),
  STREAM_TICKET_TTL_SECONDS: parseInt(process.env.STREAM_TICKET_TTL_SECONDS ?? '14400', 10),
  STREAM_RANGE_CHUNK_MB: parseInt(process.env.STREAM_RANGE_CHUNK_MB ?? '8', 10),

  // Local
  LOCAL_STORAGE_PATH: process.env.LOCAL_STORAGE_PATH ?? '/mnt/anime',

  // Scanner
  SCANNER_CRON: process.env.SCANNER_CRON ?? '0 */6 * * *',
  VIDEO_EXTENSIONS: (process.env.VIDEO_EXTENSIONS ?? 'mkv,mp4,avi,webm,m4v')
    .split(',')
    .map(e => e.trim().toLowerCase()),
  POST_SCAN_AUDIO_PREWARM_ENABLED: process.env.POST_SCAN_AUDIO_PREWARM_ENABLED !== 'false',
  POST_SCAN_AUDIO_PREWARM_EPISODE_LIMIT: parseInt(process.env.POST_SCAN_AUDIO_PREWARM_EPISODE_LIMIT ?? '12', 10),
  POST_SCAN_AUDIO_PREWARM_MAX_TRACKS_PER_EPISODE: parseInt(process.env.POST_SCAN_AUDIO_PREWARM_MAX_TRACKS_PER_EPISODE ?? '1', 10),

  // SyncPlay cleanup
  SYNCPLAY_CLEANUP_CRON: process.env.SYNCPLAY_CLEANUP_CRON ?? '*/10 * * * *',
  SYNCPLAY_ENDED_TTL_MINUTES: parseInt(process.env.SYNCPLAY_ENDED_TTL_MINUTES ?? '60', 10),
  SYNCPLAY_ENDED_CLEANUP_ENABLED: process.env.SYNCPLAY_ENDED_CLEANUP_ENABLED !== 'false',
  SYNCPLAY_READY_TIMEOUT_MS: parseInt(process.env.SYNCPLAY_READY_TIMEOUT_MS ?? '12000', 10),

  // SyncPlay buffer & sync tuning
  SYNCPLAY_BUFFER_GOAL_SECONDS: parseInt(process.env.SYNCPLAY_BUFFER_GOAL_SECONDS ?? '120', 10),
  SYNCPLAY_SOFT_SEEK_THRESHOLD_MS: parseInt(process.env.SYNCPLAY_SOFT_SEEK_THRESHOLD_MS ?? '200', 10),
  SYNCPLAY_SPEED_SYNC_MAX_MS: parseInt(process.env.SYNCPLAY_SPEED_SYNC_MAX_MS ?? '10000', 10),
  SYNCPLAY_ESCAPE_BUFFER_SECONDS: parseInt(process.env.SYNCPLAY_ESCAPE_BUFFER_SECONDS ?? '30', 10),
  SYNCPLAY_ESCAPE_WAIT_MS: parseInt(process.env.SYNCPLAY_ESCAPE_WAIT_MS ?? '10000', 10),

  // AniList
  ANILIST_ENABLED: process.env.ANILIST_ENABLED !== 'false',

  // MyAnimeList fallback metadata enrichment
  MYANIMELIST_ENABLED: process.env.MYANIMELIST_ENABLED !== 'false',
  MYANIMELIST_CLIENT_ID: process.env.MYANIMELIST_CLIENT_ID ?? process.env.MAL_CLIENT_ID ?? '',

  // OpenRouter scanner fallback
  OPENROUTER_ENABLED: process.env.OPENROUTER_ENABLED === 'true',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
  OPENROUTER_SITE_URL: process.env.OPENROUTER_SITE_URL ?? process.env.FRONTEND_URL?.split(',')?.[0] ?? '',
  OPENROUTER_APP_NAME: process.env.OPENROUTER_APP_NAME ?? 'Animind',
  OPENROUTER_TIMEOUT_MS: parseInt(process.env.OPENROUTER_TIMEOUT_MS ?? '12000', 10),
  OPENROUTER_MIN_CONFIDENCE: parseFloat(process.env.OPENROUTER_MIN_CONFIDENCE ?? '0.72'),

  // Audio variant cache cleanup
  AUDIO_CACHE_VARIANT_CLEANUP_ENABLED: process.env.AUDIO_CACHE_VARIANT_CLEANUP_ENABLED !== 'false',
  AUDIO_CACHE_VARIANT_CLEANUP_CRON: process.env.AUDIO_CACHE_VARIANT_CLEANUP_CRON ?? '15 */6 * * *',
  AUDIO_CACHE_VARIANT_TTL_DAYS: parseInt(process.env.AUDIO_CACHE_VARIANT_TTL_DAYS ?? '14', 10),

  // HLS session management
  HLS_SEGMENT_DURATION: parseInt(process.env.HLS_SEGMENT_DURATION ?? '10', 10),
  HLS_MAX_CONCURRENT_SESSIONS: parseInt(process.env.HLS_MAX_CONCURRENT_SESSIONS ?? '2', 10),
  HLS_SESSION_TIMEOUT_MINUTES: parseInt(process.env.HLS_SESSION_TIMEOUT_MINUTES ?? '120', 10),

  // Desktop durable auth
  DESKTOP_ACCESS_TOKEN_TTL_SECONDS: parseInt(process.env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS ?? '900', 10),
  DESKTOP_REFRESH_TOKEN_TTL_DAYS: parseInt(process.env.DESKTOP_REFRESH_TOKEN_TTL_DAYS ?? '30', 10),
  DESKTOP_AUTH_CLEANUP_ENABLED: process.env.DESKTOP_AUTH_CLEANUP_ENABLED !== 'false',
  DESKTOP_AUTH_CLEANUP_CRON: process.env.DESKTOP_AUTH_CLEANUP_CRON ?? '30 2 * * *',
  DESKTOP_AUTH_EXPIRED_RETENTION_DAYS: parseInt(process.env.DESKTOP_AUTH_EXPIRED_RETENTION_DAYS ?? '7', 10),
};
