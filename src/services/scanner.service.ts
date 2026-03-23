/**
 * scanner.service.ts
 *
 * Scans S3/local storage for video files, parses anime metadata,
 * and upserts shows + episodes into Supabase.
 */

import { S3Client, ListObjectsV2Command, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { readdir, stat } from 'fs/promises';
import { spawn } from 'child_process';
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
      // Skip the audio variant cache folder — those are not real episodes
      if (entry.name === '.animind-audio-cache') continue;
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
  const trimmed = title.trim();

  // 1. Quick lookup by the raw parsed title (covers most cases)
  const { data: existing } = await supabase
    .from('shows')
    .select('id')
    .ilike('title', trimmed)
    .maybeSingle();

  if (existing?.id) return existing.id;

  // 2. Fetch AniList metadata — this gives us the canonical title
  const meta = await fetchAniListMeta(trimmed);
  const canonicalTitle = meta?.title?.english ?? meta?.title?.romaji ?? trimmed;

  // 3. If the canonical title differs from the parsed title, check again.
  //    e.g. file "Frieren Beyond Journey's End" → AniList → "Frieren: Beyond Journey's End"
  //    The second show row already exists under the canonical title, so we find it here
  //    instead of inserting a duplicate.
  if (canonicalTitle.toLowerCase() !== trimmed.toLowerCase()) {
    const { data: byCanonical } = await supabase
      .from('shows')
      .select('id')
      .ilike('title', canonicalTitle)
      .maybeSingle();

    if (byCanonical?.id) return byCanonical.id;
  }

  const showPayload = {
    title: canonicalTitle,
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

  // Try a plain INSERT first. If it fails due to a unique violation (race condition
  // where another scan inserted the same show between our lookup and now), we fall
  // back to fetching the existing row. This avoids relying on onConflict targeting
  // an expression index (lower(trim(title))) which PostgREST cannot resolve.
  const { data: inserted, error } = await supabase
    .from('shows')
    .insert(showPayload)
    .select('id')
    .single();

  if (error) {
    // Likely a unique constraint violation — fetch the row that won the race
    const { data: raceWinner } = await supabase
      .from('shows')
      .select('id')
      .ilike('title', canonicalTitle)
      .maybeSingle();
    if (raceWinner?.id) return raceWinner.id;
    throw new Error(`Failed to insert show "${title}": ${error.message}`);
  }

  return inserted.id;
}

/**
 * Upsert an episode row using the UNIQUE(show_id, episode_number) DB constraint.
 * Now that the constraint exists in Postgres, PostgREST's onConflict works
 * correctly — no space in the key name, no manual check-then-insert needed.
 */
async function upsertEpisode(
  showId: string,
  episodeNumber: number,
  filePath: string,
  bucketName: string
): Promise<void> {
  const { error } = await supabase
    .from('episodes')
    .upsert(
      {
        show_id: showId,
        episode_number: episodeNumber,
        file_path: filePath,
        bucket_name: bucketName,
      },
      { onConflict: 'show_id,episode_number' } // comma-separated column list matching UNIQUE(show_id, episode_number)
    );

  if (error) {
    console.error(
      `[Scanner] Failed to upsert episode ${episodeNumber} for show ${showId}:`,
      error.message
    );
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

// ── Subtitle extraction → .vtt files on disk ────────────────────────────────────
// During scan, embedded subtitle streams are extracted from each .mkv and
// saved as .vtt files next to the video file:
//   /mnt/anime/Show/Episode 01.mkv
//   /mnt/anime/Show/Episode 01.English.vtt   ← created here
//   /mnt/anime/Show/Episode 01.Japanese.vtt  ← created here
// The existing getLocalSubtitleTracks() in episode.controller.ts already
// scans for .vtt sidecar files, so subtitles load instantly after the first scan.

function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function normalizeLanguage(raw?: string): string {
  if (!raw) return 'Unknown';
  const val = raw.toLowerCase();
  if (val === 'eng' || val === 'en' || val.includes('english')) return 'English';
  if (val === 'jpn' || val === 'jp' || val.includes('japanese')) return 'Japanese';
  if (val === 'spa' || val === 'es' || val.includes('spanish')) return 'Spanish';
  return raw;
}

async function extractSubtitlesToDisk(filePath: string): Promise<void> {
  // Only for local mode — S3 files can't be piped through ffmpeg this way
  if (env.STORAGE_MODE !== 'local') return;

  const fullVideoPath = path.resolve(env.LOCAL_STORAGE_PATH, filePath);
  const videoDir      = path.dirname(fullVideoPath);
  const videoBaseName = path.parse(fullVideoPath).name;
  const ffprobeBin    = process.env.FFPROBE_PATH || 'ffprobe';
  const ffmpegBin     = process.env.FFMPEG_PATH  || 'ffmpeg';

  // 1. Probe for subtitle streams
  let probeResult: { code: number; stdout: string; stderr: string };
  try {
    probeResult = await runProcess(ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 's',
      fullVideoPath,
    ]);
  } catch {
    console.warn(`[Scanner] ffprobe unavailable for ${filePath}, skipping subtitle extraction.`);
    return;
  }

  if (probeResult.code !== 0 || !probeResult.stdout.trim()) return;

  let streams: any[] = [];
  try {
    const parsed = JSON.parse(probeResult.stdout) as { streams?: any[] };
    streams = parsed.streams ?? [];
  } catch { return; }

  if (!streams.length) return;

  // Image-based subtitle formats that cannot be converted to VTT by ffmpeg
  const unsupportedCodecs = new Set([
    'hdmv_pgs_subtitle',  // Blu-ray PGS
    'dvd_subtitle',       // DVD bitmap subs
    'xsub',              // DivX bitmap subs
    'dvb_subtitle',       // DVB bitmap subs
    'dvb_teletext',       // Teletext
  ]);

  let extracted = 0;

  // Track language counts to handle duplicates (e.g. two English tracks)
  const langCount: Record<string, number> = {};

  for (const stream of streams) {
    if (typeof stream?.index !== 'number') continue;
    const codec = String(stream?.codec_name ?? '').toLowerCase();

    // Silently skip image-based codecs — no warning needed, they're expected
    if (unsupportedCodecs.has(codec)) continue;

    const language = normalizeLanguage(stream?.tags?.language);
    langCount[language] = (langCount[language] ?? 0) + 1;
    const suffix      = langCount[language] > 1 ? `${language}.${langCount[language]}` : language;
    const vttFileName = `${videoBaseName}.${suffix}.vtt`;
    const vttFilePath = path.join(videoDir, vttFileName);

    // Skip if the .vtt file already exists — no need to re-extract on every scan
    try {
      await stat(vttFilePath);
      console.log(`[Scanner] Subtitle already exists: ${vttFileName}`);
      continue;
    } catch { /* doesn't exist yet, extract it */ }

    // Extract subtitle stream directly to .vtt file on disk
    const result = await runProcess(ffmpegBin, [
      '-v', 'error',
      '-i', fullVideoPath,
      '-map', `0:${stream.index}`,
      '-f', 'webvtt',
      vttFilePath,
    ]).catch(() => null);

    if (result && result.code === 0) {
      console.log(`[Scanner] Extracted subtitle: ${vttFileName}`);
      extracted++;
    } else {
      // Log codec name so we can add it to unsupportedCodecs if needed
      console.warn(`[Scanner] Could not convert stream ${stream.index} (codec: ${codec}) from ${path.basename(filePath)} to VTT — skipping.`);
      // Clean up empty/partial file if ffmpeg wrote one
      import('fs').then(fs => fs.promises.unlink(vttFilePath).catch(() => undefined));
    }
  }

  if (extracted > 0) {
    console.log(`[Scanner] Saved ${extracted} subtitle file(s) for ${path.basename(filePath)}.`);
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

      // Extract embedded subtitles to .vtt files next to the video.
      // Runs in the background so it doesn't block the scan loop.
      // On the next scan, already-extracted .vtt files are skipped.
      extractSubtitlesToDisk(filePath).catch((err: any) =>
        console.error(`[Scanner] Subtitle extraction error for ${filePath}:`, err.message)
      );
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
