# SyncPlay Architecture (Watch Together)

To create a Plex-like SyncPlay experience, users need to be put into a shared state pool where their video player actions are synchronized.

## The WebSocket Server
We use **Socket.IO** attached to your Express backend. Unlike regular HTTP, WebSockets maintain an active, bidirectional connection.

## Flow of Syncing

1. **Creating a Room:**
   - User A (Host) clicks "Watch with Friends" on an episode.
   - Frontend connects to Socket Server: `socket.emit('createroom', { episodeId })`
   - Server generates a unique Room Code (e.g., `A4X9B`) and replies.
   
2. **Joining a Room:**
   - User B pastes the Room Code.
   - Frontend emits `socket.emit('joinroom', { roomCode })`.
   - Server adds User B to the Socket.IO room.

3. **Core Sync Logic (The Tricky Part):**
   - **Host Authority**: Only the Host should dictate the timeline to prevent chaotic skipping. (Alternatively, any user can pause/play, but usually, a host is better).
   - If User A pauses the video:
     - Frontend catches `<video onPause>` and emits `socket.emit('sync_pause')`
     - Server receives and broadcasts `socket.to(roomCode).emit('video_pause')`
     - User B's frontend catches it and forces `videoRef.current.pause()`.
   - If User A seeks to 12:00:
     - Frontend catches `<video onSeeked>` and emits `socket.emit('sync_seek', { time: 720 })`
     - User B receives it and runs `videoRef.current.currentTime = 720`.

4. **Buffering Thresholds:**
   - What happens if User B's internet is slow and buffers?
   - User B emits `socket.emit('buffering')`.
   - Server tells everyone else to pause until User B emits `socket.emit('ready_to_play')`.

## Example Socket Event Structure

```javascript
io.on('connection', (socket) => {
  socket.on('createroom', async ({ episodeId }) => { ... });
  socket.on('joinroom', ({ roomCode }) => { ... });

  // Playback Control
  socket.on('play', () => io.to(socket.roomId).emit('play'));
  socket.on('pause', () => io.to(socket.roomId).emit('pause'));
  socket.on('seek', (time) => io.to(socket.roomId).emit('seek', time));
});
```
