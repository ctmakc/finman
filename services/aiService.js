/**
 * Multi-provider AI abstraction.
 * Set AI_PROVIDER=anthropic|openai|google in .env
 */
const config = require('../config/config');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MODEL_OVERRIDE = process.env.AI_MODEL || '';
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '2048', 10);

// Default models per provider
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-1.5-flash',
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a chat request.
 * @param {Array} messages - [{role, content}]
 * @param {Array} [tools] - Anthropic-format tool definitions
 * @param {string} [providerOverride] - 'anthropic'|'openai'|'google'
 */
async function chat(messages, tools = null, providerOverride = null) {
  const provider = providerOverride || PROVIDER;
  switch (provider) {
    case 'openai': return openaiChat(messages, tools);
    case 'google': return googleChat(messages, tools);
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
