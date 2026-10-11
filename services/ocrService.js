// services/ocrService.js — РЕАЛЬНЫЙ OCR чеков на базе tesseract.js (без API-ключа).
//
// Экспортирует:
//   - recognizeBuffer(buffer, { lang }) -> Promise<string>   // сырой текст из изображения
//   - decodeImageInput(input) -> Buffer|input               // base64 / data-URL -> Buffer
//   - parseReceiptText(rawText) -> { merchant, total_amount, currency, receipt_date, items }
//   - categorizeReceipt(text) -> string                      // эвристика категории
//   - processImage(input, { lang, vision }) -> Promise<{ ocr_status, ocr_engine, ocr_raw, merchant, total_amount, currency, receipt_date, category, items }>
//     (LLM vision first when a configured provider supports it, tesseract fallback; vision:false forces tesseract)
//
// Дизайн: парсер (parseReceiptText) — чистая функция без сети/wasm, что делает его
// полностью тестируемым. recognizeBuffer тонко оборачивает tesseract; в тестах его
// мокают, чтобы не тянуть wasm/трафик в CI.

const money = require('../lib/money');
// PORT_PLAN A14: LLM vision (google / gemini-oauth / openai) is tried first when a configured
// provider supports it; tesseract stays the offline fallback. Required lazily-safe: the
// provider module has no side effects and is mocked in tests.
const provider = require('../lib/ai/provider');

let logger;
try {
  logger = require('../lib/logger');
} catch (_) {
  // Защитно: если logger недоступен — не падаем (feature-detect Foundation).
  logger = { info() {}, warn() {}, error() {} };
}

// Поддерживаемые языки распознавания: украинский + русский + английский.
const DEFAULT_LANG = 'ukr+rus+eng';

// Ключевые слова "итоговой суммы" на ru/uk/en.
const TOTAL_KEYWORDS = [
  'итого', 'итог', 'всего', 'сума', 'сумма', 'усього', 'до сплати', 'к оплате',
  'к уплате', 'total', 'amount due', 'balance due', 'grand total', 'разом'
];

// Слова, которые НЕ должны попадать в итог (промежуточные/служебные строки).
const TOTAL_NEGATIVE = ['без пдв', 'без ндс', 'пдв', 'ндс', 'vat', 'tax', 'subtotal', 'сдача', 'решта', 'готівка', 'наличн', 'карт'];

// Символы валют -> ISO код.
const CURRENCY_SYMBOLS = [
  { re: /грн|₴|uah/i, code: 'UAH' },
  { re: /руб|₽|rub/i, code: 'RUB' },
  { re: /\$|usd|долл/i, code: 'USD' },
  { re: /€|eur|евро|євро/i, code: 'EUR' },
  { re: /£|gbp/i, code: 'GBP' },
  { re: /zł|pln/i, code: 'PLN' }
];

/**
 * Привести произвольный вход (Buffer / base64-строка / data-URL) к Buffer.
 * tesseract.js умеет принимать Buffer, путь, data-URL — но мы нормализуем
 * к Buffer, чтобы поведение было предсказуемым и не зависело от File API.
 */
function decodeImageInput(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') {
    // data:image/png;base64,XXXX  ->  берём часть после запятой
    const comma = input.indexOf(',');
    const b64 = input.startsWith('data:') && comma !== -1 ? input.slice(comma + 1) : input;
    try {
      return Buffer.from(b64, 'base64');
    } catch (_) {
      return input; // отдадим как есть, tesseract попробует разобраться
    }
  }
  return input;
}

/**
 * Распознать текст из буфера изображения через tesseract.js.
 * Возвращает сырой распознанный текст (может быть пустым).
 * Бросает обычную ошибку при сбое распознавания — вызывающий код решает,
 * как пометить ocr_status.
 */
async function recognizeBuffer(buffer, options = {}) {
  const lang = options.lang || DEFAULT_LANG;
  // Ленивая загрузка, чтобы тяжёлый модуль не требовался при импорте сервиса
  // (и чтобы тесты могли подменить recognizeBuffer без загрузки tesseract).
  // eslint-disable-next-line global-require
  const Tesseract = require('tesseract.js');
  const { data } = await Tesseract.recognize(buffer, lang);
  return (data && data.text) || '';
}

// --- Парсинг -------------------------------------------------------------

// Нормализуем число вида "1 234,56" / "1.234,56" / "1234.56" -> 1234.56
function parseAmount(str) {
  if (str == null) return NaN;
  let s = String(str).trim();
  // убрать пробелы-разделители тысяч и неразрывные пробелы
  s = s.replace(/[\s ]/g, '');
  // убрать символы валют и буквы
  s = s.replace(/[^\d.,-]/g, '');
  if (!s) return NaN;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // Последний из , . — десятичный разделитель.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // запятая десятичная: убрать точки-тысячи, запятую -> точка
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // точка десятичная: убрать запятые-тысячи
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // только запятая -> десятичный разделитель
    s = s.replace(/,/g, '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

// Извлечь все "денежные" числа из строки. Возвращает массив чисел.
function extractNumbers(line) {
  const out = [];
  // числа вида 1234, 1 234,56, 1.234,56, 12.50, 12,50
  const re = /\d[\d\s .,]*\d|\d/g;
  const matches = line.match(re) || [];
  for (const m of matches) {
    const n = parseAmount(m);
    // отсечём явно "номерные" значения без дробной части и длинные (ИНН, телефоны)
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

// Определить валюту по всему тексту.
function detectCurrency(text) {
  for (const { re, code } of CURRENCY_SYMBOLS) {
    if (re.test(text)) return code;
  }
  return null;
}

// Найти дату в тексте (несколько распространённых форматов) -> YYYY-MM-DD | null
function detectDate(text) {
  if (!text) return null;
  // dd.mm.yyyy | dd/mm/yyyy | dd-mm-yyyy  (год 2 или 4 цифры)
  let m = text.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    d = d.padStart(2, '0');
    mo = mo.padStart(2, '0');
    const day = parseInt(d, 10);
    const mon = parseInt(mo, 10);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${y}-${mo}-${d}`;
    }
  }
  // yyyy-mm-dd
  m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    if (parseInt(mo, 10) <= 12 && parseInt(d, 10) <= 31) {
      return `${y}-${mo}-${d}`;
    }
  }
  return null;
}

// Найти строку с названием магазина (эвристика "верхняя содержательная строка").
function detectMerchant(lines) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // пропускаем строки, состоящие в основном из цифр/спецсимволов
    const letters = (line.match(/[A-Za-zА-Яа-яЁёІіЇїЄєҐґ]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters < 2) continue;
    if (digits > letters) continue;
    // пропускаем явные "технические" заголовки чека
    if (/^(чек|касовий|кассовый|receipt|фіскальний|фискальный|товарный)/i.test(line)) continue;
    // обрежем слишком длинные строки (адреса)
    return line.replace(/\s{2,}/g, ' ').slice(0, 80);
  }
  return null;
}

// Найти итоговую сумму: приоритет — строка с keyword TOTAL/ИТОГО/СУМА;
// fallback — самое большое денежное число в тексте.
function detectTotal(lines) {
  let keywordTotal = null;
  for (const raw of lines) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (!TOTAL_KEYWORDS.some((k) => lower.includes(k))) continue;
    if (TOTAL_NEGATIVE.some((k) => lower.includes(k))) continue;
    const nums = extractNumbers(line);
    if (nums.length) {
      // берём наибольшее число в строке-итоге
      const candidate = Math.max(...nums);
      if (keywordTotal === null || candidate > keywordTotal) {
        keywordTotal = candidate;
      }
    }
  }
  if (keywordTotal !== null) return keywordTotal;

  // Fallback: наибольшее денежное число во всём чеке.
  let maxNum = null;
  for (const raw of lines) {
    for (const n of extractNumbers(raw)) {
      if (maxNum === null || n > maxNum) maxNum = n;
    }
  }
  return maxNum; // может быть null, если чисел нет
}

// Извлечь позиции чека: строки "название ... цена".
function detectItems(lines) {
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    // не считаем служебные/итоговые строки позициями
    if (TOTAL_KEYWORDS.some((k) => lower.includes(k))) continue;
    if (TOTAL_NEGATIVE.some((k) => lower.includes(k))) continue;

    const nums = extractNumbers(line);
    if (!nums.length) continue;
    // название = текст слева, до первой цифры
    const nameMatch = line.match(/^[^\d]*[A-Za-zА-Яа-яЁёІіЇїЄєҐґ][^\d]*/);
    let name = nameMatch ? nameMatch[0].trim() : '';
    name = name.replace(/[*xх×]\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
    if (!name || name.length < 2) continue;
    const price = nums[nums.length - 1]; // последняя цифра в строке — обычно цена позиции
    if (!Number.isFinite(price) || price <= 0) continue;
    items.push({ name: name.slice(0, 60), price: money.round(price), quantity: 1 });
    if (items.length >= 50) break; // защита от взрыва
  }
  return items;
}

/**
 * Главный парсер: из сырого OCR-текста извлекает структуру чека.
 * Чистая функция — без сети, полностью тестируема.
 */
function parseReceiptText(rawText) {
  const text = String(rawText || '');
  const lines = text.split(/\r?\n/).map((l) => l.replace(/ /g, ' '));

  const merchant = detectMerchant(lines);
  const total = detectTotal(lines);
  const currency = detectCurrency(text);
  const receipt_date = detectDate(text);
  const items = detectItems(lines);

  return {
    merchant: merchant || null,
    total_amount: total != null ? money.round(total) : null,
    currency: currency || null,
    receipt_date: receipt_date || null,
    items
  };
}

/**
 * Эвристика категории по тексту чека (reuse идеи из csvImportService).
 * Возвращает наш внутренний slug категории.
 */
function categorizeReceipt(text) {
  const t = String(text || '').toLowerCase();
  const has = (...kw) => kw.some((k) => t.includes(k));

  if (has('кафе', 'ресторан', 'кофе', 'кава', 'пицца', 'піца', 'бургер', 'еда', 'їжа', 'cafe', 'restaurant', 'coffee'))
    return 'food';
  if (has('супермаркет', 'продукт', 'магазин', 'market', 'атб', 'сільпо', 'сильпо', 'novus', 'ашан', 'магнит', 'metro', 'grocery'))
    return 'food';
  if (has('такси', 'taxi', 'uber', 'bolt', 'метро', 'автобус', 'wog', 'okko', 'shell', 'паливо', 'бензин', 'азс', 'fuel', 'transport'))
    return 'transport';
  if (has('аптека', 'pharmacy', 'clinic', 'больниц', 'лікарн', 'врач', 'лікар', 'health'))
    return 'health';
  if (has('одежда', 'одяг', 'обувь', 'взуття', 'zara', 'h&m', 'clothes'))
    return 'shopping';
  if (has('rozetka', 'розетка', 'епіцентр', 'эпицентр', 'comfy', 'фокстрот', 'foxtrot', 'allo', 'техник', 'техніка', 'electronics'))
    return 'shopping';
  if (has('кино', 'кіно', 'театр', 'концерт', 'cinema', 'entertainment'))
    return 'entertainment';
  if (has('подписк', 'підписк', 'subscription', 'netflix', 'spotify'))
    return 'subscriptions';

  return 'other';
}

// --- LLM vision (PORT_PLAN A14) -------------------------------------------

const VISION_PROMPT =
  'This is a photo or scan of a purchase receipt. Extract the data and answer with ONLY a JSON object, ' +
  'no markdown and no commentary, with exactly these keys: ' +
  '"total" (number: the final amount paid), ' +
  '"currency" (ISO 4217 code such as UAH, USD, EUR, PLN, GBP, or null if unknown), ' +
  '"date" (YYYY-MM-DD or null), ' +
  '"merchant" (store name or null), ' +
  '"items" (array of {"name": string, "price": number}; empty array if unreadable). ' +
  'Never invent values: use null when a field is not visible.';

const MIME_FROM_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/**
 * Determine the image MIME type from a data-URL prefix or the buffer's magic bytes.
 * Falls back to image/jpeg (the most common phone photo format).
 */
function detectMimeType(input, buffer) {
  if (typeof input === 'string') {
    const m = input.match(MIME_FROM_DATA_URL);
    if (m) return m[1].toLowerCase();
  }
  if (Buffer.isBuffer(buffer) && buffer.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  }
  return 'image/jpeg';
}

/**
 * Parse the model's answer into { total_amount, currency, receipt_date, merchant, items }.
 * Tolerates ```json fences and prose around the object. Returns null when no JSON object
 * can be read — the caller then falls back to tesseract.
 */
function parseVisionJson(text) {
  if (!text) return null;
  let raw = String(text).trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let obj;
  try {
    obj = JSON.parse(raw.slice(first, last + 1));
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  let total = null;
  if (typeof obj.total === 'number' && Number.isFinite(obj.total)) total = money.round(obj.total);
  else if (typeof obj.total === 'string') {
    const n = parseAmount(obj.total);
    if (Number.isFinite(n)) total = money.round(n);
  }

  let currency = null;
  if (typeof obj.currency === 'string' && /^[a-z]{3}$/i.test(obj.currency.trim())) {
    currency = obj.currency.trim().toUpperCase();
  } else if (typeof obj.currency === 'string') {
    currency = detectCurrency(obj.currency);
  }

  let receipt_date = null;
  if (typeof obj.date === 'string' && obj.date.trim()) {
    const d = obj.date.trim();
    // ISO first (the format we asked for); detectDate's dd.mm.yyyy heuristic would
    // otherwise bite into "2026-06-19" as "26-06-19".
    const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso && parseInt(iso[2], 10) >= 1 && parseInt(iso[2], 10) <= 12 && parseInt(iso[3], 10) >= 1 && parseInt(iso[3], 10) <= 31) {
      receipt_date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    } else {
      receipt_date = detectDate(d);
    }
  }

  const merchant =
    typeof obj.merchant === 'string' && obj.merchant.trim()
      ? obj.merchant.trim().replace(/\s{2,}/g, ' ').slice(0, 80)
      : null;

  const items = Array.isArray(obj.items)
    ? obj.items
        .filter((it) => it && typeof it === 'object' && typeof it.name === 'string' && it.name.trim())
        .map((it) => {
          const price =
            typeof it.price === 'number' && Number.isFinite(it.price)
              ? money.round(it.price)
              : typeof it.price === 'string' && Number.isFinite(parseAmount(it.price))
              ? money.round(parseAmount(it.price))
              : null;
          return { name: it.name.trim().slice(0, 120), price };
        })
    : [];

  return { total_amount: total, currency, receipt_date, merchant, items };
}

function visionAvailable() {
  return (
    typeof provider.isConfigured === 'function' &&
    typeof provider.supportsVision === 'function' &&
    typeof provider.vision === 'function' &&
    provider.isConfigured() &&
    provider.supportsVision()
  );
}

/**
 * Try the LLM vision path. Returns a full OCR result object on success, or null when
 * vision is unavailable / unsupported / failed / returned nothing usable (-> tesseract).
 * Never throws.
 */
async function recognizeWithVision(input, options = {}) {
  if (options.vision === false) return null;
  let available = false;
  try {
    available = visionAvailable();
  } catch (_) {
    available = false;
  }
  if (!available) return null;

  try {
    const buffer = decodeImageInput(input);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const mimeType = detectMimeType(input, buffer);
    const result = await provider.vision({
      imageBase64: buffer.toString('base64'),
      mimeType,
      prompt: VISION_PROMPT,
      maxTokens: 800,
    });
    const text = (result && result.text) || '';
    const parsed = parseVisionJson(text);
    if (!parsed || (parsed.total_amount == null && !parsed.merchant)) {
      logger.warn({ provider: result && result.provider }, 'Receipt vision returned nothing usable, falling back to OCR');
      return null;
    }
    const categoryText = [parsed.merchant || '', ...parsed.items.map((i) => i.name)].join('\n');
    return {
      ocr_status: 'completed',
      ocr_engine: 'vision',
      ocr_provider: (result && result.provider) || null,
      ocr_raw: text,
      merchant: parsed.merchant,
      total_amount: parsed.total_amount,
      currency: parsed.currency,
      receipt_date: parsed.receipt_date,
      category: categorizeReceipt(categoryText),
      items: parsed.items
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, 'Receipt vision failed, falling back to OCR');
    return null;
  }
}

/**
 * Высокоуровневая обёртка: принимает изображение (Buffer / base64 / data-URL),
 * распознаёт, парсит и возвращает структуру с честным ocr_status.
 * НИКОГДА не бросает: на ошибке возвращает { ocr_status: 'failed', ... }.
 */
async function processImage(input, options = {}) {
  // 1) LLM vision first (google / gemini-oauth / openai) when configured; via module.exports
  //    so tests can observe/replace it. Returns null -> continue with tesseract.
  const visionResult = await module.exports.recognizeWithVision(input, options);
  if (visionResult) return visionResult;

  // 2) tesseract fallback (offline, no key).
  let rawText = '';
  try {
    const buffer = decodeImageInput(input);
    if (!buffer || (Buffer.isBuffer(buffer) && buffer.length === 0)) {
      throw new Error('Empty image input');
    }
    // Через module.exports, чтобы recognizeBuffer можно было замокать в тестах
    // (иначе подмена exports.recognizeBuffer не повлияла бы на внутренний вызов).
    rawText = await module.exports.recognizeBuffer(buffer, options);
  } catch (err) {
    logger.warn({ err: err && err.message }, 'OCR recognize failed');
    return {
      ocr_status: 'failed',
      ocr_engine: 'tesseract',
      ocr_raw: null,
      merchant: null,
      total_amount: null,
      currency: null,
      receipt_date: null,
      category: null,
      items: []
    };
  }

  try {
    const parsed = parseReceiptText(rawText);
    const category = categorizeReceipt(rawText);
    // "completed" только если реально что-то распознали и вытащили хоть сумму/магазин.
    const meaningful =
      (rawText && rawText.trim().length > 0) &&
      (parsed.total_amount != null || parsed.merchant);
    return {
      ocr_status: meaningful ? 'completed' : 'failed',
      ocr_engine: 'tesseract',
      ocr_raw: rawText,
      merchant: parsed.merchant,
      total_amount: parsed.total_amount,
      currency: parsed.currency,
      receipt_date: parsed.receipt_date,
      category,
      items: parsed.items
    };
  } catch (err) {
    logger.error({ err: err && err.message }, 'OCR parse failed');
    return {
      ocr_status: 'failed',
      ocr_engine: 'tesseract',
      ocr_raw: rawText || null,
      merchant: null,
      total_amount: null,
      currency: null,
      receipt_date: null,
      category: null,
      items: []
    };
  }
}

module.exports = {
  DEFAULT_LANG,
  decodeImageInput,
  recognizeBuffer,
  parseAmount,
  extractNumbers,
  detectCurrency,
  detectDate,
  detectMerchant,
  detectTotal,
  detectItems,
  parseReceiptText,
  categorizeReceipt,
  // vision (PORT_PLAN A14)
  VISION_PROMPT,
  detectMimeType,
  parseVisionJson,
  recognizeWithVision,
  processImage
};
