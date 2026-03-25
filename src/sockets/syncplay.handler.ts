/**
 * syncplay.handler.ts
 *
 * Real-time watch-party (SyncPlay) using Socket.IO.
 * Room lifecycle: createRoom → joinRoom → play/pause/seek → leaveRoom
 *
 * Implements a Plex-style "Readiness Gate":
 *   Playback is HELD until every peer in the room reports their video is
 *   buffered and ready.  This eliminates desyncs caused by one side buffering
 *   while the other plays ahead.
 *
 * Room state is kept in-memory. For multi-process deployments, replace the
 * `rooms` Map with a Redis adapter: https://socket.io/docs/v4/redis-adapter/
 */

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Room {
  code: string;
  episodeId: string;
  hostSocketId: string;
  hostUserId: string;
  participants: Map<string, string>;   // socketId → userId
  displayNames: Map<string, string>;   // userId  → displayName
  currentTime: number;
  isPlaying: boolean;
  /** Plex-style readiness gate: socketIds that have confirmed video is buffered */
  readyPeers: Set<string>;
  /** Whether the room is currently waiting for all peers to report ready */
  waitingForReady: boolean;
  /** Saved play intent so we know to auto-play once all peers are ready */
  playIntentAfterReady: boolean;
  /** Safety-net force-resume timers (per socket) */
  readyTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// ── In-memory room store ─────────────────────────────────────────────────────
const rooms = new Map<string, Room>();
const userDisplayNameCache = new Map<string, string>();
const SYNCPLAY_SOCKET_PATH = '/api/socket.io';
const READY_TIMEOUT_MS = 30_000; // force-resume after 30s if a peer never reports ready
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

// ── Readiness gate helpers ───────────────────────────────────────────────────

/**
 * Initiate a readiness gate: pause everyone, clear ready states, ask all
 * peers to buffer at `room.currentTime` and report back `ready`.
 */
function initiateReadinessGate(
  io: SocketServer,
  room: Room,
  playAfterReady: boolean,
): void {
  // Clear previous timers
  room.readyTimers.forEach(t => clearTimeout(t));
  room.readyTimers.clear();

  room.readyPeers.clear();
  room.waitingForReady = true;
  room.playIntentAfterReady = playAfterReady;
  room.isPlaying = false;

  const readyList = Array.from(room.participants.entries()).map(([sid, uid]) => ({
    socketId: sid,
    userId: uid,
    displayName: room.displayNames.get(uid) ?? uid.slice(0, 8),
    ready: false,
  }));

  io.to(room.code).emit('waitForReady', {
    currentTime: room.currentTime,
    peers: readyList,
    totalPeers: room.participants.size,
    readyCount: 0,
    sentAt: Date.now(),
  });

  console.log(`[SyncPlay] Room ${room.code}: readiness gate opened (${room.participants.size} peers, playAfter=${playAfterReady})`);

  // Set up force-resume timers per peer
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
        currentTime: 0,
        isPlaying: false,
        readyPeers: new Set(),
        waitingForReady: false,
        playIntentAfterReady: false,
        readyTimers: new Map(),
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
          isPlaying: false, // Always false — readiness gate will coordinate start
          hostUserId: room.hostUserId,
          participantCount: room.participants.size,
          participants: participantList,
          sentAt: Date.now(),
        });
      }

      // ── Plex-style: new joiner triggers readiness gate ──
      // Pause everyone and wait for ALL peers (including new joiner) to buffer
      const wasPlaying = room.isPlaying;
      room.isPlaying = false;
      initiateReadinessGate(io, room, wasPlaying);
    });

    // ── play (host-initiated → readiness gate) ───────────────────────────────
    socket.on('play', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      room.currentTime = currentTime;

      // If there's only one peer (host alone), skip the gate — play immediately
      if (room.participants.size === 1) {
        room.isPlaying = true;
        socket.emit('syncPlay', { currentTime, sentAt: Date.now() });
        return;
      }

      // Multiple peers: initiate readiness gate — everyone must buffer then report ready
      initiateReadinessGate(io, room, true);
    });

    // ── pause ─────────────────────────────────────────────────────────────────
    socket.on('pause', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      room.isPlaying = false;
      room.currentTime = currentTime;

      // Cancel any pending readiness gate
      if (room.waitingForReady) {
        room.waitingForReady = false;
        room.playIntentAfterReady = false;
        room.readyTimers.forEach(t => clearTimeout(t));
        room.readyTimers.clear();
        room.readyPeers.clear();
      }

      socket.to(code).emit('pause', { currentTime, fromUserId: userId, sentAt: Date.now() });
    });

    // ── seek (host-initiated → readiness gate) ───────────────────────────────
    socket.on('seek', ({ time }: { time: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      const wasPlaying = room.isPlaying;
      room.currentTime = time;

      // If alone, just broadcast seek directly
      if (room.participants.size === 1) {
        socket.emit('seek', { time, fromUserId: userId, sentAt: Date.now() });
        return;
      }

      // Multiple peers: seek causes a readiness gate so everyone re-buffers
      initiateReadinessGate(io, room, wasPlaying);
    });

    // ── ready (peer reports video is buffered and ready to play) ──────────────
    socket.on('ready', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Ignore if not in a readiness gate or already marked ready
      if (!room.waitingForReady) return;
      if (room.readyPeers.has(socket.id)) return;

      room.readyPeers.add(socket.id);

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

    // ── buffering (mid-stream stall — safety net) ────────────────────────────
    // If a peer's video stalls during active playback (e.g. network congestion),
    // trigger a readiness gate so everyone pauses and waits.  Ignored if a gate
    // is already open (join/play/seek already handling it).
    socket.on('buffering', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Already in a readiness gate — no need to open another one
      if (room.waitingForReady) return;

      // Only matters if the room was actively playing
      if (!room.isPlaying) return;

      const displayName = await getUserDisplayName(userId);
      console.log(`[SyncPlay] Room ${code}: mid-stream buffering from ${displayName} — opening readiness gate`);

      // Save current time from the server's perspective
      // (client may be slightly behind; server time is canonical)
      initiateReadinessGate(io, room, true /* resume play after all ready */);
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
      const bt = room.readyTimers.get(socket.id);
      if (bt) { clearTimeout(bt); room.readyTimers.delete(socket.id); }

      if (room.participants.size === 0) {
        // Clean up empty room — clear all remaining timers first
        room.readyTimers.forEach(t => clearTimeout(t));
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

        // If a peer left during a readiness gate, check if remaining peers are all ready
        if (room.waitingForReady) {
          tryResumeAfterReady(io, room);
        }
      }

      console.log(`[SyncPlay] Disconnected: ${socket.id} (user: ${userId})`);
    });
  });

  return io;
}
