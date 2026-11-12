#!/bin/sh
# scripts/geo-update.sh — refresh the DB-IP Lite country database used by
# services/geo.js (IP -> country for the sign-up source). DB-IP Lite is
# CC BY 4.0, attribution on finman.money/privacy. Run monthly, e.g. on the host:
#   docker exec finman sh /app/scripts/geo-update.sh
# GEO_DB_DIR defaults to /app/data/geo. Add CITY=1 for the city database (~130 MB).
set -eu
DIR="${GEO_DB_DIR:-/app/data/geo}"
mkdir -p "$DIR"
fetch() { # name
  for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m 2>/dev/null || true)"; do
    [ -n "$m" ] || continue
    url="https://download.db-ip.com/free/dbip-$1-lite-$m.mmdb.gz"
    if wget -q -O "$DIR/.$1.gz" "$url" 2>/dev/null || curl -fsSL -o "$DIR/.$1.gz" "$url" 2>/dev/null; then
      gunzip -c "$DIR/.$1.gz" > "$DIR/.$1.mmdb" && mv "$DIR/.$1.mmdb" "$DIR/dbip-$1-lite.mmdb"
      rm -f "$DIR/.$1.gz"; echo "geo: dbip-$1-lite $m"; return 0
    fi
  done
  rm -f "$DIR/.$1.gz"; echo "geo: download failed for $1" >&2; return 1
}
fetch country
[ "${CITY:-0}" = 1 ] && fetch city
exit 0
