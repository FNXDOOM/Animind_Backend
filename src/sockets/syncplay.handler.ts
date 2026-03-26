/**
 * syncplay.handler.ts  — Animind SyncPlay v2
 *
 * Architecture: Plex-style host authority + NTP clock calibration +
 *               scheduled-play gate (Netflix/YouTube style)
 *
 * Key techniques used by Netflix / YouTube / Plex:
 *
 *  1. NTP ping/pong clock offset  — every client measures RTT and computes
 *     its own offset from server wall-clock.  This cancels client-clock skew.
 *
 *  2. Readiness gate with scheduled play-time  — instead of "play NOW", the
 *     server says "play at server_wall_clock_ms = T".  Each client schedules
 *     video.play() so it fires at the exact same wall-clock instant, even if
 *     clients have different latencies.  This is how Netflix Party & Discord
 *     ActivityManager achieve <50 ms sync.
 *
 *  3. Continuous soft drift correction  — while playing, each participant
 *     sends a heartbeat with their local currentTime.  The server computes
 *     drift relative to the host.  If drift > 0.5 s → soft seek (no re-gate).
 *     If drift > 2 s → full re-gate.
 *
 *  4. Adaptive buffering gate  — any peer stall opens a gate.  The stalled
 *     peer is given a 30 s window to recover; if it times out it is skipped
 *     and play resumes.
 *
 *  5. Slow-connection accommodation  — participants with high latency get
 *     an extra "catch-up" margin baked into the scheduled play-time.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Peer {
  socketId: string;
  userId: string;
  displayName: string;
  /** Estimated one-way latency (ms) from NTP ping/pong */
  estimatedLatencyMs: number;
  /** Client clock offset: serverTime = clientTime + clockOffsetMs */
  clockOffsetMs: number;
  /** Number of NTP samples collected (for averaging) */
  ntpSamples: number;
  /** Whether this peer has reported ready in the current gate */
  ready: boolean;
  /** Whether this peer is actively buffering */
  buffering: boolean;
  /** Force-ready fallback timer */
  forceReadyTimer?: ReturnType<typeof setTimeout>;
  /** Reported currentTime from last heartbeat */
  lastReportedTime: number;
  lastHeartbeatAt: number;
}

interface Room {
  code: string;
  episodeId: string;
  hostSocketId: string;
  hostUserId: string;
  peers: Map<string, Peer>;           // socketId → Peer
  /** Server-side canonical playback time (seconds), updated on each host action */
  currentTime: number;
  /** Whether room intends to be playing (not paused) */
  isPlaying: boolean;
  /** Whether a readiness gate is currently open */
  gateOpen: boolean;
  /** If gate is open, should we play when it closes? */
  playAfterGate: boolean;
  /** Wall-clock ms at which we last computed currentTime */
  lastTimestampAt: number;
  /** Drift-check interval */
  driftCheckTimer?: ReturnType<typeof setInterval>;
}

// ─── In-memory room store ─────────────────────────────────────────────────────
const rooms = new Map<string, Room>();
const userDisplayNameCache = new Map<string, string>();

const SYNCPLAY_SOCKET_PATH = '/api/socket.io';

/** After gate opens, wait this long for slow peers before forcing them ready */
const READY_TIMEOUT_MS = 30_000;

/**
 * Extra scheduling margin (ms) added to the scheduled play-time to give
 * all clients time to wake up from the gate.  Higher = safer on slow connections.
 * 500 ms is the Netflix Party default.
 */
const SCHEDULE_MARGIN_MS = 600;

/**
 * Maximum clock-offset samples to keep per peer.
 * We use a running average over the last N samples.
 */
const MAX_NTP_SAMPLES = 8;

/** Heartbeat interval for drift detection (ms) */
const HEARTBEAT_INTERVAL_MS = 3_000;

/** Drift threshold for soft correction (seconds) */
const SOFT_DRIFT_THRESHOLD_S = 0.5;

/** Drift threshold for hard re-gate (seconds) */
const HARD_DRIFT_THRESHOLD_S = 2.5;

let hasWarnedMissingEndedAtColumn = false;

// ─── DB helpers ───────────────────────────────────────────────────────────────

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
      console.warn('[SyncPlay] watch_parties.ended_at column missing. Run TTL migration.');
    }
    await supabase.from('watch_parties').update({ status: 'ended' }).eq('id', roomCode);
    return;
  }
  console.warn(`[SyncPlay] Failed to mark room ${roomCode} ended:`, error.message);
}

async function closeStaleActiveWatchParties(): Promise<void> {
  const endedAt = new Date().toISOString();
  const { error } = await supabase
    .from('watch_parties')
    .update({ status: 'ended', ended_at: endedAt })
    .eq('status', 'active');

  if (!error) { console.log('[SyncPlay] Stale active parties cleaned up.'); return; }

  if (isMissingEndedAtColumnError(error.message)) {
    if (!hasWarnedMissingEndedAtColumn) {
      hasWarnedMissingEndedAtColumn = true;
      console.warn('[SyncPlay] watch_parties.ended_at column missing. Run TTL migration.');
    }
    const { error: fallback } = await supabase
      .from('watch_parties').update({ status: 'ended' }).eq('status', 'active');
    if (!fallback) console.log('[SyncPlay] Stale active parties cleaned up (fallback).');
    return;
  }
  console.warn('[SyncPlay] Failed to close stale parties:', error.message);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

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
    .from('profiles').select('username').eq('id', userId).maybeSingle();
  const name = data?.username?.trim() || `User ${userId.slice(0, 8)}`;
  userDisplayNameCache.set(userId, name);
  return name;
}

/** Compute canonical server time in seconds, advancing from last snapshot */
function getCanonicalTime(room: Room): number {
  if (!room.isPlaying || room.gateOpen) return room.currentTime;
  const elapsed = (Date.now() - room.lastTimestampAt) / 1000;
  return room.currentTime + elapsed;
}

/** Snapshot canonical time into room.currentTime (call before emitting events) */
function snapshotTime(room: Room): void {
  room.currentTime = getCanonicalTime(room);
  room.lastTimestampAt = Date.now();
}

/** Max estimated latency across all peers in the room (ms) */
function maxLatencyMs(room: Room): number {
  let max = 0;
  for (const peer of room.peers.values()) {
    if (peer.estimatedLatencyMs > max) max = peer.estimatedLatencyMs;
  }
  return max;
}

// ─── Readiness Gate ───────────────────────────────────────────────────────────

/**
 * Open the readiness gate.
 *
 * Steps:
 *  1. Pause all peers.
 *  2. Emit `waitForReady` with current canonical time and a scheduled
 *     play-time (server wall-clock ms) so every peer can play at the same
 *     instant even across different network latencies.
 *  3. Each peer seeks to `currentTime`, buffers, and emits `ready`.
 *  4. When all peers are ready, emit `allReady` with the scheduled play-time.
 *  5. Set force-ready timers for slow/unresponsive peers.
 */
function openGate(io: SocketServer, room: Room, playAfterGate: boolean): void {
  // Cancel any existing gate first
  closeGateTimers(room);

  snapshotTime(room);
  room.gateOpen = true;
  room.playAfterGate = playAfterGate;
  room.isPlaying = false;

  // Reset ready state for all peers
  for (const peer of room.peers.values()) {
    peer.ready = false;
    peer.buffering = false;
  }

  // Compute scheduled play-time: server wall-clock ms when all clients should call play().
  // We add SCHEDULE_MARGIN_MS + max peer latency so even the slowest peer has time.
  const slowestPeerLatency = maxLatencyMs(room);
  const scheduledPlayAt = Date.now() + SCHEDULE_MARGIN_MS + slowestPeerLatency;

  const peersArray = Array.from(room.peers.values()).map(p => ({
    userId: p.userId,
    displayName: p.displayName,
    ready: false,
  }));

  io.to(room.code).emit('waitForReady', {
    currentTime: room.currentTime,
    scheduledPlayAt,          // ← wall-clock ms: "play at this exact moment"
    playAfterGate,
    peers: peersArray,
    totalPeers: room.peers.size,
    readyCount: 0,
    sentAt: Date.now(),
  });

  console.log(
    `[SyncPlay] Room ${room.code}: gate opened — ${room.peers.size} peer(s), ` +
    `t=${room.currentTime.toFixed(2)}s, playAt=${scheduledPlayAt}, playAfter=${playAfterGate}`
  );

  // Force-ready timers per peer
  for (const [socketId, peer] of room.peers.entries()) {
    peer.forceReadyTimer = setTimeout(async () => {
      if (!room.gateOpen) return;
      if (peer.ready) return;
      peer.ready = true;
      console.log(`[SyncPlay] Room ${room.code}: force-ready peer ${peer.userId} (timeout)`);
      io.to(room.code).emit('peerReady', {
        userId: peer.userId,
        displayName: peer.displayName,
        timedOut: true,
        readyCount: countReady(room),
        totalPeers: room.peers.size,
      });
      tryCloseGate(io, room);
    }, READY_TIMEOUT_MS);
  }
}

function countReady(room: Room): number {
  let n = 0;
  for (const p of room.peers.values()) if (p.ready) n++;
  return n;
}

function closeGateTimers(room: Room): void {
  for (const peer of room.peers.values()) {
    if (peer.forceReadyTimer) {
      clearTimeout(peer.forceReadyTimer);
      peer.forceReadyTimer = undefined;
    }
  }
}

/**
 * Check if all peers are ready; if so, close the gate and schedule play.
 * The scheduled play-time is consistent with what was sent in `waitForReady`.
 */
function tryCloseGate(io: SocketServer, room: Room): void {
  if (!room.gateOpen) return;
  const ready = countReady(room);
  if (ready < room.peers.size) return;

  // All ready — close gate
  room.gateOpen = false;
  closeGateTimers(room);

  if (room.playAfterGate) {
    const slowestPeerLatency = maxLatencyMs(room);
    const scheduledPlayAt = Date.now() + SCHEDULE_MARGIN_MS + slowestPeerLatency;
    room.isPlaying = true;
    room.lastTimestampAt = scheduledPlayAt; // canonical time starts ticking from scheduledPlayAt
    // Don't advance currentTime yet — let it start from the gate snapshot

    io.to(room.code).emit('allReady', {
      currentTime: room.currentTime,
      scheduledPlayAt,          // ← every client calls play() at exactly this ms
      sentAt: Date.now(),
    });

    console.log(
      `[SyncPlay] Room ${room.code}: gate closed — all ${ready} peer(s) ready, ` +
      `scheduled play at ${scheduledPlayAt} (in ~${scheduledPlayAt - Date.now()}ms)`
    );
  } else {
    io.to(room.code).emit('syncPaused', {
      currentTime: room.currentTime,
      sentAt: Date.now(),
    });
    console.log(`[SyncPlay] Room ${room.code}: gate closed — staying paused`);
  }
}

// ─── Drift correction ─────────────────────────────────────────────────────────

function startDriftCheck(io: SocketServer, room: Room): void {
  stopDriftCheck(room);
  room.driftCheckTimer = setInterval(() => {
    if (!room.isPlaying || room.gateOpen || room.peers.size < 2) return;

    const canonicalTime = getCanonicalTime(room);
    const now = Date.now();

    for (const peer of room.peers.values()) {
      if (peer.socketId === room.hostSocketId) continue;
      if (now - peer.lastHeartbeatAt > 10_000) continue; // stale peer, skip

      const drift = Math.abs(canonicalTime - peer.lastReportedTime);

      if (drift > HARD_DRIFT_THRESHOLD_S) {
        console.log(
          `[SyncPlay] Room ${room.code}: hard drift for ${peer.userId} (${drift.toFixed(2)}s) — re-gating`
        );
        snapshotTime(room);
        openGate(io, room, true);
        return; // gate handles everyone
      }

      if (drift > SOFT_DRIFT_THRESHOLD_S) {
        // Soft correction: tell just this peer to snap to canonical time
        console.log(
          `[SyncPlay] Room ${room.code}: soft drift for ${peer.userId} (${drift.toFixed(2)}s) — correcting`
        );
        const targetSocket = io.sockets.sockets.get(peer.socketId);
        if (targetSocket) {
          targetSocket.emit('softCorrect', {
            currentTime: canonicalTime,
            isPlaying: true,
            sentAt: Date.now(),
          });
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopDriftCheck(room: Room): void {
  if (room.driftCheckTimer) {
    clearInterval(room.driftCheckTimer);
    room.driftCheckTimer = undefined;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export function initSyncPlay(httpServer: HttpServer): SocketServer {
  const allowedOrigins = env.FRONTEND_URL
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const io = new SocketServer(httpServer, {
    path: SYNCPLAY_SOCKET_PATH,
    cors: {
      origin: (origin, cb) => {
        if (!origin) { cb(null, true); return; }
        const normalized = origin.replace(/\/+$/, '');
        if (allowedOrigins.includes(normalized)) { cb(null, true); return; }
        cb(new Error('Not allowed by SyncPlay CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Ping/pong to detect dead connections quickly
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });

  void closeStaleActiveWatchParties();

  // JWT auth middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required.'));
    const userId = await verifySocketToken(token);
    if (!userId) return next(new Error('Invalid token.'));
    (socket as any).userId = userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;
    console.log(`[SyncPlay] Connected: ${socket.id} (user: ${userId})`);

    // ── NTP clock sync ping/pong ───────────────────────────────────────────
    // Client emits: { clientSendTime: Date.now() }
    // Server replies: { clientSendTime, serverReceiveTime }
    // Client computes: RTT = Date.now() - clientSendTime
    //                  oneWay = RTT / 2
    //                  offset = serverReceiveTime + oneWay - Date.now()
    //                  (serverTime = clientTime + offset)
    socket.on('timesync_ping', ({ clientSendTime }: { clientSendTime: number }) => {
      socket.emit('timesync_pong', {
        clientSendTime,
        serverReceiveTime: Date.now(),
      });

      // Update peer latency estimate using client-reported RTT if provided
      const code = (socket as any).roomCode as string | undefined;
      const room = code ? rooms.get(code) : undefined;
      const peer = room?.peers.get(socket.id);
      if (peer) {
        const rtt = Date.now() - clientSendTime;
        const oneWay = rtt / 2;
        // Running average of N samples
        const weight = 1 / Math.min(peer.ntpSamples + 1, MAX_NTP_SAMPLES);
        peer.estimatedLatencyMs = peer.estimatedLatencyMs * (1 - weight) + oneWay * weight;
        peer.ntpSamples++;
      }
    });

    // Client also tells us its computed clock offset after ping/pong
    socket.on('timesync_offset', ({ offsetMs }: { offsetMs: number }) => {
      const code = (socket as any).roomCode as string | undefined;
      const room = code ? rooms.get(code) : undefined;
      const peer = room?.peers.get(socket.id);
      if (!peer || typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) return;
      // Running average
      const weight = 1 / Math.min(peer.ntpSamples + 1, MAX_NTP_SAMPLES);
      peer.clockOffsetMs = peer.clockOffsetMs * (1 - weight) + offsetMs * weight;
    });

    // ── createRoom ────────────────────────────────────────────────────────
    socket.on('createRoom', async ({ episodeId }: { episodeId: string }, callback) => {
      const epId = typeof episodeId === 'string' ? episodeId.trim() : '';
      if (!epId) {
        if (typeof callback === 'function') callback({ success: false, error: 'Episode ID required.' });
        return;
      }

      let code = generateRoomCode();
      while (rooms.has(code)) code = generateRoomCode();

      const displayName = await getUserDisplayName(userId);
      const hostPeer: Peer = {
        socketId: socket.id,
        userId,
        displayName,
        estimatedLatencyMs: 0,
        clockOffsetMs: 0,
        ntpSamples: 0,
        ready: false,
        buffering: false,
        lastReportedTime: 0,
        lastHeartbeatAt: Date.now(),
      };

      const room: Room = {
        code,
        episodeId: epId,
        hostSocketId: socket.id,
        hostUserId: userId,
        peers: new Map([[socket.id, hostPeer]]),
        currentTime: 0,
        isPlaying: false,
        gateOpen: false,
        playAfterGate: false,
        lastTimestampAt: Date.now(),
      };

      rooms.set(code, room);
      socket.join(code);
      (socket as any).roomCode = code;

      startDriftCheck(io, room);

      console.log(`[SyncPlay] Room ${code} created by ${userId} for episode ${epId}`);

      await supabase.from('watch_parties').insert({
        id: code, host_user_id: userId, episode_id: epId, status: 'active',
      }).then(({ error }) => { if (error) console.warn('[SyncPlay] DB insert:', error.message); });

      if (typeof callback === 'function') callback({ success: true, roomCode: code });
    });

    // ── joinRoom ──────────────────────────────────────────────────────────
    socket.on('joinRoom', async ({ roomCode }: { roomCode: string }, callback) => {
      const code = typeof roomCode === 'string' ? roomCode.trim().toUpperCase() : '';
      if (!code) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room code required.' });
        return;
      }

      const room = rooms.get(code);
      if (!room) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found.' });
        return;
      }

      const displayName = await getUserDisplayName(userId);
      const peer: Peer = {
        socketId: socket.id,
        userId,
        displayName,
        estimatedLatencyMs: 0,
        clockOffsetMs: 0,
        ntpSamples: 0,
        ready: false,
        buffering: false,
        lastReportedTime: 0,
        lastHeartbeatAt: Date.now(),
      };
      room.peers.set(socket.id, peer);
      socket.join(code);
      (socket as any).roomCode = code;

      await supabase.from('watch_party_participants').insert({
        party_id: code, user_id: userId, joined_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.warn('[SyncPlay] DB participant:', error.message); });

      const participantList = Array.from(
        new Map(Array.from(room.peers.values()).map(p => [p.userId, p]))
      ).map(([, p]) => ({ userId: p.userId, displayName: p.displayName }));

      socket.to(code).emit('peerJoined', {
        userId,
        displayName,
        participantCount: room.peers.size,
      });

      snapshotTime(room);
      const wasPlaying = room.isPlaying;

      if (typeof callback === 'function') {
        callback({
          success: true,
          episodeId: room.episodeId,
          currentTime: room.currentTime,
          isPlaying: false,        // gate will coordinate
          hostUserId: room.hostUserId,
          participantCount: room.peers.size,
          participants: participantList,
          sentAt: Date.now(),
        });
      }

      // Open gate so the new joiner buffers in sync with everyone else
      openGate(io, room, wasPlaying);
    });

    // ── play ──────────────────────────────────────────────────────────────
    socket.on('play', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;

      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
        room.currentTime = Math.max(0, currentTime);
      }
      room.lastTimestampAt = Date.now();

      // Solo host: play immediately, no gate needed
      if (room.peers.size === 1) {
        room.isPlaying = true;
        socket.emit('allReady', {
          currentTime: room.currentTime,
          scheduledPlayAt: Date.now() + 100,
          sentAt: Date.now(),
        });
        return;
      }

      openGate(io, room, true);
    });

    // ── pause ──────────────────────────────────────────────────────────────
    socket.on('pause', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;

      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      snapshotTime(room);
      if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
        room.currentTime = Math.max(0, currentTime);
      }
      room.isPlaying = false;
      room.lastTimestampAt = Date.now();

      // Cancel any open gate
      if (room.gateOpen) {
        room.gateOpen = false;
        room.playAfterGate = false;
        closeGateTimers(room);
      }

      socket.to(code).emit('pause', {
        currentTime: room.currentTime,
        fromUserId: userId,
        sentAt: Date.now(),
      });
    });

    // ── seek ───────────────────────────────────────────────────────────────
    socket.on('seek', ({ time }: { time: number }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;

      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can seek.' });
        return;
      }

      if (typeof time !== 'number' || !Number.isFinite(time)) return;
      const wasPlaying = room.isPlaying;
      room.currentTime = Math.max(0, time);
      room.lastTimestampAt = Date.now();

      if (room.peers.size === 1) {
        socket.emit('seek', { time: room.currentTime, sentAt: Date.now() });
        return;
      }

      openGate(io, room, wasPlaying);
    });

    // ── ready ──────────────────────────────────────────────────────────────
    socket.on('ready', async () => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;
      if (!room.gateOpen) return;

      const peer = room.peers.get(socket.id);
      if (!peer || peer.ready) return;

      peer.ready = true;
      peer.buffering = false;
      if (peer.forceReadyTimer) {
        clearTimeout(peer.forceReadyTimer);
        peer.forceReadyTimer = undefined;
      }

      const readyCount = countReady(room);
      io.to(code).emit('peerReady', {
        userId: peer.userId,
        displayName: peer.displayName,
        readyCount,
        totalPeers: room.peers.size,
      });

      console.log(`[SyncPlay] Room ${code}: ${peer.userId} ready (${readyCount}/${room.peers.size})`);
      tryCloseGate(io, room);
    });

    // ── buffering ──────────────────────────────────────────────────────────
    socket.on('buffering', async () => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;
      if (room.gateOpen) return;   // already handling it
      if (!room.isPlaying) return; // don't open gate for a paused room

      const peer = room.peers.get(socket.id);
      if (!peer || peer.buffering) return;
      peer.buffering = true;

      console.log(`[SyncPlay] Room ${code}: mid-stream buffer from ${peer.displayName}`);
      snapshotTime(room);
      openGate(io, room, true);
    });

    // ── heartbeat (drift detection) ────────────────────────────────────────
    // Each client sends this every ~3 s while playing
    socket.on('heartbeat', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;

      const peer = room.peers.get(socket.id);
      if (!peer) return;

      if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
        peer.lastReportedTime = currentTime;
      }
      peer.lastHeartbeatAt = Date.now();

      // Update room canonical time if this is the host
      if (room.hostSocketId === socket.id && room.isPlaying && !room.gateOpen) {
        room.currentTime = peer.lastReportedTime;
        room.lastTimestampAt = Date.now();
      }
    });

    // ── requestSync ────────────────────────────────────────────────────────
    socket.on('requestSync', () => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;

      socket.emit('sync', {
        currentTime: getCanonicalTime(room),
        isPlaying: room.isPlaying && !room.gateOpen,
        gateOpen: room.gateOpen,
        sentAt: Date.now(),
      });
    });

    // ── transferHost ────────────────────────────────────────────────────────
    socket.on('transferHost', async ({ targetUserId }: { targetUserId: string }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the current host can transfer control.' });
        return;
      }

      const targetEntry = Array.from(room.peers.entries())
        .find(([, p]) => p.userId === targetUserId);
      if (!targetEntry) {
        socket.emit('syncDenied', { reason: 'Target user is not in the room.' });
        return;
      }

      const [newSocketId, newPeer] = targetEntry;
      room.hostSocketId = newSocketId;
      room.hostUserId = targetUserId;
      io.to(code).emit('hostChanged', {
        newHostUserId: targetUserId,
        newHostDisplayName: newPeer.displayName,
      });
      console.log(`[SyncPlay] Room ${code}: host transferred → ${targetUserId}`);
    });

    // ── changeEpisode ───────────────────────────────────────────────────────
    socket.on('changeEpisode', ({ episodeId }: { episodeId: string }) => {
      const code = (socket as any).roomCode as string;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can change the episode.' });
        return;
      }

      room.episodeId = episodeId;
      room.currentTime = 0;
      room.isPlaying = false;
      room.gateOpen = false;
      room.playAfterGate = false;
      room.lastTimestampAt = Date.now();
      closeGateTimers(room);
      for (const p of room.peers.values()) { p.ready = false; p.buffering = false; }

      socket.to(code).emit('episodeChanged', { episodeId, sentAt: Date.now() });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const code = (socket as any).roomCode as string;
      if (!code) return;

      const room = rooms.get(code);
      if (!room) return;

      const peer = room.peers.get(socket.id);
      room.peers.delete(socket.id);

      if (room.peers.size === 0) {
        closeGateTimers(room);
        stopDriftCheck(room);
        rooms.delete(code);
        await markWatchPartyEndedByCode(code);
        console.log(`[SyncPlay] Room ${code} closed (empty).`);
        return;
      }

      // Promote new host if the host left
      if (room.hostSocketId === socket.id) {
        const [newSocketId, newPeer] = room.peers.entries().next().value as [string, Peer];
        room.hostSocketId = newSocketId;
        room.hostUserId = newPeer.userId;
        io.to(code).emit('hostChanged', {
          newHostUserId: newPeer.userId,
          newHostDisplayName: newPeer.displayName,
        });
        console.log(`[SyncPlay] Room ${code}: host promoted → ${newPeer.userId}`);
      }

      if (peer) {
        socket.to(code).emit('peerLeft', {
          userId: peer.userId,
          displayName: peer.displayName,
          participantCount: room.peers.size,
        });
      }

      // If gate was open and the leaver was blocking it, try to close
      if (room.gateOpen) tryCloseGate(io, room);

      console.log(`[SyncPlay] Disconnected: ${socket.id} (${userId})`);
    });
  });

  return io;
}
