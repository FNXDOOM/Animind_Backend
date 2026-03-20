# Storage Scanner Service

The Scanner Service is the core bridge between your raw files and the database. 

## The Challenge
Video files uploaded to a VPS or a bucket usually have messy names like `[SubsPlease] Frieren - 01 (1080p).mkv`. The backend needs to figure out that this belongs to the show "Frieren" and is episode "1".

## Workflow

1. **Triggering the Scan:**
   - **Manual**: Via a button on the Admin panel on the site.
   - **Automated (Cron)**: Runs every X hours.
   - **Automated (Webhook)**: If using S3, an S3 Event Notification can hit an API endpoint (`/api/webhooks/storage`) the moment a file is uploaded.

2. **Listing Files:**
   - The backend uses the AWS SDK to `listObjectsV2` on the bucket, OR uses `fs.readdir` recursively if it's a local VPS folder.

3. **Parsing Metadata (The "Guessit" step):**
   - The backend runs strings through a parser. For Node.js, libraries like `anime-parser` or `anitomy-js` are excellent. They parse `[Group] Anime Title - Episode [Quality]` to give structured JSON.
   
4. **Database Upsertion:**
   - For every parsed file:
     - Check if the `shows` table has the parsed `Anime Title`. If not, insert it (optionally reaching out to the AniList API `https://graphql.anilist.co` for official cover art/synopsis).
     - Check if the `episodes` table has this `episode_number` for the `show_id`.
     - If not, insert the record with the `file_path`.
     - If it exists but with a new path, update the path.

5. **Pruning Missing Files:**
   - The scanner should maintain a cache of found files. If an episode exists in the DB but was not seen in the bucket in the latest scan, it should be marked as offline or deleted from the DB.
