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

    try {
      const data = await this.sendMessage(message);
      this.appendMessage('assistant', data.reply || '(пустой ответ)');
    } catch (err) {
      this.appendMessage('error', err.message);
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
    const btn = document.getElementById('ai-send-btn');
    if (btn) btn.disabled = state;
    const ins = document.getElementById('ai-insights-btn');
    if (ins) ins.disabled = state;
  },

  appendMessage(role, text) {
    const log = document.getElementById('ai-messages');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;
    const who =
      role === 'user' ? 'Вы' : role === 'assistant' ? 'CFO' : 'Ошибка';
    div.innerHTML = `<span class="ai-msg-role">${who}</span><span class="ai-msg-text">${this.escape(text)}</span>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
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
    container.innerHTML = `
      <div class="ai-cfo">
        <div class="ai-header">
          <h3>🤖 AI Финансовый директор</h3>
          <button id="ai-insights-btn" class="btn btn-secondary" onclick="AiCfoModule.handleInsights()">Инсайты</button>
        </div>
        <div id="ai-insights" class="ai-insights"></div>
        <div id="ai-messages" class="ai-messages"></div>
        <div class="ai-input-row">
          <input id="ai-input" class="form-control" type="text"
                 placeholder="Спросите CFO о ваших финансах…"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();AiCfoModule.handleSend();}">
          <button id="ai-send-btn" class="btn btn-primary" onclick="AiCfoModule.handleSend()">Отправить</button>
        </div>
      </div>
    `;
  },
};

// Делаем доступным глобально (как остальные модули фронта).
if (typeof window !== 'undefined') {
  window.AiCfoModule = AiCfoModule;
}
