// Smart Dashboard Module (Wave-2)
// Делегирует рендер/DnD/HTTP в DashboardWidgets (public/js/widgets.js),
// который ДОЛЖЕН подключаться <script>-тегом ПЕРЕД этим файлом.
// При отсутствии DashboardWidgets модуль деградирует мягко (но без DnD).

const SmartDashboard = {
  widgets: [],
  availableWidgets: [],
  editMode: false,
  period: 'month',

  // короткий алиас на хелперы виджетов (может отсутствовать в legacy-окружении)
  get W() {
    return (typeof window !== 'undefined' && window.DashboardWidgets) || null;
  },

  async init() {
    await Promise.all([this.loadWidgets(), this.loadAvailable()]);
    // Гидратируем signature-hero из тех же widget-данных (single source of truth).
    this.hydrateHero();
  },

  // Форматирование суммы в гривне с табличными цифрами.
  fmtMoney(value) {
    const n = Number(value) || 0;
    try {
      return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(n));
    } catch (e) {
      return String(Math.round(n));
    }
  },

  // Плавный count-up чистого капитала (restrained; уважает reduced-motion).
  animateHeroNetWorth(target) {
    const el = document.getElementById('hero-networth');
    if (!el) return;
    const amountEl = el.querySelector('.fm-hero-amount') || el;
    el.setAttribute('data-countup', String(target));
    const reduce = typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !target) {
      amountEl.textContent = this.fmtMoney(target);
      return;
    }
    const duration = 900;
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const self = this;
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      amountEl.textContent = self.fmtMoney(target * ease(t));
      if (t < 1) requestAnimationFrame(step);
      else amountEl.textContent = self.fmtMoney(target);
    }
    requestAnimationFrame(step);
  },

  // Наполняет hero числами из balance/cashflow виджетов + вешает AI-кнопку.
  // Полностью аддитивно: при отсутствии данных hero остаётся на плейсхолдерах.
  async hydrateHero() {
    const heroBtn = document.getElementById('hero-ai-more');
    if (heroBtn && !heroBtn.dataset.bound) {
      heroBtn.dataset.bound = '1';
      heroBtn.addEventListener('click', () => {
        if (typeof window !== 'undefined' && window.AIAssistant &&
            typeof window.AIAssistant.open === 'function') {
          window.AIAssistant.open();
        } else if (typeof window !== 'undefined' && typeof window.toggleAIPanel === 'function') {
          window.toggleAIPanel();
        }
      });
    }

    const fetchData = (type) => {
      if (this.W && typeof this.W.fetchWidgetData === 'function') {
        return this.W.fetchWidgetData(type, this.period);
      }
      return fetch(`/api/widgets/${type}/data`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      }).then((r) => r.json());
    };

    try {
      const [balance, cashflow] = await Promise.all([
        fetchData('balance').catch(() => null),
        fetchData('cashflow').catch(() => null)
      ]);

      if (balance && typeof balance.total !== 'undefined') {
        this.animateHeroNetWorth(Number(balance.total) || 0);
      }

      if (cashflow) {
        const inEl = document.getElementById('hero-cashflow-in');
        const outEl = document.getElementById('hero-cashflow-out');
        if (inEl && typeof cashflow.income !== 'undefined') {
          inEl.textContent = '₴' + this.fmtMoney(cashflow.income);
        }
        if (outEl && typeof cashflow.expense !== 'undefined') {
          outEl.textContent = '₴' + this.fmtMoney(cashflow.expense);
        }
        const insightEl = document.getElementById('hero-insight-text');
        if (insightEl) {
          const net = (Number(cashflow.income) || 0) - (Number(cashflow.expense) || 0);
          insightEl.textContent = net >= 0
            ? 'Цього місяця ви витрачаєте менше, ніж заробляєте — капітал зростає. Так тримати.'
            : 'Витрати цього місяця перевищили доходи. Загляньте в категорії, щоб повернути баланс.';
        }
      }
    } catch (error) {
      console.error('Error hydrating hero:', error);
    }
  },

  async loadWidgets() {
    try {
      if (this.W) {
        this.widgets = await this.W.fetchWidgets();
      } else {
        const response = await fetch('/api/widgets', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        this.widgets = await response.json();
      }
      if (!Array.isArray(this.widgets)) this.widgets = [];
      this.render();
    } catch (error) {
      console.error('Error loading widgets:', error);
    }
  },

  async loadAvailable() {
    try {
      const response = await fetch('/api/widgets/available', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      this.availableWidgets = await response.json();
    } catch (error) {
      console.error('Error loading available widgets:', error);
    }
  },

  render() {
    const container = document.getElementById('dashboard-widgets');
    if (!container) return;

    const visibleWidgets = this.widgets.filter((w) => w.is_visible);

    if (visibleWidgets.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><p>Нет виджетов. Нажмите "Настроить" чтобы добавить.</p></div>';
      return;
    }

    if (this.W) {
      container.innerHTML = visibleWidgets
        .map((w) => this.W.renderWidget(w, { editMode: this.editMode }))
        .join('');
      // Включаем drag-to-reorder только в режиме редактирования.
      if (this.editMode) {
        this.W.enableDragReorder(container, (orderedIds) => this.persistOrder(orderedIds));
      }
    } else {
      container.innerHTML = visibleWidgets.map((w) => this.renderWidgetFallback(w)).join('');
    }

    visibleWidgets.forEach((w) => this.loadWidgetData(w));
  },

  // Фолбэк-рендер каркаса (если widgets.js не загрузился).
  renderWidgetFallback(widget) {
    const sizeClass =
      widget.size === 'small' ? 'widget-sm' : widget.size === 'large' ? 'widget-lg' : 'widget-md';
    const actions = this.editMode
      ? `<div class="widget-actions">
          <button class="btn btn-sm btn-icon" onclick="SmartDashboard.moveWidget(${widget.id}, -1)">↑</button>
          <button class="btn btn-sm btn-icon" onclick="SmartDashboard.moveWidget(${widget.id}, 1)">↓</button>
          <button class="btn btn-sm btn-icon btn-danger" onclick="SmartDashboard.removeWidget(${widget.id})">✕</button>
        </div>`
      : '';
    return `
      <div class="dashboard-widget ${sizeClass}" data-id="${widget.id}" data-type="${widget.widget_type}">
        <div class="widget-header"><h3>${widget.title || widget.widget_type}</h3>${actions}</div>
        <div class="widget-content" id="widget-content-${widget.id}">
          <div class="widget-loading"><div class="spinner"></div></div>
        </div>
      </div>`;
  },

  async loadWidgetData(widget) {
    const container = document.getElementById(`widget-content-${widget.id}`);
    if (!container) return;

    try {
      let data;
      if (this.W) {
        data = await this.W.fetchWidgetData(widget.widget_type, this.period);
        container.innerHTML = this.W.renderContent(widget.widget_type, data);
      } else {
        const response = await fetch(`/api/widgets/${widget.widget_type}/data`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        data = await response.json();
        container.innerHTML = this.renderWidgetContentFallback(widget.widget_type, data);
      }
    } catch (error) {
      container.innerHTML = '<p class="text-secondary">Ошибка загрузки</p>';
    }
  },

  // Минимальный фолбэк-рендер контента (когда widgets.js недоступен).
  renderWidgetContentFallback(type, data) {
    data = data || {};
    if (type === 'balance') return `<div class="widget-value">${(data.total || 0).toLocaleString()} ₴</div>`;
    if (type === 'cashflow') return `<div class="widget-value">${(data.net || 0).toLocaleString()} ₴</div>`;
    return '<p class="text-secondary">—</p>';
  },

  toggleEditMode() {
    this.editMode = !this.editMode;
    const btn = document.getElementById('edit-mode-btn');
    if (btn) btn.textContent = this.editMode ? '✓ Готово' : '⚙️ Настроить';
    this.render();
  },

  // ----- персист порядка (новый контракт: упорядоченный список id) -----
  async persistOrder(orderedIds) {
    // Локально переупорядочим this.widgets, чтобы UI был консистентен без релоада.
    const byId = {};
    this.widgets.forEach((w) => { byId[w.id] = w; });
    const reordered = orderedIds.map((id) => byId[id]).filter(Boolean);
    // дописываем виджеты, которых не было в DnD-наборе (скрытые), в конец
    this.widgets.forEach((w) => { if (orderedIds.indexOf(w.id) === -1) reordered.push(w); });
    reordered.forEach((w, i) => { w.position = i; });
    this.widgets = reordered;

    try {
      if (this.W) {
        await this.W.saveOrder(orderedIds);
      } else {
        await fetch('/api/widgets/reorder', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({ order: orderedIds })
        });
      }
    } catch (error) {
      console.error('Error reordering:', error);
    }
  },

  showAddWidgetModal() {
    const used = this.widgets.map((w) => w.widget_type);
    const available = this.availableWidgets.filter((w) => !used.includes(w.type));

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Добавить виджет</h2>
          <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button>
        </div>
        <div class="modal-body">
          ${available.length === 0 ? '<p>Все виджеты уже добавлены</p>' : `
            <div class="widget-picker">
              ${available.map((w) => `
                <div class="widget-option" onclick="SmartDashboard.addWidget('${w.type}', '${w.name}')">
                  <strong>${w.name}</strong>
                  <small>${w.description}</small>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  async addWidget(type, title) {
    try {
      await fetch('/api/widgets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        },
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
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      await this.loadWidgets();
    } catch (error) {
      alert('Ошибка');
    }
  },

  // Скрыть/показать виджет (is_visible toggle).
  async toggleVisibility(id) {
    const w = this.widgets.find((x) => x.id === id);
    if (!w) return;
    const next = w.is_visible ? 0 : 1;
    try {
      if (this.W) {
        await this.W.updateWidget(id, { is_visible: next });
      } else {
        await fetch(`/api/widgets/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({ is_visible: next })
        });
      }
      w.is_visible = next;
      this.render();
    } catch (error) {
      console.error('Error toggling visibility:', error);
    }
  },

  // Циклически менять размер small -> medium -> large -> small.
  async cycleSize(id) {
    const w = this.widgets.find((x) => x.id === id);
    if (!w) return;
    const sizes = (this.W && this.W.SIZES) || ['small', 'medium', 'large'];
    const idx = sizes.indexOf(w.size);
    const nextSize = sizes[(idx + 1) % sizes.length];
    try {
      if (this.W) {
        await this.W.updateWidget(id, { size: nextSize });
      } else {
        await fetch(`/api/widgets/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({ size: nextSize })
        });
      }
      w.size = nextSize;
      this.render();
    } catch (error) {
      console.error('Error resizing widget:', error);
    }
  },

  // Кнопочный перенос (↑/↓) — переиспользует тот же reorder-эндпоинт.
  async moveWidget(id, direction) {
    const visible = this.widgets.filter((w) => w.is_visible);
    const idx = visible.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= visible.length) return;

    const tmp = visible[idx];
    visible[idx] = visible[newIdx];
    visible[newIdx] = tmp;

    const orderedIds = visible.map((w) => w.id);
    await this.persistOrder(orderedIds);
    this.render();
  },

  setPeriod(period) {
    this.period = period;
    this.widgets.filter((w) => w.is_visible).forEach((w) => this.loadWidgetData(w));
  },

  // SIGNATURE HERO: "Your money, clarified". Markup + classes are set here;
  // numbers are hydrated from the balance/cashflow widgets after init() so the
  // existing widget API calls stay the single source of truth.
  renderHero() {
    return `
      <section class="fm-hero" aria-label="Ваши финансы">
        <div class="fm-hero-grid">
          <div class="fm-hero-main">
            <span class="fm-hero-eyebrow"><i class="fas fa-sparkles"></i> Your money, clarified</span>
            <h1 class="fm-hero-title">Чистый капитал</h1>
            <div class="fm-hero-figure" id="hero-networth" data-countup="0" data-currency="₴">
              <span class="fm-hero-currency">₴</span><span class="fm-hero-amount">—</span>
            </div>
            <div class="fm-hero-cashflow">
              <div class="fm-cashflow-item">
                <span class="fm-cashflow-label">Доходы</span>
                <span class="fm-cashflow-value in" id="hero-cashflow-in">—</span>
              </div>
              <div class="fm-cashflow-item">
                <span class="fm-cashflow-label">Расходы</span>
                <span class="fm-cashflow-value out" id="hero-cashflow-out">—</span>
              </div>
            </div>
          </div>
          <aside class="fm-insight-card" aria-label="AI-инсайт">
            <span class="fm-insight-label"><span class="fm-insight-dot"></span> AI-финдиректор</span>
            <p class="fm-insight-text" id="hero-insight-text">Анализирую ваши финансы…</p>
            <div class="fm-insight-foot">
              <button class="btn btn-sm" id="hero-ai-more" type="button">Спросить AI</button>
            </div>
          </aside>
        </div>
      </section>`;
  },

  getPage() {
    return `
      <div class="smart-dashboard">
        ${this.renderHero()}
        <div class="page-header">
          <h1>📊 Дашборд</h1>
          <div class="btn-group">
            <button class="btn" id="edit-mode-btn" onclick="SmartDashboard.toggleEditMode()">⚙️ Настроить</button>
            <button class="btn btn-primary" onclick="SmartDashboard.showAddWidgetModal()">+ Виджет</button>
          </div>
        </div>
        <div class="dashboard-grid" id="dashboard-widgets"></div>
      </div>`;
  }
};

// Override default dashboard render
function renderSmartDashboard() {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;
  mainContent.innerHTML = SmartDashboard.getPage();
  SmartDashboard.init();
}

if (typeof window !== 'undefined') {
  window.SmartDashboard = SmartDashboard;
  window.renderSmartDashboard = renderSmartDashboard;
}
