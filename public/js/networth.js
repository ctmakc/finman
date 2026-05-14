// Net Worth Module
const NetWorthModule = {
  current: null,
  history: [],
  assets: [],

  async init() {
    await Promise.all([this.loadCurrent(), this.loadHistory(), this.loadAssets()]);
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

    const change = this.history.length > 1 ? this.current.netWorth - this.history[0].net_worth : 0;
    const changePercent = this.history.length > 1 && this.history[0].net_worth ? (change / Math.abs(this.history[0].net_worth) * 100).toFixed(1) : 0;

    container.innerHTML = `
      <div class="networth-main">
        <div class="networth-value">
          <span class="label">Net Worth</span>
          <span class="value ${this.current.netWorth >= 0 ? 'positive' : 'negative'}">${this.current.netWorth.toLocaleString()} $</span>
          ${change !== 0 ? `<span class="change ${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : ''}${change.toLocaleString()} $ (${changePercent}%)</span>` : ''}
        </div>
      </div>
      <div class="networth-breakdown">
        <div class="breakdown-item positive"><span class="label">Assets</span><span class="value">${this.current.totalAssets.toLocaleString()} $</span></div>
        <div class="breakdown-item negative"><span class="label">Liabilities</span><span class="value">${this.current.totalLiabilities.toLocaleString()} $</span></div>
      </div>
    `;

    this.renderBreakdown();
  },

  renderBreakdown() {
    const container = document.getElementById('networth-details');
    if (!container || !this.current) return;

    const ab = this.current.assetsBreakdown;
    container.innerHTML = `
      <div class="card"><h3>📊 Asset breakdown</h3>
        <div class="breakdown-list">
          <div class="breakdown-row"><span>Accounts</span><span>${(ab.accounts?.total || 0).toLocaleString()} $</span></div>
          <div class="breakdown-row"><span>Investments</span><span>${(ab.investments?.total || 0).toLocaleString()} $</span></div>
          <div class="breakdown-row"><span>Manual assets</span><span>${(ab.manualAssets?.total || 0).toLocaleString()} $</span></div>
          <div class="breakdown-row"><span>Receivables</span><span>${(ab.receivables?.total || 0).toLocaleString()} $</span></div>
        </div>
      </div>
    `;
  },

  renderAssets() {
    const container = document.getElementById('manual-assets');
    if (!container) return;

    if (this.assets.length === 0) {
      container.innerHTML = '<p class="text-secondary">No assets added</p>';
      return;
    }

    const assetIcons = { real_estate: '🏠', vehicle: '🚗', crypto: '₿', precious_metals: '🥇', collectibles: '🎨', business: '🏢', other: '📦' };

    container.innerHTML = this.assets.filter(a => a.is_active).map(asset => `
      <div class="asset-item">
        <span class="asset-icon">${assetIcons[asset.type] || '📦'}</span>
        <div class="asset-info"><strong>${esc(asset.name)}</strong><small>${asset.type}</small></div>
        <span class="asset-value">${asset.value.toLocaleString()} ${esc(asset.currency || '')}</span>
        <button class="btn btn-sm btn-icon" onclick="NetWorthModule.editAsset(${asset.id})">✏️</button>
        <button class="btn btn-sm btn-icon btn-danger" onclick="NetWorthModule.deleteAsset(${asset.id})">🗑</button>
      </div>
    `).join('');
  },

  renderChart() {
    const container = document.getElementById('networth-chart');
    if (!container) return;
    if (this.history.length < 2) {
      container.innerHTML = '<p class="text-secondary" style="padding:12px">Add snapshots over time to see your net worth trend.</p>';
      return;
    }
    container.innerHTML = '<div style="position:relative;height:200px"><canvas id="nw-chart"></canvas></div>';
    const ctx = document.getElementById('nw-chart');
    if (window._nwChart) window._nwChart.destroy();
    const sorted = [...this.history].sort((a, b) => a.snapshot_date > b.snapshot_date ? 1 : -1);
    window._nwChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: sorted.map(s => s.snapshot_date ? s.snapshot_date.slice(0, 7) : ''),
        datasets: [
          { label: 'Net Worth', data: sorted.map(s => s.net_worth || 0),
            borderColor: '#5D5CDE', backgroundColor: 'rgba(93,92,222,0.1)', fill: true, tension: 0.3, pointRadius: 4 },
          { label: 'Assets', data: sorted.map(s => s.total_assets || 0),
            borderColor: '#38C172', backgroundColor: 'transparent', borderDash: [4,4], tension: 0.3, pointRadius: 2 },
          { label: 'Liabilities', data: sorted.map(s => s.total_liabilities || 0),
            borderColor: '#E3342F', backgroundColor: 'transparent', borderDash: [4,4], tension: 0.3, pointRadius: 2 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: c => c.dataset.label + ': $' + c.parsed.y.toLocaleString() } } },
        scales: { y: { ticks: { callback: v => '$' + v.toLocaleString() } } }
      }
    });
  },

  async saveSnapshot() {
    try {
      await fetch('/api/networth/snapshot', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      showNotification('Snapshot saved', 'success');
      await this.loadHistory();
    } catch (error) {
      showNotification('Failed to save snapshot', 'error');
    }
  },

  showAddAssetModal() {
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';
    document.getElementById('asset-modal-title').textContent = 'Add asset';
    document.getElementById('asset-modal').classList.add('active');
  },

  async editAsset(id) {
    const asset = this.assets.find(a => a.id === id);
    if (!asset) return;
    document.getElementById('asset-id').value = asset.id;
    document.getElementById('asset-name').value = asset.name;
    document.getElementById('asset-type').value = asset.type;
    document.getElementById('asset-value').value = asset.value;
    document.getElementById('asset-modal-title').textContent = 'Edit asset';
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
      showNotification('Failed to save asset', 'error');
    }
  },

  deleteAsset(id) {
    showConfirm('Delete this asset?', async () => {
      try {
        await fetch(`/api/networth/assets/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
        await NetWorthModule.loadAssets();
        await NetWorthModule.loadCurrent();
      } catch (error) {
        showNotification('Failed to delete asset', 'error');
      }
    });
  },

  getPage() {
    return `
      <div class="networth-page">
        <div class="page-header"><h1>💰 Net Worth</h1>
          <button class="btn btn-primary" onclick="NetWorthModule.saveSnapshot()">📷 Save snapshot</button>
        </div>
        <div id="networth-summary" class="card networth-summary"></div>
        <div class="grid-2">
          <div id="networth-details"></div>
          <div class="card"><h3><i class="fas fa-chart-line"></i> History</h3><div id="networth-chart"></div></div>
        </div>
        <div class="card"><div class="card-header"><h3>🏠 Manual assets</h3><button class="btn btn-sm" onclick="NetWorthModule.showAddAssetModal()">+ Add</button></div><div id="manual-assets"></div></div>
      </div>
      <div class="modal" id="asset-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="asset-modal-title">Add asset</h2><button class="modal-close" onclick="document.getElementById('asset-modal').classList.remove('active')">&times;</button></div>
          <form id="asset-form" onsubmit="event.preventDefault(); NetWorthModule.saveAsset()">
            <input type="hidden" id="asset-id">
            <div class="form-group"><label>Name</label><input type="text" id="asset-name" class="form-control" required></div>
            <div class="form-group"><label>Type</label><select id="asset-type" class="form-control"><option value="real_estate">Real estate</option><option value="vehicle">Vehicle</option><option value="crypto">Cryptocurrency</option><option value="precious_metals">Precious metals</option><option value="collectibles">Collectibles</option><option value="business">Business</option><option value="other">Other</option></select></div>
            <div class="form-group"><label>Value ($)</label><input type="number" id="asset-value" class="form-control" step="0.01" required></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('asset-modal').classList.remove('active')">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
