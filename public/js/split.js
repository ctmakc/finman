// ==================== SPLIT ====================
// Shared-expense groups. Each group has its own currency; the overview totals
// come from the API (summed across groups), so they are formatted honestly:
// with a currency only when every group uses the same one.
// Requires: lib/ui.js (window.UI), app.js (fetchWithAuth, showNotification).

async function renderSplitPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const [groupsRaw, stats] = await Promise.all([
      fetchWithAuth('/api/split/groups').then((r) => r.json()),
      fetchWithAuth('/api/split/stats').then((r) => r.json()).catch(() => ({})),
    ]);
    const groups = Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw && groupsRaw.data) || [];
    const currencies = UI.uniqueCurrencies(groups.map((g) => g.currency));
    const fmt = (v) => UI.esc(UI.aggregateMoney(v || 0, currencies));
    mainContent.innerHTML = `
      <div class="split-page">
        <div class="page-header">
          <h1><i class="fas fa-users"></i> ${t('split.title')}</h1>
          <button type="button" class="btn btn-primary" data-action="split:add-group"><i class="fas fa-plus"></i> ${t('split.newGroup')}</button>
        </div>
        ${UI.mixedCurrencyNote(currencies, t('split.groups'))}
        <div class="stats-grid">
          <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${fmt(stats.totalOwed)}</div><div class="stat-label">${t('common.oweMe')}</div></div></div>
          <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${fmt(stats.totalOwes)}</div><div class="stat-label">${t('common.iOwe')}</div></div></div>
          <div class="stat-card"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${fmt(stats.netBalance)}</div><div class="stat-label">${t('common.balance')}</div></div></div>
        </div>
        <div class="card-grid" id="groups-list">
          ${groups.length === 0
            ? UI.emptyState({ icon: 'fa-users', title: t('split.empty.title'), text: t('split.empty.body'), action: { label: t('split.newGroup'), action: 'split:add-group', icon: 'fa-plus' } })
            : groups.map((g) => renderGroupCard(g)).join('')}
        </div>
      </div>`;
  } catch (e) {
    console.error('split:', e);
    mainContent.innerHTML = `<div class="alert alert-error">${t('msg.loadError')}</div>`;
  }
}

function renderGroupCard(g) {
  return `
    <div class="card" data-action="split:open" data-id="${g.id}" role="button" tabindex="0">
      <div class="card-header"><h3 class="card-title"><i class="fas fa-users"></i> ${UI.esc(g.name)}</h3></div>
      <p class="text-secondary">${UI.esc(g.description || '')}</p>
      <p>${t('split.currency', { code: UI.esc(g.currency || UI.baseCurrency()) })}</p>
    </div>`;
}

async function openGroup(id) {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const base = '/api/split/groups/' + Number(id);
    const [stats, balancesRaw, suggested] = await Promise.all([
      fetchWithAuth(base + '/stats').then((r) => r.json()),
      fetchWithAuth(base + '/balances').then((r) => r.json()),
      fetchWithAuth(base + '/settlements/suggested').then((r) => r.json()),
    ]);
    const balances = Array.isArray(balancesRaw) ? balancesRaw : Object.values(balancesRaw || {});
    const cur = (stats.group && stats.group.currency) || UI.baseCurrency();
    const money = (v) => UI.esc(UI.money(v || 0, cur));
    const settlements = Array.isArray(suggested) ? suggested : [];
    mainContent.innerHTML = `
      <div class="split-page">
        <div class="page-header">
          <button type="button" class="btn btn-outline" data-action="split:back"><i class="fas fa-arrow-left"></i> ${t('btn.back')}</button>
          <h1>${UI.esc(stats.group.name)}</h1>
          <button type="button" class="btn btn-primary" data-action="split:add-expense" data-id="${Number(id)}"><i class="fas fa-plus"></i> ${t('split.addExpense')}</button>
        </div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${Number(stats.memberCount) || 0}</div><div class="stat-label">${t('split.members')}</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(stats.totalSpent)}</div><div class="stat-label">${t('split.totalSpent')}</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(stats.averagePerPerson)}</div><div class="stat-label">${t('split.perPerson')}</div></div></div>
        </div>
        <div class="card"><h3>${t('split.balances')}</h3>
          <div class="list-group">
            ${balances.map((b) => `<div class="list-item"><span>${UI.esc(b.member && b.member.name)}</span><span class="${b.balance >= 0 ? 'text-success' : 'text-error'}">${b.balance >= 0 ? '+' : ''}${money(b.balance)}</span></div>`).join('') || `<p class="text-secondary">${t('split.noExpenses')}</p>`}
          </div>
        </div>
        ${settlements.length > 0 ? `
        <div class="card"><h3>${t('split.suggested')}</h3>
          <div class="list-group">
            ${settlements.map((s) => `<div class="list-item"><span>${UI.esc(s.from && s.from.name)} → ${UI.esc(s.to && s.to.name)}</span><span class="text-warning">${money(s.amount)}</span></div>`).join('')}
          </div>
        </div>` : ''}
      </div>`;
  } catch (e) {
    console.error('split group:', e);
    mainContent.innerHTML = `<div class="alert alert-error">${t('msg.error')}</div>`;
  }
}

function showAddGroupModal() {
  UI.modal({
    id: 'group-modal',
    title: t('split.newGroup'),
    body: `
      <form id="group-form" data-submit="split:save-group">
        <div class="form-group"><label class="form-label" for="group-name">${t('common.name')}</label><input type="text" id="group-name" name="name" class="form-control" required></div>
        <div class="form-group"><label class="form-label" for="group-description">${t('common.description')}</label><input type="text" id="group-description" name="description" class="form-control"></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="group-creator">${t('split.yourName')}</label><input type="text" id="group-creator" name="creator_name" class="form-control" value="${t('split.me')}"></div>
          <div class="form-group"><label class="form-label" for="group-currency">${t('common.currency')}</label><select id="group-currency" name="currency" class="form-control">${UI.currencyOptions()}</select></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">${t('btn.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('btn.create')}</button>
        </div>
      </form>`
  });
}

async function saveGroup(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/split/groups', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error(t('msg.error'));
    UI.closeModal('group-modal');
    showNotification(t('split.groupCreated'), 'success');
    renderSplitPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

async function showAddExpenseModal(groupId) {
  const members = await fetchWithAuth('/api/split/groups/' + Number(groupId) + '/members').then((r) => r.json());
  const list = Array.isArray(members) ? members : [];
  UI.modal({
    id: 'expense-modal',
    title: t('split.newExpense'),
    body: `
      <form id="expense-form" data-submit="split:save-expense">
        <input type="hidden" name="group_id" value="${Number(groupId)}">
        <div class="form-group"><label class="form-label" for="expense-description">${t('common.description')}</label><input type="text" id="expense-description" name="description" class="form-control" required></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="expense-amount">${t('common.amount')}</label><input type="number" id="expense-amount" name="amount" class="form-control" required min="0.01" step="0.01"></div>
          <div class="form-group"><label class="form-label" for="expense-paid-by">${t('split.paidBy')}</label>
            <select id="expense-paid-by" name="paid_by" class="form-control">${list.map((m) => `<option value="${Number(m.id)}">${UI.esc(m.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-group"><label class="form-label" for="expense-date">${t('common.date')}</label><input type="date" id="expense-date" name="date" class="form-control" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">${t('btn.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('btn.add')}</button>
        </div>
      </form>`
  });
}

async function saveExpense(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/split/groups/' + Number(d.group_id) + '/expenses', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error(t('msg.error'));
    UI.closeModal('expense-modal');
    showNotification(t('split.expenseAdded'), 'success');
    openGroup(parseInt(d.group_id, 10));
  } catch (e) { showNotification(e.message, 'error'); }
}

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'split:add-group': () => showAddGroupModal(),
    'split:save-group': (form) => saveGroup(form),
    'split:open': (el) => openGroup(el.dataset.id),
    'split:back': () => renderSplitPage(),
    'split:add-expense': (el) => showAddExpenseModal(el.dataset.id),
    'split:save-expense': (form) => saveExpense(form),
  });
  window.showAddGroupModal = showAddGroupModal; window.saveGroup = saveGroup; window.openGroup = openGroup; window.showAddExpenseModal = showAddExpenseModal; window.saveExpense = saveExpense;
})();
