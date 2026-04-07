// ==================== ANALYTICS ====================
async function renderAnalyticsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const overview = await fetchWithAuth('/api/analytics/overview').then(r => r.json());
    const byCategory = await fetchWithAuth('/api/analytics/expenses-by-category').then(r => r.json());
    const compare = await fetchWithAuth('/api/analytics/compare').then(r => r.json());
    mainContent.innerHTML = `<div class="analytics-page"><div class="page-header"><h1><i class="fas fa-chart-bar"></i> Analytics</h1></div>
      <div class="stats-grid">
        <div class="stat-card stat-ok"><div class="stat-icon"><i class="fas fa-arrow-down"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.income)}</div><div class="stat-label">Income</div></div></div>
        <div class="stat-card stat-over"><div class="stat-icon"><i class="fas fa-arrow-up"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.expense)}</div><div class="stat-label">Expenses</div></div></div>
        <div class="stat-card ${overview.netIncome >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-balance-scale"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.netIncome)}</div><div class="stat-label">Period Balance</div></div></div>
        <div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(overview.totalBalance)}</div><div class="stat-label">Total Balance</div></div></div>
      </div>
      <div class="card-grid">
        <div class="card"><h3><i class="fas fa-list"></i> Expenses by Category</h3><div class="list-group">${byCategory.map(c => `<div class="list-item"><div class="list-item-content"><div class="list-item-title">${c.category || 'Uncategorized'}</div><div class="list-item-subtitle">${c.count} transactions</div></div><div class="list-item-actions"><strong>${formatCurrency(c.total)}</strong></div></div>`).join('') || '<p class="text-secondary">No data</p>'}</div></div>
        <div class="card"><h3><i class="fas fa-exchange-alt"></i> Comparison with Last Month</h3>
          <div class="compare-stats">
            <div class="compare-item"><span>Income:</span><span class="${compare.changes.income >= 0 ? 'text-success' : 'text-error'}">${compare.changes.income >= 0 ? '+' : ''}${compare.changes.income}%</span></div>
            <div class="compare-item"><span>Expenses:</span><span class="${compare.changes.expense <= 0 ? 'text-success' : 'text-error'}">${compare.changes.expense >= 0 ? '+' : ''}${compare.changes.expense}%</span></div>
          </div>
          <div class="compare-details">
            <p>This month: income ${formatCurrency(compare.thisMonth.income)}, expenses ${formatCurrency(compare.thisMonth.expense)}</p>
            <p>Last month: income ${formatCurrency(compare.lastMonth.income)}, expenses ${formatCurrency(compare.lastMonth.expense)}</p>
          </div>
        </div>
      </div>
      <div class="card"><h3><i class="fas fa-piggy-bank"></i> Savings Goals</h3>
        <div class="budget-progress"><div class="progress-bar"><div class="progress-fill progress-ok" style="width: ${overview.savingsGoals.progress}%"></div></div>
        <div class="progress-labels"><span>Saved: ${formatCurrency(overview.savingsGoals.saved)}</span><span>Goal: ${formatCurrency(overview.savingsGoals.target)} (${overview.savingsGoals.progress}%)</span></div></div>
        <p>${overview.savingsGoals.count} active goals</p>
      </div>
      <div class="card"><h3><i class="fas fa-hand-holding-usd"></i> Debts</h3>
        <div class="stats-grid">
          <div class="stat-card stat-over"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.iOwe)}</div><div class="stat-label">I Owe</div></div></div>
          <div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.oweMe)}</div><div class="stat-label">Owed to Me</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(overview.debts.net)}</div><div class="stat-label">Net</div></div></div>
        </div>
      </div>
    </div>`;
  } catch (e) { mainContent.innerHTML = '<div class="alert alert-error">Failed to load analytics</div>'; console.error(e); }
}

async function renderExportPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = `<div class="export-page"><div class="page-header"><h1><i class="fas fa-download"></i> Export Data</h1></div>
    <div class="card-grid">
      <div class="card"><h3><i class="fas fa-file-csv"></i> Export Transactions</h3><p>Download all transactions in CSV format</p><a href="/api/export/transactions/csv" class="btn btn-primary" download><i class="fas fa-download"></i> Download CSV</a></div>
      <div class="card"><h3><i class="fas fa-file-csv"></i> Export Accounts</h3><p>Download account list in CSV format</p><a href="/api/export/accounts/csv" class="btn btn-primary" download><i class="fas fa-download"></i> Download CSV</a></div>
      <div class="card"><h3><i class="fas fa-file-code"></i> Full Backup</h3><p>Download all data in JSON format for backup</p><a href="/api/export/full/json" class="btn btn-primary" download><i class="fas fa-download"></i> Download JSON</a></div>
    </div>
  </div>`;
}
