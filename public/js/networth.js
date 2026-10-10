// Net Worth Module
// The server converts everything into the user's base currency
// (services/networthService); the UI formats with that base currency and
// shows manual assets in their own currency. Modal uses lib/ui.js convention.
const NetWorthModule = {
  current: null,
  history: [],
  assets: [],
  trend: null,

  headers() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  // Base currency of the current computation (falls back to the user's setting).
  base() {
    return (this.current && this.current.baseCurrency) || UI.baseCurrency();
  },

  fmt(n) {
    return UI.esc(UI.money(n, this.base()));
  },

  async init() {
    await UI.loadBaseCurrency();
    await Promise.all([
      this.loadCurrent(),
      this.loadHistory(),
      this.loadAssets(),
      this.loadTrend(),
    ]);
  },

  async loadCurrent() {
    try {
      const response = await fetch('/api/networth/current', { headers: this.headers() });
      this.current = await response.json();
      this.renderCurrent();
    } catch (error) {
      console.error('Error loading net worth:', error);
    }
  },

  async loadHistory() {
    try {
      const response = await fetch('/api/networth/history?period=year', { headers: this.headers() });
      const data = await response.json();
      this.history = Array.isArray(data) ? data : [];
      this.renderChart();
    } catch (error) {
      console.error('Error loading history:', error);
    }
  },

  async loadTrend() {
    try {
      const response = await fetch('/api/networth/trend?period=year', { headers: this.headers() });
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
      const response = await fetch('/api/networth/assets', { headers: this.headers() });
      const data = await response.json();
      this.assets = Array.isArray(data) ? data : [];
      this.renderAssets();
    } catch (error) {
      console.error('Error loading assets:', error);
    }
  },

  renderCurrent() {
    const container = document.getElementById('networth-summary');
    if (!container || !this.current) return;

    const first = this.history.length > 1 ? this.history[0].net_worth : null;
    const change = first != null ? this.current.netWorth - first : 0;
    const changePercent = first ? (change / Math.abs(first) * 100).toFixed(1) : 0;

    // Предупреждение, если для части валют не нашлось курса (расчёт приблизительный).
    const missing = (this.current.missingRates || []);
    const missingWarning = missing.length
      ? `<div class="networth-warning fm-currency-note" role="note">Нет курса для: ${UI.esc(missing.join(', '))} — эти суммы учтены 1:1, итог приблизительный</div>`
      : '';

    container.innerHTML = `
      <div class="networth-main">
        <div class="networth-value">
          <span class="label">Чистая стоимость (${UI.esc(this.base())})</span>
          <span class="value ${this.current.netWorth >= 0 ? 'positive' : 'negative'}">${this.fmt(this.current.netWorth)}</span>
          ${change !== 0 ? `<span class="change ${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : ''}${this.fmt(change)} (${changePercent}%)</span>` : ''}
          ${missingWarning}
        </div>
      </div>
      <div class="networth-breakdown">
        <div class="breakdown-item positive"><span class="label">Активы</span><span class="value">${this.fmt(this.current.totalAssets)}</span></div>
        <div class="breakdown-item negative"><span class="label">Обязательства</span><span class="value">${this.fmt(this.current.totalLiabilities)}</span></div>
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

    const ch = t.change || { amount: 0, percent: 0 };
    const dir = ch.amount >= 0 ? 'positive' : 'negative';
    const arrow = ch.amount >= 0 ? '▲' : '▼';
    const sign = ch.amount >= 0 ? '+' : '';

    container.innerHTML = `
      <div class="networth-trend-line ${dir}" style="font-size:0.9em;">
        <span>${arrow} ${sign}${this.fmt(ch.amount)}</span>
        <span class="text-secondary"> (${sign}${(ch.percent || 0)}%)</span>
        <span class="text-secondary" style="margin-left:6px;">за ${t.points.length} снимк.</span>
      </div>
    `;
  },

  renderBreakdown() {
    const container = document.getElementById('networth-details');
    if (!container || !this.current) return;

    const ab = this.current.assetsBreakdown || {};
    const row = (label, group) => `<div class="breakdown-row"><span>${label}</span><span>${this.fmt((group && group.total) || 0)}</span></div>`;
    container.innerHTML = `
      <div class="card"><h3>📊 Разбивка активов <small class="text-secondary">(${UI.esc(this.base())})</small></h3>
        <div class="breakdown-list">
          ${row('Счета', ab.accounts)}
          ${row('Инвестиции', ab.investments)}
          ${row('Ручные активы', ab.manualAssets)}
          ${row('Вам должны', ab.receivables)}
        </div>
      </div>
    `;
  },

  renderAssets() {
    const container = document.getElementById('manual-assets');
    if (!container) return;

    const active = this.assets.filter(a => a.is_active !== 0 && a.is_active !== false);
    if (active.length === 0) {
      container.innerHTML = UI.emptyState({
        icon: 'fa-house-chimney',
        title: 'Нет добавленных активов',
        text: 'Недвижимость, транспорт, крипта — всё, чего нет на счетах, учитывается здесь.',
        action: { label: 'Добавить актив', action: 'nw:add-asset', icon: 'fa-plus' }
      });
      return;
    }

    const assetIcons = { real_estate: '🏠', vehicle: '🚗', crypto: '₿', precious_metals: '🥇', collectibles: '🎨', business: '🏢', other: '📦' };

    container.innerHTML = active.map(asset => `
      <div class="asset-item">
        <span class="asset-icon">${assetIcons[asset.type] || '📦'}</span>
        <div class="asset-info"><strong>${UI.esc(asset.name)}</strong><small>${UI.esc(asset.type)}</small></div>
        <span class="asset-value">${UI.esc(UI.money(asset.value, asset.currency))}</span>
        <button type="button" class="btn btn-sm btn-icon" data-action="nw:edit-asset" data-id="${asset.id}" aria-label="Редактировать актив" title="Редактировать">✏️</button>
        <button type="button" class="btn btn-sm btn-icon btn-danger" data-action="nw:delete-asset" data-id="${asset.id}" aria-label="Удалить актив" title="Удалить">🗑</button>
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
      await fetch('/api/networth/snapshot', { method: 'POST', headers: this.headers() });
      alert('Снимок сохранён');
      await Promise.all([this.loadHistory(), this.loadTrend()]);
    } catch (error) {
      alert('Ошибка сохранения');
    }
  },

  fillCurrencySelect(selected) {
    const sel = document.getElementById('asset-currency');
    if (sel) sel.innerHTML = UI.currencyOptions(selected);
  },

  showAddAssetModal() {
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';
    document.getElementById('asset-modal-title').textContent = 'Добавить актив';
    this.fillCurrencySelect(this.base());
    UI.openModal('asset-modal');
  },

  async editAsset(id) {
    const asset = this.assets.find(a => a.id === Number(id));
    if (!asset) return;
    document.getElementById('asset-id').value = asset.id;
    document.getElementById('asset-name').value = asset.name;
    document.getElementById('asset-type').value = asset.type;
    document.getElementById('asset-value').value = asset.value;
    this.fillCurrencySelect(asset.currency || this.base());
    document.getElementById('asset-modal-title').textContent = 'Редактировать актив';
    UI.openModal('asset-modal');
  },

  async saveAsset() {
    const id = document.getElementById('asset-id').value;
    const data = {
      name: document.getElementById('asset-name').value,
      type: document.getElementById('asset-type').value,
      value: parseFloat(document.getElementById('asset-value').value),
      currency: document.getElementById('asset-currency').value
    };
    try {
      const url = id ? `/api/networth/assets/${id}` : '/api/networth/assets';
      const method = id ? 'PUT' : 'POST';
      await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...this.headers() }, body: JSON.stringify(data) });
      UI.closeModal('asset-modal');
      await this.loadAssets();
      await this.loadCurrent();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async deleteAsset(id) {
    if (!confirm('Удалить актив?')) return;
    try {
      await fetch(`/api/networth/assets/${Number(id)}`, { method: 'DELETE', headers: this.headers() });
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
          <button type="button" class="btn btn-primary" data-action="nw:snapshot">📷 Сохранить снимок</button>
        </div>
        <div id="networth-summary" class="card networth-summary"></div>
        <div class="grid-2">
          <div id="networth-details"></div>
          <div class="card"><h3>📈 История</h3><div id="networth-trend"></div><div id="networth-chart"></div></div>
        </div>
        <div class="card"><div class="card-header"><h3>🏠 Ручные активы</h3><button type="button" class="btn btn-sm" data-action="nw:add-asset">+ Добавить</button></div><div id="manual-assets"></div></div>
      </div>
      <div class="modal-backdrop" id="asset-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title" id="asset-modal-title">Добавить актив</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
          <div class="modal-body">
            <form id="asset-form" data-submit="nw:save-asset">
              <input type="hidden" id="asset-id">
              <div class="form-group"><label for="asset-name">Название</label><input type="text" id="asset-name" class="form-control" required></div>
              <div class="form-group"><label for="asset-type">Тип</label><select id="asset-type" class="form-control"><option value="real_estate">Недвижимость</option><option value="vehicle">Транспорт</option><option value="crypto">Криптовалюта</option><option value="precious_metals">Драгметаллы</option><option value="collectibles">Коллекции</option><option value="business">Бизнес</option><option value="other">Другое</option></select></div>
              <div class="form-row">
                <div class="form-group"><label for="asset-value">Стоимость</label><input type="number" id="asset-value" class="form-control" step="0.01" required></div>
                <div class="form-group"><label for="asset-currency">Валюта</label><select id="asset-currency" class="form-control">${UI.currencyOptions()}</select></div>
              </div>
              <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button><button type="submit" class="btn btn-primary">Сохранить</button></div>
            </form>
          </div>
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
    'nw:snapshot': () => NetWorthModule.saveSnapshot(),
    'nw:add-asset': () => NetWorthModule.showAddAssetModal(),
    'nw:edit-asset': (el) => NetWorthModule.editAsset(el.dataset.id),
    'nw:delete-asset': (el) => NetWorthModule.deleteAsset(el.dataset.id),
    'nw:save-asset': () => NetWorthModule.saveAsset(),
  });
})();
