// Subscriptions Module
// Amounts use each subscription's own currency; monthly/yearly totals are
// grouped per currency client-side (the API total adds currencies together).
// Modal follows the shared hidden / is-open convention (lib/ui.js).
const SubscriptionsModule = {
  subscriptions: [],
  stats: null,
  candidates: [],

  headers() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  async init() {
    await UI.loadBaseCurrency();
    await this.loadSubscriptions();
    await this.loadStats();
  },

  async loadSubscriptions() {
    try {
      const response = await fetch('/api/subscriptions', { headers: this.headers() });
      const data = await response.json();
      this.subscriptions = Array.isArray(data) ? data : [];
      this.render();
      this.renderStats();
    } catch (error) {
      console.error('Error loading subscriptions:', error);
    }
  },

  async loadStats() {
    try {
      const response = await fetch('/api/subscriptions/stats', { headers: this.headers() });
      this.stats = await response.json();
      this.renderStats();
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  },

  // Per-currency monthly / yearly totals of ACTIVE subscriptions.
  totals() {
    const active = this.subscriptions.filter(s => s.is_active !== 0 && s.is_active !== false);
    const monthly = UI.sumByCurrency(active, s => Number(s.amount) * UI.monthlyFactor(s.billing_cycle), 'currency');
    const yearly = {};
    Object.keys(monthly).forEach(c => { yearly[c] = Math.round(monthly[c] * 12 * 100) / 100; });
    return { activeCount: active.length, monthly, yearly };
  },

  render() {
    const container = document.getElementById('subscriptions-list');
    if (!container) return;

    const toolbar = `
      <div class="sub-toolbar">
        <button type="button" class="btn btn-secondary" data-action="subs:detect"><i class="fas fa-search"></i> Найти подписки в тратах</button>
      </div>
      <div id="sub-detect-results"></div>`;

    if (this.subscriptions.length === 0) {
      container.innerHTML = toolbar + UI.emptyState({
        icon: 'fa-box-open',
        title: 'Нет активных подписок',
        text: 'Добавьте подписку вручную или найдите регулярные списания в своих транзакциях.',
        action: { label: 'Добавить подписку', action: 'subs:add', icon: 'fa-plus' }
      });
      return;
    }

    container.innerHTML = toolbar + this.subscriptions.map(sub => `
      <div class="card subscription-card" data-id="${sub.id}" style="border-left: 4px solid ${this.safeColor(sub.color)}">
        <div class="subscription-header">
          <div class="subscription-info">
            <span class="subscription-icon">${UI.esc(sub.icon || '📦')}</span>
            <div>
              <h3>${UI.esc(sub.name)}</h3>
              <small>${UI.esc(sub.category || 'Без категории')}</small>
            </div>
          </div>
          <div class="subscription-amount">
            <strong>${UI.esc(UI.money(sub.amount, sub.currency))}</strong>
            <small>/${UI.esc(this.getCycleLabel(sub.billing_cycle))}</small>
          </div>
        </div>
        <div class="subscription-details">
          <span>Следующий платёж: <strong>${UI.esc(sub.next_billing_date || 'Не указан')}</strong></span>
          <span>${sub.daysUntilBilling != null ? (sub.daysUntilBilling <= 0 ? '⚠️ Сегодня/Просрочен' : sub.daysUntilBilling + ' дн.') : ''}</span>
        </div>
        <div class="subscription-actions">
          <button type="button" class="btn btn-sm" data-action="subs:pay" data-id="${sub.id}">✓ Оплачено</button>
          <button type="button" class="btn btn-sm btn-secondary" data-action="subs:edit" data-id="${sub.id}" aria-label="Редактировать" title="Редактировать">✏️</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="subs:cancel" data-id="${sub.id}" aria-label="Отменить подписку" title="Отменить">✕</button>
        </div>
      </div>
    `).join('');
  },

  renderStats() {
    const container = document.getElementById('subscriptions-stats');
    if (!container) return;
    const t = this.totals();
    const count = this.stats && typeof this.stats.activeCount === 'number' ? this.stats.activeCount : t.activeCount;
    container.innerHTML = `
      <div class="stat-card"><div class="stat-value">${count}</div><div class="stat-label">Активных</div></div>
      <div class="stat-card"><div class="stat-value">${UI.moneyList(t.monthly)}</div><div class="stat-label">В месяц</div></div>
      <div class="stat-card"><div class="stat-value">${UI.moneyList(t.yearly)}</div><div class="stat-label">В год</div></div>
    `;
  },

  getCycleLabel(cycle) {
    const labels = { weekly: 'нед', biweekly: '2 нед', monthly: 'мес', quarterly: 'квартал', yearly: 'год' };
    return labels[cycle] || cycle;
  },

  safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#5D5CDE';
  },

  esc(s) { return UI.esc(s); },

  // Найти регулярные списания в транзакциях (кандидаты в подписки).
  async detect() {
    const box = document.getElementById('sub-detect-results');
    if (box) box.innerHTML = '<div class="ai-loading">Ищу регулярные списания…</div>';
    try {
      const response = await fetch('/api/subscriptions/detect', { headers: this.headers() });
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
    const monthly = UI.sumByCurrency(cands, c => Number(c.amount) * UI.monthlyFactor(c.billingCycle), 'currency');
    box.innerHTML = `
      <div class="sub-detect-head">Найдено ${cands.length} — потенциально <strong>${UI.moneyList(monthly)}/мес</strong></div>
      ${cands.map((c, i) => `
        <div class="card sub-candidate">
          <div class="sub-candidate-info">
            <strong>${UI.esc(c.description)}</strong>
            <small>${UI.esc(UI.money(c.amount, c.currency))} · ${UI.esc(this.getCycleLabel(c.billingCycle))} · ${c.occurrences}× · ~${c.avgGapDays} дн</small>
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-action="subs:add-detected" data-index="${i}">+ Добавить</button>
        </div>`).join('')}`;
  },

  async addDetected(index) {
    const c = (this.candidates || [])[index];
    if (!c) return;
    try {
      await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
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

  fillCurrencySelect(selected) {
    const sel = document.getElementById('sub-currency');
    if (sel) sel.innerHTML = UI.currencyOptions(selected);
  },

  showAddModal() {
    document.getElementById('subscription-form').reset();
    document.getElementById('subscription-id').value = '';
    document.getElementById('subscription-modal-title').textContent = 'Новая подписка';
    this.fillCurrencySelect(UI.baseCurrency());
    UI.openModal('subscription-modal');
  },

  async edit(id) {
    const sub = this.subscriptions.find(s => s.id === Number(id));
    if (!sub) return;

    document.getElementById('subscription-id').value = sub.id;
    document.getElementById('sub-name').value = sub.name;
    document.getElementById('sub-amount').value = sub.amount;
    document.getElementById('sub-cycle').value = sub.billing_cycle;
    document.getElementById('sub-category').value = sub.category || '';
    document.getElementById('sub-start-date').value = sub.start_date;
    document.getElementById('sub-color').value = this.safeColor(sub.color);
    this.fillCurrencySelect(sub.currency);
    document.getElementById('subscription-modal-title').textContent = 'Редактировать подписку';
    UI.openModal('subscription-modal');
  },

  async save() {
    const id = document.getElementById('subscription-id').value;
    const data = {
      name: document.getElementById('sub-name').value,
      amount: parseFloat(document.getElementById('sub-amount').value),
      currency: document.getElementById('sub-currency').value,
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
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(data)
      });
      UI.closeModal('subscription-modal');
      await this.loadSubscriptions();
      await this.loadStats();
    } catch (error) {
      alert('Ошибка сохранения');
    }
  },

  async markPaid(id) {
    if (!confirm('Отметить как оплаченную?')) return;
    try {
      await fetch(`/api/subscriptions/${Number(id)}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
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
      await fetch(`/api/subscriptions/${Number(id)}/cancel`, { method: 'POST', headers: this.headers() });
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
          <button type="button" class="btn btn-primary" data-action="subs:add">+ Добавить</button>
        </div>
        <div class="stats-grid" id="subscriptions-stats"></div>
        <div id="subscriptions-list"></div>
      </div>
      <div class="modal-backdrop" id="subscription-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title" id="subscription-modal-title">Новая подписка</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
          <div class="modal-body">
            <form id="subscription-form" data-submit="subs:save">
              <input type="hidden" id="subscription-id">
              <div class="form-group"><label for="sub-name">Название</label><input type="text" id="sub-name" class="form-control" required></div>
              <div class="form-row">
                <div class="form-group"><label for="sub-amount">Сумма</label><input type="number" id="sub-amount" class="form-control" step="0.01" required></div>
                <div class="form-group"><label for="sub-currency">Валюта</label><select id="sub-currency" class="form-control">${UI.currencyOptions()}</select></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label for="sub-cycle">Период</label><select id="sub-cycle" class="form-control"><option value="monthly">Ежемесячно</option><option value="yearly">Ежегодно</option><option value="weekly">Еженедельно</option><option value="quarterly">Ежеквартально</option></select></div>
                <div class="form-group"><label for="sub-start-date">Дата начала</label><input type="date" id="sub-start-date" class="form-control" required></div>
              </div>
              <div class="form-row">
                <div class="form-group"><label for="sub-category">Категория</label><select id="sub-category" class="form-control"><option value="">Выберите...</option><option>Стриминг</option><option>Музыка</option><option>Облако</option><option>Софт</option><option>Игры</option><option>Другое</option></select></div>
                <div class="form-group"><label for="sub-color">Цвет</label><input type="color" id="sub-color" class="form-control" value="#5D5CDE"></div>
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
    'subs:add': () => SubscriptionsModule.showAddModal(),
    'subs:save': () => SubscriptionsModule.save(),
    'subs:edit': (el) => SubscriptionsModule.edit(el.dataset.id),
    'subs:pay': (el) => SubscriptionsModule.markPaid(el.dataset.id),
    'subs:cancel': (el) => SubscriptionsModule.cancel(el.dataset.id),
    'subs:detect': () => SubscriptionsModule.detect(),
    'subs:add-detected': (el) => SubscriptionsModule.addDetected(Number(el.dataset.index)),
  });
})();
