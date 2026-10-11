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

  // /api/forecast converts everything into the user's base currency and
  // returns it (summary.currency / currency) with missingRates.
  async init() {
    await UI.loadBaseCurrency();
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
    const note = document.getElementById('forecast-currency-note');
    if (note) note.innerHTML = UI.missingRatesNote(this.forecast && this.forecast.summary && this.forecast.summary.missingRates);
    const container = document.getElementById('forecast-summary');
    if (!container || !this.forecast) return;

    const s = this.forecast.summary;
    const isPositive = s.change >= 0;

    // Новый блок доверия (если бэкенд вернул confidence — рендерим).
    let confidenceHtml = '';
    if (s.confidence) {
      confidenceHtml = `
        <div class="detail-item">
          <span class="label">${t('forecast.band')}</span>
          <span class="value">${this.fmt(s.confidence.endBand)}</span>
          <small>${this.fmt(s.confidence.projectedLower)} … ${this.fmt(s.confidence.projectedUpper)}</small>
        </div>
        <div class="detail-item ${s.worstCasePoint < 0 ? 'warning' : ''}">
          <span class="label">${t('forecast.worstCase')}</span>
          <span class="value ${s.worstCasePoint < 0 ? 'negative' : ''}">${this.fmt(s.worstCasePoint)}</span>
          <small>${s.worstCaseDate || ''}</small>
        </div>
        <div class="detail-item">
          <span class="label">${t('forecast.model')}</span>
          <span class="value">${s.model === 'seasonal_trend' ? t('forecast.model.seasonal') : t('forecast.model.average')}</span>
          <small>${t('forecast.trendPerDay', { value: this.fmt(s.trendPerDay || 0) })}</small>
        </div>`;
    }

    container.innerHTML = `
      <div class="forecast-main">
        <div class="forecast-current">
          <span class="label">${t('forecast.currentBalance')}</span>
          <span class="value">${this.fmt(s.currentBalance)}</span>
        </div>
        <div class="forecast-arrow ${isPositive ? 'up' : 'down'}">${isPositive ? '↗' : '↘'}</div>
        <div class="forecast-projected">
          <span class="label">${t('forecast.projected')}</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${this.fmt(s.projectedBalance)}</span>
        </div>
      </div>
      <div class="forecast-details">
        <div class="detail-item">
          <span class="label">${t('forecast.change')}</span>
          <span class="value ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${this.fmt(s.change)} (${s.changePercent}%)</span>
        </div>
        <div class="detail-item warning">
          <span class="label">${t('forecast.lowest')}</span>
          <span class="value">${this.fmt(s.lowestPoint)}</span>
          <small>${s.lowestDate || ''}</small>
        </div>
        <div class="detail-item">
          <span class="label">${t('forecast.avgExpense')}</span>
          <span class="value negative">${this.fmt(s.avgDailyExpense)}</span>
        </div>
        <div class="detail-item">
          <span class="label">${t('forecast.avgIncome')}</span>
          <span class="value positive">${this.fmt(s.avgDailyIncome)}</span>
        </div>
        ${confidenceHtml}
      </div>
    `;
  },

  renderChart() {
    const canvas = document.getElementById('forecast-chart');
    if (!canvas || !this.forecast || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return; // no 2D context: keep the summary, skip the chart
    const data = this.forecast.forecast;

    if (window.forecastChartInstance) {
      window.forecastChartInstance.destroy();
    }

    const datasets = [{
      label: t('forecast.chart.balance'),
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
        label: t('forecast.chart.upper'),
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
        label: t('forecast.chart.lower'),
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
      container.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle"></i> ${t('forecast.noAnomalies')}</div>`;
      return;
    }

    const sevLabel = { high: t('forecast.sev.high'), medium: t('forecast.sev.medium'), low: t('forecast.sev.low') };
    const typeLabel = {
      amount_outlier: t('forecast.anomaly.amount_outlier'),
      duplicate_charge: t('forecast.anomaly.duplicate_charge'),
      subscription_hike: t('forecast.anomaly.subscription_hike')
    };

    const summaryHtml = summary ? `
      <div class="anomalies-summary">
        ${t('common.total')}: <strong>${summary.total}</strong> ·
        ${sevLabel.high}: ${summary.high} · ${sevLabel.medium}: ${summary.medium} · ${sevLabel.low}: ${summary.low}
      </div>` : '';

    container.innerHTML = summaryHtml + list.map(a => `
      <div class="anomaly-item severity-${a.severity}">
        <div class="anomaly-head">
          <span class="anomaly-type">${typeLabel[a.type] || this.escape(a.type)}</span>
          <span class="anomaly-sev">${sevLabel[a.severity] || this.escape(a.severity)}</span>
        </div>
        <div class="anomaly-reason">${this.escape(a.reason)}</div>
        <div class="anomaly-meta">
          ${a.amount != null ? `<span>${this.fmt(a.amount)}</span>` : ''}
          ${a.date ? `<small>${a.date}</small>` : ''}
        </div>
      </div>
    `).join('');
  },

  renderTrends() {
    const container = document.getElementById('trends-summary');
    if (!container || !this.trends) return;

    const tr = this.trends.trends;
    const p = this.trends.prediction;

    container.innerHTML = `
      <div class="trends-grid">
        <div class="trend-card">
          <div class="trend-header"><span>${t('forecast.trend.income')}</span><span class="${tr.income.direction === 'up' ? 'positive' : 'negative'}">${tr.income.direction === 'up' ? '↑' : '↓'} ${tr.income.percent}%</span></div>
          <div class="trend-prediction">${t('forecast.prediction')}: <strong>${this.fmt(p.nextMonthIncome)}</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>${t('forecast.trend.expense')}</span><span class="${tr.expense.direction === 'down' ? 'positive' : 'negative'}">${tr.expense.direction === 'up' ? '↑' : '↓'} ${tr.expense.percent}%</span></div>
          <div class="trend-prediction">${t('forecast.prediction')}: <strong>${this.fmt(p.nextMonthExpense)}</strong></div>
        </div>
        <div class="trend-card">
          <div class="trend-header"><span>${t('forecast.trend.savings')}</span><span class="${tr.savings.direction === 'up' ? 'positive' : 'negative'}">${tr.savings.direction === 'up' ? '↑' : '↓'} ${tr.savings.percent}%</span></div>
          <div class="trend-prediction">${t('forecast.prediction')}: <strong class="${p.nextMonthSavings >= 0 ? 'positive' : 'negative'}">${this.fmt(p.nextMonthSavings)}</strong></div>
        </div>
      </div>
    `;

    this.renderTrendsChart();
  },

  renderTrendsChart() {
    const canvas = document.getElementById('trends-chart');
    if (!canvas || !this.trends || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return; // no 2D context: keep the summary, skip the chart
    const months = this.trends.months;

    if (window.trendsChartInstance) {
      window.trendsChartInstance.destroy();
    }

    window.trendsChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.month),
        datasets: [
          { label: t('forecast.trend.income'), data: months.map(m => m.income), backgroundColor: 'rgba(56, 193, 114, 0.7)' },
          { label: t('forecast.trend.expense'), data: months.map(m => m.expense), backgroundColor: 'rgba(227, 52, 47, 0.7)' }
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
    const cur = (this.forecast && this.forecast.summary && this.forecast.summary.currency) || (this.trends && this.trends.currency);
    return UI.esc(UI.convertedMoney(Number.isFinite(num) ? num : 0, cur));
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
          <h1><i class="fas fa-chart-area"></i> ${t('forecast.title')}</h1>
          <div class="period-buttons">
            <button class="btn period-btn" type="button" data-action="forecast:period" data-days="7">${t('forecast.days', { n: 7 })}</button>
            <button class="btn period-btn active" type="button" data-action="forecast:period" data-days="30">${t('forecast.days', { n: 30 })}</button>
            <button class="btn period-btn" type="button" data-action="forecast:period" data-days="90">${t('forecast.days', { n: 90 })}</button>
          </div>
        </div>

        <div id="forecast-currency-note"></div>
        <div class="card" id="forecast-summary"></div>

        <div class="card">
          <h3>${t('forecast.balanceChart')}</h3>
          <div class="chart-container" style="height:300px"><canvas id="forecast-chart"></canvas></div>
        </div>

        <div class="card">
          <h3>${t('forecast.anomaliesTitle')}</h3>
          <div id="anomalies-list"></div>
        </div>

        <div class="card">
          <h3>${t('forecast.trendsTitle')}</h3>
          <div id="trends-summary"></div>
          <div class="chart-container" style="height:250px;margin-top:1rem"><canvas id="trends-chart"></canvas></div>
        </div>
      </div>
    `;
  }
};

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'forecast:period': (el) => ForecastModule.changePeriod(Number(el.dataset.days)),
  });
})();
