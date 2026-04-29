# Finman AI SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform finman into an English-language AI-powered SaaS personal finance manager with multi-tenant organizations, multi-provider AI (Anthropic/OpenAI/Google), AI Chat CFO, receipt scanning, auto-categorization, and monthly financial stories.

**Architecture:** Additive layer on top of existing ~24k-line Node.js/Express + SQLite + vanilla-JS SPA. New AI service abstracts all LLM providers. SaaS tenancy adds organizations table + org_id scoping. Frontend gets floating AI chat panel + insights widget.

**Tech Stack:** Node.js/Express, SQLite (sqlite3), vanilla JS SPA, Chart.js, @anthropic-ai/sdk, openai, @google/generative-ai, DOMPurify (XSS safety), multer, helmet

---

## File Map

New files: services/aiService.js, routes/ai.js, routes/organizations.js, models/organization.js, public/js/ai-chat.js, public/js/ai-insights.js, .env.example, Dockerfile, docker-compose.yml

Modified: db/database.js, config/config.js, services/authService.js, routes/auth.js, models/user.js, package.json, public/index.html, public/js/app.js, public/js/accounts.js, public/js/transactions.js, public/js/receipts.js, public/js/dashboard.js, public/css/style.css, server.js

---

## Task 1: Install Dependencies + .env.example

- [ ] Install AI SDKs and DOMPurify:
```bash
cd /home/llm/projects/finman
npm install @anthropic-ai/sdk openai @google/generative-ai dompurify jsdom
```

- [ ] Update package.json name/version/description:
```json
"name": "finman",
"version": "2.0.0",
"description": "AI-powered personal finance manager with multi-provider LLM support",
"keywords": ["finance", "budget", "ai", "personal-finance", "saas"]
```

- [ ] Create /home/llm/projects/finman/.env.example:
```
PORT=3000
NODE_ENV=development
JWT_SECRET=change-me-in-production
SESSION_SECRET=change-me-in-production
ENCRYPTION_KEY=change-me-64-hex-chars
DATABASE_PATH=./data/finance.db
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
AI_MODEL=
AI_MAX_TOKENS=2048
CORS_ORIGIN=http://localhost:3000
```

- [ ] Create .env from example if missing:
```bash
[ -f /home/llm/projects/finman/.env ] || cp /home/llm/projects/finman/.env.example /home/llm/projects/finman/.env
```

- [ ] Verify SDKs load:
```bash
node -e "require('@anthropic-ai/sdk'); require('openai'); require('@google/generative-ai'); require('dompurify'); console.log('OK')"
```
Expected: OK

- [ ] Commit:
```bash
git add package.json package-lock.json .env.example && git commit -m "feat: add AI SDK and DOMPurify dependencies"
```

---

## Task 2: Database Migrations

Modify: db/database.js

- [ ] Add 5 new tables inside the initDatabase() db.serialize() block, after existing tables:

```javascript
db.run(`CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',
  ai_provider TEXT DEFAULT NULL,
  ai_model TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => { if (err) console.error('Error creating organizations table:', err); });

db.run(`CREATE TABLE IF NOT EXISTS organization_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT DEFAULT 'member',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(org_id, user_id)
)`, (err) => { if (err) console.error('Error creating organization_members table:', err); });

db.run(`CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'member',
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
)`, (err) => { if (err) console.error('Error creating invites table:', err); });

db.run(`CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, period, type)
)`, (err) => { if (err) console.error('Error creating ai_insights table:', err); });

db.run(`CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT UNIQUE NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => { if (err) console.error('Error creating ai_chat_sessions table:', err); });
```

- [ ] Add org_id migration to users (after the tables above):
```javascript
db.run(`ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)`,
  (err) => { if (err && !err.message.includes('duplicate column')) console.error('Migration error:', err); }
);
```

- [ ] Verify tables created:
```bash
PORT=3334 node -e "
const {initDatabase, query} = require('/home/llm/projects/finman/db/database');
initDatabase().then(() => query(\"SELECT name FROM sqlite_master WHERE type='table'\").then(r => { console.log(r.map(x=>x.name).join(', ')); process.exit(0); })).catch(e=>{console.error(e);process.exit(1);});
" 2>/dev/null
```
Expected: output includes organizations, organization_members, invites, ai_insights, ai_chat_sessions

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add db/database.js && git commit -m "feat: add org, invite, ai_insights, ai_chat_sessions tables"
```

---

## Task 3: Organization Model

Create: models/organization.js

- [ ] Create /home/llm/projects/finman/models/organization.js:

```javascript
const { query, get, run } = require('../db/database');
const crypto = require('crypto');

class Organization {
  static async create({ name, ownerId }) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      + '-' + crypto.randomBytes(3).toString('hex');
    const org = await run(`INSERT INTO organizations (name, slug) VALUES (?, ?)`, [name, slug]);
    await run(`INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, [org.id, ownerId]);
    await run(`UPDATE users SET org_id = ? WHERE id = ?`, [org.id, ownerId]);
    return { id: org.id, name, slug, plan: 'free', role: 'owner' };
  }

  static async findById(orgId) {
    return get(`SELECT * FROM organizations WHERE id = ?`, [orgId]);
  }

  static async getMembers(orgId) {
    return query(
      `SELECT u.id, u.username, u.email, u.full_name, om.role, om.created_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? ORDER BY om.created_at ASC`,
      [orgId]
    );
  }

  static async getMemberRole(orgId, userId) {
    const row = await get(`SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?`, [orgId, userId]);
    return row ? row.role : null;
  }

  static async removeMember(orgId, userId) {
    return run(`DELETE FROM organization_members WHERE org_id = ? AND user_id = ? AND role != 'owner'`, [orgId, userId]);
  }

  static async createInvite({ orgId, email, role = 'member' }) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await run(`INSERT INTO invites (org_id, email, token, role, expires_at) VALUES (?, ?, ?, ?, ?)`, [orgId, email, token, role, expiresAt]);
    return token;
  }

  static async findInvite(token) {
    return get(`SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`, [token]);
  }

  static async useInvite(token, userId) {
    const invite = await this.findInvite(token);
    if (!invite) throw new Error('Invalid or expired invite');
    await run(`INSERT OR IGNORE INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?)`, [invite.org_id, userId, invite.role]);
    await run(`UPDATE users SET org_id = ? WHERE id = ?`, [invite.org_id, userId]);
    await run(`UPDATE invites SET used_at = datetime('now') WHERE token = ?`, [token]);
    return invite;
  }

  static async update(orgId, fields) {
    const allowed = ['name', 'plan', 'ai_provider', 'ai_model'];
    const updates = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
    if (updates.length === 0) return;
    const sql = `UPDATE organizations SET ${updates.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`;
    return run(sql, [...updates.map(k => fields[k]), orgId]);
  }
}

module.exports = Organization;
```

- [ ] Verify model loads:
```bash
node -e "const O = require('/home/llm/projects/finman/models/organization'); console.log(typeof O.create, typeof O.findById);"
```
Expected: function function

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add models/organization.js && git commit -m "feat: add Organization model with invite flow"
```

---

## Task 4: SaaS Auth — org creation on register + orgId in JWT

Modify: routes/auth.js, services/authService.js

- [ ] Add Organization require at top of routes/auth.js:
```javascript
const Organization = require('../models/organization');
```

- [ ] In register route, find where JWT token is signed. Replace:
```javascript
const token = jwt.sign({ id: newUser.id }, config.jwtSecret, { expiresIn: config.jwtExpiration });
```
With:
```javascript
const org = await Organization.create({ name: fullName || username, ownerId: newUser.id });
const token = jwt.sign({ id: newUser.id, orgId: org.id, role: 'owner' }, config.jwtSecret, { expiresIn: config.jwtExpiration });
```

- [ ] Translate all Russian message strings in routes/auth.js:
  - 'Необходимо указать имя пользователя, email и пароль' -> 'Username, email and password are required'
  - 'Некорректный формат email' -> 'Invalid email format'
  - 'Имя пользователя должно содержать 3-30 символов...' -> 'Username must be 3-30 characters (letters, digits, underscores)'
  - 'Пароль должен содержать минимум 6 символов' -> 'Password must be at least 6 characters'
  - 'Пользователь с таким именем уже существует' -> 'Username already taken'
  - 'Пользователь с таким email уже существует' -> 'Email already registered'
  - 'Произошла ошибка при регистрации' -> 'Registration failed'
  - 'Произошла ошибка при входе' -> 'Login failed'

- [ ] In services/authService.js, update JWT strategy to attach orgId:

Find the JwtStrategy callback:
```javascript
passport.use(new JwtStrategy(jwtOptions, async function(jwtPayload, done) {
  try {
    const user = await User.findById(jwtPayload.id);
    if (!user) return done(null, false);
    return done(null, user);
  } catch (error) {
    return done(error, false);
  }
}));
```

Replace with:
```javascript
passport.use(new JwtStrategy(jwtOptions, async function(jwtPayload, done) {
  try {
    const user = await User.findById(jwtPayload.id);
    if (!user) return done(null, false);
    user.orgId = jwtPayload.orgId || user.org_id;
    user.role = jwtPayload.role || 'member';
    return done(null, user);
  } catch (error) {
    return done(error, false);
  }
}));
```

- [ ] Add /api/auth/me endpoint to routes/auth.js (if missing — check first):
```javascript
router.get('/me', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    email: req.user.email,
    full_name: req.user.full_name,
    orgId: req.user.orgId,
    role: req.user.role
  });
});
```

- [ ] Update /api/auth/validate to return orgId:
```javascript
router.get('/validate', passport.authenticate('jwt', { session: false }), (req, res) => {
  res.json({ valid: true, user: { id: req.user.id, username: req.user.username, orgId: req.user.orgId } });
});
```

- [ ] Add login auto-org creation for existing users (place before jwt.sign in login route):
```javascript
if (!user.org_id) {
  try {
    const org = await Organization.create({ name: user.username, ownerId: user.id });
    user.orgId = org.id;
    user.role = 'owner';
  } catch (e) {
    const row = await require('../db/database').get('SELECT org_id FROM users WHERE id = ?', [user.id]);
    user.orgId = row ? row.org_id : null;
    user.role = 'owner';
  }
}
```

- [ ] Verify register creates org:
```bash
PORT=3334 node /home/llm/projects/finman/server.js &
sleep 2
curl -s -X POST http://localhost:3334/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"orgtest1","email":"orgtest1@test.com","password":"test1234"}' | python3 -m json.tool
kill %1
```
Expected: token + user object with no errors

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add routes/auth.js services/authService.js && git commit -m "feat: create org on register, include orgId in JWT"
```

---

## Task 5: Organizations API Routes

Create: routes/organizations.js; Modify: server.js

- [ ] Create /home/llm/projects/finman/routes/organizations.js:

```javascript
const express = require('express');
const passport = require('passport');
const Organization = require('../models/organization');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });

router.get('/', authenticate, async (req, res) => {
  try {
    if (!req.user.orgId) return res.status(404).json({ error: true, message: 'No organization found' });
    const org = await Organization.findById(req.user.orgId);
    res.json(org || { error: true, message: 'Not found' });
  } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

router.patch('/', authenticate, async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.user.role))
      return res.status(403).json({ error: true, message: 'Insufficient permissions' });
    await Organization.update(req.user.orgId, req.body);
    res.json(await Organization.findById(req.user.orgId));
  } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

router.get('/members', authenticate, async (req, res) => {
  try {
    res.json(req.user.orgId ? await Organization.getMembers(req.user.orgId) : []);
  } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

router.post('/invite', authenticate, async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.user.role))
      return res.status(403).json({ error: true, message: 'Insufficient permissions' });
    const { email, role = 'member' } = req.body;
    if (!email) return res.status(400).json({ error: true, message: 'Email required' });
    const token = await Organization.createInvite({ orgId: req.user.orgId, email, role });
    const base = process.env.APP_URL || 'http://localhost:3000';
    res.json({ token, inviteUrl: base + '/invite/' + token });
  } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

router.post('/invite/accept/:token', authenticate, async (req, res) => {
  try {
    const invite = await Organization.useInvite(req.params.token, req.user.id);
    res.json({ success: true, orgId: invite.org_id, role: invite.role });
  } catch (err) { res.status(400).json({ error: true, message: err.message }); }
});

router.delete('/members/:userId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: true, message: 'Owner only' });
    if (parseInt(req.params.userId) === req.user.id)
      return res.status(400).json({ error: true, message: 'Cannot remove yourself' });
    await Organization.removeMember(req.user.orgId, parseInt(req.params.userId));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: true, message: err.message }); }
});

module.exports = router;
```

- [ ] In server.js add import + route:
```javascript
const organizationsRoutes = require('./routes/organizations');
// ...
app.use('/api/org', organizationsRoutes);
```

- [ ] Translate server.js log messages:
  - 'Сервер запущен на порту' -> 'Server running on port'
  - 'Откройте http://localhost' -> 'Open http://localhost'

- [ ] Add health endpoint to server.js (before SPA catch-all):
```javascript
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', provider: process.env.AI_PROVIDER || 'none' });
});
```

- [ ] Test:
```bash
PORT=3334 node /home/llm/projects/finman/server.js &
sleep 2
curl -s http://localhost:3334/api/health
kill %1
```
Expected: {"status":"ok","version":"2.0.0"}

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add routes/organizations.js server.js && git commit -m "feat: add orgs API, health endpoint, translate server logs"
```

---

## Task 6: Multi-Model AI Service

Create: services/aiService.js

- [ ] Create /home/llm/projects/finman/services/aiService.js:

```javascript
class AIService {
  constructor() {
    this._provider = process.env.AI_PROVIDER || null;
    this._model = process.env.AI_MODEL || null;
    this._maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 2048;
    this._client = null;
    this._init();
  }

  _init() {
    if (!this._provider) return;
    try {
      if (this._provider === 'anthropic') {
        const Anthropic = require('@anthropic-ai/sdk');
        this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        if (!this._model) this._model = 'claude-sonnet-4-5';
      } else if (this._provider === 'openai') {
        const OpenAI = require('openai');
        this._client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        if (!this._model) this._model = 'gpt-4o';
      } else if (this._provider === 'google') {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        this._client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        if (!this._model) this._model = 'gemini-1.5-pro';
      }
    } catch (e) {
      console.warn('AI provider init failed:', e.message);
      this._client = null;
    }
  }

  isConfigured() { return !!this._client; }
  getProvider() { return this._provider; }
  getModel() { return this._model; }

  async complete(prompt, opts = {}) {
    if (!this._client) throw new Error('AI provider not configured');
    const maxTokens = opts.maxTokens || this._maxTokens;
    if (this._provider === 'anthropic') {
      const msg = await this._client.messages.create({ model: this._model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
      return msg.content[0].text;
    } else if (this._provider === 'openai') {
      const resp = await this._client.chat.completions.create({ model: this._model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
      return resp.choices[0].message.content;
    } else if (this._provider === 'google') {
      const genModel = this._client.getGenerativeModel({ model: this._model });
      const result = await genModel.generateContent(prompt);
      return result.response.text();
    }
  }

  async chat(messages, tools = [], systemPrompt = '') {
    if (!this._client) throw new Error('AI provider not configured');
    if (this._provider === 'anthropic') {
      const params = { model: this._model, max_tokens: this._maxTokens, messages };
      if (systemPrompt) params.system = systemPrompt;
      if (tools.length > 0) params.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      const resp = await this._client.messages.create(params);
      return {
        content: resp.content.filter(b => b.type === 'text').map(b => b.text).join(''),
        toolCalls: resp.content.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input, id: b.id })),
        stopReason: resp.stop_reason
      };
    } else if (this._provider === 'openai') {
      const params = { model: this._model, max_tokens: this._maxTokens, messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages };
      if (tools.length > 0) params.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || t.input_schema } }));
      const resp = await this._client.chat.completions.create(params);
      const msg = resp.choices[0].message;
      return {
        content: msg.content || '',
        toolCalls: (msg.tool_calls || []).map(tc => ({ name: tc.function.name, input: JSON.parse(tc.function.arguments), id: tc.id })),
        stopReason: resp.choices[0].finish_reason
      };
    } else if (this._provider === 'google') {
      const genModel = this._client.getGenerativeModel({ model: this._model });
      const history = messages.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'model' : m.role, parts: [{ text: m.content }] }));
      const chat = genModel.startChat({ history });
      const result = await chat.sendMessage(messages[messages.length - 1].content);
      return { content: result.response.text(), toolCalls: [], stopReason: 'end_turn' };
    }
  }

  async vision(imageBase64, mimeType, prompt) {
    if (!this._client) throw new Error('AI provider not configured');
    if (this._provider === 'anthropic') {
      const resp = await this._client.messages.create({ model: this._model, max_tokens: this._maxTokens, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } }, { type: 'text', text: prompt }] }] });
      return resp.content[0].text;
    } else if (this._provider === 'openai') {
      const resp = await this._client.chat.completions.create({ model: this._model, max_tokens: this._maxTokens, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imageBase64 } }, { type: 'text', text: prompt }] }] });
      return resp.choices[0].message.content;
    } else if (this._provider === 'google') {
      const genModel = this._client.getGenerativeModel({ model: this._model });
      const result = await genModel.generateContent([{ inlineData: { data: imageBase64, mimeType } }, prompt]);
      return result.response.text();
    }
  }
}

module.exports = new AIService();
```

- [ ] Verify loads:
```bash
node -e "const ai = require('/home/llm/projects/finman/services/aiService'); console.log('provider:', ai.getProvider(), 'configured:', ai.isConfigured());"
```

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add services/aiService.js && git commit -m "feat: multi-provider AI service (Anthropic/OpenAI/Google)"
```

---

## Task 7: AI API Routes

Create: routes/ai.js; Modify: server.js

- [ ] Create /home/llm/projects/finman/routes/ai.js with the following sections:

**Imports and setup:**
```javascript
const express = require('express');
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const aiService = require('../services/aiService');
const { query, get, run } = require('../db/database');

const router = express.Router();
const authenticate = passport.authenticate('jwt', { session: false });
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'receipts'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only jpg, png, webp, pdf allowed'));
  }
});
```

**Status endpoint:**
```javascript
router.get('/status', authenticate, (req, res) => {
  res.json({ configured: aiService.isConfigured(), provider: aiService.getProvider(), model: aiService.getModel() });
});
```

**Tool definitions array** (add to routes/ai.js after status endpoint):
```javascript
const CHAT_TOOLS = [
  { name: 'get_spending_summary', description: 'Get spending totals by category for a period',
    input_schema: { type: 'object', properties: { period: { type: 'string', description: 'this_month|last_month|last_30_days|this_year' }, type: { type: 'string', enum: ['expense','income','all'] } }, required: ['period'] },
    parameters: { type: 'object', properties: { period: { type: 'string' }, type: { type: 'string' } }, required: ['period'] }
  },
  { name: 'get_transactions', description: 'Get filtered transaction list',
    input_schema: { type: 'object', properties: { category: { type: 'string' }, type: { type: 'string', enum: ['expense','income'] }, limit: { type: 'number' }, start_date: { type: 'string' }, end_date: { type: 'string' } } },
    parameters: { type: 'object', properties: { category: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' }, start_date: { type: 'string' }, end_date: { type: 'string' } } }
  },
  { name: 'get_budget_status', description: 'Get budgets vs actual spending this month',
    input_schema: { type: 'object', properties: {} },
    parameters: { type: 'object', properties: {} }
  },
  { name: 'get_accounts', description: 'Get all account balances',
    input_schema: { type: 'object', properties: {} },
    parameters: { type: 'object', properties: {} }
  },
  { name: 'add_transaction', description: 'Add a new transaction for the user',
    input_schema: { type: 'object', properties: { date: { type: 'string' }, description: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string', enum: ['expense','income'] }, category: { type: 'string' }, account_id: { type: 'number' } }, required: ['description','amount','type'] },
    parameters: { type: 'object', properties: { date: { type: 'string' }, description: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string' }, category: { type: 'string' }, account_id: { type: 'number' } }, required: ['description','amount','type'] }
  }
];
```

**Tool executor function** (add after CHAT_TOOLS):
```javascript
async function executeTool(name, input, userId) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const thisMonthStart = new Date(y, m, 1).toISOString().split('T')[0];
  const lastMonthStart = new Date(y, m-1, 1).toISOString().split('T')[0];
  const lastMonthEnd = new Date(y, m, 0).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  function periodDates(p) {
    if (p === 'last_month') return { start: lastMonthStart, end: lastMonthEnd };
    if (p === 'last_30_days') { const d = new Date(now); d.setDate(d.getDate()-30); return { start: d.toISOString().split('T')[0], end: today }; }
    if (p === 'this_year') return { start: y + '-01-01', end: today };
    return { start: thisMonthStart, end: today };
  }

  if (name === 'get_spending_summary') {
    const { start, end } = periodDates(input.period);
    const typeClause = input.type === 'income' ? "AND type='income'" : input.type === 'expense' ? "AND type='expense'" : '';
    const rows = await query(`SELECT category, type, SUM(ABS(amount)) as total, COUNT(*) as count FROM transactions WHERE user_id=? AND date BETWEEN ? AND ? ${typeClause} GROUP BY category,type ORDER BY total DESC`, [userId, start, end]);
    return { period: start + ' to ' + end, summary: rows };
  }
  if (name === 'get_transactions') {
    const conds = ['user_id=?'], params = [userId];
    if (input.category) { conds.push('category=?'); params.push(input.category); }
    if (input.type) { conds.push('type=?'); params.push(input.type); }
    if (input.start_date) { conds.push('date>=?'); params.push(input.start_date); }
    if (input.end_date) { conds.push('date<=?'); params.push(input.end_date); }
    params.push(input.limit || 20);
    return { transactions: await query(`SELECT id,date,description,category,amount,type FROM transactions WHERE ${conds.join(' AND ')} ORDER BY date DESC LIMIT ?`, params) };
  }
  if (name === 'get_budget_status') {
    const budgets = await query(`SELECT b.id,b.category,b.amount as budget_amount,COALESCE(SUM(ABS(t.amount)),0) as spent FROM budgets b LEFT JOIN transactions t ON t.category=b.category AND t.user_id=b.user_id AND t.type='expense' AND t.date>=? WHERE b.user_id=? GROUP BY b.id`, [thisMonthStart, userId]);
    return { budgets: budgets.map(b => ({ ...b, remaining: b.budget_amount - b.spent, pct_used: Math.round(b.spent / b.budget_amount * 100) })) };
  }
  if (name === 'get_accounts') {
    return { accounts: await query(`SELECT id,name,currency,balance,account_type FROM accounts WHERE user_id=? AND is_active=1`, [userId]) };
  }
  if (name === 'add_transaction') {
    let accountId = input.account_id;
    if (!accountId) { const acc = await get(`SELECT id FROM accounts WHERE user_id=? AND is_active=1 LIMIT 1`, [userId]); accountId = acc ? acc.id : null; }
    if (!accountId) return { error: 'No account found. Please create an account first.' };
    const amount = input.type === 'expense' ? -Math.abs(input.amount) : Math.abs(input.amount);
    const result = await run(`INSERT INTO transactions (account_id,user_id,date,description,category,amount,type) VALUES (?,?,?,?,?,?,?)`, [accountId, userId, input.date || today, input.description, input.category || 'Other', amount, input.type]);
    await run(`UPDATE accounts SET balance=balance+? WHERE id=?`, [amount, accountId]);
    return { success: true, transaction_id: result.id, message: 'Added ' + input.type + ' of $' + Math.abs(input.amount) + ' for "' + input.description + '"' };
  }
  return { error: 'Unknown tool: ' + name };
}
```

**Chat CFO route:**
```javascript
router.post('/chat', authenticate, async (req, res) => {
  if (!aiService.isConfigured()) return res.status(503).json({ error: true, message: 'AI provider not configured. Set AI_PROVIDER and API key in .env' });
  const { messages, sessionId } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: true, message: 'messages array required' });
  const systemPrompt = 'You are FinMan AI, a personal CFO. You have access to the user\'s financial data via tools. Be concise, specific, and actionable. Use dollar amounts and percentages. Confirm before calling add_transaction. Today is ' + new Date().toISOString().split('T')[0] + '.';
  try {
    let currentMessages = [...messages], finalResponse = '', iterations = 0;
    while (iterations++ < 5) {
      const result = await aiService.chat(currentMessages, CHAT_TOOLS, systemPrompt);
      if (!result.toolCalls.length) { finalResponse = result.content; break; }
      const toolResults = await Promise.all(result.toolCalls.map(async tc => ({ toolCallId: tc.id, toolName: tc.name, output: await executeTool(tc.name, tc.input, req.user.id) })));
      if (aiService.getProvider() === 'anthropic') {
        currentMessages.push({ role: 'assistant', content: result.toolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })) });
        currentMessages.push({ role: 'user', content: toolResults.map(tr => ({ type: 'tool_result', tool_use_id: tr.toolCallId, content: JSON.stringify(tr.output) })) });
      } else {
        currentMessages.push({ role: 'assistant', content: null, tool_calls: result.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) });
        toolResults.forEach(tr => currentMessages.push({ role: 'tool', tool_call_id: tr.toolCallId, content: JSON.stringify(tr.output) }));
      }
      if (result.stopReason === 'end_turn' || result.stopReason === 'stop') { finalResponse = result.content; break; }
    }
    if (sessionId) {
      const all = [...messages, { role: 'assistant', content: finalResponse }];
      await run(`INSERT INTO ai_chat_sessions (org_id,user_id,session_id,messages) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET messages=?,updated_at=datetime('now')`, [req.user.orgId, req.user.id, sessionId, JSON.stringify(all), JSON.stringify(all)]);
    }
    res.json({ response: finalResponse, model: aiService.getModel() });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});
```

**Categorize route:**
```javascript
router.post('/categorize', authenticate, async (req, res) => {
  const { description, amount, type } = req.body;
  if (!description) return res.status(400).json({ error: true, message: 'description required' });
  function keywordCategory(desc, type) {
    const d = desc.toLowerCase();
    if (type === 'income') {
      if (d.match(/salary|payroll|paycheck/)) return 'Salary';
      if (d.match(/dividend|interest/)) return 'Investment Income';
      if (d.match(/refund/)) return 'Refund';
      return 'Other Income';
    }
    if (d.match(/cafe|coffee|restaurant|pizza|burger|doordash|ubereats/)) return 'Dining';
    if (d.match(/grocery|supermarket|whole foods|trader joe|costco|walmart|kroger/)) return 'Groceries';
    if (d.match(/uber|lyft|taxi|transit|gas|fuel|parking/)) return 'Transport';
    if (d.match(/netflix|spotify|amazon prime|disney|hulu|subscription/)) return 'Subscriptions';
    if (d.match(/pharmacy|doctor|hospital|clinic|medical|dental/)) return 'Health';
    if (d.match(/rent|mortgage|hydro|electric|internet|utilities/)) return 'Housing';
    if (d.match(/amazon|shopping|clothing|shoes|mall/)) return 'Shopping';
    if (d.match(/gym|fitness|yoga/)) return 'Fitness';
    if (d.match(/hotel|airbnb|flight|airline|travel/)) return 'Travel';
    return 'Other';
  }
  if (!aiService.isConfigured()) return res.json({ category: keywordCategory(description, type), confidence: 'low', source: 'keyword' });
  try {
    const prompt = 'Categorize this transaction into exactly one category. Return ONLY the category name, nothing else.\n\nTransaction: "' + description + '" | Amount: $' + Math.abs(amount||0) + ' | Type: ' + (type||'expense') + '\n\nCategories: Groceries, Dining, Transport, Housing, Utilities, Shopping, Health, Fitness, Entertainment, Travel, Subscriptions, Education, Salary, Investment Income, Freelance, Refund, Transfer, Other Income, Other\n\nCategory:';
    const category = (await aiService.complete(prompt, { maxTokens: 20 })).trim().replace(/['".,\n]/g, '');
    res.json({ category, confidence: 'high', source: aiService.getProvider() });
  } catch (err) {
    res.json({ category: keywordCategory(description, type), confidence: 'low', source: 'keyword' });
  }
});
```

**Receipt scanner route:**
```javascript
router.post('/receipt', authenticate, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: true, message: 'Image file required' });
  if (!aiService.isConfigured()) { fs.unlink(req.file.path, ()=>{}); return res.status(503).json({ error: true, message: 'AI provider not configured' }); }
  try {
    const imageBase64 = fs.readFileSync(req.file.path).toString('base64');
    const mimeType = req.file.mimetype;
    fs.unlink(req.file.path, ()=>{});
    const prompt = 'Extract transaction details from this receipt. Return ONLY valid JSON:\n{"merchant":"store name","amount":0.00,"currency":"USD","date":"YYYY-MM-DD or null","category":"Groceries|Dining|Transport|Shopping|Health|Other","items":[],"tax":0.00,"tip":0.00}\nUse null for unknown fields. Amount = total paid.';
    const text = await aiService.vision(imageBase64, mimeType, prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse receipt');
    const data = JSON.parse(jsonMatch[0]);
    data.date = data.date || new Date().toISOString().split('T')[0];
    res.json({ ...data, model: aiService.getModel() });
  } catch (err) {
    console.error('Receipt error:', err.message);
    res.status(500).json({ error: true, message: 'Scan failed: ' + err.message });
  }
});
```

**Monthly story route:**
```javascript
router.get('/insights/monthly', authenticate, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const period = year + '-' + String(month).padStart(2,'0');
  const cached = await get(`SELECT * FROM ai_insights WHERE org_id=? AND period=? AND type='monthly' AND generated_at>datetime('now','-24 hours')`, [req.user.orgId, period]);
  if (cached) return res.json(JSON.parse(cached.content));
  if (!aiService.isConfigured()) return res.status(503).json({ error: true, message: 'AI not configured' });
  try {
    const startDate = period + '-01';
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];
    const prevStart = new Date(year, month-2, 1).toISOString().split('T')[0];
    const prevEnd = new Date(year, month-1, 0).toISOString().split('T')[0];
    const [spending, prevSpending, budgets, income] = await Promise.all([
      query(`SELECT category, SUM(ABS(amount)) as total FROM transactions WHERE user_id=? AND type='expense' AND date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`, [req.user.id, startDate, endDate]),
      query(`SELECT category, SUM(ABS(amount)) as total FROM transactions WHERE user_id=? AND type='expense' AND date BETWEEN ? AND ? GROUP BY category`, [req.user.id, prevStart, prevEnd]),
      query(`SELECT category, amount as budget FROM budgets WHERE user_id=?`, [req.user.id]),
      query(`SELECT SUM(amount) as total FROM transactions WHERE user_id=? AND type='income' AND date BETWEEN ? AND ?`, [req.user.id, startDate, endDate])
    ]);
    const totalSpent = spending.reduce((s,r)=>s+r.total,0);
    const totalIncome = income[0]?.total || 0;
    const prevTotal = prevSpending.reduce((s,r)=>s+r.total,0);
    const monthName = new Date(year, month-1).toLocaleString('en', { month: 'long' });
    const dataCtx = 'Month: ' + monthName + ' ' + year + '\nTotal spent: $' + totalSpent.toFixed(2) + ' (vs $' + prevTotal.toFixed(2) + ' last month)\nTotal income: $' + totalIncome.toFixed(2) + '\nNet: $' + (totalIncome-totalSpent).toFixed(2) + '\n\nTop categories:\n' + spending.slice(0,6).map(r=>'  '+r.category+': $'+r.total.toFixed(2)).join('\n') + '\n\nBudgets:\n' + (budgets.length ? budgets.map(b=>{ const s=spending.find(x=>x.category===b.category); return '  '+b.category+': $'+(s?s.total.toFixed(2):'0.00')+' / $'+b.budget.toFixed(2); }).join('\n') : '  None set');
    const prompt = 'You are a friendly personal finance advisor. Write a monthly story for ' + monthName + ' ' + year + '.\n\n' + dataCtx + '\n\nWrite 3 paragraphs (under 250 words): opening summary, 2 spending patterns, one actionable recommendation. Be warm, specific, use actual numbers.\n\nThen on a new line write:\n---JSON---\n{"highlights":["positive1","positive2"],"warnings":["concern1"],"score":75}\n\nScore 0-100 (100=perfect). Max 3 highlights, max 2 warnings.';
    const text = await aiService.complete(prompt, { maxTokens: 800 });
    const parts = text.split('---JSON---');
    const story = parts[0].trim();
    let highlights=[], warnings=[], score=70;
    if (parts[1]) { try { const m = JSON.parse(parts[1].trim()); highlights=m.highlights||[]; warnings=m.warnings||[]; score=m.score||70; } catch(e){} }
    const result = { story, highlights, warnings, score, period, model: aiService.getModel(), generatedAt: new Date().toISOString() };
    await run(`INSERT INTO ai_insights (org_id,user_id,period,type,content,model) VALUES (?,?,?,'monthly',?,?) ON CONFLICT(org_id,period,type) DO UPDATE SET content=?,model=?,generated_at=datetime('now')`, [req.user.orgId, req.user.id, period, JSON.stringify(result), aiService.getModel(), JSON.stringify(result), aiService.getModel()]);
    res.json(result);
  } catch (err) {
    console.error('Monthly story error:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});
```

**Weekly brief route:**
```javascript
router.get('/insights/weekly', authenticate, async (req, res) => {
  if (!aiService.isConfigured()) return res.status(503).json({ error: true, message: 'AI not configured' });
  try {
    const today = new Date();
    const weekStart = new Date(today); weekStart.setDate(today.getDate()-today.getDay());
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const nextWeekStr = new Date(today.getTime()+7*86400000).toISOString().split('T')[0];
    const [weekSpending, budgets, upcoming] = await Promise.all([
      query(`SELECT category, SUM(ABS(amount)) as total FROM transactions WHERE user_id=? AND type='expense' AND date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC LIMIT 5`, [req.user.id, weekStartStr, todayStr]),
      query(`SELECT * FROM budgets WHERE user_id=?`, [req.user.id]),
      query(`SELECT * FROM recurring_payments WHERE user_id=? AND next_date BETWEEN ? AND ? AND is_active=1 ORDER BY next_date ASC`, [req.user.id, todayStr, nextWeekStr]).catch(()=>[])
    ]);
    const totalThisWeek = weekSpending.reduce((s,r)=>s+r.total,0);
    const prompt = 'Write a weekly financial CFO briefing. Max 120 words, direct.\n\nThis week (' + weekStartStr + ' to ' + todayStr + '): $' + totalThisWeek.toFixed(2) + '\nTop: ' + weekSpending.slice(0,3).map(r=>r.category+' $'+r.total.toFixed(2)).join(', ') + '\nUpcoming payments: ' + (upcoming.map(p=>p.description+' $'+p.amount).join(', ')||'none') + '\nBudgets: ' + (budgets.slice(0,3).map(b=>b.category+' $'+b.amount).join(', ')||'none') + '\n\nStart with "This week:" and end with one action starting with "Action:".';
    const brief = await aiService.complete(prompt, { maxTokens: 250 });
    const actionMatch = brief.match(/Action:\s*(.+)/);
    res.json({ brief, actionItem: actionMatch ? actionMatch[1].trim() : null, weekSpending, totalThisWeek, period: weekStartStr + ' to ' + todayStr });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

module.exports = router;
```

- [ ] Register route in server.js:
```javascript
const aiRoutes = require('./routes/ai');
// ...
app.use('/api/ai', aiRoutes);
```

- [ ] Test status and categorize:
```bash
PORT=3334 node /home/llm/projects/finman/server.js &
sleep 2
TOKEN=$(curl -s -X POST http://localhost:3334/api/auth/login -H "Content-Type: application/json" -d '{"username":"testuser42","password":"test1234"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3334/api/ai/status -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3334/api/ai/categorize -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"description":"Whole Foods","amount":45,"type":"expense"}'
kill %1
```
Expected: status JSON + category JSON

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add routes/ai.js server.js && git commit -m "feat: AI chat CFO, categorize, receipt, monthly story, weekly brief"
```

---

## Task 8: Localization — English UI + USD defaults

Modify all files in public/js/ and public/index.html

- [ ] Update public/index.html:
  - title: 'FinMan — AI Finance Manager'
  - apple-mobile-web-app-title: 'FinMan'
  - description: 'AI-powered personal finance manager — track spending, budgets, investments'
  - Add before closing body tag: `<script src="/js/ai-chat.js"></script>` and `<script src="/js/ai-insights.js"></script>`

- [ ] Create/update public/manifest.json:
```json
{
  "name": "FinMan — AI Finance Manager",
  "short_name": "FinMan",
  "description": "AI-powered personal finance manager",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#5D5CDE",
  "icons": []
}
```

- [ ] Translate public/js/app.js — replace all Cyrillic strings:
  Use sed or Edit tool for each file. Key translations:
  - 'Загрузка...' -> 'Loading...'
  - 'Главная' -> 'Dashboard'
  - 'Транзакции' -> 'Transactions'
  - 'Счета' -> 'Accounts'
  - 'Бюджеты' -> 'Budgets'
  - 'Семья' -> 'Team'
  - 'Повторяющиеся' -> 'Recurring'
  - 'Валюта' -> 'Currency'
  - 'Цели' -> 'Goals'
  - 'Долги' -> 'Debts'
  - 'Инвестиции' -> 'Investments'
  - 'Аналитика' -> 'Analytics'
  - 'Подписки' -> 'Subscriptions'
  - 'Чистый капитал' -> 'Net Worth'
  - 'Чеки' -> 'Receipts'
  - 'Прогноз' -> 'Forecast'
  - 'Банки' -> 'Banks'
  - 'Настройки' -> 'Settings'
  - 'Войти' -> 'Sign In'
  - 'Регистрация' -> 'Sign Up'
  - 'Выход' -> 'Logout'
  - 'Ошибка получения счетов' -> 'Failed to load accounts'
  - nav-link item 'family' label -> 'Team'
  - Add 'AI Chat' nav item in the nav menu (data-page="ai-chat" optional)

- [ ] Translate public/js/accounts.js:
  - Remove 'Российский рубль (RUB)' option entirely
  - Make USD first and selected by default:
    ```html
    <option value="USD" selected>US Dollar (USD)</option>
    <option value="EUR">Euro (EUR)</option>
    <option value="CAD">Canadian Dollar (CAD)</option>
    <option value="GBP">British Pound (GBP)</option>
    <option value="AUD">Australian Dollar (AUD)</option>
    <option value="CHF">Swiss Franc (CHF)</option>
    ```
  - 'Валюта' -> 'Currency', 'Название' -> 'Name', 'Тип' -> 'Type', 'Баланс' -> 'Balance'
  - 'Добавить счёт' -> 'Add Account', 'Сохранить' -> 'Save', 'Отмена' -> 'Cancel'
  - 'Расчётный' -> 'Checking', 'Сберегательный' -> 'Savings', 'Кредитный' -> 'Credit'

- [ ] Translate public/js/transactions.js:
  - 'Не удалось получить транзакции' -> 'Failed to load transactions'
  - 'Доход' -> 'Income', 'Расход' -> 'Expense'
  - 'Категория' -> 'Category', 'Описание' -> 'Description'
  - 'Сумма' -> 'Amount', 'Дата' -> 'Date'
  - 'Добавить транзакцию' -> 'Add Transaction'
  - 'Нет транзакций' -> 'No transactions found'
  - 'Фильтры' -> 'Filters', 'Поиск' -> 'Search'

- [ ] Translate public/js/dashboard.js:
  - 'Нет виджетов. Нажмите "Настроить" чтобы добавить.' -> 'No widgets. Click "Customize" to add some.'
  - 'Настроить' -> 'Customize', 'Загрузка данных...' -> 'Loading data...'
  - Add `<div id="ai-insights-slot"></div>` at start of rendered dashboard content

- [ ] Translate remaining files (currency.js, receipts.js, family.js, analytics.js, budgets.js, goals.js, recurring.js, investments.js, networth.js, reports.js, forecast.js, subscriptions.js, debts.js, split.js, calendar.js):
  - For each: find all Cyrillic strings, translate to English equivalent
  - For currency.js: reorder to show USD, EUR, CAD first

- [ ] Update db/database.js default currency:
  - Find `currency TEXT DEFAULT 'RUB'` in the accounts table CREATE statement
  - Change to `currency TEXT DEFAULT 'USD'`

- [ ] Verify no Russian strings remain in the critical files:
```bash
grep -r "[А-Яа-яЁё]" /home/llm/projects/finman/public/js/ --include="*.js" -l 2>/dev/null
```
Expected: empty (or only files with intentional Russian content)

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add public/ db/database.js && git commit -m "feat: translate UI to English, USD/EUR/CAD default currencies"
```

---

## Task 9: Frontend AI Chat Panel

Create: public/js/ai-chat.js; Modify: public/css/style.css

**SECURITY NOTE:** All user input rendered into DOM must use textContent, not innerHTML. AI responses use a safe HTML render function that only allows bold/italic/line breaks — no script/link/img tags.

- [ ] Create /home/llm/projects/finman/public/js/ai-chat.js:

```javascript
// AI Chat CFO Panel
// SECURITY: user text uses textContent; AI responses use safeMarkdown() whitelist renderer
const AIChat = {
  isOpen: false,
  messages: [],
  sessionId: 'session-' + Date.now(),
  isLoading: false,

  // Safe markdown renderer — allows only bold, italic, line breaks
  safeMarkdown(text) {
    const div = document.createElement('div');
    // Escape HTML first
    div.textContent = text;
    let safe = div.innerHTML;
    // Then selectively re-allow bold, italic, br
    safe = safe
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    return safe;
  },

  init() {
    this.injectHTML();
    this.attachEvents();
    this.checkStatus();
  },

  injectHTML() {
    const el = document.createElement('div');
    el.id = 'ai-chat-container';
    // Use textContent for dynamic content — structure is static HTML here
    el.innerHTML = '<button id="ai-chat-toggle" title="AI Financial Advisor" aria-label="Open AI Chat">' +
      '<i class="fas fa-robot"></i><span class="ai-badge">AI</span></button>' +
      '<div id="ai-chat-panel" class="ai-panel-closed">' +
        '<div class="ai-panel-header">' +
          '<div class="ai-header-info"><i class="fas fa-robot"></i>' +
            '<div><div class="ai-header-title">FinMan AI</div>' +
            '<div class="ai-header-subtitle" id="ai-provider-label">Personal CFO</div></div>' +
          '</div>' +
          '<button id="ai-chat-close" aria-label="Close"><i class="fas fa-times"></i></button>' +
        '</div>' +
        '<div id="ai-messages" class="ai-messages">' +
          '<div class="ai-welcome" id="ai-welcome-msg">' +
            '<p>Hi! I\'m your AI financial advisor. Ask me anything about your finances.</p>' +
            '<div class="ai-suggestions" id="ai-suggestions"></div>' +
          '</div>' +
        '</div>' +
        '<div class="ai-input-area">' +
          '<div class="ai-input-row">' +
            '<input type="text" id="ai-input" placeholder="Ask about your finances..." maxlength="500" />' +
            '<button id="ai-send" aria-label="Send"><i class="fas fa-paper-plane"></i></button>' +
          '</div>' +
          '<div id="ai-status-bar" class="ai-status-bar hidden"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    // Build suggestion buttons safely with textContent
    const suggestions = [
      'How much did I spend this month?',
      "What's my budget status?",
      'Show me my top expenses',
      'Am I saving enough?'
    ];
    const sugBox = document.getElementById('ai-suggestions');
    suggestions.forEach(text => {
      const btn = document.createElement('button');
      btn.className = 'ai-suggestion';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        document.getElementById('ai-input').value = text;
        this.send();
      });
      sugBox.appendChild(btn);
    });
  },

  attachEvents() {
    document.getElementById('ai-chat-toggle').addEventListener('click', () => this.toggle());
    document.getElementById('ai-chat-close').addEventListener('click', () => this.close());
    document.getElementById('ai-send').addEventListener('click', () => this.send());
    document.getElementById('ai-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
  },

  async checkStatus() {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const res = await fetch('/api/ai/status', { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.ok) {
        const data = await res.json();
        const label = document.getElementById('ai-provider-label');
        if (label) label.textContent = data.configured ? (data.model || 'Personal CFO') : 'Not configured';
      }
    } catch (e) {}
  },

  toggle() { this.isOpen ? this.close() : this.open(); },

  open() {
    this.isOpen = true;
    const panel = document.getElementById('ai-chat-panel');
    panel.classList.remove('ai-panel-closed');
    panel.classList.add('ai-panel-open');
    document.getElementById('ai-input').focus();
  },

  close() {
    this.isOpen = false;
    const panel = document.getElementById('ai-chat-panel');
    panel.classList.remove('ai-panel-open');
    panel.classList.add('ai-panel-closed');
  },

  async send() {
    const input = document.getElementById('ai-input');
    const text = input.value.trim();
    if (!text || this.isLoading) return;
    input.value = '';

    // Remove welcome message
    const welcome = document.getElementById('ai-welcome-msg');
    if (welcome) welcome.remove();

    this.addMessage('user', text);
    this.messages.push({ role: 'user', content: text });
    this.setLoading(true);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ messages: this.messages, sessionId: this.sessionId })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message);
      this.messages.push({ role: 'assistant', content: data.response });
      this.addMessage('assistant', data.response);
    } catch (err) {
      this.addMessage('error', err.message || 'Something went wrong. Please try again.');
    } finally {
      this.setLoading(false);
    }
  },

  addMessage(role, content) {
    const msgs = document.getElementById('ai-messages');
    const div = document.createElement('div');
    div.className = 'ai-message ai-message-' + role;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble' + (role === 'error' ? ' ai-bubble-error' : '');

    if (role === 'assistant') {
      // safeMarkdown: textContent-escaped then only bold/italic/br re-allowed
      bubble.innerHTML = this.safeMarkdown(content);
    } else if (role === 'error') {
      const icon = document.createElement('i');
      icon.className = 'fas fa-exclamation-triangle';
      bubble.appendChild(icon);
      bubble.appendChild(document.createTextNode(' ' + content));
    } else {
      // User input: textContent only, never innerHTML
      bubble.textContent = content;
    }

    div.appendChild(bubble);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  },

  setLoading(val) {
    this.isLoading = val;
    const bar = document.getElementById('ai-status-bar');
    const btn = document.getElementById('ai-send');
    if (val) { bar.textContent = 'Analyzing your finances...'; bar.classList.remove('hidden'); btn.disabled = true; }
    else { bar.classList.add('hidden'); btn.disabled = false; }
  }
};

document.addEventListener('DOMContentLoaded', () => { AIChat.init(); });
```

- [ ] Add CSS to public/css/style.css (append at end):

```css
/* AI CHAT PANEL */
#ai-chat-container { position:fixed; bottom:24px; right:24px; z-index:9999; }
#ai-chat-toggle { width:56px; height:56px; border-radius:50%; background:linear-gradient(135deg,#5D5CDE,#7C3AED); border:none; color:white; font-size:22px; cursor:pointer; box-shadow:0 4px 16px rgba(93,92,222,.45); display:flex; align-items:center; justify-content:center; position:relative; transition:transform .2s,box-shadow .2s; }
#ai-chat-toggle:hover { transform:scale(1.08); box-shadow:0 6px 20px rgba(93,92,222,.6); }
.ai-badge { position:absolute; top:-4px; right:-4px; background:#10b981; color:white; font-size:9px; font-weight:700; padding:2px 4px; border-radius:4px; }
#ai-chat-panel { position:absolute; bottom:68px; right:0; width:380px; max-height:560px; background:white; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,.18); display:flex; flex-direction:column; overflow:hidden; transition:opacity .2s,transform .2s; }
.ai-panel-closed { opacity:0; pointer-events:none; transform:translateY(12px) scale(.97); }
.ai-panel-open { opacity:1; pointer-events:all; transform:translateY(0) scale(1); }
.ai-panel-header { background:linear-gradient(135deg,#5D5CDE,#7C3AED); color:white; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; }
.ai-header-info { display:flex; align-items:center; gap:10px; }
.ai-header-info .fa-robot { font-size:20px; }
.ai-header-title { font-weight:700; font-size:15px; }
.ai-header-subtitle { font-size:11px; opacity:.8; margin-top:1px; }
#ai-chat-close { background:none; border:none; color:white; cursor:pointer; font-size:16px; padding:4px; opacity:.8; }
#ai-chat-close:hover { opacity:1; }
.ai-messages { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; min-height:200px; max-height:380px; }
.ai-welcome p { font-size:13px; color:#6b7280; margin-bottom:10px; }
.ai-suggestions { display:flex; flex-direction:column; gap:6px; }
.ai-suggestion { background:#f3f4f6; border:1px solid #e5e7eb; border-radius:8px; padding:7px 10px; font-size:12px; text-align:left; cursor:pointer; color:#374151; }
.ai-suggestion:hover { background:#e5e7eb; }
.ai-message { display:flex; flex-direction:column; }
.ai-message-user { align-items:flex-end; }
.ai-message-assistant { align-items:flex-start; }
.ai-bubble { background:#f3f4f6; border-radius:12px; padding:10px 13px; font-size:13px; line-height:1.5; max-width:90%; color:#1f2937; }
.ai-message-user .ai-bubble { background:linear-gradient(135deg,#5D5CDE,#7C3AED); color:white; }
.ai-bubble-error { background:#fef2f2; color:#dc2626; border:1px solid #fecaca; }
.ai-input-area { padding:10px 12px 12px; border-top:1px solid #e5e7eb; }
.ai-input-row { display:flex; gap:8px; align-items:center; }
#ai-input { flex:1; border:1px solid #d1d5db; border-radius:22px; padding:9px 14px; font-size:13px; outline:none; }
#ai-input:focus { border-color:#5D5CDE; }
#ai-send { width:36px; height:36px; border-radius:50%; background:#5D5CDE; border:none; color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; }
#ai-send:hover { background:#4f4ec4; }
#ai-send:disabled { background:#9ca3af; cursor:not-allowed; }
.ai-status-bar { font-size:11px; color:#6b7280; margin-top:6px; text-align:center; font-style:italic; }
.hidden { display:none; }
@media (max-width:440px) { #ai-chat-panel { width:calc(100vw - 20px); right:-10px; } }

/* AI INSIGHTS WIDGET */
.ai-insights-slot { margin-bottom:20px; }
.ai-insights-card { background:white; border-radius:12px; padding:18px 20px; box-shadow:0 1px 6px rgba(0,0,0,.08); border:1px solid #e5e7eb; }
.ai-insights-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.ai-insights-header h3 { font-size:15px; font-weight:600; color:#1f2937; display:flex; align-items:center; gap:7px; margin:0; }
.ai-insights-header h3 .fa-robot { color:#5D5CDE; }
#ai-insights-refresh { background:none; border:none; cursor:pointer; color:#9ca3af; font-size:13px; padding:4px; }
#ai-insights-refresh:hover { color:#5D5CDE; }
.ai-insights-loading { display:flex; align-items:center; gap:8px; font-size:13px; color:#6b7280; padding:10px 0; }
.spinner-small { width:16px; height:16px; border:2px solid #e5e7eb; border-top-color:#5D5CDE; border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.ai-score-row { display:flex; align-items:center; gap:14px; margin-bottom:12px; }
.ai-score-circle { width:56px; height:56px; border-radius:50%; border:3px solid var(--score-color,#10b981); display:flex; flex-direction:column; align-items:center; justify-content:center; flex-shrink:0; }
.ai-score-number { font-size:18px; font-weight:700; color:var(--score-color,#10b981); line-height:1; }
.ai-score-label { font-size:9px; color:#9ca3af; text-transform:uppercase; }
.ai-chips { display:flex; flex-wrap:wrap; gap:5px; }
.ai-chip { font-size:11px; padding:3px 8px; border-radius:12px; font-weight:500; }
.ai-chip-green { background:#d1fae5; color:#065f46; }
.ai-chip-red { background:#fee2e2; color:#991b1b; }
.ai-story-text { font-size:13px; line-height:1.65; color:#374151; }
.ai-insights-error { color:#dc2626; font-size:13px; }
```

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add public/js/ai-chat.js public/css/style.css && git commit -m "feat: add AI chat panel with XSS-safe rendering"
```

---

## Task 10: AI Insights Widget + Dashboard Integration

Create: public/js/ai-insights.js; Modify: public/js/dashboard.js

- [ ] Create /home/llm/projects/finman/public/js/ai-insights.js:

```javascript
// AI Monthly Story widget — all content rendered safely
// AI text: uses safeMarkdown (textContent-escaped + limited HTML)
// User-visible scores/chips: textContent only
const AIInsights = {
  safeText(text) {
    const d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
  },

  async init() {
    const token = localStorage.getItem('token');
    if (!token) return;
    // Wait for slot to appear in DOM, retry up to 10 times
    let attempts = 0;
    const tryRender = async () => {
      const slot = document.getElementById('ai-insights-slot');
      if (slot) { await this.renderWidget(); }
      else if (++attempts < 10) { setTimeout(tryRender, 500); }
    };
    tryRender();
  },

  async renderWidget() {
    const slot = document.getElementById('ai-insights-slot');
    if (!slot || slot.dataset.initialized) return;
    slot.dataset.initialized = '1';

    const card = document.createElement('div');
    card.className = 'ai-insights-card';

    const header = document.createElement('div');
    header.className = 'ai-insights-header';
    header.innerHTML = '<h3><i class="fas fa-robot"></i> Monthly Story</h3>';

    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'ai-insights-refresh';
    refreshBtn.title = 'Regenerate';
    refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
    refreshBtn.addEventListener('click', () => this.load(true));
    header.appendChild(refreshBtn);

    const content = document.createElement('div');
    content.id = 'ai-insights-content';

    card.appendChild(header);
    card.appendChild(content);
    slot.appendChild(card);

    await this.load();
  },

  async load(force = false) {
    const content = document.getElementById('ai-insights-content');
    if (!content) return;
    const now = new Date();
    const token = localStorage.getItem('token');
    const cacheKey = 'ai-insights-' + now.getFullYear() + '-' + (now.getMonth()+1);
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.ts < 86400000) { this.render(cached.data); return; }
      } catch(e) {}
    }
    const loading = document.createElement('div');
    loading.className = 'ai-insights-loading';
    loading.innerHTML = '<div class="spinner-small"></div>';
    const loadText = document.createTextNode(' Generating your financial story...');
    loading.appendChild(loadText);
    content.innerHTML = '';
    content.appendChild(loading);

    try {
      const res = await fetch('/api/ai/insights/monthly?year=' + now.getFullYear() + '&month=' + (now.getMonth()+1), { headers: { 'Authorization': 'Bearer ' + token } });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Failed'); }
      const data = await res.json();
      try { localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() })); } catch(e) {}
      this.render(data);
    } catch (err) {
      content.innerHTML = '';
      const errP = document.createElement('p');
      errP.className = 'ai-insights-error';
      errP.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ';
      errP.appendChild(document.createTextNode(err.message));
      content.appendChild(errP);
    }
  },

  render(data) {
    const content = document.getElementById('ai-insights-content');
    if (!content) return;
    content.innerHTML = '';

    const score = data.score || 70;
    const scoreColor = score >= 75 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';

    // Score row
    const scoreRow = document.createElement('div');
    scoreRow.className = 'ai-score-row';

    const circle = document.createElement('div');
    circle.className = 'ai-score-circle';
    circle.style.setProperty('--score-color', scoreColor);
    const scoreNum = document.createElement('span');
    scoreNum.className = 'ai-score-number';
    scoreNum.style.color = scoreColor;
    scoreNum.textContent = score;
    const scoreLabel = document.createElement('span');
    scoreLabel.className = 'ai-score-label';
    scoreLabel.textContent = 'score';
    circle.appendChild(scoreNum);
    circle.appendChild(scoreLabel);
    scoreRow.appendChild(circle);

    const chips = document.createElement('div');
    chips.className = 'ai-chips';
    (data.highlights || []).forEach(h => {
      const chip = document.createElement('span');
      chip.className = 'ai-chip ai-chip-green';
      chip.textContent = h; // textContent — safe
      chips.appendChild(chip);
    });
    (data.warnings || []).forEach(w => {
      const chip = document.createElement('span');
      chip.className = 'ai-chip ai-chip-red';
      chip.textContent = w; // textContent — safe
      chips.appendChild(chip);
    });
    scoreRow.appendChild(chips);
    content.appendChild(scoreRow);

    // Story text — escape then allow line breaks
    const storyDiv = document.createElement('div');
    storyDiv.className = 'ai-story-text';
    const escaped = this.safeText(data.story || '');
    storyDiv.innerHTML = escaped.replace(/\n/g, '<br>');
    content.appendChild(storyDiv);
  }
};

document.addEventListener('DOMContentLoaded', () => { AIInsights.init(); });
```

- [ ] In public/js/dashboard.js, find the render() function where dashboard HTML is built.
  Add `<div id="ai-insights-slot" class="ai-insights-slot"></div>` at the very beginning of the main content div (before the widgets grid), for example:

  Find where container.innerHTML is set or where the main page content starts rendering, and prepend the slot:
```javascript
// Before any existing widgets HTML in render():
const insightsSlot = document.getElementById('ai-insights-slot');
if (!insightsSlot) {
  const slot = document.createElement('div');
  slot.id = 'ai-insights-slot';
  slot.className = 'ai-insights-slot';
  const container = document.getElementById('dashboard-widgets') || document.getElementById('main-content');
  if (container) container.insertBefore(slot, container.firstChild);
}
```

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add public/js/ai-insights.js public/js/dashboard.js && git commit -m "feat: add AI monthly story widget on dashboard"
```

---

## Task 11: Wire Auto-categorize + Receipt Scan to Forms

Modify: public/js/transactions.js, public/js/receipts.js

- [ ] Add autoCategorize helper to public/js/transactions.js (at top of file):
```javascript
async function autoCategorize(description, amount, type) {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/ai/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ description, amount, type })
    });
    if (!res.ok) return null;
    return (await res.json()).category || null;
  } catch (e) { return null; }
}
```

- [ ] Find where the transaction modal description input is built in transactions.js. After building the form, add blur listener. Look for the function that renders the "add/edit transaction" modal (likely renderTransactionModal or similar). After modal is inserted into DOM, add:
```javascript
// After modal HTML is inserted:
const descInput = document.getElementById('tx-description') || document.querySelector('[id$="-description"]');
const catSelect = document.getElementById('tx-category') || document.querySelector('[id$="-category"]');
const typeSelect = document.getElementById('tx-type') || document.querySelector('[id$="-type"]');
if (descInput && catSelect) {
  descInput.addEventListener('blur', async () => {
    const desc = descInput.value.trim();
    const type = typeSelect ? typeSelect.value : 'expense';
    if (desc && (!catSelect.value || catSelect.value === 'Other' || !catSelect.value)) {
      const cat = await autoCategorize(desc, 0, type);
      if (cat) {
        const opt = catSelect.querySelector('option[value="' + cat + '"]');
        if (opt) { catSelect.value = cat; catSelect.title = 'AI: ' + cat; }
      }
    }
  });
}
```

- [ ] In public/js/receipts.js, find the file input element setup. After it's rendered, add scan-on-change:
```javascript
// After file input is in DOM:
const fileInput = document.getElementById('receipt-file-input') || document.querySelector('input[type="file"]');
if (fileInput && !fileInput.dataset.aiHooked) {
  fileInput.dataset.aiHooked = '1';
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('receipt-scan-status');
    if (statusEl) statusEl.textContent = 'Scanning receipt with AI...';
    const formData = new FormData();
    formData.append('image', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/ai/receipt', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData });
      const data = await res.json();
      if (data.error) throw new Error(data.message);
      // Fill form fields safely with textContent/value (no innerHTML for data)
      const setField = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
      setField('receipt-description', data.merchant);
      setField('receipt-amount', data.amount);
      setField('receipt-date', data.date);
      if (data.category) {
        const catEl = document.getElementById('receipt-category');
        if (catEl && catEl.querySelector('option[value="' + data.category + '"]')) catEl.value = data.category;
      }
      if (statusEl) statusEl.textContent = 'Scanned: ' + (data.merchant || 'Receipt') + ' — $' + (data.amount || '?');
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Scan failed: ' + err.message;
    }
  });
}
```

- [ ] Commit:
```bash
cd /home/llm/projects/finman && git add public/js/transactions.js public/js/receipts.js && git commit -m "feat: auto-categorize on transaction form, AI receipt scan on upload"
```

---

## Task 12: Dockerfile + Final Polish + Push + Local Deploy

- [ ] Create /home/llm/projects/finman/Dockerfile:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data /app/uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

- [ ] Create /home/llm/projects/finman/docker-compose.yml:
```yaml
version: '3.9'
services:
  finman:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - finman_data:/app/data
      - finman_uploads:/app/uploads
    environment:
      - NODE_ENV=production
      - PORT=3000
      - JWT_SECRET=${JWT_SECRET}
      - SESSION_SECRET=${SESSION_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - DATABASE_PATH=/app/data/finance.db
      - AI_PROVIDER=${AI_PROVIDER:-anthropic}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  finman_data:
  finman_uploads:
```

- [ ] Ensure .gitignore includes:
```
.env
data/
uploads/
node_modules/
ios/
android/
```

- [ ] Run final npm install:
```bash
cd /home/llm/projects/finman && npm install 2>&1 | tail -3
```

- [ ] Full startup test:
```bash
PORT=3001 node /home/llm/projects/finman/server.js > /tmp/finman-final.log 2>&1 &
sleep 3
curl -s http://localhost:3001/api/health
curl -s http://localhost:3001/ | grep -i "FinMan" | head -2
kill %1
```
Expected: health JSON + FinMan in page title

- [ ] Commit all remaining changes:
```bash
cd /home/llm/projects/finman
git add Dockerfile docker-compose.yml .gitignore
git add -A
git status
git commit -m "feat: Dockerfile, docker-compose, finalize v2 AI SaaS"
```

- [ ] Push to GitHub:
```bash
cd /home/llm/projects/finman && git push origin main
```
Expected: "main -> main" success message

- [ ] Deploy locally for demo:
```bash
pkill -f "node /home/llm/projects/finman" 2>/dev/null; sleep 1
PORT=3001 node /home/llm/projects/finman/server.js > /tmp/finman-demo.log 2>&1 &
sleep 3
cat /tmp/finman-demo.log
echo ""
echo "FinMan v2 running at: http://localhost:3001"
```

---

## Self-Review

Spec coverage:
- Localization (EN, USD/EUR/CAD): Task 8 ✓
- SaaS orgs/invites: Tasks 2,3,4,5 ✓
- Multi-model AI (Anthropic/OpenAI/Google): Task 6 ✓
- AI Chat CFO with tool-calling: Task 7 ✓
- Auto-categorization: Tasks 7,11 ✓
- Receipt scanner: Tasks 7,11 ✓
- Monthly story: Task 7 ✓
- Weekly brief: Task 7 ✓
- Frontend chat panel (XSS-safe): Task 9 ✓
- AI insights widget (XSS-safe): Task 10 ✓
- .env.example: Task 1 ✓
- Docker: Task 12 ✓
- Push + local deploy: Task 12 ✓

Security:
- User input: textContent only ✓
- AI responses: safeMarkdown (escape first, then whitelist) ✓
- Receipt/API data: .value setter only ✓
- Keyword fallback if AI unavailable ✓

Type consistency:
- Organization.create({ name, ownerId }) → used in Task 4 ✓
- aiService.chat(messages, tools, systemPrompt) → Task 7 ✓
- aiService.vision(imageBase64, mimeType, prompt) → Task 7 ✓
- req.user.orgId set in Task 4, used in Tasks 5,7 ✓
- executeTool(name, input, userId) defined+used in Task 7 ✓
