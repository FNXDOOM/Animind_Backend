import { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { stat, readFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from '../config/db.js';
import { getStreamInfo } from '../services/stream.service.js';
import { env } from '../config/env.js';

interface SubtitleTrackPayload {
  id: string;
  label: string;
  language: string;
  content: string;
}

interface AudioTrackPayload {
  id: string;
  label: string;
  language: string;
  streamIndex: number;
}

const SUBTITLE_EXTENSIONS = ['.vtt', '.srt'];
let s3Client: S3Client | null = null;
const STREAM_TICKET_TTL_SECONDS = Math.max(120, env.STREAM_TICKET_TTL_SECONDS);

interface StreamTicketPayload {
  episodeId: string;
  at?: number;
  exp: number;
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signTicketPart(payloadPart: string): string {
  return crypto
    .createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
    .update(payloadPart)
    .digest('base64url');
}

function createStreamTicket(episodeId: string, audioTrackIndex?: number): string {
  const payload: StreamTicketPayload = {
    episodeId,
    ...(typeof audioTrackIndex === 'number' ? { at: audioTrackIndex } : {}),
    exp: Date.now() + STREAM_TICKET_TTL_SECONDS * 1000,
  };
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signaturePart = signTicketPart(payloadPart);
  return `${payloadPart}.${signaturePart}`;
}

function verifyStreamTicket(ticket: string, episodeId: string): boolean {
  const parts = ticket.split('.');
  if (parts.length !== 2) return false;

  const [payloadPart, signaturePart] = parts;
  const expectedSignaturePart = signTicketPart(payloadPart);

  try {
    const provided = Buffer.from(signaturePart);
    const expected = Buffer.from(expectedSignaturePart);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return false;
    }

    const payload = JSON.parse(fromBase64Url(payloadPart)) as StreamTicketPayload;
    if (!payload || payload.episodeId !== episodeId || payload.exp <= Date.now()) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function verifyBearerAuth(authHeader?: string): Promise<boolean> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
  if (!token) return false;

  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data.user;
}

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: !!env.S3_ENDPOINT,
    });
  }
  return s3Client;
}

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isMatchingSubtitleSidecar(fileName: string, videoBaseName: string): boolean {
  const fileNameLower = fileName.toLowerCase();
  const baseNameLower = videoBaseName.toLowerCase();

  if (!fileNameLower.startsWith(baseNameLower)) return false;

  const rest = fileNameLower.slice(baseNameLower.length);
  // Accept both "Episode 01.vtt" and "Episode 01.English.vtt" patterns.
  return /^\.(vtt|srt)$/.test(rest) || /^[._ -].+\.(vtt|srt)$/.test(rest);
}

function subtitleToVtt(content: string, extension: string): string {
  if (extension === '.vtt') {
    return content.startsWith('WEBVTT') ? content : `WEBVTT\n\n${content}`;
  }

  // Basic SRT -> VTT conversion
  const withoutIndices = content.replace(/^\d+\s*$/gm, '').trim();
  const normalizedTimes = withoutIndices.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${normalizedTimes}`;
}

function languageFromFilename(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('.en.') || lower.includes('english')) return 'English';
  if (lower.includes('.jp.') || lower.includes('japanese')) return 'Japanese';
  if (lower.includes('.es.') || lower.includes('spanish')) return 'Spanish';
  return 'Unknown';
}

function normalizeLanguage(raw?: string): string {
  if (!raw) return 'Unknown';
  const val = raw.toLowerCase();
  if (val === 'eng' || val === 'en' || val.includes('english')) return 'English';
  if (val === 'jpn' || val === 'jp' || val.includes('japanese')) return 'Japanese';
  if (val === 'spa' || val === 'es' || val.includes('spanish')) return 'Spanish';
  return raw;
}

async function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function getOrCreateAudioVariant(
  sourcePath: string,
  episodeId: string,
  audioTrackIndex: number
): Promise<string> {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const sourceStat = await stat(sourcePath);
  const sourceSignature = `${sourcePath}:${sourceStat.size}:${sourceStat.mtimeMs}`;
  const variantHash = crypto.createHash('sha1').update(sourceSignature).digest('hex').slice(0, 12);
  const cacheDir = path.resolve(env.LOCAL_STORAGE_PATH, '.animind-audio-cache');
  const outputPath = path.join(cacheDir, `${episodeId}-a${audioTrackIndex}-${variantHash}.mp4`);

  await mkdir(cacheDir, { recursive: true });

  try {
    const cached = await stat(outputPath);
    if (cached.size > 0) {
      return outputPath;
    }
  } catch {
    // Cache miss; build below.
  }

  // First attempt: copy both tracks as-is for speed and quality.
  let result = await runProcess(ffmpegBin, [
    '-y',
    '-v', 'error',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', `0:${audioTrackIndex}`,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]).catch(() => null);

  // Fallback: transcode audio if container/codec copy is incompatible.
  if (!result || result.code !== 0) {
    result = await runProcess(ffmpegBin, [
      '-y',
      '-v', 'error',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', `0:${audioTrackIndex}`,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ]).catch(() => null);
  }

  if (!result || result.code !== 0) {
    const stderr = result?.stderr?.trim() || 'ffmpeg remux failed';
    throw new Error(stderr);
  }

  return outputPath;
}

async function getEmbeddedSubtitleTracks(fullVideoPath: string): Promise<SubtitleTrackPayload[]> {
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';

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
    // ffprobe is missing; skip embedded extraction gracefully
    return [];
  }

  if (probeResult.code !== 0 || !probeResult.stdout.trim()) {
    return [];
  }

  let streams: any[] = [];
  try {
    const parsed = JSON.parse(probeResult.stdout) as { streams?: any[] };
    streams = parsed.streams ?? [];
  } catch {
    return [];
  }

  if (!streams.length) {
    return [];
  }

  const unsupportedCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'xsub']);
  const tracks: SubtitleTrackPayload[] = [];

  for (const stream of streams) {
    if (typeof stream?.index !== 'number') continue;
    const codec = String(stream?.codec_name ?? '').toLowerCase();
    if (unsupportedCodecs.has(codec)) {
      continue;
    }

    const extract = await runProcess(ffmpegBin, [
      '-v', 'error',
      '-i', fullVideoPath,
      '-map', `0:${stream.index}`,
      '-f', 'webvtt',
      'pipe:1',
    ]).catch(() => null);

    if (!extract || extract.code !== 0) {
      continue;
    }

    const raw = extract.stdout.trim();
    if (!raw || !raw.includes('-->')) {
      continue;
    }

    const content = raw.startsWith('WEBVTT') ? raw : `WEBVTT\n\n${raw}`;
    const language = normalizeLanguage(stream?.tags?.language);
    const title = stream?.tags?.title ? String(stream.tags.title) : '';

    tracks.push({
      id: `embedded-${stream.index}`,
      label: title ? `${title} (${language})` : `Embedded ${language} #${stream.index}`,
      language,
      content,
    });
  }

  return tracks;
}

async function getEmbeddedAudioTracks(fullVideoPath: string): Promise<AudioTrackPayload[]> {
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';

  let probeResult: { code: number; stdout: string; stderr: string };
  try {
    probeResult = await runProcess(ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      fullVideoPath,
    ]);
  } catch {
    return [];
  }

  if (probeResult.code !== 0 || !probeResult.stdout.trim()) {
    return [];
  }

  let streams: any[] = [];
  try {
    const parsed = JSON.parse(probeResult.stdout) as { streams?: any[] };
    streams = parsed.streams ?? [];
  } catch {
    return [];
  }

  if (!streams.length) {
    return [];
  }

  const tracks: AudioTrackPayload[] = [];
  let order = 1;

  for (const stream of streams) {
    if (typeof stream?.index !== 'number') continue;

    const language = normalizeLanguage(stream?.tags?.language);
    const title = stream?.tags?.title ? String(stream.tags.title) : '';
    const codec = stream?.codec_name ? String(stream.codec_name).toUpperCase() : '';
    const channels = typeof stream?.channels === 'number' ? `${stream.channels}ch` : '';
    const metadataBits = [codec, channels].filter(Boolean).join(' / ');
    const labelBase = title || `${language} Track ${order}`;
    const label = metadataBits
      ? `${labelBase} [#${stream.index}] (${metadataBits})`
      : `${labelBase} [#${stream.index}]`;

    tracks.push({
      id: `audio-${stream.index}`,
      label,
      language,
      streamIndex: stream.index,
    });

    order += 1;
  }

  return tracks;
}

async function getLocalSubtitleTracks(filePath: string): Promise<SubtitleTrackPayload[]> {
  const fullVideoPath = path.resolve(env.LOCAL_STORAGE_PATH, filePath);
  const dir = path.dirname(fullVideoPath);
  const baseName = path.parse(fullVideoPath).name;

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const subtitleFiles = entries.filter(name => isMatchingSubtitleSidecar(name, baseName));

  const tracks: SubtitleTrackPayload[] = [];
  for (const subtitleFile of subtitleFiles) {
    const ext = path.extname(subtitleFile).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) continue;

    const content = await readFile(path.join(dir, subtitleFile), 'utf-8');
    tracks.push({
      id: subtitleFile,
      label: subtitleFile,
      language: languageFromFilename(subtitleFile),
      content: subtitleToVtt(content, ext),
    });
  }

  const embeddedTracks = await getEmbeddedSubtitleTracks(fullVideoPath);
  tracks.push(...embeddedTracks);

  return tracks;
}

async function getS3SubtitleTracks(filePath: string, bucketName: string): Promise<SubtitleTrackPayload[]> {
  const objectKey = toPosix(filePath);
  const parsed = path.posix.parse(objectKey);
  const prefix = parsed.dir ? `${parsed.dir}/` : '';

  const client = getS3Client();
  const listRes = await client.send(new ListObjectsV2Command({
    Bucket: bucketName || env.S3_BUCKET_NAME,
    Prefix: prefix,
  }));

  const candidateKeys = (listRes.Contents ?? [])
    .map(item => item.Key)
    .filter((key): key is string => !!key)
    .filter(key => isMatchingSubtitleSidecar(path.posix.basename(key), parsed.name));

  const tracks: SubtitleTrackPayload[] = [];
  for (const key of candidateKeys) {
    const ext = path.posix.extname(key).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) continue;

    const objectRes = await client.send(new GetObjectCommand({
      Bucket: bucketName || env.S3_BUCKET_NAME,
      Key: key,
    }));

    const content = await objectRes.Body?.transformToString();
    if (!content) continue;

    const fileName = path.posix.basename(key);
    tracks.push({
      id: key,
      label: fileName,
      language: languageFromFilename(fileName),
      content: subtitleToVtt(content, ext),
    });
  }

  return tracks;
}

/** GET /api/episodes/:id/stream
 * - S3 mode:    Returns { url } or 302 redirect to presigned S3 URL
 * - Local mode: Streams file with HTTP 206 Range support
 */
export async function streamEpisode(req: Request, res: Response) {
  const { id } = req.params;
  const audioTrackParam = typeof req.query.at === 'string' ? req.query.at : undefined;
  const selectedAudioTrackIndex =
    typeof audioTrackParam === 'string' && /^\d+$/.test(audioTrackParam)
      ? parseInt(audioTrackParam, 10)
      : null;

  const streamTicket = typeof req.query.st === 'string' ? req.query.st : undefined;
  const hasValidBearer = await verifyBearerAuth(req.headers.authorization);
  const hasValidTicket = !!streamTicket && verifyStreamTicket(streamTicket, id);

  if (!hasValidBearer && !hasValidTicket) {
    res.status(401).json({ error: 'Missing or invalid stream authorization.' });
    return;
  }

  // 1. Fetch episode record
  const { data: episode, error } = await supabase
    .from('episodes')
    .select('id, file_path, bucket_name')
    .eq('id', id)
    .single();

  if (error || !episode) {
    res.status(404).json({ error: 'Episode not found.' });
    return;
  }

  try {
    const streamInfo = await getStreamInfo(episode.file_path, episode.bucket_name);

    // ── S3: redirect to presigned URL ────────────────────────────────────────
    if (streamInfo.type === 'redirect') {
      // Option A: JSON response (frontend sets <video src={url}>)
      if (req.headers.accept?.includes('application/json')) {
        res.json({ url: streamInfo.url, expiresIn: streamInfo.expiresIn });
        return;
      }
      // Option B: 302 redirect (browser/video player follows automatically)
      res.redirect(302, streamInfo.url);
      return;
    }

    // ── Local: HTTP Range-Request streaming ──────────────────────────────────
    let filePath = streamInfo.url;
    if (selectedAudioTrackIndex !== null) {
      try {
        filePath = await getOrCreateAudioVariant(filePath, id, selectedAudioTrackIndex);
      } catch (variantError: any) {
        console.error('[Stream][AudioVariant] Error:', variantError?.message || variantError);
        res.status(400).json({ error: 'Selected audio track is unavailable for this episode.' });
        return;
      }
    }

    let fileSize: number;
    try {
      const stats = await stat(filePath);
      fileSize = stats.size;
    } catch {
      res.status(404).json({ error: 'Video file not found on disk.' });
      return;
    }

    const rangeHeader = req.headers.range;
    const mimeType = selectedAudioTrackIndex !== null ? 'video/mp4' : getMimeType(episode.file_path);

    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 * 2 - 1, fileSize - 1); // 2 MB chunks
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });

      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      // Full file (fallback — not recommended for large videos)
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    console.error('[Stream] Error:', err.message);
    res.status(500).json({ error: 'Streaming failed.' });
  }
}

/** GET /api/episodes/:id/stream-ticket
 * Issues a short-lived, episode-scoped ticket for video element playback.
 */
export async function getEpisodeStreamTicket(req: Request, res: Response) {
  const { id } = req.params;
  const audioTrackParam = typeof req.query.at === 'string' ? req.query.at : undefined;
  const selectedAudioTrackIndex =
    typeof audioTrackParam === 'string' && /^\d+$/.test(audioTrackParam)
      ? parseInt(audioTrackParam, 10)
      : undefined;

  const { data: episode, error } = await supabase
    .from('episodes')
    .select('id')
    .eq('id', id)
    .single();

  if (error || !episode) {
    res.status(404).json({ error: 'Episode not found.' });
    return;
  }

  const ticket = createStreamTicket(id, selectedAudioTrackIndex);
  const audioQuery = typeof selectedAudioTrackIndex === 'number' ? `&at=${selectedAudioTrackIndex}` : '';
  res.json({
    url: `/api/episodes/${encodeURIComponent(id)}/stream?st=${encodeURIComponent(ticket)}${audioQuery}`,
    expiresIn: STREAM_TICKET_TTL_SECONDS,
  });
}

/** GET /api/episodes/:id/subtitles
 * Returns subtitle tracks for an episode by looking for sidecar subtitle files
 * next to the video file in local storage or S3.
 */
export async function getEpisodeSubtitles(req: Request, res: Response) {
  const { id } = req.params;

  const { data: episode, error } = await supabase
    .from('episodes')
    .select('id, file_path, bucket_name')
    .eq('id', id)
    .single();

  if (error || !episode) {
    res.status(404).json({ error: 'Episode not found.' });
    return;
  }

  try {
    // Subtitles are extracted to .vtt files on disk during scan.
    // getLocalSubtitleTracks already picks them up as sidecar files —
    // instant load after the first scan, no ffprobe needed at play time.
    const tracks = env.STORAGE_MODE === 's3'
      ? await getS3SubtitleTracks(episode.file_path, episode.bucket_name)
      : await getLocalSubtitleTracks(episode.file_path);

    res.json({ tracks });
  } catch (err: any) {
    console.error('[Subtitles] Error:', err.message);
    res.status(500).json({ error: 'Failed to load subtitles.' });
  }
}

/** GET /api/episodes/:id/audio-tracks
 * Returns discoverable embedded audio tracks (local mode only).
 */
export async function getEpisodeAudioTracks(req: Request, res: Response) {
  const { id } = req.params;

  const { data: episode, error } = await supabase
    .from('episodes')
    .select('id, file_path')
    .eq('id', id)
    .single();

  if (error || !episode) {
    res.status(404).json({ error: 'Episode not found.' });
    return;
  }

  if (env.STORAGE_MODE === 's3') {
    res.json({ tracks: [] as AudioTrackPayload[] });
    return;
  }

  try {
    const fullVideoPath = path.resolve(env.LOCAL_STORAGE_PATH, episode.file_path);
    const tracks = await getEmbeddedAudioTracks(fullVideoPath);
    res.json({ tracks });
  } catch (err: any) {
    console.error('[AudioTracks] Error:', err.message);
    res.status(500).json({ error: 'Failed to load audio tracks.' });
  }
}

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    m4v: 'video/mp4',
  };
  return map[ext ?? ''] ?? 'video/mp4';
}
