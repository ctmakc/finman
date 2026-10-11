// Reports Module
// Report figures come from the server summed across all accounts, so they are
// formatted with a currency only when every account shares one (otherwise a
// plain number plus a visible note). Modals use the lib/ui.js convention.
const ReportsModule = {
  reports: [],
  types: [],
  currencies: [],

  headers() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  async init() {
    await UI.loadBaseCurrency();
    await Promise.all([this.loadReports(), this.loadTypes()]);
  },

  // Money formatter: report totals are in the report's currency (server lib/fx).
  fmt(n) {
    return UI.esc(UI.convertedMoney(n || 0, this.reportCurrency));
  },

  async loadReports() {
    try {
      const response = await fetch('/api/reports', { headers: this.headers() });
      const data = await response.json();
      this.reports = Array.isArray(data) ? data : [];
      this.renderHistory();
    } catch (error) {
      console.error('Error loading reports:', error);
    }
  },

  async loadTypes() {
    try {
      const response = await fetch('/api/reports/types', { headers: this.headers() });
      const data = await response.json();
      this.types = Array.isArray(data) ? data : [];
      this.renderTypes();
    } catch (error) {
      console.error('Error loading types:', error);
    }
  },

  // Report types come from the server with Russian names; prefer the client
  // dictionary when it has a key for the id, fall back to the server string.
  typeLabel(rt, field) {
    const key = 'reports.' + (field === 'description' ? 'typeDesc.' : 'typeName.') + rt.id;
    const val = t(key);
    return val !== key ? val : (rt[field] || '');
  },

  renderTypes() {
    const container = document.getElementById('report-types');
    if (!container) return;

    const icons = { monthly: 'fa-calendar-alt', yearly: 'fa-chart-bar', category: 'fa-tags', networth: 'fa-coins', budget: 'fa-clipboard-list', investments: 'fa-chart-line', tax: 'fa-file-invoice-dollar' };

    container.innerHTML = this.types.map(rt => `
      <div class="report-type-card" data-action="reports:generate-modal" data-type="${UI.esc(rt.id)}" role="button" tabindex="0">
        <span class="report-icon"><i class="fas ${icons[rt.id] || 'fa-file-alt'}"></i></span>
        <div class="report-type-info"><h3>${UI.esc(this.typeLabel(rt, 'name'))}</h3><p>${UI.esc(this.typeLabel(rt, 'description'))}</p></div>
      </div>
    `).join('');
  },

  renderHistory() {
    const container = document.getElementById('reports-history');
    if (!container) return;

    if (this.reports.length === 0) {
      container.innerHTML = UI.emptyState({
        icon: 'fa-file-lines',
        title: t('reports.empty.title'),
        text: t('reports.empty.body')
      });
      return;
    }

    container.innerHTML = `<table class="table">
      <thead><tr><th>${t('common.name')}</th><th>${t('common.type')}</th><th>${t('reports.period')}</th><th>${t('common.date')}</th><th></th></tr></thead>
      <tbody>
        ${this.reports.map(r => `
          <tr>
            <td>${UI.esc(r.title)}</td>
            <td>${UI.esc(this.typeLabel({ id: r.report_type, name: r.report_type }, 'name'))}</td>
            <td>${UI.esc(r.period_start || '')} - ${UI.esc(r.period_end || '')}</td>
            <td>${new Date(r.created_at).toLocaleDateString(i18n.getLanguage())}</td>
            <td>
              <button type="button" class="btn btn-sm" data-action="reports:view" data-id="${r.id}" aria-label="${t('reports.open')}" title="${t('reports.open')}"><i class="fas fa-eye"></i></button>
              <button type="button" class="btn btn-sm" data-action="reports:pdf" data-id="${r.id}" title="${t('reports.downloadPdf')}"><i class="fas fa-download"></i> PDF</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="reports:delete" data-id="${r.id}" aria-label="${t('reports.deleteReport')}" title="${t('btn.delete')}"><i class="fas fa-trash"></i></button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  },

  showGenerateModal(type) {
    document.getElementById('generate-form').reset();
    document.getElementById('report-type').value = type;
    const typeInfo = this.types.find(rt => rt.id === type);
    document.getElementById('generate-modal-title').textContent = typeInfo ? this.typeLabel(typeInfo, 'name') : t('reports.generate');

    const { start, end } = UI.monthRange(new Date());
    document.getElementById('period-start').value = start;
    document.getElementById('period-end').value = end;

    UI.openModal('generate-modal');
  },

  async generateReport() {
    const data = {
      report_type: document.getElementById('report-type').value,
      period_start: document.getElementById('period-start').value,
      period_end: document.getElementById('period-end').value
    };

    try {
      const response = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(data)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) throw new Error((result && result.message) || 'generate failed');

      UI.closeModal('generate-modal');
      // POST /api/reports/generate returns the report body as `data`.
      this.showReportResult(result.data || result.report, data.report_type);
      await this.loadReports();
    } catch (error) {
      alert(t('reports.generateError'));
    }
  },

  // wave-2 pdf-reports: сгенерировать настоящий PDF и сразу предложить скачать.
  async generatePdfReport(reportType) {
    const type = reportType || (document.getElementById('report-type') || {}).value || 'monthly';
    const startEl = document.getElementById('period-start');
    const endEl = document.getElementById('period-end');
    const payload = {
      report_type: type,
      format: 'pdf',
      period_start: startEl ? startEl.value : undefined,
      period_end: endEl ? endEl.value : undefined
    };

    try {
      const response = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('generate failed');
      const result = await response.json();

      UI.closeModal('generate-modal');

      await this.loadReports();
      if (result && result.id) {
        await this.downloadPdf(result.id);
      }
    } catch (error) {
      alert(t('reports.pdfError'));
    }
  },

  // Скачивает PDF отчёта по id (стрим из /:id/download) как файл в браузере.
  async downloadPdf(id) {
    try {
      const response = await fetch(`/api/reports/${Number(id)}/download`, { headers: this.headers() });
      if (!response.ok) throw new Error('download failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert(t('reports.downloadError'));
    }
  },

  async viewReport(id) {
    try {
      const response = await fetch(`/api/reports/${Number(id)}`, { headers: this.headers() });
      if (!response.ok) throw new Error('load failed');
      const report = await response.json();
      this.showReportResult(this.parseReportData(report.data || report.file_data), report.report_type);
    } catch (error) {
      alert(t('msg.loadError'));
    }
  },

  // reports.file_data is stored as a JSON string; tolerate objects and junk.
  parseReportData(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  },

  showReportResult(data, type) {
    const container = document.getElementById('report-result');
    data = data || {};
    const esc = UI.esc;
    this.reportCurrency = data.currency || data.baseCurrency || null;
    let html = '<div class="report-content">' + UI.missingRatesNote(data.missingRates);

    if (type === 'monthly' || type === 'yearly') {
      const s = data.summary || {};
      html += `
        <div class="report-summary">
          <h3>${t('reports.summary')}</h3>
          <div class="stats-grid">
            <div class="stat-card positive"><div class="stat-value">${this.fmt(s.income)}</div><div class="stat-label">${t('common.income')}</div></div>
            <div class="stat-card negative"><div class="stat-value">${this.fmt(s.expenses)}</div><div class="stat-label">${t('reports.expenses')}</div></div>
            <div class="stat-card"><div class="stat-value">${this.fmt(s.balance != null ? s.balance : s.savings)}</div><div class="stat-label">${t('common.balance')}</div></div>
          </div>
        </div>
      `;
      if (data.byCategory) {
        html += `<h3>${t('reports.byCategory')}</h3><div class="categories-list">`;
        data.byCategory.forEach(c => {
          html += `<div class="category-row"><span>${esc(c.category || t('reports.noCategory'))}</span><span>${this.fmt(c.total)}</span></div>`;
        });
        html += '</div>';
      }
      if (data.monthly) {
        html += `<h3>${t('reports.byMonth')}</h3><table class="table"><thead><tr><th>${t('reports.month')}</th><th>${t('common.income')}</th><th>${t('reports.expenses')}</th></tr></thead><tbody>`;
        data.monthly.forEach(m => {
          html += `<tr><td>${esc(m.month)}</td><td class="positive">${this.fmt(m.income)}</td><td class="negative">${this.fmt(m.expenses)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
    } else if (type === 'category') {
      html += `<h3>${t('reports.byCategory')}</h3><div class="categories-list">`;
      (data.expenses || []).forEach(c => {
        html += `<div class="category-row"><span>${esc(c.category)}</span><span>${this.fmt(c.total)}</span><span>${esc(c.percent)}%</span></div>`;
      });
      html += '</div>';
    } else if (type === 'networth') {
      const base = (data.current && data.current.base_currency) || UI.baseCurrency();
      html += `<h3>${t('reports.netWorth')}</h3><p>${t('reports.current')}: <strong>${esc(UI.money((data.current && data.current.net_worth) || 0, base))}</strong></p>`;
      html += `<p>${t('reports.change')}: <strong class="${data.change >= 0 ? 'positive' : 'negative'}">${esc(UI.money(data.change || 0, base))} (${esc(data.changePercent || 0)}%)</strong></p>`;
    } else if (type === 'tax') {
      html += `
        <h3>${t('reports.tax.title')}</h3>
        <p>${t('reports.totalIncome')}: <strong>${this.fmt(data.totalIncome)}</strong></p>
        <h4>${t('reports.tax.estimate')}</h4>
        <ul>
          <li>${t('reports.tax.group3')}: ${this.fmt(data.estimatedTax5)}</li>
          <li>${t('reports.tax.pit')}: ${this.fmt(data.estimatedTax18)}</li>
          <li>${t('reports.tax.ssc')}: ${this.fmt(data.estimatedESV)}</li>
        </ul>
      `;
    } else {
      html += '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>';
    }

    html += '</div>';
    container.innerHTML = html;
    UI.openModal('result-modal');
  },

  async deleteReport(id) {
    if (!confirm(t('reports.confirmDelete'))) return;
    try {
      await fetch(`/api/reports/${Number(id)}`, { method: 'DELETE', headers: this.headers() });
      await this.loadReports();
    } catch (error) {
      alert(t('msg.error'));
    }
  },

  getPage() {
    return `
      <div class="reports-page">
        <div class="page-header"><h1><i class="fas fa-file-alt"></i> ${t('reports.title')}</h1></div>
        <div class="card"><h2>${t('reports.createTitle')}</h2><div id="report-types" class="report-types-grid"></div></div>
        <div class="card"><h2>${t('reports.history')}</h2><div id="reports-history"></div></div>
      </div>
      <div class="modal-backdrop" id="generate-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title" id="generate-modal-title">${t('reports.generate')}</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="${t('btn.close')}">&times;</button></div>
          <div class="modal-body">
            <form id="generate-form" data-submit="reports:generate">
              <input type="hidden" id="report-type">
              <div class="form-row">
                <div class="form-group"><label for="period-start">${t('reports.periodStart')}</label><input type="date" id="period-start" class="form-control" required></div>
                <div class="form-group"><label for="period-end">${t('reports.periodEnd')}</label><input type="date" id="period-end" class="form-control" required></div>
              </div>
              <div class="form-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:close">${t('btn.cancel')}</button>
                <button type="button" class="btn" data-action="reports:generate-pdf"><i class="fas fa-file-pdf"></i> PDF</button>
                <button type="submit" class="btn btn-primary">${t('reports.generate')}</button>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div class="modal-backdrop" id="result-modal" hidden>
        <div class="modal modal-lg">
          <div class="modal-header"><h2 class="modal-title">${t('reports.result')}</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="${t('btn.close')}">&times;</button></div>
          <div class="modal-body" id="report-result"></div>
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
    'reports:generate-modal': (el) => ReportsModule.showGenerateModal(el.dataset.type),
    'reports:generate': () => ReportsModule.generateReport(),
    'reports:generate-pdf': () => ReportsModule.generatePdfReport(),
    'reports:view': (el) => ReportsModule.viewReport(el.dataset.id),
    'reports:pdf': (el) => ReportsModule.downloadPdf(el.dataset.id),
    'reports:delete': (el) => ReportsModule.deleteReport(el.dataset.id),
  });
})();
