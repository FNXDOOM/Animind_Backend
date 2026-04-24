/**
 * hlsSession.service.ts
 *
 * Manages ffmpeg-based HLS streaming sessions. Each session corresponds to
 * one episode being played with a specific audio track. ffmpeg outputs
 * segmented HLS (.m3u8 + .ts) to a temp directory. Segments are served
 * on-demand and auto-cleaned when the session ends.
 *
 * Key design choices:
 *  - Sessions live in os.tmpdir()/animind-hls/<sessionId>/
 *  - Max concurrent sessions = env.HLS_MAX_CONCURRENT_SESSIONS (default 2)
 *  - Sessions auto-expire after env.HLS_SESSION_TIMEOUT_MINUTES (default 30)
 *  - Segments are 6 seconds long (configurable via env.HLS_SEGMENT_DURATION)
 *  - ffmpeg uses -hls_flags delete_segments to keep only recent segments on disk
 */

import { spawn, ChildProcess } from 'child_process';
import { mkdir, rm, readFile, stat, readdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { env } from '../config/env.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface HlsSession {
  id: string;
  episodeId: string;
  sourcePath: string;
  audioTrackIndex: number;
  browserSafeAudio: boolean;
  /** Whether the source video is HEVC/H.265 — requires -tag:v hvc1 for Android ExoPlayer */
  isHevc: boolean;
  ffmpegProcess: ChildProcess | null;
  dir: string;
  playlistPath: string;
  lastAccess: number;
  startTime: number;
  /** Resolves when the first segment is ready (playlist exists and has at least one segment) */
  readyPromise: Promise<void>;
  /** Whether the session is being destroyed */
  destroying: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Audio codecs that can be stream-copied directly into MPEG-TS (HLS).
 *
 * IMPORTANT: Opus and Vorbis are NOT valid in MPEG-TS — the TS specification
 * has no registered PID for them. Attempting -c:a copy with Opus/Vorbis causes
 * ffmpeg to emit "Error parsing Opus/Vorbis packet header" and write broken
 * segments that ExoPlayer cannot decode. Always transcode those to AAC.
 */
const HLS_MPEGTS_COPY_SAFE_CODECS = new Set(['aac', 'mp3']);
const HLS_ROOT_DIR = path.join(os.tmpdir(), 'animind-hls');
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, HlsSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true only for codecs that are valid in MPEG-TS and safe to copy.
 * Opus and Vorbis are excluded even though they play fine in MP4/WebM,
 * because MPEG-TS does not support them.
 */
function isMpegTsCopySafeCodec(codec?: string): boolean {
  const normalized = String(codec ?? '').toLowerCase().trim();
  if (!normalized) return false;
  // aac covers both 'aac' and 'aac_latm'; mp4a is the MPEG-4 Audio Object type alias
  return normalized === 'mp4a' || normalized.startsWith('aac') || HLS_MPEGTS_COPY_SAFE_CODECS.has(normalized);
}

function generateSessionId(): string {
  return crypto.randomBytes(16).toString('hex');
}

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

async function getAudioStreamCodec(fullVideoPath: string, streamIndex: number): Promise<string | null> {
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const probeResult = await runProcess(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'a',
    fullVideoPath,
  ]).catch(() => null);

  if (!probeResult || probeResult.code !== 0 || !probeResult.stdout.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(probeResult.stdout) as {
      streams?: Array<{ index?: number; codec_name?: string }>;
    };
    const stream = (parsed.streams ?? []).find(item => item?.index === streamIndex);
    return stream?.codec_name ? String(stream.codec_name).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Probe the first video stream codec of the source file.
 * Used to detect HEVC/H.265 so we can add -tag:v hvc1 for Android ExoPlayer compatibility.
 */
async function getVideoStreamCodec(fullVideoPath: string): Promise<string | null> {
  const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
  const probeResult = await runProcess(ffprobeBin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'v:0',
    fullVideoPath,
  ]).catch(() => null);

  if (!probeResult || probeResult.code !== 0 || !probeResult.stdout.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(probeResult.stdout) as {
      streams?: Array<{ codec_name?: string }>;
    };
    const stream = (parsed.streams ?? [])[0];
    return stream?.codec_name ? String(stream.codec_name).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Wait for playlist to contain at least one segment entry */
async function waitForFirstSegment(playlistPath: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  const checkInterval = 250;

  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(playlistPath, 'utf-8');
      // A valid HLS playlist with segments will contain .ts entries.
      if (content.includes('.ts') && content.includes('#EXTINF:')) {
        return;
      }
    } catch {
      // File doesn't exist yet, keep waiting
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  throw new Error('HLS session timed out waiting for first segment');
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Create a new HLS streaming session.
 * Starts ffmpeg in the background producing HLS segments.
 * Returns immediately — hls.js polls the playlist endpoint for segments.
 */
export async function createSession(
  sourcePath: string,
  episodeId: string,
  audioTrackIndex: number,
  startTime = 0,
): Promise<{ sessionId: string; playlistUrl: string }> {
  // Enforce concurrency limit
  const activeSessions = Array.from(sessions.values()).filter(s => !s.destroying);
  if (activeSessions.length >= env.HLS_MAX_CONCURRENT_SESSIONS) {
    // Evict the least-recently-accessed session
    const oldest = activeSessions.sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (oldest) {
      console.log(`[HLS] Evicting oldest session ${oldest.id} (episode ${oldest.episodeId}) to make room`);
      await destroySession(oldest.id);
    }
  }

  const sessionId = generateSessionId();
  const sessionDir = path.join(HLS_ROOT_DIR, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const playlistPath = path.join(sessionDir, 'playlist.m3u8');
  const segmentPattern = path.join(sessionDir, 'seg%05d.ts');

  // Determine audio encoding strategy.
  // Only AAC and MP3 can be stream-copied into MPEG-TS; Opus/Vorbis must be transcoded.
  const codec = await getAudioStreamCodec(sourcePath, audioTrackIndex).catch(() => null);
  const canCopyAudio = isMpegTsCopySafeCodec(codec ?? undefined);

  // Detect HEVC/H.265 video — Android ExoPlayer requires -tag:v hvc1 for HEVC in MPEG-TS HLS.
  // Without this tag ffmpeg defaults to hev1 which Media3 cannot decode.
  const videoCodec = await getVideoStreamCodec(sourcePath).catch(() => null);
  const isHevc = videoCodec === 'hevc' || videoCodec === 'h265';

  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const segDuration = Math.max(2, Math.min(30, env.HLS_SEGMENT_DURATION));

  const ffmpegArgs: string[] = [
    '-v', 'warning',
    '-threads', '0',
    // Seek to start position if specified
    ...(startTime > 0 ? ['-ss', String(startTime)] : []),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', `0:${audioTrackIndex}`,
    '-c:v', 'copy',
    // HEVC in MPEG-TS must be tagged hvc1 for Android Media3/ExoPlayer to decode it.
    // Without this flag ffmpeg emits a warning and uses hev1, which Android rejects.
    ...(isHevc ? ['-tag:v', 'hvc1'] : []),
    ...(canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-f', 'hls',
    '-hls_time', String(segDuration),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'append_list+temp_file',
    '-hls_segment_filename', segmentPattern,
    '-start_number', '0',
    playlistPath,
  ];

  const ffmpegProcess = spawn(ffmpegBin, ffmpegArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Log ffmpeg errors but don't crash
  ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg && !msg.startsWith('frame=')) {
      console.warn(`[HLS][${sessionId.slice(0, 8)}] ffmpeg: ${msg.slice(0, 200)}`);
    }
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[HLS][${sessionId.slice(0, 8)}] ffmpeg process error:`, err.message);
  });

  ffmpegProcess.on('close', (code) => {
    const session = sessions.get(sessionId);
    if (session && !session.destroying) {
      console.log(`[HLS][${sessionId.slice(0, 8)}] ffmpeg exited with code ${code}`);
    }
  });

  const readyPromise = waitForFirstSegment(playlistPath);

  const session: HlsSession = {
    id: sessionId,
    episodeId,
    sourcePath,
    audioTrackIndex,
    browserSafeAudio: canCopyAudio,
    isHevc,
    ffmpegProcess,
    dir: sessionDir,
    playlistPath,
    lastAccess: Date.now(),
    startTime,
    readyPromise,
    destroying: false,
  };

  sessions.set(sessionId, session);
  startCleanupTimer();

  // Wait for the first segment before returning — with 2s segments this
  // blocks for only ~1-2 seconds, and guarantees the playlist is playable
  // when hls.js first loads it (important for frontends without retry logic).
  await readyPromise;

  console.log(`[HLS] Session ${sessionId.slice(0, 8)} created for episode ${episodeId} (video: ${videoCodec ?? 'unknown'}${isHevc ? ' [hvc1 tag]' : ''}, audio: track ${audioTrackIndex} codec=${codec ?? 'unknown'} ${canCopyAudio ? '[copy]' : '[→aac transcode]'})`);

  return {
    sessionId,
    playlistUrl: `/api/hls/${sessionId}/playlist.m3u8`,
  };
}

/**
 * Get the HLS playlist content for a session.
 */
export async function getPlaylist(sessionId: string): Promise<string | null> {
  const session = sessions.get(sessionId);
  if (!session || session.destroying) return null;

  session.lastAccess = Date.now();

  try {
    return await readFile(session.playlistPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get the absolute path to a segment file for streaming.
 */
export async function getSegmentPath(sessionId: string, segmentName: string): Promise<string | null> {
  const session = sessions.get(sessionId);
  if (!session || session.destroying) return null;

  session.lastAccess = Date.now();

  // Sanitize segment name to prevent path traversal
  const safeName = path.basename(segmentName);
  if (!safeName.endsWith('.ts')) return null;

  const segmentPath = path.join(session.dir, safeName);

  try {
    const stats = await stat(segmentPath);
    if (stats.size > 0) return segmentPath;
    return null;
  } catch {
    return null;
  }
}

/**
 * Seek to a new position. Kills current ffmpeg and restarts from the new time.
 */
export async function seekSession(sessionId: string, timeSeconds: number): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session || session.destroying) return false;

  session.lastAccess = Date.now();

  // Kill current ffmpeg process
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGKILL');
  }

  // Clean up existing segments
  try {
    const files = await readdir(session.dir);
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.tmp')) {
        await rm(path.join(session.dir, file), { force: true });
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  // Restart ffmpeg from new position
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const segDuration = Math.max(2, Math.min(30, env.HLS_SEGMENT_DURATION));
  const segmentPattern = path.join(session.dir, 'seg%05d.ts');

  const ffmpegArgs: string[] = [
    '-v', 'warning',
    '-threads', '0',
    '-ss', String(Math.max(0, timeSeconds)),
    '-i', session.sourcePath,
    '-map', '0:v:0',
    '-map', `0:${session.audioTrackIndex}`,
    '-c:v', 'copy',
    // Preserve hvc1 tag on seek restart — same requirement as createSession.
    ...(session.isHevc ? ['-tag:v', 'hvc1'] : []),
    ...(session.browserSafeAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-f', 'hls',
    '-hls_time', String(segDuration),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'append_list+temp_file',
    '-hls_segment_filename', segmentPattern,
    '-start_number', '0',
    session.playlistPath,
  ];

  const ffmpegProcess = spawn(ffmpegBin, ffmpegArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg && !msg.startsWith('frame=')) {
      console.warn(`[HLS][${sessionId.slice(0, 8)}] ffmpeg: ${msg.slice(0, 200)}`);
    }
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[HLS][${sessionId.slice(0, 8)}] ffmpeg process error:`, err.message);
  });

  ffmpegProcess.on('close', (code) => {
    const s = sessions.get(sessionId);
    if (s && !s.destroying) {
      console.log(`[HLS][${sessionId.slice(0, 8)}] ffmpeg (seek) exited with code ${code}`);
    }
  });

  session.ffmpegProcess = ffmpegProcess;
  session.startTime = timeSeconds;
  session.readyPromise = waitForFirstSegment(session.playlistPath);

  // Wait for the first new segment before returning
  await session.readyPromise;

  console.log(`[HLS] Session ${sessionId.slice(0, 8)} seeked to ${timeSeconds}s`);
  return true;
}

/**
 * Destroy a specific session — kill ffmpeg and delete temp files.
 */
export async function destroySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.destroying = true;

  // Kill ffmpeg
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGKILL');
  }

  // Remove temp directory
  try {
    await rm(session.dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  sessions.delete(sessionId);
  console.log(`[HLS] Session ${sessionId.slice(0, 8)} destroyed`);

  if (sessions.size === 0) {
    stopCleanupTimer();
  }
}

/**
 * Destroy all sessions — used during graceful shutdown.
 */
export async function destroyAllSessions(): Promise<void> {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map(id => destroySession(id)));

  // Also clean up the root HLS temp directory
  try {
    await rm(HLS_ROOT_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  console.log(`[HLS] All sessions destroyed (${ids.length})`);
}

/**
 * Check if a session exists and is active.
 */
export function hasSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return !!session && !session.destroying;
}

/**
 * Get stats about active HLS sessions.
 */
export function getSessionStats(): {
  activeSessions: number;
  maxSessions: number;
  sessions: Array<{ id: string; episodeId: string; audioTrack: number; idleSeconds: number }>;
} {
  const now = Date.now();
  return {
    activeSessions: sessions.size,
    maxSessions: env.HLS_MAX_CONCURRENT_SESSIONS,
    sessions: Array.from(sessions.values())
      .filter(s => !s.destroying)
      .map(s => ({
        id: s.id.slice(0, 8),
        episodeId: s.episodeId,
        audioTrack: s.audioTrackIndex,
        idleSeconds: Math.round((now - s.lastAccess) / 1000),
      })),
  };
}

// ── Auto-cleanup ─────────────────────────────────────────────────────────────

function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
}

function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  const timeoutMs = env.HLS_SESSION_TIMEOUT_MINUTES * 60 * 1000;

  for (const [id, session] of sessions) {
    if (session.destroying) continue;
    if (now - session.lastAccess > timeoutMs) {
      console.log(`[HLS] Session ${id.slice(0, 8)} expired (idle for ${Math.round((now - session.lastAccess) / 60000)}m)`);
      await destroySession(id);
    }
  }
}
