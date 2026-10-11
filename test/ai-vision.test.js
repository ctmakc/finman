// test/ai-vision.test.js — PORT_PLAN A14: receipt vision through the AI provider with
// tesseract fallback. Provider mocked (no network); tesseract replaced by a text stub.

const path = require('path');
const { makeApp } = require('./helpers/app');

const mockProvider = {
  _configured: true,
  _vision: true,
  _answer: null,
  isConfigured: jest.fn(() => mockProvider._configured),
  supportsVision: jest.fn(() => mockProvider._configured && mockProvider._vision),
  chat: jest.fn(async () => ({ text: 'unused' })),
  vision: jest.fn(async (args) => {
    const a = typeof mockProvider._answer === 'function' ? mockProvider._answer(args) : mockProvider._answer;
    if (a instanceof Error) throw a;
    return { text: a, provider: 'google', model: 'gemini-2.5-flash' };
  }),
};
jest.mock('../lib/ai/provider', () => mockProvider);

const PROJECT_ROOT = path.join(__dirname, '..');
const ocrService = require(path.join(PROJECT_ROOT, 'services', 'ocrService'));

const TESSERACT_TEXT = ['СІЛЬПО', 'Молоко 2.5% 1шт      32,50', 'СУМА ДО СПЛАТИ       246,40', '19.06.2026 14:23', 'грн'].join('\n');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_MAGIC.toString('base64')}`;

// The caller (routes/receipts.js) grants vision per user (AI opt-in + tier); without it -> tesseract.
const VISION = { vision: true };

const GOOD_JSON = {
  total: 246.4,
  currency: 'UAH',
  date: '2026-06-19',
  merchant: 'Сільпо',
  items: [{ name: 'Молоко 2.5%', price: 32.5 }, { name: 'Хліб', price: 24 }],
};

let originalRecognize;
beforeAll(() => {
  originalRecognize = ocrService.recognizeBuffer;
  ocrService.recognizeBuffer = jest.fn(async () => TESSERACT_TEXT);
});
afterAll(() => {
  ocrService.recognizeBuffer = originalRecognize;
});
beforeEach(() => {
  mockProvider._configured = true;
  mockProvider._vision = true;
  mockProvider._answer = JSON.stringify(GOOD_JSON);
  mockProvider.vision.mockClear();
  mockProvider.isConfigured.mockClear();
  mockProvider.supportsVision.mockClear();
  ocrService.recognizeBuffer.mockClear();
});

// ---------------------------------------------------------------------------
describe('ocrService.processImage — vision first, tesseract fallback', () => {
  test('vision configured + supported -> parsed JSON result, tesseract untouched', async () => {
    const out = await ocrService.processImage(PNG_DATA_URL, VISION);
    expect(out).toMatchObject({
      ocr_status: 'completed',
      ocr_engine: 'vision',
      ocr_provider: 'google',
      merchant: 'Сільпо',
      total_amount: 246.4,
      currency: 'UAH',
      receipt_date: '2026-06-19',
    });
    expect(out.items).toEqual([{ name: 'Молоко 2.5%', price: 32.5 }, { name: 'Хліб', price: 24 }]);
    expect(out.category).toBeTruthy();
    expect(ocrService.recognizeBuffer).not.toHaveBeenCalled();

    const args = mockProvider.vision.mock.calls[0][0];
    expect(args.mimeType).toBe('image/png');
    expect(args.imageBase64).toBe(PNG_MAGIC.toString('base64'));
    expect(args.prompt).toContain('JSON');
    expect(args.prompt).toContain('"total"');
  });

  test('fenced ```json answer with prose around it is still parsed', async () => {
    mockProvider._answer = 'Sure! Here it is:\n```json\n' + JSON.stringify(GOOD_JSON) + '\n```\nHope it helps.';
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('vision');
    expect(out.total_amount).toBe(246.4);
    expect(mockProvider.vision.mock.calls[0][0].mimeType).toBe('image/jpeg');
  });

  test('vision returns garbage -> tesseract fallback', async () => {
    mockProvider._answer = 'I cannot read this image.';
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('tesseract');
    expect(out.ocr_status).toBe('completed');
    expect(out.total_amount).toBe(246.4);
    expect(out.merchant.toUpperCase()).toContain('СІЛЬПО');
    expect(ocrService.recognizeBuffer).toHaveBeenCalledTimes(1);
  });

  test('vision JSON without total and merchant -> tesseract fallback', async () => {
    mockProvider._answer = JSON.stringify({ total: null, currency: null, date: null, merchant: null, items: [] });
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('tesseract');
    expect(ocrService.recognizeBuffer).toHaveBeenCalledTimes(1);
  });

  test('vision throws (provider error) -> tesseract fallback, never rejects', async () => {
    mockProvider._answer = new Error('HTTP 429');
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('tesseract');
    expect(out.ocr_status).toBe('completed');
  });

  test('provider configured but without vision support (e.g. ollama) -> tesseract only', async () => {
    mockProvider._vision = false;
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('tesseract');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });

  test('provider not configured -> tesseract only', async () => {
    mockProvider._configured = false;
    const out = await ocrService.processImage(JPEG_BYTES, VISION);
    expect(out.ocr_engine).toBe('tesseract');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });

  test('no vision option -> tesseract only: the image never leaves the server by default', async () => {
    const out = await ocrService.processImage(JPEG_BYTES);
    expect(out.ocr_engine).toBe('tesseract');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });

  test('options.vision === false forces tesseract', async () => {
    const out = await ocrService.processImage(JPEG_BYTES, { vision: false });
    expect(out.ocr_engine).toBe('tesseract');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });

  test('empty input -> failed status without calling vision', async () => {
    const out = await ocrService.processImage(Buffer.alloc(0), VISION);
    expect(out.ocr_status).toBe('failed');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('ocrService.parseVisionJson / detectMimeType (pure)', () => {
  test('normalizes string total, lowercase currency, dd.mm.yyyy date, filters bad items', () => {
    const parsed = ocrService.parseVisionJson(
      JSON.stringify({
        total: '1 234,50',
        currency: 'uah',
        date: '19.06.2026',
        merchant: '  ATB   Market  ',
        items: [{ name: 'Milk', price: '32,50' }, { name: '', price: 1 }, null, { name: 'Bread' }],
      })
    );
    expect(parsed).toEqual({
      total_amount: 1234.5,
      currency: 'UAH',
      receipt_date: '2026-06-19',
      merchant: 'ATB Market',
      items: [{ name: 'Milk', price: 32.5 }, { name: 'Bread', price: null }],
    });
  });

  test('currency text like "грн" maps through detectCurrency; unknown date -> null', () => {
    const parsed = ocrService.parseVisionJson('{"total": 10, "currency": "грн", "date": "sometime", "merchant": "X", "items": []}');
    expect(parsed.currency).toBe('UAH');
    expect(parsed.receipt_date).toBeNull();
  });

  test('non-JSON / empty -> null', () => {
    expect(ocrService.parseVisionJson('')).toBeNull();
    expect(ocrService.parseVisionJson('no braces here')).toBeNull();
    expect(ocrService.parseVisionJson('{not json}')).toBeNull();
  });

  test('detectMimeType: data URL prefix, PNG/JPEG/WEBP magic, jpeg default', () => {
    expect(ocrService.detectMimeType('data:image/webp;base64,AAAA', Buffer.alloc(0))).toBe('image/webp');
    expect(ocrService.detectMimeType(PNG_MAGIC, PNG_MAGIC)).toBe('image/png');
    expect(ocrService.detectMimeType(JPEG_BYTES, JPEG_BYTES)).toBe('image/jpeg');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
    expect(ocrService.detectMimeType(webp, webp)).toBe('image/webp');
    expect(ocrService.detectMimeType(Buffer.alloc(20, 7), Buffer.alloc(20, 7))).toBe('image/jpeg');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/receipts/upload uses vision results', () => {
  let ctx;
  let routeOcr;
  let routeOrigRecognize;
  beforeAll(async () => {
    ctx = await makeApp();
    // makeApp() reloads services: stub tesseract on the route's own ocrService instance too.
    routeOcr = require(path.join(PROJECT_ROOT, 'services', 'ocrService'));
    routeOrigRecognize = routeOcr.recognizeBuffer;
    routeOcr.recognizeBuffer = jest.fn(async () => TESSERACT_TEXT);
  });
  afterAll(() => {
    if (routeOcr) routeOcr.recognizeBuffer = routeOrigRecognize;
  });
  afterAll(async () => ctx && ctx.close());

  test('user not opted in to AI -> tesseract, vision never called', async () => {
    const res = await ctx.request
      .post('/api/receipts/upload')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ image_data: PNG_DATA_URL });
    expect(res.status).toBe(201);
    expect(res.body.merchant).toBe('СІЛЬПО');
    expect(mockProvider.vision).not.toHaveBeenCalled();
  });

  test('stores merchant/total/date from the vision JSON', async () => {
    await require('../db/database').run('UPDATE users SET ai_opt_in = 1 WHERE id = ?', [ctx.userId]);
    const res = await ctx.request
      .post('/api/receipts/upload')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ image_data: PNG_DATA_URL });
    expect(res.status).toBe(201);
    expect(res.body.ocr_status).toBe('completed');
    expect(res.body.merchant).toBe('Сільпо');
    expect(res.body.total_amount).toBe(246.4);
    expect(res.body.currency).toBe('UAH');
    expect(res.body.receipt_date).toBe('2026-06-19');
    expect(mockProvider.vision).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('receipt dates and "$" (review findings 7-8)', () => {
  const NOW = new Date(2026, 9, 11); // 2026-10-11 local

  test('validReceiptDate: calendar round-trip + [today-2y, today+1d]', () => {
    const v = ocrService.validReceiptDate;
    expect(v(2026, 2, 31, NOW)).toBeNull(); // 31 Feb
    expect(v(2025, 2, 29, NOW)).toBeNull(); // not a leap year
    expect(v(2026, 10, 11, NOW)).toBe('2026-10-11');
    expect(v(2026, 10, 12, NOW)).toBe('2026-10-12'); // +1 day tolerance (time zones)
    expect(v(2026, 10, 13, NOW)).toBeNull();
    expect(v(2024, 10, 11, NOW)).toBe('2024-10-11');
    expect(v(2024, 10, 10, NOW)).toBeNull();
    expect(v(2062, 6, 19, NOW)).toBeNull();
  });

  test('vision JSON: impossible or out-of-range dates -> null', () => {
    const date = (d) => ocrService.parseVisionJson(JSON.stringify({ total: 1, merchant: 'X', date: d }), NOW).receipt_date;
    expect(date('2026-02-31')).toBeNull();
    expect(date('2016-06-19')).toBeNull();
    expect(date('2027-01-01')).toBeNull();
    expect(date('2026-06-19')).toBe('2026-06-19');
    expect(date('19.06.2026')).toBe('2026-06-19');
  });

  test('tesseract text: skips an invalid candidate, ISO not misread as dd-mm-yy', () => {
    expect(ocrService.detectDate('Tel 31.02.2026  Date 05.10.2026', NOW)).toBe('2026-10-05');
    expect(ocrService.detectDate('2026-06-19 14:23', NOW)).toBe('2026-06-19');
    expect(ocrService.detectDate('99.99.9999', NOW)).toBeNull();
  });

  test('bare "$" -> deployment dollar (DEFAULT_CURRENCY when a dollar, else USD); explicit codes win', () => {
    const prev = process.env.DEFAULT_CURRENCY;
    try {
      jest.isolateModules(() => {
        process.env.DEFAULT_CURRENCY = 'CAD';
        const svc = require('../services/ocrService');
        expect(svc.detectCurrency('TOTAL $12.50')).toBe('CAD');
        expect(svc.detectCurrency('TOTAL US$12.50')).toBe('USD');
        expect(svc.detectCurrency('TOTAL 12.50 USD')).toBe('USD');
        expect(svc.detectCurrency('TOTAL 12,50 грн')).toBe('UAH');
      });
      jest.isolateModules(() => {
        process.env.DEFAULT_CURRENCY = 'UAH';
        const svc = require('../services/ocrService');
        expect(svc.detectCurrency('TOTAL $12.50')).toBe('USD');
        expect(svc.detectCurrency('TOTAL C$12.50')).toBe('CAD');
      });
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_CURRENCY;
      else process.env.DEFAULT_CURRENCY = prev;
    }
  });
});
