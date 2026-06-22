// public/js/api-tokens.js — менеджер Personal Access Tokens (публичный REST API).
//
// UI:
//   - список токенов (имя, дата создания, дата последнего использования)
//   - создание токена: имя -> один раз показываем plaintext с кнопкой «копировать»
//   - отзыв токена
//
// Работает на /api/v1/tokens (jwt-сессия UI). Plaintext-токен сервер отдаёт
// ровно один раз (в ответе на POST) — UI обязан показать его сразу и больше
// никогда не запрашивает.
//
// Self-contained: экспортирует window.ApiTokensModule с getPage()/init(); не
// трогает app.js/index.html (их монтирует Integrator).

(function () {
  'use strict';

  // Полное HTML-экранирование (включая кавычки — безопасно и в атрибутах).
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function authHeaders(extra) {
    const h = { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') };
    if (extra) Object.assign(h, extra);
    return h;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return escapeHtml(value);
    return d.toLocaleString();
  }

  const ApiTokensModule = {
    tokens: [],

    // Разметка страницы (для роутера, который вставит её в main-контейнер).
    getPage() {
      return (
        '<div class="api-tokens-page">' +
        '<h2>API-токены</h2>' +
        '<p class="muted">Personal Access Tokens для публичного REST API ' +
        '(<code>/api/v1</code>). Используйте заголовок ' +
        '<code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
        '<div class="api-tokens-create">' +
        '<input id="api-token-name" type="text" maxlength="100" ' +
        'placeholder="Название токена (напр. «Мобильный скрипт»)" />' +
        '<button class="btn btn-primary" id="api-token-create-btn">Создать токен</button>' +
        '</div>' +
        '<div id="api-token-new"></div>' +
        '<div id="api-tokens-list"></div>' +
        '</div>'
      );
    },

    async init(containerId) {
      // Если страница ещё не вставлена в DOM — вставим в указанный/типовой контейнер.
      const host =
        document.getElementById('api-tokens-list') ||
        (containerId && document.getElementById(containerId)) ||
        document.getElementById('main-content') ||
        document.getElementById('app');
      if (host && !document.getElementById('api-tokens-list')) {
        host.innerHTML = this.getPage();
      }
      this.bind();
      await this.load();
    },

    bind() {
      const btn = document.getElementById('api-token-create-btn');
      if (btn && !btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => this.create());
      }
      const input = document.getElementById('api-token-name');
      if (input && !input.dataset.bound) {
        input.dataset.bound = '1';
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.create();
        });
      }
    },

    async load() {
      try {
        const res = await fetch('/api/v1/tokens', { headers: authHeaders() });
        const body = await res.json();
        this.tokens = (body && body.success && body.data && body.data.tokens) || [];
      } catch (e) {
        this.tokens = [];
      }
      this.render();
    },

    render() {
      const list = document.getElementById('api-tokens-list');
      if (!list) return;
      if (!this.tokens.length) {
        list.innerHTML = '<div class="empty-state"><p>Токенов пока нет</p></div>';
        return;
      }
      list.innerHTML =
        '<table class="api-tokens-table"><thead><tr>' +
        '<th>Название</th><th>Создан</th><th>Последнее использование</th><th></th>' +
        '</tr></thead><tbody>' +
        this.tokens
          .map(function (t) {
            return (
              '<tr data-id="' + Number(t.id) + '">' +
              '<td>' + escapeHtml(t.name) + '</td>' +
              '<td>' + fmtDate(t.createdAt) + '</td>' +
              '<td>' + fmtDate(t.lastUsedAt) + '</td>' +
              '<td><button class="btn btn-danger btn-sm" ' +
              'onclick="ApiTokensModule.revoke(' + Number(t.id) + ')">Отозвать</button></td>' +
              '</tr>'
            );
          })
          .join('') +
        '</tbody></table>';
    },

    async create() {
      const input = document.getElementById('api-token-name');
      const name = input ? input.value.trim() : '';
      if (!name) {
        alert('Введите название токена');
        return;
      }
      try {
        const res = await fetch('/api/v1/tokens', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ name: name }),
        });
        const body = await res.json();
        if (!res.ok || !body.success) {
          const msg = (body && body.error && body.error.message) || 'Ошибка создания токена';
          alert(msg);
          return;
        }
        if (input) input.value = '';
        this.showNewToken(body.data.token);
        await this.load();
      } catch (e) {
        alert('Сетевая ошибка при создании токена');
      }
    },

    // Показываем plaintext-токен один раз, с предупреждением и кнопкой копирования.
    showNewToken(token) {
      const box = document.getElementById('api-token-new');
      if (!box || !token) return;
      const value = String(token.token || '');
      box.innerHTML =
        '<div class="api-token-reveal card">' +
        '<strong>Токен «' + escapeHtml(token.name) + '» создан.</strong> ' +
        'Скопируйте его сейчас — больше он не будет показан.' +
        '<div class="api-token-value">' +
        '<code id="api-token-plaintext">' + escapeHtml(value) + '</code> ' +
        '<button class="btn btn-secondary btn-sm" id="api-token-copy-btn">Копировать</button>' +
        '</div></div>';
      const copyBtn = document.getElementById('api-token-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value);
          }
          copyBtn.textContent = 'Скопировано';
        });
      }
    },

    async revoke(id) {
      if (!confirm('Отозвать этот токен? Приложения, использующие его, потеряют доступ.')) {
        return;
      }
      try {
        const res = await fetch('/api/v1/tokens/' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: authHeaders(),
        });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok || !body.success) {
          alert((body && body.error && body.error.message) || 'Не удалось отозвать токен');
          return;
        }
        await this.load();
      } catch (e) {
        alert('Сетевая ошибка при отзыве токена');
      }
    },
  };

  if (typeof window !== 'undefined') {
    window.ApiTokensModule = ApiTokensModule;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ApiTokensModule;
  }
})();
