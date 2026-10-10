// lib/txFilter.js — единый SQL-фильтр «денежного потока».
//
// В transactions лежат не только доходы/расходы: с wave-2 есть type='transfer'
// (две ноги перевода между счетами), а начальный баланс счёта записывается
// транзакцией с категорией 'Начальный баланс' (routes/accounts.js). И то и другое
// не является доходом/расходом и ломает аналитику: «+658 % к прошлому месяцу»,
// прогноз «+116.8 % за 30 дней», категория расходов «Начальный баланс».
//
// Если money-агент введёт явный флаг (type='opening' / is_opening), фильтр по
// type IN ('income','expense') уже исключает такие строки; категории — страховка
// для уже существующих данных.

const OPENING_CATEGORIES = ['Начальный баланс', 'Opening balance', 'Початковий баланс', 'Opening Balance'];

// Возвращает { sql, params } — фрагмент для WHERE (начинается с AND).
// alias — префикс таблицы ('t' -> 't.type'), по умолчанию без префикса.
function cashflowOnly(alias) {
  const p = alias ? `${alias}.` : '';
  const placeholders = OPENING_CATEGORIES.map(() => '?').join(', ');
  return {
    sql: ` AND ${p}type IN ('income', 'expense') AND COALESCE(${p}category, '') NOT IN (${placeholders})`,
    params: [...OPENING_CATEGORIES],
  };
}

module.exports = { OPENING_CATEGORIES, cashflowOnly };
