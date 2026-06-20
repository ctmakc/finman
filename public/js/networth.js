// Net Worth Module
const NetWorthModule = {
  current: null,
  history: [],
  assets: [],
  trend: null,

  // Символы валют для отображения базовой валюты.
  currencySymbols: {
    UAH: '₴', USD: '$', EUR: '€', GBP: '£', PLN: 'zł', CZK: 'Kč',
    CHF: 'CHF', CAD: 'C$', AUD: 'A$', JPY: '¥', CNY: '¥', TRY: '₺',
    ILS: '₪', BTC: '₿', RUB: '₽'
  },

  // Символ базовой валюты текущего расчёта (по умолчанию ₴).
  baseSymbol() {
    const code = (this.current && this.current.baseCurrency) || 'UAH';
    return this.currencySymbols[code] || code;
  },

  fmt(n) {
    return Number(n || 0).toLocaleString();
  },

  async init() {
    await Promise.all([
      this.loadCurrent(),
      this.loadHistory(),
      this.loadAssets(),
      this.loadTrend(),
    ]);
  },

  async loadCurrent() {
    try {
      const response = await fetch('/api/networth/current', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.current = await response.json();
      this.renderCurrent();
    } catch (error) {
      console.error('Error loading net worth:', error);
    }
  },

  async loadHistory() {
    try {
      const response = await fetch('/api/networth/history?period=year', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.history = await response.json();
      this.renderChart();
    } catch (error) {
      console.error('Error loading history:', error);
    }
  },

  async loadTrend() {
    try {
      const response = await fetch('/api/networth/trend?period=year', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const body = await response.json();
      // Foundation respond.ok -> { success, data }; защищаемся на случай legacy-формы.
      this.trend = (body && body.data) ? body.data : body;
      this.renderTrend();
    } catch (error) {
      console.error('Error loading trend:', error);
    }
  },

  async loadAssets() {
    try {
      const response = await fetch('/api/networth/assets', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.assets = await response.json();
      this.renderAssets();
    } catch (error) {
      console.error('Error loading assets:', error);
    }
  },

  renderCurrent() {
    const container = document.getElementById('networth-summary');
    if (!container || !this.current) return;

    const sym = this.baseSymbol();
    const change = this.history.length > 1 ? this.current.netWorth - this.history[0].net_worth : 0;
    const changePercent = this.history.length > 1 && this.history[0].net_worth ? (change / Math.abs(this.history[0].net_worth) * 100).toFixed(1) : 0;

    // Предупреждение, если для части валют не нашлось курса (расчёт приблизительный).
    const missing = (this.current.missingRates || []);
    const missingWarning = missing.length
      ? `<div class="networth-warning text-secondary" style="font-size:0.85em;margin-top:4px;">⚠️ Нет курса для: ${missing.join(', ')} — учтены 1:1, итог приблизительный</div>`
      : '';

    container.innerHTML = `
      <div class="networth-main">
        <div class="networth-value">
          <span class="label">Чистая стоимость (${(this.current.baseCurrency || 'UAH')})</span>
          <span class="value ${this.current.netWorth >= 0 ? 'positive' : 'negative'}">${this.fmt(this.current.netWorth)} ${sym}</span>
          ${change !== 0 ? `<span class="change ${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : ''}${this.fmt(change)} ${sym} (${changePercent}%)</span>` : ''}
          ${missingWarning}
        </div>
      </div>
      <div class="networth-breakdown">
        <div class="breakdown-item positive"><span class="label">Активы</span><span class="value">${this.fmt(this.current.totalAssets)} ${sym}</span></div>
        <div class="breakdown-item negative"><span class="label">Обязательства</span><span class="value">${this.fmt(this.current.totalLiabilities)} ${sym}</span></div>
      </div>
    `;

    this.renderBreakdown();
  },

  // Небольшой тренд по снимкам (текстовый, рядом с графиком).
  renderTrend() {
    const container = document.getElementById('networth-trend');
    if (!container) return;

    const t = this.trend;
    if (!t || !Array.isArray(t.points) || t.points.length < 2) {
      container.innerHTML = '<p class="text-secondary" style="font-size:0.85em;">Тренд появится после нескольких снимков</p>';
      return;
    }

    const sym = this.baseSymbol();
    const ch = t.change || { amount: 0, percent: 0 };
    const dir = ch.amount >= 0 ? 'positive' : 'negative';
    const arrow = ch.amount >= 0 ? '▲' : '▼';
    const sign = ch.amount >= 0 ? '+' : '';

    container.innerHTML = `
      <div class="networth-trend-line ${dir}" style="font-size:0.9em;">
        <span>${arrow} ${sign}${this.fmt(ch.amount)} ${sym}</span>
        <span class="text-secondary"> (${sign}${(ch.percent || 0)}%)</span>
        <span class="text-secondary" style="margin-left:6px;">за ${t.points.length} снимк.</span>
      </div>
    `;
  },

  renderBreakdown() {
    const container = document.getElementById('networth-details');
    if (!container || !this.current) return;

    const ab = this.current.assetsBreakdown;
    container.innerHTML = `
      <div class="card"><h3>📊 Разбивка активов</h3>
        <div class="breakdown-list">
          <div class="breakdown-row"><span>Счета</span><span>${(ab.accounts?.total || 0).toLocaleString()} ₴</span></div>
          <div class="breakdown-row"><span>Инвестиции</span><span>${(ab.investments?.total || 0).toLocaleString()} ₴</span></div>
          <div class="breakdown-row"><span>Ручные активы</span><span>${(ab.manualAssets?.total || 0).toLocaleString()} ₴</span></div>
          <div class="breakdown-row"><span>Вам должны</span><span>${(ab.receivables?.total || 0).toLocaleString()} ₴</span></div>
        </div>
      </div>
    `;
  },

  renderAssets() {
    const container = document.getElementById('manual-assets');
    if (!container) return;

    if (this.assets.length === 0) {
      container.innerHTML = '<p class="text-secondary">Нет добавленных активов</p>';
      return;
    }

    const assetIcons = { real_estate: '🏠', vehicle: '🚗', crypto: '₿', precious_metals: '🥇', collectibles: '🎨', business: '🏢', other: '📦' };

    container.innerHTML = this.assets.filter(a => a.is_active).map(asset => `
      <div class="asset-item">
        <span class="asset-icon">${assetIcons[asset.type] || '📦'}</span>
        <div class="asset-info"><strong>${asset.name}</strong><small>${asset.type}</small></div>
        <span class="asset-value">${asset.value.toLocaleString()} ${asset.currency}</span>
        <button class="btn btn-sm btn-icon" onclick="NetWorthModule.editAsset(${asset.id})">✏️</button>
        <button class="btn btn-sm btn-icon btn-danger" onclick="NetWorthModule.deleteAsset(${asset.id})">🗑</button>
      </div>
    `).join('');
  },

  renderChart() {
    const container = document.getElementById('networth-chart');
    if (!container || this.history.length < 2) {
      if (container) container.innerHTML = '<p class="text-secondary">Недостаточно данных для графика</p>';
      return;
    }
    container.innerHTML = '<canvas id="nw-chart"></canvas>';
    // Chart would be rendered here with Chart.js
  },

  async saveSnapshot() {
    try {
      await fetch('/api/networth/snapshot', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      alert('Снимок сохранён');
      await Promise.all([this.loadHistory(), this.loadTrend()]);
    } catch (error) {
      alert('Ошибка сохранения');
    }
  },

  showAddAssetModal() {
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';
    document.getElementById('asset-modal-title').textContent = 'Добавить актив';
    document.getElementById('asset-modal').classList.add('active');
  },

  async editAsset(id) {
    const asset = this.assets.find(a => a.id === id);
    if (!asset) return;
    document.getElementById('asset-id').value = asset.id;
    document.getElementById('asset-name').value = asset.name;
    document.getElementById('asset-type').value = asset.type;
    document.getElementById('asset-value').value = asset.value;
    document.getElementById('asset-modal-title').textContent = 'Редактировать актив';
    document.getElementById('asset-modal').classList.add('active');
  },

  async saveAsset() {
    const id = document.getElementById('asset-id').value;
    const data = {
      name: document.getElementById('asset-name').value,
      type: document.getElementById('asset-type').value,
      value: parseFloat(document.getElementById('asset-value').value)
    };
    try {
      const url = id ? `/api/networth/assets/${id}` : '/api/networth/assets';
      const method = id ? 'PUT' : 'POST';
      await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(data) });
      document.getElementById('asset-modal').classList.remove('active');
      await this.loadAssets();
      await this.loadCurrent();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async deleteAsset(id) {
    if (!confirm('Удалить актив?')) return;
    try {
      await fetch(`/api/networth/assets/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      await this.loadAssets();
      await this.loadCurrent();
    } catch (error) {
      alert('Ошибка');
    }
  },

  getPage() {
    return `
      <div class="networth-page">
        <div class="page-header"><h1>💰 Net Worth</h1>
          <button class="btn btn-primary" onclick="NetWorthModule.saveSnapshot()">📷 Сохранить снимок</button>
        </div>
        <div id="networth-summary" class="card networth-summary"></div>
        <div class="grid-2">
          <div id="networth-details"></div>
          <div class="card"><h3>📈 История</h3><div id="networth-trend"></div><div id="networth-chart"></div></div>
        </div>
        <div class="card"><div class="card-header"><h3>🏠 Ручные активы</h3><button class="btn btn-sm" onclick="NetWorthModule.showAddAssetModal()">+ Добавить</button></div><div id="manual-assets"></div></div>
      </div>
      <div class="modal" id="asset-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="asset-modal-title">Добавить актив</h2><button class="modal-close" onclick="document.getElementById('asset-modal').classList.remove('active')">&times;</button></div>
          <form id="asset-form" onsubmit="event.preventDefault(); NetWorthModule.saveAsset()">
            <input type="hidden" id="asset-id">
            <div class="form-group"><label>Название</label><input type="text" id="asset-name" class="form-control" required></div>
            <div class="form-group"><label>Тип</label><select id="asset-type" class="form-control"><option value="real_estate">Недвижимость</option><option value="vehicle">Транспорт</option><option value="crypto">Криптовалюта</option><option value="precious_metals">Драгметаллы</option><option value="collectibles">Коллекции</option><option value="business">Бизнес</option><option value="other">Другое</option></select></div>
            <div class="form-group"><label>Стоимость (₴)</label><input type="number" id="asset-value" class="form-control" step="0.01" required></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('asset-modal').classList.remove('active')">Отмена</button><button type="submit" class="btn btn-primary">Сохранить</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
