// public/js/widgets.js — Wave-2 widget rendering + HTML5 drag-to-reorder.
//
// Загружается как <script> ПЕРЕД public/js/dashboard.js (см. integration_notes).
// Экспортирует глобальный объект DashboardWidgets с чистыми (по возможности)
// функциями рендера и хелперами DnD, которые переиспользует SmartDashboard.
//
// Зависимости: только глобальный fetch + localStorage('token'). Никаких внешних
// библиотек. Совместимо с существующими CSS-классами (.dashboard-widget,
// .widget-content, .widget-value и т.п.).

(function (global) {
  'use strict';

  // ----- утилиты -----
  function authHeaders(extra) {
    var token = (global.localStorage && global.localStorage.getItem('token')) || '';
    var h = { Authorization: 'Bearer ' + token };
    if (extra) {
      Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    }
    return h;
  }

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(n) {
    var num = Number(n || 0);
    try {
      return num.toLocaleString();
    } catch (e) {
      return String(num);
    }
  }

  function sizeClass(size) {
    if (size === 'small') return 'widget-sm';
    if (size === 'large') return 'widget-lg';
    return 'widget-md';
  }

  // ----- рендер содержимого виджета по типу -----
  function renderContent(type, data) {
    data = data || {};
    switch (type) {
      case 'balance':
        return '<div class="widget-value">' + fmt(data.total) + ' ₴</div>';

      case 'networth': {
        var nw = Number(data.netWorth || 0);
        return '<div class="widget-value ' + (nw >= 0 ? 'positive' : 'negative') + '">' +
          fmt(nw) + ' ₴</div>' +
          '<div class="widget-subtitle">Активы: ' + fmt(data.assets) +
          ' ₴ | Долги: ' + fmt(data.liabilities) + ' ₴</div>';
      }

      case 'cashflow': {
        var net = Number(data.net || 0);
        return '<div class="widget-value ' + (net >= 0 ? 'positive' : 'negative') + '">' +
          (net >= 0 ? '+' : '') + fmt(net) + ' ₴</div>' +
          '<div class="widget-subtitle">Доход ' + fmt(data.income) +
          ' ₴ / Расход ' + fmt(data.expense) + ' ₴</div>';
      }

      case 'expenses':
        return '<div class="widget-value negative">' + fmt(data.total) + ' ₴</div>' +
          '<div class="widget-subtitle">за ' + (data.period === 'year' ? 'год' : 'месяц') + '</div>';

      case 'income':
        return '<div class="widget-value positive">' + fmt(data.total) + ' ₴</div>' +
          '<div class="widget-subtitle">за ' + (data.period === 'year' ? 'год' : 'месяц') + '</div>';

      case 'budget': {
        if (!data.budgets || data.budgets.length === 0) {
          return '<p class="text-secondary">Нет бюджетов</p>';
        }
        return data.budgets.slice(0, 3).map(function (b) {
          var pct = b.amount > 0 ? Math.min(100, ((b.spent || 0) / b.amount) * 100) : 0;
          return '<div class="mini-budget">' +
            '<div class="mini-budget-header"><span>' + esc(b.category || b.name) + '</span>' +
            '<span>' + fmt(b.spent || 0) + '/' + fmt(b.amount) + '</span></div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        }).join('');
      }

      case 'goals': {
        if (!data.goals || data.goals.length === 0) {
          return '<p class="text-secondary">Нет целей</p>';
        }
        return data.goals.slice(0, 3).map(function (g) {
          var p = Math.round(g.progress || 0);
          return '<div class="mini-goal"><span>' + esc(g.name) + '</span>' +
            '<div class="progress-bar"><div class="progress-fill progress-ok" style="width:' + p + '%"></div></div>' +
            '<span>' + p + '%</span></div>';
        }).join('');
      }

      case 'upcoming': {
        if (!data.items || data.items.length === 0) {
          return '<p class="text-secondary">Нет предстоящих платежей</p>';
        }
        return '<div class="mini-list">' + data.items.slice(0, 5).map(function (i) {
          return '<div class="mini-item"><span>' + esc(i.title) + '</span>' +
            '<span>' + fmt(i.amount) + ' ₴</span><small>' + esc(i.date) + '</small></div>';
        }).join('') + '</div>';
      }

      case 'top_categories': {
        if (!data.categories || data.categories.length === 0) {
          return '<p class="text-secondary">Нет расходов</p>';
        }
        return data.categories.slice(0, 5).map(function (c) {
          return '<div class="mini-budget">' +
            '<div class="mini-budget-header"><span>' + esc(c.category) + '</span>' +
            '<span>' + fmt(c.total) + ' ₴ (' + (c.percent || 0) + '%)</span></div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + (c.percent || 0) + '%"></div></div>' +
            '</div>';
        }).join('');
      }

      case 'subscriptions':
        return '<div class="widget-value">' + fmt(data.monthlyTotal) + ' ₴/мес</div>' +
          '<div class="widget-subtitle">' + ((data.subscriptions && data.subscriptions.length) || 0) + ' подписок</div>';

      case 'investments':
        return '<div class="widget-value">' + fmt(data.totalValue) + ' ₴</div>' +
          '<div class="widget-subtitle">' + (data.portfolioCount || 0) + ' портфелей</div>';

      case 'debts':
        return '<div class="widget-value negative">' + fmt(data.totalOwed) + ' ₴</div>' +
          '<div class="widget-subtitle">' + ((data.debts && data.debts.length) || 0) + ' долгов</div>';

      case 'recent': {
        if (!data.transactions || data.transactions.length === 0) {
          return '<p class="text-secondary">Нет транзакций</p>';
        }
        return '<div class="mini-list">' + data.transactions.slice(0, 5).map(function (t) {
          var sign = t.type === 'income' ? '+' : '-';
          var cls = t.type === 'income' ? 'positive' : 'negative';
          return '<div class="mini-item"><span>' + esc(t.description || t.category) + '</span>' +
            '<span class="' + cls + '">' + sign + fmt(t.amount) + '</span></div>';
        }).join('') + '</div>';
      }

      case 'quick_add':
        return '<button class="btn btn-success btn-block" onclick="showAddTransactionModal(\'income\')">+ Доход</button>' +
          '<button class="btn btn-danger btn-block" onclick="showAddTransactionModal(\'expense\')">- Расход</button>';

      default:
        return '<p class="text-secondary">Виджет недоступен</p>';
    }
  }

  // ----- рендер каркаса виджета (header + слот контента) -----
  function renderWidget(widget, opts) {
    opts = opts || {};
    var editMode = !!opts.editMode;
    var draggable = editMode ? ' draggable="true"' : '';
    var actions = '';
    if (editMode) {
      actions = '<div class="widget-actions">' +
        '<button class="btn btn-sm btn-icon" data-action="up" onclick="SmartDashboard.moveWidget(' + widget.id + ', -1)">↑</button>' +
        '<button class="btn btn-sm btn-icon" data-action="down" onclick="SmartDashboard.moveWidget(' + widget.id + ', 1)">↓</button>' +
        '<button class="btn btn-sm btn-icon" data-action="hide" onclick="SmartDashboard.toggleVisibility(' + widget.id + ')" title="Скрыть">\u{1F441}</button>' +
        '<button class="btn btn-sm btn-icon" data-action="resize" onclick="SmartDashboard.cycleSize(' + widget.id + ')" title="Размер">⇲</button>' +
        '<button class="btn btn-sm btn-icon btn-danger" data-action="remove" onclick="SmartDashboard.removeWidget(' + widget.id + ')">✕</button>' +
        '</div>';
    }
    return '<div class="dashboard-widget ' + sizeClass(widget.size) + '"' + draggable +
      ' data-id="' + widget.id + '" data-type="' + esc(widget.widget_type) + '">' +
      '<div class="widget-header"><h3>' + esc(widget.title || widget.widget_type) + '</h3>' + actions + '</div>' +
      '<div class="widget-content" id="widget-content-' + widget.id + '">' +
      '<div class="widget-loading"><div class="spinner"></div></div></div>' +
      '</div>';
  }

  // ----- HTML5 drag-and-drop: навешивает обработчики на контейнер -----
  // onReorder(orderedIds) вызывается с массивом id в новом порядке.
  function enableDragReorder(container, onReorder) {
    if (!container) return;
    var dragEl = null;

    container.addEventListener('dragstart', function (e) {
      var el = e.target.closest ? e.target.closest('.dashboard-widget') : null;
      if (!el) return;
      dragEl = el;
      el.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', el.dataset.id); } catch (err) { /* IE */ }
      }
    });

    container.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (!dragEl) return;
      var after = getDragAfterElement(container, e.clientY);
      if (after == null) {
        container.appendChild(dragEl);
      } else if (after !== dragEl) {
        container.insertBefore(dragEl, after);
      }
    });

    container.addEventListener('dragend', function () {
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      var ids = Array.prototype.map.call(
        container.querySelectorAll('.dashboard-widget'),
        function (el) { return Number(el.dataset.id); }
      );
      if (typeof onReorder === 'function') onReorder(ids);
    });
  }

  // Возвращает элемент, перед которым надо вставить перетаскиваемый виджет.
  function getDragAfterElement(container, y) {
    var els = Array.prototype.slice.call(
      container.querySelectorAll('.dashboard-widget:not(.dragging)')
    );
    var closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for (var i = 0; i < els.length; i++) {
      var box = els[i].getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset: offset, element: els[i] };
      }
    }
    return closest.element;
  }

  // ----- API-обёртки -----
  function fetchWidgets() {
    return fetch('/api/widgets', { headers: authHeaders() }).then(function (r) { return r.json(); });
  }

  function fetchWidgetData(type, period) {
    var qs = period ? ('?period=' + encodeURIComponent(period)) : '';
    return fetch('/api/widgets/' + encodeURIComponent(type) + '/data' + qs, {
      headers: authHeaders()
    }).then(function (r) { return r.json(); });
  }

  // Сохранить порядок: отправляем упорядоченный список id (новый контракт).
  function saveOrder(orderedIds) {
    return fetch('/api/widgets/reorder', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ order: orderedIds })
    }).then(function (r) { return r.json(); });
  }

  function updateWidget(id, patch) {
    return fetch('/api/widgets/' + id, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch || {})
    }).then(function (r) { return r.json(); });
  }

  global.DashboardWidgets = {
    authHeaders: authHeaders,
    esc: esc,
    fmt: fmt,
    sizeClass: sizeClass,
    renderContent: renderContent,
    renderWidget: renderWidget,
    enableDragReorder: enableDragReorder,
    getDragAfterElement: getDragAfterElement,
    fetchWidgets: fetchWidgets,
    fetchWidgetData: fetchWidgetData,
    saveOrder: saveOrder,
    updateWidget: updateWidget,
    SIZES: ['small', 'medium', 'large']
  };
})(typeof window !== 'undefined' ? window : this);
