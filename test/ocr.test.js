// test/ocr.test.js — тесты РЕАЛЬНОГО OCR-парсера и роута чеков.
//
// ВАЖНО: мы НЕ зависим от настоящего tesseract (wasm/сеть) — мокаем
// ocrService.recognizeBuffer (для processImage) и ocrService.processImage
// (для роутового теста), скармливая известный текст. Тестируем именно ПАРСЕР.

const path = require('path');
const { makeApp } = require('./helpers/app');

const PROJECT_ROOT = path.join(__dirname, '..');
const ocrService = require(path.join(PROJECT_ROOT, 'services', 'ocrService'));

// Образец текста украинского чека (то, что "вернул бы" tesseract).
const SAMPLE_RECEIPT_TEXT = [
  'СІЛЬПО',
  'м. Київ, вул. Хрещатик 1',
  'Молоко 2.5% 1шт      32,50',
  'Хліб бородинський    24,00',
  'Кава мелена          189,90',
  'ПДВ 20%              41,07',
  'СУМА ДО СПЛАТИ       246,40',
  'Готівка              300,00',
  'Решта                53,60',
  '19.06.2026 14:23',
  'грн'
].join('\n');

describe('ocrService.parseReceiptText (чистый парсер)', () => {
  test('извлекает магазин из верхней содержательной строки', () => {
    const parsed = ocrService.parseReceiptText(SAMPLE_RECEIPT_TEXT);
    expect(parsed.merchant).toBeTruthy();
    expect(parsed.merchant.toUpperCase()).toContain('СІЛЬПО');
  });

  test('извлекает итог по ключевому слову СУМА (а не самое большое число)', () => {
    const parsed = ocrService.parseReceiptText(SAMPLE_RECEIPT_TEXT);
    // 246.40 — это "СУМА ДО СПЛАТИ"; 300.00 (Готівка) НЕ должно стать итогом.
    expect(parsed.total_amount).toBe(246.4);
  });

  test('извлекает дату в формате YYYY-MM-DD', () => {
    const parsed = ocrService.parseReceiptText(SAMPLE_RECEIPT_TEXT);
    expect(parsed.receipt_date).toBe('2026-06-19');
  });

  test('определяет валюту (грн -> UAH)', () => {
    const parsed = ocrService.parseReceiptText(SAMPLE_RECEIPT_TEXT);
    expect(parsed.currency).toBe('UAH');
  });

  test('извлекает позиции чека с ценами', () => {
    const parsed = ocrService.parseReceiptText(SAMPLE_RECEIPT_TEXT);
    const names = parsed.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes('молоко'))).toBe(true);
    expect(names.some((n) => n.includes('кава'))).toBe(true);
    const milk = parsed.items.find((i) => i.name.toLowerCase().includes('молоко'));
    expect(milk.price).toBe(32.5);
    // Служебные строки (СУМА/Готівка/Решта/ПДВ) не должны быть позициями.
    expect(names.some((n) => n.includes('сума'))).toBe(false);
    expect(names.some((n) => n.includes('готівка') || n.includes('готивка'))).toBe(false);
  });
});

describe('ocrService.parseAmount (нормализация чисел)', () => {
  test('1 234,56 -> 1234.56', () => {
    expect(ocrService.parseAmount('1 234,56')).toBe(1234.56);
  });
  test('1.234,56 -> 1234.56 (евро-формат)', () => {
    expect(ocrService.parseAmount('1.234,56')).toBe(1234.56);
  });
  test('1,234.56 -> 1234.56 (US-формат)', () => {
    expect(ocrService.parseAmount('1,234.56')).toBe(1234.56);
  });
  test('246,40 грн -> 246.4', () => {
    expect(ocrService.parseAmount('246,40 грн')).toBe(246.4);
  });
});

describe('ocrService.detectTotal fallback', () => {
  test('без ключевого слова берёт наибольшее число', () => {
    const lines = ['Товар А 10,00', 'Товар Б 55,00', 'Товар В 7,00'];
    expect(ocrService.detectTotal(lines)).toBe(55);
  });
});

describe('ocrService.categorizeReceipt', () => {
  test('супермаркет -> food', () => {
    expect(ocrService.categorizeReceipt('СІЛЬПО супермаркет молоко')).toBe('food');
  });
  test('АЗС WOG паливо -> transport', () => {
    expect(ocrService.categorizeReceipt('WOG паливо А95')).toBe('transport');
  });
  test('аптека -> health', () => {
    expect(ocrService.categorizeReceipt('Аптека Доброго Дня')).toBe('health');
  });
  test('неизвестное -> other', () => {
    expect(ocrService.categorizeReceipt('xyz zzz')).toBe('other');
  });
});

describe('ocrService.processImage (с мокнутым tesseract)', () => {
  let origRecognize;
  afterEach(() => {
    if (origRecognize) {
      ocrService.recognizeBuffer = origRecognize;
      origRecognize = null;
    }
  });

  test('успех: ставит ocr_status=completed и парсит поля', async () => {
    origRecognize = ocrService.recognizeBuffer;
    ocrService.recognizeBuffer = async () => SAMPLE_RECEIPT_TEXT;

    const fakeImage = Buffer.from('not-a-real-image-but-non-empty');
    const out = await ocrService.processImage(fakeImage);

    expect(out.ocr_status).toBe('completed');
    expect(out.total_amount).toBe(246.4);
    expect(out.merchant.toUpperCase()).toContain('СІЛЬПО');
    expect(out.currency).toBe('UAH');
    expect(out.category).toBe('food');
    expect(out.ocr_raw).toContain('СУМА');
  });

  test('ошибка распознавания: ставит ocr_status=failed и не бросает', async () => {
    origRecognize = ocrService.recognizeBuffer;
    ocrService.recognizeBuffer = async () => {
      throw new Error('tesseract boom (corrupt image)');
    };

    const out = await ocrService.processImage(Buffer.from('garbage'));
    expect(out.ocr_status).toBe('failed');
    expect(out.total_amount).toBeNull();
    expect(out.merchant).toBeNull();
    expect(out.items).toEqual([]);
  });

  test('пустой текст (нечего распознавать): ocr_status=failed', async () => {
    origRecognize = ocrService.recognizeBuffer;
    ocrService.recognizeBuffer = async () => '   ';

    const out = await ocrService.processImage(Buffer.from('x'));
    expect(out.ocr_status).toBe('failed');
  });

  test('пустой вход изображения: ocr_status=failed без вызова tesseract', async () => {
    origRecognize = ocrService.recognizeBuffer;
    let called = false;
    ocrService.recognizeBuffer = async () => {
      called = true;
      return SAMPLE_RECEIPT_TEXT;
    };
    const out = await ocrService.processImage(Buffer.alloc(0));
    expect(out.ocr_status).toBe('failed');
    expect(called).toBe(false);
  });
});

describe('ocrService.decodeImageInput', () => {
  test('data-URL -> Buffer (содержимое после запятой)', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const buf = ocrService.decodeImageInput(`data:image/png;base64,${b64}`);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('hello');
  });
  test('Buffer на входе возвращается как есть', () => {
    const b = Buffer.from('abc');
    expect(ocrService.decodeImageInput(b)).toBe(b);
  });
});

describe('POST /api/receipts/upload (роут, OCR мокнут)', () => {
  let ctx;
  let origProcessImage;
  // ВАЖНО: makeApp() сбрасывает require-кэш для services/* и routes/*, поэтому
  // роут видит СВОЙ свежий экземпляр ocrService. Чтобы мок реально подменил
  // вызов внутри роута, берём ТОТ ЖЕ экземпляр из кэша ПОСЛЕ makeApp().
  let routeOcrService;

  beforeAll(async () => {
    ctx = await makeApp();
    routeOcrService = require(path.join(PROJECT_ROOT, 'services', 'ocrService'));
  });

  afterAll(async () => {
    if (origProcessImage) routeOcrService.processImage = origProcessImage;
    if (ctx) await ctx.close();
  });

  test('сохраняет РЕАЛЬНЫЕ распознанные данные и ocr_status=completed', async () => {
    origProcessImage = routeOcrService.processImage;
    routeOcrService.processImage = async () => ({
      ocr_status: 'completed',
      ocr_raw: SAMPLE_RECEIPT_TEXT,
      merchant: 'СІЛЬПО',
      total_amount: 246.4,
      currency: 'UAH',
      receipt_date: '2026-06-19',
      category: 'food',
      items: [{ name: 'Молоко', price: 32.5, quantity: 1 }]
    });

    const res = await ctx.request
      .post('/api/receipts/upload')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ image_data: 'data:image/png;base64,' + Buffer.from('x').toString('base64') });

    expect(res.status).toBe(201);
    expect(res.body.ocr_status).toBe('completed');
    expect(res.body.total_amount).toBe(246.4);
    expect(res.body.merchant).toBe('СІЛЬПО');

    // Проверяем, что в БД лёг реальный результат, а не фейк.
    const fetched = await ctx.request
      .get('/api/receipts/' + res.body.id)
      .set('Authorization', 'Bearer ' + ctx.token);
    expect(fetched.status).toBe(200);
    expect(fetched.body.ocr_status).toBe('completed');
    expect(fetched.body.total_amount).toBe(246.4);
    expect(fetched.body.merchant).toBe('СІЛЬПО');
    expect(fetched.body.ocr_raw).toContain('СУМА');

    routeOcrService.processImage = origProcessImage;
    origProcessImage = null;
  });

  test('битое изображение: ocr_status=failed, запись создана, без 500', async () => {
    origProcessImage = routeOcrService.processImage;
    routeOcrService.processImage = async () => ({
      ocr_status: 'failed',
      ocr_raw: null,
      merchant: null,
      total_amount: null,
      currency: null,
      receipt_date: null,
      category: null,
      items: []
    });

    const res = await ctx.request
      .post('/api/receipts/upload')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({ image_data: 'data:image/png;base64,bm90YW5pbWFnZQ==' });

    expect(res.status).toBe(201);
    expect(res.body.ocr_status).toBe('failed');

    const fetched = await ctx.request
      .get('/api/receipts/' + res.body.id)
      .set('Authorization', 'Bearer ' + ctx.token);
    expect(fetched.body.ocr_status).toBe('failed');

    routeOcrService.processImage = origProcessImage;
    origProcessImage = null;
  });

  test('без image_data -> 400', async () => {
    const res = await ctx.request
      .post('/api/receipts/upload')
      .set('Authorization', 'Bearer ' + ctx.token)
      .send({});
    expect(res.status).toBe(400);
  });
});
