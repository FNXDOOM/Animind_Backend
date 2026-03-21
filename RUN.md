# Animind Backend — How to Run

This guide walks you through setting up, configuring, and running the Animind backend from scratch.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Project Structure](#2-project-structure)
3. [Step 1 — Clone & Install](#3-step-1--clone--install)
4. [Step 2 — Set Up Supabase](#4-step-2--set-up-supabase)
5. [Step 3 — Configure Storage](#5-step-3--configure-storage)
6. [Step 4 — Configure Environment Variables](#6-step-4--configure-environment-variables)
7. [Step 5 — Run Locally](#7-step-5--run-locally)
8. [Step 6 — Connect the Frontend](#8-step-6--connect-the-frontend)
9. [Step 7 — Deploy to Production](#9-step-7--deploy-to-production)
10. [API Reference](#10-api-reference)
11. [SyncPlay Socket Events](#11-syncplay-socket-events)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Use [nvm](https://github.com/nvm-sh/nvm) to manage versions |
| npm | 9+ | Comes with Node |
| Supabase account | — | [supabase.com](https://supabase.com) — same project as the frontend |
| Storage | — | Either an S3-compatible bucket **or** a local folder of video files |

---

## 2. Project Structure

```
animind-backend/
├── src/
│   ├── config/
│   │   ├── db.ts           # Supabase service-role client
│   │   └── env.ts          # Typed, validated environment variables
│   ├── controllers/
│   │   ├── show.controller.ts      # GET /api/shows, GET /api/shows/:id
│   │   ├── episode.controller.ts   # GET /api/episodes/:id/stream
│   │   ├── scanner.controller.ts   # POST /api/rescan + webhook
│   │   └── admin.controller.ts     # Admin-only endpoints
│   ├── middleware/
│   │   └── auth.middleware.ts      # Supabase JWT verification
│   ├── routes/
│   │   └── api.routes.ts           # All routes wired together
│   ├── services/
│   │   ├── scanner.service.ts      # S3/local file scanner + DB upserter
│   │   ├── stream.service.ts       # Presigned URL generator / local proxy
│   │   └── anilist.service.ts      # AniList GraphQL metadata fetcher
│   ├── sockets/
│   │   └── syncplay.handler.ts     # Socket.IO watch-party logic
│   ├── utils/
│   │   └── titleParser.ts          # Anime filename → title + episode parser
│   ├── app.ts              # Express app (CORS, routes, middleware)
│   └── server.ts           # Entry point (HTTP server + Socket.IO + cron)
├── supabase-schema.sql     # Run this once in Supabase SQL Editor
├── .env.example            # Template — copy to .env
├── package.json
└── tsconfig.json
```

---

## 3. Step 1 — Clone & Install

```bash
# Put the backend folder wherever you like
cd ~/projects
# (If you already have the folder, just cd into it)
cd animind-backend

npm install
```

---

## 4. Step 2 — Set Up Supabase

The backend uses the **same Supabase project** as the frontend.

### 4a. Run the schema migration

1. Open your Supabase project → **SQL Editor**
2. Paste the entire contents of `supabase-schema.sql`
3. Click **Run**

This creates:
- `profiles` — user accounts (auto-created on signup)
- `shows` — scanned anime library
- `episodes` — individual video files
- `watchlist` — already used by the frontend
- `progress` — playback progress (already used by the frontend)
- `watch_parties` + `watch_party_participants` — SyncPlay rooms

### 4b. Get your Service Role Key

1. Supabase Dashboard → **Project Settings** → **API**
2. Copy the **service_role** key (NOT the anon key)

> ⚠️ The service role key bypasses Row Level Security. **Never** expose it to the browser.
> The backend uses it server-side only.

---

## 5. Step 3 — Configure Storage

### Option A — S3-Compatible Bucket (Recommended)

Works with **Cloudflare R2**, **DigitalOcean Spaces**, **MinIO**, or **AWS S3**.

Your bucket folder structure should look like:

```
bucket/
  Frieren/
    [SubsPlease] Frieren - 01 (1080p).mkv
    [SubsPlease] Frieren - 02 (1080p).mkv
  Naruto Shippuden/
    Naruto Shippuden S01E01.mkv
```

The scanner reads the top-level folder name as the show title.

### Option B — Local VPS Folder

Put all videos in a single root folder (e.g., `/mnt/anime`):

```
/mnt/anime/
  Frieren/
    Frieren - 01.mkv
  Naruto/
    Naruto - 001.mkv
```

---

## 6. Step 4 — Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

```env
# Port the backend listens on
PORT=3001

# Your Vercel frontend URL (or localhost for dev)
FRONTEND_URL=https://your-animind.vercel.app

# Supabase — use service_role key here
SUPABASE_URL=https://xyz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# "s3" or "local"
STORAGE_MODE=s3

# S3 settings (only needed when STORAGE_MODE=s3)
S3_BUCKET_NAME=animind-videos
S3_REGION=auto
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret

# Local path (only needed when STORAGE_MODE=local)
LOCAL_STORAGE_PATH=/mnt/anime
```

---

## 7. Step 5 — Run Locally

### Development (with hot reload)

```bash
npm run dev
```

You should see:

```
🚀 Animind Backend running on port 3001
   Environment : development
   CORS origin : http://localhost:5173
   Storage mode: s3
   Health check: http://localhost:3001/health
```

### Production build

```bash
npm run build    # compiles TypeScript → dist/
npm start        # runs dist/server.js
```

### Verify it's working

```bash
curl http://localhost:3001/health
# → {"status":"ok","timestamp":"..."}

# Trigger a manual library scan
curl -X POST http://localhost:3001/api/rescan
# → [] (empty array until videos are scanned)
```

### Run automated tests

```bash
npm run test
```

Current test coverage includes:
- Route wiring and status responses (health, shows, rescan, auth/admin protected routes)
- Auth middleware behavior (missing/invalid token, valid token, admin guard)

---

## 8. Step 6 — Connect the Frontend

Add one variable to the **frontend's** `.env.local`:

```env
VITE_CLOUD_SERVER_URL=http://localhost:3001
```

For production, replace with your deployed backend URL:

```env
VITE_CLOUD_SERVER_URL=https://animind-backend.railway.app
```

The frontend already calls:
- `POST ${VITE_CLOUD_SERVER_URL}/api/rescan` — "Scan Cloud Storage" button
- `GET /api/episodes/:id/stream` — video player (needs auth header)

### Sending the auth token from the frontend

The stream endpoint requires a Bearer token. Update `VideoModal.tsx` to pass the Supabase session token:

```typescript
// In VideoModal.tsx — replace the hardcoded videoSrc with:
const [videoSrc, setVideoSrc] = useState('');

useEffect(() => {
  const fetchStreamUrl = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(
      `${import.meta.env.VITE_CLOUD_SERVER_URL}/api/episodes/${episodeId}/stream`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const data = await res.json();
    setVideoSrc(data.url); // presigned S3 URL or local stream URL
  };
  fetchStreamUrl();
}, [episodeId]);
```

---

## 9. Step 7 — Deploy to Production

### Option A — Railway (Easiest, recommended for S3 storage)

1. Push `animind-backend/` to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. In Railway → **Variables** tab, add all `.env` values
5. Railway auto-detects Node.js and runs `npm start`
6. Copy the public URL Railway provides → paste into `VITE_CLOUD_SERVER_URL` on Vercel

### Option B — VPS with PM2 (Required for local video storage)

```bash
# On your VPS (DigitalOcean, Hetzner, etc.)
git clone https://github.com/your/animind-backend.git
cd animind-backend
npm install
npm run build

# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start dist/server.js --name animind-backend
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

#### Nginx reverse proxy (optional but recommended)

```nginx
server {
    listen 80;
    server_name api.your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;

        # Required for Socket.IO / WebSockets
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

Then get an SSL cert:
```bash
sudo certbot --nginx -d api.your-domain.com
```

---

## 10. API Reference

All routes are prefixed with `/api`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Health check |
| GET | `/api/shows` | None | List all scanned shows |
| GET | `/api/shows/:id` | None | Show detail + episodes list |
| GET | `/api/episodes/:id/stream` | Bearer JWT | Get stream URL or stream file |
| POST | `/api/rescan` | None | Trigger manual library scan |
| POST | `/api/webhooks/storage` | Secret header | S3 event webhook |
| GET | `/api/admin/users` | Admin JWT | List all users |
| PATCH | `/api/admin/users/:id` | Admin JWT | Toggle admin flag |
| DELETE | `/api/admin/shows/:id` | Admin JWT | Delete a show |
| POST | `/api/admin/scan` | Admin JWT | Admin-triggered scan with stats |

### Example responses

**GET /api/shows**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Frieren",
      "synopsis": "A journey after the defeat...",
      "cover_image_url": "https://...",
      "genres": ["Adventure", "Fantasy"],
      "rating": 9.1,
      "episode_count": 28
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**GET /api/episodes/:id/stream** (S3 mode)
```json
{
  "url": "https://r2.cloudflarestorage.com/...?X-Amz-Signature=...",
  "expiresIn": 14400
}
```

---

## 11. SyncPlay Socket Events

Connect with:
```typescript
import { io } from 'socket.io-client';
const socket = io(VITE_CLOUD_SERVER_URL, {
  auth: { token: supabaseSession.access_token }
});
```

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `createRoom` | `{ episodeId }` | Create a new watch party |
| `joinRoom` | `{ roomCode }` | Join existing room |
| `play` | `{ currentTime }` | Broadcast play to room |
| `pause` | `{ currentTime }` | Broadcast pause to room |
| `seek` | `{ time }` | Broadcast seek position |
| `buffering` | — | Tell room you're buffering |
| `ready` | — | Tell room buffering is done |
| `requestSync` | — | Ask server for current state |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `createRoom` callback | `{ success, roomCode }` | Room created |
| `joinRoom` callback | `{ success, episodeId, currentTime, isPlaying, ... }` | Joined room state |
| `play` | `{ currentTime, fromUserId }` | Play command received |
| `pause` | `{ currentTime, fromUserId }` | Pause command received |
| `seek` | `{ time, fromUserId }` | Seek command received |
| `sync` | `{ currentTime, isPlaying }` | State sync response |
| `peerJoined` | `{ userId, participantCount }` | Someone joined |
| `peerLeft` | `{ userId, participantCount }` | Someone left |
| `peerBuffering` | `{ userId }` | Someone is buffering |
| `peerReady` | `{ userId }` | Someone resumed |
| `hostChanged` | `{ newHostUserId }` | Host transferred |

---

## 12. Troubleshooting

**"Missing required env variable: SUPABASE_URL"**
→ Make sure `.env` exists and is in the project root (not inside `src/`).

**CORS errors in the browser**
→ Set `FRONTEND_URL` in `.env` to exactly match your frontend origin (include `https://`, no trailing slash).

**Scanner finds 0 files**
→ Check `STORAGE_MODE`, bucket name, S3 credentials, and that video files have extensions in `VIDEO_EXTENSIONS`.

**"Episode not found" on stream**
→ The `episodes` table is empty — run a scan first via `POST /api/rescan`.

**WebSocket connection refused**
→ If behind Nginx, make sure the `Upgrade` and `Connection` headers are proxied (see Nginx config above).

**TypeScript build errors**
→ Run `npx tsc --noEmit` to see all errors. Most are caused by mismatched `@types/*` versions — delete `node_modules/` and run `npm install` again.
