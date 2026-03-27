/**
 * syncplay.handler.ts
 *
 * Real-time watch-party (SyncPlay) using Socket.IO.
 * Room lifecycle: createRoom → joinRoom → play/pause/seek → leaveRoom
 *
 * Implements Plex/Netflix-style synchronised playback:
 *
 *   1. Dual control     — any participant can play/pause/seek.
 *   2. Smart buffering   — buffer-goal gate (120 s ahead) instead of simple ready/not-ready.
 *   3. Graduated sync    — soft-seek (<200 ms) → speed-seek (<10 s) → hard re-gate.
 *   4. Stall skip        — mid-stream stalls get a 5 s grace before re-gating.
 *   5. Rich peer state   — heartbeat broadcasts position, rate, buffer % per peer.
 *
 * Room state is kept in-memory. For multi-process deployments, replace the
 * `rooms` Map with a Redis adapter: https://socket.io/docs/v4/redis-adapter/
 */

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SYNCPLAY_SOCKET_PATH = '/api/socket.io';
const READY_TIMEOUT_MS = Math.max(5_000, Math.min(60_000, env.SYNCPLAY_READY_TIMEOUT_MS || 12_000));
const BUFFER_GOAL_S = env.SYNCPLAY_BUFFER_GOAL_SECONDS ?? 120;
const SOFT_SEEK_MS = env.SYNCPLAY_SOFT_SEEK_THRESHOLD_MS ?? 200;
const SPEED_SYNC_MS = env.SYNCPLAY_SPEED_SYNC_MAX_MS ?? 10_000;
const ESCAPE_BUFFER_S = env.SYNCPLAY_ESCAPE_BUFFER_SECONDS ?? 30;
const ESCAPE_WAIT_MS = env.SYNCPLAY_ESCAPE_WAIT_MS ?? 10_000;
/** How often the server checks drift on heartbeats (effectively per-peer) */
const STALL_DETECT_WINDOW_MS = 2_000;
/** Mid-stream stall grace before re-gating */
const STALL_GRACE_MS = 5_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface ParticipantState {
  userId: string;
  displayName: string;
  currentTime: number;
  playbackRate: number;
  readyState: 'buffering' | 'ready';
  /** Seconds buffered ahead of currentTime */
  bufferedAhead: number;
  lastHeartbeatAt: number;
  /** Non-zero when the peer is stalling mid-stream */
  stallingSince: number;
}

interface Room {
  code: string;
  episodeId: string;
  hostSocketId: string;
  hostUserId: string;
  /** socketId → userId  (kept for backwards compat / quick lookups) */
  participants: Map<string, string>;
  /** userId → displayName */
  displayNames: Map<string, string>;
  /** Rich per-peer state */
  participantStates: Map<string, ParticipantState>;
  /** Canonical playback position (server-authoritative) */
  currentTime: number;
  isPlaying: boolean;

  // ── Buffer-goal gate ──
  /** Set of socketIds that have met the buffer goal */
  readyPeers: Set<string>;
  waitingForReady: boolean;
  playIntentAfterReady: boolean;
  /** Per-peer force-resume timers */
  readyTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Escape-hatch timer — fires after ESCAPE_WAIT_MS if any peer has ≥ ESCAPE_BUFFER_S */
  escapeTimer: ReturnType<typeof setTimeout> | null;

  // ── Stall tracking ──
  /** socketIds that are currently stalling mid-stream */
  stallingPeers: Set<string>;
  /** Per-peer stall-grace timers (5 s grace before re-gate) */
  stallGraceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// ── In-memory room store ─────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const userDisplayNameCache = new Map<string, string>();
let hasWarnedMissingEndedAtColumn = false;

function isMissingEndedAtColumnError(message: string): boolean {
  return /ended_at/i.test(message) && /(column|schema cache|does not exist)/i.test(message);
}

async function markWatchPartyEndedByCode(roomCode: string): Promise<void> {
  const endedAt = new Date().toISOString();
  const { error } = await supabase
    .from('watch_parties')
    .update({ status: 'ended', ended_at: endedAt })
    .eq('id', roomCode);

  if (!error) return;

  if (isMissingEndedAtColumnError(error.message)) {
    if (!hasWarnedMissingEndedAtColumn) {
      hasWarnedMissingEndedAtColumn = true;
      console.warn('[SyncPlay] watch_parties.ended_at is missing. Run the SyncPlay TTL migration to enable 1-hour auto cleanup.');
    }

    const { error: fallbackError } = await supabase
      .from('watch_parties')
      .update({ status: 'ended' })
      .eq('id', roomCode);

    if (fallbackError) {
      console.warn(`[SyncPlay] Failed to mark room ${roomCode} as ended:`, fallbackError.message);
    }

    return;
  }

  console.warn(`[SyncPlay] Failed to mark room ${roomCode} as ended:`, error.message);
}

async function closeStaleActiveWatchParties(): Promise<void> {
  const endedAt = new Date().toISOString();
  const { error } = await supabase
    .from('watch_parties')
    .update({ status: 'ended', ended_at: endedAt })
    .eq('status', 'active');

  if (!error) {
    console.log('[SyncPlay] Closed stale active watch parties from previous server sessions.');
    return;
  }

  if (isMissingEndedAtColumnError(error.message)) {
    if (!hasWarnedMissingEndedAtColumn) {
      hasWarnedMissingEndedAtColumn = true;
      console.warn('[SyncPlay] watch_parties.ended_at is missing. Run the SyncPlay TTL migration to enable 1-hour auto cleanup.');
    }

    const { error: fallbackError } = await supabase
      .from('watch_parties')
      .update({ status: 'ended' })
      .eq('status', 'active');

    if (fallbackError) {
      console.warn('[SyncPlay] Failed to close stale active watch parties:', fallbackError.message);
      return;
    }

    console.log('[SyncPlay] Closed stale active watch parties from previous server sessions.');
    return;
  }

  if (error) {
    console.warn('[SyncPlay] Failed to close stale active watch parties:', error.message);
    return;
  }
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── Socket auth helper ───────────────────────────────────────────────────────

async function verifySocketToken(token: string): Promise<string | null> {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

async function getUserDisplayName(userId: string): Promise<string> {
  const cached = userDisplayNameCache.get(userId);
  if (cached) return cached;

  const { data } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .maybeSingle();

  const displayName = data?.username?.trim() || `User ${userId.slice(0, 8)}`;
  userDisplayNameCache.set(userId, displayName);
  return displayName;
}

// ── Helper: build serialisable peer-state array ──────────────────────────────

function buildPeerStates(room: Room) {
  return Array.from(room.participantStates.entries()).map(([sid, ps]) => ({
    socketId: sid,
    userId: ps.userId,
    displayName: ps.displayName,
    currentTime: ps.currentTime,
    playbackRate: ps.playbackRate,
    readyState: ps.readyState,
    bufferedAhead: ps.bufferedAhead,
    ready: room.readyPeers.has(sid),
    stalling: room.stallingPeers.has(sid),
  }));
}

// ── Buffer-goal gate helpers ─────────────────────────────────────────────────

/**
 * Initiate a buffer-goal gate: pause everyone, clear ready states, ask all
 * peers to buffer `BUFFER_GOAL_S` seconds ahead at `room.currentTime`.
 */
function initiateBufferGate(
  io: SocketServer,
  room: Room,
  playAfterReady: boolean,
): void {
  // Clear previous timers
  room.readyTimers.forEach(t => clearTimeout(t));
  room.readyTimers.clear();
  if (room.escapeTimer) { clearTimeout(room.escapeTimer); room.escapeTimer = null; }
  room.stallingPeers.clear();
  room.stallGraceTimers.forEach(t => clearTimeout(t));
  room.stallGraceTimers.clear();

  room.readyPeers.clear();
  room.waitingForReady = true;
  room.playIntentAfterReady = playAfterReady;
  room.isPlaying = false;

  const peerStates = buildPeerStates(room);

  io.to(room.code).emit('waitForBufferGoal', {
    currentTime: room.currentTime,
    bufferGoalSeconds: BUFFER_GOAL_S,
    peers: peerStates,
    totalPeers: room.participants.size,
    readyCount: 0,
    sentAt: Date.now(),
  });

  // Backward compat: also emit waitForReady so older clients don't break
  io.to(room.code).emit('waitForReady', {
    currentTime: room.currentTime,
    peers: peerStates,
    totalPeers: room.participants.size,
    readyCount: 0,
    sentAt: Date.now(),
  });

  console.log(
    `[SyncPlay] Room ${room.code}: buffer gate opened (${room.participants.size} peers, goal=${BUFFER_GOAL_S}s, playAfter=${playAfterReady})`
  );

  // Per-peer force-resume timers
  for (const [socketId, uid] of room.participants.entries()) {
    const timer = setTimeout(async () => {
      if (!room.readyPeers.has(socketId) && room.waitingForReady) {
        room.readyPeers.add(socketId);
        room.readyTimers.delete(socketId);
        const dn = await getUserDisplayName(uid);
        io.to(room.code).emit('peerReady', {
          userId: uid,
          displayName: dn,
          timedOut: true,
          readyCount: room.readyPeers.size,
          totalPeers: room.participants.size,
        });
        console.log(`[SyncPlay] Room ${room.code}: peer ${uid} force-readied (timeout)`);
        tryResumeAfterReady(io, room);
      }
    }, READY_TIMEOUT_MS);
    room.readyTimers.set(socketId, timer);
  }

  // Escape hatch: if any peer has ≥ ESCAPE_BUFFER_S after ESCAPE_WAIT_MS, force-start
  room.escapeTimer = setTimeout(() => {
    if (!room.waitingForReady) return;
    // Check if at least one peer has enough buffer
    let anyHasMinBuffer = false;
    for (const ps of room.participantStates.values()) {
      if (ps.bufferedAhead >= ESCAPE_BUFFER_S) { anyHasMinBuffer = true; break; }
    }
    if (anyHasMinBuffer || room.readyPeers.size > 0) {
      console.log(`[SyncPlay] Room ${room.code}: escape hatch triggered (≥${ESCAPE_BUFFER_S}s buffer or some ready)`);
      // Force all remaining peers ready
      for (const [sid] of room.participants.entries()) {
        room.readyPeers.add(sid);
      }
      tryResumeAfterReady(io, room);
    }
  }, ESCAPE_WAIT_MS);
}

/**
 * Check if all peers are ready. If so, close the gate and send coordinated
 * play (or just leave paused if no play intent).
 */
function tryResumeAfterReady(io: SocketServer, room: Room): void {
  if (!room.waitingForReady) return;
  if (room.readyPeers.size < room.participants.size) return;

  // All peers ready — close the gate
  room.waitingForReady = false;
  room.readyTimers.forEach(t => clearTimeout(t));
  room.readyTimers.clear();
  if (room.escapeTimer) { clearTimeout(room.escapeTimer); room.escapeTimer = null; }

  console.log(`[SyncPlay] Room ${room.code}: all peers ready`);

  if (room.playIntentAfterReady) {
    room.isPlaying = true;
    room.playIntentAfterReady = false;
    io.to(room.code).emit('syncPlay', {
      currentTime: room.currentTime,
      sentAt: Date.now(),
    });
    console.log(`[SyncPlay] Room ${room.code}: coordinated play at ${room.currentTime.toFixed(1)}s`);
  } else {
    // Just notify the gate is closed — stay paused
    io.to(room.code).emit('syncPaused', {
      currentTime: room.currentTime,
      sentAt: Date.now(),
    });
  }
}

// ── Graduated drift correction ───────────────────────────────────────────────

/**
 * Called on each heartbeat. Detects drift and sends the appropriate correction:
 *   < SOFT_SEEK_MS   → softCorrect (nudge currentTime)
 *   < SPEED_SYNC_MS  → speedSeek  (temporarily adjust playbackRate)
 *   ≥ SPEED_SYNC_MS  → hard re-gate
 */
function checkDrift(
  io: SocketServer,
  socket: Socket,
  room: Room,
  peerTime: number,
): void {
  if (!room.isPlaying) return;
  if (room.waitingForReady) return;

  const driftMs = Math.abs(peerTime - room.currentTime) * 1000;

  if (driftMs < SOFT_SEEK_MS) {
    // Within tolerance — no action
    return;
  }

  if (driftMs < 500) {
    // Soft seek: nudge currentTime directly
    socket.emit('softCorrect', { currentTime: room.currentTime });
    return;
  }

  if (driftMs < SPEED_SYNC_MS) {
    // Speed seek: adjust playback rate to catch up
    const behind = peerTime < room.currentTime;
    const rate = behind ? 1.5 : 0.8;
    // Duration to apply the speed change (approximate)
    const catchUpMs = Math.min(driftMs * 2, 8000);
    socket.emit('speedSeek', { rate, duration: catchUpMs, targetTime: room.currentTime });
    console.log(`[SyncPlay] Room ${room.code}: speed-seek peer drift=${(driftMs / 1000).toFixed(1)}s rate=${rate}`);
    return;
  }

  // Hard re-gate: drift is too large
  console.log(`[SyncPlay] Room ${room.code}: hard re-gate, peer drift=${(driftMs / 1000).toFixed(1)}s`);
  initiateBufferGate(io, room, true);
}

// ── Stall detection helper ───────────────────────────────────────────────────

function handlePeerStall(
  io: SocketServer,
  socket: Socket,
  room: Room,
  socketId: string,
  userId: string,
): void {
  if (room.stallingPeers.has(socketId)) return; // already tracking
  if (room.waitingForReady) return; // gate already open
  if (!room.isPlaying) return; // not playing

  room.stallingPeers.add(socketId);
  const displayName = room.displayNames.get(userId) ?? userId.slice(0, 8);

  // Broadcast informational stall event
  io.to(room.code).emit('peerStalling', { userId, displayName });
  console.log(`[SyncPlay] Room ${room.code}: peer ${displayName} stalling — 5s grace`);

  // Grace timer: if stall persists > STALL_GRACE_MS, re-gate
  const graceTimer = setTimeout(() => {
    room.stallGraceTimers.delete(socketId);
    if (!room.stallingPeers.has(socketId)) return; // recovered in time
    if (room.waitingForReady) return; // gate already open

    console.log(`[SyncPlay] Room ${room.code}: peer ${displayName} stall persisted > ${STALL_GRACE_MS}ms — re-gating`);
    room.stallingPeers.delete(socketId);
    initiateBufferGate(io, room, true);
  }, STALL_GRACE_MS);

  room.stallGraceTimers.set(socketId, graceTimer);
}

function handlePeerStallRecovered(
  io: SocketServer,
  room: Room,
  socketId: string,
  userId: string,
): void {
  if (!room.stallingPeers.has(socketId)) return;
  room.stallingPeers.delete(socketId);

  const graceTimer = room.stallGraceTimers.get(socketId);
  if (graceTimer) { clearTimeout(graceTimer); room.stallGraceTimers.delete(socketId); }

  const displayName = room.displayNames.get(userId) ?? userId.slice(0, 8);
  io.to(room.code).emit('peerStallRecovered', { userId, displayName });
  console.log(`[SyncPlay] Room ${room.code}: peer ${displayName} recovered from stall`);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export function initSyncPlay(httpServer: HttpServer): SocketServer {
  const allowedOrigins = env.FRONTEND_URL
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const io = new SocketServer(httpServer, {
    path: SYNCPLAY_SOCKET_PATH,
    cors: {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        const normalizedOrigin = origin.replace(/\/+$/, '');
        if (allowedOrigins.includes(normalizedOrigin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Not allowed by SyncPlay CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Rooms are in-memory; any DB row still marked active after restart is stale.
  void closeStaleActiveWatchParties();

  // Auth middleware: validate JWT before socket connects
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required.'));
    }
    const userId = await verifySocketToken(token);
    if (!userId) {
      return next(new Error('Invalid token.'));
    }
    (socket as any).userId = userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;
    console.log(`[SyncPlay] Connected: ${socket.id} (user: ${userId})`);

    // ── createRoom ────────────────────────────────────────────────────────────
    socket.on('createRoom', async ({ episodeId }: { episodeId: string }, callback) => {
      const normalizedEpisodeId = typeof episodeId === 'string' ? episodeId.trim() : '';
      if (!normalizedEpisodeId) {
        if (typeof callback === 'function') callback({ success: false, error: 'Episode is required.' });
        return;
      }

      let code = generateRoomCode();
      while (rooms.has(code)) code = generateRoomCode(); // ensure uniqueness

      const hostDisplayName = await getUserDisplayName(userId);
      const room: Room = {
        code,
        episodeId: normalizedEpisodeId,
        hostSocketId: socket.id,
        hostUserId: userId,
        participants: new Map([[socket.id, userId]]),
        displayNames: new Map([[userId, hostDisplayName]]),
        participantStates: new Map([[socket.id, {
          userId,
          displayName: hostDisplayName,
          currentTime: 0,
          playbackRate: 1,
          readyState: 'ready',
          bufferedAhead: 0,
          lastHeartbeatAt: Date.now(),
          stallingSince: 0,
        }]]),
        currentTime: 0,
        isPlaying: false,
        readyPeers: new Set(),
        waitingForReady: false,
        playIntentAfterReady: false,
        readyTimers: new Map(),
        escapeTimer: null,
        stallingPeers: new Set(),
        stallGraceTimers: new Map(),
      };

      rooms.set(code, room);
      socket.join(code);
      (socket as any).roomCode = code;

      console.log(`[SyncPlay] Room ${code} created by user ${userId} for episode ${normalizedEpisodeId}`);

      // Optionally persist to DB
      await supabase.from('watch_parties').insert({
        id: code,
        host_user_id: userId,
        episode_id: normalizedEpisodeId,
        status: 'active',
      }).then(({ error }) => {
        if (error) console.warn('[SyncPlay] DB insert warn:', error.message);
      });

      if (typeof callback === 'function') callback({ success: true, roomCode: code });
    });

    // ── joinRoom ──────────────────────────────────────────────────────────────
    socket.on('joinRoom', async ({ roomCode }: { roomCode: string }, callback) => {
      const normalizedRoomCode = typeof roomCode === 'string' ? roomCode.trim().toUpperCase() : '';
      if (!normalizedRoomCode) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room code is required.' });
        return;
      }

      const room = rooms.get(normalizedRoomCode);
      if (!room) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found.' });
        return;
      }

      room.participants.set(socket.id, userId);
      socket.join(normalizedRoomCode);
      (socket as any).roomCode = normalizedRoomCode;

      // Persist participant
      await supabase.from('watch_party_participants').insert({
        party_id: normalizedRoomCode,
        user_id: userId,
        joined_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.warn('[SyncPlay] DB participant warn:', error.message);
      });

      const displayName = await getUserDisplayName(userId);
      room.displayNames.set(userId, displayName);

      // Add participant state
      room.participantStates.set(socket.id, {
        userId,
        displayName,
        currentTime: room.currentTime,
        playbackRate: 1,
        readyState: 'buffering',
        bufferedAhead: 0,
        lastHeartbeatAt: Date.now(),
        stallingSince: 0,
      });

      // Build the full participant list to send to the joiner
      const participantList = Array.from(room.participants.values())
        .filter((uid, idx, arr) => arr.indexOf(uid) === idx) // unique userIds
        .map(uid => ({ userId: uid, displayName: room.displayNames.get(uid) ?? uid.slice(0, 8) }));

      // Notify others
      socket.to(normalizedRoomCode).emit('peerJoined', { userId, displayName, participantCount: room.participants.size });

      if (typeof callback === 'function') {
        callback({
          success: true,
          episodeId: room.episodeId,
          currentTime: room.currentTime,
          isPlaying: false, // Always false — buffer gate will coordinate start
          hostUserId: room.hostUserId,
          participantCount: room.participants.size,
          participants: participantList,
          sentAt: Date.now(),
        });
      }

      // New joiner triggers buffer gate
      const wasPlaying = room.isPlaying;
      room.isPlaying = false;
      initiateBufferGate(io, room, wasPlaying);
    });

    // ── play (dual control — any participant) ─────────────────────────────────
    socket.on('play', ({ currentTime: ct }: { currentTime: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (!room.participants.has(socket.id)) return;

      room.currentTime = ct;

      // If there's only one peer (alone), skip the gate — play immediately
      if (room.participants.size === 1) {
        room.isPlaying = true;
        socket.emit('syncPlay', { currentTime: ct, sentAt: Date.now() });
        return;
      }

      // Multiple peers: initiate buffer gate — everyone must buffer then report ready
      initiateBufferGate(io, room, true);
    });

    // ── pause (dual control — any participant) ────────────────────────────────
    socket.on('pause', ({ currentTime: ct }: { currentTime: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (!room.participants.has(socket.id)) return;

      room.isPlaying = false;
      room.currentTime = ct;

      // Cancel any pending buffer gate
      if (room.waitingForReady) {
        room.waitingForReady = false;
        room.playIntentAfterReady = false;
        room.readyTimers.forEach(t => clearTimeout(t));
        room.readyTimers.clear();
        room.readyPeers.clear();
        if (room.escapeTimer) { clearTimeout(room.escapeTimer); room.escapeTimer = null; }
      }

      socket.to(code).emit('pause', { currentTime: ct, fromUserId: userId, sentAt: Date.now() });
    });

    // ── seek (dual control — any participant) ─────────────────────────────────
    socket.on('seek', ({ time }: { time: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (!room.participants.has(socket.id)) return;

      const wasPlaying = room.isPlaying;
      room.currentTime = time;

      // If alone, just broadcast seek directly
      if (room.participants.size === 1) {
        socket.emit('seek', { time, fromUserId: userId, sentAt: Date.now() });
        return;
      }

      // Multiple peers: seek causes a buffer gate so everyone re-buffers
      initiateBufferGate(io, room, wasPlaying);
    });

    // ── ready (peer reports video is buffered and ready to play) ──────────────
    socket.on('ready', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Ignore if not in a gate or already marked ready
      if (!room.waitingForReady) return;
      if (room.readyPeers.has(socket.id)) return;

      room.readyPeers.add(socket.id);

      // Update participant state
      const ps = room.participantStates.get(socket.id);
      if (ps) ps.readyState = 'ready';

      // Cancel force-resume timer for this peer
      const timer = room.readyTimers.get(socket.id);
      if (timer) { clearTimeout(timer); room.readyTimers.delete(socket.id); }

      const displayName = await getUserDisplayName(userId);
      io.to(code).emit('peerReady', {
        userId,
        displayName,
        readyCount: room.readyPeers.size,
        totalPeers: room.participants.size,
      });

      console.log(`[SyncPlay] Room ${code}: peer ${userId} ready (${room.readyPeers.size}/${room.participants.size})`);

      tryResumeAfterReady(io, room);
    });

    // ── bufferingProgress (peer reports buffer % during gate) ─────────────────
    socket.on('bufferingProgress', ({ bufferedSeconds, percent }: { bufferedSeconds: number; percent: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      const ps = room.participantStates.get(socket.id);
      if (ps) {
        ps.bufferedAhead = bufferedSeconds;
        ps.readyState = 'buffering';
      }

      // Broadcast progress to all peers
      const displayName = room.displayNames.get(userId) ?? userId.slice(0, 8);
      io.to(code).emit('bufferingUpdate', {
        userId,
        displayName,
        bufferedSeconds,
        percent,
        bufferGoalSeconds: BUFFER_GOAL_S,
      });

      // Check if this peer has now met the buffer goal
      if (bufferedSeconds >= BUFFER_GOAL_S && room.waitingForReady && !room.readyPeers.has(socket.id)) {
        room.readyPeers.add(socket.id);
        if (ps) ps.readyState = 'ready';

        const readyTimer = room.readyTimers.get(socket.id);
        if (readyTimer) { clearTimeout(readyTimer); room.readyTimers.delete(socket.id); }

        io.to(code).emit('peerReady', {
          userId,
          displayName,
          readyCount: room.readyPeers.size,
          totalPeers: room.participants.size,
        });

        console.log(`[SyncPlay] Room ${code}: peer ${userId} buffer goal met (${bufferedSeconds.toFixed(0)}/${BUFFER_GOAL_S}s)`);
        tryResumeAfterReady(io, room);
      }
    });

    // ── buffering (mid-stream stall — Phase 4 stall skip) ────────────────────
    socket.on('buffering', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Already in a gate — no need to open another one
      if (room.waitingForReady) return;

      // Only matters if the room was actively playing
      if (!room.isPlaying) return;

      // Phase 4: don't re-gate immediately — give 5s grace
      handlePeerStall(io, socket, room, socket.id, userId);
    });

    // ── stallRecovered (peer recovered from mid-stream stall) ─────────────────
    socket.on('stallRecovered', () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      handlePeerStallRecovered(io, room, socket.id, userId);
    });

    // ── heartbeat (continuous position/state sync) ───────────────────────────
    socket.on('heartbeat', ({ currentTime: peerTime, playbackRate: peerRate, bufferedAhead: peerBuf }: {
      currentTime: number;
      playbackRate?: number;
      bufferedAhead?: number;
    }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      const now = Date.now();
      const ps = room.participantStates.get(socket.id);
      if (ps) {
        const prevTime = ps.currentTime;
        ps.currentTime = peerTime;
        ps.playbackRate = peerRate ?? 1;
        ps.bufferedAhead = peerBuf ?? 0;
        ps.lastHeartbeatAt = now;

        // Stall detection: if playing but time hasn't advanced in STALL_DETECT_WINDOW_MS
        if (room.isPlaying && !room.waitingForReady) {
          const timeDelta = Math.abs(peerTime - prevTime);
          if (timeDelta < 0.1 && ps.stallingSince === 0) {
            ps.stallingSince = now;
          } else if (timeDelta >= 0.1) {
            if (ps.stallingSince > 0) {
              ps.stallingSince = 0;
              handlePeerStallRecovered(io, room, socket.id, userId);
            }
          }

          // If stalling for > STALL_DETECT_WINDOW_MS, trigger stall handler
          if (ps.stallingSince > 0 && (now - ps.stallingSince) >= STALL_DETECT_WINDOW_MS) {
            handlePeerStall(io, socket, room, socket.id, userId);
          }
        }
      }

      // Update canonical time from host (or most advanced peer if host is stale)
      if (socket.id === room.hostSocketId && room.isPlaying) {
        room.currentTime = peerTime;
      }

      // Broadcast participant states periodically (piggyback on heartbeat)
      io.to(code).emit('participantStates', {
        peers: buildPeerStates(room),
        canonicalTime: room.currentTime,
        isPlaying: room.isPlaying,
      });

      // Graduated drift correction (Phase 3)
      checkDrift(io, socket, room, peerTime);
    });

    // ── transferHost ───────────────────────────────────────────────────────────
    socket.on('transferHost', async ({ targetUserId }: { targetUserId: string }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the current host can transfer control.' });
        return;
      }

      // Find the target's socket id
      const targetSocketId = Array.from(room.participants.entries())
        .find(([, uid]) => uid === targetUserId)?.[0];
      if (!targetSocketId) {
        socket.emit('syncDenied', { reason: 'Target user is not in the room.' });
        return;
      }

      room.hostSocketId = targetSocketId;
      room.hostUserId   = targetUserId;
      const newHostDisplayName = await getUserDisplayName(targetUserId);
      io.to(code).emit('hostChanged', { newHostUserId: targetUserId, newHostDisplayName });
      console.log(`[SyncPlay] Host of ${code} transferred from ${userId} to ${targetUserId}`);
    });

    // ── changeEpisode ─────────────────────────────────────────────────────────
    socket.on('changeEpisode', ({ episodeId }: { episodeId: string }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can change the episode.' });
        return;
      }

      room.episodeId   = episodeId;
      room.currentTime = 0;
      room.isPlaying   = false;
      room.playIntentAfterReady = false;
      // Clear all readiness state — new episode means fresh start
      room.waitingForReady = false;
      room.readyTimers.forEach(t => clearTimeout(t));
      room.readyTimers.clear();
      room.readyPeers.clear();
      if (room.escapeTimer) { clearTimeout(room.escapeTimer); room.escapeTimer = null; }
      room.stallingPeers.clear();
      room.stallGraceTimers.forEach(t => clearTimeout(t));
      room.stallGraceTimers.clear();

      socket.to(code).emit('episodeChanged', { episodeId, sentAt: Date.now() });
      console.log(`[SyncPlay] Room ${code} episode changed to ${episodeId} by host ${userId}`);
    });

    // ── NTP-style clock sync ping/pong ────────────────────────────────────────
    socket.on('timesync_ping', ({ clientSendTime }: { clientSendTime: number }) => {
      socket.emit('timesync_pong', {
        clientSendTime,          // echoed so client can compute RTT
        serverTime: Date.now(),  // server wall-clock at the moment of receipt
      });
    });

    // ── sync request (late joiner asks host for current time) ────────────────
    socket.on('requestSync', () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      socket.emit('sync', {
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
        waitingForReady: room.waitingForReady,
        sentAt: Date.now(),
      });
    });

    // ── disconnect / leave ────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const code = (socket as any).roomCode;
      if (!code) return;

      const room = rooms.get(code);
      if (!room) return;

      room.participants.delete(socket.id);
      room.readyPeers.delete(socket.id);
      room.participantStates.delete(socket.id);
      room.stallingPeers.delete(socket.id);
      const bt = room.readyTimers.get(socket.id);
      if (bt) { clearTimeout(bt); room.readyTimers.delete(socket.id); }
      const st = room.stallGraceTimers.get(socket.id);
      if (st) { clearTimeout(st); room.stallGraceTimers.delete(socket.id); }

      if (room.participants.size === 0) {
        // Clean up empty room — clear all remaining timers first
        room.readyTimers.forEach(t => clearTimeout(t));
        room.stallGraceTimers.forEach(t => clearTimeout(t));
        if (room.escapeTimer) clearTimeout(room.escapeTimer);
        rooms.delete(code);
        await markWatchPartyEndedByCode(code);
        console.log(`[SyncPlay] Room ${code} closed (all left).`);
      } else {
        // If host left, promote next participant
        if (room.hostSocketId === socket.id) {
          const nextParticipant = room.participants.entries().next().value as [string, string] | undefined;
          if (nextParticipant) {
            const [newHostSocketId, newHostUserId] = nextParticipant;
            room.hostSocketId = newHostSocketId;
            room.hostUserId = newHostUserId;
            const newHostDisplayName = await getUserDisplayName(newHostUserId);
            io.to(code).emit('hostChanged', { newHostUserId, newHostDisplayName });
            console.log(`[SyncPlay] Host left room ${code}, new host: ${newHostUserId}`);
          }
        }

        const displayName = await getUserDisplayName(userId);
        socket.to(code).emit('peerLeft', { userId, displayName, participantCount: room.participants.size });

        // If a peer left during a buffer gate, check if remaining peers are all ready
        if (room.waitingForReady) {
          tryResumeAfterReady(io, room);
        }
      }

      console.log(`[SyncPlay] Disconnected: ${socket.id} (user: ${userId})`);
    });
  });

  return io;
}
