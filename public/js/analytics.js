// ==================== ANALYTICS ====================
// /api/analytics/* converts every account's amounts into the user's base
// currency (server lib/fx) and returns it as `currency`, plus `missingRates`
// for currencies without an exchange rate (counted 1:1).
async function renderAnalyticsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const [overview, byCategoryRaw, compare] = await Promise.all([
      fetchWithAuth('/api/analytics/overview').then(r => r.json()),
      fetchWithAuth('/api/analytics/expenses-by-category').then(r => r.json()),
      fetchWithAuth('/api/analytics/compare').then(r => r.json()),
    ]);
    const byCategory = Array.isArray(byCategoryRaw) ? byCategoryRaw : [];
    const cur = overview.currency || overview.baseCurrency || (compare && compare.currency);
    const money = (v) => UI.esc(UI.convertedMoney(v || 0, cur));
    const missing = [].concat(overview.missingRates || [], (compare && compare.missingRates) || []);
    const esc = UI.esc;
    const goals = overview.savingsGoals || {};
    const debts = overview.debts || {};
    const changes = (compare && compare.changes) || {};
    const thisMonth = (compare && compare.thisMonth) || {};
    const lastMonth = (compare && compare.lastMonth) || {};

    mainContent.innerHTML = `<div class="analytics-page">
      <div class="page-header"><h1><i class="fas fa-chart-bar"></i> ${t('analytics.title')}</h1></div>
      ${UI.missingRatesNote(missing)}
      <div class="stats-grid">
        <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${money(overview.income)}</div><div class="stat-label">${t('common.income')}</div></div></div>
        <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${money(overview.expense)}</div><div class="stat-label">${t('common.expense')}</div></div></div>
        <div class="stat-card ${overview.netIncome >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${money(overview.netIncome)}</div><div class="stat-label">${t('analytics.netPeriod')}</div></div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${money(overview.totalBalance)}</div><div class="stat-label">${t('analytics.totalBalance')}</div></div></div>
      </div>
      <div class="card-grid">
        <div class="card"><h3><i class="fas fa-list"></i> ${t('analytics.byCategory')}</h3>
          <div class="list-group">${byCategory.map(c => `<div class="list-item"><div class="list-item-content"><div class="list-item-title">${esc(c.category || t('common.noCategory'))}</div><div class="list-item-subtitle">${t('analytics.txCount', { n: esc(c.count) })}</div></div><div class="list-item-actions"><strong>${money(c.total)}</strong></div></div>`).join('') || `<p class="text-secondary">${t('common.empty')}</p>`}</div>
        </div>
        <div class="card"><h3><i class="fas fa-exchange-alt"></i> ${t('analytics.compare')}</h3>
          <div class="compare-stats">
            <div class="compare-item"><span>${t('common.income')}:</span><span class="${(changes.income || 0) >= 0 ? 'text-success' : 'text-error'}">${(changes.income || 0) >= 0 ? '+' : ''}${esc(changes.income || 0)}%</span></div>
            <div class="compare-item"><span>${t('common.expense')}:</span><span class="${(changes.expense || 0) <= 0 ? 'text-success' : 'text-error'}">${(changes.expense || 0) >= 0 ? '+' : ''}${esc(changes.expense || 0)}%</span></div>
          </div>
          <div class="compare-details">
            <p>${t('analytics.thisMonth', { income: money(thisMonth.income), expense: money(thisMonth.expense) })}</p>
            <p>${t('analytics.lastMonth', { income: money(lastMonth.income), expense: money(lastMonth.expense) })}</p>
          </div>
        </div>
      </div>
      <div class="card"><h3><i class="fas fa-piggy-bank"></i> ${t('analytics.goals')}</h3>
        <div class="budget-progress"><div class="progress-bar" role="progressbar" aria-valuenow="${Number(goals.progress) || 0}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill progress-ok" style="width: ${Math.min(100, Number(goals.progress) || 0)}%"></div></div>
        <div class="progress-labels"><span>${t('analytics.saved', { amount: money(goals.saved) })}</span><span>${t('analytics.target', { amount: money(goals.target), pct: esc(goals.progress || 0) })}</span></div></div>
        <p>${t('analytics.activeGoals', { n: esc(goals.count || 0) })}</p>
      </div>
      <div class="card"><h3><i class="fas fa-hand-holding-usd"></i> ${t('analytics.debts')}</h3>
        <div class="stats-grid">
          <div class="stat-card stat-over"><div class="stat-data"><div class="stat-value">${money(debts.iOwe)}</div><div class="stat-label">${t('common.iOwe')}</div></div></div>
          <div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">${money(debts.oweMe)}</div><div class="stat-label">${t('common.oweMe')}</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(debts.net)}</div><div class="stat-label">${t('analytics.net')}</div></div></div>
        </div>
      </div>
    </div>`;
  } catch (e) { mainContent.innerHTML = `<div class="alert alert-error">${t('analytics.loadError')}</div>`; console.error(e); }
}

// Legacy export page (the Settings panel in data-export.js is the primary UI).
async function renderExportPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = `<div class="export-page"><div class="page-header"><h1><i class="fas fa-download"></i> ${t('export.title')}</h1></div>
    <div class="card-grid">
      <div class="card"><h3><i class="fas fa-file-csv"></i> ${t('exportPage.transactions')}</h3><p>${t('exportPage.transactionsHint')}</p><a href="/api/export/transactions/csv" class="btn btn-primary" download><i class="fas fa-download"></i> ${t('exportPage.downloadCsv')}</a></div>
      <div class="card"><h3><i class="fas fa-file-csv"></i> ${t('exportPage.accounts')}</h3><p>${t('exportPage.accountsHint')}</p><a href="/api/export/accounts/csv" class="btn btn-primary" download><i class="fas fa-download"></i> ${t('exportPage.downloadCsv')}</a></div>
      <div class="card"><h3><i class="fas fa-file-code"></i> ${t('exportPage.full')}</h3><p>${t('exportPage.fullHint')}</p><a href="/api/export/full/json" class="btn btn-primary" download><i class="fas fa-download"></i> ${t('exportPage.downloadJson')}</a></div>
    </div>
  </div>`;
}
