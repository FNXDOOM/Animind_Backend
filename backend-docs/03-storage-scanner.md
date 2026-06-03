# Storage Scanner Service

The Scanner Service maintains the anime library by discovering files, extracting metadata, and populating the database with shows and episodes.

## Overview

Video files in your S3 bucket or local VPS storage have names like `[SubsPlease] Frieren - 01 (1080p).mkv`. The Scanner`s job is to:
1. List all video files from storage
2. Parse filenames into structured metadata (title, episode number, season)
3. Enrich with anime metadata (cover art, synopsis, rating)
4. Upsert shows and episodes into the database
5. Prune offline episodes

## Triggering a Scan

### Manual Scan
Via the admin panel: `POST /api/rescan` (requires auth + admin role)

### Scheduled Scan (Cron)
Configured via `SCANNER_CRON` environment variable. Examples:
- `0 */6 * * *` — Every 6 hours
- `0 2 * * *` — Daily at 2 AM
- `*/30 * * * *` — Every 30 minutes

### S3 Event Webhook
AWS S3 bucket → Event notification → `POST /api/webhooks/storage` (protected with `WEBHOOK_SECRET`)

## Scanning Process

### Step 1: List Files
**S3 Mode** (`STORAGE_MODE=s3`):
- Uses AWS SDK `ListObjectsV2` command
- Filters by video extensions (from `VIDEO_EXTENSIONS` env)

**Local Mode** (`STORAGE_MODE=local`):
- Recursively scans `LOCAL_STORAGE_PATH` directory
- Skips `.animind-audio-cache` folder

### Step 2: Parse Filenames

The backend attempts parsing in this order:

**1. Deterministic Parser** (`titleParser.ts`)
- Regex-based extraction of title and episode number
- Recognizes patterns: `[SubGroup] Title - 01`, `Title S01E05`, folder structures

**2. MyAnimeList Fallback** (if enabled)
- Query MyAnimeList API for shows matching parsed title
- Requires `MYANIMELIST_CLIENT_ID` in environment

**3. OpenRouter AI Fallback** (if enabled)
- Use GPT-4o-mini via OpenRouter to classify ambiguous files
- Only if confidence score < `OPENROUTER_MIN_CONFIDENCE` (default 0.72)

### Step 3: Metadata Enrichment

**AniList API** (if `ANILIST_ENABLED=true`, default):
- GraphQL query to `https://graphql.anilist.co`
- Fetches: cover art, synopsis, rating, genres, studio, status, year

**MyAnimeList Fallback** (if AniList fails):
- Secondary source for metadata

### Step 4: Database Upsert

For each parsed file:
1. Normalize show title (lowercase, remove punctuation)
2. Check if show exists → update or insert
3. Check if episode exists by (show_id, season_number, episode_number) → update or insert
4. Mark as online/available

### Step 5: Pruning

Remove episodes that are no longer present in storage.

## Configuration

| Environment Variable | Default | Purpose |
|----------------------|---------|---------|
| `SCANNER_CRON` | `0 */6 * * *` | Cron expression for auto-scan |
| `VIDEO_EXTENSIONS` | `mkv,mp4,avi,webm,m4v` | File extensions to scan |
| `ANILIST_ENABLED` | `true` | Fetch metadata from AniList |
| `MYANIMELIST_ENABLED` | `true` | Fallback metadata from MAL |
| `MYANIMELIST_CLIENT_ID` | — | MyAnimeList API client ID |
| `OPENROUTER_ENABLED` | `false` | AI-powered filename parsing |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `OPENROUTER_MIN_CONFIDENCE` | `0.72` | Confidence threshold for AI |

## Performance Notes

- Full library scan: ~1-5 seconds depending on file count
- Metadata enrichment: 50-200ms per show
- Database upsert: 100-500ms per show depending on episode count
