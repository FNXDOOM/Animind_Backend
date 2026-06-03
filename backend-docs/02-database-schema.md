# Database Schema

All core tables are created and managed in Supabase PostgreSQL. The schema is designed to support:
- Dynamic anime library discovery
- Multi-season episode organization
- Metadata enrichment from AniList/MyAnimeList
- SyncPlay watch party sessions
- Multi-user access and administration

## Core Tables

### `shows`
Represents a single anime series.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `title` | String | Required; unique constraint enforced |
| `synopsis` | Text | Optional; enriched from AniList |
| `cover_image_url` | String | Optional; poster art from metadata service |
| `genres` | Array (text[]) | Optional; e.g., `['Action', 'Adventure']` |
| `rating` | Numeric | Optional; 0-10 scale from AniList |
| `episode_count` | Integer | Expected episode count from metadata |
| `studio` | String | Animation studio |
| `status` | String | e.g., `'FINISHED'`, `'AIRING'` |
| `year` | String | Release year |
| `anilist_id` | Integer | AniList ID for metadata enrichment |
| `trailer_id` | String | YouTube video ID |
| `trailer_site` | String | e.g., `'youtube'` |
| `trailer_thumbnail` | String | URL to trailer thumbnail |
| `created_at` | Timestamp | Record creation time |
| `updated_at` | Timestamp | Last modification time |

**Indexes**: 
- `UNIQUE(title)` for upsert support
- Expression index on `lower(trim(title))` for case-insensitive searching

### `episodes`
Represents an individual video file mapped to a show.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `show_id` | UUID (FK→shows.id) | Required; maps episode to show |
| `season_number` | Integer | 1-based (defaults to 1 if missing) |
| `episode_number` | Float | Decimal support for specials (e.g., 5.5) |
| `content_type` | String | Optional; `'tv'`, `'special'`, `'movie'`, etc. |
| `title` | String | Optional; episode title |
| `file_path` | String | S3 object key or local path (e.g., `Frieren/S01/01.mkv`) |
| `bucket_name` | String | Identifier for multi-bucket support |
| `duration` | Integer | Video duration in seconds (calculated by scanner) |
| `created_at` | Timestamp | When episode was discovered |
| `updated_at` | Timestamp | Last modification |

**Constraints**:
- `UNIQUE(show_id, episode_number)` prevents duplicate episodes
- Deduplication by `(season_number, episode_number, content_type)` on API responses

### `watch_parties` (SyncPlay Rooms)
Tracks active and completed watch party sessions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Room code; also used in Socket.IO events |
| `episode_id` | UUID (FK→episodes.id) | The episode being watched |
| `host_user_id` | UUID (FK→auth.users.id) | User who created the room |
| `status` | String | `'active'` or `'ended'` |
| `created_at` | Timestamp | When room was created |
| `ended_at` | Timestamp | When room was closed |

**Cleanup**: Rooms are auto-deleted after `SYNCPLAY_ENDED_TTL_MINUTES` if status is `'ended'`.

### `watch_party_participants`
Tracks membership in watch parties.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `party_id` | UUID (FK→watch_parties.id) | Room membership |
| `user_id` | UUID (FK→auth.users.id) | Participant |
| `joined_at` | Timestamp | When user joined room |
| `last_heartbeat_at` | Timestamp | Last activity check |

**Note**: When a user disconnects, their record remains for a grace period before being removed.

### `profiles` (Supabase Auth Extended)
Extends `auth.users` with application-specific user data.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK, FK→auth.users.id) | User ID |
| `username` | String | Unique handle |
| `avatar_url` | String | User avatar or generated gravatar |
| `is_admin` | Boolean | Admin privileges |
| `created_at` | Timestamp | Account creation |
| `updated_at` | Timestamp | Last profile update |

## Optional Tables (Maintenance & Metadata)

### `desktop_auth_sessions` (Desktop Client Support)
Stores long-lived access tokens for native clients (desktop/mobile).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Session ID |
| `user_id` | UUID (FK→auth.users.id) | Owner |
| `access_token` | String | Signed JWT |
| `refresh_token` | String | Refresh JWT |
| `expires_at` | Timestamp | Token expiry |
| `created_at` | Timestamp | Session start |

Expired sessions are auto-cleaned by cron job `DESKTOP_AUTH_CLEANUP_CRON`.

## Data Flow

### Scanner → Database
```
1. Scanner lists S3 or local files
2. Parser extracts: "Anime Title - S01E05" 
3. Check if show exists in `shows`
   → If not: insert shell row, fetch metadata (AniList), upsert
4. Check if episode exists in `episodes`
   → If not: insert with file_path + bucket_name
   → If yes + different path: update file_path
5. Prune episodes not found in latest scan
```

### Frontend Watch Party → Database
```
1. User creates/joins room (Socket.IO event)
2. Server creates `watch_parties` row with episode_id
3. Server adds entry to `watch_party_participants`
4. Broadcast room_id to frontend
5. On disconnect: Remove participant row
6. On room end: Mark watch_parties.status = 'ended'
7. Cron cleanup: Delete ended rooms after TTL
```
