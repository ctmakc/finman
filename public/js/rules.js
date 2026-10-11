// public/js/rules.js — менеджер правил категоризации + кнопка «Применить правила».
// Детерминированные правила: description/category/amount + оператор -> категория.
// Все пользовательские данные в innerHTML проходят через escapeHtml (XSS).

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RulesModule = {
  rules: [],

  // Labels are i18n keys, resolved at render time (t() comes from i18n.js).
  FIELDS: [
    { value: 'description', key: 'common.description' },
    { value: 'category', key: 'common.category' },
    { value: 'amount', key: 'common.amount' },
  ],
  OPS: [
    { value: 'contains', key: 'rules.op.contains' },
    { value: 'equals', key: 'rules.op.equals' },
    { value: 'gt', key: 'rules.op.gt' },
    { value: 'lt', key: 'rules.op.lt' },
    { value: 'regex', key: 'rules.op.regex' },
  ],

  _authHeaders(json) {
    const h = { Authorization: `Bearer ${localStorage.getItem('token')}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  },

  async init() {
    await this.load();
  },

  async load() {
    try {
      const res = await fetch('/api/rules', { headers: this._authHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.rules = await res.json();
      this.render();
    } catch (error) {
      console.error('Error loading rules:', error);
    }
  },

  fieldLabel(v) {
    const f = this.FIELDS.find((x) => x.value === v);
    return f ? t(f.key) : v;
  },

  opLabel(v) {
    const o = this.OPS.find((x) => x.value === v);
    return o ? t(o.key) : v;
  },

  render() {
    const container = document.getElementById('rules-list');
    if (!container) return;

    const toolbar = `
      <div class="rules-toolbar">
        <button class="btn btn-primary" onclick="RulesModule.apply()"><i class="fas fa-bolt"></i> ${t('rules.apply')}</button>
        <span id="rules-apply-result" class="rules-apply-result"></span>
      </div>
      ${this.renderForm()}`;

    if (!Array.isArray(this.rules) || this.rules.length === 0) {
      container.innerHTML = toolbar + `<div class="empty-state"><p>${t('rules.empty')}</p></div>`;
      return;
    }

    const rows = this.rules
      .map(
        (r) => `
      <div class="card rule-card" data-id="${escapeHtml(r.id)}">
        <div class="rule-summary">
          <span class="rule-priority">#${escapeHtml(r.priority)}</span>
          <span class="rule-cond">
            ${escapeHtml(this.fieldLabel(r.match_field))}
            ${escapeHtml(this.opLabel(r.match_op))}
            <strong>«${escapeHtml(r.match_value)}»</strong>
            → <strong>${escapeHtml(r.set_category)}</strong>
          </span>
          <span class="rule-status ${r.is_active ? 'text-success' : 'text-secondary'}" title="${r.is_active ? t('rules.active') : t('rules.paused')}"><i class="fas ${r.is_active ? 'fa-check-circle' : 'fa-pause-circle'}"></i></span>
        </div>
        <div class="rule-actions">
          <button class="btn btn-sm" onclick="RulesModule.toggle(${escapeHtml(r.id)})">
            ${r.is_active ? t('rules.disable') : t('rules.enable')}
          </button>
          <button class="btn btn-sm btn-danger" onclick="RulesModule.remove(${escapeHtml(r.id)})">${t('btn.delete')}</button>
        </div>
      </div>`
      )
      .join('');

    container.innerHTML = toolbar + rows;
  },

  renderForm() {
    const fieldOpts = this.FIELDS.map(
      (f) => `<option value="${escapeHtml(f.value)}">${escapeHtml(t(f.key))}</option>`
    ).join('');
    const opOpts = this.OPS.map(
      (o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(t(o.key))}</option>`
    ).join('');

    return `
      <form class="rule-form" onsubmit="RulesModule.create(event)">
        <input type="number" id="rule-priority" placeholder="${escapeHtml(t('rules.priorityPlaceholder'))}" value="100" min="0" />
        <select id="rule-field">${fieldOpts}</select>
        <select id="rule-op">${opOpts}</select>
        <input type="text" id="rule-value" placeholder="${escapeHtml(t('rules.valuePlaceholder'))}" required />
        <input type="text" id="rule-category" placeholder="${escapeHtml(t('rules.categoryPlaceholder'))}" required />
        <button type="submit" class="btn btn-secondary">${t('rules.add')}</button>
      </form>`;
  },

  _val(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  },

  async create(event) {
    if (event) event.preventDefault();
    const body = {
      priority: parseInt(this._val('rule-priority'), 10) || 100,
      match_field: this._val('rule-field'),
      match_op: this._val('rule-op'),
      match_value: this._val('rule-value'),
      set_category: this._val('rule-category'),
      is_active: true,
    };
    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: this._authHeaders(true),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || t('rules.createError'));
        return;
      }
      await this.load();
    } catch (error) {
      console.error('Error creating rule:', error);
    }
  },

  async toggle(id) {
    const rule = this.rules.find((r) => String(r.id) === String(id));
    if (!rule) return;
    try {
      await fetch(`/api/rules/${id}`, {
        method: 'PUT',
        headers: this._authHeaders(true),
        body: JSON.stringify({ is_active: !rule.is_active }),
      });
      await this.load();
    } catch (error) {
      console.error('Error toggling rule:', error);
    }
  },

  async remove(id) {
    try {
      await fetch(`/api/rules/${id}`, { method: 'DELETE', headers: this._authHeaders() });
      await this.load();
    } catch (error) {
      console.error('Error deleting rule:', error);
    }
  },

  async apply() {
    const out = document.getElementById('rules-apply-result');
    if (out) out.textContent = t('rules.applying');
    try {
      const res = await fetch('/api/rules/apply', {
        method: 'POST',
        headers: this._authHeaders(true),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (out) {
        out.textContent = t('rules.updated', { n: data.updated || 0 });
      }
    } catch (error) {
      console.error('Error applying rules:', error);
      if (out) out.textContent = t('rules.applyError');
    }
  },
};

if (typeof window !== 'undefined') {
  window.RulesModule = RulesModule;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RulesModule;
}
