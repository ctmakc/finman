// ==================== RECONCILE (сверка счёта с выпиской) ====================
// Панель сверки: выбираем счёт, вводим баланс по выписке, видим расхождение
// (delta) и список непроведённых транзакций. Можно отметить транзакции как
// проведённые (cleared) или закрыть расхождение одной корректировкой.
//
// Зависит от глобальных хелперов приложения: fetchWithAuth, showNotification,
// formatCurrency. escapeHtml определяем локально (user-data попадает в innerHTML).

// Полное HTML-экранирование (включая кавычки — безопасно и в атрибутах).
function reconcileEscapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Текущее состояние панели (последний расчёт сверки).
let _reconcileState = { accountId: null, statementBalance: null };

async function renderReconcilePage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const accounts = await fetchWithAuth('/api/accounts?includeShared=false')
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? d : (d.own || d.all || [])));

    const options = accounts
      .map(
        (a) =>
          `<option value="${a.id}">${reconcileEscapeHtml(a.name)} (${formatCurrency(
            a.balance,
            a.currency
          )})</option>`
      )
      .join('');

    mainContent.innerHTML = `
      <div class="reconcile-page">
        <div class="page-header">
          <h1><i class="fas fa-balance-scale"></i> Сверка счёта</h1>
        </div>
        <div class="card">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Счёт</label>
              <select id="reconcile-account" class="form-control">${options || ''}</select>
            </div>
            <div class="form-group">
              <label class="form-label">Баланс по выписке</label>
              <input type="number" id="reconcile-statement" class="form-control" step="0.01" placeholder="0.00">
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end">
              <button class="btn btn-primary" onclick="runReconcile()"><i class="fas fa-sync"></i> Сверить</button>
            </div>
          </div>
        </div>
        <div id="reconcile-result"></div>
      </div>`;
  } catch (e) {
    mainContent.innerHTML = '<div class="alert alert-error">Ошибка загрузки</div>';
  }
}

async function runReconcile() {
  const accountId = document.getElementById('reconcile-account').value;
  const statementBalance = parseFloat(
    document.getElementById('reconcile-statement').value
  );
  if (!accountId) {
    showNotification('Выберите счёт', 'error');
    return;
  }
  if (!Number.isFinite(statementBalance)) {
    showNotification('Введите баланс по выписке', 'error');
    return;
  }
  _reconcileState = { accountId, statementBalance };
  const box = document.getElementById('reconcile-result');
  box.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const res = await fetchWithAuth(
      `/api/reconcile/${accountId}?statementBalance=${encodeURIComponent(statementBalance)}`
    );
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error((json.error && json.error.message) || 'Ошибка сверки');
    }
    box.innerHTML = renderReconcileResult(json.data);
  } catch (e) {
    box.innerHTML = `<div class="alert alert-error">${reconcileEscapeHtml(e.message)}</div>`;
  }
}

function renderReconcileResult(data) {
  const deltaClass = data.reconciled ? 'text-success' : 'text-danger';
  const rows = (data.uncleared || [])
    .map((t) => {
      const isSuspect = (data.suspect || []).some((s) => s.id === t.id);
      return `<tr class="${isSuspect ? 'reconcile-suspect' : ''}">
        <td><input type="checkbox" class="reconcile-cb" value="${t.id}" ${
        isSuspect ? 'checked' : ''
      }></td>
        <td>${reconcileEscapeHtml(t.date)}</td>
        <td>${reconcileEscapeHtml(t.description || '')}</td>
        <td>${reconcileEscapeHtml(t.category || '')}</td>
        <td class="${t.amount >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(
        t.amount
      )}</td>
      </tr>`;
    })
    .join('');

  const status = data.reconciled
    ? '<span class="text-success"><i class="fas fa-check-circle"></i> Сходится</span>'
    : `<span class="${deltaClass}"><i class="fas fa-exclamation-triangle"></i> Расхождение ${formatCurrency(
        data.delta
      )}</span>`;

  return `
    <div class="card">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(
          data.clearedBalance
        )}</div><div class="stat-label">Очищенный баланс</div></div></div>
        <div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(
          data.statementBalance
        )}</div><div class="stat-label">По выписке</div></div></div>
        <div class="stat-card"><div class="stat-data"><div class="stat-value ${deltaClass}">${formatCurrency(
          data.delta
        )}</div><div class="stat-label">Расхождение</div></div></div>
      </div>
      <p style="margin:0.5rem 0">${status}</p>
      ${
        (data.uncleared || []).length === 0
          ? '<div class="empty-state"><i class="fas fa-check"></i><h3>Все транзакции проведены</h3></div>'
          : `<table class="table reconcile-table">
              <thead><tr><th></th><th>Дата</th><th>Описание</th><th>Категория</th><th>Сумма</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <div class="reconcile-actions" style="margin-top:0.75rem;display:flex;gap:0.5rem">
              <button class="btn btn-outline" onclick="clearSelectedReconcile()"><i class="fas fa-check"></i> Отметить выбранные</button>
              ${
                data.reconciled
                  ? ''
                  : `<button class="btn btn-primary" onclick="postReconcileAdjustment()"><i class="fas fa-wand-magic-sparkles"></i> Закрыть корректировкой</button>`
              }
            </div>`
      }
    </div>`;
}

async function clearSelectedReconcile() {
  const txIds = Array.from(document.querySelectorAll('.reconcile-cb:checked')).map(
    (cb) => parseInt(cb.value, 10)
  );
  if (txIds.length === 0) {
    showNotification('Ничего не выбрано', 'error');
    return;
  }
  try {
    const res = await fetchWithAuth(
      `/api/reconcile/${_reconcileState.accountId}/clear`,
      { method: 'POST', body: JSON.stringify({ txIds }) }
    );
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error((json.error && json.error.message) || 'Ошибка');
    }
    showNotification(`Отмечено: ${json.data.updated}`, 'success');
    runReconcile();
  } catch (e) {
    showNotification(e.message, 'error');
  }
}

async function postReconcileAdjustment() {
  if (!confirm('Создать балансирующую корректировку на величину расхождения?')) return;
  try {
    const res = await fetchWithAuth(
      `/api/reconcile/${_reconcileState.accountId}/adjust`,
      {
        method: 'POST',
        body: JSON.stringify({ statementBalance: _reconcileState.statementBalance }),
      }
    );
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error((json.error && json.error.message) || 'Ошибка');
    }
    showNotification('Корректировка создана', 'success');
    runReconcile();
  } catch (e) {
    showNotification(e.message, 'error');
  }
}

window.renderReconcilePage = renderReconcilePage;
window.runReconcile = runReconcile;
window.clearSelectedReconcile = clearSelectedReconcile;
window.postReconcileAdjustment = postReconcileAdjustment;
