# Animind Backend — Docker VPS Deployment Guide

This guide covers deploying the backend on a VPS with Docker, configuring Nginx for WebSocket (SyncPlay) support, and connecting it to your Vercel frontend.

---

## 1. Prerequisites

- VPS running Ubuntu 22.04+ (or any distro with Docker support)
- Docker Engine + Docker Compose plugin installed
- A domain/subdomain pointed at your VPS: `api.yourdomain.com`
- Certbot installed for SSL
- Frontend already deployed on Vercel

---

## 2. Configure `.env`

Create your `.env` from the example:

```bash
cp .env.example .env
nano .env
```

### Required values

```env
PORT=3001
NODE_ENV=production

# Comma-separated list of allowed frontend origins (no trailing slashes)
FRONTEND_URL=https://your-frontend.vercel.app,https://yourdomain.com

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# FFmpeg — use bare command names inside Docker (Alpine installs them to PATH)
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

### Storage: S3 / Cloudflare R2

```env
STORAGE_MODE=s3
S3_BUCKET_NAME=your-bucket-name
S3_REGION=auto
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_PRESIGN_EXPIRES=14400
```

### Storage: Local VPS disk

```env
STORAGE_MODE=local
LOCAL_STORAGE_PATH=/mnt/anime
```

Then uncomment the volume mount in `docker-compose.yml`:

```yaml
volumes:
  - /mnt/anime:/mnt/anime:ro
```

> **Note:** `STORAGE_MODE` must appear only once in `.env`. Having it twice (once for `s3`, once for `local`) means the last value wins silently — delete whichever mode you are not using.

---

## 3. Build and start the container

```bash
docker compose build
docker compose up -d
```

Verify it started:

```bash
docker compose ps
curl http://127.0.0.1:3001/health
# expected: {"status":"ok","timestamp":"..."}
```

Watch live logs:

```bash
docker compose logs -f animind-backend
```

---

## 4. Nginx configuration (required for SyncPlay / WebSocket)

SyncPlay uses Socket.IO over WebSocket. Nginx **must** have a dedicated `location` block for `/api/socket.io/` with the WebSocket upgrade headers, otherwise long-lived connections are dropped and clients get "SyncPlay request timed out" errors.

Create or edit your Nginx site config:

```bash
sudo nano /etc/nginx/sites-available/api.yourdomain.com
```

Paste the following (replace `api.yourdomain.com` with your actual subdomain):

```nginx
server {
    server_name api.yourdomain.com;

    # ── Regular REST API traffic ──────────────────────────────────
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    # ── Socket.IO / SyncPlay WebSocket ───────────────────────────
    # This block MUST come before location / so Nginx matches it first.
    # Without the Upgrade + Connection headers, WebSocket handshakes fail
    # and Socket.IO silently falls back to polling (which also fails).
    location /api/socket.io/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;

        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Keep WebSocket connections alive indefinitely
        proxy_read_timeout    86400s;
        proxy_send_timeout    86400s;
        proxy_connect_timeout 10s;
    }

    listen 443 ssl; # managed by Certbot
    # Certbot will add ssl_certificate lines below
}

# HTTP → HTTPS redirect (managed by Certbot)
server {
    if ($host = api.yourdomain.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    server_name api.yourdomain.com;
    return 404;
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/api.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Add SSL with Certbot

```bash
sudo certbot --nginx -d api.yourdomain.com
```

---

## 5. Vercel frontend configuration

### Environment variable

In your Vercel project → Settings → Environment Variables, add:

```
VITE_CLOUD_SERVER_URL=https://api.yourdomain.com
```

Redeploy the frontend after saving.

### Content Security Policy (`vercel.json`)

The `connect-src` directive in `vercel.json` must include both `https://` **and** `wss://` for your backend domain, otherwise the browser blocks the WebSocket upgrade:

```json
"connect-src": "'self' https://api.yourdomain.com wss://api.yourdomain.com ..."
```

---

## 6. Verify SyncPlay is working

```bash
# 1. Health check
curl https://api.yourdomain.com/health

# 2. Check the Socket.IO path responds (should return Socket.IO HTML)
curl https://api.yourdomain.com/api/socket.io/

# 3. Watch live logs while testing from the browser
docker compose logs -f animind-backend
```

In the browser console you should see:
- `[SyncPlay] SyncPlay connected.` — WebSocket connected successfully
- `[TimeSync] clockOffset=Xms` — NTP clock sync completed

If you see `WebSocket connection failed` in the browser, the most common causes are:
1. The `/api/socket.io/` Nginx block is outside the `server { }` block — move it inside
2. `wss://api.yourdomain.com` is missing from `connect-src` in `vercel.json`
3. SSL certificate is not yet issued — run Certbot

---

## 7. Container internals

| What | Detail |
|---|---|
| Base image | `node:20-alpine` |
| Build stages | 3: `deps` → `build` → `runtime` |
| Runtime user | `animind` (non-root) |
| Exposed port | `3001` |
| Health check | `curl -f http://127.0.0.1:3001/health` every 30s |
| Log rotation | 10 MB per file, max 5 files |
| Memory limit | 512 MB (configurable in `docker-compose.yml`) |
| Open file limit | 65536 (required for many concurrent WebSocket connections) |
| Stop signal | `SIGTERM` — Node handles it for graceful Socket.IO drain |
| ffmpeg | Installed via Alpine `apk` — use bare names `ffmpeg`/`ffprobe` in `.env` |

---

## 8. Update workflow

```bash
# On your development machine
git add .
git commit -m "your changes"
git push

# On the VPS
git pull
docker compose build --no-cache
docker compose up -d

# Confirm the new container is healthy
docker compose ps
curl https://api.yourdomain.com/health
```

Zero-downtime swap (old container keeps serving until the new one is healthy):

```bash
docker compose up -d --no-deps --build animind-backend
```

---

## 9. Useful commands

```bash
# Live logs
docker compose logs -f animind-backend

# Shell into running container
docker compose exec animind-backend sh

# Check resource usage
docker stats animind-backend

# Stop and remove container (keeps image)
docker compose down

# Stop and remove container + image
docker compose down --rmi local

# Restart without rebuild
docker compose restart animind-backend
```

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `SyncPlay request timed out` | WebSocket blocked by Nginx or CSP | Add `/api/socket.io/` Nginx block inside `server {}` + add `wss://` to `vercel.json` CSP |
| `WebSocket connection failed` in browser console | CSP `connect-src` missing `wss://` | Add `wss://api.yourdomain.com` to `connect-src` in `vercel.json`, redeploy Vercel |
| Peers keep flickering / buffering loop | Old backend without buffering idempotency fix | Rebuild container with latest code |
| `clock offset` very large in console | Server and client clocks skewed | NTP sync handles this automatically; check VPS time with `timedatectl` |
| Container exits immediately | Bad `.env` value | Run `docker compose logs animind-backend` to see the startup error |
| `EACCES` permission error on local storage | Volume mounted as wrong user | Check `LOCAL_STORAGE_PATH` permissions; the container runs as `animind` (UID varies) |
| Health check failing | Container not ready yet | Increase `start_period` in `docker-compose.yml` or wait 20s after `up -d` |
