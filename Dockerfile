# syntax=docker/dockerfile:1
# ============================================================================
# FINMAN — multi-stage production image
#   Stage 1 (deps):  install PROD-only node_modules, rebuilding the sqlite3
#                    native addon from source if no prebuilt binary matches.
#   Stage 2 (runtime): slim image, copies node_modules + app, runs as non-root,
#                    persists the SQLite DB under /app/data (mount a volume!).
# ============================================================================

# ---- Stage 1: dependencies ------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# Toolchain needed to (re)build native addons like sqlite3 if a prebuilt
# binary is unavailable for this platform/glibc. Kept ONLY in the deps stage
# so the final image stays lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install prod deps against the lockfile for reproducible builds.
# npm rebuild sqlite3 forces a source build if the downloaded prebuilt
# doesn't load (belt-and-suspenders; usually the prebuilt just works).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm rebuild sqlite3 --build-from-source --omit=dev || npm rebuild sqlite3 \
  && npm cache clean --force

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/finance.db

# wget is used by the HEALTHCHECK below; node:22-slim ships without it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

# Bring in the already-built dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source. .dockerignore keeps node_modules, the local
# data/ dir, mobile build output, tests and secrets out of the image.
COPY . .

# Persisted SQLite database lives here. Create it up front and hand ownership
# to the non-root user so the app can write even on a fresh named volume.
RUN mkdir -p /app/data \
  && chown -R node:node /app

# Drop privileges — never run the app as root.
USER node

EXPOSE 3000

# Liveness: hit the real /api/health endpoint (provided by routes/health.js).
# Fails (exit 1) if the server is not answering with HTTP 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]
