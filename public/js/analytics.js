// ==================== ANALYTICS ====================
async function renderAnalyticsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const [overview, byCategory, compare, topExpenses, trends] = await Promise.all([
      fetchWithAuth('/api/analytics/overview').then(r => r.json()),
      fetchWithAuth('/api/analytics/expenses-by-category').then(r => r.json()),
      fetchWithAuth('/api/analytics/compare').then(r => r.json()),
      fetchWithAuth('/api/analytics/top-expenses').then(r => r.json()).catch(() => []),
      fetchWithAuth('/api/analytics/trends?period=monthly&months=6').then(r => r.json()).catch(() => ({ data: [] })),
    ]);

    const savingsGoals = overview.savingsGoals || { progress: 0, saved: 0, target: 0, count: 0 };
    const debts = overview.debts || { iOwe: 0, oweMe: 0, net: 0 };

    mainContent.innerHTML = `
      <div class="analytics-page">
        <div class="page-header"><h1 class="page-title"><i class="fas fa-chart-bar"></i> Analytics</h1></div>

        <div class="dashboard-summary">
          <div class="summary-card income">
            <div class="summary-icon"><i class="fas fa-arrow-down"></i></div>
            <div class="summary-data"><h3>Income</h3><div class="summary-amount">${formatCurrency(overview.income)}</div></div>
          </div>
          <div class="summary-card expense">
            <div class="summary-icon"><i class="fas fa-arrow-up"></i></div>
            <div class="summary-data"><h3>Expenses</h3><div class="summary-amount">${formatCurrency(overview.expense)}</div></div>
          </div>
          <div class="summary-card ${overview.netIncome >= 0 ? 'balance' : 'expense'}">
            <div class="summary-icon"><i class="fas fa-balance-scale"></i></div>
            <div class="summary-data"><h3>Net</h3><div class="summary-amount">${formatCurrency(overview.netIncome)}</div></div>
          </div>
          <div class="summary-card balance">
            <div class="summary-icon"><i class="fas fa-wallet"></i></div>
            <div class="summary-data"><h3>Balance</h3><div class="summary-amount">${formatCurrency(overview.totalBalance)}</div></div>
          </div>
        </div>

        <div class="db-grid">
          <div class="db-col">
            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-chart-line" style="color:var(--accent)"></i> 6-month trend</h2></div>
              <div style="position:relative;height:220px"><canvas id="analytics-trend-chart"></canvas></div>
            </div>

            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-chart-bar" style="color:var(--accent)"></i> Expenses by category</h2></div>
              <div style="position:relative;height:220px"><canvas id="analytics-cat-chart"></canvas></div>
            </div>

            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-list"></i> Category breakdown</h2></div>
              <div class="list-group">
                ${byCategory.length ? byCategory.map(c => `
                  <div class="list-item">
                    <div class="list-item-content">
                      <div class="list-item-title">${c.category || 'Uncategorized'}</div>
                      <div class="list-item-subtitle">${c.count} transactions</div>
                    </div>
                    <div class="list-item-actions"><strong>${formatCurrency(c.total)}</strong></div>
                  </div>`).join('') : '<p class="text-secondary" style="padding:12px">No expense data yet</p>'}
              </div>
            </div>
          </div>

          <div class="db-col">
            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-exchange-alt"></i> Month-over-month</h2></div>
              <table class="table" style="margin:0">
                <thead><tr><th>Metric</th><th>This month</th><th>Last month</th><th>Change</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Income</td>
                    <td>${formatCurrency(compare.thisMonth?.income || 0)}</td>
                    <td>${formatCurrency(compare.lastMonth?.income || 0)}</td>
                    <td class="${(compare.changes?.income || 0) >= 0 ? 'text-success' : 'text-error'}">${(compare.changes?.income || 0) >= 0 ? '+' : ''}${compare.changes?.income || 0}%</td>
                  </tr>
                  <tr>
                    <td>Expenses</td>
                    <td>${formatCurrency(compare.thisMonth?.expense || 0)}</td>
                    <td>${formatCurrency(compare.lastMonth?.expense || 0)}</td>
                    <td class="${(compare.changes?.expense || 0) <= 0 ? 'text-success' : 'text-error'}">${(compare.changes?.expense || 0) >= 0 ? '+' : ''}${compare.changes?.expense || 0}%</td>
                  </tr>
                </tbody>
              </table>
            </div>

            ${savingsGoals.count > 0 ? `
            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-piggy-bank"></i> Savings goals</h2></div>
              <div class="db-progress-bar" style="margin:8px 0">
                <div class="db-progress-fill" style="width:${Math.min(savingsGoals.progress, 100)}%;background:var(--accent)"></div>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:13px">
                <span>Saved: ${formatCurrency(savingsGoals.saved)}</span>
                <span>Target: ${formatCurrency(savingsGoals.target)} (${savingsGoals.progress}%)</span>
              </div>
            </div>` : ''}

            ${(debts.iOwe > 0 || debts.oweMe > 0) ? `
            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-hand-holding-usd"></i> Debts</h2></div>
              <div style="display:flex;gap:12px;flex-wrap:wrap">
                <div class="db-goal-stat" style="flex:1">
                  <span class="db-goal-val" style="color:var(--danger)">${formatCurrency(debts.iOwe)}</span>
                  <span class="db-goal-lbl">I Owe</span>
                </div>
                <div class="db-goal-stat" style="flex:1">
                  <span class="db-goal-val" style="color:var(--success)">${formatCurrency(debts.oweMe)}</span>
                  <span class="db-goal-lbl">Owed to me</span>
                </div>
                <div class="db-goal-stat" style="flex:1">
                  <span class="db-goal-val">${formatCurrency(debts.net)}</span>
                  <span class="db-goal-lbl">Net</span>
                </div>
              </div>
            </div>` : ''}

            ${topExpenses.length ? `
            <div class="card db-widget">
              <div class="section-header"><h2><i class="fas fa-receipt"></i> Top expenses</h2></div>
              <div class="list-group">
                ${topExpenses.slice(0, 5).map(t => `
                  <div class="list-item">
                    <div class="list-item-content">
                      <div class="list-item-title">${t.description || 'Unknown'}</div>
                      <div class="list-item-subtitle">${t.category || 'Uncategorized'} · ${t.date || ''}</div>
                    </div>
                    <div class="list-item-actions"><strong style="color:var(--danger)">${formatCurrency(Math.abs(t.amount))}</strong></div>
                  </div>`).join('')}
              </div>
            </div>` : ''}
          </div>
        </div>
      </div>`;

    renderAnalyticsChart('analytics-cat-chart', byCategory);
    renderAnalyticsTrendChart('analytics-trend-chart', trends.data || []);
  } catch (e) {
    mainContent.innerHTML = '<div class="alert alert-error">Failed to load analytics</div>';
    console.error(e);
  }
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
