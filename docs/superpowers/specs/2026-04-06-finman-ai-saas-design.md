# Finman v2 — AI-Powered SaaS Finance Manager

**Date:** 2026-04-06  
**Status:** Approved  
**Approach:** Additive — build on top of existing ~24k-line finman codebase, no rewrites

---

## 1. Scope

Four parallel workstreams:

1. **Localization** — EN UI, USD/EUR/CAD defaults, remove RUB hardcoding
2. **SaaS multi-tenancy** — organization layer for multi-user/client support
3. **Multi-model AI service** — Anthropic / OpenAI / Google, switchable via `.env`
4. **AI features** — Chat CFO, auto-categorization, receipt scanning, monthly story, weekly brief

---

## 2. Localization

**Goal:** Full English UI, North American currency defaults.

- Replace all Russian strings in `public/js/` (app.js, accounts.js, transactions.js, currency.js, receipts.js, family.js, dashboard.js, and all others)
- Replace Russian strings in `public/index.html` and `public/css/`
- Change default currency from `RUB` to `USD` everywhere (DB schema default, frontend dropdowns, bank-api-config)
- Currency options: USD, EUR, CAD, GBP, AUD, CHF (remove RUB)
- Update `public/manifest.json` name/short_name to "FinMan"
- Update `server.js` and config error messages to English
- Update `package.json` description, keywords to English

---

## 3. SaaS Multi-tenancy

**Goal:** Each client (organization) is isolated. One user can belong to one org. Invite flow via email token.

### DB changes (`db/database.js`)

New table `organizations`:
```sql
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',        -- free | pro | team
  ai_provider TEXT DEFAULT NULL,   -- which AI provider this org uses
  ai_model TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

New table `organization_members`:
```sql
CREATE TABLE IF NOT EXISTS organization_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT DEFAULT 'member',      -- owner | admin | member
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(org_id, user_id)
)
```

New table `invites`:
```sql
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'member',
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES organizations(id)
)
```

Add `org_id` column to `users` table (ALTER TABLE migration on startup).

### Auth flow changes

- On register: auto-create personal org, assign user as owner, set `users.org_id`
- JWT payload includes `{ userId, orgId, role }`
- All data routes scope queries by `req.user.orgId` (replaces `req.user.id` for data isolation)
- Existing `family` module routes → deprecated in favor of org system (keep for backwards compat but don't expose in new UI)

### New routes (`routes/organizations.js`)

- `GET /api/org` — get current org info
- `PATCH /api/org` — update name, plan, AI settings (owner only)
- `GET /api/org/members` — list members
- `POST /api/org/invite` — send invite (generates token, returns invite link)
- `POST /api/org/invite/accept/:token` — accept invite
- `DELETE /api/org/members/:userId` — remove member (owner/admin)

### Frontend

- Settings page: "Organization" tab with member list, invite form, plan info
- Registration flow: org name field (optional, defaults to user's name)

---

## 4. Multi-Model AI Service

**File:** `services/aiService.js`

### Config (`.env`)

```
AI_PROVIDER=anthropic          # anthropic | openai | google
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
AI_MODEL=                      # optional override; defaults per provider
AI_MAX_TOKENS=2048
```

### Interface

```js
class AIService {
  async chat(messages, tools)     // → { content, toolCalls }
  async complete(prompt, opts)    // → string
  async vision(imageBase64, prompt) // → string (for receipt scanning)
  isConfigured()                  // → bool
  getProvider()                   // → 'anthropic' | 'openai' | 'google' | null
}
```

### Provider defaults

| Provider | Default model | Vision |
|---|---|---|
| anthropic | claude-sonnet-4-5 | claude-sonnet-4-5 (vision capable) |
| openai | gpt-4o | gpt-4o |
| google | gemini-1.5-pro | gemini-1.5-pro |

### Dependencies to add

```
@anthropic-ai/sdk
openai
@google/generative-ai
```

### Tool definitions (for Chat CFO)

Five tools the AI can call:
1. `get_spending_summary(period, category?)` — aggregated spend by category
2. `get_transactions(filters)` — filtered transaction list
3. `get_budget_status()` — current budgets vs actuals
4. `get_accounts()` — account balances
5. `add_transaction(date, description, amount, category, accountId)` — create transaction

---

## 5. AI Features

### 5.1 AI Chat CFO

**Route:** `POST /api/ai/chat`  
**Auth:** JWT required  
**Body:** `{ messages: [{role, content}], sessionId? }`

Flow:
1. Load user's financial context (last 90 days transactions summary, accounts, budgets)
2. Send to AI with system prompt: "You are a personal CFO for {user}. You have access to their financial data via tools..."
3. Execute tool calls against the DB with `req.user.orgId` scope
4. Return final response

**Frontend:** Floating chat button (bottom-right), opens slide-over panel. Persists session in localStorage. Shows tool usage as "Checking your transactions..." status.

### 5.2 Auto-Categorization

**Route:** `POST /api/ai/categorize`  
**Body:** `{ description, amount, type }`  
**Returns:** `{ category, confidence }`

Called automatically:
- When user creates a transaction (before save, enriches the payload)
- During CSV import (batch, up to 50 transactions at once)

Falls back to keyword matching if AI unavailable or `isConfigured()` is false.

### 5.3 Receipt Scanner

**Route:** `POST /api/ai/receipt`  
**Body:** multipart form — `image` file  
**Returns:** `{ merchant, amount, date, category, items[], currency, confidence }`

Flow:
1. Accept image upload (multer, max 10MB, jpg/png/webp/pdf)
2. Convert to base64
3. Send to vision API with extraction prompt
4. Return structured data → frontend pre-fills transaction form

Integrated into existing receipts page — "Scan Receipt" button triggers file picker → auto-fills form fields.

### 5.4 Monthly Story

**Route:** `GET /api/ai/insights/monthly?year=YYYY&month=MM`  
**Returns:** `{ story, highlights[], warnings[], score }`

Generates narrative from:
- Transaction totals by category vs previous month
- Budget adherence
- Recurring payments status
- Notable large transactions
- Net worth change

Cached in DB table `ai_insights` (org_id, period, type, content, generated_at). Regenerates if older than 24h.

### 5.5 Weekly Brief

**Route:** `GET /api/ai/insights/weekly`  
**Returns:** `{ brief, actionItems[], upcomingPayments[] }`

CFO-style briefing:
- Spending pace this week vs weekly budget
- Budget alerts (>80% used)
- Upcoming recurring payments (next 7 days)
- One actionable recommendation

Available on-demand + optionally via cron (if email configured).

---

## 6. Frontend AI Components

### AI Chat Panel (`public/js/ai-chat.js`)

- Floating button (bottom-right, 56px circle, gradient)
- Slide-over drawer (right side, 400px wide)
- Message thread with markdown rendering
- Tool status indicators: "Analyzing your transactions..."
- Suggested prompts on first open: "How much did I spend this month?", "Show me my biggest expenses", "Am I on track with my budget?"
- "Add transaction" shortcut: natural language → AI parses → confirms with user → saves

### AI Insights Widget (`public/js/ai-insights.js`)

- Dashboard card: "Monthly Story" with rendered narrative
- Refresh button
- Score indicator (0-100 financial health score)
- Highlights and warnings as colored chips

### Receipt Scanner Enhancement

- Upgrade existing receipt upload UI to auto-scan on file select
- Show extraction results for confirmation before saving
- "Scan Another" flow

### AI Settings (`public/js/settings.js` addition)

- AI Provider selector (shows which is active per env)
- Test connection button
- Usage stats (tokens used this month)
- Enable/disable AI features toggle

---

## 7. DB Migration for AI

New table `ai_insights`:
```sql
CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,      -- e.g. "2026-04" or "2026-W14"
  type TEXT NOT NULL,        -- "monthly" | "weekly"
  content TEXT NOT NULL,     -- JSON
  model TEXT,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, period, type)
)
```

New table `ai_chat_sessions`:
```sql
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  messages TEXT NOT NULL,    -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

---

## 8. What to Fix (Code Review Notes)

- `services/services/csvImportService.js` duplicate path — already fixed by merge
- `package.json` missing `npm install` for new AI deps — add to setup
- `public/index.html` CSP allows `unsafe-inline` scripts — keep for now (SPA pattern)
- Default currency `RUB` in accounts table schema — change to `USD`
- `server.js` error messages still in Russian — translate
- `config/bank-api-config.js` Russian bank references — remove, keep international banks only
- Stash pop after merge — restore any uncommitted work

---

## 9. Startup Program Positioning

Multi-provider design means:
- **Apply to Anthropic** → use Claude, show in demo
- **Apply to OpenAI** → switch `AI_PROVIDER=openai` in `.env`, same codebase
- **Apply to Google** → same with Gemini
- Each application narrative: "AI-native personal finance SaaS — replaces manual budgeting with conversational AI CFO, receipt scanning, and predictive insights"

Demo script: Register → connect test bank → upload receipt → chat "how's my budget?" → view monthly story.

---

## 10. Deployment

Local dev:
```
npm install
cp .env.example .env   # add API key
npm run dev
```

Production (Docker):
- Add Dockerfile + docker-compose.yml
- Volume mount for SQLite data
- Env vars via .env or secrets

Push to `main` branch on GitHub (`ctmakc/finman`).
