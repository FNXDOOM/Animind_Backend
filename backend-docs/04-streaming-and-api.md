# Streaming and REST APIs

To integrate with your React frontend, the backend needs to expose standard REST APIs and properly serve video content.

## Main Endpoints

### `GET /api/shows`
- Returns a list of shows scanned from the bucket.
- Output: `[{ id: 1, title: 'Frieren', cover_image_url: '...' }]`

### `GET /api/shows/:id`
- Returns detail for a specific show AND an array of its episodes, ordered by `episode_number`.
- Output: `{ id: 1, title: 'Frieren', episodes: [{ id: 101, episode_number: 1, ... }] }`

## Serving the Video

When the user clicks on an episode in the "Show" tab, the frontend opens a video player (such as standard HTML5 `<video>` or Video.js).

### Approach A: S3 / Cloud Bucket (Recommended)
If your videos are on an S3-compatible service:
- You **do not** stream directly through your server as it eats up massive bandwidth.
- Your backend exposes `GET /api/episodes/:id/stream`.
- This endpoint authenticates the user, then generates an **S3 Pre-signed URL** valid for a few hours.
- It returns a 302 Redirect to the S3 URL (or returns it in JSON for the frontend to use as the `<video src="...">`).

### Approach B: Local VPS Storage
If your videos sit directly on the hard drive of your backend VPS:
- Your Express backend needs an endpoint `GET /api/episodes/:id/stream`.
- It must support HTTP **206 Partial Content (Range Requests)**. This allows the browser to request byte chunks (e.g., bites 0-500000) so the video can be scrubbed/seeked efficiently without downloading the whole file at once.
- Most frameworks have modules for this (like `express.static`, or manual implementations checking the `range` header).
