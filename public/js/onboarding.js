// public/js/onboarding.js — WAVE-2 stream "onboarding"
//
// Гайдед-онбординг первого запуска: 4-шаговый мастер-оверлей, который
// показывается, когда статус онбординга неполный. Дёргает API:
//   GET  /api/onboarding/status         -> какие шаги пройдены
//   POST /api/onboarding/quickstart     -> создать дефолтный счёт + категории
//   POST /api/onboarding/complete-step  -> явно отметить/пропустить шаг
//
// Самодостаточный модуль: собственные стили (scoped), собственный fetch с
// Bearer-токеном из localStorage. Не зависит от других js-модулей и не ломает их.
// Грязно-устойчив: при любой ошибке сети просто не показывает оверлей.

(function () {
  'use strict';

  var STEP_META = {
    account: {
      title: 'Добавьте счёт',
      desc: 'Создайте первый счёт — карту, наличные или вклад. С него начнётся учёт.',
      icon: 'fa-wallet',
      cta: 'Создать стартовый счёт',
    },
    transaction: {
      title: 'Запишите операцию',
      desc: 'Добавьте первую транзакцию или импортируйте выписку из банка.',
      icon: 'fa-right-left',
      cta: 'Перейти к транзакциям',
    },
    budget: {
      title: 'Задайте бюджет',
      desc: 'Установите лимит расходов по категории, чтобы держать траты под контролем.',
      icon: 'fa-chart-pie',
      cta: 'Перейти к бюджетам',
    },
    goal: {
      title: 'Поставьте цель',
      desc: 'Создайте цель накопления — на отпуск, подушку безопасности или мечту.',
      icon: 'fa-piggy-bank',
      cta: 'Перейти к целям',
    },
  };

  var STEP_ORDER = ['account', 'transaction', 'budget', 'goal'];

  var OnboardingWizard = {
    status: null,
    activeIndex: 0,
    root: null,

    token: function () {
      try {
        return localStorage.getItem('token');
      } catch (e) {
        return null;
      }
    },

    api: function (path, opts) {
      opts = opts || {};
      var headers = { 'Content-Type': 'application/json' };
      var t = this.token();
      if (t) headers.Authorization = 'Bearer ' + t;
      return fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(function (r) {
        return r.json().then(function (json) {
          return { ok: r.ok, status: r.status, json: json };
        });
      });
    },

    // Извлекаем data из { success, data } или возвращаем тело как есть.
    unwrap: function (res) {
      if (res && res.json && typeof res.json === 'object') {
        if (res.json.success && res.json.data !== undefined) return res.json.data;
        return res.json;
      }
      return null;
    },

    // Точка входа: грузим статус и показываем мастер, если онбординг неполный.
    init: function () {
      var self = this;
      if (!this.token()) return; // не залогинен — нечего показывать
      this.fetchStatus()
        .then(function (status) {
          self.status = status;
          if (status && status.showWizard) {
            self.activeIndex = self.firstIncompleteIndex();
            self.render();
          }
        })
        .catch(function () {
          /* offline / ошибка — тихо не показываем оверлей */
        });
    },

    fetchStatus: function () {
      var self = this;
      return this.api('/api/onboarding/status').then(function (res) {
        if (!res.ok) throw new Error('status failed');
        return self.unwrap(res);
      });
    },

    firstIncompleteIndex: function () {
      if (!this.status || !this.status.steps) return 0;
      for (var i = 0; i < this.status.steps.length; i++) {
        if (!this.status.steps[i].done) return i;
      }
      return 0;
    },

    stepDone: function (key) {
      if (!this.status || !this.status.steps) return false;
      for (var i = 0; i < this.status.steps.length; i++) {
        if (this.status.steps[i].key === key) return this.status.steps[i].done;
      }
      return false;
    },

    // ===== действия шагов =====

    // Шаг account: quickstart создаёт дефолтный счёт + категории.
    quickstart: function () {
      var self = this;
      return this.api('/api/onboarding/quickstart', { method: 'POST', body: {} }).then(
        function (res) {
          var data = self.unwrap(res);
          if (data && data.status) self.status = data.status;
          return data;
        }
      );
    },

    // Явная отметка/пропуск шага.
    completeStep: function (key) {
      var self = this;
      return this.api('/api/onboarding/complete-step', {
        method: 'POST',
        body: { step: key },
      }).then(function (res) {
        var data = self.unwrap(res);
        if (data && data.steps) self.status = data;
        return data;
      });
    },

    // Перейти к соответствующему разделу приложения (если фронт это поддерживает).
    navigateToSection: function (key) {
      var sectionMap = {
        account: 'accounts',
        transaction: 'transactions',
        budget: 'budgets',
        goal: 'goals',
      };
      var section = sectionMap[key];
      if (!section) return;
      // Пытаемся переключить активную секцию, не падая, если хелпера нет.
      try {
        var link = document.querySelector('[data-section="' + section + '"]');
        if (link && typeof link.click === 'function') {
          link.click();
          return;
        }
        if (window.location && window.location.hash !== undefined) {
          window.location.hash = '#' + section;
        }
      } catch (e) {
        /* no-op */
      }
    },

    // ===== навигация мастера =====

    next: function () {
      if (this.activeIndex < STEP_ORDER.length - 1) {
        this.activeIndex += 1;
        this.render();
      } else {
        this.close();
      }
    },

    prev: function () {
      if (this.activeIndex > 0) {
        this.activeIndex -= 1;
        this.render();
      }
    },

    skip: function () {
      var key = STEP_ORDER[this.activeIndex];
      var self = this;
      this.completeStep(key)
        .catch(function () {})
        .then(function () {
          self.advanceOrFinish();
        });
    },

    advanceOrFinish: function () {
      // Если все шаги выполнены — закрываем; иначе идём к следующему незавершённому.
      if (this.status && this.status.complete) {
        this.close();
        return;
      }
      if (this.activeIndex < STEP_ORDER.length - 1) {
        this.activeIndex += 1;
        this.render();
      } else {
        this.close();
      }
    },

    // Главное действие текущего шага.
    primaryAction: function () {
      var key = STEP_ORDER[this.activeIndex];
      var self = this;

      if (key === 'account' && !this.stepDone('account')) {
        this.setBusy(true);
        this.quickstart()
          .then(function () {
            self.setBusy(false);
            self.advanceOrFinish();
          })
          .catch(function () {
            self.setBusy(false);
            self.showError('Не удалось создать стартовый счёт. Попробуйте ещё раз.');
          });
        return;
      }

      // Для остальных шагов: отметить как просмотренный и направить в раздел.
      this.completeStep(key)
        .catch(function () {})
        .then(function () {
          self.navigateToSection(key);
          self.advanceOrFinish();
        });
    },

    close: function () {
      if (this.root && this.root.parentNode) {
        this.root.parentNode.removeChild(this.root);
      }
      this.root = null;
    },

    setBusy: function (busy) {
      if (!this.root) return;
      var btn = this.root.querySelector('.ob-primary');
      if (btn) {
        btn.disabled = !!busy;
        btn.classList.toggle('ob-busy', !!busy);
      }
    },

    showError: function (msg) {
      if (!this.root) return;
      var el = this.root.querySelector('.ob-error');
      if (el) {
        el.textContent = msg;
        el.style.display = 'block';
      }
    },

    // ===== рендер =====

    ensureStyles: function () {
      if (document.getElementById('ob-styles')) return;
      var css =
        '.ob-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);' +
        'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}' +
        '.ob-card{background:#fff;color:#1e293b;width:min(440px,92vw);border-radius:16px;' +
        'box-shadow:0 20px 60px rgba(0,0,0,.35);padding:28px;position:relative;}' +
        '.ob-close{position:absolute;top:14px;right:16px;border:0;background:transparent;' +
        'font-size:20px;cursor:pointer;color:#94a3b8;line-height:1;}' +
        '.ob-steps{display:flex;gap:8px;margin-bottom:22px;}' +
        '.ob-dot{flex:1;height:6px;border-radius:3px;background:#e2e8f0;}' +
        '.ob-dot.active{background:#5D5CDE;}.ob-dot.done{background:#22C55E;}' +
        '.ob-icon{width:56px;height:56px;border-radius:14px;background:#eef0fc;color:#5D5CDE;' +
        'display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:16px;}' +
        '.ob-title{font-size:20px;font-weight:700;margin:0 0 8px;}' +
        '.ob-desc{font-size:14px;line-height:1.5;color:#475569;margin:0 0 20px;}' +
        '.ob-error{display:none;color:#dc2626;font-size:13px;margin-bottom:12px;}' +
        '.ob-actions{display:flex;gap:10px;align-items:center;}' +
        '.ob-primary{flex:1;background:#5D5CDE;color:#fff;border:0;border-radius:10px;' +
        'padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;}' +
        '.ob-primary[disabled]{opacity:.6;cursor:default;}' +
        '.ob-primary.done{background:#22C55E;}' +
        '.ob-secondary{background:transparent;border:0;color:#64748b;cursor:pointer;' +
        'font-size:14px;padding:10px;}' +
        '.ob-foot{display:flex;justify-content:space-between;margin-top:16px;font-size:13px;}' +
        '.ob-foot button{background:transparent;border:0;color:#64748b;cursor:pointer;}' +
        '@media (prefers-color-scheme: dark){.ob-card{background:#1e293b;color:#e2e8f0;}' +
        '.ob-desc{color:#94a3b8;}.ob-dot{background:#334155;}.ob-icon{background:#312e81;}}';
      var style = document.createElement('style');
      style.id = 'ob-styles';
      style.textContent = css;
      document.head.appendChild(style);
    },

    render: function () {
      this.ensureStyles();
      this.close(); // снимаем предыдущий, если был

      var key = STEP_ORDER[this.activeIndex];
      var meta = STEP_META[key];
      var done = this.stepDone(key);
      var isLast = this.activeIndex === STEP_ORDER.length - 1;
      var self = this;

      var overlay = document.createElement('div');
      overlay.className = 'ob-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      var dots = '';
      for (var i = 0; i < STEP_ORDER.length; i++) {
        var cls = 'ob-dot';
        if (this.stepDone(STEP_ORDER[i])) cls += ' done';
        else if (i === this.activeIndex) cls += ' active';
        dots += '<div class="' + cls + '"></div>';
      }

      var primaryLabel = done ? 'Готово ✓' : meta.cta;

      overlay.innerHTML =
        '<div class="ob-card">' +
        '<button class="ob-close" aria-label="Закрыть">×</button>' +
        '<div class="ob-steps">' + dots + '</div>' +
        '<div class="ob-icon"><i class="fa-solid ' + meta.icon + '"></i></div>' +
        '<h2 class="ob-title">' + meta.title + '</h2>' +
        '<p class="ob-desc">' + meta.desc + '</p>' +
        '<div class="ob-error"></div>' +
        '<div class="ob-actions">' +
        '<button class="ob-primary' + (done ? ' done' : '') + '">' + primaryLabel + '</button>' +
        '</div>' +
        '<div class="ob-foot">' +
        '<button class="ob-prev"' + (this.activeIndex === 0 ? ' style="visibility:hidden"' : '') + '>Назад</button>' +
        '<button class="ob-skip">' + (isLast ? 'Завершить' : 'Пропустить') + '</button>' +
        '</div>' +
        '</div>';

      // Обработчики.
      overlay.querySelector('.ob-close').addEventListener('click', function () {
        self.close();
      });
      overlay.querySelector('.ob-primary').addEventListener('click', function () {
        if (done) {
          self.advanceOrFinish();
        } else {
          self.primaryAction();
        }
      });
      overlay.querySelector('.ob-prev').addEventListener('click', function () {
        self.prev();
      });
      overlay.querySelector('.ob-skip').addEventListener('click', function () {
        self.skip();
      });

      document.body.appendChild(overlay);
      this.root = overlay;
    },
  };

  // Экспорт для тестов/отладки и автозапуск после загрузки DOM.
  if (typeof window !== 'undefined') {
    window.OnboardingWizard = OnboardingWizard;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        OnboardingWizard.init();
      });
    } else {
      OnboardingWizard.init();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OnboardingWizard;
  }
})();
