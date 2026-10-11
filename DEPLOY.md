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

## Staging on MMIX-Apps-US (vps-site)

Staging is a demo instance: `site-run` starts the container **without a volume**,
so the SQLite file lives inside the container and is recreated empty on every
deploy. Two env flags turn that into a feature instead of a blank screen:

| Env | Value | Effect |
|---|---|---|
| `DEMO_SEED_ON_EMPTY` | `1` | After migrations, if `users` is empty, seed the demo household (`lib/demoSeed.js`): user `demo`, 3 accounts, ~190 transactions over 6 months, budgets, goals, car loan, TFSA portfolio, subscriptions, rules, family with `demo-partner`. A DB with any user is never touched. |
| `DEMO_SEED_ALLOW_PRODUCTION` | `1` | Required together with `DEMO_SEED_ON_EMPTY` when the container runs with `NODE_ENV=production` (the image default). Without it the seed refuses: the demo account has a public password. Set it only on staging. |
| `DEMO_MODE` | `1` | `/api/health` and `/api/health/demo` report `demo:true`; billing/AI answers carry `_meta.demo`. The frontend uses `GET /api/health/demo` for the "Demo instance — data resets on every deploy" banner. |
| `DEMO_PASSWORD` | optional | Password for `demo` / `demo-partner` (default `finman-demo-2026`). |

Required secrets in the env file (names only, values live in
`~/.config/vps-migration/env/finman.env` on the workstation and are shipped as
`/srv/apps/finman.env.json`): `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`
(64 hex), `NODE_ENV=production`, `CORS_ORIGIN=https://finman.apps.mmix.biz`.
Optional: `AI_PROVIDER` + its key (Gemini/Ollama/OpenAI-compatible, never
Anthropic by default), `LOG_LEVEL`.

```bash
# env file: KEY=<json string> per line
$EDITOR ~/.config/vps-migration/env/finman.env

vps-site app finman /path/to/finman-checkout \
  --env DEMO_SEED_ON_EMPTY=1 --env DEMO_SEED_ALLOW_PRODUCTION=1 --env DEMO_MODE=1 \
  --env NODE_ENV=production --env CORS_ORIGIN=https://finman.apps.mmix.biz
                                                     # build on the workstation, ship, swap without downtime;
                                                     # --env extras are kept in the registry for later `env`/`app` calls.
                                                     # Add --idle off on demo days so the first visitor never waits
                                                     # for a cold start (the idle stop keeps the container filesystem).
vps-site hosts finman finman.apps.mmix.biz          # first host is primary (hosts WITHOUT args rewrites the list)
vps-site check finman                                # HTTP status per hostname
vps-site logs finman 100                             # look for "demo seed: household created"
vps-site env finman                                  # push changed env, restart, no rebuild
vps-site rollback finman                             # previous image
```

Checks after a staging deploy:

```bash
curl -s https://finman.apps.mmix.biz/api/health        # data.demo:true, data.seeded_at set
curl -s https://finman.apps.mmix.biz/api/health/demo   # message: "Demo instance — data resets on every deploy"
# log in: username demo, password = DEMO_PASSWORD (default finman-demo-2026)
```

Staging data resets on every deploy and every container restart that recreates
the filesystem; anything a reviewer enters disappears with the next `vps-site
app`. That is intended. If staging ever needs to keep accounts between deploys,
`site-run` has to gain a `-v finman-data:/app/data` option; the entrypoint
already handles a root-owned volume — and then `DEMO_SEED_ON_EMPTY` seeds only
the very first boot, because the users table is no longer empty afterwards.

`finman` is not registered in `sites.json` yet; the first `vps-site app` call
registers it and assigns a port. Never set `DEMO_SEED_ON_EMPTY` or `DEMO_MODE`
on docker-1 (`app.finman.money`).

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
