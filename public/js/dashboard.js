// Smart Dashboard Module
const SmartDashboard = {
  widgets: [],
  availableWidgets: [],
  editMode: false,

  async init() {
    await Promise.all([this.loadWidgets(), this.loadAvailable()]);
  },

  async loadWidgets() {
    try {
      const response = await fetch('/api/widgets', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.widgets = await response.json();
      this.render();
    } catch (error) {
      console.error('Error loading widgets:', error);
    }
  },

  async loadAvailable() {
    try {
      const response = await fetch('/api/widgets/available', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.availableWidgets = await response.json();
    } catch (error) {
      console.error('Error loading available widgets:', error);
    }
  },

  render() {
    const container = document.getElementById('dashboard-widgets');
    if (!container) return;

    const visibleWidgets = this.widgets.filter(w => w.is_visible);

    if (visibleWidgets.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>Нет виджетов. Нажмите "Настроить" чтобы добавить.</p></div>';
      return;
    }

    container.innerHTML = visibleWidgets.map(widget => this.renderWidget(widget)).join('');

    // Загружаем данные для каждого виджета
    visibleWidgets.forEach(w => this.loadWidgetData(w));
  },

  renderWidget(widget) {
    const sizeClass = widget.size === 'small' ? 'widget-sm' : widget.size === 'large' ? 'widget-lg' : 'widget-md';

    return ` + "`" + `
      <div class="dashboard-widget ${sizeClass}" data-id="${widget.id}" data-type="${widget.widget_type}">
        <div class="widget-header">
          <h3>${widget.title}</h3>
          ${this.editMode ? ` + "`" + `<div class="widget-actions">
            <button class="btn btn-sm btn-icon" onclick="SmartDashboard.moveWidget(${widget.id}, -1)">↑</button>
            <button class="btn btn-sm btn-icon" onclick="SmartDashboard.moveWidget(${widget.id}, 1)">↓</button>
            <button class="btn btn-sm btn-icon btn-danger" onclick="SmartDashboard.removeWidget(${widget.id})">✕</button>
          </div>` + "`" + ` : ''}
        </div>
        <div class="widget-content" id="widget-content-${widget.id}">
          <div class="widget-loading"><div class="spinner"></div></div>
        </div>
      </div>
    ` + "`" + `;
  },

  async loadWidgetData(widget) {
    const container = document.getElementById(`widget-content-${widget.id}`);
    if (!container) return;

    try {
      const response = await fetch(`/api/widgets/${widget.widget_type}/data`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      container.innerHTML = this.renderWidgetContent(widget.widget_type, data);
    } catch (error) {
      container.innerHTML = '<p class="text-secondary">Ошибка загрузки</p>';
    }
  },

  renderWidgetContent(type, data) {
    switch (type) {
      case 'balance':
        return ` + "`" + `<div class="widget-value">${(data.total || 0).toLocaleString()} ₴</div>` + "`" + `;

      case 'networth':
        return ` + "`" + `
          <div class="widget-value ${data.netWorth >= 0 ? 'positive' : 'negative'}">${data.netWorth.toLocaleString()} ₴</div>
          <div class="widget-subtitle">Активы: ${data.assets.toLocaleString()} ₴ | Долги: ${data.liabilities.toLocaleString()} ₴</div>
        ` + "`" + `;

      case 'expenses':
        return ` + "`" + `<div class="widget-value negative">${(data.total || 0).toLocaleString()} ₴</div><div class="widget-subtitle">за ${data.period === 'month' ? 'месяц' : 'год'}</div>` + "`" + `;

      case 'income':
        return ` + "`" + `<div class="widget-value positive">${(data.total || 0).toLocaleString()} ₴</div><div class="widget-subtitle">за ${data.period === 'month' ? 'месяц' : 'год'}</div>` + "`" + `;

      case 'budget':
        if (!data.budgets || data.budgets.length === 0) return '<p class="text-secondary">Нет бюджетов</p>';
        return data.budgets.slice(0, 3).map(b => ` + "`" + `
          <div class="mini-budget">
            <div class="mini-budget-header"><span>${b.category}</span><span>${b.spent || 0}/${b.amount}</span></div>
            <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, ((b.spent || 0) / b.amount) * 100)}%"></div></div>
          </div>
        ` + "`" + `).join('');

      case 'goals':
        if (!data.goals || data.goals.length === 0) return '<p class="text-secondary">Нет целей</p>';
        return data.goals.slice(0, 3).map(g => ` + "`" + `
          <div class="mini-goal">
            <span>${g.name}</span>
            <div class="progress-bar"><div class="progress-fill progress-ok" style="width:${g.progress}%"></div></div>
            <span>${Math.round(g.progress)}%</span>
          </div>
        ` + "`" + `).join('');

      case 'upcoming':
        if (!data.items || data.items.length === 0) return '<p class="text-secondary">Нет предстоящих платежей</p>';
        return ` + "`" + `<div class="mini-list">${data.items.slice(0, 5).map(i => ` + "`" + `
          <div class="mini-item"><span>${i.title}</span><span>${i.amount.toLocaleString()} ₴</span><small>${i.date}</small></div>
        ` + "`" + `).join('')}</div>` + "`" + `;

      case 'subscriptions':
        return ` + "`" + `<div class="widget-value">${data.monthlyTotal.toLocaleString()} ₴/мес</div><div class="widget-subtitle">${data.subscriptions.length} подписок</div>` + "`" + `;

      case 'investments':
        return ` + "`" + `<div class="widget-value">${data.totalValue.toLocaleString()} ₴</div><div class="widget-subtitle">${data.portfolioCount} портфелей</div>` + "`" + `;

      case 'debts':
        return ` + "`" + `<div class="widget-value negative">${data.totalOwed.toLocaleString()} ₴</div><div class="widget-subtitle">${data.debts.length} долгов</div>` + "`" + `;

      case 'recent':
        if (!data.transactions || data.transactions.length === 0) return '<p class="text-secondary">Нет транзакций</p>';
        return ` + "`" + `<div class="mini-list">${data.transactions.slice(0, 5).map(t => ` + "`" + `
          <div class="mini-item">
            <span>${t.description || t.category}</span>
            <span class="${t.type === 'income' ? 'positive' : 'negative'}">${t.type === 'income' ? '+' : '-'}${t.amount.toLocaleString()}</span>
          </div>
        ` + "`" + `).join('')}</div>` + "`" + `;

      case 'quick_add':
        return ` + "`" + `
          <button class="btn btn-success btn-block" onclick="showAddTransactionModal('income')">+ Доход</button>
          <button class="btn btn-danger btn-block" onclick="showAddTransactionModal('expense')">- Расход</button>
        ` + "`" + `;

      default:
        return '<p class="text-secondary">Виджет недоступен</p>';
    }
  },

  toggleEditMode() {
    this.editMode = !this.editMode;
    document.getElementById('edit-mode-btn').textContent = this.editMode ? '✓ Готово' : '⚙️ Настроить';
    this.render();
  },

  showAddWidgetModal() {
    const used = this.widgets.map(w => w.widget_type);
    const available = this.availableWidgets.filter(w => !used.includes(w.type));

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = ` + "`" + `
      <div class="modal">
        <div class="modal-header">
          <h2>Добавить виджет</h2>
          <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button>
        </div>
        <div class="modal-body">
          ${available.length === 0 ? '<p>Все виджеты уже добавлены</p>' : ` + "`" + `
            <div class="widget-picker">
              ${available.map(w => ` + "`" + `
                <div class="widget-option" onclick="SmartDashboard.addWidget('${w.type}', '${w.name}')">
                  <strong>${w.name}</strong>
                  <small>${w.description}</small>
                </div>
              ` + "`" + `).join('')}
            </div>
          ` + "`" + `}
        </div>
      </div>
    ` + "`" + `;
    document.body.appendChild(modal);
  },

  async addWidget(type, title) {
    try {
      await fetch('/api/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ widget_type: type, title, size: 'medium' })
      });
      document.querySelector('.modal-backdrop')?.remove();
      await this.loadWidgets();
    } catch (error) {
      alert('Ошибка добавления');
    }
  },

  async removeWidget(id) {
    if (!confirm('Удалить виджет?')) return;
    try {
      await fetch(`/api/widgets/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      await this.loadWidgets();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async moveWidget(id, direction) {
    const idx = this.widgets.findIndex(w => w.id === id);
    if (idx === -1) return;

    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= this.widgets.length) return;

    // Swap positions
    const order = this.widgets.map((w, i) => ({ id: w.id, position: i }));
    [order[idx].position, order[newIdx].position] = [order[newIdx].position, order[idx].position];

    try {
      await fetch('/api/widgets/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ order })
      });
      await this.loadWidgets();
    } catch (error) {
      console.error('Error reordering:', error);
    }
  },

  getPage() {
    return ` + "`" + `
      <div class="smart-dashboard">
        <div class="page-header">
          <h1>📊 Дашборд</h1>
          <div class="btn-group">
            <button class="btn" id="edit-mode-btn" onclick="SmartDashboard.toggleEditMode()">⚙️ Настроить</button>
            <button class="btn btn-primary" onclick="SmartDashboard.showAddWidgetModal()">+ Виджет</button>
          </div>
        </div>
        <div class="dashboard-grid" id="dashboard-widgets"></div>
      </div>
    ` + "`" + `;
  }
};

// Override default dashboard render
function renderSmartDashboard() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = SmartDashboard.getPage();
  SmartDashboard.init();
}
