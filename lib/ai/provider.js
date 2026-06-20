// lib/ai/provider.js — провайдер-агностичный AI-клиент поверх axios.
// env:
//   AI_PROVIDER  in { anthropic, openai, ollama }   (default: anthropic)
//   AI_API_KEY   — ключ (для ollama не обязателен)
//   AI_BASE_URL  — переопределение базового URL (опционально)
//   AI_MODEL     — имя модели (есть дефолты на провайдера)
//
// Экспорт:
//   chat({ system, messages, maxTokens }) -> Promise<{ text }>
//   isConfigured() -> boolean
//
// messages: [{ role: 'user'|'assistant', content: string }, ...]

const axios = require('axios');
const { AppError } = require('../../middleware/error');
const logger = require('../logger');

const DEFAULTS = {
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    model: 'claude-opus-4-8',
    needsKey: true,
  },
  openai: {
    baseURL: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    needsKey: true,
  },
  ollama: {
    baseURL: 'http://localhost:11434',
    model: 'llama3.1',
    needsKey: false,
  },
};

function provider() {
  const name = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  return DEFAULTS[name] ? name : 'anthropic';
}

function config() {
  const name = provider();
  const d = DEFAULTS[name];
  return {
    name,
    baseURL: process.env.AI_BASE_URL || d.baseURL,
    model: process.env.AI_MODEL || d.model,
    apiKey: process.env.AI_API_KEY || '',
    needsKey: d.needsKey,
    maxTokens: 1024,
  };
}

function isConfigured() {
  const c = config();
  if (c.needsKey) return Boolean(c.apiKey);
  // ollama: ключ не нужен, считаем настроенным, если явно выбран провайдер или есть base url
  return true;
}

async function chat({ system, messages, maxTokens } = {}) {
  if (!isConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
  }
  const c = config();
  const tokens = maxTokens || c.maxTokens;
  const msgs = Array.isArray(messages) ? messages : [];

  try {
    if (c.name === 'anthropic') {
      const resp = await axios.post(
        `${c.baseURL}/v1/messages`,
        {
          model: c.model,
          max_tokens: tokens,
          system: system || undefined,
          messages: msgs,
        },
        {
          headers: {
            'x-api-key': c.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 60000,
        }
      );
      const text = (resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text) || '';
      return { text };
    }

    if (c.name === 'openai') {
      const oaMessages = system ? [{ role: 'system', content: system }, ...msgs] : msgs;
      const resp = await axios.post(
        `${c.baseURL}/v1/chat/completions`,
        {
          model: c.model,
          max_tokens: tokens,
          messages: oaMessages,
        },
        {
          headers: {
            Authorization: `Bearer ${c.apiKey}`,
            'content-type': 'application/json',
          },
          timeout: 60000,
        }
      );
      const text =
        (resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content) ||
        '';
      return { text };
    }

    // ollama (local Ollama or Ollama Cloud at https://ollama.com)
    const olMessages = system ? [{ role: 'system', content: system }, ...msgs] : msgs;
    const olHeaders = { 'content-type': 'application/json' };
    // Ollama Cloud requires Bearer auth; local Ollama ignores it. Send it whenever a key is present.
    if (c.apiKey) {
      olHeaders.Authorization = `Bearer ${c.apiKey}`;
    }
    const resp = await axios.post(
      `${c.baseURL}/api/chat`,
      {
        model: c.model,
        messages: olMessages,
        stream: false,
        options: { num_predict: tokens },
      },
      { headers: olHeaders, timeout: 120000 }
    );
    const text = (resp.data && resp.data.message && resp.data.message.content) || '';
    return { text };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const status = err.response && err.response.status;
    logger.error({ provider: c.name, status, msg: err.message }, 'AI provider request failed');
    throw new AppError(502, 'AI_REQUEST_FAILED', `AI provider request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

module.exports = { chat, isConfigured };
