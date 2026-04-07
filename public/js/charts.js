// Functions for графикs

// Initialize графиков на dashboardе
function initCharts(statsData) {
    // Initialize графика incomes and expenses
    initIncomeExpenseChart(statsData.transactionsByMonth);
    
    // Initialize графика categories expenses
    initExpenseCategoriesChart(statsData.transactionsByCategory);
  }
  
  // График incomes and expenses by months
  function initIncomeExpenseChart(transactionsByMonth) {
    const ctx = document.getElementById('income-expense-chart').getContext('2d');
    
    // Сортировка monthев
    const sortedMonths = Object.keys(transactionsByMonth).sort();
    
    // Подготовка дан
    const labels = sortedMonths.map(month => {
      const [year, monthNum] = month.split('-');
      return new Date(year, monthNum - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    });
    
    const incomeData = sortedMonths.map(month => transactionsByMonth[month].income);
    const expenseData = sortedMonths.map(month => transactionsByMonth[month].expense);
    
    // Create chart
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Income',
            data: incomeData,
            backgroundColor: 'rgba(56, 193, 114, 0.7)',
            borderColor: 'rgba(56, 193, 114, 1)',
            borderWidth: 1
          },
          {
            label: 'Expenses',
            data: expenseData,
            backgroundColor: 'rgba(227, 52, 47, 0.7)',
            borderColor: 'rgba(227, 52, 47, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return '$' + value.toLocaleString('en-US');
              }
            }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                label += '$' + context.parsed.y.toLocaleString('en-US');
                return label;
              }
            }
          }
        }
      }
    });
  }
  
  // График categories expenses
  function initExpenseCategoriesChart(transactionsByCategory) {
    const ctx = document.getElementById('expense-categories-chart').getContext('2d');
    
    // Фильтрация только expenses and сортировка по сумме
    const expenseCategories = Object.entries(transactionsByCategory)
      .filter(([_, values]) => values.expense > 0)
      .sort((a, b) => b[1].expense - a[1].expense);
    
    // Ограничение до 7 categories, остальные объединяем в "Other"
    const topCategories = expenseCategories.slice(0, 7);
    const otherCategories = expenseCategories.slice(7);
    
    let labels = topCategories.map(([category]) => category);
    let data = topCategories.map(([_, values]) => values.expense);
    
    // Adding каtagории "Other", если есть
    if (otherCategories.length > 0) {
      const otherSum = otherCategories.reduce((sum, [_, values]) => sum + values.expense, 0);
      labels.push('Other');
      data.push(otherSum);
    }
    
    // Generate colors
    const backgroundColors = [
      'rgba(227, 52, 47, 0.7)',
      'rgba(246, 153, 63, 0.7)',
      'rgba(255, 193, 7, 0.7)',
      'rgba(56, 193, 114, 0.7)',
      'rgba(52, 144, 220, 0.7)',
      'rgba(101, 116, 205, 0.7)',
      'rgba(149, 97, 226, 0.7)',
      'rgba(108, 117, 125, 0.7)' // For "Other"
    ];
    
    // Create chart
    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: backgroundColors,
            borderColor: backgroundColors.map(color => color.replace('0.7', '1')),
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.parsed;
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = ((value / total) * 100).toFixed(1);
                return `${context.label}: ₽${value.toLocaleString('en-US')} (${percentage}%)`;
              }
            }
          },
          legend: {
            position: 'right',
            labels: {
              boxWidth: 12,
              padding: 10
            }
          }
        }
      }
    });
  }