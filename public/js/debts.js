// ==================== DEBTS ====================
// Debts page. "Paid" is derived from paid_amount / amount (API `remaining`,
// `is_paid`, `isOverdue` win when present); amounts use the debt's own
// currency and totals are grouped per currency.
// Requires: lib/ui.js (window.UI), app.js (fetchWithAuth, showNotification).

const DEBT_I_OWE_TYPES = ['i_owe', 'credit', 'mortgage', 'loan'];

// ---- pure helpers (exported for Jest) ----
function debtProgress(d, today) {
  const amount = Number(d && d.amount) || 0;
  const paid = Number(d && d.paid_amount) || 0;
  const remaining = d && d.remaining != null && isFinite(Number(d.remaining))
    ? Math.max(0, Number(d.remaining))
    : Math.max(0, amount - paid);
  let percent;
  if (d && d.progress != null && isFinite(Number(d.progress))) percent = Number(d.progress);
  else percent = amount > 0 ? (paid / amount) * 100 : 0;
  percent = Math.max(0, Math.min(100, percent));
  const isPaid = !!(d && d.is_paid) || (amount > 0 && remaining <= 0);
  const todayStr = today || new Date().toISOString().split('T')[0];
  const isOverdue = d && d.isOverdue != null
    ? !!d.isOverdue
    : !!(d && d.due_date && !isPaid && String(d.due_date).slice(0, 10) < todayStr);
  const isIOwe = DEBT_I_OWE_TYPES.includes(d && d.type);
  return { amount, paid, remaining, percent, pct: Math.round(percent), isPaid, isOverdue, isIOwe };
}

// Per-currency remaining balances: what I still owe, what is owed to me, net.
function debtsSummary(debts, today) {
  const list = Array.isArray(debts) ? debts : [];
  const byCurrency = {};
  let active = 0;
  let paid = 0;
  let overdue = 0;
  list.forEach((d) => {
    const p = debtProgress(d, today);
    if (p.isPaid) paid++; else active++;
    if (p.isOverdue) overdue++;
    const cur = String(d.currency || (typeof UI !== 'undefined' ? UI.baseCurrency() : 'UAH')).toUpperCase();
    const row = byCurrency[cur] || (byCurrency[cur] = { iOwe: 0, oweMe: 0, net: 0 });
    if (!p.isPaid) {
      if (p.isIOwe) row.iOwe = Math.round((row.iOwe + p.remaining) * 100) / 100;
      else row.oweMe = Math.round((row.oweMe + p.remaining) * 100) / 100;
    }
    row.net = Math.round((row.oweMe - row.iOwe) * 100) / 100;
  });
  return { total: list.length, active, paid, overdue, byCurrency };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { debtProgress, debtsSummary, DEBT_I_OWE_TYPES };
}

// ---- page ----
async function renderDebtsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const debts = await fetchWithAuth('/api/debts').then((r) => r.json());
    const list = Array.isArray(debts) ? debts : (debts && debts.data) || [];
    const summary = debtsSummary(list);
    mainContent.innerHTML = `
      <div class="debts-page">
        <div class="page-header">
          <h1><i class="fas fa-hand-holding-usd"></i> Долги</h1>
          <button type="button" class="btn btn-primary" data-action="debts:add"><i class="fas fa-plus"></i> Добавить</button>
        </div>
        <div class="stats-grid">${renderDebtStats(summary)}</div>
        <div class="card-grid" id="debts-list">
          ${list.length === 0
            ? UI.emptyState({ icon: 'fa-hand-holding-usd', title: 'Нет долгов', text: 'Записывайте кредиты и займы: остаток и срок считаются по платежам.', action: { label: 'Добавить долг', action: 'debts:add', icon: 'fa-plus' } })
            : list.map((d) => renderDebtCard(d)).join('')}
        </div>
      </div>`;
  } catch (e) {
    console.error('debts:', e);
    mainContent.innerHTML = '<div class="alert alert-error">Ошибка загрузки</div>';
  }
}

function renderDebtStats(summary) {
  const iOwe = {};
  const oweMe = {};
  const net = {};
  Object.keys(summary.byCurrency).forEach((c) => {
    iOwe[c] = summary.byCurrency[c].iOwe;
    oweMe[c] = summary.byCurrency[c].oweMe;
    net[c] = summary.byCurrency[c].net;
  });
  return `
    <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${UI.moneyList(iOwe)}</div><div class="stat-label">Я должен</div></div></div>
    <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${UI.moneyList(oweMe)}</div><div class="stat-label">Мне должны</div></div></div>
    <div class="stat-card"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${UI.moneyList(net, { signed: true })}</div><div class="stat-label">Баланс</div></div></div>`;
}

function renderDebtCard(d) {
  const p = debtProgress(d);
  const cur = d.currency;
  const cardClass = ['card', p.isPaid ? 'debt-paid' : '', p.isOverdue ? 'debt-overdue budget-over' : ''].filter(Boolean).join(' ');
  const due = d.due_date
    ? `<p class="debt-due${p.isOverdue ? ' overdue' : ''}"><i class="fas fa-${p.isOverdue ? 'exclamation-circle' : 'calendar'}"></i> Срок: ${UI.esc(d.due_date)}${p.isOverdue ? ' (просрочено!)' : ''}</p>`
    : '';
  const status = p.isPaid
    ? '<p class="debt-remaining text-success"><i class="fas fa-check-circle"></i> Выплачено!</p>'
    : `<p class="debt-remaining">Осталось: <strong>${UI.esc(UI.money(p.remaining, cur))}</strong></p>`;
  return `
    <div class="${cardClass}" data-id="${d.id}">
      <div class="card-header">
        <h3 class="card-title">${p.isIOwe ? '<i class="fas fa-arrow-up text-error"></i>' : '<i class="fas fa-arrow-down text-success"></i>'} ${UI.esc(d.name)}</h3>
        <div class="card-actions">
          ${p.isPaid ? '' : `<button type="button" class="btn btn-sm btn-outline" data-action="debts:pay" data-id="${d.id}" aria-label="Записать платёж" title="Записать платёж"><i class="fas fa-money-bill"></i></button>`}
          <button type="button" class="btn btn-sm btn-danger" data-action="debts:delete" data-id="${d.id}" aria-label="Удалить долг" title="Удалить"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      ${d.counterparty ? `<p class="text-secondary">${UI.esc(d.counterparty)}</p>` : ''}
      <div class="budget-progress">
        <div class="progress-bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Выплачено ${p.pct}%">
          <div class="progress-fill progress-ok" style="width: ${p.percent}%"></div>
        </div>
        <div class="progress-labels">
          <span>Выплачено: ${UI.esc(UI.money(p.paid, cur))}</span>
          <span>из ${UI.esc(UI.money(p.amount, cur))}</span>
        </div>
      </div>
      ${due}
      ${status}
    </div>`;
}

function showAddDebtModal() {
  const today = new Date().toISOString().split('T')[0];
  UI.modal({
    id: 'debt-modal',
    title: 'Новый долг',
    body: `
      <form id="debt-form" data-submit="debts:save">
        <div class="form-group"><label class="form-label" for="debt-name">Название</label><input type="text" id="debt-name" name="name" class="form-control" required></div>
        <div class="form-group"><label class="form-label" for="debt-type">Тип</label>
          <select id="debt-type" name="type" class="form-control">
            <option value="i_owe">Я должен</option>
            <option value="owe_me">Мне должны</option>
            <option value="credit">Кредит</option>
            <option value="loan">Займ</option>
            <option value="mortgage">Ипотека</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="debt-amount">Сумма</label><input type="number" id="debt-amount" name="amount" class="form-control" required min="1" step="0.01"></div>
          <div class="form-group"><label class="form-label" for="debt-currency">Валюта</label><select id="debt-currency" name="currency" class="form-control">${UI.currencyOptions()}</select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="debt-rate">Процент</label><input type="number" id="debt-rate" name="interest_rate" class="form-control" value="0" min="0" step="0.1"></div>
          <div class="form-group"><label class="form-label" for="debt-counterparty">Кому/от кого</label><input type="text" id="debt-counterparty" name="counterparty" class="form-control"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="debt-start">Дата начала</label><input type="date" id="debt-start" name="start_date" class="form-control" required value="${today}"></div>
          <div class="form-group"><label class="form-label" for="debt-due">Срок</label><input type="date" id="debt-due" name="due_date" class="form-control"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Создать</button>
        </div>
      </form>`
  });
}

async function saveDebt(form) {
  const d = Object.fromEntries(new FormData(form));
  if (!d.due_date) delete d.due_date;
  try {
    const r = await fetchWithAuth('/api/debts', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error('Ошибка');
    UI.closeModal('debt-modal');
    showNotification('Долг добавлен', 'success');
    renderDebtsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

function showPaymentModal(id) {
  UI.modal({
    id: 'payment-modal',
    title: 'Платёж',
    body: `
      <form id="payment-form" data-submit="debts:pay-save">
        <input type="hidden" name="debtId" value="${Number(id)}">
        <div class="form-group"><label class="form-label" for="payment-amount">Сумма</label><input type="number" id="payment-amount" name="amount" class="form-control" required min="0.01" step="0.01"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Оплатить</button>
        </div>
      </form>`
  });
}

async function makePayment(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/debts/' + Number(d.debtId) + '/payment', { method: 'POST', body: JSON.stringify({ amount: parseFloat(d.amount) }) });
    if (!r.ok) throw new Error('Ошибка');
    UI.closeModal('payment-modal');
    showNotification('Платёж записан', 'success');
    renderDebtsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

async function deleteDebt(id) {
  if (!confirm('Удалить?')) return;
  try {
    await fetchWithAuth('/api/debts/' + Number(id), { method: 'DELETE' });
    showNotification('Удалено', 'success');
    renderDebtsPage();
  } catch (e) { showNotification('Ошибка', 'error'); }
}

if (typeof window !== 'undefined' && window.UI) {
  UI.actions({
    'debts:add': () => showAddDebtModal(),
    'debts:save': (form) => saveDebt(form),
    'debts:pay': (el) => showPaymentModal(el.dataset.id),
    'debts:pay-save': (form) => makePayment(form),
    'debts:delete': (el) => deleteDebt(el.dataset.id),
  });
  window.showAddDebtModal = showAddDebtModal; window.saveDebt = saveDebt; window.showPaymentModal = showPaymentModal; window.makePayment = makePayment; window.deleteDebt = deleteDebt;
  window.debtProgress = debtProgress; window.debtsSummary = debtsSummary;
}
