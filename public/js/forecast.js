// Forecast Module
const ForecastModule = {
  forecast: null,
  trends: null,

  async init() {
    await Promise.all([this.loadForecast(), this.loadTrends()]);
  },

  async loadForecast(days = 30) {
    try {
      const response = await fetch(`/api/forecast/balance?days=${days}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.forecast = await response.json();
      this.renderForecast();
      this.renderChart();
    } catch (error) {
      console.error('Error loading forecast:', error);
    }
  },

  async loadTrends() {
    try {
      const response = await fetch('/api/forecast/trends', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.trends = await response.json();
      this.renderTrends();
    } catch (error) {
      console.error('Error loading trends:', error);
    }
  },

  renderForecast() {
    const container = document.getElementById('forecast-summary');
    if (!container || !this.forecast) return;

    const s = this.forecast.summary;
    const isPositive = s.change >= 0;

    container.innerHTML = `
      <div class="forecast-main">
        <div class="forecast-current">
          <span class="label">Current balance</span>
          <span class="value">${s.currentBalance.toLocaleString()} $</span>
        </div>
        <div class="forecast-arrow ${isPositive ? 'up' : 'down'}">${isPositive ? '↗' : '↘'}</div>
        <div class="forecast-projected">
          <span class="label">Через 30 days</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${s.projectedBalance.toLocaleString()} $</span>
        </div>
      </div>
      <div class="forecast-details">
        <div class="detail-item">
          <span class="label">Изменение</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${s.change.toLocaleString()} $ (${s.changePercent}%)</span>
        </div>
        <div class="detail-item warning">
          <span class="label">Минимум balance</span>
          <span class="value">${s.lowestPoint.toLocaleString()} $</span>
          <small>${s.lowestDate}</small>
        </div>
        <div class="detail-item">
          <span class="label">Avg. expense/day</span>
          <span class="value negative">${s.avgDailyExpense.toLocaleString()} $</span>
        </div>
        <div class="detail-item">
          <span class="label">Avg. income/day</span>
          <span class="value positive">${s.avgDailyIncome.toLocaleString()} $</span>
        </div>
      </div>
    `;
  },

  renderChart() {
    const canvas = document.getElementById('forecast-chart');
    if (!canvas || !this.forecast) return;

    const ctx = canvas.getContext('2d');
    const data = this.forecast.forecast;

    if (window.forecastChartInstance) {
      window.forecastChartInstance.destroy();
    }

    window.forecastChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.date.substring(5)),
        datasets: [{
          label: 'Balance',
          data: data.map(d => d.balance),
          borderColor: '#5D5CDE',
          backgroundColor: 'rgba(93, 92, 222, 0.1)',
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: false },
          x: { ticks: { maxTicksLimit: 10 } }
        }
      }
    });
  },

  renderTrends() {
    const container = document.getElementById('trends-summary');
    if (!container || !this.trends) return;

    const t = this.trends.trends;
    const p = this.trends.prediction;

    container.innerHTML = `
      <div class="trends-grid">
        <div class="trend-card">
          <div class="trend-header"><span>📈 Income</span><span class="${t.income.direction === 'up' ? 'positive' : 'negative'}">${t.income.direction === 'up' ? '↑' : '↓'} ${t.income.percent}%</span></div>
          <div class="trend-prediction">Forecast: <strong>${p.nextMonthIncome.toLocaleString()} $</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>📉 Expenses</span><span class="${t.expense.direction === 'down' ? 'positive' : 'negative'}">${t.expense.direction === 'up' ? '↑' : '↓'} ${t.expense.percent}%</span></div>
          <div class="trend-prediction">Forecast: <strong>${p.nextMonthExpense.toLocaleString()} $</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>💰 Сбережения</span><span class="${t.savings.direction === 'up' ? 'positive' : 'negative'}">${t.savings.direction === 'up' ? '↑' : '↓'} ${t.savings.percent}%</span></div>
          <div class="trend-prediction">Forecast: <strong class="${p.nextMonthSavings >= 0 ? 'positive' : 'negative'}">${p.nextMonthSavings.toLocaleString()} $</strong></div>
        </div>
      </div>
    `;

    this.renderTrendsChart();
  },

  renderTrendsChart() {
    const canvas = document.getElementById('trends-chart');
    if (!canvas || !this.trends) return;

    const ctx = canvas.getContext('2d');
    const months = this.trends.months;

    if (window.trendsChartInstance) {
      window.trendsChartInstance.destroy();
    }

    window.trendsChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.month),
        datasets: [
          { label: 'Income', data: months.map(m => m.income), backgroundColor: 'rgba(56, 193, 114, 0.7)' },
          { label: 'Expenses', data: months.map(m => m.expense), backgroundColor: 'rgba(227, 52, 47, 0.7)' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  },

  changePeriod(days) {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    this.loadForecast(days);
  },

  getPage() {
    return `
      <div class="forecast-page">
        <div class="page-header">
          <h1>🔮 Forecast</h1>
          <div class="period-buttons">
            <button class="btn period-btn" onclick="ForecastModule.changePeriod(7)">7 days</button>
            <button class="btn period-btn active" onclick="ForecastModule.changePeriod(30)">30 days</button>
            <button class="btn period-btn" onclick="ForecastModule.changePeriod(90)">90 days</button>
          </div>
        </div>

        <div class="card" id="forecast-summary"></div>

        <div class="card">
          <h3>📊 Forecast balance</h3>
          <div class="chart-container" style="height:300px"><canvas id="forecast-chart"></canvas></div>
        </div>

        <div class="card">
          <h3>📈 Trends & forecasts for next month</h3>
          <div id="trends-summary"></div>
          <div class="chart-container" style="height:250px;margin-top:1rem"><canvas id="trends-chart"></canvas></div>
        </div>
      </div>
    `;
  }
};
