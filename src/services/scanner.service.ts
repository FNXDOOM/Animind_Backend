/**
 * scanner.service.ts
 *
 * Scans S3/local storage for video files, parses anime metadata,
 * and upserts shows + episodes into Supabase.
 */

import { S3Client, ListObjectsV2Command, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';
import { parseFolderPath } from '../utils/titleParser.js';
import { fetchAniListMeta } from './anilist.service.js';

// ── S3 Client (lazy-initialized) ────────────────────────────────────────────
let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: !!env.S3_ENDPOINT, // required for non-AWS endpoints (R2, MinIO, etc.)
    });
  }
  return s3Client;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isVideoFile(key: string): boolean {
  const ext = path.extname(key).replace('.', '').toLowerCase();
  return env.VIDEO_EXTENSIONS.includes(ext);
}

/** List all video object keys from S3 bucket */
async function listS3Files(): Promise<string[]> {
  const client = getS3Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: env.S3_BUCKET_NAME,
      ContinuationToken: continuationToken,
    });
    const res: ListObjectsV2CommandOutput = await client.send(cmd);
    for (const obj of res.Contents ?? []) {
      if (obj.Key && isVideoFile(obj.Key)) keys.push(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

/** Recursively list all video files from local directory */
async function listLocalFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listLocalFiles(fullPath, base)));
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      // Store relative path from base dir
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}

// ── DB Operations ────────────────────────────────────────────────────────────

async function getOrCreateShow(title: string): Promise<string> {
  // 1. Check if show already exists
  const { data: existing } = await supabase
    .from('shows')
    .select('id')
    .ilike('title', title)
    .maybeSingle();

  if (existing?.id) return existing.id;

  // 2. Try to fetch AniList metadata
  const meta = await fetchAniListMeta(title);

  const showPayload = {
    title: meta?.title?.english ?? meta?.title?.romaji ?? title,
    synopsis: meta?.description?.replace(/<[^>]+>/g, '') ?? null,
    cover_image_url: meta?.coverImage?.large ?? null,
    anilist_id: meta?.id ?? null,
    genres: meta?.genres ?? [],
    rating: meta?.averageScore ? meta.averageScore / 10 : null,
    episode_count: meta?.episodes ?? null,
    studio: meta?.studios?.nodes?.[0]?.name ?? null,
    status: meta?.status ?? null,
    year: meta?.seasonYear?.toString() ?? null,
    trailer_id: meta?.trailer?.id ?? null,
    trailer_site: meta?.trailer?.site ?? null,
    trailer_thumbnail: meta?.trailer?.thumbnail ?? null,
  };

  const { data: inserted, error } = await supabase
    .from('shows')
    .insert(showPayload)
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert show "${title}": ${error.message}`);
  return inserted.id;
}

async function upsertEpisode(
  showId: string,
  episodeNumber: number,
  filePath: string,
  bucketName: string
) {
  const { error } = await supabase.from('episodes').upsert(
    {
      show_id: showId,
      episode_number: episodeNumber,
      file_path: filePath,
      bucket_name: bucketName,
    },
    { onConflict: 'show_id, episode_number' }
  );

  if (error) {
    console.error(`[Scanner] Failed to upsert episode ${episodeNumber} for show ${showId}:`, error.message);
  }
}

/** Remove DB episodes whose file paths no longer exist in the scanned set */
async function pruneDeletedFiles(foundPaths: Set<string>) {
  const { data: allEpisodes } = await supabase.from('episodes').select('id, file_path');
  if (!allEpisodes) return;

  const toDelete = allEpisodes
    .filter(ep => !foundPaths.has(ep.file_path))
    .map(ep => ep.id);

  if (toDelete.length > 0) {
    await supabase.from('episodes').delete().in('id', toDelete);
    console.log(`[Scanner] Pruned ${toDelete.length} missing episode(s) from DB.`);
  }
}

// ── Main Scanner ─────────────────────────────────────────────────────────────

export interface ScanResult {
  scanned: number;
  inserted: number;
  errors: string[];
  durationMs: number;
}

export async function runScan(): Promise<ScanResult> {
  const start = Date.now();
  const result: ScanResult = { scanned: 0, inserted: 0, errors: [], durationMs: 0 };
  const foundPaths = new Set<string>();

  console.log(`[Scanner] Starting scan (mode: ${env.STORAGE_MODE})...`);

  let filePaths: string[] = [];

  try {
    filePaths =
      env.STORAGE_MODE === 's3'
        ? await listS3Files()
        : await listLocalFiles(env.LOCAL_STORAGE_PATH);
  } catch (err: any) {
    result.errors.push(`Failed to list files: ${err.message}`);
    result.durationMs = Date.now() - start;
    return result;
  }

  console.log(`[Scanner] Found ${filePaths.length} video file(s).`);

  for (const filePath of filePaths) {
    result.scanned++;
    foundPaths.add(filePath);

    const parsed = parseFolderPath(filePath);
    if (!parsed) {
      console.warn(`[Scanner] Could not parse: ${filePath}`);
      result.errors.push(`Unparseable: ${filePath}`);
      continue;
    }

    try {
      const showId = await getOrCreateShow(parsed.title);
      await upsertEpisode(
        showId,
        parsed.episode,
        filePath,
        env.STORAGE_MODE === 's3' ? env.S3_BUCKET_NAME : 'local'
      );
      result.inserted++;
    } catch (err: any) {
      console.error(`[Scanner] Error processing ${filePath}:`, err.message);
      result.errors.push(`${filePath}: ${err.message}`);
    }
  }

  await pruneDeletedFiles(foundPaths);

  result.durationMs = Date.now() - start;
  console.log(`[Scanner] Done in ${result.durationMs}ms. Inserted/updated: ${result.inserted}, Errors: ${result.errors.length}`);
  return result;
}
