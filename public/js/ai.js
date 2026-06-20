// public/js/ai.js — AI Financial CFO chat panel + Insights.
// Загружается через <script> в index.html, доступен как глобальный AiCfoModule.
// Бэкенд отвечает в конверте { success, data } (lib/respond) либо
// { success:false, error:{ code, message } } при ошибке.

const AiCfoModule = {
  conversationId: null,
  loading: false,

  // Вызывается при открытии вкладки/панели ИИ.
  init() {
    this.render();
  },

  // --- helpers -----------------------------------------------------------

  authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    };
  },

  // Унифицированный разбор ответа: бросает понятную ошибку для UI.
  async parse(response) {
    let body = null;
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
    if (!response.ok || !body || body.success === false) {
      const err = (body && body.error) || {};
      const message =
        err.code === 'AI_NOT_CONFIGURED'
          ? 'ИИ-провайдер не настроен. Добавьте AI_API_KEY в настройках сервера.'
          : err.code === 'PAYMENT_REQUIRED'
          ? 'AI-CFO доступен на тарифе Pro.'
          : (err.message || `Ошибка запроса (${response.status})`);
      const e = new Error(message);
      e.code = err.code;
      throw e;
    }
    return body.data;
  },

  // --- API ---------------------------------------------------------------

  async sendMessage(message) {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ conversationId: this.conversationId, message }),
    });
    const data = await this.parse(response);
    this.conversationId = data.conversationId;
    return data;
  },

  async loadInsights() {
    const response = await fetch('/api/ai/insights', {
      headers: this.authHeaders(),
    });
    return this.parse(response);
  },

  // --- Wave-2 API: streaming chat, auto-categorize, monthly summary --------

  // Стримит ответ ассистента по SSE. onChunk(text) — на каждый кусок,
  // onStart({conversationId}) и onDone({conversationId, reply}) — события.
  // Возвращает Promise, который резолвится по 'done' (или реджектится на error).
  async streamMessage(message, { onStart, onChunk, onDone } = {}) {
    const response = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ conversationId: this.conversationId, message }),
    });

    // Ошибки ДО открытия потока приходят обычным JSON-конвертом.
    const ctype = response.headers.get('content-type') || '';
    if (!response.ok || ctype.indexOf('text/event-stream') === -1) {
      // переиспользуем parse() для единообразного текста ошибки
      return this.parse(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let done = false;

    // Простой парсер SSE: события разделены пустой строкой.
    const handleEvent = (block) => {
      let event = 'message';
      const dataLines = [];
      block.split('\n').forEach((line) => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });
      let payload = {};
      try {
        payload = JSON.parse(dataLines.join('\n') || '{}');
      } catch (e) {
        payload = {};
      }
      if (event === 'start') {
        if (payload.conversationId) this.conversationId = payload.conversationId;
        if (onStart) onStart(payload);
      } else if (event === 'chunk') {
        full += payload.text || '';
        if (onChunk) onChunk(payload.text || '');
      } else if (event === 'done') {
        if (payload.conversationId) this.conversationId = payload.conversationId;
        done = true;
        if (onDone) onDone({ conversationId: this.conversationId, reply: payload.reply != null ? payload.reply : full });
      } else if (event === 'error') {
        const e = new Error(payload.message || 'Ошибка стриминга');
        e.code = payload.code;
        throw e;
      }
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) handleEvent(block);
      }
      if (streamDone) break;
    }
    return { conversationId: this.conversationId, reply: full, done };
  },

  async loadCategorize() {
    const response = await fetch('/api/ai/categorize', {
      headers: this.authHeaders(),
    });
    return this.parse(response);
  },

  async applyCategorize(accepted) {
    const response = await fetch('/api/ai/categorize', {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ accepted }),
    });
    return this.parse(response);
  },

  async loadSummary(month) {
    const qs = month ? `?month=${encodeURIComponent(month)}` : '';
    const response = await fetch(`/api/ai/summary${qs}`, {
      headers: this.authHeaders(),
    });
    return this.parse(response);
  },

  // --- UI actions --------------------------------------------------------

  async handleSend() {
    if (this.loading) return;
    const input = document.getElementById('ai-input');
    if (!input) return;
    const message = (input.value || '').trim();
    if (!message) return;

    input.value = '';
    this.appendMessage('user', message);
    this.setLoading(true);

    // Создаём пустой пузырь ассистента, который наполняем по мере стрима.
    const bubble = this.appendMessage('assistant', '');
    const textEl = bubble ? bubble.querySelector('.ai-msg-text') : null;
    let acc = '';

    try {
      await this.streamMessage(message, {
        onChunk: (piece) => {
          acc += piece;
          if (textEl) {
            textEl.textContent = acc; // textContent — безопасно (без HTML-инъекций)
            this.scrollMessages();
          }
        },
        onDone: ({ reply }) => {
          const finalText = reply != null && reply !== '' ? reply : acc;
          if (textEl) textEl.textContent = finalText || '(пустой ответ)';
          this.scrollMessages();
        },
      });
    } catch (err) {
      if (textEl) {
        bubble.className = 'ai-msg ai-msg-error';
        textEl.textContent = err.message;
      } else {
        this.appendMessage('error', err.message);
      }
    } finally {
      this.setLoading(false);
    }
  },

  async handleCategorize() {
    if (this.loading) return;
    this.setLoading(true);
    const container = document.getElementById('ai-categorize');
    if (container) container.innerHTML = '<div class="ai-loading">Анализирую неразмеченные транзакции…</div>';

    try {
      const data = await this.loadCategorize();
      this.renderCategorize(data);
    } catch (err) {
      if (container) container.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
    } finally {
      this.setLoading(false);
    }
  },

  async handleApplyCategorize() {
    if (this.loading) return;
    const checks = Array.from(
      document.querySelectorAll('#ai-categorize input[type="checkbox"][data-tx]:checked')
    );
    const accepted = checks.map((c) => ({
      transactionId: Number(c.getAttribute('data-tx')),
      category: c.getAttribute('data-cat'),
    }));
    if (!accepted.length) return;

    this.setLoading(true);
    const container = document.getElementById('ai-categorize');
    try {
      const res = await this.applyCategorize(accepted);
      if (container) {
        container.innerHTML = `<div class="ai-note">Применено категорий: ${res.applied || 0}.</div>`;
      }
    } catch (err) {
      if (container) container.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
    } finally {
      this.setLoading(false);
    }
  },

  async handleSummary() {
    if (this.loading) return;
    this.setLoading(true);
    const container = document.getElementById('ai-summary');
    if (container) container.innerHTML = '<div class="ai-loading">Собираю историю месяца…</div>';

    try {
      const input = document.getElementById('ai-summary-month');
      const month = input && input.value ? input.value : undefined;
      const data = await this.loadSummary(month);
      this.renderSummary(data);
    } catch (err) {
      if (container) container.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
    } finally {
      this.setLoading(false);
    }
  },

  async handleInsights() {
    if (this.loading) return;
    this.setLoading(true);
    const container = document.getElementById('ai-insights');
    if (container) container.innerHTML = '<div class="ai-loading">Анализирую ваши данные…</div>';

    try {
      const data = await this.loadInsights();
      this.renderInsights(data);
    } catch (err) {
      if (container) {
        container.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
      }
    } finally {
      this.setLoading(false);
    }
  },

  // --- rendering ---------------------------------------------------------

  setLoading(state) {
    this.loading = state;
    ['ai-send-btn', 'ai-insights-btn', 'ai-categorize-btn', 'ai-summary-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = state;
    });
  },

  scrollMessages() {
    const log = document.getElementById('ai-messages');
    if (log) log.scrollTop = log.scrollHeight;
  },

  // Возвращает созданный DOM-элемент сообщения (нужно для стрим-наполнения).
  appendMessage(role, text) {
    const log = document.getElementById('ai-messages');
    if (!log) return null;
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;
    const who =
      role === 'user' ? 'Вы' : role === 'assistant' ? 'CFO' : 'Ошибка';
    const roleSpan = document.createElement('span');
    roleSpan.className = 'ai-msg-role';
    roleSpan.textContent = who;
    const textSpan = document.createElement('span');
    textSpan.className = 'ai-msg-text';
    textSpan.textContent = text == null ? '' : text;
    div.appendChild(roleSpan);
    div.appendChild(textSpan);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  },

  renderInsights(data) {
    const container = document.getElementById('ai-insights');
    if (!container) return;
    const a = (data && data.analysis) || {};
    const cats = a.topCategories || [];

    let html = '<div class="ai-insights-card">';
    html += '<h4>Анализ трат</h4>';
    html += `<div class="ai-insights-summary">Доход: <b>${a.recentIncome || 0}</b> · Расход: <b>${a.recentExpense || 0}</b> · Сбережения: <b>${a.savingsRate || 0}%</b></div>`;

    if (cats.length) {
      html += '<ul class="ai-cat-list">';
      cats.forEach((c) => {
        html += `<li><span>${this.escape(c.category)}</span><span>${c.total} (${c.sharePercent}%)</span></li>`;
      });
      html += '</ul>';
    }

    if (a.budgetsOverLimit && a.budgetsOverLimit.length) {
      html += `<div class="ai-warning">Превышен бюджет: ${a.budgetsOverLimit.map((b) => this.escape(b)).join(', ')}</div>`;
    }

    if (data && data.insight) {
      html += `<div class="ai-insight-text">${this.escape(data.insight)}</div>`;
    } else if (data && data.aiConfigured === false) {
      html += '<div class="ai-note">Подключите AI-провайдера, чтобы получить персональные рекомендации.</div>';
    }

    html += '</div>';
    container.innerHTML = html;
  },

  renderCategorize(data) {
    const container = document.getElementById('ai-categorize');
    if (!container) return;
    const suggestions = (data && data.suggestions) || [];

    if (!suggestions.length) {
      const total = (data && data.uncategorizedCount) || 0;
      const cats = (data && data.categories) || [];
      let msg;
      if (!cats.length) {
        msg = 'Нет категорий для сопоставления — сначала создайте категории.';
      } else if (!total) {
        msg = 'Все транзакции уже размечены 🎉';
      } else {
        msg = 'ИИ не нашёл уверенных совпадений для неразмеченных транзакций.';
      }
      container.innerHTML = `<div class="ai-note">${this.escape(msg)}</div>`;
      return;
    }

    let html = '<div class="ai-cat-suggest"><h4>Предложения категорий</h4><ul class="ai-cat-suggest-list">';
    suggestions.forEach((s) => {
      html += `<li>
        <label>
          <input type="checkbox" checked data-tx="${Number(s.transactionId)}" data-cat="${this.escape(s.suggestedCategory)}">
          <span class="ai-cat-desc">${this.escape(s.description || '(без описания)')}</span>
          <span class="ai-cat-amt">${this.escape(String(s.amount))}</span>
          <span class="ai-cat-arrow">→</span>
          <span class="ai-cat-name">${this.escape(s.suggestedCategory)}</span>
        </label>
      </li>`;
    });
    html += '</ul>';
    html += '<button id="ai-apply-cat-btn" class="btn btn-primary" onclick="AiCfoModule.handleApplyCategorize()">Применить выбранные</button>';
    html += '</div>';
    container.innerHTML = html;
  },

  renderSummary(data) {
    const container = document.getElementById('ai-summary');
    if (!container) return;
    const stats = (data && data.stats) || {};

    let html = '<div class="ai-summary-card">';
    html += `<h4>История денег · ${this.escape((data && data.month) || '')}</h4>`;
    if (data && data.narrative) {
      html += `<p class="ai-summary-text">${this.escape(data.narrative)}</p>`;
    }
    html += `<div class="ai-summary-stats">Доход: <b>${stats.totalIncome || 0}</b> · Расход: <b>${stats.totalExpense || 0}</b> · Нетто: <b>${stats.netFlow || 0}</b> · Сбережения: <b>${stats.savingsRate || 0}%</b></div>`;
    const top = (stats.topCategories || [])[0];
    if (top) {
      html += `<div class="ai-summary-top">Топ-категория: ${this.escape(top.category)} (${top.total})</div>`;
    }
    if (data && data.aiUsed === false) {
      html += '<div class="ai-note">Подключите AI-провайдера для развёрнутой истории.</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  },

  escape(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  render() {
    const container = document.getElementById('ai-cfo-content');
    if (!container) return;
    const defaultMonth = this.currentMonth();
    container.innerHTML = `
      <div class="ai-cfo" role="region" aria-label="AI Финансовый директор">
        <div class="ai-header">
          <h3>🤖 AI Финансовый директор</h3>
          <div class="ai-actions" role="group" aria-label="Действия ассистента">
            <button type="button" id="ai-insights-btn" class="btn btn-secondary" onclick="AiCfoModule.handleInsights()">Инсайты</button>
            <button type="button" id="ai-categorize-btn" class="btn btn-secondary" onclick="AiCfoModule.handleCategorize()">Авто-категоризация</button>
            <button type="button" id="ai-summary-btn" class="btn btn-secondary" onclick="AiCfoModule.handleSummary()">Сводка за месяц</button>
            <input id="ai-summary-month" class="form-control ai-month-input" type="month" aria-label="Месяц для сводки" value="${this.escape(defaultMonth)}">
          </div>
        </div>
        <div id="ai-insights" class="ai-insights"></div>
        <div id="ai-categorize" class="ai-categorize"></div>
        <div id="ai-summary" class="ai-summary"></div>
        <div id="ai-messages" class="ai-messages" aria-live="polite" aria-atomic="false"></div>
        <div class="ai-input-row">
          <input id="ai-input" class="form-control" type="text"
                 autocomplete="off" enterkeyhint="send" aria-label="Сообщение AI-директору"
                 placeholder="Спросите CFO о ваших финансах…"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();AiCfoModule.handleSend();}">
          <button type="button" id="ai-send-btn" class="btn btn-primary" onclick="AiCfoModule.handleSend()">Отправить</button>
        </div>
      </div>
    `;
  },

  // Текущий месяц в формате YYYY-MM (для <input type="month">).
  currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },
};

// Делаем доступным глобально (как остальные модули фронта).
if (typeof window !== 'undefined') {
  window.AiCfoModule = AiCfoModule;
}
