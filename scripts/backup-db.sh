#!/bin/sh
# ============================================================================
# FINMAN — consistent SQLite backup + rotation (keep the newest 14).
#
# Runs INSIDE the container (preferred) or on any host with the DB file:
#   docker exec finman /app/scripts/backup-db.sh
#   DATABASE_PATH=./data/finman.db ./scripts/backup-db.sh
#
# Output: <data dir>/backups/finman-YYYYmmdd-HHMM.db
#
# Method: `sqlite3 .backup` when the CLI exists, otherwise `VACUUM INTO`
# through the app's own node sqlite3 module (the runtime image has no sqlite3
# CLI). Both are online, WAL-safe snapshots; a plain `cp` of a live DB is not.
#
# Env:
#   DATABASE_PATH  (default /app/data/finman.db)
#   BACKUP_DIR     (default <dir of DATABASE_PATH>/backups)
#   BACKUP_KEEP    (default 14)
# ============================================================================
set -eu

DB_PATH="${DATABASE_PATH:-/app/data/finman.db}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB_PATH")/backups}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$BACKUP_DIR/finman-$STAMP.db"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
rm -f "$OUT"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$OUT'"
else
  # Resolve the app's node_modules relative to this script (…/scripts/../).
  APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  NODE_PATH="$APP_DIR/node_modules" node -e '
    const sqlite3 = require("sqlite3");
    const [src, out] = process.argv.slice(1);
    const db = new sqlite3.Database(src, sqlite3.OPEN_READONLY, (err) => {
      if (err) { console.error("[backup] open failed:", err.message); process.exit(1); }
      db.run("VACUUM INTO ?", [out], (e) => {
        if (e) { console.error("[backup] VACUUM INTO failed:", e.message); process.exit(1); }
        db.close(() => process.exit(0));
      });
    });
  ' "$DB_PATH" "$OUT"
fi

SIZE="$(wc -c < "$OUT" | tr -d ' ')"
echo "[backup] wrote $OUT ($SIZE bytes)"

# Rotation: keep the newest $KEEP finman-*.db files, delete the rest.
# ls -t sorts newest first; tail -n +N prints from the N-th line on.
ls -1t "$BACKUP_DIR"/finman-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -f "$old" && echo "[backup] pruned $old"
done
