# Backend Architecture Overview

This backend is designed to serve a personal streaming application ("Animind") that aggregates anime videos from a VPS or object storage bucket, indexes them, and streams them to the frontend, complete with a SyncPlay (watch together) feature.

## Key Goals
1. **Dynamic Media Library**: Automatically scan storage and maintain a catalog of shows and episodes.
2. **Video Streaming**: Deliver video efficiently to the frontend.
3. **SyncPlay (Watch Party)**: Real-time synchronization of video playback for multiple users.

## Tech Stack Recommendation
Since the frontend is built with React/TypeScript and uses Supabase for authentication, a harmonious backend stack would be:
- **Language**: Node.js with TypeScript (for code sharing and ecosystem compatibility).
- **Framework**: Express.js or Fastify (for the REST APIs).
- **Database**: PostgreSQL (specifically, Supabase to seamlessly integrate with your existing auth).
- **Real-time**: Socket.IO or Supabase Realtime for the SyncPlay feature.
- **Storage**: AWS S3 (or any S3-compatible storage like Cloudflare R2, MinIO, or DigitalOcean Spaces) OR direct local storage on the VPS.

## Core Services
1. **Scanner Service**: A background worker (Cron job) or a triggered service that reads objects in the VPS/Bucket, extracts metadata (title, episode number), and updates the database.
2. **REST API Service**: Serves endpoints like `GET /api/shows`, `GET /api/shows/:id/episodes` for the frontend to render the library.
3. **Streaming/Proxy Service**: Serves the video file. For buckets, this often means creating and returning Signed URLs. For VPS storage, this means serving the file using HTTP Range Requests (206 Partial Content).
4. **WebSocket Server**: Manages state for watch parties. Validates users, handles room creation, and broadcasts "play", "pause", and "seek" events.
