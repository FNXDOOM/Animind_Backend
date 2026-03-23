# ── Stage 1: install all deps (including devDeps for the build) ───────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy manifests first so Docker layer-caches the npm install
COPY package*.json ./
RUN npm ci

# ── Stage 2: compile TypeScript ───────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 3: lean production image ────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# ffmpeg + ffprobe are required for subtitle/audio extraction.
# curl is used by the HEALTHCHECK so we don't need the node fetch polyfill.
RUN apk add --no-cache ffmpeg curl

# Install only production deps (no devDeps)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Run as non-root for security
RUN addgroup -S animind && adduser -S animind -G animind
USER animind

EXPOSE 3001

# Graceful shutdown: use SIGTERM, give Node 10s to drain connections
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -f http://127.0.0.1:3001/health || exit 1

CMD ["node", "dist/server.js"]
