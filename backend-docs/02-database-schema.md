# Database Schema

To support the relationships between Anime shows, their distinct episodes, and active SyncPlay rooms, we need a relational layout. Since you use Supabase in the frontend, these tables can be created there.

## Tables

### `shows`
Contains metadata for the top-level Anime.
- `id` (UUID, Primary Key)
- `title` (String)
- `synopsis` (Text)
- `cover_image_url` (String)
- `anilist_id` (Integer, Nullable) - To optionally fetch metadata from AniList.
- `created_at` (Timestamp)

### `episodes`
Represents an individual video file on your VPS/Bucket.
- `id` (UUID, Primary Key)
- `show_id` (UUID, Foreign Key mapping to `shows(id)`)
- `episode_number` (Integer or Float)
- `title` (String, Optional)
- `file_path` (String) - The S3 object key or VPS path (e.g., `Naruto/Season 1/S01E01.mkv`)
- `bucket_name` (String) - In case you use multiple storage buckets.
- `duration` (Integer) - Duration in seconds, if pre-calculated.
- `created_at` (Timestamp)
- *Constraint*: `show_id`, `episode_number` must be unique to prevent duplicates.

### `watch_parties` (SyncPlay Rooms)
Used to keep track of active SyncPlay sessions.
- `id` (UUID, Primary Key) - Often used as the room code.
- `host_user_id` (UUID, Foreign Key to Auth User) - The user who controls the playback.
- `episode_id` (UUID, Foreign Key mapping to `episodes(id)`)
- `status` (Enum: `active`, `ended`)
- `created_at` (Timestamp)

### `watch_party_participants`
- `party_id` (UUID, Foreign Key to `watch_parties(id)`)
- `user_id` (UUID, Foreign Key to Auth User)
- `joined_at` (Timestamp)
