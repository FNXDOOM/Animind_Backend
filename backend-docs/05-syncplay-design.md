# SyncPlay Architecture (Watch Together)

SyncPlay enables real-time synchronized video watching across multiple users using WebSocket connections. It maintains room state, synchronizes playback, and handles user presence.

## Overview

**Technology**: Socket.IO (WebSocket with fallback transport)
**Architecture**: Host-based authority model where room host controls timeline
**Database**: Supabase `watch_parties` and `watch_party_participants` tables
**Cleanup**: Auto-removal of ended rooms after `SYNCPLAY_ENDED_TTL_MINUTES`

## Room Lifecycle

### Creating a Room

**User Action**: Click "Watch with Friends" on an episode

**Frontend Emits:**
```javascript
socket.emit('create-party', {
  episodeId: 'episode-uuid',
  roomCode: 'optional-custom-code'
});
```

**Server Response:**
```javascript
socket.on('party-created', {
  roomId: 'unique-uuid',
  roomCode: 'A4X9B',
  episodeId: 'episode-uuid',
  participants: [{ userId, username, isHost: true }]
});
```

**Database Action:**
- Insert into `watch_parties` with `status='active'`
- Insert into `watch_party_participants` for host user

### Joining a Room

**User Action**: Enter room code or follow invite link

**Frontend Emits:**
```javascript
socket.emit('join-party', {
  roomCode: 'A4X9B'
});
```

**Server Actions:**
1. Lookup `watch_parties` by room code
2. Verify episode exists
3. Add user to `watch_party_participants`
4. Broadcast to all participants

**Server Broadcasts:**
```javascript
socket.to(roomCode).emit('user-joined', {
  userId,
  username,
  participantCount: 2
});
```

### Leaving a Room

**Frontend Emits:**
```javascript
socket.emit('leave-party');
```

**Server Actions:**
1. Remove from `watch_party_participants`
2. Broadcast to remaining participants
3. If all users left: Mark room as `status='ended'` for cleanup

## Playback Synchronization

### Host Authority Model

Only the **host** (room creator) can issue playback commands:
- Play
- Pause
- Seek

Other participants must wait for host commands and update their local player.

### Play Event

**Host Emits:**
```javascript
socket.emit('play', { time: 120.5 });
```

**Server Broadcasts:**
```javascript
socket.to(roomCode).emit('play', {
  time: 120.5,
  timestamp: Date.now()
});
```

**Guest Behavior:**
```javascript
socket.on('play', ({ time }) => {
  videoRef.current.currentTime = time;
  videoRef.current.play();
});
```

### Pause Event

**Host Emits:**
```javascript
socket.emit('pause', { time: 120.5 });
```

**Server Broadcasts:** Same pattern, all guests pause at same time.

### Seek Event

**Host Emits:**
```javascript
socket.emit('seek', { time: 300.0 });
```

**Guest Actions:**
1. Set `video.currentTime = 300.0`
2. Pause video while buffering (optional)
3. Resume when ready

## Buffering & Synchronization States

### Robust Sync Strategy

**Offset Tolerance**: ±2 seconds accepted before re-sync
**Heartbeat**: Optional ping/pong every 5 seconds to detect disconnects

### Guest Buffering

If a guest is slow to buffer:

**Guest Emits:**
```javascript
socket.emit('buffering');
```

**Server Actions:**
1. Store buffering state for this participant
2. Broadcast to host (optional): "Guest X is buffering"
3. Don't pause other guests automatically (let host decide)

**Guest Continues Emitting:**
```javascript
socket.emit('ready', { time: current_time });
```

## Connection Management

### Establishing Connection

**Frontend:**
```javascript
import io from 'socket.io-client';

const socket = io('https://api.yourdomain.com', {
  auth: {
    token: 'bearer-token-from-supabase'
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5
});
```

**Server Auth Check:**
- Verifies token validity
- Rejects unauthorized connections
- Stores user ID in socket data

### Disconnection Handling

**Graceful Disconnect:**
- Guest leaves room intentionally
- Server removes from participants
- Room ends if all users leave

**Abrupt Disconnect (Network Failure):**
- Socket disconnects after 60-second timeout
- Server marks participant as `last_heartbeat_at`
- After grace period (configurable): Remove participant
- If room empty: Mark as ended

**Reconnection:**
- Guest can rejoin same room within grace period
- Sync to current host playback state
- Resume watching from host's current position

## Database State

### watch_parties Table

| Column | Value | Purpose |
|--------|-------|---------|
| `id` | UUID | Room unique ID |
| `episode_id` | UUID | Episode being watched |
| `host_user_id` | UUID | User who created room |
| `status` | 'active' \| 'ended' | Room state |
| `created_at` | Timestamp | When room created |
| `ended_at` | Timestamp | When room ended |

### watch_party_participants Table

| Column | Value | Purpose |
|--------|-------|---------|
| `id` | UUID | Participant record ID |
| `party_id` | UUID | Which room |
| `user_id` | UUID | Which user |
| `joined_at` | Timestamp | When joined |
| `last_heartbeat_at` | Timestamp | Last activity |

## Cleanup & Maintenance

### Auto-Cleanup Job

**Schedule**: `SYNCPLAY_CLEANUP_CRON` (default: `0 */6 * * *` = every 6 hours)

**Action**:
1. Find `watch_parties` with `status='ended'` AND created > `SYNCPLAY_ENDED_TTL_MINUTES` ago
2. Delete associated participant records
3. Delete room record
4. Log cleanup summary

**Configuration:**
```env
SYNCPLAY_ENDED_CLEANUP_ENABLED=true
SYNCPLAY_ENDED_TTL_MINUTES=1440  # 24 hours
SYNCPLAY_CLEANUP_CRON=0 */6 * * *
```

### Startup Cleanup

On server startup, immediately run cleanup once to remove stale rooms from previous crashes.

## Event Reference

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `create-party` | `{ episodeId, roomCode? }` | Create watch room |
| `join-party` | `{ roomCode }` | Join existing room |
| `leave-party` | `{}` | Leave current room |
| `play` | `{ time }` | Start playback (host only) |
| `pause` | `{ time }` | Pause playback (host only) |
| `seek` | `{ time }` | Seek to time (host only) |
| `buffering` | `{}` | Signal buffering state |
| `ready` | `{ time }` | Signal ready to play |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `party-created` | Room data | Room created successfully |
| `party-joined` | Room data | User joined room |
| `user-joined` | `{ userId, username }` | Another user joined |
| `user-left` | `{ userId, participantCount }` | User left room |
| `play` | `{ time, timestamp }` | Host started playback |
| `pause` | `{ time, timestamp }` | Host paused |
| `seek` | `{ time, timestamp }` | Host seeked |
| `party-ended` | `{}` | Room was closed |
| `sync-error` | `{ message }` | Sync failed (re-connect) |

## Performance & Scaling

### Concurrent Sessions

**Default Limit**: `HLS_MAX_CONCURRENT_SESSIONS` for HLS, no hard limit for SyncPlay

**Recommendations**:
- Monitor CPU usage per Socket.IO connection (~1-2 MB per connection)
- For 100+ concurrent rooms: Consider multi-process clustering
- Use Redis adapter for Socket.IO to scale across multiple servers

### Message Throughput

- Play/pause events: < 50 bytes
- Seek events: < 50 bytes
- Heartbeats: 0-1 message per participant per 5 seconds
- Average room (2 users): ~1-5 KB/hour

## Testing & Debugging

### Enable Debug Logging

```env
DEBUG=socket.io:*
```

### Test Scenarios

1. **Two users create separate rooms**: Both should have independent playback
2. **User joins, then host pauses**: Guest should pause at same time
3. **Guest disconnects**: Guest auto-leaves room
4. **Room with 1 user, user leaves**: Room marked as ended
5. **Rapid seeks**: All guests sync to latest seek time

### Common Issues

- **Desync despite sync commands**: Check for network latency, may need offset tolerance
- **Ghost participants**: Check cleanup job is running
- **Memory leak**: Ensure disconnect handlers properly clean Socket.IO data
