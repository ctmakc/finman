/**
 * Multi-provider AI abstraction.
 * Set AI_PROVIDER=anthropic|openai|google|gemini-oauth in .env
 */
const config = require('../config/config');
const fs = require('fs');
const https = require('https');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MODEL_OVERRIDE = process.env.AI_MODEL || '';
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '2048', 10);

// Default models per provider
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-1.5-flash',
  'gemini-oauth': 'gemini-2.5-flash',
};

function resolveModel(providerOverride) {
  const provider = providerOverride || PROVIDER;
  return MODEL_OVERRIDE || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

async function anthropicChat(messages, tools, orgOverride) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = resolveModel('anthropic');

  const params = {
    model,
    max_tokens: MAX_TOKENS,
    messages,
  };
  if (tools && tools.length > 0) params.tools = tools;

  const response = await client.messages.create(params);
  return {
    provider: 'anthropic',
    model,
    content: response.content,
    stop_reason: response.stop_reason,
    usage: response.usage,
  };
}

async function anthropicVision(imageBase64, mimeType, prompt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = resolveModel('anthropic');

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  return { provider: 'anthropic', model, text };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

function toOpenAITools(tools) {
  if (!tools) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function openaiChat(messages, tools) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = resolveModel('openai');

  const params = { model, max_tokens: MAX_TOKENS, messages };
  const oaiTools = toOpenAITools(tools);
  if (oaiTools) params.tools = oaiTools;

  const response = await client.chat.completions.create(params);
  const choice = response.choices[0];

  // Normalize to Anthropic-like content blocks for uniform handling
  const content = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  const stop_reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { provider: 'openai', model, content, stop_reason, usage: response.usage };
}

async function openaiVision(imageBase64, mimeType, prompt) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = resolveModel('openai');

  const response = await client.chat.completions.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.choices[0].message.content || '';
  return { provider: 'openai', model, text };
}

// ─── Google ───────────────────────────────────────────────────────────────────

function toGoogleMessages(messages) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.content)
        ? m.content.map(b => b.type === 'text' ? { text: b.text } : { text: JSON.stringify(b) })
        : [{ text: m.content }],
    }));
}

async function googleChat(messages, tools) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = resolveModel('google');
  const genModel = genai.getGenerativeModel({ model });

  const system = messages.find(m => m.role === 'system');
  const history = toGoogleMessages(messages.slice(0, -1));
  const lastMsg = messages[messages.length - 1];
  const lastText = Array.isArray(lastMsg.content)
    ? lastMsg.content.map(b => b.text || '').join('')
    : lastMsg.content;

  const chat = genModel.startChat({
    history,
    systemInstruction: system ? system.content : undefined,
  });

  const result = await chat.sendMessage(lastText);
  const text = result.response.text();

  return {
    provider: 'google',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {},
  };
}

async function googleVision(imageBase64, mimeType, prompt) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = resolveModel('google');
  const genModel = genai.getGenerativeModel({ model });

  const result = await genModel.generateContent([
    { inlineData: { mimeType, data: imageBase64 } },
    prompt,
  ]);
  const text = result.response.text();
  return { provider: 'google', model, text };
}

// ─── Gemini OAuth (cloudcode-pa) ──────────────────────────────────────────────

let _geminiOAuthToken = null;
let _geminiOAuthExpiry = 0;
let _geminiProjectId = null;

async function getGeminiOAuthToken() {
  if (_geminiOAuthToken && Date.now() < _geminiOAuthExpiry - 60000) return _geminiOAuthToken;

  // Resolve refresh token: env var first, then creds file
  let refreshToken = process.env.GEMINI_REFRESH_TOKEN;
  if (!refreshToken) {
    const credsPath = process.env.GEMINI_OAUTH_CREDS || `${process.env.HOME}/.gemini-home/.gemini/oauth_creds.json`;
    try { refreshToken = JSON.parse(fs.readFileSync(credsPath, 'utf8')).refresh_token; } catch {}
  }
  if (!refreshToken) throw new Error('No GEMINI_REFRESH_TOKEN configured');

  const clientId = process.env.GEMINI_CLIENT_ID;
  const clientSecret = process.env.GEMINI_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GEMINI_CLIENT_ID / GEMINI_CLIENT_SECRET not set');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  const tokenData = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!tokenData.access_token) throw new Error(`Gemini OAuth token refresh failed: ${JSON.stringify(tokenData)}`);
  _geminiOAuthToken = tokenData.access_token;
  _geminiOAuthExpiry = Date.now() + (tokenData.expires_in || 3600) * 1000;
  return _geminiOAuthToken;
}

function toGeminiOAuthContents(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const text = Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : m.content;
    result.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  return result;
}

function cloudcodePost(path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'cloudcode-pa.googleapis.com',
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getGeminiProject(token) {
  if (_geminiProjectId) return _geminiProjectId;
  const res = await cloudcodePost('/v1internal:loadCodeAssist', {
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    cloudaicompanionProject: null,
  }, token);
  if (!res.cloudaicompanionProject) throw new Error('loadCodeAssist returned no project');
  _geminiProjectId = res.cloudaicompanionProject;
  return _geminiProjectId;
}

async function geminiOAuthChat(messages) {
  const token = await getGeminiOAuthToken();
  const project = await getGeminiProject(token);
  const model = resolveModel('gemini-oauth');
  const system = messages.find(m => m.role === 'system');
  const contents = toGeminiOAuthContents(messages);

  const res = await cloudcodePost('/v1internal:generateContent', {
    model,
    project,
    request: {
      model: `models/${model}`,
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system.content }] } } : {}),
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
    },
  }, token);

  if (res.error) throw new Error(`Gemini error: ${res.error.message}`);
  const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { provider: 'gemini-oauth', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} };
}

async function geminiOAuthVision(imageBase64, mimeType, prompt) {
  const token = await getGeminiOAuthToken();
  const project = await getGeminiProject(token);
  const model = resolveModel('gemini-oauth');

  const res = await cloudcodePost('/v1internal:generateContent', {
    model,
    project,
    request: {
      model: `models/${model}`,
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    },
  }, token);

  if (res.error) throw new Error(`Gemini error: ${res.error.message}`);
  const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { provider: 'gemini-oauth', model, text };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a chat request.
 * @param {Array} messages - [{role, content}]
 * @param {Array} [tools] - Anthropic-format tool definitions
 * @param {string} [providerOverride] - 'anthropic'|'openai'|'google'|'gemini-oauth'
 */
async function chat(messages, tools = null, providerOverride = null) {
  const provider = providerOverride || PROVIDER;
  switch (provider) {
    case 'openai': return openaiChat(messages, tools);
    case 'google': return googleChat(messages, tools);
    case 'gemini-oauth': return geminiOAuthChat(messages);
    default: return anthropicChat(messages, tools);
  }
}

/**
 * Send a vision (image analysis) request.
 * @param {string} imageBase64 - base64-encoded image
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @param {string} prompt
 * @param {string} [providerOverride]
 */
async function vision(imageBase64, mimeType, prompt, providerOverride = null) {
  const provider = providerOverride || PROVIDER;
  switch (provider) {
    case 'openai': return openaiVision(imageBase64, mimeType, prompt);
    case 'google': return googleVision(imageBase64, mimeType, prompt);
    case 'gemini-oauth': return geminiOAuthVision(imageBase64, mimeType, prompt);
    default: return anthropicVision(imageBase64, mimeType, prompt);
  }
}

/**
 * Extract plain text from a chat response's content blocks.
 */
function extractText(response) {
  if (!response || !response.content) return '';
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Extract tool_use blocks from a chat response.
 */
function extractToolUses(response) {
  if (!response || !response.content) return [];
  return response.content.filter(b => b.type === 'tool_use');
}

module.exports = { chat, vision, extractText, extractToolUses, PROVIDER, resolveModel };
