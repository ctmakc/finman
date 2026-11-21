// lib/vaultTables.js — какие таблицы составляют сейф пользователя (Finman Vault).
// Общий список для сервера (routes/vault.js: legacy-export, purge-legacy) и
// браузерного движка (engine/: импорт, счётчики). См. docs/E2E-ENCRYPTION.md.
//
// where — SQL-условие, выбирающее строки ОДНОГО пользователя; '?' везде = user_id
// (params — сколько раз подставить user_id). Порядок важен: родители раньше детей
// (импорт идёт сверху вниз, удаление — снизу вверх).

const U = (col = 'user_id') => ({ where: `${col} = ?`, params: 1 });
const sub = (col, parentSql) => ({ where: `${col} IN (${parentSql})`, params: (parentSql.match(/\?/g) || []).length });

const TX = 'SELECT id FROM transactions WHERE user_id = ?';
const GROUPS = 'SELECT id FROM split_groups WHERE user_id = ?';
const PORTF = 'SELECT id FROM investment_portfolios WHERE user_id = ?';
const INV = `SELECT id FROM investments WHERE portfolio_id IN (${PORTF})`;

const VAULT_TABLES = [
  { name: 'categories', ...U() },
  { name: 'custom_banks', ...U() },
  { name: 'bank_connections', ...U() },
  { name: 'accounts', ...U() },
  { name: 'transactions', ...U() },
  { name: 'tags', ...U() },
  { name: 'transaction_tags', ...sub('transaction_id', TX) },
  { name: 'budgets', ...U() },
  { name: 'recurring_payments', ...U() },
  { name: 'user_currency_settings', ...U() },
  { name: 'savings_goals', ...U() },
  { name: 'goal_contributions', ...sub('goal_id', 'SELECT id FROM savings_goals WHERE user_id = ?') },
  { name: 'debts', ...U() },
  { name: 'debt_payments', ...sub('debt_id', 'SELECT id FROM debts WHERE user_id = ?') },
  { name: 'split_groups', ...U() },
  { name: 'split_members', ...sub('group_id', GROUPS) },
  { name: 'split_expenses', ...sub('group_id', GROUPS) },
  { name: 'split_shares', ...sub('expense_id', `SELECT id FROM split_expenses WHERE group_id IN (${GROUPS})`) },
  { name: 'split_settlements', ...sub('group_id', GROUPS) },
  { name: 'notifications', ...U() },
  { name: 'notification_settings', ...U() },
  { name: 'investment_portfolios', ...U() },
  { name: 'investments', ...sub('portfolio_id', PORTF) },
  { name: 'investment_transactions', ...sub('investment_id', INV) },
  { name: 'investment_events', ...sub('investment_id', INV) },
  { name: 'subscriptions', ...U() },
  { name: 'subscription_payments', ...sub('subscription_id', 'SELECT id FROM subscriptions WHERE user_id = ?') },
  { name: 'receipts', ...U() },
  { name: 'networth_snapshots', ...U() },
  { name: 'manual_assets', ...U() },
  { name: 'dashboard_widgets', ...U() },
  { name: 'calendar_events', ...U() },
  { name: 'reports', ...U() },
  { name: 'category_rules', ...U() },
  { name: 'ai_chat_sessions', ...U() },
  { name: 'ai_conversations', ...U() },
  { name: 'ai_messages', ...sub('conversation_id', 'SELECT id FROM ai_conversations WHERE user_id = ?') },
  { name: 'ai_insights', ...U() },
  { name: 'onboarding_progress', ...U() },
  { name: 'user_ai_keys', ...U() },
  { name: 'ai_agent_threads', ...U() },
  { name: 'ai_agent_messages', ...U() },
  { name: 'ai_agent_actions', ...U() },
  // Совместный доступ (на проде 21.11 — 0 строк). В сейф идут строки, где
  // пользователь владелец; строки «мне дали доступ» удаляются вместе с его данными.
  { name: 'families', ...U('owner_id') },
  { name: 'family_members', ...U() },
  { name: 'family_invites', ...U('created_by') },
  { name: 'account_permissions', ...U() },
  { name: 'budget_permissions', ...U() },
];

function paramsFor(t, userId) {
  return Array.from({ length: t.params }, () => userId);
}

module.exports = { VAULT_TABLES, paramsFor };
