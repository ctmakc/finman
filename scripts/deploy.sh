#!/usr/bin/env bash
# ============================================================================
# FINMAN — build & deploy via Docker Compose, then smoke-test /api/health.
#
# Usage:
#   ./scripts/deploy.sh
#
# What it does:
#   1. Ensures a .env exists (creates one from .env.example if missing).
#   2. Builds the image and starts the stack detached (docker compose up -d --build).
#   3. Polls http://localhost:<PORT>/api/health until the app is healthy.
#
# Env overrides:
#   PORT          host port to probe (default: value from .env, else 3000)
#   HEALTH_RETRIES number of health poll attempts (default: 30)
#   HEALTH_DELAY   seconds between attempts (default: 2)
# ============================================================================
set -euo pipefail

# Resolve repo root (this script lives in <root>/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[deploy:error]\033[0m %s\n' "$*" >&2; }

# --- Pick the docker compose invocation (v2 plugin vs legacy v1) -----------
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  err "Neither 'docker compose' nor 'docker-compose' is available. Install Docker first."
  exit 1
fi

# --- Ensure .env exists ----------------------------------------------------
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    log "No .env found — creating one from .env.example. EDIT IT with real secrets!"
    cp .env.example .env
  else
    err "No .env and no .env.example to copy from. Aborting."
    exit 1
  fi
fi

# --- Determine the port to probe (PORT env > .env > 3000) ------------------
PORT="${PORT:-}"
if [ -z "${PORT}" ] && [ -f .env ]; then
  # Read PORT from .env without sourcing the whole file.
  PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)"
fi
PORT="${PORT:-3000}"

HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY="${HEALTH_DELAY:-2}"
HEALTH_URL="http://localhost:${PORT}/api/health"

# --- Build & start ---------------------------------------------------------
log "Building image and starting stack (${COMPOSE} up -d --build)..."
${COMPOSE} up -d --build

# --- Smoke test: poll /api/health -----------------------------------------
log "Waiting for app to become healthy at ${HEALTH_URL} ..."
attempt=1
while [ "${attempt}" -le "${HEALTH_RETRIES}" ]; do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    log "Health check passed on attempt ${attempt}."
    log "Response:"
    curl -fsS "${HEALTH_URL}" || true
    echo
    log "Deploy complete. FINMAN is up at http://localhost:${PORT}"
    exit 0
  fi
  printf '\033[1;33m[deploy]\033[0m health attempt %s/%s failed; retrying in %ss...\n' \
    "${attempt}" "${HEALTH_RETRIES}" "${HEALTH_DELAY}"
  attempt=$((attempt + 1))
  sleep "${HEALTH_DELAY}"
done

err "App did not become healthy after ${HEALTH_RETRIES} attempts. Recent logs:"
${COMPOSE} logs --tail=50 app || true
exit 1
