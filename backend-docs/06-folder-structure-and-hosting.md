# Hosted Separately or Together?

**Short Answer:** Yes, you should host the backend **separately** from your frontend.

### Why Host Separately?
1. **Frontend Hosting (Vercel/Netlify):** Your current frontend is a Vite + React application (indicated by `vercel.json`). This is a "Static Site" that executes in the user's browser. It is best hosted on Vercel or Netlify because it is fast, globally distributed, and free.
2. **Backend Hosting (VPS or PaaS):** The backend we designed requires:
   - **Continuous background jobs** (for the Storage Scanner).
   - **Persistent WebSocket connections** (for the SyncPlay room features).
   - **Heavy Bandwidth** (for video streaming if you are piping video through the backend).
   
Serverless platforms like Vercel usually **kill** connections after 10-60 seconds, which breaks WebSockets (SyncPlay) and long video streams. Therefore, your backend needs to run on a persistent server like:
- **A VPS:** DigitalOcean Droplet, Hetzner, or AWS EC2 (Best if you store video files directly on this server's hard drive).
- **A Container PaaS:** Railway.app or Render.app (Best if your videos are stored in an S3 Bucket, so the backend just needs to be a lightweight Express server).

---

# Recommended Backend Folder Structure

If you decide to build this backend in **Node.js + Express (with TypeScript)**, here is a scalable folder structure to start with:

```text
animind-backend/
├── src/
│   ├── config/               # Configuration files (Supabase/DB connection, AWS S3 keys)
│   │   └── db.ts
│   ├── controllers/          # Handles incoming HTTP requests
│   │   ├── show.controller.ts
│   │   ├── episode.controller.ts
│   │   └── webhook.controller.ts
│   ├── routes/               # Express route definitions
│   │   ├── show.routes.ts
│   │   └── api.routes.ts
│   ├── services/             # Core business logic
│   │   ├── scanner.service.ts    # Logic for scanning VPS/S3 and matching anime names
│   │   └── anilist.service.ts    # Fetches cover images/synopsis from AniList
│   ├── sockets/              # WebSocket logic for SyncPlay
│   │   └── syncplay.handler.ts   # Joins rooms, syncs play/pause state
│   ├── utils/                # Helper functions
│   │   └── titleParser.ts        # Regex to extract "Frieren" and "Episode 1" from "[Subs] Frieren - 01.mkv"
│   ├── app.ts                # Express app setup and middleware
│   └── server.ts             # Entry point (Starts HTTP server and Socket.IO)
├── .env                      # Environment variables (DB_URL, S3_SECRET)
├── package.json              # Dependencies
└── tsconfig.json             # TypeScript config
```

### Flow Example for this Structure:
1. `server.ts` boots up Express (`app.ts`) and the Socket Server (`sockets/syncplay.handler.ts`).
2. A Cron Job inside `server.ts` triggers `services/scanner.service.ts` every hour.
3. The frontend asks for shows by hitting `/api/shows` -> handled by `routes/show.routes.ts` -> executed by `controllers/show.controller.ts`.
