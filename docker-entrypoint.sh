#!/bin/sh
# docker-entrypoint.sh — fix data-volume ownership, then run the app as `node`.
#
# Why: the production volume `finman-data` was created by a root container
# (node:20-alpine, no USER). A non-root image cannot write finman.db there or
# create the SQLite -wal/-shm sidecar files. So the image starts as root,
# chowns the data dir to the app uid/gid when it can, and drops privileges
# with setpriv before exec'ing node. If the container is started with
# `--user` (not root), the chown step is skipped and we run as-is.
set -eu

DB_PATH="${DATABASE_PATH:-/app/data/finman.db}"
DATA_DIR="$(dirname "$DB_PATH")"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"

mkdir -p "$DATA_DIR" "$DATA_DIR/backups" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  if [ -w "$DATA_DIR" ]; then
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || echo "[entrypoint] warn: chown $DATA_DIR failed (read-only mount?)" >&2
    chmod 770 "$DATA_DIR" 2>/dev/null || true
  else
    echo "[entrypoint] warn: $DATA_DIR not writable by root; skipping chown" >&2
  fi
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups --inh-caps=-all "$@"
  fi
  echo "[entrypoint] warn: setpriv missing, running as root" >&2
fi

exec "$@"
