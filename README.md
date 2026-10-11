# FINMAN — Personal Finance Manager

Self-hosted personal finance manager: accounts, transactions, budgets, savings
goals, debts, family/shared finances, investments, subscriptions, net-worth
tracking, CSV import, receipt OCR, and real bank API sync (Monobank / Revolut /
Tinkoff). Node/Express + SQLite + a vanilla-JS frontend (no build step), with an
optional AI assistant and Stripe-based subscription tiers.

---

## Quick start

### Option A — Docker (recommended, persistent DB)

```bash
cp .env.example .env          # then edit: set JWT_SECRET / SESSION_SECRET / ENCRYPTION_KEY
docker compose up -d --build  # build image + start detached
curl http://127.0.0.1:3011/api/health
```

The container is named `finman`, listens on 3000 inside and is bound to
**`127.0.0.1:3011`** on the host (a reverse proxy such as Caddy fronts it; the
port is never exposed publicly). The SQLite database `finman.db` is stored on
the named Docker volume **`finman-data`** (mounted at `/app/data`), so it
survives restarts, `docker compose down`, and image rebuilds. The entrypoint
chowns that directory to uid 1000 at start and drops to the `node` user, so a
root-owned volume from an older image keeps working.

Backups (online snapshot via `sqlite3 .backup` or `VACUUM INTO`, newest 14 kept
under `/app/data/backups/`):

```bash
docker exec finman /app/scripts/backup-db.sh
# host crontab — nightly at 03:15:
# 15 3 * * * docker exec finman /app/scripts/backup-db.sh >> /var/log/finman-backup.log 2>&1
```

See `DEPLOY.md` for the staging deploy and the production cutover procedure.

One-liner build + deploy + smoke test:

```bash
./scripts/deploy.sh
```

Stop / remove (DB volume is kept):

```bash
docker compose down           # keep data
docker compose down -v        # ALSO delete the finman-data volume (wipes the DB!)
```

### Option B — Local development

Requires **Node.js 22+**.

```bash
cp .env.example .env          # dev secrets auto-generate if unset (NODE_ENV != production)
npm install
npm run dev                   # nodemon, http://localhost:3000
# or: npm start               # plain node server.js
```

---

## Environment variables

Copy `.env.example` to `.env`. In **production** (`NODE_ENV=production`) the
secrets are **required** — the app fails fast on boot if they are missing. In
development they auto-generate (with a warning).

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default `3000`) | HTTP port the app listens on. |
| `NODE_ENV` | no (default `development`) | `development` or `production`. Production enforces real secrets. |
| `JWT_SECRET` | **prod** | Signing secret for Passport-JWT auth tokens. |
| `SESSION_SECRET` | **prod** | `express-session` cookie secret. |
| `ENCRYPTION_KEY` | **prod** | AES-256 key (64 hex chars) for encrypting stored bank tokens. |
| `DATABASE_PATH` | no | SQLite file path. Default `./data/finance.db` for local dev; Docker forces `/app/data/finman.db` (the production file name). `finance.db` is only a legacy local-dev fallback. |
| `COOKIE_DOMAIN` | no | Domain attribute of the `finman.sid` session cookie (e.g. `.finman.money`). Unset = host-only. |
| `CORS_ORIGIN` | no | Comma-separated allowed browser origins in production (e.g. `https://app.finman.money,https://finman.money`). `capacitor://localhost` and `http://localhost` (mobile shells) are always allowed. |
| `LOG_LEVEL` | no | pino level (`info` default). |
| `AI_PROVIDER` | no | `google` \| `gemini-oauth` \| `ollama` \| `openai` \| `anthropic` (opt-in). Empty = auto-detect: google → gemini-oauth → ollama → openai. |
| `AI_API_KEY` | for AI | Generic key for the chosen provider (Google Gemini by default). Provider-specific keys below win when set. Without any key, AI endpoints return `503 AI_NOT_CONFIGURED`. |
| `GOOGLE_API_KEY` | for google | Gemini API key (REST `generativelanguage.googleapis.com`). Default model `gemini-2.5-flash`. |
| `GEMINI_CLIENT_ID` / `GEMINI_CLIENT_SECRET` / `GEMINI_REFRESH_TOKEN` (or `GEMINI_OAUTH_CREDS`) | for gemini-oauth | Google OAuth refresh-token flow (cloudcode-pa). |
| `OLLAMA_API_KEY` (or `OLLAMA_API_KEY_FILE`) | for ollama | Ollama Cloud key (`https://ollama.com`). A local Ollama needs `AI_BASE_URL` instead of a key. |
| `OPENAI_API_KEY` | for openai | OpenAI or any OpenAI-compatible server (`AI_BASE_URL` for gateways). |
| `ANTHROPIC_API_KEY` | optional | Only with `AI_PROVIDER=anthropic`; never selected automatically. |
| `AI_MODEL` | no | Model id override (e.g. `gemini-2.5-pro`, `gpt-oss:120b`, `gpt-4o-mini`). |
| `AI_BASE_URL` | no | Base URL override for the env provider (local Ollama, OpenAI-compatible gateway, Gemini proxy). |
| `AI_MAX_TOKENS` | no | Max output tokens per answer (default `1024`). |
| `SYNC_ENABLED` | for sync | `true` to enable scheduled bank auto-sync. |
| `STRIPE_SECRET_KEY` | for billing | Stripe secret key for the subscription/billing flow. |
| `STRIPE_WEBHOOK_SECRET` | for billing | Stripe webhook signing secret (`whsec_...`). |
| `DEMO_MODE` | no | Marks a demo instance: `/api/health` returns `demo:true`, billing/AI replies carry `_meta.demo`. |
| `DEMO_SEED_ON_EMPTY` | no | `1` = at boot, when the `users` table is empty, seed the demo household (user `demo`). For staging without a persistent DB; see DEPLOY.md. Never set on production. |
| `DEMO_PASSWORD` | no | Password of the seeded `demo` / `demo-partner` accounts (default `finman-demo-2026`). |

### Demo data

`DEMO_SEED_ON_EMPTY=1` makes the server seed a realistic Canadian household the
first time it starts on an empty database: user `demo` (`demo@finman.money`,
password `DEMO_PASSWORD`, default `finman-demo-2026`), three accounts (CAD
chequing, CAD credit card, USD savings), about 190 transactions over the last
six months (biweekly payroll, weekly groceries, rent, hydro, internet, phone,
four subscriptions, two credit-card payments as transfers), two budgets, two
goals, a car loan with five linked payments, a TFSA portfolio (XEQT, VFV, BTC),
recurring payments, two rules and a two-member family (`demo-partner`). All
dates are relative to today (`lib/dates.js`), amounts come from a seeded PRNG,
and everything is written through the model layer (`lib/demoSeed.js`), so
balances equal opening balance + ledger and analytics exclude the opening rows.
A database that already has a user is never touched. The same seed runs by hand
with `node scripts/seed-demo.js` (`--force` adds the demo user next to existing
users on a local checkout). `GET /api/health/demo` tells the frontend whether
to show the "Demo instance — data resets" banner.

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Tests

Jest + Supertest. Each suite runs against an isolated temporary SQLite database.

```bash
npm test            # jest --runInBand
npm run test:watch
```

CI (`.github/workflows/ci.yml`) runs `npm ci` + `npm test` on Node 22 for every
push/PR, then verifies the Docker image builds.

---

## Architecture

```
Browser (vanilla JS, public/)  ──HTTP/JSON──►  Express app (server.js)
                                                   │
                          Passport-JWT auth ───────┤
                                                   │
        Route modules (routes/*.js)  ──►  Services (services/*.js)
                                                   │
                                        db helpers (db/database.js)
                                                   │
                                          SQLite file (data/finance.db)
```

- **Backend:** Node.js + Express. Security via `helmet`, `cors`, rate limiting,
  and `express-session`. Structured logging via `pino` / `pino-http`.
- **Auth:** Passport with a JWT strategy (`Authorization: Bearer <token>`).
- **Database:** a single SQLite file (`data/finance.db`). Schema is created on
  boot by `initDatabase()`, then additive migrations run via `lib/migrate.js`
  (`migrations/*.js`). Access through the promise helpers `query` / `get` / `run`.
- **Shared libs:** `lib/money.js` (float-safe money math), `lib/respond.js`
  (uniform `{success,data}` / `{success,error}` envelopes), `lib/ai/provider.js`
  (provider-agnostic AI client), and middleware (`error.js`, `authorize.js`,
  `requireTier.js`).
- **Frontend:** static HTML/CSS/JS in `public/` — no build step; scripts are
  loaded via `<script>` tags. Express serves it and the SPA catch-all (which
  deliberately does **not** swallow `/api/*`).
- **Mobile:** Capacitor shells for Android/iOS wrap the same web app.

### Health & readiness

| Endpoint | Returns |
|---|---|
| `GET /api/health` | Liveness: `{ status:"ok", uptime, version }`. Used by the Docker `HEALTHCHECK`. |
| `GET /api/ready` | Readiness: checks the DB responds; `503` if not. |

---

## Feature status

Core finance features work out of the box with just the required secrets.
Some features are **gated on additional keys** and stay inactive (returning a
clear error or `503`) until configured — they never break the rest of the app.

| Feature | Status | Needs |
|---|---|---|
| Accounts, transactions, categories | Ready | — |
| Budgets | Ready | — |
| Savings goals | Ready | — |
| Debts & credits | Ready | — |
| Family / shared finances & permissions | Ready | — |
| Expense splitting | Ready | — |
| Recurring payments, subscriptions | Ready | — |
| Investments & net worth | Ready | — |
| Financial calendar, dashboard widgets, reports | Ready | — |
| CSV import | Ready | — |
| Receipt OCR (tesseract.js) | Ready | Offline fallback; see Receipt vision below. |
| Manual bank sync (Monobank / Revolut / Tinkoff) | Ready | Per-user bank token entered in-app (encrypted with `ENCRYPTION_KEY`). |
| **Scheduled bank auto-sync** | Gated | `SYNC_ENABLED=true` + per-user bank tokens. |
| **AI CFO (chat, streaming, plan, what-if, categorize, insights)** | Gated | Any configured provider (see AI vars). Returns `503 AI_NOT_CONFIGURED` otherwise. The `pro` tier is required only when billing (`STRIPE_SECRET_KEY`) is configured; without billing every authenticated user gets AI. |
| **Insights block (digest, alerts, monthly story, weekly brief)** | Ready | `GET /api/ai/digest`, `/alerts`, `/insights/monthly` (cached in `ai_insights`), `/insights/weekly`. Digest and alerts are deterministic; stories fall back to deterministic text without a provider. |
| **Receipt vision** | Gated | Uses the AI provider's vision (google / gemini-oauth / openai) first, tesseract.js fallback. |
| **Billing / subscription tiers** | Gated | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. |
| **Anomaly detection** | Gated | Authenticated; functionality depends on the F7 feature stream. |

> Note: AI, billing, sync, and anomaly endpoints may be wired as stubs in this
> branch and are filled in by their respective feature streams. The keys above
> are what they require once implemented.

---

## Project layout

```
server.js            Express app wiring (exports `app`; listens only when run directly)
config/config.js     Env-driven config (port, secrets, DB path, CORS, token crypto)
db/database.js       SQLite connection, schema init, query/get/run helpers
lib/                 money, respond, logger, migrate, ai/provider, validateEnv
middleware/          error (AppError + errorHandler), authorize, requireTier
migrations/          additive schema migrations (run after initDatabase)
routes/              REST endpoints (auth, accounts, transactions, … health, ai, billing, sync)
services/            bank API sync, auth, CSV import, etc.
public/              static frontend (HTML/CSS/JS, no build step)
test/                Jest + Supertest suites (isolated temp DB per suite)
Dockerfile           multi-stage production image (entrypoint drops to `node`, healthcheck)
docker-entrypoint.sh chown data volume -> setpriv to uid 1000 -> node server.js
docker-compose.yml   `finman` service, 127.0.0.1:3011, persistent finman-data volume
scripts/deploy.sh    build + compose up + /api/health smoke test
scripts/backup-db.sh online SQLite backup to /app/data/backups (keeps 14)
DEPLOY.md            staging deploy + production cutover / rollback
```

---

## License

ISC.
