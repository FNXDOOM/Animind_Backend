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
  participants: Map<string, string>; // socketId → userId
  currentTime: number;
  isPlaying: boolean;
  buffering: Set<string>; // socketIds currently buffering
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

      const room: Room = {
        code,
        episodeId: normalizedEpisodeId,
        hostSocketId: socket.id,
        hostUserId: userId,
        participants: new Map([[socket.id, userId]]),
        currentTime: 0,
        isPlaying: false,
        buffering: new Set(),
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
      // Broadcast to all except sender
      socket.to(code).emit('play', { currentTime, fromUserId: userId });
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
      socket.to(code).emit('pause', { currentTime, fromUserId: userId });
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
      socket.to(code).emit('seek', { time, fromUserId: userId });
    });

    // ── buffering ─────────────────────────────────────────────────────────────
    socket.on('buffering', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      room.buffering.add(socket.id);
      const displayName = await getUserDisplayName(userId);
      // Ask everyone to pause while someone is buffering
      io.to(code).emit('pause', { currentTime: room.currentTime, fromUserId: 'system', reason: 'buffering' });
      io.to(code).emit('peerBuffering', { userId, displayName });
    });

    // ── ready (buffering done) ────────────────────────────────────────────────
    socket.on('ready', async () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      room.buffering.delete(socket.id);
      const displayName = await getUserDisplayName(userId);
      io.to(code).emit('peerReady', { userId, displayName });

      // If no one is buffering anymore, resume
      if (room.buffering.size === 0 && room.isPlaying) {
        io.to(code).emit('play', { currentTime: room.currentTime, fromUserId: 'system' });
      }
    });

    // ── sync request (late joiner asks host for current time) ────────────────
    socket.on('requestSync', () => {
      const code = (socket as any).roomCode;
      const room = rooms.get(code);
      if (!room) return;

      socket.emit('sync', {
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
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

      if (room.participants.size === 0) {
        // Clean up empty room
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
