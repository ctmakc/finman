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

    const toolbar = `
      <div class="sub-toolbar">
        <button class="btn btn-secondary" onclick="SubscriptionsModule.detect()">🔍 Найти подписки в тратах</button>
      </div>
      <div id="sub-detect-results"></div>`;

    if (this.subscriptions.length === 0) {
      container.innerHTML = toolbar + `<div class="empty-state"><p>Нет активных подписок</p></div>`;
      return;
    }

    container.innerHTML = toolbar + this.subscriptions.map(sub => `
      <div class="card subscription-card" data-id="${sub.id}" style="border-left: 4px solid ${sub.color || '#5D5CDE'}">
        <div class="subscription-header">
          <div class="subscription-info">
            <span class="subscription-icon">${sub.icon || '📦'}</span>
            <div>
              <h3>${sub.name}</h3>
              <small>${sub.category || 'Без категории'}</small>
            </div>
          </div>
          <div class="subscription-amount">
            <strong>${sub.amount.toLocaleString()} ${sub.currency}</strong>
            <small>/${this.getCycleLabel(sub.billing_cycle)}</small>
          </div>
        </div>
        <div class="subscription-details">
          <span>Следующий платёж: <strong>${sub.next_billing_date || 'Не указан'}</strong></span>
          <span>${sub.daysUntilBilling !== null ? (sub.daysUntilBilling <= 0 ? '⚠️ Сегодня/Просрочен' : sub.daysUntilBilling + ' дн.') : ''}</span>
        </div>
        <div class="subscription-actions">
          <button class="btn btn-sm" onclick="SubscriptionsModule.markPaid(${sub.id})">✓ Оплачено</button>
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
      <div class="stat-card"><div class="stat-value">${this.stats.activeCount}</div><div class="stat-label">Активных</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.monthlyTotal.toLocaleString()} ₴</div><div class="stat-label">В месяц</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.yearlyTotal.toLocaleString()} ₴</div><div class="stat-label">В год</div></div>
    `;
  },

  getCycleLabel(cycle) {
    const labels = { weekly: 'нед', biweekly: '2 нед', monthly: 'мес', quarterly: 'квартал', yearly: 'год' };
    return labels[cycle] || cycle;
  },

  esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  },

  // Найти регулярные списания в транзакциях (кандидаты в подписки).
  async detect() {
    const box = document.getElementById('sub-detect-results');
    if (box) box.innerHTML = '<div class="ai-loading">Ищу регулярные списания…</div>';
    try {
      const response = await fetch('/api/subscriptions/detect', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      this.candidates = data.candidates || [];
      this.renderCandidates(data);
    } catch (error) {
      if (box) box.innerHTML = '<div class="ai-error">Не удалось проанализировать траты</div>';
    }
  },

  renderCandidates(data) {
    const box = document.getElementById('sub-detect-results');
    if (!box) return;
    const cands = (data && data.candidates) || [];
    if (!cands.length) {
      box.innerHTML = '<div class="empty-state"><p>Регулярных списаний не найдено 👍</p></div>';
      return;
    }
    box.innerHTML = `
      <div class="sub-detect-head">Найдено ${cands.length} — потенциально <strong>${(data.monthlyTotal || 0).toLocaleString()} ₴/мес</strong></div>
      ${cands.map((c, i) => `
        <div class="card sub-candidate">
          <div class="sub-candidate-info">
            <strong>${this.esc(c.description)}</strong>
            <small>${c.amount.toLocaleString()} ₴ · ${this.getCycleLabel(c.billingCycle)} · ${c.occurrences}× · ~${c.avgGapDays} дн</small>
          </div>
          <button class="btn btn-sm btn-primary" onclick="SubscriptionsModule.addDetected(${i})">+ Добавить</button>
        </div>`).join('')}`;
  },

  async addDetected(index) {
    const c = (this.candidates || [])[index];
    if (!c) return;
    try {
      await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({
          name: c.description,
          amount: c.amount,
          currency: c.currency,
          billing_cycle: c.billingCycle,
          category: c.category,
          start_date: c.lastDate,
        }),
      });
      await this.loadSubscriptions();
      await this.loadStats();
      await this.detect();
    } catch (error) {
      alert('Ошибка добавления подписки');
    }
  },

  showAddModal() {
    const modal = document.getElementById('subscription-modal');
    document.getElementById('subscription-form').reset();
    document.getElementById('subscription-id').value = '';
    document.getElementById('subscription-modal-title').textContent = 'Новая подписка';
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
    document.getElementById('subscription-modal-title').textContent = 'Редактировать подписку';
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
      alert('Ошибка сохранения');
    }
  },

  async markPaid(id) {
    if (!confirm('Отметить как оплаченную?')) return;
    try {
      await fetch(`/api/subscriptions/${id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ create_transaction: true })
      });
      await this.loadSubscriptions();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async cancel(id) {
    if (!confirm('Отменить подписку?')) return;
    try {
      await fetch(`/api/subscriptions/${id}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      await this.loadSubscriptions();
      await this.loadStats();
    } catch (error) {
      alert('Ошибка');
    }
  },

  getPage() {
    return `
      <div class="subscriptions-page">
        <div class="page-header">
          <h1>📦 Подписки</h1>
          <button class="btn btn-primary" onclick="SubscriptionsModule.showAddModal()">+ Добавить</button>
        </div>
        <div class="stats-grid" id="subscriptions-stats"></div>
        <div id="subscriptions-list"></div>
      </div>
      <div class="modal" id="subscription-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="subscription-modal-title">Новая подписка</h2><button class="modal-close" onclick="document.getElementById('subscription-modal').classList.remove('active')">&times;</button></div>
          <form id="subscription-form" onsubmit="event.preventDefault(); SubscriptionsModule.save()">
            <input type="hidden" id="subscription-id">
            <div class="form-group"><label>Название</label><input type="text" id="sub-name" class="form-control" required></div>
            <div class="form-row">
              <div class="form-group"><label>Сумма</label><input type="number" id="sub-amount" class="form-control" step="0.01" required></div>
              <div class="form-group"><label>Период</label><select id="sub-cycle" class="form-control"><option value="monthly">Ежемесячно</option><option value="yearly">Ежегодно</option><option value="weekly">Еженедельно</option><option value="quarterly">Ежеквартально</option></select></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Категория</label><select id="sub-category" class="form-control"><option value="">Выберите...</option><option>Стриминг</option><option>Музыка</option><option>Облако</option><option>Софт</option><option>Игры</option><option>Другое</option></select></div>
              <div class="form-group"><label>Дата начала</label><input type="date" id="sub-start-date" class="form-control" required></div>
            </div>
            <div class="form-group"><label>Цвет</label><input type="color" id="sub-color" class="form-control" value="#5D5CDE"></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('subscription-modal').classList.remove('active')">Отмена</button><button type="submit" class="btn btn-primary">Сохранить</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
