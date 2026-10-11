// models/subscription.js — даты списания подписок.
//
// Раньше подписка со start_date 2024-02-15 показывала «Следующий платёж:
// 2024-02-15 ⚠️ Просрочен»: next_billing_date считался как start+1 цикл и больше
// не двигался. Здесь — перекат серии к первой дате >= сегодня (lib/dates.rollForward)
// и единое вычисление daysUntilBilling / isOverdue / isDueToday.

const { query, run } = require('../db/database');
const dates = require('../lib/dates');

const CYCLES = ['weekly', 'monthly', 'quarterly', 'yearly'];

function cycleOf(cycle) {
  return CYCLES.includes(cycle) ? cycle : 'monthly';
}

// Сдвиг на один цикл вперёд от даты.
function addCycle(iso, cycle) {
  const c = cycleOf(cycle);
  if (c === 'weekly') return dates.addDaysISO(iso, 7);
  if (c === 'quarterly') return dates.addMonthsISO(iso, 3);
  if (c === 'yearly') return dates.addMonthsISO(iso, 12);
  return dates.addMonthsISO(iso, 1);
}

const Subscription = {
  CYCLES,
  addCycle,

  // Первая дата списания для новой подписки: ближайшая дата серии
  // start_date + k*cycle, которая >= today (start_date в будущем — сама start_date).
  firstBillingDate(startDate, cycle, today = null) {
    const todayStr = today || dates.todayISO();
    const start = dates.parseISO(startDate) ? startDate : todayStr;
    return dates.rollForward(String(start).slice(0, 10), cycleOf(cycle), todayStr);
  },

  // После оплаты: следующая дата = дата оплаты + цикл, но не раньше сегодня.
  nextAfterPayment(paymentDate, cycle, today = null) {
    const todayStr = today || dates.todayISO();
    const base = dates.parseISO(paymentDate) ? String(paymentDate).slice(0, 10) : todayStr;
    const next = addCycle(base, cycle);
    return dates.rollForward(next, cycleOf(cycle), todayStr);
  },

  // Поля для карточки: daysUntilBilling (целые дни, 0 = сегодня), isDueToday, isOverdue.
  billingInfo(sub, today = null) {
    const todayStr = today || dates.todayISO();
    const next = sub && sub.next_billing_date ? String(sub.next_billing_date).slice(0, 10) : null;
    const days = next ? dates.diffDays(todayStr, next) : null;
    return {
      daysUntilBilling: days,
      isDueToday: days === 0,
      isOverdue: days !== null && days < 0,
    };
  },

  // Докатить просроченные автопродляемые подписки пользователя до даты >= today.
  // Ручные (auto_renew = 0) не трогаем — там «просрочено» несёт факт.
  // Возвращает число обновлённых строк.
  async rollForwardStale(userId, today = null) {
    const todayStr = today || dates.todayISO();
    const stale = await query(
      `SELECT id, start_date, next_billing_date, billing_cycle FROM subscriptions
       WHERE user_id = ? AND is_active = 1 AND auto_renew = 1
         AND next_billing_date IS NOT NULL AND next_billing_date < ?`,
      [userId, todayStr]
    );
    let updated = 0;
    for (const s of stale) {
      const from = String(s.next_billing_date || s.start_date).slice(0, 10);
      const next = dates.rollForward(from, cycleOf(s.billing_cycle), todayStr);
      if (next && next !== s.next_billing_date) {
        await run(
          `UPDATE subscriptions SET next_billing_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [next, s.id]
        );
        updated += 1;
      }
    }
    return updated;
  },
};

module.exports = Subscription;
