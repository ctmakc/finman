// Функции для работы с графиками
// Цвета берём из дизайн-системных токенов (--fm-*), поэтому графики
// автоматически совпадают с палитрой и переключаются вместе с темой.

// Читает CSS-переменную из :root (фолбэк, если переменная не найдена).
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

// hex (#rgb / #rrggbb) → rgba(...) с нужной альфой; не-hex значения отдаём как есть.
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

// Форматирование сумм в гривне для осей/тултипов.
function fmMoney(value) {
  try {
    return '₴' + Number(value).toLocaleString('uk-UA', { maximumFractionDigits: 0 });
  } catch (e) {
    return '₴' + value;
  }
}

// Инициализация графиков на дашборде
function initCharts(statsData) {
    // Инициализация графика доходов и расходов
    initIncomeExpenseChart(statsData.transactionsByMonth);

    // Инициализация графика категорий расходов
    initExpenseCategoriesChart(statsData.transactionsByCategory);
  }

  // График доходов и расходов по месяцам
  function initIncomeExpenseChart(transactionsByMonth) {
    const ctx = document.getElementById('income-expense-chart').getContext('2d');

    const ink2 = fmToken('--fm-ink-2', '#545A6B');
    const border = fmToken('--fm-border', '#E2E5EE');
    const positive = fmToken('--fm-positive', '#0E9B8A');
    const negative = fmToken('--fm-negative', '#C76074');

    // Сортировка месяцев
    const sortedMonths = Object.keys(transactionsByMonth).sort();

    // Подготовка данных
    const labels = sortedMonths.map(month => {
      const [year, monthNum] = month.split('-');
      return new Date(year, monthNum - 1).toLocaleDateString('uk-UA', { month: 'short', year: 'numeric' });
    });

    const incomeData = sortedMonths.map(month => transactionsByMonth[month].income);
    const expenseData = sortedMonths.map(month => transactionsByMonth[month].expense);

    // Создание графика
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Доходи',
            data: incomeData,
            backgroundColor: fmAlpha(positive, 0.78),
            borderColor: positive,
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false
          },
          {
            label: 'Витрати',
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

  // График категорий расходов
  function initExpenseCategoriesChart(transactionsByCategory) {
    const ctx = document.getElementById('expense-categories-chart').getContext('2d');

    const ink2 = fmToken('--fm-ink-2', '#545A6B');
    const surface = fmToken('--fm-surface', '#FFFFFF');

    // Фильтрация только расходов и сортировка по сумме
    const expenseCategories = Object.entries(transactionsByCategory)
      .filter(([_, values]) => values.expense > 0)
      .sort((a, b) => b[1].expense - a[1].expense);

    // Ограничение до 7 категорий, остальные объединяем в "Другое"
    const topCategories = expenseCategories.slice(0, 7);
    const otherCategories = expenseCategories.slice(7);

    let labels = topCategories.map(([category]) => category);
    let data = topCategories.map(([_, values]) => values.expense);

    // Добавление категории "Другое", если есть
    if (otherCategories.length > 0) {
      const otherSum = otherCategories.reduce((sum, [_, values]) => sum + values.expense, 0);
      labels.push('Інше');
      data.push(otherSum);
    }

    // Палитра категорий из токенов дизайн-системы (индиго → ramp вокруг бренда).
    const palette = [
      fmToken('--fm-primary', '#5D5CDE'),
      fmToken('--fm-primary-soft', '#7C7BEA'),
      fmToken('--fm-positive', '#0E9B8A'),
      fmToken('--fm-warning', '#D98A1F'),
      fmToken('--fm-negative', '#C76074'),
      fmToken('--fm-secondary', '#5B6478'),
      fmToken('--fm-primary-strong', '#4B49C8'),
      fmToken('--fm-ink-3', '#8A90A2') // для "Інше"
    ];
    const backgroundColors = labels.map((_, i) => fmAlpha(palette[i % palette.length], 0.85));

    // Создание графика
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
                const percentage = ((value / total) * 100).toFixed(1);
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
