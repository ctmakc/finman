// public/js/ai.js — AI Financial CFO chat panel + Insights + dashboard Insights block.
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
          ? t('ai.err.notConfigured')
          : err.code === 'PAYMENT_REQUIRED'
          ? t('ai.err.pro')
          : (err.message || t('ai.err.request', { status: response.status }));
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
        const e = new Error(payload.message || t('ai.err.stream'));
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
          if (textEl) textEl.textContent = finalText || t('ai.emptyReply');
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
    if (container) container.innerHTML = `<div class="ai-loading">${t('ai.categorize.loading')}</div>`;

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
        container.innerHTML = `<div class="ai-note">${t('ai.categorize.applied', { n: res.applied || 0 })}</div>`;
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
    if (container) container.innerHTML = `<div class="ai-loading">${t('ai.summary.loading')}</div>`;

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
    if (container) container.innerHTML = `<div class="ai-loading">${t('ai.insights.loading')}</div>`;

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

  async loadPlan() {
    const response = await fetch('/api/ai/plan', { headers: this.authHeaders() });
    return this.parse(response);
  },

  async handlePlan() {
    if (this.loading) return;
    this.setLoading(true);
    const container = document.getElementById('ai-plan');
    if (container) container.innerHTML = `<div class="ai-loading">${t('ai.plan.loading')}</div>`;
    try {
      const data = await this.loadPlan();
      this.renderPlan(data);
    } catch (err) {
      if (container) container.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
    } finally {
      this.setLoading(false);
    }
  },

  renderPlan(data) {
    const container = document.getElementById('ai-plan');
    if (!container || !data) return;
    const p = data.plan || {};
    const cur = (p.goals && p.goals[0] && p.goals[0].currency) ||
                (p.debts && p.debts[0] && p.debts[0].currency) || '';
    const fmt = (n) => this.fmtMoney(n, cur);
    const perMonth = t('ai.plan.perMonth');
    const rows = [];
    rows.push(`<div class="ai-plan-stat"><span>${t('ai.plan.savingsRate')}</span><strong>${this.escape(String(p.currentSavingsRate))}%</strong></div>`);
    rows.push(`<div class="ai-plan-stat"><span>${t('ai.plan.target')}</span><strong>${this.escape(String(p.targetSavingsRate))}% · ${fmt(p.targetMonthlySavings)}${perMonth}</strong></div>`);
    if (typeof p.savingsGap === 'number' && p.savingsGap > 0) {
      rows.push(`<div class="ai-plan-stat ai-plan-warn"><span>${t('ai.plan.cut')}</span><strong>${fmt(p.savingsGap)}${perMonth}</strong></div>`);
    }
    let goalsHtml = '';
    (p.goals || []).forEach((g) => {
      goalsHtml += `<li><strong>${this.escape(g.name)}</strong> — ${t('ai.plan.remaining', { amount: fmt(g.remaining) })}` +
        `${g.monthlyNeeded ? `, ${fmt(g.monthlyNeeded)}${perMonth}` : ''}` +
        `${g.monthsLeft ? ` ${t('ai.plan.monthsLeft', { n: this.escape(String(g.monthsLeft)) })}` : ''}</li>`;
    });
    let debtsHtml = '';
    (p.debts || []).forEach((d) => {
      debtsHtml += `<li><strong>${this.escape(d.name)}</strong> — ${fmt(d.remaining)}</li>`;
    });
    const aiHtml = (data.aiConfigured && data.planText)
      ? `<div class="ai-plan-ai">${this.escape(data.planText).replace(/\n/g, '<br>')}</div>`
      : `<div class="ai-plan-note">${t('ai.plan.connect')}</div>`;
    container.innerHTML = `
      <div class="ai-plan-card">
        <h4>${t('ai.plan.title')}</h4>
        <div class="ai-plan-stats">${rows.join('')}</div>
        ${goalsHtml ? `<div class="ai-plan-section"><h5>${t('ai.plan.goals')}</h5><ul>${goalsHtml}</ul></div>` : ''}
        ${debtsHtml ? `<div class="ai-plan-section"><h5>${t('ai.plan.debts')}</h5><ul>${debtsHtml}</ul></div>` : ''}
        ${aiHtml}
      </div>`;
  },

  handleWhatif() {
    const container = document.getElementById('ai-whatif');
    if (!container) return;
    container.innerHTML = `
      <div class="ai-whatif-form">
        <h4>${t('ai.whatif.title')}</h4>
        <div class="ai-whatif-row">
          <input id="wi-category" class="form-control" type="text" placeholder="${this.escape(t('ai.whatif.categoryPh'))}" aria-label="${this.escape(t('ai.whatif.categoryAria'))}">
          <input id="wi-percent" class="form-control ai-whatif-num" type="number" min="0" max="100" value="20" aria-label="${this.escape(t('ai.whatif.percentAria'))}">
          <span class="ai-whatif-unit">${t('ai.whatif.cut')}</span>
        </div>
        <div class="ai-whatif-row">
          <input id="wi-extra" class="form-control ai-whatif-num" type="number" min="0" value="0" aria-label="${this.escape(t('ai.whatif.extraAria'))}">
          <span class="ai-whatif-unit">${t('ai.whatif.extra', { cur: this.escape(this.baseCurrency()) })}</span>
          <button type="button" id="ai-whatif-run" class="btn btn-primary" onclick="AiCfoModule.handleWhatifRun()">${t('ai.whatif.run')}</button>
        </div>
        <div id="ai-whatif-result"></div>
      </div>`;
  },

  async handleWhatifRun() {
    if (this.loading) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const category = (val('wi-category') || '').trim();
    const percent = Number(val('wi-percent') || 0);
    const extra = Number(val('wi-extra') || 0);
    const cuts = category ? [{ category, percent }] : [];
    const out = document.getElementById('ai-whatif-result');
    if (out) out.innerHTML = `<div class="ai-loading">${t('ai.whatif.loading')}</div>`;
    this.setLoading(true);
    try {
      const response = await fetch('/api/ai/whatif', {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({ cuts, extraMonthlySaving: extra }),
      });
      const data = await this.parse(response);
      this.renderWhatif(data);
    } catch (err) {
      if (out) out.innerHTML = `<div class="ai-error">${this.escape(err.message)}</div>`;
    } finally {
      this.setLoading(false);
    }
  },

  renderWhatif(data) {
    const out = document.getElementById('ai-whatif-result');
    if (!out || !data) return;
    const r = data.result || {};
    const b = r.baseline || {};
    const s = r.scenario || {};
    const fmt = (n) => (n === null || n === undefined ? '—' : this.escape(String(n)));
    const money = (n) => this.fmtMoney(n);
    let goals = '';
    (r.goals || []).forEach((g) => {
      const sooner = g.monthsSaved && g.monthsSaved > 0 ? ` — ${t('ai.whatif.sooner', { n: this.escape(String(g.monthsSaved)) })}` : '';
      goals += `<li><strong>${this.escape(g.name)}</strong>: ${fmt(g.monthsBaseline)} → <strong>${fmt(g.monthsScenario)}</strong> ${t('ai.whatif.months')}${sooner}</li>`;
    });
    const ai = (data.aiConfigured && data.narrative)
      ? `<div class="ai-plan-ai">${this.escape(data.narrative).replace(/\n/g, '<br>')}</div>` : '';
    out.innerHTML = `
      <div class="ai-whatif-card">
        <div class="ai-whatif-ba">
          <div class="ai-whatif-col"><span>${t('ai.whatif.now')}</span><strong>${money(b.monthlyNet)}</strong><em>${fmt(b.savingsRate)}%</em></div>
          <div class="ai-whatif-arrow">→</div>
          <div class="ai-whatif-col ai-whatif-after"><span>${t('ai.whatif.scenario')}</span><strong>${money(s.monthlyNet)}</strong><em>${fmt(s.savingsRate)}%</em></div>
        </div>
        ${s.monthlyFreed ? `<p class="ai-whatif-freed">${t('ai.whatif.freed', { amount: `<strong>${money(s.monthlyFreed)}</strong>` })}</p>` : ''}
        ${goals ? `<ul class="ai-whatif-goals">${goals}</ul>` : ''}
        ${ai}
      </div>`;
  },

  // --- rendering ---------------------------------------------------------

  setLoading(state) {
    this.loading = state;
    ['ai-send-btn', 'ai-plan-btn', 'ai-whatif-btn', 'ai-whatif-run', 'ai-insights-btn', 'ai-categorize-btn', 'ai-summary-btn'].forEach((id) => {
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
      role === 'user' ? t('ai.you') : role === 'assistant' ? t('ai.cfo.short') : t('ai.roleError');
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
    html += `<h4>${t('ai.insights.title')}</h4>`;
    html += `<div class="ai-insights-summary">${t('common.income')}: <b>${this.fmtFigure(a.recentIncome)}</b> · ${t('common.expense')}: <b>${this.fmtFigure(a.recentExpense)}</b> · ${t('ai.insights.savings')}: <b>${this.escape(String(a.savingsRate || 0))}%</b></div>`;

    if (cats.length) {
      html += '<ul class="ai-cat-list">';
      cats.forEach((c) => {
        html += `<li><span>${this.escape(c.category)}</span><span>${this.fmtFigure(c.total)} (${this.escape(String(c.sharePercent))}%)</span></li>`;
      });
      html += '</ul>';
    }

    if (a.budgetsOverLimit && a.budgetsOverLimit.length) {
      html += `<div class="ai-warning">${t('ai.insights.overBudget', { list: a.budgetsOverLimit.map((b) => this.escape(b)).join(', ') })}</div>`;
    }

    if (data && data.insight) {
      html += `<div class="ai-insight-text">${this.escape(data.insight)}</div>`;
    } else if (data && data.aiConfigured === false) {
      html += `<div class="ai-note">${t('ai.insights.connect')}</div>`;
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
        msg = t('ai.categorize.noCategories');
      } else if (!total) {
        msg = t('ai.categorize.allDone');
      } else {
        msg = t('ai.categorize.noMatches');
      }
      container.innerHTML = `<div class="ai-note">${this.escape(msg)}</div>`;
      return;
    }

    let html = `<div class="ai-cat-suggest"><h4>${t('ai.categorize.title')}</h4><ul class="ai-cat-suggest-list">`;
    suggestions.forEach((s) => {
      html += `<li>
        <label>
          <input type="checkbox" checked data-tx="${Number(s.transactionId)}" data-cat="${this.escape(s.suggestedCategory)}">
          <span class="ai-cat-desc">${this.escape(s.description || t('ai.categorize.noDesc'))}</span>
          <span class="ai-cat-amt">${this.escape(String(s.amount))}</span>
          <span class="ai-cat-arrow">→</span>
          <span class="ai-cat-name">${this.escape(s.suggestedCategory)}</span>
        </label>
      </li>`;
    });
    html += '</ul>';
    html += `<button id="ai-apply-cat-btn" class="btn btn-primary" onclick="AiCfoModule.handleApplyCategorize()">${t('ai.categorize.apply')}</button>`;
    html += '</div>';
    container.innerHTML = html;
  },

  renderSummary(data) {
    const container = document.getElementById('ai-summary');
    if (!container) return;
    const stats = (data && data.stats) || {};

    let html = '<div class="ai-summary-card">';
    html += `<h4>${t('ai.summary.title', { month: this.escape((data && data.month) || '') })}</h4>`;
    if (data && data.narrative) {
      html += `<p class="ai-summary-text">${this.escape(data.narrative)}</p>`;
    }
    html += `<div class="ai-summary-stats">${t('common.income')}: <b>${this.fmtFigure(stats.totalIncome)}</b> · ${t('common.expense')}: <b>${this.fmtFigure(stats.totalExpense)}</b> · ${t('ai.summary.net')}: <b>${this.fmtFigure(stats.netFlow)}</b> · ${t('ai.insights.savings')}: <b>${this.escape(String(stats.savingsRate || 0))}%</b></div>`;
    const top = (stats.topCategories || [])[0];
    if (top) {
      html += `<div class="ai-summary-top">${t('ai.summary.top', { category: this.escape(top.category), total: this.fmtFigure(top.total) })}</div>`;
    }
    if (data && data.aiUsed === false) {
      html += `<div class="ai-note">${t('ai.summary.connect')}</div>`;
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

  // User's base currency (lib/ui.js caches /api/currency/settings; app.js keeps appState).
  baseCurrency() {
    try {
      if (typeof UI !== 'undefined' && typeof UI.baseCurrency === 'function') return UI.baseCurrency();
      if (typeof appState !== 'undefined' && appState.baseCurrency) return appState.baseCurrency;
    } catch (e) { /* ignore */ }
    return 'CAD';
  },

  // Money in the given (or base) currency, HTML-escaped; '—' when there is no value.
  fmtMoney(value, currency) {
    if (value === null || value === undefined || value === '') return '—';
    const cur = currency || this.baseCurrency();
    try {
      if (typeof UI !== 'undefined' && typeof UI.money === 'function') return this.escape(UI.money(value, cur));
      if (typeof formatCurrency === 'function') return this.escape(formatCurrency(value, cur));
    } catch (e) { /* fall through */ }
    return this.escape(`${value} ${cur}`.trim());
  },

  render() {
    const container = document.getElementById('ai-cfo-content');
    if (!container) return;
    const defaultMonth = this.currentMonth();
    container.innerHTML = `
      <div class="ai-cfo" role="region" aria-label="${this.escape(t('ai.cfo.title'))}">
        <div class="ai-header">
          <h3>${t('ai.cfo.title')}</h3>
          <div class="ai-actions" role="group" aria-label="${this.escape(t('ai.cfo.actions'))}">
            <button type="button" id="ai-plan-btn" class="btn btn-primary" onclick="AiCfoModule.handlePlan()">${t('ai.plan.btn')}</button>
            <button type="button" id="ai-whatif-btn" class="btn btn-secondary" onclick="AiCfoModule.handleWhatif()">${t('ai.whatif.btn')}</button>
            <button type="button" id="ai-insights-btn" class="btn btn-secondary" onclick="AiCfoModule.handleInsights()">${t('ai.insights.btn')}</button>
            <button type="button" id="ai-categorize-btn" class="btn btn-secondary" onclick="AiCfoModule.handleCategorize()">${t('ai.categorize.btn')}</button>
            <button type="button" id="ai-summary-btn" class="btn btn-secondary" onclick="AiCfoModule.handleSummary()">${t('ai.summary.btn')}</button>
            <input id="ai-summary-month" class="form-control ai-month-input" type="month" aria-label="${this.escape(t('ai.summary.monthAria'))}" value="${this.escape(defaultMonth)}">
          </div>
        </div>
        <div id="ai-plan" class="ai-plan"></div>
        <div id="ai-whatif" class="ai-whatif"></div>
        <div id="ai-insights" class="ai-insights"></div>
        <div id="ai-categorize" class="ai-categorize"></div>
        <div id="ai-summary" class="ai-summary"></div>
        <div id="ai-messages" class="ai-messages" aria-live="polite" aria-atomic="false"></div>
        <div class="ai-input-row">
          <input id="ai-input" class="form-control" type="text"
                 autocomplete="off" enterkeyhint="send" aria-label="${this.escape(t('ai.cfo.inputAria'))}"
                 placeholder="${this.escape(t('ai.cfo.placeholder'))}"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();AiCfoModule.handleSend();}">
          <button type="button" id="ai-send-btn" class="btn btn-primary" onclick="AiCfoModule.handleSend()">${t('ai.send')}</button>
        </div>
      </div>
    `;
  },

  // --- Dashboard "Insights" block (PORT_PLAN A8/A15) ------------------------
  // Consumes GET /api/ai/alerts, /api/ai/insights/monthly, /api/ai/insights/weekly.
  // Rendered into a host element on the dashboard by SmartDashboard.init() through
  // renderDashboardInsights(hostId). DOM is built with createElement + addEventListener
  // (no inline handlers, no inline style attributes — bar heights go through the CSSOM).

  async loadAlerts() {
    const response = await fetch('/api/ai/alerts', { headers: this.authHeaders() });
    return this.parse(response);
  },

  async loadDigest() {
    const response = await fetch('/api/ai/digest', { headers: this.authHeaders() });
    return this.parse(response);
  },

  async loadMonthlyInsight({ month, refresh } = {}) {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (refresh) params.set('refresh', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(`/api/ai/insights/monthly${qs}`, { headers: this.authHeaders() });
    return this.parse(response);
  },

  async loadWeeklyBrief() {
    const response = await fetch('/api/ai/insights/weekly', { headers: this.authHeaders() });
    return this.parse(response);
  },

  // Compact number formatting for digest figures (no currency: the digest sums all
  // accounts of the user, so a symbol here would be a guess).
  fmtFigure(value) {
    const n = Number(value) || 0;
    try {
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n));
    } catch (e) {
      return String(Math.round(n));
    }
  },

  // Small DOM helper: el('div', 'class-a class-b', 'text') -> HTMLElement
  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  },

  // Human label for the digest period "YYYY-MM" (English, matching the new strings).
  periodLabel(period) {
    if (!period || !/^\d{4}-\d{2}$/.test(period)) return '';
    const [y, m] = period.split('-').map((x) => parseInt(x, 10));
    try {
      return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    } catch (e) {
      return period;
    }
  },

  // Entry point: builds the block skeleton, loads the three endpoints in parallel, renders.
  async renderDashboardInsights(hostId) {
    const host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId;
    if (!host) return;
    host.textContent = '';
    host.classList.add('ai-dash');

    // Header row: eyebrow + period + actions.
    const head = this.el('div', 'ai-dash-head');
    const eyebrow = this.el('span', 'ai-dash-eyebrow');
    eyebrow.appendChild(this.el('span', 'ai-dash-dot'));
    eyebrow.appendChild(document.createTextNode('Insights'));
    const period = this.el('span', 'ai-dash-period', '');
    const actions = this.el('div', 'ai-dash-actions');
    const refreshBtn = this.el('button', 'btn btn-sm ai-dash-refresh', 'Refresh');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('aria-label', 'Regenerate insights');
    const askBtn = this.el('button', 'btn btn-sm ai-dash-ask', 'Ask the CFO');
    askBtn.type = 'button';
    actions.appendChild(refreshBtn);
    actions.appendChild(askBtn);
    head.appendChild(eyebrow);
    head.appendChild(period);
    head.appendChild(actions);

    const alerts = this.el('div', 'ai-dash-alerts');
    alerts.setAttribute('role', 'list');
    alerts.setAttribute('aria-label', 'Alerts');
    const grid = this.el('div', 'ai-dash-grid');
    const monthly = this.el('article', 'ai-dash-panel ai-dash-monthly');
    const weekly = this.el('article', 'ai-dash-panel ai-dash-weekly');
    grid.appendChild(monthly);
    grid.appendChild(weekly);

    host.appendChild(head);
    host.appendChild(alerts);
    host.appendChild(grid);

    const navToAi = () => {
      const link = document.querySelector('[data-page="ai"]');
      if (link) link.click();
    };
    askBtn.addEventListener('click', navToAi);

    const load = async (refresh) => {
      host.classList.add('is-loading');
      refreshBtn.disabled = true;
      this.renderInsightSkeleton(monthly, 3);
      this.renderInsightSkeleton(weekly, 2);
      const [alertsRes, monthlyRes, weeklyRes] = await Promise.all([
        this.loadAlerts().catch((e) => ({ error: e })),
        this.loadMonthlyInsight({ refresh }).catch((e) => ({ error: e })),
        this.loadWeeklyBrief().catch((e) => ({ error: e })),
      ]);
      period.textContent = alertsRes && !alertsRes.error ? this.periodLabel(alertsRes.period) : '';
      this.renderAlertsStrip(alerts, alertsRes);
      this.renderMonthlyPanel(monthly, monthlyRes);
      this.renderWeeklyPanel(weekly, weeklyRes);
      host.classList.remove('is-loading');
      refreshBtn.disabled = false;
      // Entrance: one short staggered reveal (transform/opacity only; CSS honours reduced motion).
      host.classList.remove('is-ready');
      requestAnimationFrame(() => host.classList.add('is-ready'));
    };

    refreshBtn.addEventListener('click', () => load(true));
    await load(false);
  },

  renderInsightSkeleton(panel, lines) {
    panel.textContent = '';
    panel.setAttribute('aria-busy', 'true');
    for (let i = 0; i < lines; i += 1) {
      panel.appendChild(this.el('div', `ai-dash-skel ai-dash-skel-${i % 3}`));
    }
  },

  // Error line shared by the panels: 402 (Pro) and 503 (no provider) are plain notes, not alarms.
  renderInsightError(panel, err) {
    panel.textContent = '';
    panel.removeAttribute('aria-busy');
    const note = this.el('p', 'ai-dash-note');
    note.textContent =
      err && err.code === 'PAYMENT_REQUIRED'
        ? 'Insights are part of the Pro plan.'
        : err && err.code === 'AI_NOT_CONFIGURED'
        ? 'Connect an AI provider on the server to unlock generated insights.'
        : 'Insights are unavailable right now.';
    panel.appendChild(note);
  },

  renderAlertsStrip(container, res) {
    container.textContent = '';
    if (!res || res.error) {
      container.hidden = true;
      return;
    }
    const list = Array.isArray(res.alerts) ? res.alerts : [];
    container.hidden = false;
    if (!list.length) {
      const calm = this.el('div', 'ai-dash-alert ai-dash-alert-calm');
      calm.setAttribute('role', 'listitem');
      calm.appendChild(this.el('span', 'ai-dash-alert-bar'));
      calm.appendChild(this.el('span', 'ai-dash-alert-text', 'No alerts this month. Budgets and spending are on track.'));
      container.appendChild(calm);
      return;
    }
    list.slice(0, 4).forEach((a) => {
      const row = this.el('div', `ai-dash-alert ai-dash-alert-${a.severity || 'medium'}`);
      row.setAttribute('role', 'listitem');
      row.appendChild(this.el('span', 'ai-dash-alert-bar'));
      row.appendChild(this.el('span', 'ai-dash-alert-type', String(a.type || 'alert').toUpperCase()));
      row.appendChild(this.el('span', 'ai-dash-alert-text', a.message || ''));
      container.appendChild(row);
    });
    if (list.length > 4) {
      container.appendChild(this.el('div', 'ai-dash-alert-more', `+${list.length - 4} more`));
    }
  },

  renderMonthlyPanel(panel, res) {
    if (!res || res.error) return this.renderInsightError(panel, res && res.error);
    panel.textContent = '';
    panel.removeAttribute('aria-busy');
    const insight = res.insight || {};

    const title = this.el('h4', 'ai-dash-title', 'Monthly story');
    if (res.cached) title.appendChild(this.el('span', 'ai-dash-tag', 'cached'));
    panel.appendChild(title);

    const figures = this.el('dl', 'ai-dash-figures');
    const fig = (label, value, cls) => {
      const wrap = this.el('div', `ai-dash-figure${cls ? ` ${cls}` : ''}`);
      wrap.appendChild(this.el('dt', null, label));
      wrap.appendChild(this.el('dd', null, value));
      figures.appendChild(wrap);
    };
    fig('Income', this.fmtFigure(insight.totalIncome), 'in');
    fig('Spent', this.fmtFigure(insight.totalSpent), 'out');
    const rate = Number(insight.savingsRate);
    fig('Savings rate', Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—', rate < 0 ? 'out' : '');
    panel.appendChild(figures);

    panel.appendChild(this.el('p', 'ai-dash-text', insight.text || ''));

    const foot = this.el('div', 'ai-dash-foot');
    foot.appendChild(
      this.el('span', 'ai-dash-source', res.aiUsed ? 'Generated from your digest' : 'Computed from your transactions')
    );
    panel.appendChild(foot);
  },

  renderWeeklyPanel(panel, res) {
    if (!res || res.error) return this.renderInsightError(panel, res && res.error);
    panel.textContent = '';
    panel.removeAttribute('aria-busy');

    panel.appendChild(this.el('h4', 'ai-dash-title', 'Weekly brief'));

    // 7-day bar strip from dailyTotals (heights via CSSOM custom property).
    const daily = Array.isArray(res.dailyTotals) ? res.dailyTotals : [];
    if (daily.length) {
      const max = Math.max(...daily.map((d) => Number(d.spent) || 0), 1);
      const bars = this.el('div', 'ai-dash-bars');
      bars.setAttribute('role', 'img');
      bars.setAttribute('aria-label', `Daily spending over the last 7 days, peak ${this.fmtFigure(max)}`);
      daily.slice(-7).forEach((d) => {
        const bar = this.el('span', 'ai-dash-bar');
        // Square-root scale: a single big day (rent) must not flatten the other six to nothing.
        const pct = Math.max(6, Math.round(Math.sqrt((Number(d.spent) || 0) / max) * 100));
        bar.style.setProperty('--h', `${pct}%`);
        bar.title = `${d.date}: ${this.fmtFigure(d.spent)}`;
        bars.appendChild(bar);
      });
      panel.appendChild(bars);
    }

    const figures = this.el('dl', 'ai-dash-figures ai-dash-figures-compact');
    const fig = (label, value, cls) => {
      const wrap = this.el('div', `ai-dash-figure${cls ? ` ${cls}` : ''}`);
      wrap.appendChild(this.el('dt', null, label));
      wrap.appendChild(this.el('dd', null, value));
      figures.appendChild(wrap);
    };
    fig('Spent', this.fmtFigure(res.totalSpent), 'out');
    fig('Earned', this.fmtFigure(res.totalEarned), 'in');
    fig('Transactions', String(res.transactionCount || 0), '');
    panel.appendChild(figures);

    panel.appendChild(this.el('p', 'ai-dash-text', res.brief || ''));
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
