# Streaming and REST APIs

Animind Backend provides REST APIs for:
- Show/episode discovery
- Video streaming in multiple modes
- User authentication and authorization
- Admin controls
- Socket.IO WebSocket for SyncPlay

## Library Endpoints

### `GET /api/shows` (Public)
Returns all shows with metadata.

**Query Parameters:**
- `limit` (default 50, max 200): Result count
- `offset` (default 0): Pagination offset

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Frieren: Beyond Journey's End",
      "synopsis": "...",
      "cover_image_url": "...",
      "genres": ["Adventure", "Fantasy"],
      "rating": 8.5,
      "episode_count": 28,
      "studio": "Madhouse",
      "status": "FINISHED",
      "year": "2023",
      "anilist_id": 154587,
      "trailer_id": "...",
      "trailer_site": "youtube"
    }
  ],
  "total": 125,
  "limit": 50,
  "offset": 0
}
```

### `GET /api/shows/:id` (Public)
Returns a show with its episodes organized by season.

**Response:**
```json
{
  "id": "uuid",
  "title": "Frieren",
  "episodes": [
    {
      "id": "uuid",
      "season_number": 1,
      "episode_number": 1,
      "content_type": "tv",
      "title": "The Journey's End",
      "duration": 1440,
      "created_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

## Streaming Endpoints

### Streaming Flow

1. **Get Stream Ticket** (Authenticated)
   ```
   GET /api/episodes/:id/stream-ticket
   ```
   Returns a signed, time-limited ticket for fetching the video.

2. **Fetch Stream** (Public with valid ticket)
   ```
   GET /api/episodes/:id/stream?ticket=...
   ```
   Returns video based on storage mode:
   - **S3**: HTTP 302 redirect to presigned URL
   - **Local**: HTTP 206 Range Request support for seeking

### `GET /api/episodes/:id/stream-ticket` (Authenticated)
Creates a signed ticket for video playback.

**Response:**
```json
{
  "ticket": "base64url-signed-ticket",
  "expiresAt": 1234567890
}
```

**Ticket Format:** HMAC-SHA256 signed payload containing:
- `episodeId`: UUID of episode
- `exp`: Expiration timestamp
- `cm`: Cache mode (`'n'` = native client, `'b'` = browser)
- `at`: Optional start time for resuming playback

### `GET /api/episodes/:id/stream` (Public with ticket)
Serves the video file.

**Query Parameters:**
- `ticket`: Signed ticket from `/stream-ticket`

**Storage Mode Behavior:**

**S3 Mode** (Presigned URLs):
- Validates ticket
- Generates AWS S3 presigned URL valid for 4 hours
- Returns 302 redirect or JSON with URL

**Local Mode** (HTTP Range Requests):
- Validates ticket
- Streams file with 206 Partial Content support
- Supports byte-range requests for seeking
- Chunk size: 8 MB (configurable via `STREAM_RANGE_CHUNK_MB`)
- Native clients: 32 MB chunks

**Example Request:**
```bash
# Desktop/web client
GET /api/episodes/{id}/stream?ticket=xxx
Range: bytes=0-8388607

# Response
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-8388607/total_size
Content-Length: 8388608
```

## HLS Streaming (Local Storage Only)

HLS streaming is used when:
- Storage mode is local
- User selects a non-browser-safe audio codec
- Need on-demand audio transcoding

### `POST /api/episodes/:id/hls-session` (Authenticated)
Creates an HLS streaming session.

**Request Body:**
```json
{
  "audioTrackIndex": 1,
  "startTime": 0
}
```

**Response:**
```json
{
  "sessionId": "uuid",
  "playlistUrl": "/api/hls/{sessionId}/playlist.m3u8"
}
```

### `GET /api/hls/:sessionId/playlist.m3u8` (Public)
Returns HLS master playlist.

### `GET /api/hls/:sessionId/:segment` (Public)
Serves individual HLS video segments.

### `POST /api/hls/:sessionId/seek` (Authenticated)
Seek to a specific time in the stream.

**Request Body:**
```json
{
  "time": 120.5
}
```

### `DELETE /api/hls/:sessionId` (Authenticated)
Destroys the HLS session and cleanup temporary files.

## Audio & Subtitle Endpoints

### `GET /api/episodes/:id/audio-tracks` (Authenticated)
Lists available audio tracks for an episode.

**Response:**
```json
{
  "tracks": [
    {
      "id": "track-0",
      "label": "Japanese",
      "language": "ja",
      "streamIndex": 0,
      "codec": "aac",
      "browserSupported": true,
      "cached": false
    },
    {
      "id": "track-1",
      "label": "English",
      "language": "en",
      "streamIndex": 1,
      "codec": "flac",
      "browserSupported": false,
      "cached": true,
      "cacheMode": "transcode"
    }
  ]
}
```

**Browser-Safe Codecs:** `aac`, `mp3`, `opus`, `vorbis`

### `GET /api/episodes/:id/subtitles` (Authenticated)
Lists available subtitle files for an episode.

**Response:**
```json
{
  "subtitles": [
    {
      "id": "sub-0",
      "label": "English",
      "language": "en",
      "format": "vtt"
    }
  ]
}
```

## Admin Endpoints

### `GET /api/admin/users` (Authenticated + Admin)
Lists all users and their admin status.

### `PATCH /api/admin/users/:id` (Authenticated + Admin)
Update user admin status.

**Request Body:**
```json
{
  "is_admin": true
}
```

### `DELETE /api/admin/shows/:id` (Authenticated + Admin)
Remove a show from the library.

### `POST /api/admin/scan` (Authenticated + Admin)
Trigger immediate library scan.

### `POST /api/rescan` (Authenticated + Admin)
Trigger library rescan with rate limiting (3 per minute).

## Authentication Endpoints

### `POST /api/auth/signup` (Public)
Create a new user account.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "secure-password",
  "username": "username"
}
```

**Response:**
```json
{
  "access_token": "jwt",
  "refresh_token": "jwt",
  "user": {
    "id": "uuid",
    "email": "user@example.com"
  }
}
```

### `POST /api/auth/login` (Public)
Login with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password"
}
```

### `GET /api/auth/google-url` (Public)
Get Google OAuth authentication URL.

**Query Parameters:**
- `mode`: `'signin'` or `'signup'`

**Response:**
```json
{
  "url": "https://supabase.../authorize?provider=google...",
  "mode": "signin"
}
```

### `POST /api/auth/desktop/exchange` (Public)
Exchange Clerk token for long-lived desktop session (native apps).

**Request Body:**
```json
{
  "clerkToken": "..."
}
```

**Response:**
```json
{
  "accessToken": "long-lived-jwt",
  "refreshToken": "refresh-jwt",
  "expiresIn": 900
}
```

### `POST /api/auth/desktop/refresh` (Public)
Refresh a desktop session.

### `POST /api/auth/desktop/revoke` (Public)
Revoke a desktop session.

## Webhook Endpoints

### `POST /api/webhooks/storage` (Public with secret)
S3 bucket event webhook for auto-scanning new uploads.

**Authentication:** `x-webhook-secret` header must match `WEBHOOK_SECRET` env

**Payload:** S3 Event Notification (standard format)

**Response:** HTTP 200 on successful scan trigger

## Health & Status

### `GET /health` (Public)
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:00:00.000Z"
}
```

## Error Responses

All endpoints return errors in standard format:

```json
{
  "error": "Human-readable error message"
}
```

Common status codes:
- `400`: Bad request (invalid parameters)
- `401`: Unauthorized (missing/invalid auth)
- `403`: Forbidden (insufficient permissions)
- `404`: Not found (resource doesn't exist)
- `429`: Rate limited (too many requests)
- `500`: Server error

## Rate Limiting

Public endpoints have IP-based rate limits:
- `/api/auth/signup`: 10 req/min
- `/api/auth/login`: 20 req/min
- `/api/rescan`: 3 req/min (admin only)
- `/api/webhooks/storage`: 30 req/min

## CORS Configuration

Backend allows requests from origins in `FRONTEND_URL` env (comma-separated).

```env
FRONTEND_URL=http://localhost:5173,https://yourdomain.com
```

Credentials allowed with `Content-Type`, `Authorization`, `x-webhook-secret` headers.
