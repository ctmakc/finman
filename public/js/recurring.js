// Recurring Payments Module

// ==================== API ====================

async function fetchRecurringPayments(includeInactive = false) {
  try {
    const response = await fetch(`/api/recurring?includeInactive=${includeInactive}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('Failed to load');
    return await response.json();
  } catch (error) {
    console.error('Error:', error);
    showNotification('Failed to load payments', 'error');
    return [];
  }
}

async function fetchRecurringStats() {
  try {
    const response = await fetch('/api/recurring/stats', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('Error');
    return await response.json();
  } catch (error) {
    console.error('Error:', error);
    return { total: 0, active: 0, monthlyExpenses: 0, monthlyIncome: 0, upcomingCount: 0, overdueCount: 0 };
  }
}

async function fetchUpcomingPayments(days = 7) {
  try {
    const response = await fetch(`/api/recurring/upcoming?days=${days}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('Error');
    return await response.json();
  } catch (error) {
    console.error('Error:', error);
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
    if (!response.ok) throw new Error(result.message || 'Error');
    showNotification('Payment created', 'success');
    return result.payment;
  } catch (error) {
    console.error('Error:', error);
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
    if (!response.ok) throw new Error(result.message || 'Error');
    showNotification('Payment updated', 'success');
    return result.payment;
  } catch (error) {
    console.error('Error:', error);
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
    if (!response.ok) throw new Error('Error');
    showNotification('Payment deleted', 'success');
    return true;
  } catch (error) {
    console.error('Error:', error);
    showNotification('Failed to delete', 'error');
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
    if (!response.ok) throw new Error(result.message || 'Error');
    showNotification('Payment marked as paid', 'success');
    return result;
  } catch (error) {
    console.error('Error:', error);
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
    if (!response.ok) throw new Error(result.message || 'Error');
    showNotification('Payment skipped', 'success');
    return result;
  } catch (error) {
    console.error('Error:', error);
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
    if (!response.ok) throw new Error(result.message || 'Error');
    showNotification(result.payment.is_active ? 'Payment resumed' : 'Payment paused', 'success');
    return result.payment;
  } catch (error) {
    console.error('Error:', error);
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
        <h1 class="page-title"><i class="fas fa-sync-alt"></i> Recurring Payments</h1>
        <button class="btn btn-primary" onclick="showAddRecurringModal()">
          <i class="fas fa-plus"></i> Add payment
        </button>
      </header>

      <div class="recurring-stats" id="recurring-stats">
        <div class="loading"><i class="fas fa-spinner fa-spin"></i></div>
      </div>

      <div class="recurring-sections">
        <div class="recurring-section" id="overdue-section" style="display:none;">
          <h2><i class="fas fa-exclamation-triangle text-danger"></i> Overdue</h2>
          <div class="payments-list" id="overdue-list"></div>
        </div>

        <div class="recurring-section" id="upcoming-section">
          <h2><i class="fas fa-clock"></i> Upcoming (7 days)</h2>
          <div class="payments-list" id="upcoming-list"></div>
        </div>

        <div class="recurring-section">
          <h2><i class="fas fa-list"></i> All payments</h2>
          <div class="filter-row">
            <label>
              <input type="checkbox" id="show-inactive" onchange="loadRecurringPayments()">
              Show inactive
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
          <div class="stat-label">Active</div>
        </div>
      </div>
      <div class="stat-card expense">
        <div class="stat-icon"><i class="fas fa-arrow-up"></i></div>
        <div class="stat-data">
          <div class="stat-value">${formatCurrency(stats.monthlyExpenses)}</div>
          <div class="stat-label">Expenses/mo</div>
        </div>
      </div>
      <div class="stat-card income">
        <div class="stat-icon"><i class="fas fa-arrow-down"></i></div>
        <div class="stat-data">
          <div class="stat-value">${formatCurrency(stats.monthlyIncome)}</div>
          <div class="stat-label">Income/mo</div>
        </div>
      </div>
      <div class="stat-card ${stats.overdueCount > 0 ? 'warning' : ''}">
        <div class="stat-icon"><i class="fas fa-exclamation-circle"></i></div>
        <div class="stat-data">
          <div class="stat-value">${stats.overdueCount}</div>
          <div class="stat-label">Overdue</div>
        </div>
      </div>
    </div>
  `;
}

async function loadRecurringPayments() {
  const includeInactive = document.getElementById('show-inactive')?.checked || false;
  const payments = await fetchRecurringPayments(includeInactive);
  const upcoming = await fetchUpcomingPayments(7);

  // Overdue
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

  // Upcoming
  const upcomingList = document.getElementById('upcoming-list');
  const upcomingFiltered = upcoming.filter(p => p.next_payment_date >= today);

  if (upcomingFiltered.length > 0) {
    upcomingList.innerHTML = upcomingFiltered.map(p => renderPaymentCard(p)).join('');
  } else {
    upcomingList.innerHTML = '<p class="empty-text">No upcoming payments</p>';
  }

  // All payments
  const allList = document.getElementById('all-payments-list');
  if (payments.length > 0) {
    allList.innerHTML = payments.map(p => renderPaymentCard(p)).join('');
  } else {
    allList.innerHTML = '<p class="empty-text">No recurring payments</p>';
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
          ${isOverdue ? 'Overdue: ' : 'Next: '}
          ${formatDateShort(payment.next_payment_date)}
          ${!isOverdue && daysUntil >= 0 ? `(in ${daysUntil} days)` : ''}
        </span>
      </div>

      <div class="payment-actions">
        ${payment.is_active ? `
          <button class="btn btn-sm btn-success" onclick="payRecurring(${payment.id})" title="Pay">
            <i class="fas fa-check"></i>
          </button>
          <button class="btn btn-sm btn-warning" onclick="skipRecurring(${payment.id})" title="Skip">
            <i class="fas fa-forward"></i>
          </button>
        ` : ''}
        <button class="btn btn-sm btn-outline" onclick="editRecurring(${payment.id})" title="Edit">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn btn-sm ${payment.is_active ? 'btn-secondary' : 'btn-primary'}"
                onclick="toggleRecurring(${payment.id})" title="${payment.is_active ? 'Pause' : 'Resume'}">
          <i class="fas fa-${payment.is_active ? 'pause' : 'play'}"></i>
        </button>
        <button class="btn btn-sm btn-danger" onclick="deleteRecurring(${payment.id})" title="Delete">
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
        <h3>${isEdit ? 'Edit payment' : 'New recurring payment'}</h3>
        <button class="btn-close" onclick="closeModal('recurring-modal')">&times;</button>
      </div>
      <div class="modal-body">
        <form id="recurring-form">
          <div class="form-row">
            <div class="form-group">
              <label>Name *</label>
              <input type="text" id="rp-name" value="${payment?.name || ''}" required placeholder="E.g.: Netflix">
            </div>
            <div class="form-group">
              <label>Account *</label>
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
              <label>Amount *</label>
              <input type="number" id="rp-amount" step="0.01" min="0" value="${payment?.amount || ''}" required>
            </div>
            <div class="form-group">
              <label>Type</label>
              <select id="rp-type">
                <option value="expense" ${payment?.type === 'expense' ? 'selected' : ''}>Expense</option>
                <option value="income" ${payment?.type === 'income' ? 'selected' : ''}>Income</option>
              </select>
            </div>
            <div class="form-group">
              <label>Category</label>
              <input type="text" id="rp-category" value="${payment?.category || ''}" placeholder="Subscriptions">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Frequency *</label>
              <select id="rp-frequency" onchange="updateFrequencyOptions()">
                <option value="daily" ${payment?.frequency === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${payment?.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="biweekly" ${payment?.frequency === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
                <option value="monthly" ${!payment || payment?.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="quarterly" ${payment?.frequency === 'quarterly' ? 'selected' : ''}>Quarterly</option>
                <option value="yearly" ${payment?.frequency === 'yearly' ? 'selected' : ''}>Yearly</option>
              </select>
            </div>
            <div class="form-group" id="day-of-week-group" style="display:none;">
              <label>Day of week</label>
              <select id="rp-day-of-week">
                <option value="0">Sunday</option>
                <option value="1" ${payment?.day_of_week === 1 ? 'selected' : ''}>Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
              </select>
            </div>
            <div class="form-group" id="day-of-month-group">
              <label>Day of month</label>
              <input type="number" id="rp-day-of-month" min="1" max="31" value="${payment?.day_of_month || ''}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Date start *</label>
              <input type="date" id="rp-start-date" value="${payment?.start_date || new Date().toISOString().split('T')[0]}" required>
            </div>
            <div class="form-group">
              <label>End date</label>
              <input type="date" id="rp-end-date" value="${payment?.end_date || ''}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group checkbox-group">
              <label>
                <input type="checkbox" id="rp-auto-create" ${payment?.auto_create ? 'checked' : ''}>
                Auto-create transactions
              </label>
            </div>
            <div class="form-group">
              <label>Remind before (days)</label>
              <input type="number" id="rp-notify-before" min="0" max="30" value="${payment?.notify_before || 3}">
            </div>
          </div>

          <div class="form-group">
            <label>Description</label>
            <textarea id="rp-description" rows="2">${payment?.description || ''}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('recurring-modal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveRecurring(${payment?.id || 'null'})">
          ${isEdit ? 'Save' : 'Create'}
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
    showNotification('Please fill required fields', 'error');
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
  if (!confirm('Delete this recurring payment?')) return;
  if (await deleteRecurringPayment(id)) {
    await loadRecurringStats();
    await loadRecurringPayments();
  }
}

async function payRecurring(id) {
  const createTx = confirm('Create transaction?');
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
    daily: 'Daily',
    weekly: 'Weekly',
    biweekly: 'Every 2 weeks',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    yearly: 'Yearly'
  };
  return labels[frequency] || frequency;
}

function formatDateShort(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// formatCurrency defined in app.js

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.remove();
}
