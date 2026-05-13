// Dashboard and analytics charts

function initCharts(stats, categoryData) {
  initIncomeExpenseChart(stats.rows || []);
  initExpenseCategoriesChart(categoryData || []);
}

function initIncomeExpenseChart(rows) {
  const ctx = document.getElementById('income-expense-chart');
  if (!ctx) return;

  // Aggregate rows by period
  const byPeriod = {};
  rows.forEach(r => {
    if (!byPeriod[r.period]) byPeriod[r.period] = { income: 0, expense: 0 };
    byPeriod[r.period].income += r.income || 0;
    byPeriod[r.period].expense += r.expense || 0;
  });

  const sortedPeriods = Object.keys(byPeriod).sort();
  const labels = sortedPeriods.map(p => {
    const [y, m] = p.split('-');
    return new Date(y, m - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  });

  if (sortedPeriods.length === 0) {
    ctx.closest('div').innerHTML = '<p style="text-align:center;color:#aaa;padding:20px">No data yet</p>';
    return;
  }

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: sortedPeriods.map(p => byPeriod[p].income),
          backgroundColor: 'rgba(56,193,114,0.7)', borderColor: 'rgba(56,193,114,1)', borderWidth: 1 },
        { label: 'Expenses', data: sortedPeriods.map(p => byPeriod[p].expense),
          backgroundColor: 'rgba(227,52,47,0.7)', borderColor: 'rgba(227,52,47,1)', borderWidth: 1 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: c => c.dataset.label + ': $' + c.parsed.y.toLocaleString() } } }
    }
  });
}

function initExpenseCategoriesChart(categoryRows) {
  const ctx = document.getElementById('expense-categories-chart');
  if (!ctx) return;

  const sorted = [...categoryRows].sort((a, b) => b.total - a.total);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7);

  const labels = top.map(c => c.category || 'Uncategorized');
  const data = top.map(c => c.total);
  if (rest.length) {
    labels.push('Other');
    data.push(rest.reduce((s, c) => s + c.total, 0));
  }

  if (data.length === 0) {
    ctx.closest('div').innerHTML = '<p style="text-align:center;color:#aaa;padding:20px">No expenses yet</p>';
    return;
  }

  const COLORS = [
    'rgba(93,92,222,0.8)', 'rgba(227,52,47,0.8)', 'rgba(246,153,63,0.8)',
    'rgba(56,193,114,0.8)', 'rgba(52,144,220,0.8)', 'rgba(255,193,7,0.8)',
    'rgba(149,97,226,0.8)', 'rgba(108,117,125,0.8)',
  ];

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.slice(0, data.length), borderWidth: 1 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            label: c => {
              const total = c.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((c.parsed / total) * 100).toFixed(1) : 0;
              return `${c.label}: $${c.parsed.toLocaleString()} (${pct}%)`;
            }
          }
        },
        legend: { position: 'right', labels: { boxWidth: 12, padding: 10 } }
      }
    }
  });
}

// Analytics page chart (rendered into a given canvas id)
function renderAnalyticsTrendChart(canvasId, rows) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (!rows.length) {
    ctx.closest('div').innerHTML = '<p style="text-align:center;color:#aaa;padding:20px">No trend data yet</p>';
    return;
  }
  const labels = rows.map(r => {
    const [y, m] = String(r.period).split('-');
    return m ? new Date(y, m - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : r.period;
  });
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: rows.map(r => r.income || 0),
          borderColor: 'rgba(56,193,114,1)', backgroundColor: 'rgba(56,193,114,0.1)',
          tension: 0.3, fill: true, pointRadius: 3 },
        { label: 'Expenses', data: rows.map(r => r.expense || 0),
          borderColor: 'rgba(227,52,47,1)', backgroundColor: 'rgba(227,52,47,0.07)',
          tension: 0.3, fill: true, pointRadius: 3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: c => c.dataset.label + ': $' + c.parsed.y.toLocaleString() } } }
    }
  });
}

function renderAnalyticsChart(canvasId, categoryRows) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const sorted = [...categoryRows].sort((a, b) => b.total - a.total).slice(0, 10);
  const COLORS = ['#5D5CDE','#E3342F','#F6993F','#38C172','#3490DC','#FFC107','#9561E2','#6C757D','#17A2B8','#FF6384'];
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(c => c.category || 'Uncategorized'),
      datasets: [{ label: 'Expenses', data: sorted.map(c => c.total), backgroundColor: COLORS, borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => '$' + c.parsed.x.toLocaleString() } } },
      scales: { x: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } }
    }
  });
}
