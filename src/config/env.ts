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

  // Local
  LOCAL_STORAGE_PATH: process.env.LOCAL_STORAGE_PATH ?? '/mnt/anime',

  // Scanner
  SCANNER_CRON: process.env.SCANNER_CRON ?? '0 */6 * * *',
  VIDEO_EXTENSIONS: (process.env.VIDEO_EXTENSIONS ?? 'mkv,mp4,avi,webm,m4v')
    .split(',')
    .map(e => e.trim().toLowerCase()),

  // AniList
  ANILIST_ENABLED: process.env.ANILIST_ENABLED !== 'false',
};
