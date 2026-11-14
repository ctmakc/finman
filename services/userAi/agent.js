// services/userAi/agent.js — the in-app assistant on the person's own AI key.
//
// Same tools as the MCP server (services/mcp/tools.js), run as this person only.
// Loop: the model answers or asks for tools. Read-only tools run at once (status auto).
// Tools that change data wait for the person (status pending) and run only after
// "Confirm" (done / failed) or are skipped on "Decline" (declined). When every call of
// one model turn is resolved, the results go back to the model as one tool message.
'use strict';

const { get, query, run } = require('../../db/database');
const mcpTools = require('../mcp/tools');
const providers = require('./providers');
const keys = require('./keys');
const logger = require('../../lib/logger');
const dates = require('../../lib/dates');

const { UserAiError } = providers;
const MAX_STEPS = 8;
const HISTORY_ROWS = 40;
const RESULT_CHARS = 20000;
const DECLINED = 'The person declined this action. Do not retry it unless they ask again.';

const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…[cut: ${s.length - n} more characters]` : s);

function systemPrompt(locale, tz) {
  const today = dates.todayISO(tz || dates.DEFAULT_TZ);
  const lang = { uk: 'Ukrainian', ru: 'Russian', en: 'English' }[locale] || 'the language the person writes in';
  return [
    'You are the assistant inside Finman, a personal and small-business finance app.',
    `Today is ${today}. Reply in ${lang} unless the person writes in another language; then use theirs.`,
    'Use the tools to read the person\'s real accounts, transactions, invoices and clients. Never invent numbers, names or balances: if a tool did not return it, say you do not have it.',
    'For totals and "how much did I spend" questions use get_spending_summary; call list_accounts first when you need an account_id.',
    'Tools that change data (adding, editing or deleting transactions, invoices, clients) are shown to the person as a card with Confirm and Decline; they run only after Confirm. Ask for such a tool directly, without asking for permission in text first.',
    'Amounts in add_transaction are positive; the type says income or expense. Dates are YYYY-MM-DD.',
    'Keep answers short and concrete. Format money with its currency.',
  ].join('\n');
}

// ---------- threads ----------
async function threadFor(userId, threadId) {
  const t = await get('SELECT * FROM ai_agent_threads WHERE id = ? AND user_id = ?', [parseInt(threadId, 10) || 0, userId]);
  if (!t) throw new UserAiError('AI_THREAD_NOT_FOUND', 'Conversation not found', 404);
  return t;
}

async function listThreads(userId) {
  return query('SELECT id, title, created_at, updated_at FROM ai_agent_threads WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50', [userId]);
}

async function deleteThread(userId, threadId) {
  const t = await threadFor(userId, threadId);
  await run('DELETE FROM ai_agent_actions WHERE thread_id = ?', [t.id]);
  await run('DELETE FROM ai_agent_messages WHERE thread_id = ?', [t.id]);
  await run('DELETE FROM ai_agent_threads WHERE id = ?', [t.id]);
  return { deleted: true };
}

async function addMessage(thread, role, content) {
  const r = await run('INSERT INTO ai_agent_messages (thread_id, user_id, role, content) VALUES (?, ?, ?, ?)', [thread.id, thread.user_id, role, JSON.stringify(content)]);
  await run('UPDATE ai_agent_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [thread.id]);
  return r.id;
}

// Transcript for the model: last rows, starting at a person's message (so every tool
// result follows the model turn that asked for it).
async function history(threadId) {
  const rows = await query('SELECT id, role, content FROM ai_agent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?', [threadId, HISTORY_ROWS]);
  rows.reverse();
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows.map((r) => ({ role: r.role, ...parse(r.content, {}) }));
}

// ---------- tools ----------
function toolList() {
  return mcpTools.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
const TITLES = () => new Map(mcpTools.listTools().map((t) => [t.name, t.title || t.name]));

async function runTool(userId, name, args) {
  try {
    const out = await mcpTools.callTool(userId, name, args);
    if (!out) return { content: `Unknown tool: ${name}`, isError: true };
    const text = (out.content || []).map((c) => c.text || '').join('\n');
    return { content: clip(text, RESULT_CHARS), isError: !!out.isError };
  } catch (e) {
    logger.error(`[userAi] tool ${name} failed: ${e && e.message}`);
    return { content: 'The tool failed on the Finman side. Tell the person to try again later.', isError: true };
  }
}

// When all calls of one model message are resolved, write their results (in call order).
async function flushResults(thread, messageId) {
  const acts = await query('SELECT * FROM ai_agent_actions WHERE message_id = ? ORDER BY seq', [messageId]);
  if (!acts.length || acts.some((a) => a.status === 'pending' || a.status === 'running')) return false;
  const msg = await get('SELECT content FROM ai_agent_messages WHERE id = ?', [messageId]);
  const calls = (parse(msg && msg.content, {}).calls) || [];
  const gid = new Map(calls.map((c) => [c.id, c.meta && c.meta.gid]));
  await addMessage(thread, 'tool', {
    results: acts.map((a) => ({ id: a.call_id, name: a.tool, content: a.result || '', isError: !!a.is_error, ...(gid.get(a.call_id) ? { gid: gid.get(a.call_id) } : {}) })),
  });
  return true;
}

// ---------- the loop ----------
async function step(thread, keyRow, secret, locale) {
  const u = await get('SELECT timezone FROM users WHERE id = ?', [thread.user_id]);
  const tz = dates.userTz(u);
  for (let i = 0; i < MAX_STEPS; i += 1) {
    let resp;
    try {
      resp = await providers.complete({
        provider: keyRow.provider, key: secret, model: keyRow.model, baseUrl: keyRow.base_url,
        system: systemPrompt(locale, tz), messages: await history(thread.id), tools: toolList(),
      });
    } catch (e) {
      await keys.markUsed(keyRow.id, e instanceof UserAiError ? e.message : 'error');
      throw e;
    }
    await keys.markUsed(keyRow.id, null);
    const calls = (resp.calls || []).slice(0, 10);
    const messageId = await addMessage(thread, 'assistant', { text: resp.text || '', calls });
    if (!calls.length) return;

    let waiting = false;
    for (let s = 0; s < calls.length; s += 1) {
      const c = calls[s];
      const known = !!mcpTools.listTools().find((t) => t.name === c.name);
      const auto = !known || mcpTools.isReadOnly(c.name);
      let result = null; let isError = 0; let status = 'pending';
      if (auto) {
        const out = await runTool(thread.user_id, c.name, c.args);
        result = out.content; isError = out.isError ? 1 : 0; status = 'auto';
      } else waiting = true;
      await run(
        `INSERT INTO ai_agent_actions (thread_id, user_id, message_id, seq, call_id, tool, args, status, result, is_error, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${auto ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
        [thread.id, thread.user_id, messageId, s, String(c.id), c.name, JSON.stringify(c.args || {}), status, result, isError],
      );
    }
    if (waiting) return;
    await flushResults(thread, messageId);
  }
  await addMessage(thread, 'assistant', { text: '…', calls: [], note: 'step_limit' });
}

async function chat(userId, { threadId, message, keyId, locale, retry }) {
  const text = String(message || '').trim();
  if (retry && threadId) return retryLast(userId, { threadId, keyId, locale });
  if (!text) throw new UserAiError('AI_EMPTY', 'Write a message');
  if (text.length > 8000) throw new UserAiError('AI_TOO_LONG', 'The message is too long (8000 characters max)');

  let thread;
  if (threadId) thread = await threadFor(userId, threadId);
  const { row, secret } = await keys.resolve(userId, keyId || (thread && thread.key_id) || null);
  if (!thread) {
    const r = await run('INSERT INTO ai_agent_threads (user_id, key_id, title) VALUES (?, ?, ?)', [userId, row.id, text.replace(/\s+/g, ' ').slice(0, 80)]);
    thread = await threadFor(userId, r.id);
  } else if (thread.key_id !== row.id) {
    await run('UPDATE ai_agent_threads SET key_id = ? WHERE id = ?', [row.id, thread.id]);
  }

  // A new message while cards wait = those actions are declined.
  const pending = await query("SELECT DISTINCT message_id FROM ai_agent_actions WHERE thread_id = ? AND status = 'pending'", [thread.id]);
  if (pending.length) {
    await run("UPDATE ai_agent_actions SET status = 'declined', result = ?, is_error = 1, resolved_at = CURRENT_TIMESTAMP WHERE thread_id = ? AND status = 'pending'", [DECLINED, thread.id]);
    for (const p of pending) await flushResults(thread, p.message_id);
  }

  await addMessage(thread, 'user', { text });
  try {
    await step(thread, row, secret, locale);
  } catch (e) {
    // The message is saved: the screen reopens this thread and offers a retry.
    e.threadId = thread.id;
    throw e;
  }
  return view(userId, thread.id);
}

// The answer to the last message failed (provider busy, key fixed…): ask again without a new message.
async function retryLast(userId, { threadId, keyId, locale }) {
  const thread = await threadFor(userId, threadId);
  const last = await get('SELECT role FROM ai_agent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1', [thread.id]);
  if (!last || last.role !== 'user') return view(userId, thread.id);
  const { row, secret } = await keys.resolve(userId, keyId || thread.key_id || null);
  if (thread.key_id !== row.id) await run('UPDATE ai_agent_threads SET key_id = ? WHERE id = ?', [row.id, thread.id]);
  try {
    await step(thread, row, secret, locale);
  } catch (e) {
    e.threadId = thread.id;
    throw e;
  }
  return view(userId, thread.id);
}

async function resolveAction(userId, actionId, approve, locale) {
  const a = await get('SELECT * FROM ai_agent_actions WHERE id = ? AND user_id = ?', [parseInt(actionId, 10) || 0, userId]);
  if (!a) throw new UserAiError('AI_ACTION_NOT_FOUND', 'Action not found', 404);
  const claim = await run("UPDATE ai_agent_actions SET status = 'running' WHERE id = ? AND status = 'pending'", [a.id]);
  if (!claim.changes) throw new UserAiError('AI_ACTION_DONE', 'This action is already answered', 409);

  if (approve) {
    const out = await runTool(userId, a.tool, parse(a.args, {}));
    await run('UPDATE ai_agent_actions SET status = ?, result = ?, is_error = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?', [out.isError ? 'failed' : 'done', out.content, out.isError ? 1 : 0, a.id]);
  } else {
    await run("UPDATE ai_agent_actions SET status = 'declined', result = ?, is_error = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [DECLINED, a.id]);
  }

  const thread = await threadFor(userId, a.thread_id);
  if (await flushResults(thread, a.message_id)) {
    // Every card of that turn is answered: the model goes on (needs the key again).
    let resolved;
    try { resolved = await keys.resolve(userId, thread.key_id || null); } catch (e) { resolved = null; }
    if (resolved) {
      try { await step(thread, resolved.row, resolved.secret, locale); } catch (e) {
        const v = await view(userId, thread.id);
        v.error = { code: e.code || 'AI_PROVIDER_ERROR', message: e instanceof UserAiError ? e.message : 'The AI service failed' };
        return v;
      }
    }
  }
  return view(userId, thread.id);
}

// ---------- what the screen shows ----------
function summarize(tool, args, names) {
  const a = Object.assign({}, args || {});
  const n = names && names.get(Number(a.account_id));
  if (n) a.account_id = n;
  const bits = [];
  for (const k of ['amount', 'type', 'date', 'description', 'category', 'account_id', 'transaction_id', 'invoice_id', 'client_id', 'status', 'name', 'email']) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== '') bits.push([k, typeof a[k] === 'object' ? JSON.stringify(a[k]) : String(a[k])]);
  }
  return bits.slice(0, 8);
}

async function view(userId, threadId) {
  const thread = await threadFor(userId, threadId);
  const rows = await query('SELECT id, role, content, created_at FROM ai_agent_messages WHERE thread_id = ? ORDER BY id', [thread.id]);
  const acts = await query('SELECT * FROM ai_agent_actions WHERE thread_id = ? ORDER BY message_id, seq', [thread.id]);
  const titles = TITLES();
  const accIds = [...new Set(acts.map((a) => Number(parse(a.args, {}).account_id)).filter((x) => Number.isInteger(x) && x > 0))];
  const names = new Map();
  if (accIds.length) {
    const rowsA = await query(
      `SELECT a.id, a.name FROM accounts a WHERE a.id IN (${accIds.map(() => '?').join(',')})
         AND (a.user_id = ? OR EXISTS (SELECT 1 FROM account_permissions p WHERE p.account_id = a.id AND p.user_id = ? AND p.can_view = 1))`,
      [...accIds, userId, userId]);
    for (const r of rowsA) names.set(r.id, r.name);
  }
  const byMsg = new Map();
  for (const a of acts) {
    if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
    byMsg.get(a.message_id).push({
      id: a.id,
      tool: a.tool,
      title: titles.get(a.tool) || a.tool,
      status: a.status,
      needs_confirm: a.status === 'pending',
      is_error: !!a.is_error,
      args: parse(a.args, {}),
      fields: summarize(a.tool, parse(a.args, {}), names),
      result_preview: a.status === 'pending' || !a.result ? null : a.result.slice(0, 600),
    });
  }
  const messages = [];
  for (const r of rows) {
    if (r.role === 'tool') continue;
    const c = parse(r.content, {});
    const actions = byMsg.get(r.id) || [];
    if (r.role === 'assistant' && !c.text && !actions.length) continue;
    messages.push({ id: r.id, role: r.role, text: c.text || '', actions, created_at: r.created_at, ...(c.note ? { note: c.note } : {}) });
  }
  const key = thread.key_id ? await get('SELECT * FROM user_ai_keys WHERE id = ? AND user_id = ?', [thread.key_id, userId]) : null;
  return {
    thread: { id: thread.id, title: thread.title, key: key ? keys.publicKey(key) : null, updated_at: thread.updated_at },
    messages,
    pending: acts.filter((a) => a.status === 'pending').length,
  };
}

module.exports = { chat, resolveAction, view, listThreads, deleteThread, systemPrompt, MAX_STEPS };
