// Functions for budgets

// Fetch all budgets
async function fetchBudgets() {
  try {
    const response = await fetchWithAuth('/api/budgets');
    if (!response.ok) {
      throw new Error('Failed to fetch budgets');
    }
    const data = await response.json();
    appState.budgets = data;
    return data;
  } catch (error) {
    console.error('Error fetching budgets:', error);
    return [];
  }
}

// Fetch statistics по budgetм
async function fetchBudgetStats() {
  try {
    const response = await fetchWithAuth('/api/budgets/stats');
    if (!response.ok) {
      throw new Error('Failed to fetch statistics');
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching statistics:', error);
    return null;
  }
}

// Create budget
async function createBudget(budgetData) {
  try {
    const response = await fetchWithAuth('/api/budgets', {
      method: 'POST',
      body: JSON.stringify(budgetData)
    });

    const data = await response.json();

    if (!response.ok) {
      showNotification(data.message || 'Failed to create budget', 'error');
      return null;
    }

    showNotification('Budget created', 'success');
    return data.budget;
  } catch (error) {
    console.error('Failed to create budget:', error);
    showNotification('An error occurred', 'error');
    return null;
  }
}

// Update budget
async function updateBudget(id, budgetData) {
  try {
    const response = await fetchWithAuth(`/api/budgets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(budgetData)
    });

    const data = await response.json();

    if (!response.ok) {
      showNotification(data.message || 'Failed to update', 'error');
      return null;
    }

    showNotification('Budget updated', 'success');
    return data.budget;
  } catch (error) {
    console.error('Failed to update budget:', error);
    showNotification('An error occurred', 'error');
    return null;
  }
}

// Delete budget
async function deleteBudget(id) {
  try {
    const response = await fetchWithAuth(`/api/budgets/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const data = await response.json();
      showNotification(data.message || 'Failed to delete', 'error');
      return false;
    }

    showNotification('Budget deleted', 'success');
    return true;
  } catch (error) {
    console.error('Failed to delete budget:', error);
    showNotification('An error occurred', 'error');
    return false;
  }
}

// Render budgets page
async function renderBudgetsPage() {
  const mainContent = document.getElementById('main-content');

  // Load data
  const [budgets, stats] = await Promise.all([
    fetchBudgets(),
    fetchBudgetStats()
  ]);

  mainContent.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Budgets</h1>
      <button class="btn btn-primary" id="add-budget-btn">
        <i class="fas fa-plus"></i> New budget
      </button>
    </div>

    ${stats ? renderBudgetStats(stats) : ''}

    <div class="budgets-list">
      ${budgets.length > 0 ? renderBudgetCards(budgets) : renderEmptyBudgets()}
    </div>
  `;

  // Handler for добавления budget
  document.getElementById('add-budget-btn').addEventListener('click', showCreateBudgetModal);

  // Обработчики действий с budgets
  document.querySelectorAll('.budget-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => showEditBudgetModal(btn.dataset.id));
  });

  document.querySelectorAll('.budget-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteBudget(btn.dataset.id));
  });
}

// Рендер statistics
function renderBudgetStats(stats) {
  const overallStatus = stats.overallPercentUsed >= 100 ? 'over' :
                        stats.overallPercentUsed >= 80 ? 'warning' : 'ok';

  return `
    <div class="budget-stats-overview">
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-wallet"></i></div>
        <div class="stat-info">
          <div class="stat-value">${formatCurrency(stats.totalBudgetAmount)}</div>
          <div class="stat-label">Total budget</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-shopping-cart"></i></div>
        <div class="stat-info">
          <div class="stat-value">${formatCurrency(stats.totalSpent)}</div>
          <div class="stat-label">Spent</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-piggy-bank"></i></div>
        <div class="stat-info">
          <div class="stat-value">${formatCurrency(stats.totalRemaining)}</div>
          <div class="stat-label">Remaining</div>
        </div>
      </div>

      <div class="stat-card stat-${overallStatus}">
        <div class="stat-icon"><i class="fas fa-chart-pie"></i></div>
        <div class="stat-info">
          <div class="stat-value">${stats.overallPercentUsed}%</div>
          <div class="stat-label">Used</div>
        </div>
      </div>
    </div>

    ${stats.overBudgetCount > 0 ? `
      <div class="alert alert-danger">
        <i class="fas fa-exclamation-triangle"></i>
        ${stats.overBudgetCount} budgets over!
      </div>
    ` : ''}

    ${stats.nearLimitCount > 0 ? `
      <div class="alert alert-warning">
        <i class="fas fa-exclamation-circle"></i>
        ${stats.nearLimitCount} budgets near limit
      </div>
    ` : ''}
  `;
}

// Рендер карточек budgets
function renderBudgetCards(budgets) {
  return budgets.map(budget => {
    const statusClass = budget.isOverBudget ? 'over' :
                        budget.shouldNotify ? 'warning' : 'ok';
    const progressWidth = Math.min(budget.percentUsed, 100);

    return `
      <div class="budget-card budget-${statusClass}">
        <div class="budget-header">
          <div class="budget-info">
            <h3 class="budget-name">${budget.name}</h3>
            ${budget.category ? `<span class="budget-category">${budget.category}</span>` : ''}
          </div>
          <div class="budget-actions">
            <button class="btn btn-sm btn-outline budget-edit-btn" data-id="${budget.id}">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-sm btn-danger budget-delete-btn" data-id="${budget.id}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>

        <div class="budget-progress">
          <div class="progress-bar">
            <div class="progress-fill progress-${statusClass}" style="width: ${progressWidth}%"></div>
          </div>
          <div class="progress-labels">
            <span class="spent">${formatCurrency(budget.spent)}</span>
            <span class="total">of ${formatCurrency(budget.amount)}</span>
          </div>
        </div>

        <div class="budget-footer">
          <span class="budget-remaining ${budget.remaining < 0 ? 'negative' : ''}">
            ${budget.remaining >= 0 ? 'Remaining: ' : 'Over by: '}
            ${formatCurrency(Math.abs(budget.remaining))}
          </span>
          <span class="budget-period">${getPeriodLabel(budget.period)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Рендер пуст state
function renderEmptyBudgets() {
  return `
    <div class="empty-state">
      <i class="fas fa-piggy-bank"></i>
      <h3>No budgets</h3>
      <p>Create your first budget, to to track your expenses</p>
      <button class="btn btn-primary" onclick="showCreateBudgetModal()">
        <i class="fas fa-plus"></i> Create budget
      </button>
    </div>
  `;
}

// Fetch метки period
function getPeriodLabel(period) {
  const labels = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    yearly: 'Annual',
    custom: 'Custom'
  };
  return labels[period] || period;
}

// Create modal budget
function showCreateBudgetModal() {
  const modalId = 'create-budget-modal';

  const modalHtml = `
    <div class="modal-backdrop" id="${modalId}-backdrop">
      <div class="modal" id="${modalId}">
        <div class="modal-header">
          <h2 class="modal-title">New budget</h2>
          <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
        </div>

        <form id="${modalId}-form" class="modal-body">
          <div class="form-group">
            <label for="${modalId}-name" class="form-label">Name *</label>
            <input type="text" id="${modalId}-name" class="form-control" placeholder="E.g.: Groceries" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-category" class="form-label">Category</label>
            <input type="text" id="${modalId}-category" class="form-control" placeholder="Category expenses (optional)">
            <small class="form-hint">Leave empty for a general budget covering all expenses</small>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">Amount *</label>
              <input type="number" id="${modalId}-amount" class="form-control" min="1" step="0.01" required>
            </div>

            <div class="form-group">
              <label for="${modalId}-currency" class="form-label">Currency</label>
              <select id="${modalId}-currency" class="form-control">
                <option value="UAH">UAH</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="CAD">CAD</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label for="${modalId}-period" class="form-label">Period</label>
            <select id="${modalId}-period" class="form-control">
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
              <option value="yearly">Annual</option>
            </select>
          </div>

          <div class="form-group">
            <label for="${modalId}-notify" class="form-label">Notify when reaching (%)</label>
            <input type="number" id="${modalId}-notify" class="form-control" min="50" max="100" value="80">
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  `;

  safeInsertHTML(document.body, 'beforeend', modalHtml);

  const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
  const modalClose = document.getElementById(`${modalId}-close`);
  const modalCancel = document.getElementById(`${modalId}-cancel`);
  const modalForm = document.getElementById(`${modalId}-form`);

  const closeModal = () => {
    modalBackdrop.classList.add('closing');
    setTimeout(() => document.body.removeChild(modalBackdrop), 300);
  };

  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const budgetData = {
      name: document.getElementById(`${modalId}-name`).value.trim(),
      category: document.getElementById(`${modalId}-category`).value.trim() || null,
      amount: parseFloat(document.getElementById(`${modalId}-amount`).value),
      currency: document.getElementById(`${modalId}-currency`).value,
      period: document.getElementById(`${modalId}-period`).value,
      notifyAtPercent: parseInt(document.getElementById(`${modalId}-notify`).value)
    };

    const result = await createBudget(budgetData);

    if (result) {
      closeModal();
      renderBudgetsPage();
    }
  });
}

// Модальное окно редактирования budget
async function showEditBudgetModal(id) {
  const budget = appState.budgets?.find(b => b.id == id);
  if (!budget) {
    showNotification('Budget not found', 'error');
    return;
  }

  const modalId = 'edit-budget-modal';

  const modalHtml = `
    <div class="modal-backdrop" id="${modalId}-backdrop">
      <div class="modal" id="${modalId}">
        <div class="modal-header">
          <h2 class="modal-title">Edit budget</h2>
          <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
        </div>

        <form id="${modalId}-form" class="modal-body">
          <div class="form-group">
            <label for="${modalId}-name" class="form-label">Name *</label>
            <input type="text" id="${modalId}-name" class="form-control" value="${budget.name}" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-category" class="form-label">Category</label>
            <input type="text" id="${modalId}-category" class="form-control" value="${budget.category || ''}">
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">Amount *</label>
              <input type="number" id="${modalId}-amount" class="form-control" min="1" step="0.01" value="${budget.amount}" required>
            </div>

            <div class="form-group">
              <label for="${modalId}-currency" class="form-label">Currency</label>
              <select id="${modalId}-currency" class="form-control">
                <option value="UAH" ${budget.currency === 'UAH' ? 'selected' : ''}>UAH</option>
                <option value="USD" ${budget.currency === 'USD' ? 'selected' : ''}>USD</option>
                <option value="EUR" ${budget.currency === 'EUR' ? 'selected' : ''}>EUR</option>
                <option value="CAD" ${budget.currency === 'CAD' ? 'selected' : ''}>CAD</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label for="${modalId}-period" class="form-label">Period</label>
            <select id="${modalId}-period" class="form-control">
              <option value="monthly" ${budget.period === 'monthly' ? 'selected' : ''}>Monthly</option>
              <option value="weekly" ${budget.period === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="daily" ${budget.period === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="yearly" ${budget.period === 'yearly' ? 'selected' : ''}>Annual</option>
            </select>
          </div>

          <div class="form-group">
            <label for="${modalId}-notify" class="form-label">Notify at (%)</label>
            <input type="number" id="${modalId}-notify" class="form-control" min="50" max="100" value="${budget.notifyAtPercent}">
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  `;

  safeInsertHTML(document.body, 'beforeend', modalHtml);

  const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
  const modalClose = document.getElementById(`${modalId}-close`);
  const modalCancel = document.getElementById(`${modalId}-cancel`);
  const modalForm = document.getElementById(`${modalId}-form`);

  const closeModal = () => {
    modalBackdrop.classList.add('closing');
    setTimeout(() => document.body.removeChild(modalBackdrop), 300);
  };

  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const budgetData = {
      name: document.getElementById(`${modalId}-name`).value.trim(),
      category: document.getElementById(`${modalId}-category`).value.trim() || null,
      amount: parseFloat(document.getElementById(`${modalId}-amount`).value),
      currency: document.getElementById(`${modalId}-currency`).value,
      period: document.getElementById(`${modalId}-period`).value,
      notifyAtPercent: parseInt(document.getElementById(`${modalId}-notify`).value)
    };

    const result = await updateBudget(id, budgetData);

    if (result) {
      closeModal();
      renderBudgetsPage();
    }
  });
}

// Confirmation удаления budget
async function confirmDeleteBudget(id) {
  if (confirm('Are you sure you want to delete this budget?')) {
    const result = await deleteBudget(id);
    if (result) {
      renderBudgetsPage();
    }
  }
}

// Widget budgets для dashboardа
async function renderBudgetWidget() {
  const stats = await fetchBudgetStats();

  if (!stats || stats.totalBudgets === 0) {
    return `
      <div class="widget budget-widget">
        <h3 class="widget-title"><i class="fas fa-piggy-bank"></i> Budgets</h3>
        <div class="widget-empty">
          <p>No active budgets</p>
          <button class="btn btn-sm btn-primary" onclick="navigateTo('budgets')">Create budget</button>
        </div>
      </div>
    `;
  }

  const budgetsHtml = stats.budgets.slice(0, 3).map(budget => `
    <div class="budget-mini budget-${budget.status}">
      <div class="budget-mini-info">
        <span class="budget-mini-name">${budget.name}</span>
        <span class="budget-mini-progress">${budget.percentUsed}%</span>
      </div>
      <div class="progress-bar-mini">
        <div class="progress-fill-mini progress-${budget.status}" style="width: ${Math.min(budget.percentUsed, 100)}%"></div>
      </div>
    </div>
  `).join('');

  return `
    <div class="widget budget-widget">
      <div class="widget-header">
        <h3 class="widget-title"><i class="fas fa-piggy-bank"></i> Budgets</h3>
        <a href="#" onclick="navigateTo('budgets'); return false;" class="widget-link">All</a>
      </div>
      <div class="widget-content">
        ${budgetsHtml}
      </div>
      ${stats.overBudgetCount > 0 ? `
        <div class="widget-alert alert-danger">
          ${stats.overBudgetCount} budgets over
        </div>
      ` : ''}
    </div>
  `;
}
