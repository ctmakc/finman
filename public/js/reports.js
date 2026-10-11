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
    this.currencies = await UI.loadAccountCurrencies();
    await Promise.all([this.loadReports(), this.loadTypes()]);
  },

  // Money formatter for server-side aggregates.
  fmt(n) {
    return UI.esc(UI.aggregateMoney(n || 0, this.currencies));
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

  renderTypes() {
    const container = document.getElementById('report-types');
    if (!container) return;

    const icons = { monthly: '📅', yearly: '📊', category: '🏷️', networth: '💰', budget: '📋', investments: '📈', tax: '🧾' };

    container.innerHTML = this.types.map(t => `
      <div class="report-type-card" data-action="reports:generate-modal" data-type="${UI.esc(t.id)}" role="button" tabindex="0">
        <span class="report-icon">${icons[t.id] || '📄'}</span>
        <div class="report-type-info"><h3>${UI.esc(t.name)}</h3><p>${UI.esc(t.description)}</p></div>
      </div>
    `).join('');
  },

  renderHistory() {
    const container = document.getElementById('reports-history');
    if (!container) return;

    if (this.reports.length === 0) {
      container.innerHTML = UI.emptyState({
        icon: 'fa-file-lines',
        title: 'Нет созданных отчётов',
        text: 'Выберите тип отчёта выше — готовый отчёт сохранится здесь, его можно открыть или скачать в PDF.'
      });
      return;
    }

    container.innerHTML = `<table class="table">
      <thead><tr><th>Название</th><th>Тип</th><th>Период</th><th>Дата</th><th></th></tr></thead>
      <tbody>
        ${this.reports.map(r => `
          <tr>
            <td>${UI.esc(r.title)}</td>
            <td>${UI.esc(r.report_type)}</td>
            <td>${UI.esc(r.period_start || '')} - ${UI.esc(r.period_end || '')}</td>
            <td>${new Date(r.created_at).toLocaleDateString()}</td>
            <td>
              <button type="button" class="btn btn-sm" data-action="reports:view" data-id="${r.id}" aria-label="Открыть отчёт" title="Открыть">👁️</button>
              <button type="button" class="btn btn-sm" data-action="reports:pdf" data-id="${r.id}" title="Скачать PDF">⬇️ PDF</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="reports:delete" data-id="${r.id}" aria-label="Удалить отчёт" title="Удалить">🗑</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  },

  showGenerateModal(type) {
    document.getElementById('generate-form').reset();
    document.getElementById('report-type').value = type;
    const typeInfo = this.types.find(t => t.id === type);
    document.getElementById('generate-modal-title').textContent = typeInfo ? typeInfo.name : 'Генерация отчёта';

    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    document.getElementById('period-start').value = firstDay;
    document.getElementById('period-end').value = lastDay;

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
      const result = await response.json();

      UI.closeModal('generate-modal');
      this.showReportResult(result.report, data.report_type);
      await this.loadReports();
    } catch (error) {
      alert('Ошибка генерации отчёта');
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
      alert('Ошибка генерации PDF-отчёта');
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
      alert('Ошибка скачивания PDF');
    }
  },

  async viewReport(id) {
    try {
      const response = await fetch(`/api/reports/${Number(id)}`, { headers: this.headers() });
      const report = await response.json();
      this.showReportResult(report.file_data, report.report_type);
    } catch (error) {
      alert('Ошибка загрузки');
    }
  },

  showReportResult(data, type) {
    const container = document.getElementById('report-result');
    data = data || {};
    const esc = UI.esc;
    let html = '<div class="report-content">' + UI.mixedCurrencyNote(this.currencies);

    if (type === 'monthly' || type === 'yearly') {
      const s = data.summary || {};
      html += `
        <div class="report-summary">
          <h3>Сводка</h3>
          <div class="stats-grid">
            <div class="stat-card positive"><div class="stat-value">${this.fmt(s.income)}</div><div class="stat-label">Доходы</div></div>
            <div class="stat-card negative"><div class="stat-value">${this.fmt(s.expenses)}</div><div class="stat-label">Расходы</div></div>
            <div class="stat-card"><div class="stat-value">${this.fmt(s.balance != null ? s.balance : s.savings)}</div><div class="stat-label">Баланс</div></div>
          </div>
        </div>
      `;
      if (data.byCategory) {
        html += '<h3>По категориям</h3><div class="categories-list">';
        data.byCategory.forEach(c => {
          html += `<div class="category-row"><span>${esc(c.category || 'Без категории')}</span><span>${this.fmt(c.total)}</span></div>`;
        });
        html += '</div>';
      }
      if (data.monthly) {
        html += '<h3>По месяцам</h3><table class="table"><thead><tr><th>Месяц</th><th>Доходы</th><th>Расходы</th></tr></thead><tbody>';
        data.monthly.forEach(m => {
          html += `<tr><td>${esc(m.month)}</td><td class="positive">${this.fmt(m.income)}</td><td class="negative">${this.fmt(m.expenses)}</td></tr>`;
        });
        html += '</tbody></table>';
      }
    } else if (type === 'category') {
      html += '<h3>Расходы по категориям</h3><div class="categories-list">';
      (data.expenses || []).forEach(c => {
        html += `<div class="category-row"><span>${esc(c.category)}</span><span>${this.fmt(c.total)}</span><span>${esc(c.percent)}%</span></div>`;
      });
      html += '</div>';
    } else if (type === 'networth') {
      const base = (data.current && data.current.base_currency) || UI.baseCurrency();
      html += `<h3>Net Worth</h3><p>Текущий: <strong>${esc(UI.money((data.current && data.current.net_worth) || 0, base))}</strong></p>`;
      html += `<p>Изменение: <strong class="${data.change >= 0 ? 'positive' : 'negative'}">${esc(UI.money(data.change || 0, base))} (${esc(data.changePercent || 0)}%)</strong></p>`;
    } else if (type === 'tax') {
      html += `
        <h3>Налоговый отчёт</h3>
        <p>Общий доход: <strong>${this.fmt(data.totalIncome)}</strong></p>
        <h4>Оценка налогов:</h4>
        <ul>
          <li>5% (3 группа ФОП): ${this.fmt(data.estimatedTax5)}</li>
          <li>18% НДФЛ: ${this.fmt(data.estimatedTax18)}</li>
          <li>ЕСВ: ${this.fmt(data.estimatedESV)}</li>
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
    if (!confirm('Удалить отчёт?')) return;
    try {
      await fetch(`/api/reports/${Number(id)}`, { method: 'DELETE', headers: this.headers() });
      await this.loadReports();
    } catch (error) {
      alert('Ошибка');
    }
  },

  getPage() {
    return `
      <div class="reports-page">
        <div class="page-header"><h1>📊 Отчёты</h1></div>
        <div class="card"><h2>Создать отчёт</h2><div id="report-types" class="report-types-grid"></div></div>
        <div class="card"><h2>История отчётов</h2><div id="reports-history"></div></div>
      </div>
      <div class="modal-backdrop" id="generate-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title" id="generate-modal-title">Генерация отчёта</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
          <div class="modal-body">
            <form id="generate-form" data-submit="reports:generate">
              <input type="hidden" id="report-type">
              <div class="form-row">
                <div class="form-group"><label for="period-start">Начало периода</label><input type="date" id="period-start" class="form-control" required></div>
                <div class="form-group"><label for="period-end">Конец периода</label><input type="date" id="period-end" class="form-control" required></div>
              </div>
              <div class="form-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button>
                <button type="button" class="btn" data-action="reports:generate-pdf">📄 PDF</button>
                <button type="submit" class="btn btn-primary">Сгенерировать</button>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div class="modal-backdrop" id="result-modal" hidden>
        <div class="modal modal-lg">
          <div class="modal-header"><h2 class="modal-title">Результат отчёта</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
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
