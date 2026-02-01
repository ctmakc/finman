// Модуль регулярных платежей

// ==================== API ====================

async function fetchRecurringPayments(includeInactive = false) {
  try {
    const response = await fetch(`/api/recurring?includeInactive=${includeInactive}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('Ошибка загрузки');
    return await response.json();
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification('Ошибка загрузки платежей', 'error');
    return [];
  }
}

async function fetchRecurringStats() {
  try {
    const response = await fetch('/api/recurring/stats', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('Ошибка');
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
    if (!response.ok) throw new Error('Ошибка');
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
    if (!response.ok) throw new Error(result.message || 'Ошибка');
    showNotification('Платеж создан', 'success');
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
    if (!response.ok) throw new Error(result.message || 'Ошибка');
    showNotification('Платеж обновлен', 'success');
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
    if (!response.ok) throw new Error('Ошибка');
    showNotification('Платеж удален', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка:', error);
    showNotification('Ошибка удаления', 'error');
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
    if (!response.ok) throw new Error(result.message || 'Ошибка');
    showNotification('Платеж отмечен как оплаченный', 'success');
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
    if (!response.ok) throw new Error(result.message || 'Ошибка');
    showNotification('Платеж пропущен', 'success');
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
    if (!response.ok) throw new Error(result.message || 'Ошибка');
    showNotification(result.payment.is_active ? 'Платеж возобновлен' : 'Платеж приостановлен', 'success');
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

  mainContent.innerHTML = `
    <div class="recurring-page">
      <header class="page-header">
        <h1 class="page-title"><i class="fas fa-sync-alt"></i> Регулярные платежи</h1>
        <button class="btn btn-primary" onclick="showAddRecurringModal()">
          <i class="fas fa-plus"></i> Добавить платеж
        </button>
      </header>

      <div class="recurring-stats" id="recurring-stats">
        <div class="loading"><i class="fas fa-spinner fa-spin"></i></div>
      </div>

      <div class="recurring-sections">
        <div class="recurring-section" id="overdue-section" style="display:none;">
          <h2><i class="fas fa-exclamation-triangle text-danger"></i> Просроченные</h2>
          <div class="payments-list" id="overdue-list"></div>
        </div>

        <div class="recurring-section" id="upcoming-section">
          <h2><i class="fas fa-clock"></i> Ближайшие (7 дней)</h2>
          <div class="payments-list" id="upcoming-list"></div>
        </div>

        <div class="recurring-section">
          <h2><i class="fas fa-list"></i> Все платежи</h2>
          <div class="filter-row">
            <label>
              <input type="checkbox" id="show-inactive" onchange="loadRecurringPayments()">
              Показать неактивные
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

async function loadRecurringStats() {
  const stats = await fetchRecurringStats();
  const container = document.getElementById('recurring-stats');

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-sync-alt"></i></div>
        <div class="stat-data">
          <div class="stat-value">${stats.active}</div>
          <div class="stat-label">Активных</div>
        </div>
      </div>
      <div class="stat-card expense">
        <div class="stat-icon"><i class="fas fa-arrow-up"></i></div>
        <div class="stat-data">
          <div class="stat-value">${formatCurrency(stats.monthlyExpenses)}</div>
          <div class="stat-label">Расходы/мес</div>
        </div>
      </div>
      <div class="stat-card income">
        <div class="stat-icon"><i class="fas fa-arrow-down"></i></div>
        <div class="stat-data">
          <div class="stat-value">${formatCurrency(stats.monthlyIncome)}</div>
          <div class="stat-label">Доходы/мес</div>
        </div>
      </div>
      <div class="stat-card ${stats.overdueCount > 0 ? 'warning' : ''}">
        <div class="stat-icon"><i class="fas fa-exclamation-circle"></i></div>
        <div class="stat-data">
          <div class="stat-value">${stats.overdueCount}</div>
          <div class="stat-label">Просрочено</div>
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
  const today = new Date().toISOString().split('T')[0];
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
    upcomingList.innerHTML = '<p class="empty-text">Нет ближайших платежей</p>';
  }

  // Все платежи
  const allList = document.getElementById('all-payments-list');
  if (payments.length > 0) {
    allList.innerHTML = payments.map(p => renderPaymentCard(p)).join('');
  } else {
    allList.innerHTML = '<p class="empty-text">Нет регулярных платежей</p>';
  }
}

function renderPaymentCard(payment, isOverdue = false) {
  const daysUntil = Math.ceil((new Date(payment.next_payment_date) - new Date()) / (1000 * 60 * 60 * 24));
  const statusClass = isOverdue ? 'overdue' : (daysUntil <= 3 ? 'soon' : '');

  return `
    <div class="payment-card ${statusClass} ${!payment.is_active ? 'inactive' : ''}" data-id="${payment.id}">
      <div class="payment-main">
        <div class="payment-icon ${payment.type}">
          <i class="fas fa-${payment.type === 'income' ? 'arrow-down' : 'arrow-up'}"></i>
        </div>
        <div class="payment-info">
          <h4>${escapeHtml(payment.name)}</h4>
          <span class="payment-account">${escapeHtml(payment.account_name)}</span>
          ${payment.category ? `<span class="payment-category">${escapeHtml(payment.category)}</span>` : ''}
        </div>
        <div class="payment-amount ${payment.type}">
          ${payment.type === 'expense' ? '-' : '+'}${formatCurrency(Math.abs(payment.amount), payment.account_currency)}
        </div>
      </div>

      <div class="payment-schedule">
        <span class="frequency">${getFrequencyLabel(payment.frequency)}</span>
        <span class="next-date ${statusClass}">
          ${isOverdue ? 'Просрочено: ' : 'Следующий: '}
          ${formatDateShort(payment.next_payment_date)}
          ${!isOverdue && daysUntil >= 0 ? `(через ${daysUntil} дн.)` : ''}
        </span>
      </div>

      <div class="payment-actions">
        ${payment.is_active ? `
          <button class="btn btn-sm btn-success" onclick="payRecurring(${payment.id})" title="Оплатить">
            <i class="fas fa-check"></i>
          </button>
          <button class="btn btn-sm btn-warning" onclick="skipRecurring(${payment.id})" title="Пропустить">
            <i class="fas fa-forward"></i>
          </button>
        ` : ''}
        <button class="btn btn-sm btn-outline" onclick="editRecurring(${payment.id})" title="Редактировать">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn btn-sm ${payment.is_active ? 'btn-secondary' : 'btn-primary'}"
                onclick="toggleRecurring(${payment.id})" title="${payment.is_active ? 'Приостановить' : 'Возобновить'}">
          <i class="fas fa-${payment.is_active ? 'pause' : 'play'}"></i>
        </button>
        <button class="btn btn-sm btn-danger" onclick="deleteRecurring(${payment.id})" title="Удалить">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `;
}

function showAddRecurringModal(payment = null) {
  const isEdit = !!payment;
  const accounts = appState.accounts?.all || appState.accounts || [];

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'recurring-modal';
  modal.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <h3>${isEdit ? 'Редактировать платеж' : 'Новый регулярный платеж'}</h3>
        <button class="btn-close" onclick="closeModal('recurring-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form id="recurring-form">
          <div class="form-row">
            <div class="form-group">
              <label>Название *</label>
              <input type="text" id="rp-name" value="${payment?.name || ''}" required placeholder="Например: Netflix">
            </div>
            <div class="form-group">
              <label>Счет *</label>
              <select id="rp-account" required>
                ${accounts.map(a => `
                  <option value="${a.id}" ${payment?.account_id === a.id ? 'selected' : ''}>
                    ${escapeHtml(a.name)}
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Сумма *</label>
              <input type="number" id="rp-amount" step="0.01" min="0" value="${payment?.amount || ''}" required>
            </div>
            <div class="form-group">
              <label>Тип</label>
              <select id="rp-type">
                <option value="expense" ${payment?.type === 'expense' ? 'selected' : ''}>Расход</option>
                <option value="income" ${payment?.type === 'income' ? 'selected' : ''}>Доход</option>
              </select>
            </div>
            <div class="form-group">
              <label>Категория</label>
              <input type="text" id="rp-category" value="${payment?.category || ''}" placeholder="Подписки">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Частота *</label>
              <select id="rp-frequency" onchange="updateFrequencyOptions()">
                <option value="daily" ${payment?.frequency === 'daily' ? 'selected' : ''}>Ежедневно</option>
                <option value="weekly" ${payment?.frequency === 'weekly' ? 'selected' : ''}>Еженедельно</option>
                <option value="biweekly" ${payment?.frequency === 'biweekly' ? 'selected' : ''}>Раз в 2 недели</option>
                <option value="monthly" ${!payment || payment?.frequency === 'monthly' ? 'selected' : ''}>Ежемесячно</option>
                <option value="quarterly" ${payment?.frequency === 'quarterly' ? 'selected' : ''}>Ежеквартально</option>
                <option value="yearly" ${payment?.frequency === 'yearly' ? 'selected' : ''}>Ежегодно</option>
              </select>
            </div>
            <div class="form-group" id="day-of-week-group" style="display:none;">
              <label>День недели</label>
              <select id="rp-day-of-week">
                <option value="0">Воскресенье</option>
                <option value="1" ${payment?.day_of_week === 1 ? 'selected' : ''}>Понедельник</option>
                <option value="2">Вторник</option>
                <option value="3">Среда</option>
                <option value="4">Четверг</option>
                <option value="5">Пятница</option>
                <option value="6">Суббота</option>
              </select>
            </div>
            <div class="form-group" id="day-of-month-group">
              <label>День месяца</label>
              <input type="number" id="rp-day-of-month" min="1" max="31" value="${payment?.day_of_month || ''}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Дата начала *</label>
              <input type="date" id="rp-start-date" value="${payment?.start_date || new Date().toISOString().split('T')[0]}" required>
            </div>
            <div class="form-group">
              <label>Дата окончания</label>
              <input type="date" id="rp-end-date" value="${payment?.end_date || ''}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group checkbox-group">
              <label>
                <input type="checkbox" id="rp-auto-create" ${payment?.auto_create ? 'checked' : ''}>
                Автоматически создавать транзакции
              </label>
            </div>
            <div class="form-group">
              <label>Напоминать за (дней)</label>
              <input type="number" id="rp-notify-before" min="0" max="30" value="${payment?.notify_before || 3}">
            </div>
          </div>

          <div class="form-group">
            <label>Описание</label>
            <textarea id="rp-description" rows="2">${payment?.description || ''}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('recurring-modal')">Отмена</button>
        <button class="btn btn-primary" onclick="saveRecurring(${payment?.id || 'null'})">
          ${isEdit ? 'Сохранить' : 'Создать'}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
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
    showNotification('Заполните обязательные поля', 'error');
    return;
  }

  let result;
  if (id) {
    result = await updateRecurringPayment(id, data);
  } else {
    result = await createRecurringPayment(data);
  }

  if (result) {
    closeModal('recurring-modal');
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
  if (!confirm('Удалить этот регулярный платеж?')) return;
  if (await deleteRecurringPayment(id)) {
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

async function payRecurring(id) {
  const createTx = confirm('Создать транзакцию?');
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
  const labels = {
    daily: 'Ежедневно',
    weekly: 'Еженедельно',
    biweekly: 'Раз в 2 недели',
    monthly: 'Ежемесячно',
    quarterly: 'Ежеквартально',
    yearly: 'Ежегодно'
  };
  return labels[frequency] || frequency;
}

function formatDateShort(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatCurrency(amount, currency = 'UAH') {
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: currency
  }).format(amount);
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.remove();
}
