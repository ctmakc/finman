// Reports Module
const ReportsModule = {
  reports: [],
  types: [],

  async init() {
    await Promise.all([this.loadReports(), this.loadTypes()]);
  },

  async loadReports() {
    try {
      const response = await fetch('/api/reports', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.reports = await response.json();
      this.renderHistory();
    } catch (error) {
      console.error('Error loading reports:', error);
    }
  },

  async loadTypes() {
    try {
      const response = await fetch('/api/reports/types', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.types = await response.json();
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
      <div class="report-type-card" onclick="ReportsModule.showGenerateModal('${t.id}')">
        <span class="report-icon">${icons[t.id] || '📄'}</span>
        <div class="report-type-info"><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p></div>
      </div>
    `).join('');
  },

  renderHistory() {
    const container = document.getElementById('reports-history');
    if (!container) return;

    if (this.reports.length === 0) {
      container.innerHTML = '<p class="text-secondary">No reports created</p>';
      return;
    }

    container.innerHTML = `<table class="table">
      <thead><tr><th>Name</th><th>Type</th><th>Period</th><th>Date</th><th></th></tr></thead>
      <tbody>
        ${this.reports.map(r => `
          <tr>
            <td>${esc(r.title)}</td>
            <td>${r.report_type}</td>
            <td>${r.period_start || ''} - ${r.period_end || ''}</td>
            <td>${new Date(r.created_at).toLocaleDateString()}</td>
            <td><button class="btn btn-sm" onclick="ReportsModule.viewReport(${r.id})">👁️</button><button class="btn btn-sm btn-danger" onclick="ReportsModule.deleteReport(${r.id})">🗑</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  },

  showGenerateModal(type) {
    document.getElementById('generate-form').reset();
    document.getElementById('report-type').value = type;
    const typeInfo = this.types.find(t => t.id === type);
    document.getElementById('generate-modal-title').textContent = typeInfo ? typeInfo.name : 'Generating report';

    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    document.getElementById('period-start').value = firstDay;
    document.getElementById('period-end').value = lastDay;

    document.getElementById('generate-modal').classList.add('active');
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify(data)
      });
      const result = await response.json();

      document.getElementById('generate-modal').classList.remove('active');
      this.showReportResult(result.report, data.report_type);
      await this.loadReports();
    } catch (error) {
      showNotification('Error generating report', 'error');
    }
  },

  async viewReport(id) {
    try {
      const response = await fetch(`/api/reports/${id}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const report = await response.json();
      this.showReportResult(report.file_data, report.report_type);
    } catch (error) {
      showNotification('Failed to load report', 'error');
    }
  },

  showReportResult(data, type) {
    const container = document.getElementById('report-result');
    let html = '<div class="report-content">';

    if (type === 'monthly' || type === 'yearly') {
      html += `
        <div class="report-summary">
          <h3>Summary</h3>
          <div class="stats-grid">
            <div class="stat-card positive"><div class="stat-value">${(data.summary?.income || 0).toLocaleString()} $</div><div class="stat-label">Income</div></div>
            <div class="stat-card negative"><div class="stat-value">${(data.summary?.expenses || 0).toLocaleString()} $</div><div class="stat-label">Expenses</div></div>
            <div class="stat-card"><div class="stat-value">${(data.summary?.balance || data.summary?.savings || 0).toLocaleString()} $</div><div class="stat-label">Balance</div></div>
          </div>
        </div>
      `;
      if (data.byCategory) {
        html += '<h3>By categories</h3><div class="categories-list">';
        data.byCategory.forEach(c => {
          html += `<div class="category-row"><span>${esc(c.category || 'Uncategorized')}</span><span>${c.total.toLocaleString()} $</span></div>`;
        });
        html += '</div>';
      }
      if (data.monthly) {
        html += '<h3>By month</h3><table class="table"><thead><tr><th>Month</th><th>Income</th><th>Expenses</th></tr></thead><tbody>';
        data.monthly.forEach(m => {
          html += `<tr><td>${m.month}</td><td class="positive">${m.income.toLocaleString()}</td><td class="negative">${m.expenses.toLocaleString()}</td></tr>`;
        });
        html += '</tbody></table>';
      }
    } else if (type === 'category') {
      html += '<h3>Expenses by category</h3><div class="categories-list">';
      (data.expenses || []).forEach(c => {
        html += `<div class="category-row"><span>${esc(c.category)}</span><span>${c.total.toLocaleString()} $</span><span>${c.percent}%</span></div>`;
      });
      html += '</div>';
    } else if (type === 'networth') {
      html += `<h3>Net Worth</h3><p>Current: <strong>${(data.current?.net_worth || 0).toLocaleString()} $</strong></p>`;
      html += `<p>Change: <strong class="${data.change >= 0 ? 'positive' : 'negative'}">${(data.change || 0).toLocaleString()} $ (${data.changePercent || 0}%)</strong></p>`;
    } else if (type === 'tax') {
      html += `
        <h3>Tax report</h3>
        <p>Total income: <strong>${(data.totalIncome || 0).toLocaleString()} $</strong></p>
        <h4>Tax estimate:</h4>
        <ul>
          <li>5% (3 group FOP): ${(data.estimatedTax5 || 0).toLocaleString()} $</li>
          <li>18% Income tax: ${(data.estimatedTax18 || 0).toLocaleString()} $</li>
          <li>SSC: ${(data.estimatedESV || 0).toLocaleString()} $</li>
        </ul>
      `;
    } else {
      html += '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
    }

    html += '</div>';
    container.innerHTML = html;
    document.getElementById('result-modal').classList.add('active');
  },

  async deleteReport(id) {
    showConfirm('Delete this report?', async () => {
      try {
        await fetch(`/api/reports/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
        await this.loadReports();
      } catch (error) {
        showNotification('Failed to delete report', 'error');
      }
    });
  },

  getPage() {
    return `
      <div class="reports-page">
        <div class="page-header"><h1>📊 Reports</h1></div>
        <div class="card"><h2>Create report</h2><div id="report-types" class="report-types-grid"></div></div>
        <div class="card"><h2>Reports history</h2><div id="reports-history"></div></div>
      </div>
      <div class="modal" id="generate-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="generate-modal-title">Generating report</h2><button class="modal-close" onclick="document.getElementById('generate-modal').classList.remove('active')">&times;</button></div>
          <form id="generate-form" onsubmit="event.preventDefault(); ReportsModule.generateReport()">
            <input type="hidden" id="report-type">
            <div class="form-row">
              <div class="form-group"><label>Period start</label><input type="date" id="period-start" class="form-control" required></div>
              <div class="form-group"><label>Period end</label><input type="date" id="period-end" class="form-control" required></div>
            </div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('generate-modal').classList.remove('active')">Cancel</button><button type="submit" class="btn btn-primary">Generate</button></div>
          </form>
        </div>
      </div>
      <div class="modal" id="result-modal">
        <div class="modal-content modal-lg">
          <div class="modal-header"><h2>Report result</h2><button class="modal-close" onclick="document.getElementById('result-modal').classList.remove('active')">&times;</button></div>
          <div id="report-result"></div>
        </div>
      </div>
    `;
  }
};
