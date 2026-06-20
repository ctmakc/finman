// Forecast Module
// Рендерит прогноз баланса с доверительным коридором + список аномалий.
// Обратно совместим: сохраняет init/loadForecast/loadTrends/getPage старого модуля.
const ForecastModule = {
  forecast: null,
  trends: null,
  anomalies: null,

  authHeaders() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  async init() {
    await Promise.all([this.loadForecast(), this.loadTrends(), this.loadAnomalies()]);
  },

  async loadForecast(days = 30) {
    try {
      const response = await fetch(`/api/forecast/balance?days=${days}`, {
        headers: this.authHeaders()
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
        headers: this.authHeaders()
      });
      this.trends = await response.json();
      this.renderTrends();
    } catch (error) {
      console.error('Error loading trends:', error);
    }
  },

  async loadAnomalies() {
    try {
      const response = await fetch('/api/anomalies', {
        headers: this.authHeaders()
      });
      const body = await response.json();
      // Формат Foundation: { success, data:{ anomalies, summary } }
      this.anomalies = body && body.data ? body.data : body;
      this.renderAnomalies();
    } catch (error) {
      console.error('Error loading anomalies:', error);
    }
  },

  renderForecast() {
    const container = document.getElementById('forecast-summary');
    if (!container || !this.forecast) return;

    const s = this.forecast.summary;
    const isPositive = s.change >= 0;

    // Новый блок доверия (если бэкенд вернул confidence — рендерим).
    let confidenceHtml = '';
    if (s.confidence) {
      confidenceHtml = `
        <div class="detail-item">
          <span class="label">Коридор прогноза (±)</span>
          <span class="value">${this.fmt(s.confidence.endBand)} ₴</span>
          <small>${this.fmt(s.confidence.projectedLower)} … ${this.fmt(s.confidence.projectedUpper)} ₴</small>
        </div>
        <div class="detail-item ${s.worstCasePoint < 0 ? 'warning' : ''}">
          <span class="label">Худший сценарий</span>
          <span class="value ${s.worstCasePoint < 0 ? 'negative' : ''}">${this.fmt(s.worstCasePoint)} ₴</span>
          <small>${s.worstCaseDate || ''}</small>
        </div>
        <div class="detail-item">
          <span class="label">Модель</span>
          <span class="value">${s.model === 'seasonal_trend' ? 'сезонность+тренд' : 'средняя'}</span>
          <small>тренд/день: ${this.fmt(s.trendPerDay || 0)} ₴</small>
        </div>`;
    }

    container.innerHTML = `
      <div class="forecast-main">
        <div class="forecast-current">
          <span class="label">Текущий баланс</span>
          <span class="value">${this.fmt(s.currentBalance)} ₴</span>
        </div>
        <div class="forecast-arrow ${isPositive ? 'up' : 'down'}">${isPositive ? '↗' : '↘'}</div>
        <div class="forecast-projected">
          <span class="label">Прогноз</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${this.fmt(s.projectedBalance)} ₴</span>
        </div>
      </div>
      <div class="forecast-details">
        <div class="detail-item">
          <span class="label">Изменение</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${this.fmt(s.change)} ₴ (${s.changePercent}%)</span>
        </div>
        <div class="detail-item warning">
          <span class="label">Минимум баланса</span>
          <span class="value">${this.fmt(s.lowestPoint)} ₴</span>
          <small>${s.lowestDate || ''}</small>
        </div>
        <div class="detail-item">
          <span class="label">Ср. расход/день</span>
          <span class="value negative">${this.fmt(s.avgDailyExpense)} ₴</span>
        </div>
        <div class="detail-item">
          <span class="label">Ср. доход/день</span>
          <span class="value positive">${this.fmt(s.avgDailyIncome)} ₴</span>
        </div>
        ${confidenceHtml}
      </div>
    `;
  },

  renderChart() {
    const canvas = document.getElementById('forecast-chart');
    if (!canvas || !this.forecast || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');
    const data = this.forecast.forecast;

    if (window.forecastChartInstance) {
      window.forecastChartInstance.destroy();
    }

    const datasets = [{
      label: 'Баланс',
      data: data.map(d => d.balance),
      borderColor: '#5D5CDE',
      backgroundColor: 'rgba(93, 92, 222, 0.1)',
      fill: false,
      tension: 0.3,
      order: 1
    }];

    // Доверительный коридор: верхняя и нижняя границы с заливкой между ними.
    const hasBand = data.length && data[0].balanceUpper !== undefined;
    if (hasBand) {
      datasets.push({
        label: 'Верхняя граница',
        data: data.map(d => d.balanceUpper),
        borderColor: 'rgba(93, 92, 222, 0.25)',
        borderDash: [4, 4],
        pointRadius: 0,
        fill: '+1', // заливка до следующего датасета (нижней границы)
        backgroundColor: 'rgba(93, 92, 222, 0.10)',
        tension: 0.3,
        order: 2
      });
      datasets.push({
        label: 'Нижняя граница',
        data: data.map(d => d.balanceLower),
        borderColor: 'rgba(93, 92, 222, 0.25)',
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 3
      });
    }

    window.forecastChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.date.substring(5)),
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: hasBand, position: 'bottom' },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          y: { beginAtZero: false },
          x: { ticks: { maxTicksLimit: 10 } }
        }
      }
    });
  },

  renderAnomalies() {
    const container = document.getElementById('anomalies-list');
    if (!container) return;

    const list = (this.anomalies && this.anomalies.anomalies) || [];
    const summary = (this.anomalies && this.anomalies.summary) || null;

    if (!list.length) {
      container.innerHTML = `<div class="empty-state">✅ Аномалий не обнаружено</div>`;
      return;
    }

    const sevLabel = { high: '🔴 Высокая', medium: '🟠 Средняя', low: '🟡 Низкая' };
    const typeLabel = {
      amount_outlier: 'Крупная транзакция',
      duplicate_charge: 'Повтор списания',
      subscription_hike: 'Рост цены подписки'
    };

    const summaryHtml = summary ? `
      <div class="anomalies-summary">
        Всего: <strong>${summary.total}</strong> ·
        🔴 ${summary.high} · 🟠 ${summary.medium} · 🟡 ${summary.low}
      </div>` : '';

    container.innerHTML = summaryHtml + list.map(a => `
      <div class="anomaly-item severity-${a.severity}">
        <div class="anomaly-head">
          <span class="anomaly-type">${typeLabel[a.type] || a.type}</span>
          <span class="anomaly-sev">${sevLabel[a.severity] || a.severity}</span>
        </div>
        <div class="anomaly-reason">${this.escape(a.reason)}</div>
        <div class="anomaly-meta">
          ${a.amount != null ? `<span>${this.fmt(a.amount)} ₴</span>` : ''}
          ${a.date ? `<small>${a.date}</small>` : ''}
        </div>
      </div>
    `).join('');
  },

  renderTrends() {
    const container = document.getElementById('trends-summary');
    if (!container || !this.trends) return;

    const t = this.trends.trends;
    const p = this.trends.prediction;

    container.innerHTML = `
      <div class="trends-grid">
        <div class="trend-card">
          <div class="trend-header"><span>📈 Доходы</span><span class="${t.income.direction === 'up' ? 'positive' : 'negative'}">${t.income.direction === 'up' ? '↑' : '↓'} ${t.income.percent}%</span></div>
          <div class="trend-prediction">Прогноз: <strong>${this.fmt(p.nextMonthIncome)} ₴</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>📉 Расходы</span><span class="${t.expense.direction === 'down' ? 'positive' : 'negative'}">${t.expense.direction === 'up' ? '↑' : '↓'} ${t.expense.percent}%</span></div>
          <div class="trend-prediction">Прогноз: <strong>${this.fmt(p.nextMonthExpense)} ₴</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>💰 Сбережения</span><span class="${t.savings.direction === 'up' ? 'positive' : 'negative'}">${t.savings.direction === 'up' ? '↑' : '↓'} ${t.savings.percent}%</span></div>
          <div class="trend-prediction">Прогноз: <strong class="${p.nextMonthSavings >= 0 ? 'positive' : 'negative'}">${this.fmt(p.nextMonthSavings)} ₴</strong></div>
        </div>
      </div>
    `;

    this.renderTrendsChart();
  },

  renderTrendsChart() {
    const canvas = document.getElementById('trends-chart');
    if (!canvas || !this.trends || typeof Chart === 'undefined') return;

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
          { label: 'Доходы', data: months.map(m => m.income), backgroundColor: 'rgba(56, 193, 114, 0.7)' },
          { label: 'Расходы', data: months.map(m => m.expense), backgroundColor: 'rgba(227, 52, 47, 0.7)' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  },

  // ---- helpers ----
  fmt(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0';
    return num.toLocaleString();
  },

  escape(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  changePeriod(days) {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    if (typeof event !== 'undefined' && event.target) event.target.classList.add('active');
    this.loadForecast(days);
  },

  getPage() {
    return `
      <div class="forecast-page">
        <div class="page-header">
          <h1>🔮 Прогнозирование</h1>
          <div class="period-buttons">
            <button class="btn period-btn" onclick="ForecastModule.changePeriod(7)">7 дней</button>
            <button class="btn period-btn active" onclick="ForecastModule.changePeriod(30)">30 дней</button>
            <button class="btn period-btn" onclick="ForecastModule.changePeriod(90)">90 дней</button>
          </div>
        </div>

        <div class="card" id="forecast-summary"></div>

        <div class="card">
          <h3>📊 Прогноз баланса (с доверительным коридором)</h3>
          <div class="chart-container" style="height:300px"><canvas id="forecast-chart"></canvas></div>
        </div>

        <div class="card">
          <h3>⚠️ Аномалии транзакций</h3>
          <div id="anomalies-list"></div>
        </div>

        <div class="card">
          <h3>📈 Тренды и прогнозы на следующий месяц</h3>
          <div id="trends-summary"></div>
          <div class="chart-container" style="height:250px;margin-top:1rem"><canvas id="trends-chart"></canvas></div>
        </div>
      </div>
    `;
  }
};
