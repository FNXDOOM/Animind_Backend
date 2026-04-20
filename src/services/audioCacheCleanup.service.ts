import { readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { env } from '../config/env.js';

interface AudioCacheTrackEntry {
  streamIndex: number;
  variantPath: string;
}

interface AudioCacheMetadata {
  episodeId: string;
  tracks: AudioCacheTrackEntry[];
}

interface AudioCacheCleanupResult {
  deletedFiles: number;
  deletedDirs: number;
  prunedMetadataEntries: number;
  updatedMetadataFiles: number;
}

export async function cleanupAudioVariantCacheByTtl(
  ttlDays = env.AUDIO_CACHE_VARIANT_TTL_DAYS
): Promise<AudioCacheCleanupResult> {
  if (env.STORAGE_MODE !== 'local') {
    return { deletedFiles: 0, deletedDirs: 0, prunedMetadataEntries: 0, updatedMetadataFiles: 0 };
  }

  const cacheDir = path.resolve(env.LOCAL_STORAGE_PATH, '.animind-audio-cache');
  const now = Date.now();
  const ttlMs = Math.max(1, ttlDays) * 24 * 60 * 60 * 1000;
  let deletedFiles = 0;
  let deletedDirs = 0;
  let prunedMetadataEntries = 0;
  let updatedMetadataFiles = 0;

  try {
    const stats = await stat(cacheDir);
    if (!stats.isDirectory()) {
      return { deletedFiles: 0, deletedDirs: 0, prunedMetadataEntries: 0, updatedMetadataFiles: 0 };
    }
  } catch {
    return { deletedFiles: 0, deletedDirs: 0, prunedMetadataEntries: 0, updatedMetadataFiles: 0 };
  }

  const episodeDirs = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);

  for (const dirent of episodeDirs) {
    if (!dirent.isDirectory()) continue;

    const episodeDir = path.join(cacheDir, dirent.name);
    const metadataPath = path.join(episodeDir, 'metadata.json');
    const fileEntries = await readdir(episodeDir, { withFileTypes: true }).catch(() => []);

    for (const entry of fileEntries) {
      if (!entry.isFile()) continue;
      if (entry.name === 'metadata.json') continue;

      const fullPath = path.join(episodeDir, entry.name);
      try {
        const stats = await stat(fullPath);
        if (now - stats.mtimeMs > ttlMs) {
          await rm(fullPath, { force: true });
          deletedFiles += 1;
        }
      } catch {
        // Ignore unreadable/deleted files.
      }
    }

    try {
      const raw = await readFile(metadataPath, 'utf-8');
      const parsed = JSON.parse(raw) as AudioCacheMetadata;
      if (parsed && Array.isArray(parsed.tracks)) {
        const before = parsed.tracks.length;
        const nextTracks: AudioCacheTrackEntry[] = [];

        for (const track of parsed.tracks) {
          const variantPath = path.join(episodeDir, track.variantPath ?? '');
          try {
            const stats = await stat(variantPath);
            if (now - stats.mtimeMs <= ttlMs) {
              nextTracks.push(track);
            }
          } catch {
            // Variant missing/expired -> prune metadata entry.
          }
        }

        const pruned = before - nextTracks.length;
        if (pruned > 0) {
          prunedMetadataEntries += pruned;
          parsed.tracks = nextTracks;
          await writeFile(metadataPath, JSON.stringify(parsed, null, 2), 'utf-8');
          updatedMetadataFiles += 1;
        }
      }
    } catch {
      // Ignore invalid/missing metadata.
    }

    const remaining = await readdir(episodeDir, { withFileTypes: true }).catch(() => []);
    const hasVariant = remaining.some(item => item.isFile() && item.name !== 'metadata.json');
    if (!hasVariant) {
      await rm(episodeDir, { recursive: true, force: true }).catch(() => {});
      deletedDirs += 1;
    }
  }

  return { deletedFiles, deletedDirs, prunedMetadataEntries, updatedMetadataFiles };
}
