import { mkdir, stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { env } from '../config/env.js';

interface AudioStreamMeta {
  streamIndex: number;
  codec: string;
  browserSupported: boolean;
  language: string;
}

const BROWSER_SAFE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

function normalizeAudioCodec(raw?: string): string {
  return String(raw ?? '').toLowerCase().trim();
}

function normalizeLanguage(raw?: string): string {
  if (!raw) return 'Unknown';
  const val = raw.toLowerCase();
  if (val === 'eng' || val === 'en' || val.includes('english')) return 'English';
  if (val === 'jpn' || val === 'jp' || val.includes('japanese')) return 'Japanese';
  if (val === 'spa' || val === 'es' || val.includes('spanish')) return 'Spanish';
  return raw;
}

function isJapaneseLanguage(value?: string): boolean {
  return /\b(japanese|jpn|ja|jp)\b/i.test(String(value ?? '').toLowerCase());
}

function isBrowserSafeAudioCodec(codec?: string): boolean {
  const normalized = normalizeAudioCodec(codec);
  if (!normalized) return false;
  return normalized === 'mp4a' || normalized.startsWith('aac') || BROWSER_SAFE_AUDIO_CODECS.has(normalized);
}

function normalizePositiveInt(value: number, fallback: number, min = 1, max = 128): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    child.on('close', code => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function getEmbeddedAudioStreamIndexes(fullVideoPath: string): Promise<AudioStreamMeta[]> {
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const probeResult = await runProcess(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'a',
    fullVideoPath,
  ]).catch(() => null);

  if (!probeResult || probeResult.code !== 0 || !probeResult.stdout.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(probeResult.stdout) as {
      streams?: Array<{ index?: number; codec_name?: string; tags?: { language?: string } }>;
    };
    return (parsed.streams ?? [])
      .filter(stream => typeof stream?.index === 'number')
      .map(stream => {
        const codec = normalizeAudioCodec(stream.codec_name);
        return {
          streamIndex: stream.index as number,
          codec,
          browserSupported: isBrowserSafeAudioCodec(codec),
          language: normalizeLanguage(stream.tags?.language),
        };
      });
  } catch {
    return [];
  }
}

async function getOrCreateAudioVariant(
  sourcePath: string,
  episodeId: string,
  audioTrackIndex: number,
  preferCopyAudio: boolean
): Promise<string> {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const sourceStat = await stat(sourcePath);
  const sourceSignature = `${sourcePath}:${sourceStat.size}:${sourceStat.mtimeMs}:${audioTrackIndex}:${preferCopyAudio ? 'copy' : 'aac'}`;
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

  let result: { code: number; stdout: string; stderr: string } | null = null;

  if (preferCopyAudio) {
    result = await runProcess(ffmpegBin, [
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
  }

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

const inFlightPrewarm = new Set<string>();

export async function prewarmEpisodeAudioVariants(
  episodes: Array<{ id: string; filePath: string }>
): Promise<void> {
  if (env.STORAGE_MODE !== 'local') return;
  if (!env.POST_SCAN_AUDIO_PREWARM_ENABLED) return;

  const episodeLimit = normalizePositiveInt(env.POST_SCAN_AUDIO_PREWARM_EPISODE_LIMIT, 12, 1, 200);
  const maxTracksPerEpisode = normalizePositiveInt(env.POST_SCAN_AUDIO_PREWARM_MAX_TRACKS_PER_EPISODE, 1, 1, 8);

  // Keep earliest scanned entries first; dedupe by episode id.
  const uniqueEpisodes = Array.from(
    new Map(episodes.map(ep => [ep.id, ep])).values()
  ).slice(0, episodeLimit);

  if (!uniqueEpisodes.length) return;

  for (const episode of uniqueEpisodes) {
    const fullVideoPath = path.resolve(env.LOCAL_STORAGE_PATH, episode.filePath);
    const streams = await getEmbeddedAudioStreamIndexes(fullVideoPath).catch(() => []);

    // Only prewarm tracks that are not browser-safe to keep CPU usage low.
    // JP tracks are prioritized; if JP fails/missing, other languages are used.
    const unsupportedStreams = streams.filter(track => !track.browserSupported);
    const jpUnsupported = unsupportedStreams.filter(track => isJapaneseLanguage(track.language));
    const nonJpUnsupported = unsupportedStreams.filter(track => !isJapaneseLanguage(track.language));
    const orderedCandidates = [...jpUnsupported, ...nonJpUnsupported].slice(0, maxTracksPerEpisode);

    for (const track of orderedCandidates) {
      const key = `${episode.id}:${track.streamIndex}`;
      if (inFlightPrewarm.has(key)) continue;

      inFlightPrewarm.add(key);
      try {
        await getOrCreateAudioVariant(fullVideoPath, episode.id, track.streamIndex, track.browserSupported);
      } catch (error: any) {
        console.warn('[Prewarm][AudioVariant] Failed:', {
          episodeId: episode.id,
          streamIndex: track.streamIndex,
          language: track.language,
          codec: track.codec,
          error: error?.message || String(error),
        });
      } finally {
        inFlightPrewarm.delete(key);
      }
    }
  }
}
