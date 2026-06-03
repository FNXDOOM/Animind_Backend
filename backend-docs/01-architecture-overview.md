# Backend Architecture Overview

Animind Backend is a Node.js + Express + TypeScript server that delivers a personal anime streaming experience. It scans cloud or local storage, serves video with multiple streaming modes, and enables real-time watch parties (SyncPlay).

## Key Goals
1. **Dynamic Media Library** — Auto-scan storage, extract episode metadata, enrich with AniList/MyAnimeList
2. **Flexible Streaming** — Presigned URLs (S3), HTTP Range Requests (local), or HLS (local with audio track selection)
3. **Real-time Watch Parties** — Socket.IO-based SyncPlay with synchronized playback across users
4. **Multi-auth Support** — Supabase + Clerk + Google OAuth for maximum compatibility
5. **Audio/Subtitle Handling** — Extract and serve multiple audio tracks, support subtitle files

## Tech Stack
- **Language**: Node.js 20+ with TypeScript
- **Framework**: Express.js for REST APIs
- **Database**: Supabase (PostgreSQL with Supabase Auth)
- **Real-time**: Socket.IO for SyncPlay
- **Streaming**: HTTP Range Requests, S3 Presigned URLs, FFmpeg for HLS
- **Storage**: S3-compatible (R2, MinIO, Spaces) OR local VPS disk
- **Auth**: Supabase Auth + Clerk (desktop) + Google OAuth

## Core Services

### 1. Scanner Service (`src/services/scanner.service.ts`)
- **Purpose**: Discovers new anime files and maintains the library database
- **Trigger**: Cron schedule, manual rescan button, or S3 webhook
- **Process**:
  1. List objects from S3 bucket or local directory
  2. Parse filenames (e.g., `[Group] Show Title - 01 [1080p].mkv`)
  3. Upsert shows and episodes into Supabase
  4. Enrich metadata from AniList/MyAnimeList (optional)
  5. Prune missing episodes

### 2. Streaming Service (`src/services/stream.service.ts`)
- **Purpose**: Handle multiple video streaming modes based on storage type and client capability
- **Modes**:
  - **S3 Presigned URLs**: Direct redirect for cloud storage (bandwidth-efficient)
  - **HTTP 206 Range Requests**: Local storage with seeking support
  - **HLS Segments**: For non-browser-safe audio codecs or complex transcoding

### 3. HLS Session Service (`src/services/hlsSession.service.ts`)
- **Purpose**: Manage segmented streaming sessions for audio track selection
- **Features**:
  - On-demand transcoding of audio tracks to browser-safe codecs
  - Session-based playlist generation
  - Auto-cleanup of idle sessions
  - Cache management for pre-warmed audio variants

### 4. Audio Processing (`src/services/audioPrewarm.service.ts`)
- **Purpose**: Pre-process audio tracks for efficient streaming
- **Features**:
  - Extract and cache audio variant metadata
  - Identify browser-safe vs. non-safe codecs
  - Support copy (fast) or transcode modes

### 5. SyncPlay Socket Handler (`src/sockets/syncplay.handler.ts`)
- **Purpose**: Real-time watch party coordination
- **Events**:
  - `join-party`: Create or join a watch room
  - `play`, `pause`, `seek`: Broadcast playback commands
  - `leave-party`: Exit watch room
  - Auto-cleanup of abandoned rooms via cron

### 6. Authentication Services
- **Supabase Auth** (`src/controllers/auth.controller.ts`): Standard email/password + Google OAuth
- **Clerk Desktop Auth** (`src/controllers/desktopAuth.controller.ts`): Long-lived tokens for desktop clients
- **Admin Utilities**: User role management, content controls

## Request Flow

### Show Discovery (Frontend)
```
GET /api/shows
└─→ Express handler
    └─→ Supabase query (shows table)
        └─→ Return with metadata
```

### Video Playback (Frontend)
```
GET /api/episodes/:id/stream-ticket  (get signed ticket)
    └─→ Verify auth
        └─→ Create HMAC-signed ticket with expiry
            └─→ Return to frontend

GET /api/episodes/:id/stream?ticket=...  (fetch video)
    └─→ Verify ticket
        └─→ Determine streaming mode:
            ├─ S3: Generate presigned URL → 302 redirect
            ├─ Local: Stream with Range Request support
            └─ HLS: Create session, return playlist URL
```

### Watch Party (WebSocket)
```
User A: socket.emit('join-party', { episodeId, roomCode })
    ↓
Server: Create/find room, add participant
    ↓
Broadcast to Room: User A joined
    ↓
User B joins same room
    ↓
Both see real-time play/pause/seek events
```

## Environment Configuration

See `.env.example` for all options. Critical variables:
- **Storage**: `STORAGE_MODE` (s3 or local)
- **Supabase**: URLs and keys for database + auth
- **Clerk**: For desktop client support
- **Cron Schedules**: Scanner, SyncPlay cleanup, audio cache cleanup
- **HLS**: Segment duration, max concurrent sessions
- **Streaming**: Ticket TTL, range chunk size
