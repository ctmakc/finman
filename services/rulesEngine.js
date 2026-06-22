// services/rulesEngine.js — детерминированная категоризация транзакций
// по пользовательским правилам (закрывает gap Actual/Firefly: правила-категории).
//
// applyToUncategorized(userId, opts) -> { updated, suggestions }
//   - берёт расходные транзакции пользователя БЕЗ категории
//     (category IS NULL / пустая / плейсхолдер «Прочее»/«Без категории»/«Uncategorized»),
//   - прогоняет активные правила в порядке priority (меньше = раньше; первое
//     совпавшее правило выигрывает),
//   - выставляет set_category совпавшим транзакциям,
//   - возвращает число обновлённых + список предложений (tx -> category).
//
// Чисто детерминированно (без ИИ): одинаковый вход даёт одинаковый выход.
'use strict';

const { query, get, run, transaction } = require('../db/database');
const CategoryRule = require('../models/categoryRule');

// Плейсхолдеры «без категории», которые проставляет дефолт Transaction.create
// и репорт-слой. Считаем такие транзакции некатегоризированными.
const PLACEHOLDER_CATEGORIES = ['прочее', 'без категории', 'uncategorized'];

function isUncategorized(category) {
  if (category == null) return true;
  const c = String(category).trim().toLowerCase();
  if (c === '') return true;
  return PLACEHOLDER_CATEGORIES.includes(c);
}

// Скомпилировать пользовательский regex безопасно (невалидный -> null, не матчит).
function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch (_) {
    return null;
  }
}

// Проверка одного правила против транзакции. Возвращает boolean.
function ruleMatches(rule, tx) {
  const field = rule.match_field;
  const op = rule.match_op;
  const value = rule.match_value;

  // Числовой путь — поле amount. Сравниваем по модулю (расходы хранятся
  // отрицательными), чтобы правила писались в «человеческих» суммах.
  if (field === 'amount') {
    const txAmount = Math.abs(Number(tx.amount));
    const target = Math.abs(Number(value));
    if (!Number.isFinite(txAmount) || !Number.isFinite(target)) return false;
    switch (op) {
      case 'gt':
        return txAmount > target;
      case 'lt':
        return txAmount < target;
      case 'equals':
        return txAmount === target;
      case 'contains':
        return String(txAmount).includes(String(value));
      case 'regex': {
        const re = safeRegex(value);
        return re ? re.test(String(txAmount)) : false;
      }
      default:
        return false;
    }
  }

  // Текстовый путь — description / category.
  const haystack = String(tx[field] == null ? '' : tx[field]).toLowerCase();
  const needle = String(value == null ? '' : value).toLowerCase();

  switch (op) {
    case 'contains':
      return needle !== '' && haystack.includes(needle);
    case 'equals':
      return haystack === needle;
    case 'regex': {
      const re = safeRegex(value);
      return re ? re.test(String(tx[field] == null ? '' : tx[field])) : false;
    }
    case 'gt':
      return Number(tx[field]) > Number(value);
    case 'lt':
      return Number(tx[field]) < Number(value);
    default:
      return false;
  }
}

// Найти первое совпавшее правило (правила уже отсортированы по priority).
function firstMatch(rules, tx) {
  for (const rule of rules) {
    if (ruleMatches(rule, tx)) return rule;
  }
  return null;
}

// Получить некатегоризированные расходные транзакции пользователя.
async function getUncategorizedExpenses(userId, limit) {
  // ВАЖНО: SQLite LOWER() не понижает кириллицу ('Прочее' != 'прочее'), поэтому
  // плейсхолдер-фильтр делаем в JS через isUncategorized() (JS toLowerCase знает кириллицу).
  const rows = await query(
    `SELECT id, date, description, category, amount, type
       FROM transactions
      WHERE user_id = ? AND type = 'expense'
      ORDER BY date DESC, id DESC`,
    [userId]
  );
  const uncats = rows.filter((r) => isUncategorized(r.category));
  return limit ? uncats.slice(0, limit) : uncats;
}

// Основная операция: применить активные правила к некатегоризированным расходам.
// opts.dryRun = true -> только посчитать предложения, не писать в БД.
async function applyToUncategorized(userId, opts = {}) {
  const { dryRun = false, limit = null } = opts;

  const rules = await CategoryRule.findByUserId(userId, { activeOnly: true });
  const txs = await getUncategorizedExpenses(userId, limit);

  const suggestions = [];
  for (const tx of txs) {
    const rule = firstMatch(rules, tx);
    if (!rule) continue;
    // Если транзакция уже в нужной категории — не считаем изменением.
    if (!isUncategorized(tx.category) && String(tx.category) === rule.set_category) {
      continue;
    }
    suggestions.push({
      transactionId: tx.id,
      ruleId: rule.id,
      description: tx.description,
      from: tx.category == null ? null : tx.category,
      to: rule.set_category,
    });
  }

  if (dryRun || suggestions.length === 0) {
    return { updated: 0, suggestions };
  }

  // Пишем только категорию (баланс не трогаем) — одно поле, безопасно.
  // Оборачиваем в transaction() для сериализации с остальными писателями.
  let updated = 0;
  await transaction(async () => {
    for (const s of suggestions) {
      const result = await run(
        `UPDATE transactions
            SET category = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?`,
        [s.to, s.transactionId, userId]
      );
      if (result.changes > 0) updated += 1;
    }
  });

  return { updated, suggestions };
}

// Тест-предпросмотр: применить правила к произвольному списку транзакций
// (без обращения к БД). Полезно для UI «предпросмотр правила».
function previewRules(rules, txs) {
  const sorted = [...rules]
    .filter((r) => r.is_active === undefined || r.is_active)
    .sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
  const out = [];
  for (const tx of txs) {
    const rule = firstMatch(sorted, tx);
    if (rule) out.push({ transactionId: tx.id, to: rule.set_category, ruleId: rule.id });
  }
  return out;
}

module.exports = {
  applyToUncategorized,
  ruleMatches,
  firstMatch,
  previewRules,
  isUncategorized,
  getUncategorizedExpenses,
};
