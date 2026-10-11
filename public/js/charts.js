// Dashboard charts (Chart.js).
// Every colour comes from the design-system tokens (--fm-*), so the charts
// follow the palette and switch together with the theme. The reskin agent
// can re-palette charts from CSS alone via --fm-chart-1..6, --fm-positive,
// --fm-negative and --fm-ink-3 (sane fallbacks below).

// Read a CSS custom property from :root (fallback when missing).
function fmToken(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

// Series palette: --fm-chart-1..6 first, then the brand tokens as fallbacks.
function fmChartPalette() {
  const fallbacks = [
    fmToken('--fm-primary', '#5D5CDE'),
    fmToken('--fm-primary-soft', '#7C7BEA'),
    fmToken('--fm-positive', '#0E9B8A'),
    fmToken('--fm-warning', '#D98A1F'),
    fmToken('--fm-negative', '#C76074'),
    fmToken('--fm-secondary', '#5B6478')
  ];
  return fallbacks.map((fb, i) => fmToken('--fm-chart-' + (i + 1), fb));
}

// hex (#rgb / #rrggbb) -> rgba(...) with the given alpha; other values pass through.
function fmAlpha(color, alpha) {
  const c = (color || '').trim();
  let hex = c.charAt(0) === '#' ? c.slice(1) : '';
  if (hex.length === 3) {
    hex = hex.split('').map((ch) => ch + ch).join('');
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }
  return c || ('rgba(93, 92, 222, ' + alpha + ')');
}

// BCP-47 locale for Intl, derived from the active UI language.
function fmChartLocale() {
  const lang = (typeof i18n !== 'undefined' && i18n && typeof i18n.getLanguage === 'function')
    ? i18n.getLanguage()
    : 'en';
  return lang === 'uk' ? 'uk-UA' : lang === 'ru' ? 'ru-RU' : 'en-CA';
}

// Whole-number amount in the base currency for axes/tooltips.
function fmMoney(value) {
  const code = (typeof appState !== 'undefined' && appState && appState.baseCurrency) || 'CAD';
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(fmChartLocale(), {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0
    }).format(safe);
  } catch (e) {
    return Math.round(safe) + ' ' + code;
  }
}

// Dashboard chart bootstrap
let _lastChartStats = null;

function initCharts(statsData) {
    _lastChartStats = statsData; // cached for the theme-change redraw
    initIncomeExpenseChart(statsData.transactionsByMonth);
    initExpenseCategoriesChart(statsData.transactionsByCategory);
  }

  // Income vs expense by month
  function initIncomeExpenseChart(transactionsByMonth) {
    const ctx = document.getElementById('income-expense-chart').getContext('2d');
    if (window.Chart && Chart.getChart) { const _ex = Chart.getChart(ctx.canvas); if (_ex) _ex.destroy(); }

    const ink2 = fmToken('--fm-ink-2', '#545A6B');
    const border = fmToken('--fm-border', '#E2E5EE');
    const positive = fmToken('--fm-positive', '#0E9B8A');
    const negative = fmToken('--fm-negative', '#C76074');
    const locale = fmChartLocale();

    const sortedMonths = Object.keys(transactionsByMonth || {}).sort();

    const labels = sortedMonths.map(month => {
      const [year, monthNum] = month.split('-');
      return new Date(year, monthNum - 1).toLocaleDateString(locale, { month: 'short', year: 'numeric' });
    });

    const incomeData = sortedMonths.map(month => transactionsByMonth[month].income);
    const expenseData = sortedMonths.map(month => transactionsByMonth[month].expense);

    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: t('common.income'),
            data: incomeData,
            backgroundColor: fmAlpha(positive, 0.78),
            borderColor: positive,
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false
          },
          {
            label: t('common.expense'),
            data: expenseData,
            backgroundColor: fmAlpha(negative, 0.78),
            borderColor: negative,
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: ink2 }
          },
          y: {
            beginAtZero: true,
            grid: { color: border, drawBorder: false },
            ticks: {
              color: ink2,
              callback: function(value) {
                return fmMoney(value);
              }
            }
          }
        },
        plugins: {
          legend: {
            labels: { color: ink2, boxWidth: 12, padding: 12 }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                label += fmMoney(context.parsed.y);
                return label;
              }
            }
          }
        }
      }
    });
  }

  // Expenses by category (doughnut)
  function initExpenseCategoriesChart(transactionsByCategory) {
    const ctx = document.getElementById('expense-categories-chart').getContext('2d');
    if (window.Chart && Chart.getChart) { const _ex = Chart.getChart(ctx.canvas); if (_ex) _ex.destroy(); }

    const ink2 = fmToken('--fm-ink-2', '#545A6B');
    const surface = fmToken('--fm-surface', '#FFFFFF');

    // Expenses only, largest first
    const expenseCategories = Object.entries(transactionsByCategory || {})
      .filter(([_, values]) => values.expense > 0)
      .sort((a, b) => b[1].expense - a[1].expense);

    // Top 6 categories; the rest collapse into "Other"
    const topCategories = expenseCategories.slice(0, 6);
    const otherCategories = expenseCategories.slice(6);

    let labels = topCategories.map(([category]) => category);
    let data = topCategories.map(([_, values]) => values.expense);

    const palette = fmChartPalette();
    const backgroundColors = labels.map((_, i) => fmAlpha(palette[i % palette.length], 0.85));

    if (otherCategories.length > 0) {
      const otherSum = otherCategories.reduce((sum, [_, values]) => sum + values.expense, 0);
      labels.push(t('common.other'));
      data.push(otherSum);
      backgroundColors.push(fmAlpha(fmToken('--fm-ink-3', '#8A90A2'), 0.85));
    }

    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: backgroundColors,
            borderColor: surface,
            borderWidth: 2,
            hoverBorderColor: surface,
            hoverOffset: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '64%',
        plugins: {
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.parsed;
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                return `${context.label}: ${fmMoney(value)} (${percentage}%)`;
              }
            }
          },
          legend: {
            position: 'right',
            labels: {
              color: ink2,
              boxWidth: 12,
              padding: 10
            }
          }
        }
      }
    });
  }

// Redraw on theme change: the --fm-* tokens change, so re-read them and
// re-create the charts from the last data (destroy+recreate is built in).
if (typeof document !== 'undefined') {
  document.addEventListener('fm:themechange', function () {
    if (_lastChartStats) {
      try { initCharts(_lastChartStats); } catch (e) { /* charts may be absent on the current page */ }
    }
  });
}
