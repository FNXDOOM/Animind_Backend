# Deployment & Architecture Guide

## Hosting Strategy

### Separate Frontend & Backend

**Frontend** (Vercel/Netlify):
- React + TypeScript + Vite
- Executes in user's browser
- Static site deployment
- No persistent state needed

**Backend** (VPS/PaaS):
- Node.js + Express + TypeScript
- Requires persistent connections for:
  - Socket.IO WebSocket (SyncPlay)
  - Long-running scan jobs (Cron)
  - Streaming video (if local storage mode)
- Typical uptime: 99.5%+

### Why Not Serverless?

Serverless (Vercel/Netlify Functions) kills connections after 10-60 seconds:
- ✗ Breaks WebSocket/SyncPlay
- ✗ Interrupts video streams
- ✗ Cannot run background jobs (Scanner Cron)

### Recommended Hosting Providers

**VPS (Best for Local Storage):**
- DigitalOcean Droplet ($5-12/month)
- Hetzner Cloud ($3-5/month)
- AWS EC2 (pay-as-you-go)
- Benefits: Full server control, video files stored locally

**Container PaaS (Best for S3 Storage):**
- Railway.app
- Render.app
- Fly.io
- Benefits: Simple deployment, auto-scaling, lighter server needs

## Current Project Structure

```
animind-backend/
├── src/
│   ├── app.ts                 # Express setup (CORS, routes, middleware)
│   ├── server.ts              # Entry point (HTTP + Socket.IO + Cron jobs)
│   │
│   ├── config/
│   │   ├── db.ts              # Supabase client initialization
│   │   ├── env.ts             # Environment validation & typed config
│   │   └── index.ts           # Config exports
│   │
│   ├── controllers/           # HTTP request handlers
│   │   ├── show.controller.ts
│   │   ├── episode.controller.ts
│   │   ├── hls.controller.ts
│   │   ├── scanner.controller.ts
│   │   ├── admin.controller.ts
│   │   ├── auth.controller.ts
│   │   ├── desktopAuth.controller.ts
│   │   └── account.controller.ts
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts
│   │   └── rateLimit.middleware.ts
│   │
│   ├── routes/
│   │   └── api.routes.ts      # All API routes
│   │
│   ├── services/              # Business logic & integrations
│   │   ├── scanner.service.ts
│   │   ├── stream.service.ts
│   │   ├── hlsSession.service.ts
│   │   ├── audioPrewarm.service.ts
│   │   ├── syncplayCleanup.service.ts
│   │   ├── desktopAuth.service.ts
│   │   ├── desktopAuthCleanup.service.ts
│   │   ├── anilist.service.ts
│   │   ├── myanimelist.service.ts
│   │   ├── animeMetadata.service.ts
│   │   ├── openrouterScanner.service.ts
│   │   └── audioCacheCleanup.service.ts
│   │
│   ├── sockets/
│   │   └── syncplay.handler.ts
│   │
│   ├── utils/
│   │   └── titleParser.ts
│   │
│   └── scripts/
│       └── migrateSubtitles.ts
│
├── tests/
│   ├── app.routes.test.ts
│   ├── auth.middleware.test.ts
│   └── titleParser.test.ts
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── RUN.md
```

## Request Flow

### Show Discovery
```
Browser: GET /api/shows
  ↓
Express Router
  ↓
show.controller.ts (getShows)
  ↓
Supabase: SELECT * FROM shows
  ↓
Response to frontend
```

### Video Streaming (Local Storage)
```
Browser: GET /api/episodes/:id/stream-ticket
  ↓
episode.controller.ts (getEpisodeStreamTicket)
  ↓
Create HMAC-signed ticket with TTL
  ↓
Browser: GET /api/episodes/:id/stream?ticket=xxx
  ↓
Validate ticket
  ↓
Open file from LOCAL_STORAGE_PATH
  ↓
Stream with Range Request support (206 Partial Content)
```

### Video Streaming (S3 Storage)
```
Browser: GET /api/episodes/:id/stream-ticket
  ↓
Create ticket
  ↓
Browser: GET /api/episodes/:id/stream?ticket=xxx
  ↓
Validate ticket
  ↓
Generate S3 presigned URL
  ↓
HTTP 302 redirect to S3 URL
```

### Library Scanner (Cron)
```
Server startup OR Cron tick (every 6 hours)
  ↓
scanner.service.ts (runScan)
  ↓
List files from S3/Local
  ↓
Parse filenames (titleParser.ts)
  ↓
Fetch metadata (AniList → MAL → OpenRouter fallback)
  ↓
Upsert shows & episodes to Supabase
  ↓
Prune offline episodes
```

### SyncPlay (Watch Together)
```
Frontend: socket.connect()
  ↓
syncplay.handler.ts (onConnection)
  ↓
Verify auth token
  ↓
Frontend: socket.emit('join-party', { roomCode })
  ↓
Create/lookup watch_parties room
  ↓
Add to watch_party_participants
  ↓
Host: socket.emit('play', { time })
  ↓
Broadcast to room participants
  ↓
Guests: Update video.currentTime and play()
```

### Background Cleanup Jobs

**Server startup (server.ts):**
1. Initialize Scanner cron (if `SCANNER_CRON` valid)
2. Initialize SyncPlay cleanup cron (if `SYNCPLAY_ENDED_CLEANUP_ENABLED`)
3. Initialize Audio cache cleanup cron (if `AUDIO_CACHE_VARIANT_CLEANUP_ENABLED`)
4. Initialize Desktop auth cleanup cron (if `DESKTOP_AUTH_CLEANUP_ENABLED`)

## Service Responsibilities

| Service | Purpose | Triggers |
|---------|---------|----------|
| scanner.service.ts | Discover files, parse names, enrich metadata | Cron, webhook, manual |
| stream.service.ts | Determine streaming mode (S3/local/HLS) | GET /stream |
| hlsSession.service.ts | Create/manage HLS segments, transcode audio | POST /hls-session |
| audioPrewarm.service.ts | Analyze & cache audio tracks | Scanner, on-demand |
| syncplayCleanup.service.ts | Remove ended watch rooms | Cron |
| audioCacheCleanup.service.ts | Prune old audio variant cache | Cron |
| desktopAuthCleanup.service.ts | Remove expired desktop tokens | Cron |
| anilist.service.ts | Fetch show metadata from AniList | Scanner |
| myanimelist.service.ts | Fallback metadata from MyAnimeList | Scanner |
| openrouterScanner.service.ts | AI-powered filename disambiguation | Scanner |

## Environment Configuration

See `.env.example` for complete reference. Critical sections:

**Server:**
```env
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://yourdomain.com
```

**Database:**
```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx
```

**Storage (pick ONE):**
```env
# Option A: S3/Cloudflare R2
STORAGE_MODE=s3
S3_BUCKET_NAME=xxx
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx

# Option B: Local VPS
STORAGE_MODE=local
LOCAL_STORAGE_PATH=/mnt/anime
```

**Cron Jobs:**
```env
SCANNER_CRON=0 */6 * * *
SYNCPLAY_CLEANUP_CRON=0 */6 * * *
SYNCPLAY_ENDED_TTL_MINUTES=1440
AUDIO_CACHE_VARIANT_CLEANUP_ENABLED=true
DESKTOP_AUTH_CLEANUP_ENABLED=true
```

**Authentication:**
```env
CLERK_SECRET_KEY=sk_live_xxx
DESKTOP_TOKEN_SIGNING_KEY=long-random-secret
```

## Deployment Steps

### 1. Prepare VPS

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or use Docker (recommended)
docker --version  # Ensure Docker installed
```

### 2. Clone & Setup

```bash
git clone https://github.com/FNXDOOM/Animind_Backend.git
cd animind-backend
cp .env.example .env
nano .env  # Configure with real values
```

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Start Server

**Development:**
```bash
npm run dev
```

**Production (PM2):**
```bash
npm install -g pm2
pm2 start dist/server.js --name "animind-backend"
pm2 save
pm2 startup
```

**Production (Docker):**
```bash
docker compose build
docker compose up -d
```

### 5. Configure Nginx (Optional Reverse Proxy)

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
    }
}
```

Then enable SSL with certbot:
```bash
certbot --nginx -d api.yourdomain.com
```

## Monitoring

### Check Logs

```bash
# PM2
pm2 logs animind-backend

# Docker
docker compose logs -f

# Journal
journalctl -u pm2-animind -f
```

### Key Metrics to Monitor

- Scanner execution time & success rate
- WebSocket connection count & room count
- Video stream bandwidth
- Cache hit rate (for audio variants)
- Database query performance
- Disk space (for audio cache & local storage)
