# AniMind Backend — Setup & Deployment Guide

**AniMind Backend** is a Node.js + Express server that enables cloud-hosted anime file streaming, watch parties (SyncPlay), and admin controls for personal anime libraries.

> ☁️ **S3 & Local Storage** — Scan and stream from Cloudflare R2, AWS S3, or local disk  
> 🔐 **Supabase Integration** — Unified auth and database with the frontend  
> 🎬 **Adaptive Streaming** — Presigned URLs or local HTTP proxy  
> 👥 **Watch Parties** — Real-time Socket.IO synchronized playback  
> 📡 **Webhooks** — Auto-scan when new files are added to storage  
> 🛡️ **Admin Panel** — Manage users, shows, and system settings  

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Project Structure](#2-project-structure)
3. [Installation](#3-installation)
4. [Supabase Setup](#4-supabase-setup)
5. [Storage Configuration](#5-storage-configuration)
6. [Environment Variables](#6-environment-variables)
7. [Running Locally](#7-running-locally)
8. [Connecting the Frontend](#8-connecting-the-frontend)
9. [API Reference](#9-api-reference)
10. [Socket.IO Events](#10-socketio-events)
11. [Production Deployment](#11-production-deployment)
12. [Docker Deployment](#12-docker-deployment)
13. [Troubleshooting](#13-troubleshooting)
14. [Database Migrations](#14-database-migrations)

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) — or use [nvm](https://github.com/nvm-sh/nvm) |
| **npm** | 9+ | Bundled with Node.js |
| **Supabase** | — | Same project as frontend — [supabase.com](https://supabase.com) |
| **Storage** | — | S3-compatible bucket **OR** local folder on VPS |
| **Git** | — | For cloning and version control |

**Optional but Recommended:**
- PM2 (for VPS auto-restart)
- Nginx (for reverse proxy / SSL on VPS)
- certbot (for free HTTPS certificates)

---

## 2. Project Structure

```
animind-backend/
├── src/
│   ├── config/
│   │   ├── db.ts               # Supabase service-role client setup
│   │   ├── env.ts              # Environment validation & typed config
│   │   └── index.ts            # Config exports
│   │
│   ├── controllers/            # HTTP request handlers
│   │   ├── show.controller.ts      # Shows: list & detail endpoints
│   │   ├── episode.controller.ts   # Episodes: stream endpoint
│   │   ├── scanner.controller.ts   # Library scan endpoints
│   │   ├── admin.controller.ts     # Admin: user & show management
│   │   └── auth.controller.ts      # Health check endpoint
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts      # JWT token verification (Supabase)
│   │   └── rateLimit.middleware.ts # Request rate limiting
│   │
│   ├── routes/
│   │   └── api.routes.ts           # All API routes wired together
│   │
│   ├── services/               # Business logic & external integrations
│   │   ├── scanner.service.ts      # S3/local file scanning + metadata
│   │   ├── stream.service.ts       # Presigned URL & local proxy
│   │   ├── anilist.service.ts      # AniList GraphQL queries
│   │   ├── audioPrewarm.service.ts # Audio codec prewarming
│   │   └── syncplayCleanup.service.ts # SyncPlay room cleanup
│   │
│   ├── sockets/
│   │   └── syncplay.handler.ts     # Socket.IO watch party logic
│   │
│   ├── utils/
│   │   └── titleParser.ts          # Parse filename → title + episode#
│   │
│   ├── scripts/
│   │   └── migrateSubtitles.ts    # One-time subtitle reorganization
│   │
│   ├── app.ts                  # Express app setup (CORS, routes)
│   ├── server.ts               # Entry point (HTTP + Socket.IO + cron)
│   └── types.ts                # TypeScript interfaces
│
├── tests/
│   ├── app.routes.test.ts      # Route and status tests
│   ├── auth.middleware.test.ts # Auth middleware tests
│   └── titleParser.test.ts     # Filename parsing tests
│
├── supabase-schema.sql         # Database schema (run once)
├── supabase-shows-dedupe-cleanup.sql # Optional: clean duplicate shows
├── supabase-episodes-season-migration.sql # Optional: season restructuring
├── supabase-syncplay-ttl-migration.sql # Optional: watch party cleanup
│
├── .env.example                # Configuration template
├── .dockerignore                # Files to exclude from Docker image
├── Dockerfile                  # Docker image definition
├── docker-compose.yml          # Docker Compose for multi-container setup
│
├── package.json
├── tsconfig.json
├── RUN.md                      # This file
└── DOCKER_VPS_README.md        # Detailed Docker deployment guide
```

---

## 3. Installation

### Clone or navigate to the backend folder

```powershell
# Windows
cd c:\Users\gudiy\Videos\anims\Backend\animind-backend

# Or if cloning fresh:
git clone https://github.com/your-repo/animind-backend.git
cd animind-backend
```

### Install dependencies

```powershell
npm install
```

You should see dependencies install including:
- `express` — Web framework
- `@supabase/supabase-js` — Database client
- `socket.io` — Real-time communication
- `@aws-sdk/client-s3` — S3 file operations
- `axios` — HTTP requests for AniList
- `node-cron` — Scheduled tasks

---

## 4. Supabase Setup

The backend shares the **same Supabase project** as the frontend.

### 4a: Create Database Tables

1. Open [supabase.com](https://supabase.com) in your browser
2. Go to your project → **SQL Editor** (left sidebar)
3. Click **+ New Query**
4. Paste the entire contents of `supabase-schema.sql` from this folder
5. Click **Run**

This creates:

```
✓ profiles (user metadata)
✓ shows (anime library entries)
✓ episodes (video files)
✓ watch_parties (SyncPlay rooms)
✓ watch_party_participants (room members)
✓ RLS policies (access controls)
```

### 4b: Get Your Service Role Key

1. Supabase Dashboard → **Project Settings** → **API** (left sidebar)
2. Look for **Project API Keys** section
3. Copy the **service_role** key (looks like `eyJ...`)

> ⚠️ **SECURITY WARNING**: This key bypasses Row-Level Security (RLS).  
> **NEVER** expose it to browsers or public clients. Use only on the backend server.

**You'll need this in Step 6 (Environment Variables).**

---

## 5. Storage Configuration

Choose **ONE** of these two options:

### Option A: S3-Compatible Storage (Recommended for Production)

Works with:
- **Cloudflare R2** (cheapest, recommended)
- **DigitalOcean Spaces**
- **Amazon S3**
- **MinIO** (self-hosted)

**Folder structure in your bucket:**

```
bucket-name/
├── Frieren/
│   ├── Frieren - 01.mkv
│   ├── Frieren - 02.mkv
│   └── Subtitles/
│       ├── Episode 01/
│       │   ├── English.vtt
│       │   └── Japanese.vtt
│       └── Episode 02/
│           └── English.vtt
│
├── Naruto Shippuden/
│   ├── Naruto Shippuden - 001.mkv
│   ├── Naruto Shippuden - 002.mkv
│   └── ...
│
└── [Other Shows]/
```

**Key points:**
- Top-level folder name = show title
- Video files directly in show folder
- Subtitles organized under `Subtitles/Episode XX/` (optional)

### Option B: Local VPS Storage (For Self-Hosted)

Store all videos in a single folder on your server:

```
/mnt/anime/
├── Frieren/
│   ├── Frieren - 01.mkv
│   ├── Frieren - 02.mkv
│   └── Subtitles/
│       ├── Episode 01/
│       │   └── English.vtt
│       └── ...
│
├── Naruto/
│   ├── Naruto - 001.mkv
│   └── ...
│
└── [Other Shows]/
```

**Key points:**
- Must be accessible locally (mounted drive or local folder)
- Backend reads files directly (no API calls)
- Faster for LAN streaming

---

## 6. Environment Variables

### Create the `.env` file

```powershell
cp .env.example .env
```

### Edit `.env` with your values

```env
# Server
PORT=3001
NODE_ENV=development

# Frontend CORS origin (adjust for your frontend URL)
FRONTEND_URL=http://localhost:5173

# Supabase (same as frontend project)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ0eXAiOiJKV1QiLCJhbGc...

# Storage mode: "s3" or "local"
STORAGE_MODE=s3

# S3 Configuration (only if STORAGE_MODE=s3)
S3_BUCKET_NAME=animind-videos
S3_REGION=auto
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=YOUR_R2_KEY_ID
S3_SECRET_ACCESS_KEY=YOUR_R2_SECRET

# Local Storage Configuration (only if STORAGE_MODE=local)
LOCAL_STORAGE_PATH=/mnt/anime

# Optional: Webhook secret for S3 auto-scan
S3_WEBHOOK_SECRET=your-secret-here

# Optional: AniList metadata enrichment
ANILIST_API_URL=https://graphql.anilist.co

# Optional: Admin user (set on first deployment for admin features)
ADMIN_USER_ID=uuid-of-admin-user
```

### Getting S3 Credentials (Cloudflare R2 example)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **R2** → **Create Bucket** → Name it `animind-videos`
3. **R2 Settings** → Scroll to **S3 API tokens**
4. **Create API Token** → Select bucket `animind-videos`
5. Copy:
   - Access Key ID → `S3_ACCESS_KEY_ID`
   - Secret Access Key → `S3_SECRET_ACCESS_KEY`
6. Find your Account ID in R2 Overview, construct endpoint:
   - `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

---

## 7. Running Locally

### Development Mode (with hot reload)

```powershell
npm run dev
```

Expected output:

```
🚀 Animind Backend
   Environment : development
   Port        : 3001
   CORS origin : http://localhost:5173
   Storage     : s3 (animind-videos bucket)
   Health URL  : http://localhost:3001/health
```

### Production Build

```powershell
# Compile TypeScript to JavaScript
npm run build

# Run the compiled version
npm start
```

### Verify the Backend is Working

```powershell
# Health check
curl http://localhost:3001/health
# Expected: {"status":"ok","timestamp":"2025-03-29T..."}

# List shows (will be empty until you scan)
curl http://localhost:3001/api/shows
# Expected: {"data":[],"total":0,"limit":50,"offset":0}

# Trigger a manual library scan
curl -X POST http://localhost:3001/api/rescan
# Scanner begins, responses with [] or shows found
```

### Test Coverage

```powershell
# Run all tests
npm run test

# Watch mode (re-run on file changes)
npm run test:watch
```

**Current tests cover:**
- Route wiring (all 200s)
- Auth middleware (token validation & admin guards)
- Filename parsing (title extraction from video names)

---

## 8. Connecting the Frontend

### Add Backend URL to Frontend `.env.local`

Open `animind---anime-version5/.env.local`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_CLOUD_SERVER_URL=http://localhost:3001
```

For production:

```env
VITE_CLOUD_SERVER_URL=https://your-backend-domain.com
```

### Update Frontend to Send Auth Token

The stream endpoint requires a Supabase JWT token in the `Authorization` header.

Edit `animind---anime-version5/services/cloudService.ts`:

```typescript
import supabase from './supabase';

export async function getStreamUrl(episodeId: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(
    `${import.meta.env.VITE_CLOUD_SERVER_URL}/api/episodes/${episodeId}/stream`,
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    }
  );

  if (!response.ok) throw new Error('Failed to get stream URL');
  
  const { url } = await response.json();
  return url;
}
```

### Frontend Features Unlocked

✅ **Cloud Shows Tab** — New menu item appears automatically  
✅ **Rescan Button** — Admin can trigger library scans from UI  
✅ **Stream Episodes** — Watch personal anime files  
✅ **Watch Parties** — Join synchronized viewing rooms (with SyncPlay)  

---

## 9. API Reference

All endpoints are prefixed with `/api`.

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/api/shows` | List all scanned shows (paginated) |
| GET | `/api/shows/:id` | Get show details + episodes |

### Protected Endpoints (Bearer JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/episodes/:id/stream` | Get stream URL (S3) or proxy file (local) |
| POST | `/api/rescan` | Trigger manual library scan |

### Admin Endpoints (Bearer JWT + is_admin=true)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all registered users |
| PATCH | `/api/admin/users/:id` | Toggle admin flag on user |
| DELETE | `/api/admin/shows/:id` | Delete a show from library |
| POST | `/api/admin/scan` | Trigger scan with detailed stats |

### Query Parameters

**GET /api/shows**
```
?limit=50&offset=0&search=Frieren&genre=Adventure&year=2024
```

**GET /api/episodes/:showId**
```
?sort=asc&include_subtitles=true
```

### Response Examples

**GET /api/shows**
```json
{
  "data": [
    {
      "id": "550e8400-a0df-41a3-a4b0-d1eec2d6a0e5",
      "title": "Frieren: Beyond Journey's End",
      "synopsis": "After defeating the demon king...",
      "anilist_id": 154587,
      "cover_image_url": "https://...",
      "banner_image_url": "https://...",
      "genres": ["Adventure", "Fantasy", "Drama"],
      "year": 2024,
      "season": "FALL",
      "rating": 9.1,
      "episode_count": 28,
      "status": "FINISHED"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**GET /api/episodes/:episodeId/stream (S3 mode)**
```json
{
  "url": "https://your-bucket.r2.cloudflarestorage.com/Frieren/Frieren%20-%2001.mkv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...",
  "expiresIn": 3600,
  "mimeType": "video/x-matroska"
}
```

**GET /api/episodes/:episodeId/stream (Local mode)**
```json
{
  "url": "http://localhost:3001/api/episodes/550e8400.../stream/proxy",
  "expiresIn": null,
  "mimeType": "video/x-matroska"
}
```

**Error Response**
```json
{
  "error": "Authentication required",
  "code": "UNAUTHORIZED",
  "statusCode": 401
}
```

---

## 10. Socket.IO Events

Use Socket.IO for watch parties (synchronized playback with friends).

### Client-Side Connect

```typescript
import { io } from 'socket.io-client';
import supabase from '@/services/supabase';

const { data: { session } } = await supabase.auth.getSession();

export const socket = io(import.meta.env.VITE_CLOUD_SERVER_URL, {
  auth: {
    token: session?.access_token,
  },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5,
});
```

### Room Events (Client → Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `createRoom` | `{ episodeId: string }` | Create a new watch party |
| `joinRoom` | `{ roomCode: string }` | Join existing watch party |
| `leaveRoom` | — | Leave current room |
| `play` | `{ currentTime: number }` | Broadcast play command |
| `pause` | `{ currentTime: number }` | Broadcast pause command |
| `seek` | `{ time: number }` | Broadcast seek to position |
| `buffering` | — | Notify room of buffering |
| `ready` | — | Notify room buffering complete |
| `requestSync` | — | Ask server for current state |

### Room Events (Server → Clients)

| Event | Payload | Description |
|-------|---------|-------------|
| `roomCreated` | `{ roomCode: string }` | Room created (callback) |
| `joinedRoom` | `{ episodeId, currentTime, isPlaying, participants }` | Successfully joined |
| `play` | `{ currentTime, fromUserId }` | Play broadcasted |
| `pause` | `{ currentTime, fromUserId }` | Pause broadcasted |
| `seek` | `{ time, fromUserId }` | Seek broadcasted |
| `sync` | `{ currentTime, isPlaying }` | State sync response |
| `peerJoined` | `{ userId, participantCount }` | User joined room |
| `peerLeft` | `{ userId, participantCount }` | User left room |
| `peerBuffering` | `{ userId }` | User is buffering |
| `peerReady` | `{ userId }` | User ready (unbuffered) |

### Example: Create a Watch Party

```typescript
socket.emit('createRoom', { episodeId: '550e8400-a0df-41a3-a4b0-d1eec2d6a0e5' }, (response) => {
  if (response.success) {
    console.log('Room code:', response.roomCode); // Share this with friends
  }
});

socket.on('roomCreated', ({ roomCode }) => {
  console.log('Watch party: ' + roomCode);
});
```

### Example: Join a Watch Party

```typescript
socket.emit('joinRoom', { roomCode: 'ABC123' }, (response) => {
  if (response.success) {
    console.log('Joined! Current time:', response.currentTime);
    console.log('Is playing:', response.isPlaying);
  }
});
```

---

## 11. Production Deployment

### Option A: Railway (Easiest, Recommended)

Railway auto-detects and deploys Node.js projects with zero configuration.

**Steps:**

1. Push backend to GitHub
2. Go to [railway.app](https://railway.app)
3. **New Project** → **Deploy from GitHub**
4. Select your repository
5. In **Variables** tab, add all `.env` values
6. Railway auto-runs `npm install` and `npm start`
7. Copy the public URL from **Deployments** tab

**Then update frontend:**

```env
VITE_CLOUD_SERVER_URL=https://your-railway-app.up.railway.app
```

Redeploy frontend to Vercel.

### Option B: VPS with PM2 (Required for Local File Storage)

For local file storage, you need a VPS with disk access (AWS EC2, DigitalOcean Droplet, Hetzner, etc.).

**1. SSH into your VPS**

```bash
ssh root@your-vps-ip
```

**2. Clone and install**

```bash
git clone https://github.com/your-repo/animind-backend.git
cd animind-backend
curl -fsSL https://nodejs.org/dist/v20.10.0/node-v20.10.0-linux-x64.tar.xz | tar xJ -C /usr/local --strip-components=1
npm install
npm run build
```

**3. Install PM2**

```bash
npm install -g pm2
```

**4. Configure environment**

```bash
cp .env.example .env
nano .env  # edit with your values
```

**5. Start with PM2**

```bash
pm2 start dist/server.js --name animind-backend
pm2 save          # Save PM2 process list
pm2 startup       # Auto-start on reboot (follow printed instructions)
```

**6. Enable HTTPS with Nginx + Certbot**

Install Nginx:
```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/animind`:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

Enable and get SSL:

```bash
sudo ln -s /etc/nginx/sites-available/animind /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl start nginx
sudo certbot --nginx -d api.yourdomain.com
```

Certbot auto-upgrades your Nginx config to HTTPS.

**Then update frontend:**

```env
VITE_CLOUD_SERVER_URL=https://api.yourdomain.com
```

---

## 12. Docker Deployment

Deploy backend + database in Docker containers (even easier on VPS).

### Using Docker Compose

```bash
cp .env.example .env
# Edit .env with your settings first
docker compose build
docker compose up -d
docker compose logs -f
```

This starts:
- Backend on port 3001
- Nginx reverse proxy on port 80 (with auto-HTTPS if configured)

**Full Docker guide:** See `DOCKER_VPS_README.md`

---

## 13. Troubleshooting

### Backend won't start: "Cannot find module..."

```bash
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### "Missing required env variable: SUPABASE_URL"

- Verify `.env` exists in project root
- Check all required variables are set
- Run: `node -e "require('dotenv').config(); console.log(process.env.SUPABASE_URL)"`

### CORS errors in browser

```
Access-Control-Allow-Origin header missing from response.
```

**Fix:** Update `FRONTEND_URL` in `.env` to exact frontend origin:

```env
FRONTEND_URL=https://your-frontend.vercel.app
# NOT: https://your-frontend.vercel.app/   (no trailing slash)
```

### Scanner finds 0 files

1. Check `STORAGE_MODE` is correct (`s3` or `local`)
2. If S3: verify bucket name, region, credentials
3. If local: verify `LOCAL_STORAGE_PATH` exists and is readable
4. Run: `curl -X POST http://localhost:3001/api/rescan`
5. Check logs for detailed error

### "Episode not found" error when streaming

- Episodes table is empty
- Run scan first: `POST /api/rescan`
- Wait for scan to  complete
- Verify files are in correct folder structure

### Socket.IO connection refused

- If behind Nginx, ensure `Upgrade` header is proxied (see Nginx config above)
- Check frontend has correct `VITE_CLOUD_SERVER_URL`
- Verify backend port 3001 is accessible from browser

### Port 3001 already in use

```bash
# Find what's using port 3001
sudo lsof -i :3001

# Kill the process
sudo kill -9 <PID>

# Or use a different port
PORT=3002 npm run dev
```

### TypeScript build errors

```bash
npx tsc --noEmit
npm install
npm run build
```

---

## 14. Database Migrations

### Migrate Existing Subtitles Folder Structure

If you previously had subtitle files next to videos:

```
Show/
  Show - 01 [English].vtt
  Show - 01 [Japanese].vtt
  Show - 02 [English].vtt
```

You can reorganize them to the new structure:

```
Show/
  Subtitles/
    Episode 01/
      English.vtt
      Japanese.vtt
    Episode 02/
      English.vtt
```

**Dry-run first (no changes):**

```bash
npm run migrate:subtitles
```

**Apply changes:**

```bash
npm run migrate:subtitles:apply
```

Then run a rescan to extract subtitles with the new folder layout.

### Optional: Deduplicate Shows

If you have duplicate show entries after scanning:

```bash
# Preview changes
cat supabase-shows-dedupe-cleanup.sql

# Run in Supabase SQL Editor
# Paste and execute to merge duplicates
```

---

## Environment Cheat Sheet

**Development (Local)**
```env
STORAGE_MODE=local
LOCAL_STORAGE_PATH=/mnt/anime
FRONTEND_URL=http://localhost:5173
PORT=3001
NODE_ENV=development
```

**Production (S3)**
```env
STORAGE_MODE=s3
S3_BUCKET_NAME=animind-videos
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<KEY>
S3_SECRET_ACCESS_KEY=<SECRET>
FRONTEND_URL=https://your-frontend.vercel.app
PORT=3001
NODE_ENV=production
```

**Production (Local VPS)**
```env
STORAGE_MODE=local
LOCAL_STORAGE_PATH=/mnt/anime
FRONTEND_URL=https://your-frontend.vercel.app
PORT=3001
NODE_ENV=production
```

---

## Next Steps

1. ✅ Install dependencies → `npm install`
2. ✅ Set up Supabase → Run `supabase-schema.sql`
3. ✅ Configure storage → S3 bucket or local folder
4. ✅ Create `.env` file → Copy from `.env.example`
5. ✅ Run locally → `npm run dev`
6. ✅ Connect frontend → Set `VITE_CLOUD_SERVER_URL`
7. ✅ Deploy → Railway, VPS, or Docker

For additional help, check the backend docs folder or DOCKER_VPS_README.md.
