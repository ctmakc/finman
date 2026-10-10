# FINMAN — deployment

Two targets. Staging is where every merge lands first; production changes only
on the owner's explicit go.

| | Staging | Production |
|---|---|---|
| Host | MMIX-Apps-US `212.56.34.78` (Caddy, `vps-site`) | docker-1 `46.175.145.172`, `/opt/finman` |
| URL | `https://finman.apps.mmix.biz` (wildcard DNS, `noindex`) | `https://app.finman.money` |
| Container | `finman` via `site-run`, `127.0.0.1:<port>:3000` | `finman` via `docker compose`, `127.0.0.1:3011:3000` |
| Env | `~/.config/vps-migration/env/finman.env` on the workstation, shipped as `/srv/apps/finman.env.json` | `/opt/finman/.env` (`env_file` in compose) |
| DB | inside the container (see note) | named volume `finman-data` -> `/app/data/finman.db` |

## Image

`Dockerfile` (node:22-slim, multi-stage). The container starts as root only so
`docker-entrypoint.sh` can `chown -R 1000:1000` the data directory, then it
drops to uid 1000 (`node`) with `setpriv` and runs `node server.js`. Health:
`GET /api/health` (not rate-limited). Migrations run automatically at boot
(`initDatabase()` -> `lib/migrate.js`, additive, idempotent); the log line is
`Применены миграции: …`.

## Staging (vps-site)

```bash
# env file: KEY=<json string> per line; at minimum the 3 secrets
#   JWT_SECRET, SESSION_SECRET, ENCRYPTION_KEY (64 hex), plus
#   NODE_ENV=production, CORS_ORIGIN=https://finman.apps.mmix.biz
$EDITOR ~/.config/vps-migration/env/finman.env

vps-site app finman /path/to/finman-checkout        # build on the workstation, ship, swap without downtime
vps-site hosts finman finman.apps.mmix.biz          # first host is primary
vps-site check finman                                # HTTP status per hostname
vps-site logs finman 100
vps-site env finman                                  # push changed env, restart, no rebuild
vps-site rollback finman                             # previous image
```

Note on data: `server/site-run` starts the container with no volume mount, so
the staging SQLite file lives in the container filesystem and is recreated
empty on every deploy. That is fine for smoke tests and previews. If staging
ever needs to keep accounts between deploys, `site-run` has to gain a
`-v finman-data:/app/data` option; the entrypoint already handles a root-owned
volume.

`finman` is not registered in `sites.json` yet; the first `vps-site app` call
registers it and assigns a port.

## Production cutover (docker-1, preserves the existing user)

Pre-flight on the workstation: full Jest suite green, `docker build .` passes,
`test/migration-017.test.js` green (it replays the prod schema).

1. **Backup** (on docker-1):
   ```bash
   docker exec finman /app/scripts/backup-db.sh                 # if the old image has the script
   # or, image-independent:
   docker cp finman:/app/data/finman.db /opt/finman-backups/finman-$(date +%F).db
   cp /opt/finman/.env /opt/finman-backups/env-$(date +%F)
   sqlite3 /opt/finman-backups/finman-$(date +%F).db "PRAGMA integrity_check; PRAGMA foreign_key_check;"
   ```
2. **Code**: replace `/opt/finman` with a git checkout of the release branch
   (so prod never drifts from git again). Keep the old directory as
   `/opt/finman.prev` until rollback is no longer needed. Merge the old
   `.env` with `.env.example`: the 3 secrets already exist; add
   `AI_PROVIDER`, `AI_API_KEY` (or `GOOGLE_API_KEY`), `GOOGLE_*`,
   `LEAD_NOTIFY_*`, `GA4_*`, `COOKIE_DOMAIN` as needed. `DATABASE_PATH` is
   forced to `/app/data/finman.db` by compose.
3. **Volume ownership**: the entrypoint chowns `/app/data` at start, so no
   manual step is required. Doing it explicitly is harmless:
   `docker run --rm -v finman-data:/d alpine chown -R 1000:1000 /d`.
4. **Switch**:
   ```bash
   cd /opt/finman
   docker compose down            # volume finman-data is kept
   docker compose up -d --build   # service `finman`, 127.0.0.1:3011 -> Caddy
   ```
5. **Verify**:
   ```bash
   docker logs finman 2>&1 | grep -E "миграции|Сервер"      # 001…017 applied once
   curl -s http://127.0.0.1:3011/api/health                  # 200
   curl -s http://127.0.0.1:3011/api/ready                   # {"status":"ready","db":"up"}
   docker exec finman node -e "const s=require('sqlite3');const d=new s.Database('/app/data/finman.db');d.all('select id,username,email,google_id is not null g,org_id,subscription_tier from users',(e,r)=>console.log(e||r))"
   # -> the existing user row intact; login with the owner's test credentials works
   ```
   Then run a backup: `docker exec finman /app/scripts/backup-db.sh` and add the
   host cron line from README (`15 3 * * * docker exec finman /app/scripts/backup-db.sh …`).
6. **Rollback** (under 5 minutes): `docker compose down`, move `/opt/finman.prev`
   back to `/opt/finman`, `docker compose up -d` (previous image is still
   local; rebuild only if it was pruned). Migrations are additive, so the old
   code runs on the migrated file (extra tables/columns are ignored). If the
   database itself must go back, stop the container and copy the backup over
   `/var/lib/docker/volumes/finman-data/_data/finman.db` (remove `-wal`/`-shm`
   next to it first).

## Checks after any deploy

- `GET /api/health` 200, `GET /api/ready` 200
- browser: open the app, confirm inline buttons work (CSP `script-src-attr`)
  and no CSP errors in the console
- `docker logs finman` shows no `Bearer` tokens (pino redaction)
