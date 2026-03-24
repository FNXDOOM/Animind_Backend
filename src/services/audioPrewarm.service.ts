import { mkdir, stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { env } from '../config/env.js';

interface AudioStreamMeta {
  streamIndex: number;
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
    const parsed = JSON.parse(probeResult.stdout) as { streams?: Array<{ index?: number }> };
    return (parsed.streams ?? [])
      .filter(stream => typeof stream?.index === 'number')
      .map(stream => ({ streamIndex: stream.index as number }));
  } catch {
    return [];
  }
}

async function getOrCreateAudioVariant(sourcePath: string, episodeId: string, audioTrackIndex: number): Promise<string> {
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

    // Track 0 is treated as default source stream; prewarm alternate tracks only.
    const alternateStreams = streams.slice(1, 1 + maxTracksPerEpisode);
    for (const track of alternateStreams) {
      const key = `${episode.id}:${track.streamIndex}`;
      if (inFlightPrewarm.has(key)) continue;

      inFlightPrewarm.add(key);
      try {
        await getOrCreateAudioVariant(fullVideoPath, episode.id, track.streamIndex);
      } catch (error: any) {
        console.warn('[Prewarm][AudioVariant] Failed:', {
          episodeId: episode.id,
          streamIndex: track.streamIndex,
          error: error?.message || String(error),
        });
      } finally {
        inFlightPrewarm.delete(key);
      }
    }
  }
}
