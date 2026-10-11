// lib/dates.js — даты в часовом поясе пользователя и «перекат» повторяющихся дат.
//
// Проблема: 72 места в коде берут `new Date().toISOString().split('T')[0]` — это
// UTC-дата, а не дата пользователя (вечером в Торонто уже «завтра» по UTC).
// Здесь — единая точка: todayISO(tz) + помощники для роутов, которые уже
// переведены на часовой пояс (forecast/calendar/recurring/subscriptions/analytics).
//
// Все функции работают со строками 'YYYY-MM-DD' и считают дни в UTC-арифметике,
// чтобы результат не зависел от TZ процесса node.

const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Toronto';

const fmtCache = new Map();

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Бросает RangeError на неизвестной зоне.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function formatterFor(tz) {
  const zone = isValidTz(tz) ? tz : DEFAULT_TZ;
  let f = fmtCache.get(zone);
  if (!f) {
    // en-CA даёт формат YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

// Сегодняшняя календарная дата в часовом поясе tz (по умолчанию DEFAULT_TZ).
// now — необязательный Date для тестов.
function todayISO(tz, now = new Date()) {
  const parts = formatterFor(tz).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Часовой пояс пользователя (строка users.timezone) или дефолт.
function userTz(user) {
  const tz = user && user.timezone;
  return isValidTz(tz) ? tz : DEFAULT_TZ;
}

// 'YYYY-MM-DD' -> Date в полночь UTC. Для невалидного ввода -> null.
function parseISO(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function toISO(dateUtc) {
  return dateUtc.toISOString().split('T')[0];
}

// Строгая календарная проверка 'YYYY-MM-DD' (2026-02-31 — не дата).
function isValidYMD(value) {
  const ymd = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  return toISO(parseISO(ymd)) === ymd;
}

// Сдвиг на n дней (n может быть отрицательным).
function addDaysISO(iso, n) {
  const d = parseISO(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

// Сдвиг на n месяцев с «прищепкой» к последнему дню месяца
// (31 янв + 1 мес = 28/29 фев). anchorDay — желаемый день месяца (по умолчанию
// день исходной даты): после 28 фев следующий месяц снова станет 31-м.
function addMonthsISO(iso, n, anchorDay) {
  const d = parseISO(iso);
  if (!d) return null;
  const day = anchorDay || d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return toISO(first);
}

// Разница в календарных днях b - a.
function diffDays(aISO, bISO) {
  const a = parseISO(aISO);
  const b = parseISO(bISO);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

// Шаг периодичности. Поддерживаются обе номенклатуры (recurring: daily/weekly/
// biweekly/monthly/quarterly/yearly; subscriptions: weekly/monthly/quarterly/yearly).
const PERIODS = {
  daily: { days: 1 },
  weekly: { days: 7 },
  biweekly: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  yearly: { months: 12 },
  annual: { months: 12 },
};

// Первая дата серии (start + k*period, k >= 0), которая >= today.
// Если start >= today — возвращает start как есть. Неизвестная частота -> start.
// anchorDay (необязательно) — день месяца для месячных серий (day_of_month).
function rollForward(startISO, frequency, today, anchorDay) {
  const start = parseISO(startISO);
  if (!start) return null;
  const todayStr = today || todayISO();
  const startStr = toISO(start);
  const period = PERIODS[frequency] || PERIODS.monthly;

  if (startStr >= todayStr) {
    // Для месячных серий всё равно применяем anchorDay (day_of_month).
    if (period.months && anchorDay) return addMonthsISO(startStr, 0, anchorDay);
    return startStr;
  }

  if (period.days) {
    const gap = diffDays(startStr, todayStr); // > 0
    const k = Math.ceil(gap / period.days);
    return addDaysISO(startStr, k * period.days);
  }

  // Месячные серии: считаем число периодов напрямую, затем корректируем ±1.
  const t = parseISO(todayStr);
  const monthsGap =
    (t.getUTCFullYear() - start.getUTCFullYear()) * 12 + (t.getUTCMonth() - start.getUTCMonth());
  let k = Math.floor(monthsGap / period.months);
  let candidate = addMonthsISO(startStr, k * period.months, anchorDay);
  while (candidate < todayStr) {
    k += 1;
    candidate = addMonthsISO(startStr, k * period.months, anchorDay);
  }
  return candidate;
}

// Первое число месяца / последнее число месяца для даты.
function startOfMonthISO(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}
function endOfMonthISO(iso) {
  const d = parseISO(iso);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return toISO(last);
}

module.exports = {
  DEFAULT_TZ,
  isValidTz,
  todayISO,
  userTz,
  parseISO,
  toISO,
  isValidYMD,
  addDaysISO,
  addMonthsISO,
  diffDays,
  rollForward,
  startOfMonthISO,
  endOfMonthISO,
  PERIODS,
};
