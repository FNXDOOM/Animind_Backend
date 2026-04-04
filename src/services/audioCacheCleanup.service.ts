/**
 * audioCacheCleanup.service.ts
 *
 * Handles cleanup of the legacy `.animind-audio-cache` directory.
 * After migrating to HLS segmented streaming, the full-file audio cache
 * is no longer needed. This service wipes it on startup.
 */

import { rm, stat } from 'fs/promises';
import path from 'path';
import { env } from '../config/env.js';

/**
 * Delete the entire `.animind-audio-cache` directory if it exists.
 * Called once on server startup when AUDIO_CACHE_CLEANUP_ON_STARTUP is true.
 */
export async function cleanupLegacyAudioCache(): Promise<{ deleted: boolean; message: string }> {
  if (env.STORAGE_MODE !== 'local') {
    return { deleted: false, message: 'Not in local storage mode, skipping.' };
  }

  const cacheDir = path.resolve(env.LOCAL_STORAGE_PATH, '.animind-audio-cache');

  try {
    const stats = await stat(cacheDir);
    if (!stats.isDirectory()) {
      return { deleted: false, message: 'Cache path is not a directory.' };
    }
  } catch {
    return { deleted: false, message: 'No legacy audio cache directory found.' };
  }

  try {
    await rm(cacheDir, { recursive: true, force: true });
    console.log(`[AudioCacheCleanup] Wiped legacy audio cache at ${cacheDir}`);
    return { deleted: true, message: `Legacy audio cache deleted: ${cacheDir}` };
  } catch (err: any) {
    console.warn(`[AudioCacheCleanup] Failed to delete legacy cache: ${err.message}`);
    return { deleted: false, message: `Failed to delete: ${err.message}` };
  }
}
