# Animind Backend Docker Deployment (VPS)

This guide shows how to run the backend in Docker on a VPS and connect it to your Vercel frontend.

## 1. Prerequisites

- VPS with Docker + Docker Compose plugin installed
- Domain or subdomain for backend API (recommended): `api.yourdomain.com`
- Frontend already deployed on Vercel

## 2. Files included

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`

## 3. Configure backend env

In `animind-backend`, create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Set at least these values in `.env`:

```env
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://your-frontend.vercel.app,https://yourdomain.com,https://www.yourdomain.com

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

STORAGE_MODE=s3
S3_BUCKET_NAME=your-bucket-name
S3_REGION=auto
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

If you use local VPS files instead of S3:

```env
STORAGE_MODE=local
LOCAL_STORAGE_PATH=/mnt/anime
```

Then uncomment the volume in `docker-compose.yml`:

```yaml
volumes:
  - /mnt/anime:/mnt/anime:ro
```

## 4. FFmpeg / FFprobe paths

Your `.env.example` is configured with Docker-safe defaults:

```env
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

No changes needed – the Docker image installs `ffmpeg` (which includes `ffprobe`) via Alpine's package manager, so these command names will resolve correctly in the container.

## 5. Build and run on VPS

From backend folder:

```bash
docker compose build
docker compose up -d
```

Check status and logs:

```bash
docker compose ps
docker compose logs -f
```

Quick health check:

```bash
curl http://127.0.0.1:3001/health
```

## 6. Put Nginx + SSL in front (recommended)

Proxy `https://api.yourdomain.com` to `http://127.0.0.1:3001`.

After Nginx is configured and SSL is enabled (Certbot), verify:

```bash
curl https://api.yourdomain.com/health
```

## 7. Frontend steps (Vercel)

Set this env variable in Vercel project settings:

```env
VITE_CLOUD_SERVER_URL=https://api.yourdomain.com
```

Redeploy frontend after changing env vars.

## 8. Smoke test flow

1. Open frontend and login
2. Open cloud library page
3. Trigger scan
4. Try episode stream
5. If any error, check backend logs:

```bash
docker compose logs -f animind-backend
```

## 9. Update workflow on VPS

```bash
git pull
docker compose build --no-cache
docker compose up -d
```
