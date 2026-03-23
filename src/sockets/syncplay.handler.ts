/**
 * syncplay.handler.ts
 *
 * Real-time watch-party (SyncPlay) using Socket.IO.
 * Room lifecycle: createRoom → joinRoom → play/pause/seek → leaveRoom
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
  buffering: Set<string>;              // socketIds currently buffering
  bufferingTimers: Map<string, ReturnType<typeof setTimeout>>; // socketId → force-resume timer
}

// ── In-memory room store ─────────────────────────────────────────────────────
const rooms = new Map<string, Room>();
const userDisplayNameCache = new Map<string, string>();
const SYNCPLAY_SOCKET_PATH = '/api/socket.io';

async function closeStaleActiveWatchParties(): Promise<void> {
  const { error } = await supabase
    .from('watch_parties')
    .update({ status: 'ended' })
    .eq('status', 'active');

  if (error) {
    console.warn('[SyncPlay] Failed to close stale active watch parties:', error.message);
    return;
  }

  console.log('[SyncPlay] Closed stale active watch parties from previous server sessions.');
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
        buffering: new Set(),
        bufferingTimers: new Map(),
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
          isPlaying: room.isPlaying,
          hostUserId: room.hostUserId,
          participantCount: room.participants.size,
          participants: participantList,
          sentAt: Date.now(),
        });
      }
    });

    // ── play ──────────────────────────────────────────────────────────────────
    socket.on('play', ({ currentTime }: { currentTime: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      room.isPlaying = true;
      room.currentTime = currentTime;
      // Broadcast to all except sender — include sentAt for client-side latency compensation
      socket.to(code).emit('play', { currentTime, fromUserId: userId, sentAt: Date.now() });
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
      socket.to(code).emit('pause', { currentTime, fromUserId: userId, sentAt: Date.now() });
    });

    // ── seek ──────────────────────────────────────────────────────────────────
    socket.on('seek', ({ time }: { time: number }) => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostSocketId !== socket.id) {
        socket.emit('syncDenied', { reason: 'Only the host can control playback.' });
        return;
      }

      room.currentTime = time;
      socket.to(code).emit('seek', { time, fromUserId: userId, sentAt: Date.now() });
    });

    // ── buffering ─────────────────────────────────────────────────────────────
    socket.on('buffering', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Idempotent — ignore if already registered as buffering
      if (room.buffering.has(socket.id)) return;
      room.buffering.add(socket.id);

      const displayName = await getUserDisplayName(userId);

      // Only pause OTHER peers — NOT the host.
      socket.to(code).emit('pause', { currentTime: room.currentTime, fromUserId: 'system', reason: 'buffering', sentAt: Date.now() });
      io.to(code).emit('peerBuffering', { userId, displayName });

      // Force-resume after 30s so one slow peer can't block the whole room
      const forceTimer = setTimeout(async () => {
        if (!room.buffering.has(socket.id)) return; // already resolved
        room.buffering.delete(socket.id);
        room.bufferingTimers.delete(socket.id);
        const dn = await getUserDisplayName(userId);
        io.to(code).emit('peerReady', { userId, displayName: dn, timedOut: true });
        if (room.buffering.size === 0 && room.isPlaying) {
          io.to(code).emit('play', { currentTime: room.currentTime, fromUserId: 'system', sentAt: Date.now() });
        }
      }, 30_000);
      room.bufferingTimers.set(socket.id, forceTimer);
    });

    // ── ready (buffering done) ────────────────────────────────────────────────
    socket.on('ready', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      // Idempotent — ignore if this socket wasn't buffering
      if (!room.buffering.has(socket.id)) return;
      room.buffering.delete(socket.id);

      // Cancel the 30s force-resume timer since they recovered naturally
      const timer = room.bufferingTimers.get(socket.id);
      if (timer) { clearTimeout(timer); room.bufferingTimers.delete(socket.id); }

      const displayName = await getUserDisplayName(userId);
      io.to(code).emit('peerReady', { userId, displayName });

      // Resume only when ALL peers are ready
      if (room.buffering.size === 0 && room.isPlaying) {
        io.to(code).emit('play', { currentTime: room.currentTime, fromUserId: 'system', sentAt: Date.now() });
      }
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

      // Find the target’s socket id
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
      // Clear all buffering state — new episode means fresh start
      room.bufferingTimers.forEach(t => clearTimeout(t));
      room.bufferingTimers.clear();
      room.buffering.clear();

      socket.to(code).emit('episodeChanged', { episodeId, sentAt: Date.now() });
      console.log(`[SyncPlay] Room ${code} episode changed to ${episodeId} by host ${userId}`);
    });

    // ── NTP-style clock sync ping/pong ────────────────────────────────────────
    // Client sends { clientSendTime } → server echoes back { clientSendTime, serverTime }.
    // Client computes:
    //   roundTrip     = Date.now() - clientSendTime
    //   oneWayLatency = roundTrip / 2
    //   clockOffset   = serverTime - (clientSendTime + oneWayLatency)
    // After TIMESYNC_SAMPLES rounds, client takes the median clockOffset and
    // uses it to correct all sentAt timestamps, eliminating clock-skew error.
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
      room.buffering.delete(socket.id);
      const bt = room.bufferingTimers.get(socket.id);
      if (bt) { clearTimeout(bt); room.bufferingTimers.delete(socket.id); }

      if (room.participants.size === 0) {
        // Clean up empty room — clear all remaining timers first
        room.bufferingTimers.forEach(t => clearTimeout(t));
        rooms.delete(code);
        const { error } = await supabase.from('watch_parties').update({ status: 'ended' }).eq('id', code);
        if (error) {
          console.warn(`[SyncPlay] Failed to mark room ${code} as ended:`, error.message);
        }
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
      }

      console.log(`[SyncPlay] Disconnected: ${socket.id} (user: ${userId})`);
    });
  });

  return io;
}
