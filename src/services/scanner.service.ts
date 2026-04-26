/**
 * scanner.service.ts
 *
 * Scans S3/local storage for video files, parses anime metadata,
 * and upserts shows + episodes into Supabase.
 */

import { S3Client, ListObjectsV2Command, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { readdir, mkdir } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';
import { parseFolderPath } from '../utils/titleParser.js';
import { fetchAniListMeta } from './anilist.service.js';

// ── S3 Client (lazy-initialized) ────────────────────────────────────────────
let s3Client: S3Client | null = null;
let hasWarnedMissingEpisodeSeasonSchema = false;

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

function normalizeTitleForLookup(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreShowCandidate(row: {
  anilist_id?: number | null;
  cover_image_url?: string | null;
  synopsis?: string | null;
  title?: string | null;
}, parsedTitle: string): number {
  let score = 0;
  if (row.anilist_id !== null && row.anilist_id !== undefined) score += 8;
  if (row.cover_image_url) score += 3;
  if (row.synopsis) score += 2;

  const rowTitle = normalizeTitleForLookup(row.title ?? '');
  const target = normalizeTitleForLookup(parsedTitle);
  if (rowTitle === target) score += 6;
  else if (rowTitle.includes(target) || target.includes(rowTitle)) score += 3;

  return score;
}

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

  // 2a. Strong identity match by AniList id when available.
  if (meta?.id) {
    const { data: byAniList } = await supabase
      .from('shows')
      .select('id')
      .eq('anilist_id', meta.id)
      .limit(1)
      .maybeSingle();

    if (byAniList?.id) return byAniList.id;
  }

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

  // 3b. If AniList is unavailable or title mismatch remains, use a conservative
  // fuzzy fallback to avoid creating plain-title duplicates for canonical rows.
  if (!meta) {
    const fuzzySearch = `%${trimmed.replace(/\s+/g, '%')}%`;
    const { data: fuzzyMatches } = await supabase
      .from('shows')
      .select('id, title, anilist_id, cover_image_url, synopsis')
      .ilike('title', fuzzySearch)
      .limit(8);

    if (fuzzyMatches?.length) {
      const best = [...fuzzyMatches]
        .sort((a, b) => scoreShowCandidate(b, trimmed) - scoreShowCandidate(a, trimmed))[0];
      if (best?.id) return best.id;
    }
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
  seasonNumber: number,
  episodeNumber: number,
  filePath: string,
  bucketName: string
): Promise<{ id: string; file_path: string } | null> {
  const normalizedSeasonNumber = Number.isFinite(seasonNumber) && seasonNumber > 0
    ? Math.floor(seasonNumber)
    : 1;

  let { data, error } = await supabase
    .from('episodes')
    .upsert(
      {
        show_id: showId,
        season_number: normalizedSeasonNumber,
        episode_number: episodeNumber,
        file_path: filePath,
        bucket_name: bucketName,
      },
      { onConflict: 'show_id,season_number,episode_number' }
    )
    .select('id, file_path')
    .single();

  if (error) {
    const isSeasonSchemaIssue =
      /season_number/i.test(error.message) ||
      /no unique|on conflict/i.test(error.message);

    if (isSeasonSchemaIssue) {
      if (!hasWarnedMissingEpisodeSeasonSchema) {
        hasWarnedMissingEpisodeSeasonSchema = true;
        console.warn(
          '[Scanner] episodes season-aware schema is missing. Run migration supabase-episodes-season-migration.sql to avoid cross-season episode collisions.'
        );
      }

      const fallback = await supabase
        .from('episodes')
        .upsert(
          {
            show_id: showId,
            episode_number: episodeNumber,
            file_path: filePath,
            bucket_name: bucketName,
          },
          { onConflict: 'show_id,episode_number' }
        )
        .select('id, file_path')
        .single();

      data = fallback.data;
      error = fallback.error;
    }
  }

  if (error) {
    console.error(
      `[Scanner] Failed to upsert episode ${episodeNumber} for show ${showId}:`,
      error.message
    );
    return null;
  }

  return data ?? null;
}

/** Remove DB episodes whose file paths no longer exist in the scanned set */
async function pruneDeletedFiles(foundPaths: Set<string>) {
  const { data: allEpisodes } = await supabase.from('episodes').select('id, file_path, show_id');
  if (!allEpisodes) return;

  const toDelete = allEpisodes
    .filter(ep => !foundPaths.has(ep.file_path))
    .map(ep => ep.id);

  if (toDelete.length > 0) {
    await supabase.from('episodes').delete().in('id', toDelete);
    console.log(`[Scanner] Pruned ${toDelete.length} missing episode(s) from DB.`);
  }

  // Remove stale shows that no longer have any episodes after pruning.
  const { data: remainingEpisodes } = await supabase.from('episodes').select('show_id');
  const activeShowIds = new Set((remainingEpisodes ?? []).map(ep => ep.show_id).filter(Boolean));

  const { data: allShows } = await supabase.from('shows').select('id');
  if (!allShows?.length) return;

  const orphanShowIds = allShows
    .map(show => show.id)
    .filter(showId => !activeShowIds.has(showId));

  if (orphanShowIds.length > 0) {
    const { error: deleteShowError } = await supabase
      .from('shows')
      .delete()
      .in('id', orphanShowIds);

    if (deleteShowError) {
      console.warn(
        `[Scanner] Could not prune ${orphanShowIds.length} orphan show(s): ${deleteShowError.message}`
      );
    } else {
      console.log(`[Scanner] Pruned ${orphanShowIds.length} orphan show(s) with no episodes.`);
    }
  }
}

// ── Subtitle extraction → organized .vtt files on disk ──────────────────────────
// During scan, embedded subtitle streams are extracted from each video and saved
// under a per-show, per-episode structure:
//   /mnt/anime/Show/Subtitles/Episode 01/English.vtt
//   /mnt/anime/Show/Subtitles/Episode 01/Japanese.vtt
// This keeps show roots clean while still allowing legacy sidecar fallback reads.

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

/**
 * Convert a raw ASS/SSA string to a clean WebVTT string.
 *
 * Problems with ffmpeg's built-in ASS→VTT:
 *  - Karaoke vector drawing commands ("m 17.48 19.22 l ...") leak as visible text
 *  - Typeset signs, OP/ED romaji tracks, and \k karaoke syllables all render as junk
 *
 * This function:
 *  1. Parses only [Events] Dialogue lines (ignores Comments)
 *  2. Drops lines where the Style name signals non-dialogue (Signs, Karaoke, OP, ED, Title …)
 *  3. Drops lines that are pure drawing commands (\p1 … \p0 or \p1 in override tags)
 *  4. Strips ALL ASS override tags ({\…}) from the remaining text
 *  5. Drops lines whose cleaned text is empty or looks like raw coords / numbers only
 *  6. Deduplicates consecutive identical cues (common with multi-track karaoke)
 *  7. Emits a valid WEBVTT file
 */
function convertAssToVtt(assContent: string): string {
  const lines = assContent.split(/\r?\n/);

  // ── 1. Parse Format line to get column indices ───────────────────────────
  let formatCols: string[] = [];
  let inEvents = false;
  const dialogueLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[Events]') { inEvents = true; continue; }
    if (trimmed.startsWith('[') && trimmed !== '[Events]') { inEvents = false; continue; }
    if (!inEvents) continue;

    if (trimmed.startsWith('Format:')) {
      formatCols = trimmed.slice(7).split(',').map(c => c.trim().toLowerCase());
      continue;
    }
    if (trimmed.startsWith('Dialogue:')) {
      dialogueLines.push(trimmed);
    }
    // Skip Comment: lines entirely
  }

  if (!formatCols.length || !dialogueLines.length) return '';

  const iCol = (name: string) => formatCols.indexOf(name);
  const startIdx  = iCol('start');
  const endIdx    = iCol('end');
  const styleIdx  = iCol('style');
  const textIdx   = iCol('text');

  if (startIdx < 0 || endIdx < 0 || textIdx < 0) return '';

  // ── 2. Style name blocklist — these are never real dialogue ─────────────
  const nonDialogueStylePattern = /sign|caption|title|song|op|ed|opening|ending|karaoke|kara|romaji|credit|note|info|typeset|on\s?screen|screen/i;

  // ── 3. Helpers ────────────────────────────────────────────────────────────
  function assTimeToVtt(t: string): string {
    // ASS: H:MM:SS.cc  →  VTT: HH:MM:SS.mmm
    const m = t.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (!m) return '00:00:00.000';
    const [, h, min, sec, cs] = m;
    return `${h.padStart(2,'0')}:${min}:${sec}.${cs}0`;
  }

  function stripTags(text: string): string {
    return text
      .replace(/\{[^}]*\}/g, '')   // remove all {\tag} override blocks
      .replace(/\\N/g, '\n')       // \N = hard line break
      .replace(/\\n/g, '\n')       // \n = soft line break
      .replace(/\\h/g, '\u00A0')  // \h = hard space
      .trim();
  }

  function hasDrawingCommand(rawText: string): boolean {
    // \p1 (or \p2, \p3…) inside override tags = vector drawing mode
    return /\{[^}]*\\p[1-9][^}]*\}/.test(rawText);
  }

  function looksLikeJunk(text: string): boolean {
    if (!text) return true;
    // Pure numbers / coordinate strings leftover from drawing commands
    if (/^[\d\s.\-mlbsqnp]+$/i.test(text)) return true;
    // Only whitespace / punctuation
    if (/^[\s\W]+$/.test(text)) return true;
    return false;
  }

  // ── 4. Parse each Dialogue line ───────────────────────────────────────────
  interface Cue { start: string; end: string; text: string; }
  const cues: Cue[] = [];

  for (const dl of dialogueLines) {
    // Dialogue: <value>,<value>,…,<text with possible commas>
    const raw = dl.slice('Dialogue:'.length).trim();
    // Split only up to (textIdx) commas so the text field is kept whole
    const parts = raw.split(',');
    if (parts.length <= textIdx) continue;

    const start = parts[startIdx]?.trim();
    const end   = parts[endIdx]?.trim();
    const style = styleIdx >= 0 ? (parts[styleIdx]?.trim() ?? '') : '';
    // Text is everything from textIdx onward (may contain commas)
    const rawText = parts.slice(textIdx).join(',');

    if (!start || !end) continue;

    // Drop non-dialogue styles
    if (style && nonDialogueStylePattern.test(style)) continue;

    // Drop drawing-command lines
    if (hasDrawingCommand(rawText)) continue;

    const cleanText = stripTags(rawText);

    // Drop empty or junk-only lines
    if (looksLikeJunk(cleanText)) continue;

    cues.push({ start: assTimeToVtt(start), end: assTimeToVtt(end), text: cleanText });
  }

  if (!cues.length) return '';

  // ── 5. Deduplicate consecutive identical cues ─────────────────────────────
  const deduped: Cue[] = [cues[0]];
  for (let i = 1; i < cues.length; i++) {
    const prev = deduped[deduped.length - 1];
    const cur  = cues[i];
    if (cur.text === prev.text && cur.start === prev.start && cur.end === prev.end) continue;
    deduped.push(cur);
  }

  // ── 6. Build VTT output ───────────────────────────────────────────────────
  const vttLines = ['WEBVTT', ''];
  for (let i = 0; i < deduped.length; i++) {
    const { start, end, text } = deduped[i];
    vttLines.push(`${i + 1}`);
    vttLines.push(`${start} --> ${end}`);
    vttLines.push(text);
    vttLines.push('');
  }

  return vttLines.join('\n');
}

function normalizeLanguage(raw?: string): string {
  if (!raw) return 'Unknown';
  const val = raw.toLowerCase();
  if (val === 'eng' || val === 'en' || val.includes('english')) return 'English';
  if (val === 'jpn' || val === 'jp' || val.includes('japanese')) return 'Japanese';
  if (val === 'spa' || val === 'es' || val.includes('spanish')) return 'Spanish';
  return raw;
}

function getShowRootDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const [showFolder] = normalized.split('/');
  return path.resolve(env.LOCAL_STORAGE_PATH, showFolder || '');
}

function formatEpisodeFolder(episodeNumber: number): string {
  const width = episodeNumber >= 100 ? 3 : 2;
  return `Episode ${String(episodeNumber).padStart(width, '0')}`;
}

function formatSeasonFolder(seasonNumber: number): string {
  const width = seasonNumber >= 100 ? 3 : 2;
  return `Season ${String(seasonNumber).padStart(width, '0')}`;
}

function buildSubtitleEpisodeRelativePath(episodeNumber: number, seasonNumber?: number): string {
  const normalizedSeason = Number.isFinite(seasonNumber as number) && (seasonNumber as number) > 1
    ? Math.floor(seasonNumber as number)
    : 1;
  const episodeFolder = formatEpisodeFolder(episodeNumber);

  if (normalizedSeason > 1) {
    return path.join('Subtitles', formatSeasonFolder(normalizedSeason), episodeFolder);
  }

  return path.join('Subtitles', episodeFolder);
}

async function extractSubtitlesToDisk(filePath: string, episodeNumber: number, seasonNumber?: number): Promise<void> {
  // Only for local mode — S3 files can't be piped through ffmpeg this way
  if (env.STORAGE_MODE !== 'local') return;

  const fullVideoPath = path.resolve(env.LOCAL_STORAGE_PATH, filePath);
  const showRootDir = getShowRootDirectory(filePath);
  const subtitleRelativePath = buildSubtitleEpisodeRelativePath(episodeNumber, seasonNumber);
  const subtitlesDir = path.join(showRootDir, subtitleRelativePath);
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';

  await mkdir(subtitlesDir, { recursive: true });

  // If subtitle files already exist for this episode, don't try to regenerate.
  // This prevents repeated ffmpeg writes on read-only subtitle directories.
  // IMPORTANT: only skip if there are actual .vtt/.srt files — empty dirs are NOT skipped.
  try {
    const existingSubtitleEntries = await readdir(subtitlesDir);
    const hasExistingSubtitles = existingSubtitleEntries.some(entry =>
      ['.vtt', '.srt'].includes(path.extname(entry).toLowerCase())
    );
    if (hasExistingSubtitles) {
      return;
    }
    // Directory exists but is empty — fall through to extract subtitles.
    // This handles the case where a previous scan created the folder but
    // failed to populate it (e.g. due to a metadata/AniList error).
    console.log(`[Scanner] Empty subtitle dir found for ${path.basename(filePath)}, will re-attempt extraction.`);
  } catch {
    // Dir doesn't exist yet — mkdir above created it, continue normally.
  }

  // Skip extraction when directory isn't writable (common with bind mounts).
  // We attempt a probe write rather than relying solely on fs.access(), because
  // access() can return false negatives on some Linux mount configurations.
  try {
    const probeFile = path.join(subtitlesDir, '.write-probe');
    const { writeFile, unlink } = await import('fs/promises');
    await writeFile(probeFile, '');
    await unlink(probeFile);
  } catch {
    console.warn(
      `[Scanner] Subtitle directory not writable for ${path.basename(filePath)} (${subtitleRelativePath}). Skipping extraction.`
    );
    return;
  }

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

  // Codecs that truly cannot be converted to VTT by ffmpeg:
  // - Bitmap/image-based formats (PGS, DVD, XSUB, DVB) have no text to extract
  // - DVB teletext is broadcast-only
  // ASS/SSA are text-based and CAN be converted to VTT — ffmpeg handles this fine.
  const trulyUnsupportedCodecs = new Set([
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
    'xsub',
    'dvb_subtitle',
    'dvb_teletext',
  ]);

  console.log(`[Scanner] Found ${streams.length} subtitle stream(s) in ${path.basename(filePath)}:`, streams.map(s => `${s.codec_name}(${s.tags?.language ?? 'und'})`).join(', '));

  let extracted = 0;
  const langCount: Record<string, number> = {};

  for (const stream of streams) {
    if (typeof stream?.index !== 'number') continue;
    const codec = String(stream?.codec_name ?? '').toLowerCase();

    if (trulyUnsupportedCodecs.has(codec)) {
      console.log(`[Scanner] Skipping stream ${stream.index} (${codec}) — bitmap/image-based subtitle, cannot convert to VTT.`);
      continue;
    }

    const language = normalizeLanguage(stream?.tags?.language);
    langCount[language] = (langCount[language] ?? 0) + 1;
    const suffix = langCount[language] > 1 ? `${language}.${langCount[language]}` : language;
    const vttFileName = `${suffix}.vtt`;
    const vttFilePath = path.join(subtitlesDir, vttFileName);

    try {
      const { stat } = await import('fs/promises');
      await stat(vttFilePath);
      console.log(`[Scanner] Subtitle already exists: ${path.join('Subtitles', formatEpisodeFolder(episodeNumber), vttFileName)}`);
      continue;
    } catch {
      // Doesn't exist yet, extract it.
    }

    // ASS/SSA: use our own clean converter instead of ffmpeg's broken ASS→VTT
    // which leaks drawing commands and karaoke vector paths as visible text.
    if (codec === 'ass' || codec === 'ssa') {
      const assResult = await runProcess(ffmpegBin, [
        '-v', 'error',
        '-i', fullVideoPath,
        '-map', `0:${stream.index}`,
        '-f', 'ass',
        'pipe:1',
      ]).catch(() => null);

      if (!assResult || assResult.code !== 0 || !assResult.stdout.trim()) {
        const reason = assResult?.stderr?.trim().split('\n').pop() ?? 'unknown error';
        console.warn(`[Scanner] Could not extract ASS stream ${stream.index} from ${path.basename(filePath)} — ${reason}`);
        continue;
      }

      const vttContent = convertAssToVtt(assResult.stdout);
      if (!vttContent) {
        console.warn(`[Scanner] ASS stream ${stream.index} from ${path.basename(filePath)} had no usable dialogue lines after cleaning — skipped.`);
        continue;
      }

      const { writeFile } = await import('fs/promises');
      await writeFile(vttFilePath, vttContent, 'utf8');
      console.log(`[Scanner] Extracted subtitle: ${path.join(subtitleRelativePath, vttFileName)}`);
      extracted++;
      continue;
    }

    // All other text-based codecs (subrip, srt, mov_text, webvtt): let ffmpeg convert
    const needsCodecFlag = ['subrip', 'srt', 'mov_text'].includes(codec);
    const result = await runProcess('nice', [
      '-n', '19',
      ffmpegBin,
      '-v', 'error',
      '-i', fullVideoPath,
      '-map', `0:${stream.index}`,
      ...(needsCodecFlag ? ['-c:s', 'webvtt'] : []),
      '-f', 'webvtt',
      vttFilePath,
    ]).catch(() => null);

    if (result && result.code === 0) {
      console.log(`[Scanner] Extracted subtitle: ${path.join(subtitleRelativePath, vttFileName)}`);
      extracted++;
    } else {
      const reason = result?.stderr?.trim().split('\n').pop() ?? 'unknown error';
      console.warn(`[Scanner] Could not convert stream ${stream.index} (codec: ${codec}) from ${path.basename(filePath)} to VTT — ${reason}`);
      import('fs').then(fs => fs.promises.unlink(vttFilePath).catch(() => undefined));

      // Don't spam one warning per stream when mount permissions block writes.
      if (/permission denied/i.test(reason)) {
        console.warn(
          `[Scanner] Stopping subtitle extraction for ${path.basename(filePath)} because output directory is not writable.`
        );
        break;
      }
    }
  }

  if (extracted > 0) {
    console.log(`[Scanner] Saved ${extracted} subtitle file(s) for ${path.basename(filePath)} in ${subtitleRelativePath}.`);
  }
}

// ── Main Scanner ─────────────────────────────────────────────────────────────

export interface ScanResult {
  scanned: number;
  inserted: number;
  errors: string[];
  durationMs: number;
  processedEpisodes: Array<{ id: string; filePath: string }>;
}

export async function runScan(): Promise<ScanResult> {
  const start = Date.now();
  const result: ScanResult = {
    scanned: 0,
    inserted: 0,
    errors: [],
    durationMs: 0,
    processedEpisodes: [],
  };
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
      const upsertedEpisode = await upsertEpisode(
        showId,
        parsed.season ?? 1,
        parsed.episode,
        filePath,
        env.STORAGE_MODE === 's3' ? env.S3_BUCKET_NAME : 'local'
      );

      if (upsertedEpisode?.id) {
        result.processedEpisodes.push({ id: upsertedEpisode.id, filePath: upsertedEpisode.file_path });
      }

      result.inserted++;

      // Extract embedded subtitles to .vtt files next to the video.
      // Awaited sequentially — on a 2-core/1GB VPS running concurrent ffmpeg
      // processes causes CPU/memory spikes that kill streaming for active users.
      // Already-extracted .vtt files are skipped on subsequent scans.
      await extractSubtitlesToDisk(filePath, parsed.episode, parsed.season).catch((err: any) =>
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
