// ==================== ANALYTICS ====================
// /api/analytics/* sums transactions across ALL accounts without converting
// currencies. The page formats those figures with a currency only when every
// account shares one; otherwise it shows plain numbers and says so.
async function renderAnalyticsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const currencies = await UI.loadAccountCurrencies();
    const [overview, byCategoryRaw, compare] = await Promise.all([
      fetchWithAuth('/api/analytics/overview').then(r => r.json()),
      fetchWithAuth('/api/analytics/expenses-by-category').then(r => r.json()),
      fetchWithAuth('/api/analytics/compare').then(r => r.json()),
    ]);
    const byCategory = Array.isArray(byCategoryRaw) ? byCategoryRaw : [];
    const money = (v) => UI.esc(UI.aggregateMoney(v || 0, currencies));
    const esc = UI.esc;
    const goals = overview.savingsGoals || {};
    const debts = overview.debts || {};
    const changes = (compare && compare.changes) || {};
    const thisMonth = (compare && compare.thisMonth) || {};
    const lastMonth = (compare && compare.lastMonth) || {};

    mainContent.innerHTML = `<div class="analytics-page">
      <div class="page-header"><h1><i class="fas fa-chart-bar"></i> Аналитика</h1></div>
      ${UI.mixedCurrencyNote(currencies)}
      <div class="stats-grid">
        <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${money(overview.income)}</div><div class="stat-label">Доходы</div></div></div>
        <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${money(overview.expense)}</div><div class="stat-label">Расходы</div></div></div>
        <div class="stat-card ${overview.netIncome >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${money(overview.netIncome)}</div><div class="stat-label">Баланс периода</div></div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${money(overview.totalBalance)}</div><div class="stat-label">Общий баланс</div></div></div>
      </div>
      <div class="card-grid">
        <div class="card"><h3><i class="fas fa-list"></i> Расходы по категориям</h3>
          <div class="list-group">${byCategory.map(c => `<div class="list-item"><div class="list-item-content"><div class="list-item-title">${esc(c.category || 'Без категории')}</div><div class="list-item-subtitle">${esc(c.count)} транзакций</div></div><div class="list-item-actions"><strong>${money(c.total)}</strong></div></div>`).join('') || '<p class="text-secondary">Нет данных</p>'}</div>
        </div>
        <div class="card"><h3><i class="fas fa-exchange-alt"></i> Сравнение с прошлым месяцем</h3>
          <div class="compare-stats">
            <div class="compare-item"><span>Доходы:</span><span class="${(changes.income || 0) >= 0 ? 'text-success' : 'text-error'}">${(changes.income || 0) >= 0 ? '+' : ''}${esc(changes.income || 0)}%</span></div>
            <div class="compare-item"><span>Расходы:</span><span class="${(changes.expense || 0) <= 0 ? 'text-success' : 'text-error'}">${(changes.expense || 0) >= 0 ? '+' : ''}${esc(changes.expense || 0)}%</span></div>
          </div>
          <div class="compare-details">
            <p>Этот месяц: доходы ${money(thisMonth.income)}, расходы ${money(thisMonth.expense)}</p>
            <p>Прошлый месяц: доходы ${money(lastMonth.income)}, расходы ${money(lastMonth.expense)}</p>
          </div>
        </div>
      </div>
      <div class="card"><h3><i class="fas fa-piggy-bank"></i> Цели накопления</h3>
        <div class="budget-progress"><div class="progress-bar" role="progressbar" aria-valuenow="${Number(goals.progress) || 0}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill progress-ok" style="width: ${Math.min(100, Number(goals.progress) || 0)}%"></div></div>
        <div class="progress-labels"><span>Накоплено: ${money(goals.saved)}</span><span>Цель: ${money(goals.target)} (${esc(goals.progress || 0)}%)</span></div></div>
        <p>${esc(goals.count || 0)} активных целей</p>
      </div>
      <div class="card"><h3><i class="fas fa-hand-holding-usd"></i> Долги</h3>
        <div class="stats-grid">
          <div class="stat-card stat-over"><div class="stat-data"><div class="stat-value">${money(debts.iOwe)}</div><div class="stat-label">Я должен</div></div></div>
          <div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">${money(debts.oweMe)}</div><div class="stat-label">Мне должны</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(debts.net)}</div><div class="stat-label">Нетто</div></div></div>
        </div>
      </div>
    </div>`;
  } catch (e) { mainContent.innerHTML = '<div class="alert alert-error">Ошибка загрузки аналитики</div>'; console.error(e); }
}

async function renderExportPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = `<div class="export-page"><div class="page-header"><h1><i class="fas fa-download"></i> Экспорт данных</h1></div>
    <div class="card-grid">
      <div class="card"><h3><i class="fas fa-file-csv"></i> Экспорт транзакций</h3><p>Скачать все транзакции в формате CSV</p><a href="/api/export/transactions/csv" class="btn btn-primary" download><i class="fas fa-download"></i> Скачать CSV</a></div>
      <div class="card"><h3><i class="fas fa-file-csv"></i> Экспорт счетов</h3><p>Скачать список счетов в формате CSV</p><a href="/api/export/accounts/csv" class="btn btn-primary" download><i class="fas fa-download"></i> Скачать CSV</a></div>
      <div class="card"><h3><i class="fas fa-file-code"></i> Полный бэкап</h3><p>Скачать все данные в формате JSON для бэкапа</p><a href="/api/export/full/json" class="btn btn-primary" download><i class="fas fa-download"></i> Скачать JSON</a></div>
    </div>
  </div>`;
}
