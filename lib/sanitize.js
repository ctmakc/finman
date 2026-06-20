// lib/sanitize.js — небольшие input/output-санитайзеры (security-perf-v2).
//
// ADDITIVE-хелперы: их МОГУТ перенять другие модули (роуты, рендеринг
// уведомлений, AI-вывод), но они ничего не ломают сами по себе.
// Никаких зависимостей, без состояния, безопасны на любом входе.
//
//   escapeHtml(input)  -> экранирует & < > " ' / ` = для безопасной вставки
//                         пользовательских строк в HTML-контекст (анти-XSS).
//   stripUnsafe(input) -> удаляет управляющие/непечатаемые символы и
//                         обрезает строку; для логов и однострочных полей.
//   sanitizeFilename   -> безопасное имя файла (без path-traversal).
//
// Все функции тотальны: не-строки приводятся к строке (null/undefined -> '').

'use strict';

// Карта HTML-сущностей для экранирования.
const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

const HTML_ESCAPE_RE = /[&<>"'`=/]/g;

// Управляющие символы C0/C1 (кроме TAB/CR/LF), которые нельзя пускать в
// однострочные текстовые поля и логи. Класс строится из кодов символов,
// чтобы в исходнике НЕ было ни одного литерального управляющего байта.
//   C0 :  U+0000..U+0008, U+000B, U+000C, U+000E..U+001F
//   DEL: U+007F
//   C1 : U+0080..U+009F
function buildControlCharsRe() {
  const cc = (n) => '\\u' + n.toString(16).padStart(4, '0');
  const cls =
    cc(0x00) + '-' + cc(0x08) +
    cc(0x0b) +
    cc(0x0c) +
    cc(0x0e) + '-' + cc(0x1f) +
    cc(0x7f) +
    cc(0x80) + '-' + cc(0x9f);
  // eslint-disable-next-line no-control-regex
  return new RegExp('[' + cls + ']', 'g');
}

const CONTROL_CHARS_RE = buildControlCharsRe();

/**
 * Приводит любое значение к строке безопасным образом.
 * null/undefined -> ''. Объекты -> их String()-представление.
 * @param {*} input
 * @returns {string}
 */
function toStr(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  return String(input);
}

/**
 * Экранирует HTML-чувствительные символы, чтобы пользовательский ввод
 * можно было безопасно вставлять в HTML-контекст (защита от XSS).
 * НЕ применять повторно к уже экранированному (двойное экранирование исказит
 * текст) — вызывать один раз на границе вывода.
 * @param {*} input
 * @returns {string}
 */
function escapeHtml(input) {
  const s = toStr(input);
  if (!s) return '';
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ENTITIES[ch] || ch);
}

/**
 * Удаляет управляющие/непечатаемые символы и обрезает пробелы по краям.
 * Опционально ограничивает длину (для лог-полей и однострочных значений).
 * НЕ HTML-экранирует — это отдельная ответственность (см. escapeHtml).
 * @param {*} input
 * @param {{ maxLength?: number }} [opts]
 * @returns {string}
 */
function stripUnsafe(input, opts = {}) {
  let s = toStr(input);
  if (!s) return '';
  // Нормализуем таб/перевод строки в пробел, затем убираем управляющие символы.
  s = s.replace(/[\t\r\n]+/g, ' ').replace(CONTROL_CHARS_RE, '');
  s = s.trim();
  const max = Number.isInteger(opts.maxLength) ? opts.maxLength : null;
  if (max !== null && max >= 0 && s.length > max) {
    s = s.slice(0, max);
  }
  return s;
}

/**
 * Безопасное имя файла: убирает path-traversal, разделители каталогов и
 * управляющие символы; оставляет только базовое имя.
 * @param {*} input
 * @returns {string}
 */
function sanitizeFilename(input) {
  let s = stripUnsafe(input);
  if (!s) return '';
  // Берём только последний сегмент пути (защита от ../ и абсолютных путей).
  s = s.replace(/[\\/]+/g, '/');
  s = s.split('/').pop() || '';
  // Удаляем оставшиеся опасные символы для ФС и схлопываем точки.
  s = s.replace(/[^\w.\- ]+/g, '_').replace(/\.{2,}/g, '.');
  s = s.replace(/^\.+/, '').trim();
  return s;
}

module.exports = { escapeHtml, stripUnsafe, sanitizeFilename, toStr };
