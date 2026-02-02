// ==================== ANALYTICS ====================
async function renderAnalyticsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const overview = await fetchWithAuth('/api/analytics/overview').then(r => r.json());
    const byCategory = await fetchWithAuth('/api/analytics/expenses-by-category').then(r => r.json());
    const compare = await fetchWithAuth('/api/analytics/compare').then(r => r.json());
    mainContent.innerHTML = `<div class="analytics-page"><div class="page-header"><h1><i class="fas fa-chart-bar"></i> Аналитика</h1></div>
      <div class="stats-grid">
        <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.income)}</div><div class="stat-label">Доходы</div></div></div>
        <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.expense)}</div><div class="stat-label">Расходы</div></div></div>
        <div class="stat-card ${overview.netIncome >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.netIncome)}</div><div class="stat-label">Баланс периода</div></div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.totalBalance)}</div><div class="stat-label">Общий баланс</div></div></div>
      </div>
      <div class="card-grid">
        <div class="card"><h3><i class="fas fa-list"></i> Расходы по категориям</h3><div class="list-group">${byCategory.map(c => `<div class="list-item"><div class="list-item-content"><div class="list-item-title">${c.category || 'Без категории'}</div><div class="list-item-subtitle">${c.count} транзакций</div></div><div class="list-item-actions"><strong>${formatCurrency(c.total)}</strong></div></div>`).join('') || '<p class="text-secondary">Нет данных</p>'}</div></div>
        <div class="card"><h3><i class="fas fa-exchange-alt"></i> Сравнение с прошлым месяцем</h3>
          <div class="compare-stats">
            <div class="compare-item"><span>Доходы:</span><span class="${compare.changes.income >= 0 ? 'text-success' : 'text-error'}">${compare.changes.income >= 0 ? '+' : ''}${compare.changes.income}%</span></div>
            <div class="compare-item"><span>Расходы:</span><span class="${compare.changes.expense <= 0 ? 'text-success' : 'text-error'}">${compare.changes.expense >= 0 ? '+' : ''}${compare.changes.expense}%</span></div>
          </div>
          <div class="compare-details">
            <p>Этот месяц: доходы ${formatCurrency(compare.thisMonth.income)}, расходы ${formatCurrency(compare.thisMonth.expense)}</p>
            <p>Прошлый месяц: доходы ${formatCurrency(compare.lastMonth.income)}, расходы ${formatCurrency(compare.lastMonth.expense)}</p>
          </div>
        </div>
      </div>
      <div class="card"><h3><i class="fas fa-piggy-bank"></i> Цели накопления</h3>
        <div class="budget-progress"><div class="progress-bar"><div class="progress-fill progress-ok" style="width: ${overview.savingsGoals.progress}%"></div></div>
        <div class="progress-labels"><span>Накоплено: ${formatCurrency(overview.savingsGoals.saved)}</span><span>Цель: ${formatCurrency(overview.savingsGoals.target)} (${overview.savingsGoals.progress}%)</span></div></div>
        <p>${overview.savingsGoals.count} активных целей</p>
      </div>
      <div class="card"><h3><i class="fas fa-hand-holding-usd"></i> Долги</h3>
        <div class="stats-grid">
          <div class="stat-card stat-over"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.iOwe)}</div><div class="stat-label">Я должен</div></div></div>
          <div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.oweMe)}</div><div class="stat-label">Мне должны</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.net)}</div><div class="stat-label">Нетто</div></div></div>
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
