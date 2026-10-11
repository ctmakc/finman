// test/ai-provider.test.js — lib/ai/provider: provider resolution per owner law,
// request shapes + response parsing for google / gemini-oauth / openai / ollama / anthropic,
// real streaming paths (SSE / NDJSON) with chunk fallback, vision, error mapping.
// axios is mocked: no network.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

jest.mock('axios');
const axios = require('axios');

const provider = require('../lib/ai/provider');
const { config, resetOAuthCache } = provider._internal;

const ENV_KEYS = [
  'AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_MAX_TOKENS',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'GEMINI_CLIENT_ID', 'GEMINI_CLIENT_SECRET', 'GEMINI_REFRESH_TOKEN', 'GEMINI_OAUTH_CREDS',
  'OLLAMA_API_KEY', 'OLLAMA_API_KEY_FILE', 'OLLAMA_BASE_URL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_ALLOW_HOME_CREDENTIALS', 'HOME',
];
let saved = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  axios.post.mockReset();
  resetOAuthCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function sse(lines) {
  return Readable.from([Buffer.from(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(''))]);
}
function ndjson(objs) {
  return Readable.from([Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n')]);
}
const geminiReply = (text) => ({ candidates: [{ content: { parts: [{ text }], role: 'model' } }] });

// ---------------------------------------------------------------------------
describe('provider resolution (owner law: google -> gemini-oauth -> ollama -> openai, anthropic opt-in)', () => {
  test('nothing configured -> not configured, null provider', () => {
    expect(provider.resolveProviderName()).toBeNull();
    expect(provider.isConfigured()).toBe(false);
    expect(provider.describe()).toMatchObject({ provider: null, configured: false });
  });

  test('GOOGLE_API_KEY alone -> google with gemini-2.5-flash', () => {
    process.env.GOOGLE_API_KEY = 'g-key';
    expect(provider.resolveProviderName()).toBe('google');
    expect(config()).toMatchObject({ name: 'google', model: 'gemini-2.5-flash', apiKey: 'g-key', configured: true });
  });

  test('generic AI_API_KEY with no AI_PROVIDER -> NOT guessed onto any provider (never sent to Google)', async () => {
    process.env.AI_API_KEY = 'sk-proj-some-openai-key';
    expect(provider.resolveProviderName()).toBeNull();
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      status: 503,
      code: 'AI_NOT_CONFIGURED',
      message: expect.stringContaining('AI_PROVIDER'),
    });
    expect(axios.post).not.toHaveBeenCalled();
    // a provider-specific key still auto-resolves, and the generic key does not leak into it
    process.env.OPENAI_API_KEY = 'oa';
    expect(config()).toMatchObject({ name: 'openai', apiKey: 'oa' });
  });

  test('AI_API_KEY reaches google only with an explicit AI_PROVIDER=google', () => {
    process.env.AI_API_KEY = 'g-generic';
    process.env.AI_PROVIDER = 'google';
    expect(config()).toMatchObject({ name: 'google', apiKey: 'g-generic', configured: true });
    process.env.AI_PROVIDER = 'openai';
    expect(config()).toMatchObject({ name: 'openai', apiKey: 'g-generic' });
    expect(config({ provider: 'google' })).toMatchObject({ name: 'google', apiKey: 'g-generic' });
  });

  test('OLLAMA_API_KEY alone -> ollama cloud at https://ollama.com', () => {
    process.env.OLLAMA_API_KEY = 'o-key';
    expect(provider.resolveProviderName()).toBe('ollama');
    expect(config()).toMatchObject({ name: 'ollama', baseURL: 'https://ollama.com', apiKey: 'o-key' });
  });

  test('OPENAI_API_KEY alone -> openai', () => {
    process.env.OPENAI_API_KEY = 'oa-key';
    expect(provider.resolveProviderName()).toBe('openai');
  });

  test('Gemini OAuth env alone -> gemini-oauth; google key beats it', () => {
    process.env.GEMINI_CLIENT_ID = 'cid';
    process.env.GEMINI_CLIENT_SECRET = 'sec';
    process.env.GEMINI_REFRESH_TOKEN = 'rt';
    expect(provider.resolveProviderName()).toBe('gemini-oauth');
    process.env.GOOGLE_API_KEY = 'g';
    expect(provider.resolveProviderName()).toBe('google');
  });

  test('priority: google > gemini-oauth > ollama > openai when several are set', () => {
    process.env.OPENAI_API_KEY = 'a';
    process.env.OLLAMA_API_KEY = 'b';
    expect(provider.resolveProviderName()).toBe('ollama');
    process.env.GEMINI_CLIENT_ID = 'cid';
    process.env.GEMINI_CLIENT_SECRET = 'sec';
    process.env.GEMINI_REFRESH_TOKEN = 'rt';
    expect(provider.resolveProviderName()).toBe('gemini-oauth');
    process.env.GOOGLE_API_KEY = 'g';
    expect(provider.resolveProviderName()).toBe('google');
  });

  test('anthropic only as explicit opt-in; without a key it stays unconfigured', () => {
    process.env.ANTHROPIC_API_KEY = 'ant';
    expect(provider.resolveProviderName()).toBeNull(); // never auto-selected
    process.env.AI_PROVIDER = 'anthropic';
    expect(provider.resolveProviderName()).toBe('anthropic');
    expect(provider.isConfigured()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(provider.isConfigured()).toBe(false);
  });

  test('unknown AI_PROVIDER -> unconfigured (no silent fallback)', () => {
    process.env.AI_PROVIDER = 'nope';
    process.env.AI_API_KEY = 'k';
    expect(provider.resolveProviderName()).toBeNull();
    expect(provider.isConfigured()).toBe(false);
  });

  test('explicit AI_PROVIDER=ollama uses AI_API_KEY and AI_BASE_URL (local server needs no key)', () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.AI_API_KEY = 'ok';
    expect(config()).toMatchObject({ name: 'ollama', apiKey: 'ok', baseURL: 'https://ollama.com' });
    delete process.env.AI_API_KEY;
    expect(provider.isConfigured()).toBe(false);
    process.env.AI_BASE_URL = 'http://localhost:11434/';
    expect(config()).toMatchObject({ configured: true, apiKey: '', baseURL: 'http://localhost:11434' });
  });

  test('home credential files are read only with AI_ALLOW_HOME_CREDENTIALS=1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `ai-home-${process.pid}-`));
    try {
      fs.mkdirSync(path.join(home, '.ollama'));
      fs.writeFileSync(path.join(home, '.ollama', 'api_key'), 'home-ollama\n');
      fs.mkdirSync(path.join(home, '.gemini-home', '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini-home', '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'home-rt' }));
      process.env.HOME = home;
      process.env.GEMINI_CLIENT_ID = 'cid';
      process.env.GEMINI_CLIENT_SECRET = 'sec';
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production'; // the opt-in, not NODE_ENV, is the guard
      try {
        expect(provider.resolveProviderName()).toBeNull();
        expect(provider.isConfigured('ollama')).toBe(false);
        process.env.AI_ALLOW_HOME_CREDENTIALS = '1';
        expect(provider.resolveProviderName()).toBe('gemini-oauth');
        expect(config({ provider: 'ollama' }).apiKey).toBe('home-ollama');
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('Ollama key file: OLLAMA_API_KEY_FILE is honoured', () => {
    const file = path.join(os.tmpdir(), `ollama-key-${process.pid}.txt`);
    fs.writeFileSync(file, 'file-key\n');
    try {
      expect(provider.resolveProviderName()).toBeNull();
      process.env.OLLAMA_API_KEY_FILE = file;
      expect(provider.resolveProviderName()).toBe('ollama');
      expect(config().apiKey).toBe('file-key');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('GEMINI_OAUTH_CREDS json file supplies the refresh token', () => {
    const file = path.join(os.tmpdir(), `gemini-creds-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ refresh_token: 'from-file' }));
    try {
      process.env.GEMINI_CLIENT_ID = 'cid';
      process.env.GEMINI_CLIENT_SECRET = 'sec';
      expect(provider.resolveProviderName()).toBeNull();
      process.env.GEMINI_OAUTH_CREDS = file;
      expect(provider.resolveProviderName()).toBe('gemini-oauth');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('capabilities: streaming/vision per provider', () => {
    process.env.GOOGLE_API_KEY = 'g';
    expect(provider.supportsStreaming()).toBe(true);
    expect(provider.supportsVision()).toBe(true);
    process.env.OLLAMA_API_KEY = 'o';
    expect(provider.supportsVision('ollama')).toBe(false);
    expect(provider.supportsStreaming('ollama')).toBe(true);
    process.env.ANTHROPIC_API_KEY = 'a';
    expect(provider.supportsStreaming('anthropic')).toBe(false);
    expect(provider.supportsVision('anthropic')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('google (Gemini REST, API key)', () => {
  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'g-key';
  });

  test('chat: request shape + response parsing', async () => {
    axios.post.mockResolvedValue({ data: geminiReply('Hello from Gemini') });
    const out = await provider.chat({
      system: 'SYS',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }],
      maxTokens: 123,
    });
    expect(out).toEqual({ text: 'Hello from Gemini', provider: 'google', model: 'gemini-2.5-flash' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(url).not.toContain('g-key');
    expect(axios.post.mock.calls[0][2].headers['x-goog-api-key']).toBe('g-key');
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'yo' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
    expect(body.generationConfig.maxOutputTokens).toBe(123);
  });

  test('AI_MODEL and AI_MAX_TOKENS are honoured', async () => {
    process.env.AI_MODEL = 'gemini-2.5-pro';
    process.env.AI_MAX_TOKENS = '777';
    axios.post.mockResolvedValue({ data: geminiReply('x') });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-pro:generateContent');
    expect(body.generationConfig.maxOutputTokens).toBe(777);
  });

  test('chatStream: real SSE streaming via :streamGenerateContent?alt=sse', async () => {
    axios.post.mockResolvedValue({ data: sse([geminiReply('Hel'), geminiReply('lo '), geminiReply('world')]) });
    const chunks = [];
    const out = await provider.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, (t) => chunks.push(t));
    expect(chunks).toEqual(['Hel', 'lo ', 'world']);
    expect(out).toMatchObject({ text: 'Hello world', streamed: true, provider: 'google' });
    const [url, , opts] = axios.post.mock.calls[0];
    expect(url).toMatch(/:streamGenerateContent\?alt=sse$/);
    expect(opts.headers['x-goog-api-key']).toBe('g-key');
    expect(opts.responseType).toBe('stream');
  });

  test('vision: inline_data part + prompt, parsed text', async () => {
    axios.post.mockResolvedValue({ data: geminiReply('{"total":12.5}') });
    const out = await provider.vision({ imageBase64: 'QUJD', mimeType: 'image/png', prompt: 'Read it' });
    expect(out.text).toBe('{"total":12.5}');
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toMatch(/:generateContent$/);
    expect(opts.headers['x-goog-api-key']).toBe('g-key');
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/png', data: 'QUJD' } });
    expect(body.contents[0].parts[1]).toEqual({ text: 'Read it' });
  });

  test('HTTP error -> AppError 502 AI_REQUEST_FAILED', async () => {
    const err = new Error('boom');
    err.response = { status: 429, data: { error: { message: 'quota' } } };
    axios.post.mockRejectedValue(err);
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      status: 502,
      code: 'AI_REQUEST_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
describe('gemini-oauth (cloudcode-pa, refresh-token flow)', () => {
  beforeEach(() => {
    process.env.GEMINI_CLIENT_ID = 'cid';
    process.env.GEMINI_CLIENT_SECRET = 'sec';
    process.env.GEMINI_REFRESH_TOKEN = 'rt';
  });

  test('chat: token refresh -> loadCodeAssist -> generateContent; token + project cached', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'AT', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { cloudaicompanionProject: 'proj-1' } })
      .mockResolvedValueOnce({ data: { response: geminiReply('oauth reply') } })
      .mockResolvedValueOnce({ data: { response: geminiReply('second') } });

    const out = await provider.chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(out).toEqual({ text: 'oauth reply', provider: 'gemini-oauth', model: 'gemini-2.5-flash' });

    const [tokenUrl, tokenBody, tokenOpts] = axios.post.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(String(tokenBody)).toContain('grant_type=refresh_token');
    expect(String(tokenBody)).toContain('refresh_token=rt');
    expect(String(tokenBody)).toContain('client_id=cid');
    expect(tokenOpts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const [lcaUrl, lcaBody, lcaOpts] = axios.post.mock.calls[1];
    expect(lcaUrl).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    expect(lcaBody.metadata.pluginType).toBe('GEMINI');
    expect(lcaOpts.headers.Authorization).toBe('Bearer AT');

    const [genUrl, genBody] = axios.post.mock.calls[2];
    expect(genUrl).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(genBody.project).toBe('proj-1');
    expect(genBody.model).toBe('gemini-2.5-flash');
    expect(genBody.request.model).toBe('models/gemini-2.5-flash');
    expect(genBody.request.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(genBody.request.generationConfig.maxOutputTokens).toBe(50);

    // Second call reuses token + project: exactly one more request.
    await provider.chat({ messages: [{ role: 'user', content: 'again' }] });
    expect(axios.post).toHaveBeenCalledTimes(4);
  });

  test('chatStream: SSE wrapper { response: {...} } is unwrapped', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'AT', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { cloudaicompanionProject: 'proj-1' } })
      .mockResolvedValueOnce({ data: sse([{ response: geminiReply('a') }, { response: geminiReply('b') }]) });
    const chunks = [];
    const out = await provider.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, (t) => chunks.push(t));
    expect(chunks).toEqual(['a', 'b']);
    expect(out).toMatchObject({ text: 'ab', streamed: true });
    expect(axios.post.mock.calls[2][0]).toBe('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
  });

  test('vision: inline_data under request.contents', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'AT', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { cloudaicompanionProject: 'proj-1' } })
      .mockResolvedValueOnce({ data: { response: geminiReply('seen') } });
    const out = await provider.vision({ imageBase64: 'QUJD', mimeType: 'image/jpeg', prompt: 'p' });
    expect(out.text).toBe('seen');
    const body = axios.post.mock.calls[2][1];
    expect(body.request.contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
  });

  test('token refresh failure -> 502', async () => {
    axios.post.mockResolvedValueOnce({ data: { error: 'invalid_grant' } });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 502 });
  });

  test('API error envelope -> 502', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'AT', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { cloudaicompanionProject: 'proj-1' } })
      .mockResolvedValueOnce({ data: { error: { message: 'nope' } } });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 502 });
  });
});

// ---------------------------------------------------------------------------
describe('openai (OpenAI-compatible)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'oa-key';
  });

  test('chat: /v1/chat/completions, Bearer, system first, max_tokens', async () => {
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'gpt says' } }] } });
    const out = await provider.chat({ system: 'S', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 });
    expect(out).toEqual({ text: 'gpt says', provider: 'openai', model: 'gpt-4o-mini' });
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'q' });
    expect(body.max_tokens).toBe(10);
    expect(body.stream).toBeUndefined();
    expect(opts.headers.Authorization).toBe('Bearer oa-key');
  });

  test('AI_BASE_URL points to a compatible gateway', async () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = 'https://gw.example.com/';
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'x' } }] } });
    await provider.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(axios.post.mock.calls[0][0]).toBe('https://gw.example.com/v1/chat/completions');
  });

  test('chatStream: stream:true, SSE deltas, [DONE] ignored', async () => {
    const stream = Readable.from([
      Buffer.from('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'),
      Buffer.from('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n'),
      Buffer.from('data: [DONE]\n\n'),
    ]);
    axios.post.mockResolvedValue({ data: stream });
    const chunks = [];
    const out = await provider.chatStream({ messages: [{ role: 'user', content: 'q' }] }, (t) => chunks.push(t));
    expect(chunks).toEqual(['Hel', 'lo']);
    expect(out).toMatchObject({ text: 'Hello', streamed: true });
    expect(axios.post.mock.calls[0][1].stream).toBe(true);
    expect(axios.post.mock.calls[0][2].responseType).toBe('stream');
  });

  test('vision: image_url data URL + text part', async () => {
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: '{"total":1}' } }] } });
    const out = await provider.vision({ imageBase64: 'QUJD', mimeType: 'image/png', prompt: 'read' });
    expect(out.text).toBe('{"total":1}');
    const body = axios.post.mock.calls[0][1];
    expect(body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'read' });
  });
});

// ---------------------------------------------------------------------------
describe('ollama (Ollama Cloud)', () => {
  beforeEach(() => {
    process.env.OLLAMA_API_KEY = 'o-key';
  });

  test('chat: https://ollama.com/api/chat, Bearer, stream:false, num_predict', async () => {
    axios.post.mockResolvedValue({ data: { message: { role: 'assistant', content: 'llama says' } } });
    const out = await provider.chat({ system: 'S', messages: [{ role: 'user', content: 'q' }], maxTokens: 42 });
    expect(out).toEqual({ text: 'llama says', provider: 'ollama', model: 'gpt-oss:20b' });
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://ollama.com/api/chat');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(42);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(opts.headers.Authorization).toBe('Bearer o-key');
  });

  test('chatStream: NDJSON stream', async () => {
    axios.post.mockResolvedValue({
      data: ndjson([
        { message: { content: 'A' }, done: false },
        { message: { content: 'B' }, done: false },
        { message: { content: '' }, done: true },
      ]),
    });
    const chunks = [];
    const out = await provider.chatStream({ messages: [{ role: 'user', content: 'q' }] }, (t) => chunks.push(t));
    expect(chunks).toEqual(['A', 'B']);
    expect(out).toMatchObject({ text: 'AB', streamed: true });
    expect(axios.post.mock.calls[0][1].stream).toBe(true);
  });

  test('vision unsupported -> 501 AI_VISION_UNSUPPORTED', async () => {
    await expect(provider.vision({ imageBase64: 'QUJD', mimeType: 'image/png', prompt: 'p' })).rejects.toMatchObject({
      status: 501,
      code: 'AI_VISION_UNSUPPORTED',
    });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('anthropic (explicit opt-in only)', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_API_KEY = 'ant-key';
  });

  test('chat: x-api-key header, /v1/messages', async () => {
    axios.post.mockResolvedValue({ data: { content: [{ type: 'text', text: 'claude says' }] } });
    const out = await provider.chat({ system: 'S', messages: [{ role: 'user', content: 'q' }] });
    expect(out.text).toBe('claude says');
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.system).toBe('S');
    expect(opts.headers['x-api-key']).toBe('ant-key');
  });

  test('chatStream falls back to chunking (no stream path)', async () => {
    const long = 'x'.repeat(150);
    axios.post.mockResolvedValue({ data: { content: [{ type: 'text', text: long }] } });
    const chunks = [];
    const out = await provider.chatStream({ messages: [{ role: 'user', content: 'q' }] }, (t) => chunks.push(t));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(long);
    expect(out).toMatchObject({ text: long, streamed: false });
    expect(axios.post.mock.calls[0][1].stream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('per-call overrides and guards', () => {
  test('provider/model override routes to another configured provider, ignoring env AI_MODEL/AI_BASE_URL', async () => {
    process.env.AI_PROVIDER = 'google';
    process.env.GOOGLE_API_KEY = 'g';
    process.env.AI_MODEL = 'gemini-2.5-pro';
    process.env.AI_BASE_URL = 'https://google-proxy.example';
    process.env.OPENAI_API_KEY = 'oa';
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'ok' } }] } });
    const out = await provider.chat({ messages: [{ role: 'user', content: 'q' }], provider: 'openai', model: 'gpt-4.1-mini' });
    expect(out).toEqual({ text: 'ok', provider: 'openai', model: 'gpt-4.1-mini' });
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.model).toBe('gpt-4.1-mini');
  });

  test('override of an unconfigured provider -> 503', async () => {
    process.env.GOOGLE_API_KEY = 'g';
    await expect(provider.chat({ messages: [{ role: 'user', content: 'q' }], provider: 'openai' })).rejects.toMatchObject({
      status: 503,
      code: 'AI_NOT_CONFIGURED',
    });
  });

  test('not configured -> 503 for chat, chatStream and vision; no network', async () => {
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ status: 503, code: 'AI_NOT_CONFIGURED' });
    await expect(provider.chatStream({ messages: [] }, () => {})).rejects.toMatchObject({ status: 503 });
    await expect(provider.vision({ imageBase64: 'x' })).rejects.toMatchObject({ status: 503 });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('non user/assistant messages are dropped before sending', async () => {
    process.env.GOOGLE_API_KEY = 'g';
    axios.post.mockResolvedValue({ data: geminiReply('ok') });
    await provider.chat({ messages: [{ role: 'system', content: 'leak' }, { role: 'user', content: 'q' }] });
    expect(axios.post.mock.calls[0][1].contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);
  });
});
