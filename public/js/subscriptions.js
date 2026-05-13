// Subscriptions Module
const SubscriptionsModule = {
  subscriptions: [],
  stats: null,

  async init() {
    await this.loadSubscriptions();
    await this.loadStats();
  },

  async loadSubscriptions() {
    try {
      const response = await fetch('/api/subscriptions', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.subscriptions = await response.json();
      this.render();
    } catch (error) {
      console.error('Error loading subscriptions:', error);
    }
  },

  async loadStats() {
    try {
      const response = await fetch('/api/subscriptions/stats', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.stats = await response.json();
      this.renderStats();
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  },

  render() {
    const container = document.getElementById('subscriptions-list');
    if (!container) return;

    if (this.subscriptions.length === 0) {
      container.innerHTML = `<div class="empty-state"><p>No active subscriptions</p></div>`;
      return;
    }

    container.innerHTML = this.subscriptions.map(sub => `
      <div class="card subscription-card" data-id="${sub.id}" style="border-left: 4px solid ${sub.color || '#5D5CDE'}">
        <div class="subscription-header">
          <div class="subscription-info">
            <span class="subscription-icon">${sub.icon || '📦'}</span>
            <div>
              <h3>${sub.name}</h3>
              <small>${sub.category || 'Uncategorized'}</small>
            </div>
          </div>
          <div class="subscription-amount">
            <strong>${sub.amount.toLocaleString()} ${sub.currency}</strong>
            <small>/${this.getCycleLabel(sub.billing_cycle)}</small>
          </div>
        </div>
        <div class="subscription-details">
          <span>Next payment: <strong>${sub.next_billing_date || 'Not set'}</strong></span>
          <span>${sub.daysUntilBilling !== null ? (sub.daysUntilBilling <= 0 ? '⚠️ Today/Overdue' : sub.daysUntilBilling + ' days') : ''}</span>
        </div>
        <div class="subscription-actions">
          ${sub.is_active ? `<button class="btn btn-sm" onclick="SubscriptionsModule.markPaid(${sub.id})">✓ Mark paid</button>` : '<span class="badge badge-warning" style="font-size:11px">Paused</span>'}
          <button class="btn btn-sm btn-outline" onclick="SubscriptionsModule.toggle(${sub.id})" title="${sub.is_active ? 'Pause' : 'Resume'}">${sub.is_active ? '⏸' : '▶'}</button>
          <button class="btn btn-sm btn-secondary" onclick="SubscriptionsModule.edit(${sub.id})">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="SubscriptionsModule.cancel(${sub.id})">✕</button>
        </div>
      </div>
    `).join('');
  },

  renderStats() {
    const container = document.getElementById('subscriptions-stats');
    if (!container || !this.stats) return;

    container.innerHTML = `
      <div class="stat-card"><div class="stat-value">${this.stats.activeCount}</div><div class="stat-label">Active</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.monthlyTotal.toLocaleString()} $</div><div class="stat-label">Per month</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.yearlyTotal.toLocaleString()} $</div><div class="stat-label">Per year</div></div>
    `;
  },

  getCycleLabel(cycle) {
    const labels = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', yearly: 'year' };
    return labels[cycle] || cycle;
  },

  showAddModal() {
    const modal = document.getElementById('subscription-modal');
    document.getElementById('subscription-form').reset();
    document.getElementById('subscription-id').value = '';
    document.getElementById('subscription-modal-title').textContent = 'New subscription';
    modal.classList.add('active');
  },

  async edit(id) {
    const sub = this.subscriptions.find(s => s.id === id);
    if (!sub) return;

    document.getElementById('subscription-id').value = sub.id;
    document.getElementById('sub-name').value = sub.name;
    document.getElementById('sub-amount').value = sub.amount;
    document.getElementById('sub-cycle').value = sub.billing_cycle;
    document.getElementById('sub-category').value = sub.category || '';
    document.getElementById('sub-start-date').value = sub.start_date;
    document.getElementById('sub-color').value = sub.color || '#5D5CDE';
    document.getElementById('subscription-modal-title').textContent = 'Edit subscription';
    document.getElementById('subscription-modal').classList.add('active');
  },

  async save() {
    const id = document.getElementById('subscription-id').value;
    const data = {
      name: document.getElementById('sub-name').value,
      amount: parseFloat(document.getElementById('sub-amount').value),
      billing_cycle: document.getElementById('sub-cycle').value,
      category: document.getElementById('sub-category').value,
      start_date: document.getElementById('sub-start-date').value,
      color: document.getElementById('sub-color').value
    };

    try {
      const url = id ? `/api/subscriptions/${id}` : '/api/subscriptions';
      const method = id ? 'PUT' : 'POST';
      await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify(data)
      });
      document.getElementById('subscription-modal').classList.remove('active');
      await this.loadSubscriptions();
      await this.loadStats();
    } catch (error) {
      showNotification('Failed to save subscription', 'error');
    }
  },

  async markPaid(id) {
    try {
      await fetch(`/api/subscriptions/${id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ create_transaction: true })
      });
      await this.loadSubscriptions();
    } catch (error) {
      showNotification('Failed to mark as paid', 'error');
    }
  },

  async toggle(id) {
    try {
      await fetch(`/api/subscriptions/${id}/toggle`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      await SubscriptionsModule.loadSubscriptions();
      await SubscriptionsModule.loadStats();
    } catch (error) {
      showNotification('Failed to toggle subscription', 'error');
    }
  },

  cancel(id) {
    showConfirm('Cancel this subscription?', async () => {
      try {
        await fetch(`/api/subscriptions/${id}/cancel`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        await SubscriptionsModule.loadSubscriptions();
        await SubscriptionsModule.loadStats();
      } catch (error) {
        showNotification('Failed to cancel subscription', 'error');
      }
    }, { danger: false, confirmLabel: 'Cancel subscription', title: 'Cancel subscription' });
  },

  getPage() {
    return `
      <div class="subscriptions-page">
        <div class="page-header">
          <h1>📦 Subscriptions</h1>
          <button class="btn btn-primary" onclick="SubscriptionsModule.showAddModal()">+ Add</button>
        </div>
        <div class="stats-grid" id="subscriptions-stats"></div>
        <div id="subscriptions-list"></div>
      </div>
      <div class="modal" id="subscription-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="subscription-modal-title">New subscription</h2><button class="modal-close" onclick="document.getElementById('subscription-modal').classList.remove('active')">&times;</button></div>
          <form id="subscription-form" onsubmit="event.preventDefault(); SubscriptionsModule.save()">
            <input type="hidden" id="subscription-id">
            <div class="form-group"><label>Name</label><input type="text" id="sub-name" class="form-control" required></div>
            <div class="form-row">
              <div class="form-group"><label>Amount</label><input type="number" id="sub-amount" class="form-control" step="0.01" required></div>
              <div class="form-group"><label>Period</label><select id="sub-cycle" class="form-control"><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="weekly">Weekly</option><option value="quarterly">Quarterly</option></select></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Category</label><select id="sub-category" class="form-control"><option value="">Select...</option><option>Streaming</option><option>Music</option><option>Cloud</option><option>Software</option><option>Gaming</option><option>Other</option></select></div>
              <div class="form-group"><label>Date start</label><input type="date" id="sub-start-date" class="form-control" required></div>
            </div>
            <div class="form-group"><label>Color</label><input type="color" id="sub-color" class="form-control" value="#5D5CDE"></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('subscription-modal').classList.remove('active')">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
