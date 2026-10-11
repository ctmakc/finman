// ==================== GOALS ====================
// Savings goals page. Progress is derived from current_amount / target_amount
// (API fields `remaining` / `percent` win when present); every amount is shown
// in the goal's own currency and totals are grouped per currency.
// Requires: lib/ui.js (window.UI), app.js (fetchWithAuth, showNotification).

// ---- pure helpers (exported for Jest) ----
function goalProgress(g) {
  const target = Number(g && g.target_amount) || 0;
  const current = Number(g && g.current_amount) || 0;
  const remaining = g && g.remaining != null && isFinite(Number(g.remaining))
    ? Math.max(0, Number(g.remaining))
    : Math.max(0, target - current);
  let percent;
  if (g && g.percent != null && isFinite(Number(g.percent))) percent = Number(g.percent);
  else if (g && g.progress != null && isFinite(Number(g.progress))) percent = Number(g.progress);
  else percent = target > 0 ? (current / target) * 100 : 0;
  percent = Math.max(0, Math.min(100, percent));
  const reached = !!(g && g.is_completed) || (target > 0 && remaining <= 0);
  return { target, current, remaining, percent, pct: Math.round(percent), reached };
}

// Counts + per-currency saved/target/percent. Never adds CAD to UAH.
function goalsSummary(goals) {
  const list = Array.isArray(goals) ? goals : [];
  const byCurrency = {};
  let active = 0;
  let completed = 0;
  list.forEach((g) => {
    const p = goalProgress(g);
    if (p.reached) completed++; else active++;
    const cur = String(g.currency || (typeof UI !== 'undefined' ? UI.baseCurrency() : 'UAH')).toUpperCase();
    const row = byCurrency[cur] || (byCurrency[cur] = { saved: 0, target: 0, percent: 0 });
    row.saved = Math.round((row.saved + p.current) * 100) / 100;
    row.target = Math.round((row.target + p.target) * 100) / 100;
  });
  Object.keys(byCurrency).forEach((cur) => {
    const row = byCurrency[cur];
    row.percent = row.target > 0 ? Math.round((row.saved / row.target) * 100) : 0;
  });
  return { total: list.length, active, completed, byCurrency };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { goalProgress, goalsSummary };
}

// ---- page ----
async function renderGoalsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const goals = await fetchWithAuth('/api/goals').then((r) => r.json());
    const list = Array.isArray(goals) ? goals : (goals && goals.data) || [];
    const summary = goalsSummary(list);
    mainContent.innerHTML = `
      <div class="goals-page">
        <div class="page-header">
          <h1><i class="fas fa-piggy-bank"></i> ${t('goals.title')}</h1>
          <button type="button" class="btn btn-primary" data-action="goals:add"><i class="fas fa-plus"></i> ${t('goals.new')}</button>
        </div>
        <div class="stats-grid">${renderGoalStats(summary)}</div>
        <div class="card-grid" id="goals-list">
          ${list.length === 0
            ? UI.emptyState({ icon: 'fa-piggy-bank', title: t('goals.empty.title'), text: t('goals.empty.body'), action: { label: t('goals.new'), action: 'goals:add', icon: 'fa-plus' } })
            : list.map((g) => renderGoalCard(g)).join('')}
        </div>
      </div>`;
  } catch (e) {
    console.error('goals:', e);
    mainContent.innerHTML = `<div class="alert alert-error">${t('msg.loadError')}</div>`;
  }
}

function renderGoalStats(summary) {
  const saved = {};
  Object.keys(summary.byCurrency).forEach((c) => { saved[c] = summary.byCurrency[c].saved; });
  const codes = Object.keys(summary.byCurrency);
  const progress = codes.length === 0
    ? '0%'
    : codes.length === 1
      ? `${summary.byCurrency[codes[0]].percent}%`
      : codes.map((c) => `<span class="fm-money">${UI.esc(c)} ${summary.byCurrency[c].percent}%</span>`).join('');
  return `
    <div class="stat-card"><div class="stat-icon"><i class="fas fa-bullseye"></i></div><div class="stat-data"><div class="stat-value">${summary.active}</div><div class="stat-label">${t('goals.active')}</div></div></div>
    <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-coins"></i></div><div class="stat-data"><div class="stat-value">${UI.moneyList(saved)}</div><div class="stat-label">${t('goals.saved')}</div></div></div>
    <div class="stat-card"><div class="stat-icon"><i class="fas fa-chart-pie"></i></div><div class="stat-data"><div class="stat-value">${codes.length > 1 ? `<span class="fm-money-list">${progress}</span>` : progress}</div><div class="stat-label">${t('common.progress')}</div></div></div>`;
}

function renderGoalCard(g) {
  const p = goalProgress(g);
  const cur = g.currency;
  const meta = g.target_date ? `<div class="goal-meta"><span class="goal-meta-item"><i class="fas fa-calendar"></i> ${UI.esc(g.target_date)}</span></div>` : '';
  const status = p.reached
    ? `<p class="goal-remaining text-success"><i class="fas fa-check-circle"></i> ${t('goals.reached')}</p>`
    : `<p class="goal-remaining">${t('common.remaining')}: <strong>${UI.esc(UI.money(p.remaining, cur))}</strong></p>`;
  return `
    <div class="card${p.reached ? ' goal-reached' : ''}" data-id="${g.id}">
      <div class="card-header">
        <h3 class="card-title"><i class="fas fa-piggy-bank"></i> ${UI.esc(g.name)}</h3>
        <div class="card-actions">
          <button type="button" class="btn btn-sm btn-outline" data-action="goals:contribute" data-id="${g.id}" aria-label="${t('goals.contributeAria')}" title="${t('goals.contribute')}"><i class="fas fa-plus"></i></button>
          <button type="button" class="btn btn-sm btn-danger" data-action="goals:delete" data-id="${g.id}" aria-label="${t('goals.deleteAria')}" title="${t('btn.delete')}"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="budget-progress">
        <div class="progress-bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${t('goals.progressAria', { pct: p.pct })}">
          <div class="progress-fill progress-ok" style="width: ${p.percent}%"></div>
        </div>
        <div class="progress-labels">
          <span>${UI.esc(UI.money(p.current, cur))} / ${UI.esc(UI.money(p.target, cur))}</span>
          <span>${p.pct}%</span>
        </div>
      </div>
      ${meta}
      ${status}
    </div>`;
}

function showAddGoalModal() {
  UI.modal({
    id: 'goal-modal',
    title: t('goals.new'),
    body: `
      <form id="goal-form" data-submit="goals:save">
        <div class="form-group"><label class="form-label" for="goal-name">${t('common.name')}</label><input type="text" id="goal-name" name="name" class="form-control" required></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="goal-target">${t('common.amount')}</label><input type="number" id="goal-target" name="target_amount" class="form-control" required min="1" step="0.01"></div>
          <div class="form-group"><label class="form-label" for="goal-currency">${t('common.currency')}</label><select id="goal-currency" name="currency" class="form-control">${UI.currencyOptions()}</select></div>
        </div>
        <div class="form-group"><label class="form-label" for="goal-date">${t('common.date')}</label><input type="date" id="goal-date" name="target_date" class="form-control"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">${t('btn.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('btn.create')}</button>
        </div>
      </form>`
  });
}

async function saveGoal(form) {
  const d = Object.fromEntries(new FormData(form));
  if (!d.target_date) delete d.target_date;
  try {
    const r = await fetchWithAuth('/api/goals', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error(t('msg.error'));
    UI.closeModal('goal-modal');
    showNotification(t('goals.created'), 'success');
    renderGoalsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

function showContributeModal(id) {
  UI.modal({
    id: 'contribute-modal',
    title: t('goals.contribute'),
    body: `
      <form id="contribute-form" data-submit="goals:contribute-save">
        <input type="hidden" name="goalId" value="${Number(id)}">
        <div class="form-group"><label class="form-label" for="contribute-amount">${t('common.amount')}</label><input type="number" id="contribute-amount" name="amount" class="form-control" required min="0.01" step="0.01"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">${t('btn.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('goals.contribute')}</button>
        </div>
      </form>`
  });
}

async function contributeToGoal(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/goals/' + Number(d.goalId) + '/contribute', { method: 'POST', body: JSON.stringify({ amount: parseFloat(d.amount) }) });
    if (!r.ok) throw new Error(t('msg.error'));
    UI.closeModal('contribute-modal');
    showNotification(t('goals.contributed'), 'success');
    renderGoalsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

async function deleteGoal(id) {
  if (!confirm(t('goals.confirmDelete'))) return;
  try {
    await fetchWithAuth('/api/goals/' + Number(id), { method: 'DELETE' });
    showNotification(t('msg.deleted'), 'success');
    renderGoalsPage();
  } catch (e) { showNotification(t('msg.error'), 'error'); }
}

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'goals:add': () => showAddGoalModal(),
    'goals:save': (form) => saveGoal(form),
    'goals:contribute': (el) => showContributeModal(el.dataset.id),
    'goals:contribute-save': (form) => contributeToGoal(form),
    'goals:delete': (el) => deleteGoal(el.dataset.id),
  });
  window.showAddGoalModal = showAddGoalModal; window.showContributeModal = showContributeModal; window.saveGoal = saveGoal; window.contributeToGoal = contributeToGoal; window.deleteGoal = deleteGoal;
  window.goalProgress = goalProgress; window.goalsSummary = goalsSummary;
})();
