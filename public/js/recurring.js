// Модуль регулярных платежей

// ==================== API ====================

async function fetchRecurringPayments(includeInactive = false) {
  try {
    const response = await fetch(`/api/recurring?includeInactive=${includeInactive}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error(t('recurring.loadError'));
    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(t('recurring.loadError'), 'error');
    return [];
  }
}

async function fetchRecurringStats() {
  try {
    const response = await fetch('/api/recurring/stats', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error(t('msg.error'));
    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    return { total: 0, active: 0, monthlyExpenses: 0, monthlyIncome: 0, upcomingCount: 0, overdueCount: 0 };
  }
}

async function fetchUpcomingPayments(days = 7) {
  try {
    const response = await fetch(`/api/recurring/upcoming?days=${days}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error(t('msg.error'));
    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    return [];
  }
}

async function createRecurringPayment(data) {
  try {
    const response = await fetch('/api/recurring', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || t('msg.error'));
    showNotification(t('recurring.created'), 'success');
    return result.payment;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function updateRecurringPayment(id, data) {
  try {
    const response = await fetch(`/api/recurring/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || t('msg.error'));
    showNotification(t('recurring.updated'), 'success');
    return result.payment;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function deleteRecurringPayment(id) {
  try {
    const response = await fetch(`/api/recurring/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error(t('msg.error'));
    showNotification(t('recurring.deleted'), 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(t('recurring.deleteError'), 'error');
    return false;
  }
}

async function markPaymentAsPaid(id, createTransaction = true) {
  try {
    const response = await fetch(`/api/recurring/${id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ createTransaction })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || t('msg.error'));
    showNotification(t('recurring.paid'), 'success');
    return result;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function skipPayment(id) {
  try {
    const response = await fetch(`/api/recurring/${id}/skip`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || t('msg.error'));
    showNotification(t('recurring.skipped'), 'success');
    return result;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

async function togglePayment(id) {
  try {
    const response = await fetch(`/api/recurring/${id}/toggle`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || t('msg.error'));
    showNotification(result.payment.is_active ? t('recurring.resumed') : t('recurring.paused'), 'success');
    return result.payment;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification(error.message, 'error');
    return null;
  }
}

// ==================== UI ====================

async function renderRecurringPage() {
  const mainContent = document.getElementById('main-content');
  await UI.loadBaseCurrency();

  mainContent.innerHTML = `
    <div class="recurring-page">
      <header class="page-header">
        <h1 class="page-title"><i class="fas fa-sync-alt"></i> ${t('recurring.title')}</h1>
        <button type="button" class="btn btn-primary" data-action="recurring:add">
          <i class="fas fa-plus"></i> ${t('recurring.add')}
        </button>
      </header>

      <div class="recurring-stats" id="recurring-stats">
        <div class="loading"><i class="fas fa-spinner fa-spin"></i></div>
      </div>

      <div class="recurring-sections">
        <div class="recurring-section" id="overdue-section" style="display:none;">
          <h2><i class="fas fa-exclamation-triangle text-danger"></i> ${t('recurring.overdue')}</h2>
          <div class="payments-list" id="overdue-list"></div>
        </div>

        <div class="recurring-section" id="upcoming-section">
          <h2><i class="fas fa-clock"></i> ${t('recurring.upcoming')}</h2>
          <div class="payments-list" id="upcoming-list"></div>
        </div>

        <div class="recurring-section">
          <h2><i class="fas fa-list"></i> ${t('recurring.all')}</h2>
          <div class="filter-row">
            <label>
              <input type="checkbox" id="show-inactive" data-change="recurring:reload">
              ${t('recurring.showInactive')}
            </label>
          </div>
          <div class="payments-list" id="all-payments-list"></div>
        </div>
      </div>
    </div>
  `;

  await loadRecurringStats();
  await loadRecurringPayments();
}

// Месячные суммы считаем по списку платежей в валюте СЧЁТА каждого платежа
// (API складывает все валюты в одно число). Счётчики берём из API.
function monthlyTotalsByCurrency(payments, type) {
  const active = (payments || []).filter(p => p.is_active && p.type === type);
  return UI.sumByCurrency(active, p => Math.abs(Number(p.amount) || 0) * UI.monthlyFactor(p.frequency), p => p.account_currency);
}

async function loadRecurringStats(payments) {
  const stats = await fetchRecurringStats();
  const container = document.getElementById('recurring-stats');
  if (!container) return;
  const list = payments || await fetchRecurringPayments(false);
  const expenses = monthlyTotalsByCurrency(list, 'expense');
  const income = monthlyTotalsByCurrency(list, 'income');

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-sync-alt"></i></div>
        <div class="stat-data">
          <div class="stat-value">${stats.active}</div>
          <div class="stat-label">${t('recurring.stats.active')}</div>
        </div>
      </div>
      <div class="stat-card expense">
        <div class="stat-icon"><i class="fas fa-arrow-up"></i></div>
        <div class="stat-data">
          <div class="stat-value">${UI.moneyList(expenses)}</div>
          <div class="stat-label">${t('recurring.stats.expensesPerMonth')}</div>
        </div>
      </div>
      <div class="stat-card income">
        <div class="stat-icon"><i class="fas fa-arrow-down"></i></div>
        <div class="stat-data">
          <div class="stat-value">${UI.moneyList(income)}</div>
          <div class="stat-label">${t('recurring.stats.incomePerMonth')}</div>
        </div>
      </div>
      <div class="stat-card ${stats.overdueCount > 0 ? 'warning' : ''}">
        <div class="stat-icon"><i class="fas fa-exclamation-circle"></i></div>
        <div class="stat-data">
          <div class="stat-value">${stats.overdueCount}</div>
          <div class="stat-label">${t('recurring.stats.overdue')}</div>
        </div>
      </div>
    </div>
  `;
}

async function loadRecurringPayments() {
  const includeInactive = document.getElementById('show-inactive')?.checked || false;
  const payments = await fetchRecurringPayments(includeInactive);
  const upcoming = await fetchUpcomingPayments(7);

  // Просроченные
  const today = UI.todayYMD();
  const overdue = payments.filter(p => p.is_active && p.next_payment_date < today);

  const overdueSection = document.getElementById('overdue-section');
  const overdueList = document.getElementById('overdue-list');

  if (overdue.length > 0) {
    overdueSection.style.display = 'block';
    overdueList.innerHTML = overdue.map(p => renderPaymentCard(p, true)).join('');
  } else {
    overdueSection.style.display = 'none';
  }

  // Ближайшие
  const upcomingList = document.getElementById('upcoming-list');
  const upcomingFiltered = upcoming.filter(p => p.next_payment_date >= today);

  if (upcomingFiltered.length > 0) {
    upcomingList.innerHTML = upcomingFiltered.map(p => renderPaymentCard(p)).join('');
  } else {
    upcomingList.innerHTML = `<p class="empty-text">${t('recurring.empty.upcoming')}</p>`;
  }

  // Все платежи
  const allList = document.getElementById('all-payments-list');
  if (payments.length > 0) {
    allList.innerHTML = payments.map(p => renderPaymentCard(p)).join('');
  } else {
    allList.innerHTML = `<p class="empty-text">${t('recurring.empty.all')}</p>`;
  }
}

function renderPaymentCard(payment, isOverdue = false) {
  // Whole local days between today and the next payment date.
  const next = UI.parseYMD(payment.next_payment_date);
  const todayDate = UI.parseYMD(UI.todayYMD());
  const daysUntil = next ? Math.round((next - todayDate) / (1000 * 60 * 60 * 24)) : NaN;
  // Whitelisted: it lands in a class attribute.
  const typeClass = payment.type === 'income' ? 'income' : 'expense';
  const statusClass = isOverdue ? 'overdue' : (daysUntil <= 3 ? 'soon' : '');

  return `
    <div class="payment-card ${statusClass} ${!payment.is_active ? 'inactive' : ''}" data-id="${UI.esc(payment.id)}">
      <div class="payment-main">
        <div class="payment-icon ${typeClass}">
          <i class="fas fa-${payment.type === 'income' ? 'arrow-down' : 'arrow-up'}"></i>
        </div>
        <div class="payment-info">
          <h4>${escapeHtmlRecurring(payment.name)}</h4>
          <span class="payment-account">${escapeHtmlRecurring(payment.account_name)}</span>
          ${payment.category ? `<span class="payment-category">${escapeHtmlRecurring(payment.category)}</span>` : ''}
        </div>
        <div class="payment-amount ${typeClass}">
          ${payment.type === 'expense' ? '-' : '+'}${UI.esc(UI.money(Math.abs(payment.amount), payment.account_currency))}
        </div>
      </div>

      <div class="payment-schedule">
        <span class="frequency">${getFrequencyLabel(payment.frequency)}</span>
        <span class="next-date ${statusClass}">
          ${isOverdue ? t('recurring.card.overdue') : t('recurring.card.next')}
          ${formatDateShort(payment.next_payment_date)}
          ${!isOverdue && daysUntil >= 0 ? daysUntilLabel(daysUntil) : ''}
        </span>
      </div>

      <div class="payment-actions">
        ${payment.is_active ? `
          <button type="button" class="btn btn-sm btn-success" data-action="recurring:pay" data-id="${UI.esc(payment.id)}" title="${t('recurring.action.pay')}" aria-label="${t('recurring.action.pay')}">
            <i class="fas fa-check"></i>
          </button>
          <button type="button" class="btn btn-sm btn-warning" data-action="recurring:skip" data-id="${UI.esc(payment.id)}" title="${t('recurring.action.skip')}" aria-label="${t('recurring.action.skip')}">
            <i class="fas fa-forward"></i>
          </button>
        ` : ''}
        <button type="button" class="btn btn-sm btn-outline" data-action="recurring:edit" data-id="${UI.esc(payment.id)}" title="${t('btn.edit')}" aria-label="${t('btn.edit')}">
          <i class="fas fa-edit"></i>
        </button>
        <button type="button" class="btn btn-sm ${payment.is_active ? 'btn-secondary' : 'btn-primary'}"
                data-action="recurring:toggle" data-id="${UI.esc(payment.id)}" title="${payment.is_active ? t('recurring.action.pause') : t('recurring.action.resume')}" aria-label="${payment.is_active ? t('recurring.action.pause') : t('recurring.action.resume')}">
          <i class="fas fa-${payment.is_active ? 'pause' : 'play'}"></i>
        </button>
        <button type="button" class="btn btn-sm btn-danger" data-action="recurring:delete" data-id="${UI.esc(payment.id)}" title="${t('btn.delete')}" aria-label="${t('btn.delete')}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `;
}

function showAddRecurringModal(payment = null) {
  const isEdit = !!payment;
  const accounts = UI.accountsArray();

  const body = `
        <form id="recurring-form" data-submit="recurring:save" data-id="${payment?.id || ''}">
          <div class="form-row">
            <div class="form-group">
              <label>${t('common.name')} *</label>
              <input type="text" id="rp-name" value="${UI.esc(payment?.name || '')}" required placeholder="${t('recurring.field.namePlaceholder')}">
            </div>
            <div class="form-group">
              <label>${t('recurring.field.account')} *</label>
              <select id="rp-account" required>
                ${accounts.map(a => `
                  <option value="${UI.esc(a.id)}" ${payment?.account_id === a.id ? 'selected' : ''}>
                    ${escapeHtmlRecurring(a.name)}
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>${t('common.amount')} *</label>
              <input type="number" id="rp-amount" step="0.01" min="0" value="${UI.esc(payment?.amount || '')}" required>
            </div>
            <div class="form-group">
              <label>${t('common.type')}</label>
              <select id="rp-type">
                <option value="expense" ${payment?.type === 'expense' ? 'selected' : ''}>${t('common.expense')}</option>
                <option value="income" ${payment?.type === 'income' ? 'selected' : ''}>${t('common.income')}</option>
              </select>
            </div>
            <div class="form-group">
              <label>${t('common.category')}</label>
              <input type="text" id="rp-category" value="${UI.esc(payment?.category || '')}" placeholder="${t('recurring.field.categoryPlaceholder')}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>${t('recurring.field.frequency')} *</label>
              <select id="rp-frequency" data-change="recurring:frequency">
                <option value="daily" ${payment?.frequency === 'daily' ? 'selected' : ''}>${t('recurring.freq.daily')}</option>
                <option value="weekly" ${payment?.frequency === 'weekly' ? 'selected' : ''}>${t('recurring.freq.weekly')}</option>
                <option value="biweekly" ${payment?.frequency === 'biweekly' ? 'selected' : ''}>${t('recurring.freq.biweekly')}</option>
                <option value="monthly" ${!payment || payment?.frequency === 'monthly' ? 'selected' : ''}>${t('recurring.freq.monthly')}</option>
                <option value="quarterly" ${payment?.frequency === 'quarterly' ? 'selected' : ''}>${t('recurring.freq.quarterly')}</option>
                <option value="yearly" ${payment?.frequency === 'yearly' ? 'selected' : ''}>${t('recurring.freq.yearly')}</option>
              </select>
            </div>
            <div class="form-group" id="day-of-week-group" style="display:none;">
              <label>${t('recurring.field.dayOfWeek')}</label>
              <select id="rp-day-of-week">
                <option value="0">${t('recurring.day.0')}</option>
                <option value="1" ${payment?.day_of_week === 1 ? 'selected' : ''}>${t('recurring.day.1')}</option>
                <option value="2">${t('recurring.day.2')}</option>
                <option value="3">${t('recurring.day.3')}</option>
                <option value="4">${t('recurring.day.4')}</option>
                <option value="5">${t('recurring.day.5')}</option>
                <option value="6">${t('recurring.day.6')}</option>
              </select>
            </div>
            <div class="form-group" id="day-of-month-group">
              <label>${t('recurring.field.dayOfMonth')}</label>
              <input type="number" id="rp-day-of-month" min="1" max="31" value="${UI.esc(payment?.day_of_month || '')}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>${t('recurring.field.startDate')} *</label>
              <input type="date" id="rp-start-date" value="${UI.esc(payment?.start_date || UI.todayYMD())}" required>
            </div>
            <div class="form-group">
              <label>${t('recurring.field.endDate')}</label>
              <input type="date" id="rp-end-date" value="${UI.esc(payment?.end_date || '')}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group checkbox-group">
              <label>
                <input type="checkbox" id="rp-auto-create" ${payment?.auto_create ? 'checked' : ''}>
                ${t('recurring.field.autoCreate')}
              </label>
            </div>
            <div class="form-group">
              <label>${t('recurring.field.notifyBefore')}</label>
              <input type="number" id="rp-notify-before" min="0" max="30" value="${UI.esc(payment?.notify_before ?? 3)}">
            </div>
          </div>

          <div class="form-group">
            <label>${t('common.description')}</label>
            <textarea id="rp-description" rows="2">${UI.esc(payment?.description || '')}</textarea>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" data-action="ui:close">${t('btn.cancel')}</button>
            <button type="submit" class="btn btn-primary">${isEdit ? t('btn.save') : t('btn.create')}</button>
          </div>
        </form>`;
  UI.modal({ id: 'recurring-modal', size: 'lg', title: isEdit ? t('recurring.modal.edit') : t('recurring.modal.new'), body });
  updateFrequencyOptions();
}

function updateFrequencyOptions() {
  const frequency = document.getElementById('rp-frequency').value;
  const dayOfWeekGroup = document.getElementById('day-of-week-group');
  const dayOfMonthGroup = document.getElementById('day-of-month-group');

  if (frequency === 'weekly' || frequency === 'biweekly') {
    dayOfWeekGroup.style.display = 'block';
    dayOfMonthGroup.style.display = 'none';
  } else if (['monthly', 'quarterly', 'yearly'].includes(frequency)) {
    dayOfWeekGroup.style.display = 'none';
    dayOfMonthGroup.style.display = 'block';
  } else {
    dayOfWeekGroup.style.display = 'none';
    dayOfMonthGroup.style.display = 'none';
  }
}

async function saveRecurring(id) {
  const data = {
    accountId: parseInt(document.getElementById('rp-account').value),
    name: document.getElementById('rp-name').value.trim(),
    description: document.getElementById('rp-description').value.trim(),
    amount: parseFloat(document.getElementById('rp-amount').value),
    type: document.getElementById('rp-type').value,
    category: document.getElementById('rp-category').value.trim(),
    frequency: document.getElementById('rp-frequency').value,
    dayOfMonth: parseInt(document.getElementById('rp-day-of-month').value) || null,
    dayOfWeek: parseInt(document.getElementById('rp-day-of-week').value) || null,
    startDate: document.getElementById('rp-start-date').value,
    endDate: document.getElementById('rp-end-date').value || null,
    autoCreate: document.getElementById('rp-auto-create').checked,
    notifyBefore: parseInt(document.getElementById('rp-notify-before').value) || 3
  };

  if (!data.name || !data.amount || !data.startDate) {
    showNotification(t('recurring.fillRequired'), 'error');
    return;
  }

  let result;
  if (id) {
    result = await updateRecurringPayment(id, data);
  } else {
    result = await createRecurringPayment(data);
  }

  if (result) {
    UI.closeModal('recurring-modal');
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

async function editRecurring(id) {
  const response = await fetch(`/api/recurring/${id}`, {
    headers: { 'Authorization': `Bearer ${appState.token}` }
  });
  if (response.ok) {
    const payment = await response.json();
    showAddRecurringModal(payment);
  }
}

async function deleteRecurring(id) {
  if (!confirm(t('recurring.confirmDelete'))) return;
  if (await deleteRecurringPayment(id)) {
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

async function payRecurring(id) {
  const createTx = confirm(t('recurring.confirmCreateTx'));
  if (await markPaymentAsPaid(id, createTx)) {
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

async function skipRecurring(id) {
  if (await skipPayment(id)) {
    await loadRecurringPayments();
  }
}

async function toggleRecurring(id) {
  if (await togglePayment(id)) {
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

function getFrequencyLabel(frequency) {
  const known = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
  return known.includes(frequency) ? t('recurring.freq.' + frequency) : frequency;
}

// «(in 3 days)» / «(today)» next to the next-payment date.
function daysUntilLabel(days) {
  if (days === 0) return t('recurring.card.today');
  if (days === 1) return t('recurring.card.inOneDay');
  return t('recurring.card.inDays', { n: days });
}

// Date locale follows the UI language (app.js numberLocale: en-CA / uk-UA / ru-RU).
function recurringDateLocale() {
  if (typeof numberLocale === 'function') return numberLocale();
  const lang = (typeof i18n !== 'undefined' && i18n.getLanguage) ? i18n.getLanguage() : 'en';
  return lang === 'uk' ? 'uk-UA' : lang === 'ru' ? 'ru-RU' : 'en-CA';
}

// «1 дек.» для текущего года, «1 дек. 2025» — для любого другого: иначе
// просроченный с прошлого года платёж выглядит как будущий.
function formatDateShort(dateStr) {
  // 'YYYY-MM-DD' is a local calendar date (new Date() would read it as UTC).
  const date = UI.parseYMD(dateStr);
  if (!date) return '';
  const opts = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(recurringDateLocale(), opts);
}

// HTML-экранирование и форматирование денег — общие (lib/ui.js). Раньше здесь
// жили глобальные formatCurrency('UAH')/escapeHtml/closeModal, которые
// перекрывали одноимённые функции app.js для всех модулей.
function escapeHtmlRecurring(text) {
  return UI.esc(text);
}

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'recurring:add': () => showAddRecurringModal(),
    'recurring:reload': () => loadRecurringPayments(),
    'recurring:frequency': () => updateFrequencyOptions(),
    'recurring:save': (form) => saveRecurring(form.dataset.id ? Number(form.dataset.id) : null),
    'recurring:pay': (el) => payRecurring(Number(el.dataset.id)),
    'recurring:skip': (el) => skipRecurring(Number(el.dataset.id)),
    'recurring:edit': (el) => editRecurring(Number(el.dataset.id)),
    'recurring:toggle': (el) => toggleRecurring(Number(el.dataset.id)),
    'recurring:delete': (el) => deleteRecurring(Number(el.dataset.id)),
  });
})();
