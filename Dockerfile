# syntax=docker/dockerfile:1
# ============================================================================
# FINMAN — multi-stage production image
#   Stage 1 (deps):    install PROD-only node_modules, rebuilding the sqlite3
#                      native addon from source if no prebuilt binary matches.
#   Stage 2 (runtime): slim image, copies node_modules + app, persists the
#                      SQLite DB under /app/data (named volume finman-data).
#
# Runtime user: the container STARTS as root so docker-entrypoint.sh can
# chown/chmod the mounted data volume (the production volume `finman-data`
# was created by a root container and is root-owned; a plain `USER node`
# image cannot open finman.db there or create its -wal/-shm files). The
# entrypoint then drops privileges with setpriv and runs node as uid 1000
# (`node`). The app process itself never runs as root.
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
# Grouped so a failing `npm ci` fails the build ("a && b || c" ran the
# fallback rebuild after a failed install and the image built without deps).
RUN npm ci --omit=dev --no-audit --no-fund \
  && (npm rebuild sqlite3 --build-from-source --omit=dev || npm rebuild sqlite3) \
  && node -e "require('sqlite3')" \
  && npm cache clean --force

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

# DATABASE_PATH: /app/data/finman.db is the PRODUCTION file name (app.finman.money
# lineage). The older wave2 default `finance.db` is still accepted when passed
# explicitly via env, but the image defaults to finman.db so the existing prod
# volume keeps its user data.
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/finman.db \
    APP_UID=1000 \
    APP_GID=1000

# wget is used by the HEALTHCHECK below; node:22-slim ships without it.
# setpriv (util-linux) is already present and is what the entrypoint uses to
# drop from root to `node`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

# Bring in the already-built dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source. .dockerignore keeps node_modules, the local
# data/ dir, mobile build output, tests and secrets out of the image.
COPY . .

# Persisted SQLite database lives here. Create it up front; the entrypoint
# re-chowns it at start so a pre-existing root-owned volume also works.
RUN mkdir -p /app/data /app/data/backups \
  && chown -R node:node /app \
  && chmod +x /app/docker-entrypoint.sh /app/scripts/backup-db.sh

EXPOSE 3000

# Liveness: hit the real /api/health endpoint (provided by routes/health.js).
# Fails (exit 1) if the server is not answering with HTTP 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

# No USER directive on purpose — see header. The entrypoint drops to `node`.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
