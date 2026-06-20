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
curl http://localhost:3000/api/health
```

The SQLite database is stored on the named Docker volume **`finman-data`**
(mounted at `/app/data`), so it survives restarts, `docker compose down`, and
image rebuilds.

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
| `DATABASE_PATH` | no | SQLite file path. Default `./data/finance.db`; Docker forces `/app/data/finance.db`. |
| `CORS_ORIGIN` | no | Allowed browser origin in production (set to your domain). |
| `LOG_LEVEL` | no | pino level (`info` default). |
| `AI_PROVIDER` | no | `anthropic` \| `openai` \| `ollama` (default `anthropic`). |
| `AI_API_KEY` | for AI | API key for the AI provider. Without it, AI endpoints return `503 AI_NOT_CONFIGURED`. |
| `AI_MODEL` | no | Model id (e.g. `claude-3-5-sonnet-latest`, `gpt-4o-mini`). |
| `AI_BASE_URL` | no | Override the provider base URL (e.g. Ollama / gateway). |
| `SYNC_ENABLED` | for sync | `true` to enable scheduled bank auto-sync. |
| `STRIPE_SECRET_KEY` | for billing | Stripe secret key for the subscription/billing flow. |
| `STRIPE_WEBHOOK_SECRET` | for billing | Stripe webhook signing secret (`whsec_...`). |

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
| Receipt OCR (tesseract.js) | Ready | — |
| Manual bank sync (Monobank / Revolut / Tinkoff) | Ready | Per-user bank token entered in-app (encrypted with `ENCRYPTION_KEY`). |
| **Scheduled bank auto-sync** | Gated | `SYNC_ENABLED=true` + per-user bank tokens. |
| **AI assistant** | Gated | `AI_API_KEY` (+ `AI_PROVIDER` / `AI_MODEL`). Returns `503 AI_NOT_CONFIGURED` otherwise. Requires `pro` tier. |
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
Dockerfile           multi-stage production image (non-root, healthcheck)
docker-compose.yml   app service + persistent finman-data volume
scripts/deploy.sh    build + compose up + /api/health smoke test
```

---

## License

ISC.
