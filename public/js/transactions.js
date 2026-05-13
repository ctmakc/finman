// Transaction functions

// Fetch transactions with filters
async function fetchTransactions(filters = {}) {
    try {
      // Build request parameters
      const params = new URLSearchParams();
      
      if (filters.accountId) {
        params.append('accountId', filters.accountId);
      }
      
      if (filters.startDate) {
        params.append('startDate', filters.startDate);
      }
      
      if (filters.endDate) {
        params.append('endDate', filters.endDate);
      }
      
      if (filters.category) {
        params.append('category', filters.category);
      }
      
      if (filters.type) {
        params.append('type', filters.type);
      }
      
      if (filters.search) {
        params.append('search', filters.search);
      }
      
      if (filters.page) {
        params.append('page', filters.page);
      }
      
      if (filters.limit) {
        params.append('limit', filters.limit);
      }
      
      // Execute request
      const response = await fetchWithAuth(`/api/transactions?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch transactions');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error fetching transactions:', error);
      showNotification('Error fetching transactions', 'error');
      return [];
    }
  }
  
  // Fetch categories transactions
  async function fetchCategories() {
    try {
      // Simple implementation - extract categories of existing transactions
      const transactions = await fetchTransactions({ limit: 1000 });
      
      // Extract unique categories
      const categories = [...new Set(transactions.map(t => t.category))].filter(Boolean);
      
      return categories.sort();
    } catch (error) {
      console.error('Error fetching categories:', error);
      return [];
    }
  }
  
  // Fetch statistics transactions
  async function fetchTransactionStats() {
    try {
      // Fetch current date
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Fetch transactions for current month
      const monthlyTransactions = await fetchTransactions({
        startDate: firstDayOfMonth.toISOString().split('T')[0],
        limit: 1000
      });
      
      // Fetch all accounts для calculate общего balance
      const accounts = await fetchAccounts();
      
      // Calculate statistics
      const stats = {
        monthlyIncome: 0,
        monthlyExpense: 0,
        totalBalance: accounts.reduce((sum, acc) => sum + acc.balance, 0),
        transactionsByCategory: {},
        transactionsByMonth: {}
      };
      
      // Calculate incomes and expenses per month
      monthlyTransactions.forEach(transaction => {
        if (transaction.type === 'income') {
          stats.monthlyIncome += transaction.amount;
        } else {
          stats.monthlyExpense += Math.abs(transaction.amount);
        }
        
        // Group by category
        const category = transaction.category || 'Uncategorized';
        if (!stats.transactionsByCategory[category]) {
          stats.transactionsByCategory[category] = {
            income: 0,
            expense: 0
          };
        }
        
        if (transaction.type === 'income') {
          stats.transactionsByCategory[category].income += transaction.amount;
        } else {
          stats.transactionsByCategory[category].expense += Math.abs(transaction.amount);
        }
        
        // Group by month
        const date = new Date(transaction.date);
        const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
        
        if (!stats.transactionsByMonth[monthKey]) {
          stats.transactionsByMonth[monthKey] = {
            income: 0,
            expense: 0
          };
        }
        
        if (transaction.type === 'income') {
          stats.transactionsByMonth[monthKey].income += transaction.amount;
        } else {
          stats.transactionsByMonth[monthKey].expense += Math.abs(transaction.amount);
        }
      });
      
      return stats;
    } catch (error) {
      console.error('Error fetching statistics:', error);
      return {
        monthlyIncome: 0,
        monthlyExpense: 0,
        totalBalance: 0,
        transactionsByCategory: {},
        transactionsByMonth: {}
      };
    }
  }
  
  // Create new transaction
  async function createTransaction(transactionData) {
    try {
      const response = await fetchWithAuth('/api/transactions', {
        method: 'POST',
        body: JSON.stringify(transactionData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Failed to create transactions', 'error');
        return null;
      }
      
      const newTransaction = await response.json();
      showNotification('Transaction created successfully', 'success');
      
      return newTransaction;
    } catch (error) {
      console.error('Failed to create transactions:', error);
      showNotification('An error occurred on create transactions', 'error');
      return null;
    }
  }
  
  // Update transactions
  async function updateTransaction(transactionId, transactionData) {
    try {
      const response = await fetchWithAuth(`/api/transactions/${transactionId}`, {
        method: 'PUT',
        body: JSON.stringify(transactionData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Failed to update transactions', 'error');
        return false;
      }
      
      showNotification('Transaction updated successfully', 'success');
      return true;
    } catch (error) {
      console.error('Failed to update transactions:', error);
      showNotification('An error occurred updating transaction', 'error');
      return false;
    }
  }
  
  // Delete transactions
  async function deleteTransaction(transactionId) {
    try {
      const response = await fetchWithAuth(`/api/transactions/${transactionId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Failed to delete transactions', 'error');
        return false;
      }
      
      showNotification('Transaction deleted successfully', 'success');
      return true;
    } catch (error) {
      console.error('Failed to delete transactions:', error);
      showNotification('An error occurred on delete transactions', 'error');
      return false;
    }
  }
  
  // Import transactions of CSV
  async function importTransactionsFromCSV(formData) {
    try {
      const response = await fetchWithAuth('/api/transactions/import', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: formData
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error importing transactions', 'error');
        return null;
      }
      
      const result = await response.json();
      showNotification(`Successfully imported ${result.count} transactions`, 'success');
      
      return result;
    } catch (error) {
      console.error('Error importing transactions:', error);
      showNotification('An error occurred importing transactions', 'error');
      return null;
    }
  }
  
  // Create modal/edit transaction
  function showAddTransactionModal(transactionData = null) {
    // Create modal
    const modalId = 'transaction-modal';
    const isEditing = !!transactionData;
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${isEditing ? 'Edit transactions' : 'New transaction'}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">Account</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">Select account</option>
                ${appState.accounts.map(account => `
                  <option value="${account.id}" ${isEditing && transactionData.account_id == account.id ? 'selected' : ''}>
                    ${account.name} (${formatCurrency(account.balance, account.currency)})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-type" class="form-label">Type transactions</label>
              <select id="${modalId}-type" class="form-control" required>
                <option value="income" ${isEditing && transactionData.type === 'income' ? 'selected' : ''}>Income</option>
                <option value="expense" ${isEditing && transactionData.type === 'expense' ? 'selected' : ''}>Expense</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">Amount</label>
              <input type="number" id="${modalId}-amount" class="form-control" step="0.01" value="${isEditing ? Math.abs(transactionData.amount) : ''}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-date" class="form-label">Date</label>
              <input type="date" id="${modalId}-date" class="form-control" value="${isEditing ? transactionData.date : new Date().toISOString().split('T')[0]}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-category" class="form-label">Category</label>
              <input type="text" id="${modalId}-category" class="form-control" list="${modalId}-categories" value="${isEditing ? transactionData.category : ''}">
              <datalist id="${modalId}-categories">
                <!-- Categories will be loaded dynamically -->
              </datalist>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-description" class="form-label">Description</label>
              <input type="text" id="${modalId}-description" class="form-control" value="${isEditing ? transactionData.description : ''}">
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">${isEditing ? 'Save' : 'Create'}</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    // Add modal to page
    safeInsertHTML(document.body, 'beforeend', modalHtml);
    
    // Get element references
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const modalCancel = document.getElementById(`${modalId}-cancel`);
    const modalForm = document.getElementById(`${modalId}-form`);
    const typeSelect = document.getElementById(`${modalId}-type`);
    const amountInput = document.getElementById(`${modalId}-amount`);
    
    // Load categories
    fetchCategories().then(categories => {
      const categoriesDatalist = document.getElementById(`${modalId}-categories`);
      categoriesDatalist.innerHTML = categories.map(c => `<option value="${c}">`).join('');
    });

    // Auto-categorize on description blur
    const descInput = document.getElementById(`${modalId}-description`);
    const catInput = document.getElementById(`${modalId}-category`);
    if (descInput && catInput) {
      descInput.addEventListener('blur', async () => {
        const desc = descInput.value.trim();
        if (!desc || catInput.value) return;
        try {
          const token = localStorage.getItem('token');
          const resp = await fetch('/api/ai/categorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ description: desc, amount: document.getElementById(`${modalId}-amount`).value }),
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.category && data.category !== 'Other') {
              catInput.value = data.category;
              catInput.style.borderColor = '#5D5CDE';
              catInput.title = 'Category suggested by AI';
              setTimeout(() => { catInput.style.borderColor = ''; }, 2000);
            }
          }
        } catch (_e) { /* auto-categorize is best-effort */ }
      });
    }

    // Modal close function
    const closeModal = () => {
      modalBackdrop.classList.add('closing');
      
      // Remove modal after animation
      setTimeout(() => {
        document.body.removeChild(modalBackdrop);
      }, 300);
    };
    
    // Event handlers
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Form submit handler
    modalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const accountId = document.getElementById(`${modalId}-account`).value;
      const type = document.getElementById(`${modalId}-type`).value;
      let amount = parseFloat(document.getElementById(`${modalId}-amount`).value);
      
      // If expense, make amount negative
      if (type === 'expense') {
        amount = -Math.abs(amount);
      } else {
        amount = Math.abs(amount);
      }
      
      const transactionFormData = {
        accountId,
        type,
        amount,
        date: document.getElementById(`${modalId}-date`).value,
        category: document.getElementById(`${modalId}-category`).value,
        description: document.getElementById(`${modalId}-description`).value
      };
      
      // Create or update transaction
      let success = false;
      
      if (isEditing) {
        success = await updateTransaction(transactionData.id, transactionFormData);
      } else {
        const newTransaction = await createTransaction(transactionFormData);
        success = !!newTransaction;
      }
      
      if (success) {
        closeModal();
        
        // Update UI depending on current page
        if (appState.currentPage === 'transactions') {
          renderTransactionsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        } else if (appState.currentPage === 'accounts' && appState.filters.accountId) {
          fetchAccounts().then(() => {
            renderAccountsPage();
          });
        }
      }
    });
  }
  
  // Import transactions modal
  function showImportTransactionsModal() {
    // Create modal
    const modalId = 'import-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Import transactions of CSV</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">Account</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">Select account</option>
                ${appState.accounts.map(account => `
                  <option value="${account.id}">
                    ${account.name} (${formatCurrency(account.balance, account.currency)})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-bank-type" class="form-label">Type bank</label>
              <select id="${modalId}-bank-type" class="form-control">
                <option value="generic">Generic format</option>
                <option value="tinkoff">Tinkoff</option>
                <option value="sberbank">Sberbank</option>
                <option value="vtb">VTB</option>
                <option value="alfabank">Alfa-Bank</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-file" class="form-label">CSV-file</label>
              <div class="file-upload">
                <input type="file" id="${modalId}-file" class="file-input" accept=".csv" required>
                <div class="file-label">
                  <span id="${modalId}-file-name">Select file</span>
                </div>
              </div>
            </div>
            
            <div class="import-info">
              <p><i class="fas fa-info-circle"></i> File must contain headers with columns: date, description, amount, category (optional).</p>
              <p>Select the matching bank type for correct data import.</p>
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">Import</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    // Add modal to page
    safeInsertHTML(document.body, 'beforeend', modalHtml);
    
    // Get element references
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const modalCancel = document.getElementById(`${modalId}-cancel`);
    const modalForm = document.getElementById(`${modalId}-form`);
    const fileInput = document.getElementById(`${modalId}-file`);
    const fileNameDisplay = document.getElementById(`${modalId}-file-name`);
    
    // Update имени fileа при выборе
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        fileNameDisplay.textContent = fileInput.files[0].name;
      } else {
        fileNameDisplay.textContent = 'Select file';
      }
    });
    
    // Modal close function
    const closeModal = () => {
      modalBackdrop.classList.add('closing');
      
      // Remove modal after animation
      setTimeout(() => {
        document.body.removeChild(modalBackdrop);
      }, 300);
    };
    
    // Event handlers
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Form submit handler
    modalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const accountId = document.getElementById(`${modalId}-account`).value;
      const bankType = document.getElementById(`${modalId}-bank-type`).value;
      const file = fileInput.files[0];
      
      if (!accountId || !file) {
        showNotification('Please select an account and file', 'error');
        return;
      }
      
      // Create FormData для отправки fileа
      const formData = new FormData();
      formData.append('file', file);
      formData.append('accountId', accountId);
      formData.append('bankType', bankType);
      
      // Отправка дан
      const result = await importTransactionsFromCSV(formData);
      
      if (result) {
        closeModal();
        
        // Update UI
        if (appState.currentPage === 'transactions') {
          renderTransactionsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    });
  }
  
  // Render list transactions
  function renderTransactionsList(transactions) {
    return transactions.map(transaction => `
      <tr data-transaction-id="${transaction.id}">
        <td>${formatDate(transaction.date)}</td>
        <td>${transaction.description || 'No description'}</td>
        <td>${transaction.category || 'Uncategorized'}</td>
        <td>${transaction.account_name}</td>
        <td class="text-right ${transaction.type === 'income' ? 'text-success' : 'text-error'}">
          ${formatCurrency(transaction.amount)}
        </td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm btn-icon" data-transaction-action="edit" data-transaction-id="${transaction.id}">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-sm btn-icon btn-danger" data-transaction-action="delete" data-transaction-id="${transaction.id}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }
  
  // Рендеринг пагинации
  function renderPagination(currentPage, totalItems, perPage) {
    const totalPages = Math.max(1, Math.ceil((totalItems || 0) / (perPage || 20)));

    if (totalPages <= 1) {
      return '';
    }
    
    // Build list pages
    let paginationHtml = '<ul class="pagination">';
    
    // Button "Previous"
    paginationHtml += `
      <li class="pagination-item">
        <a href="#" class="pagination-link ${currentPage <= 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" aria-label="Previous">
          <i class="fas fa-chevron-left"></i>
        </a>
      </li>
    `;
    
    // Страницы
    for (let i = 1; i <= totalPages; i++) {
      paginationHtml += `
        <li class="pagination-item">
          <a href="#" class="pagination-link ${i === currentPage ? 'active' : ''}" data-page="${i}">
            ${i}
          </a>
        </li>
      `;
    }
    
    // Button "Next"
    paginationHtml += `
      <li class="pagination-item">
        <a href="#" class="pagination-link ${currentPage >= totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" aria-label="Next">
          <i class="fas fa-chevron-right"></i>
        </a>
      </li>
    `;
    
    paginationHtml += '</ul>';
    
    return paginationHtml;
  }
  
  // Processing действий с transactionми
  async function handleTransactionAction(e) {
    const button = e.currentTarget;
    const action = button.dataset.transactionAction;
    const transactionId = button.dataset.transactionId;
    
    if (!action || !transactionId) return;
    
    switch (action) {
      case 'edit':
        // Fetch дан transactions
        const transactions = await fetchTransactions();
        const transaction = transactions.find(t => t.id == transactionId);
        
        if (transaction) {
          showAddTransactionModal(transaction);
        }
        break;
        
      case 'delete':
        if (confirm('Delete this transaction?')) {
          const success = await deleteTransaction(transactionId);
          
          if (success) {
            // Update UI
            if (appState.currentPage === 'transactions') {
              renderTransactionsPage();
            } else if (appState.currentPage === 'dashboard') {
              renderDashboard();
            }
          }
        }
        break;
    }
  }
  
  // Functions for фильтрs transactions
  function toggleFilters() {
    const filtersForm = document.getElementById('filters-form');
    const toggleButton = document.getElementById('toggle-filters-btn');
    
    if (filtersForm.classList.contains('hidden')) {
      filtersForm.classList.remove('hidden');
      toggleButton.innerHTML = '<i class="fas fa-filter"></i> Hide filters';
    } else {
      filtersForm.classList.add('hidden');
      toggleButton.innerHTML = '<i class="fas fa-filter"></i> Show filters';
    }
  }
  
  // Применение фильтров transactions
  function applyTransactionFilters() {
    // Fetch значений фильтров
    appState.filters.startDate = document.getElementById('filter-date-start').value;
    appState.filters.endDate = document.getElementById('filter-date-end').value;
    appState.filters.accountId = document.getElementById('filter-account').value;
    appState.filters.category = document.getElementById('filter-category').value;
    appState.filters.type = document.getElementById('filter-type').value;
    appState.filters.search = document.getElementById('filter-search').value;
    appState.filters.page = 1; // Сброс pagesы при применении новых фильтров
    
    // Update transaction pages
    renderTransactionsPage();
  }
  
  // Сброс фильтров transactions
  function resetTransactionFilters() {
    // Сброс значений в форме
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    document.getElementById('filter-account').value = '';
    document.getElementById('filter-category').value = '';
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-search').value = '';
    
    // Сброс фильтров в состоянии
    appState.filters = {
      startDate: null,
      endDate: null,
      accountId: null,
      category: null,
      type: null,
      search: '',
      page: 1
    };
    
    // Update transaction pages
    renderTransactionsPage();
  }
  
  // Export data
  async function handleDataExport() {
    const period = document.getElementById('export-period').value;
    let startDate = null;
    let endDate = null;
    
    // Определение period
    if (period === 'custom') {
      startDate = document.getElementById('export-start-date').value;
      endDate = document.getElementById('export-end-date').value;
      
      if (!startDate || !endDate) {
        showNotification('Please specify start and end dates', 'error');
        return;
      }
    } else if (period === 'month') {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (period === 'year') {
      const now = new Date();
      startDate = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
      endDate = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0];
    }
    
    // Fetch transactions за указанный period
    const transactions = await fetchTransactions({
      startDate,
      endDate,
      limit: 10000 // Большое значение для fetching all transactions
    });
    
    if (!transactions.length) {
      showNotification('No data to export', 'warning');
      return;
    }
    
    // Преобразование в CSV
    const headers = ['Date', 'Description', 'Category', 'Account', 'Amount', 'Type'];
    const csvRows = [headers.join(',')];
    
    transactions.forEach(transaction => {
      const rowData = [
        transaction.date,
        `"${(transaction.description || '').replace(/"/g, '""')}"`,
        `"${(transaction.category || '').replace(/"/g, '""')}"`,
        `"${(transaction.account_name || '').replace(/"/g, '""')}"`,
        transaction.amount,
        transaction.type
      ];
      
      csvRows.push(rowData.join(','));
    });
    
    const csvContent = csvRows.join('\n');
    
    // Create временной ссылки для скачивания
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    link.href = url;
    link.setAttribute('download', `finances_${startDate || 'all'}_${endDate || 'all'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showNotification('Data exported successfully', 'success');
  }