// Функции для работы с транзакциями

// Полное HTML-экранирование (включая кавычки — безопасно и в атрибутах).
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Получение транзакций с учетом фильтров
async function fetchTransactions(filters = {}) {
    try {
      // Формирование параметров запроса
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
      
      // Выполнение запроса
      const response = await fetchWithAuth(`/api/transactions?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error(t('transactions.fetchError'));
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Ошибка получения транзакций:', error);
      showNotification(t('transactions.fetchError'), 'error');
      return [];
    }
  }
  
  // Получение категорий транзакций
  async function fetchCategories() {
    try {
      // Простая реализация - извлечение категорий из существующих транзакций
      // The API clamps limit to 500.
      const transactions = await fetchTransactions({ limit: TX_PAGE_LIMIT });
      
      // Извлечение уникальных категорий
      const categories = [...new Set(transactions.map(t => t.category))].filter(Boolean);
      
      return categories.sort();
    } catch (error) {
      console.error('Ошибка получения категорий:', error);
      return [];
    }
  }
  
  // Server-side page size cap for GET /api/transactions (routes/transactions.js).
  const TX_PAGE_LIMIT = 500;

  // Every page of a filtered query (the API returns at most 500 rows per page).
  async function fetchAllTransactions(filters = {}, maxPages = 40) {
    let all = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await fetchTransactions({ ...filters, page, limit: TX_PAGE_LIMIT });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < TX_PAGE_LIMIT) break;
    }
    return all;
  }

  // Total balance converted into the base currency by the server
  // (GET /api/analytics/overview -> totalBalance + baseCurrency); null if unavailable.
  async function fetchConvertedBalance() {
    try {
      const response = await fetchWithAuth('/api/analytics/overview');
      if (!response.ok) return null;
      const data = await response.json();
      const total = Number(data && data.totalBalance);
      if (!Number.isFinite(total)) return null;
      return {
        total,
        currency: data.baseCurrency ? String(data.baseCurrency).toUpperCase() : null,
        missingRates: Array.isArray(data.missingRates) ? data.missingRates : []
      };
    } catch (error) {
      return null;
    }
  }

  // Pure aggregation (unit-tested): only real cash flow (income/expense) counts
  // — opening balances and transfers are not income or spending — and amounts
  // are grouped per currency, never added across currencies.
  function computeTransactionStats(transactions, accounts, baseCurrency) {
    const base = String(baseCurrency || 'CAD').toUpperCase();
    const curOf = (tx) => String(transactionCurrency(tx, accounts) || base).toUpperCase();
    const add = (map, key, v) => { map[key] = Math.round(((map[key] || 0) + v) * 100) / 100; };

    const incomeByCurrency = {};
    const expenseByCurrency = {};
    const flow = (transactions || []).filter(tx => tx && (tx.type === 'income' || tx.type === 'expense'));
    flow.forEach(tx => {
      const amount = Math.abs(Number(tx.amount) || 0);
      add(tx.type === 'income' ? incomeByCurrency : expenseByCurrency, curOf(tx), amount);
    });

    const balanceByCurrency = {};
    (accounts || []).forEach(acc => {
      add(balanceByCurrency, String(acc.currency || base).toUpperCase(), Number(acc.balance) || 0);
    });

    const flowCurrencies = [...new Set([...Object.keys(incomeByCurrency), ...Object.keys(expenseByCurrency)])];
    // Charts show one currency: the base one when present, else the first seen.
    const currency = flowCurrencies.length === 0 || flowCurrencies.includes(base) ? base : flowCurrencies[0];

    const transactionsByCategory = {};
    const transactionsByMonth = {};
    flow.filter(tx => curOf(tx) === currency).forEach(tx => {
      const amount = Math.abs(Number(tx.amount) || 0);
      const key = tx.type === 'income' ? 'income' : 'expense';
      const category = tx.category || t('transactions.uncategorized');
      if (!transactionsByCategory[category]) transactionsByCategory[category] = { income: 0, expense: 0 };
      transactionsByCategory[category][key] += amount;
      const monthKey = String(tx.date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(monthKey)) {
        if (!transactionsByMonth[monthKey]) transactionsByMonth[monthKey] = { income: 0, expense: 0 };
        transactionsByMonth[monthKey][key] += amount;
      }
    });

    return {
      currency,
      mixedCurrencies: flowCurrencies.length > 1,
      incomeByCurrency,
      expenseByCurrency,
      monthlyIncome: incomeByCurrency[currency] || 0,
      monthlyExpense: expenseByCurrency[currency] || 0,
      balanceByCurrency,
      totalBalance: null,
      balanceCurrency: null,
      transactionsByCategory,
      transactionsByMonth
    };
  }

  // Dashboard statistics for the current (local) month.
  async function fetchTransactionStats() {
    const base = (typeof appState !== 'undefined' && appState.baseCurrency) || 'CAD';
    try {
      const { start } = UI.monthRange(new Date());
      const [monthlyTransactions, accounts, converted] = await Promise.all([
        fetchAllTransactions({ startDate: start }),
        fetchAccounts(),
        fetchConvertedBalance()
      ]);
      const stats = computeTransactionStats(monthlyTransactions, accounts, base);
      if (converted) {
        stats.totalBalance = converted.total;
        stats.balanceCurrency = converted.currency || base;
        stats.missingRates = converted.missingRates;
      } else {
        const codes = Object.keys(stats.balanceByCurrency);
        if (codes.length <= 1) {
          stats.totalBalance = codes.length ? stats.balanceByCurrency[codes[0]] : 0;
          stats.balanceCurrency = codes[0] || base;
        }
      }
      return stats;
    } catch (error) {
      console.error('Could not load statistics:', error);
      return computeTransactionStats([], [], base);
    }
  }

  // Создание новой транзакции
  // Offline: put the transaction into the IndexedDB queue (offline.js). Returns
  // a placeholder row on success, null when there is no queue to put it in.
  async function queueTransactionOffline(transactionData) {
    if (typeof window === 'undefined' || typeof window.queueOfflineTransaction !== 'function') {
      showNotification(t('transactions.offlineNotSaved'), 'error');
      return null;
    }
    try {
      const item = await window.queueOfflineTransaction(transactionData);
      showNotification(t('transactions.offlineQueued'), 'warning');
      return { queued: true, clientTxId: item && item.clientId };
    } catch (error) {
      console.error('Could not queue the transaction offline:', error);
      showNotification(t('transactions.offlineNotSaved'), 'error');
      return null;
    }
  }

  async function createTransaction(transactionData) {
    let response;
    try {
      response = await fetchWithAuth('/api/transactions', {
        method: 'POST',
        body: JSON.stringify(transactionData)
      });
    } catch (error) {
      if (error && error.status === 401) return null;
      // No service worker and no network: fetch itself rejects.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline || error instanceof TypeError) return queueTransactionOffline(transactionData);
      console.error('Could not create the transaction:', error);
      showNotification(t('transactions.createFailed'), 'error');
      return null;
    }

    try {
      let data = null;
      try { data = await response.json(); } catch (_) { data = null; }

      // The service worker answers 503 { offline: true } when the network is gone.
      if (response.status === 503 && data && data.offline) {
        return queueTransactionOffline(transactionData);
      }

      if (!response.ok) {
        const message = (data && (data.message || (data.error && data.error.message))) || t('transactions.createError');
        showNotification(message, 'error');
        return null;
      }

      showNotification(t('transactions.created'), 'success');
      return data || {};
    } catch (error) {
      console.error('Could not create the transaction:', error);
      showNotification(t('transactions.createFailed'), 'error');
      return null;
    }
  }
  
  // Обновление транзакции
  async function updateTransaction(transactionId, transactionData) {
    try {
      const response = await fetchWithAuth(`/api/transactions/${transactionId}`, {
        method: 'PUT',
        body: JSON.stringify(transactionData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || t('transactions.updateError'), 'error');
        return false;
      }
      
      showNotification(t('transactions.updated'), 'success');
      return true;
    } catch (error) {
      console.error('Ошибка обновления транзакции:', error);
      showNotification(t('transactions.updateFailed'), 'error');
      return false;
    }
  }
  
  // Удаление транзакции
  async function deleteTransaction(transactionId) {
    try {
      const response = await fetchWithAuth(`/api/transactions/${transactionId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || t('transactions.deleteError'), 'error');
        return false;
      }
      
      showNotification(t('transactions.deleted'), 'success');
      return true;
    } catch (error) {
      console.error('Ошибка удаления транзакции:', error);
      showNotification(t('transactions.deleteFailed'), 'error');
      return false;
    }
  }
  
  // Импорт транзакций из CSV
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
        showNotification(data.message || t('transactions.importError'), 'error');
        return null;
      }
      
      const result = await response.json();
      showNotification(t('transactions.imported', { count: result.count }), 'success');
      
      return result;
    } catch (error) {
      console.error('Ошибка импорта транзакций:', error);
      showNotification(t('transactions.importFailed'), 'error');
      return null;
    }
  }
  
  // Модальное окно создания/редактирования транзакции
  // showAddTransactionModal()           -> new transaction
  // showAddTransactionModal('expense')  -> new transaction with the type preset (widgets)
  // showAddTransactionModal(row)        -> edit an existing income/expense row
  function showAddTransactionModal(transactionData = null) {
    const modalId = 'transaction-modal';
    const presetType = typeof transactionData === 'string' ? transactionData : null;
    if (typeof transactionData !== 'object') transactionData = null;
    const isEditing = !!transactionData;
    // Opening balances and transfers have their own sign rules: this form only
    // knows income/expense, so it would flip -500 into +500. Keep their type
    // and sign untouched (the Edit button is hidden for them anyway).
    const lockedType = isEditing && !['income', 'expense'].includes(transactionData.type)
      ? String(transactionData.type || '') : null;
    const selectedType = isEditing ? transactionData.type : (presetType === 'income' ? 'income' : 'expense');

    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${isEditing ? t('transactions.modal.editTitle') : t('transactions.modal.createTitle')}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">${t('transactions.field.account')}</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">${t('transactions.selectAccount')}</option>
                ${appState.accounts.map(account => `
                  <option value="${escapeHtml(account.id)}" ${isEditing && transactionData.account_id == account.id ? 'selected' : ''}>
                    ${escapeHtml(account.name)} (${escapeHtml(formatCurrency(account.balance, account.currency))})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-type" class="form-label">${t('transactions.field.type')}</label>
              <select id="${modalId}-type" class="form-control" required ${lockedType ? 'disabled' : ''}>
                ${lockedType ? `<option value="${escapeHtml(lockedType)}" selected>${escapeHtml(lockedType)}</option>` : `
                <option value="income" ${selectedType === 'income' ? 'selected' : ''}>${t('common.income')}</option>
                <option value="expense" ${selectedType === 'expense' ? 'selected' : ''}>${t('common.expense')}</option>`}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">${t('common.amount')}</label>
              <input type="number" id="${modalId}-amount" class="form-control" step="0.01" value="${isEditing ? escapeHtml(Math.abs(Number(transactionData.amount) || 0)) : ''}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-date" class="form-label">${t('common.date')}</label>
              <input type="date" id="${modalId}-date" class="form-control" value="${escapeHtml(isEditing ? String(transactionData.date || '').slice(0, 10) : UI.todayYMD())}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-category" class="form-label">${t('common.category')}</label>
              <input type="text" id="${modalId}-category" class="form-control" list="${modalId}-categories" value="${isEditing ? escapeHtml(transactionData.category) : ''}">
              <datalist id="${modalId}-categories">
                <!-- Категории будут загружены динамически -->
              </datalist>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-description" class="form-label">${t('common.description')}</label>
              <input type="text" id="${modalId}-description" class="form-control" value="${isEditing ? escapeHtml(transactionData.description) : ''}">
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">${t('btn.cancel')}</button>
              <button type="submit" class="btn btn-primary">${isEditing ? t('btn.save') : t('btn.create')}</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    // Добавление модального окна на страницу
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Получение ссылок на элементы
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const modalCancel = document.getElementById(`${modalId}-cancel`);
    const modalForm = document.getElementById(`${modalId}-form`);
    const typeSelect = document.getElementById(`${modalId}-type`);
    const amountInput = document.getElementById(`${modalId}-amount`);
    
    // Загрузка категорий
    fetchCategories().then(categories => {
      const categoriesDatalist = document.getElementById(`${modalId}-categories`);
      categoriesDatalist.innerHTML = categories.map(category => `<option value="${escapeHtml(category)}">`).join('');
    });
    
    // Функция закрытия модального окна
    const closeModal = () => {
      modalBackdrop.classList.add('closing');
      
      // Удаление модального окна после завершения анимации
      setTimeout(() => {
        document.body.removeChild(modalBackdrop);
      }, 300);
    };
    
    // Обработчики событий
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Обработчик отправки формы (кнопка заблокирована, пока запрос в пути)
    modalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      UI.busy(modalForm, () => submitTransactionForm()).catch((err) => console.error(err));
    });

    async function submitTransactionForm() {
      const accountId = document.getElementById(`${modalId}-account`).value;
      const type = lockedType || document.getElementById(`${modalId}-type`).value;
      let amount = parseFloat(document.getElementById(`${modalId}-amount`).value);
      
      if (lockedType) {
        // Keep the original sign of opening/transfer rows.
        amount = (Number(transactionData.amount) < 0 ? -1 : 1) * Math.abs(amount);
      } else if (type === 'expense') {
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
      
      // Создание или обновление транзакции
      let success = false;
      
      if (isEditing) {
        success = await updateTransaction(transactionData.id, transactionFormData);
      } else {
        const newTransaction = await createTransaction(transactionFormData);
        success = !!newTransaction;
      }
      
      if (success) {
        closeModal();
        
        // Обновление интерфейса в зависимости от текущей страницы
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
    }
  }
  
  // Модальное окно импорта транзакций
  function showImportTransactionsModal() {
    // Создание модального окна
    const modalId = 'import-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${t('transactions.import.title')}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">${t('transactions.field.account')}</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">${t('transactions.selectAccount')}</option>
                ${appState.accounts.map(account => `
                  <option value="${escapeHtml(account.id)}">
                    ${escapeHtml(account.name)} (${escapeHtml(formatCurrency(account.balance, account.currency))})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-bank-type" class="form-label">${t('transactions.import.bankFormat')}</label>
              <select id="${modalId}-bank-type" class="form-control">
                <option value="generic">${t('transactions.import.autoDetect')}</option>
                <option value="rbc">RBC Royal Bank</option>
                <option value="td">TD Canada Trust</option>
                <option value="scotiabank">Scotiabank</option>
                <option value="bmo">BMO</option>
                <option value="cibc">CIBC</option>
                <option value="tangerine">Tangerine</option>
                <option value="wealthsimple">Wealthsimple Cash</option>
                <option value="eqbank">EQ Bank</option>
                <option value="monobank">Monobank</option>
                <option value="revolut">Revolut</option>
                <option value="wise">Wise</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-file" class="form-label">${t('transactions.import.file')}</label>
              <div class="file-upload">
                <input type="file" id="${modalId}-file" class="file-input" accept=".csv" required>
                <div class="file-label">
                  <span id="${modalId}-file-name">${t('transactions.import.chooseFile')}</span>
                </div>
              </div>
            </div>
            
            <div class="import-info">
              <p><i class="fas fa-info-circle"></i> ${t('transactions.import.hint1')}</p>
              <p>${t('transactions.import.hint2')}</p>
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">${t('btn.cancel')}</button>
              <button type="submit" class="btn btn-primary">${t('btn.import')}</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    // Добавление модального окна на страницу
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Получение ссылок на элементы
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const modalCancel = document.getElementById(`${modalId}-cancel`);
    const modalForm = document.getElementById(`${modalId}-form`);
    const fileInput = document.getElementById(`${modalId}-file`);
    const fileNameDisplay = document.getElementById(`${modalId}-file-name`);
    
    // Обновление имени файла при выборе
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        fileNameDisplay.textContent = fileInput.files[0].name;
      } else {
        fileNameDisplay.textContent = t('transactions.import.chooseFile');
      }
    });
    
    // Функция закрытия модального окна
    const closeModal = () => {
      modalBackdrop.classList.add('closing');
      
      // Удаление модального окна после завершения анимации
      setTimeout(() => {
        document.body.removeChild(modalBackdrop);
      }, 300);
    };
    
    // Обработчики событий
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Обработчик отправки формы (кнопка заблокирована, пока запрос в пути)
    modalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      UI.busy(modalForm, () => submitImportForm()).catch((err) => console.error(err));
    });

    async function submitImportForm() {
      const accountId = document.getElementById(`${modalId}-account`).value;
      const bankType = document.getElementById(`${modalId}-bank-type`).value;
      const file = fileInput.files[0];
      
      if (!accountId || !file) {
        showNotification(t('transactions.import.selectAccountAndFile'), 'error');
        return;
      }
      
      // Создание FormData для отправки файла
      const formData = new FormData();
      formData.append('file', file);
      formData.append('accountId', accountId);
      formData.append('bankType', bankType);
      
      // Отправка данных
      const result = await importTransactionsFromCSV(formData);
      
      if (result) {
        closeModal();
        
        // Обновление интерфейса
        if (appState.currentPage === 'transactions') {
          renderTransactionsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    }
  }
  
  // Currency of a transaction row: the API row carries none, so take it from
  // the account (appState.accounts) and fall back to the base currency.
  function transactionCurrency(transaction, accountList) {
    if (transaction && transaction.currency) return transaction.currency;
    const accounts = Array.isArray(accountList) ? accountList
      : ((typeof appState !== 'undefined' && Array.isArray(appState.accounts)) ? appState.accounts : []);
    const acc = accounts.find(a => String(a.id) === String(transaction && transaction.account_id));
    return acc && acc.currency ? acc.currency : undefined;
  }

  // Рендеринг списка транзакций
  function renderTransactionsList(transactions) {
    // После рендера вставляем кнопку «Перевод» в тулбар транзакций (см.
    // ensureTransferButton). renderTransactionsList вызывается из app.js при
    // построении страницы, поэтому это самый надёжный additive-хук.
    if (typeof ensureTransferButton === 'function') {
      setTimeout(ensureTransferButton, 0);
    }
    return transactions.map(transaction => {
      const isTransfer = transaction.type === 'transfer';
      const isIncome = !isTransfer && transaction.type === 'income';
      // Для перевода знак определяем по сумме строки (списание < 0, зачисление > 0).
      const isInflow = (isTransfer || transaction.type === 'opening') ? transaction.amount >= 0 : isIncome;
      const category = transaction.category || t('transactions.uncategorized');
      const description = transaction.description || t('transactions.noDescription');
      // Класс/иконка/цвет суммы — отдельно для переводов, чтобы показать их
      // визуально иначе, чем доходы/расходы.
      const rowClass = isTransfer ? 'tx-transfer' : (isIncome ? 'tx-income' : 'tx-expense');
      const arrow = isTransfer ? 'right-arrow-left' : (isInflow ? 'down' : 'up');
      const amountClass = isTransfer
        ? 'transfer text-muted'
        : (isIncome ? 'income text-success' : 'expense text-error');
      const sign = isInflow ? '+' : '−';
      return `
      <tr data-transaction-id="${escapeHtml(transaction.id)}" class="tx-row ${rowClass}"${isTransfer ? ' data-transfer-id="' + escapeHtml(transaction.transfer_id || '') + '"' : ''}>
        <td data-label="${t('common.date')}" class="tx-cell tx-cell-date">${escapeHtml(formatDate(transaction.date))}</td>
        <td data-label="${t('common.description')}" class="tx-cell tx-cell-desc">
          <span class="tx-direction" aria-hidden="true"><i class="fas fa-${isTransfer ? 'exchange-alt' : 'arrow-' + arrow}"></i></span>
          <span class="tx-desc-text">${escapeHtml(description)}</span>
          ${isTransfer ? `<span class="chip tx-transfer-badge">${t('transactions.transfer')}</span>` : ''}
        </td>
        <td data-label="${t('common.category')}" class="tx-cell tx-cell-category">
          <span class="chip tx-category-chip">${escapeHtml(category)}</span>
        </td>
        <td data-label="${t('transactions.field.account')}" class="tx-cell tx-cell-account">${escapeHtml(transaction.account_name)}</td>
        <td data-label="${t('common.amount')}" class="text-right tx-cell tx-cell-amount transaction-amount ${amountClass}">
          <span class="tx-amount-sign" aria-hidden="true">${sign}</span>${escapeHtml(formatCurrency(Math.abs(transaction.amount), transactionCurrency(transaction)))}
        </td>
        <td data-label="${t('common.actions')}" class="tx-cell tx-cell-actions">
          <div class="table-actions">
            ${(isTransfer || transaction.type === 'opening') ? '' : `<button class="btn btn-sm btn-icon" data-transaction-action="edit" data-transaction-id="${escapeHtml(transaction.id)}" aria-label="${t('transactions.editAria')}" title="${t('btn.edit')}">
              <i class="fas fa-edit"></i>
            </button>`}
            <button class="btn btn-sm btn-icon btn-danger" data-transaction-action="delete" data-transaction-id="${escapeHtml(transaction.id)}" aria-label="${t('transactions.deleteAria')}" title="${t('btn.delete')}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
    }).join('');
  }

  // Вставка кнопки «Перевод» в тулбар страницы транзакций (рядом с импортом).
  // Идемпотентно: если кнопка уже есть — ничего не делает.
  function ensureTransferButton() {
    const toolbar = document.querySelector('.transactions-actions');
    if (!toolbar || document.getElementById('transfer-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'transfer-btn';
    btn.className = 'btn btn-sm btn-outline';
    btn.innerHTML = `<i class="fas fa-exchange-alt"></i> ${t('transactions.transfer')}`;
    btn.addEventListener('click', showTransferModal);
    // Ставим перед кнопкой импорта, если она есть, иначе в конец тулбара.
    const importBtn = document.getElementById('import-transactions-btn');
    if (importBtn) {
      toolbar.insertBefore(btn, importBtn);
    } else {
      toolbar.appendChild(btn);
    }
  }

  // POST /api/transactions/transfer — двойная запись перевода между счетами.
  async function createTransfer(transferData) {
    try {
      const response = await fetchWithAuth('/api/transactions/transfer', {
        method: 'POST',
        body: JSON.stringify(transferData)
      });

      if (!response.ok) {
        let message = t('transactions.transfer.createError');
        try {
          const data = await response.json();
          // Поддерживаем оба формата: { message } и { error: { message } }.
          message = (data && data.error && data.error.message) || data.message || message;
        } catch (_) { /* тело не JSON */ }
        showNotification(message, 'error');
        return null;
      }

      const result = await response.json();
      showNotification(t('transactions.transfer.done'), 'success');
      return result;
    } catch (error) {
      console.error('Ошибка создания перевода:', error);
      showNotification(t('transactions.transfer.failed'), 'error');
      return null;
    }
  }

  // Модальное окно создания перевода между двумя счетами.
  function showTransferModal() {
    const modalId = 'transfer-modal';
    const accounts = (typeof appState !== 'undefined' && appState.accounts) ? appState.accounts : [];

    const accountOptions = accounts.map(account => `
      <option value="${escapeHtml(account.id)}">
        ${escapeHtml(account.name)} (${escapeHtml(formatCurrency(account.balance, account.currency))})
      </option>
    `).join('');

    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${t('transactions.transfer.title')}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>

          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-from" class="form-label">${t('transactions.transfer.from')}</label>
              <select id="${modalId}-from" class="form-control" required>
                <option value="">${t('transactions.selectAccount')}</option>
                ${accountOptions}
              </select>
            </div>

            <div class="form-group">
              <label for="${modalId}-to" class="form-label">${t('transactions.transfer.to')}</label>
              <select id="${modalId}-to" class="form-control" required>
                <option value="">${t('transactions.selectAccount')}</option>
                ${accountOptions}
              </select>
            </div>

            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">${t('common.amount')}</label>
              <input type="number" id="${modalId}-amount" class="form-control" step="0.01" min="0.01" required>
            </div>

            <div class="form-group">
              <label for="${modalId}-date" class="form-label">${t('common.date')}</label>
              <input type="date" id="${modalId}-date" class="form-control" value="${UI.todayYMD()}" required>
            </div>

            <div class="form-group">
              <label for="${modalId}-description" class="form-label">${t('common.description')}</label>
              <input type="text" id="${modalId}-description" class="form-control" value="${t('transactions.transfer')}">
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">${t('btn.cancel')}</button>
              <button type="submit" class="btn btn-primary">${t('transactions.transfer.submit')}</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const modalCancel = document.getElementById(`${modalId}-cancel`);
    const modalForm = document.getElementById(`${modalId}-form`);

    const closeModal = () => {
      modalBackdrop.classList.add('closing');
      setTimeout(() => {
        if (modalBackdrop.parentNode) {
          document.body.removeChild(modalBackdrop);
        }
      }, 300);
    };

    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) closeModal();
    });

    modalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      UI.busy(modalForm, () => submitTransferForm()).catch((err) => console.error(err));
    });

    async function submitTransferForm() {
      const fromAccountId = document.getElementById(`${modalId}-from`).value;
      const toAccountId = document.getElementById(`${modalId}-to`).value;
      const amount = parseFloat(document.getElementById(`${modalId}-amount`).value);
      const date = document.getElementById(`${modalId}-date`).value;
      const description = document.getElementById(`${modalId}-description`).value;

      if (!fromAccountId || !toAccountId) {
        showNotification(t('transactions.transfer.selectBoth'), 'error');
        return;
      }
      if (fromAccountId === toAccountId) {
        showNotification(t('transactions.transfer.sameAccount'), 'error');
        return;
      }
      if (!(amount > 0)) {
        showNotification(t('transactions.transfer.positiveAmount'), 'error');
        return;
      }

      const result = await createTransfer({ fromAccountId, toAccountId, amount, date, description });

      if (result) {
        closeModal();
        // Обновляем интерфейс в зависимости от текущей страницы.
        if (typeof appState !== 'undefined') {
          if (appState.currentPage === 'transactions') {
            renderTransactionsPage();
          } else if (appState.currentPage === 'dashboard') {
            renderDashboard();
          } else if (appState.currentPage === 'accounts') {
            fetchAccounts().then(() => renderAccountsPage());
          }
        }
      }
    }
  }
  
  // Рендеринг пагинации
  function renderPagination(currentPage) {
    const totalPages = 5; // Упрощенный вариант, в реальности нужно получать из API
    
    if (totalPages <= 1) {
      return '';
    }
    
    // Формирование списка страниц
    let paginationHtml = '<ul class="pagination">';
    
    // Кнопка "Предыдущая"
    paginationHtml += `
      <li class="pagination-item">
        <a href="#" class="pagination-link ${currentPage <= 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" aria-label="${t('transactions.pagination.prev')}">
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
    
    // Кнопка "Следующая"
    paginationHtml += `
      <li class="pagination-item">
        <a href="#" class="pagination-link ${currentPage >= totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" aria-label="${t('transactions.pagination.next')}">
          <i class="fas fa-chevron-right"></i>
        </a>
      </li>
    `;
    
    paginationHtml += '</ul>';
    
    return paginationHtml;
  }
  
  // Обработка действий с транзакциями
  async function handleTransactionAction(e) {
    const button = e.currentTarget;
    const action = button.dataset.transactionAction;
    const transactionId = button.dataset.transactionId;
    
    if (!action || !transactionId) return;
    
    switch (action) {
      case 'edit': {
        // The row may be beyond the first page: load it by id.
        let transaction = null;
        try {
          const response = await fetchWithAuth(`/api/transactions/${encodeURIComponent(transactionId)}`);
          if (response.ok) transaction = await response.json();
        } catch (error) {
          if (!(error && error.status === 401)) console.error('Could not load the transaction:', error);
        }
        if (transaction && transaction.data && !transaction.id) transaction = transaction.data;
        if (transaction && transaction.type !== 'opening' && transaction.type !== 'transfer') {
          showAddTransactionModal(transaction);
        } else if (!transaction) {
          showNotification(t('transactions.fetchError'), 'error');
        }
        break;
      }
        
      case 'delete':
        if (confirm(t('transactions.confirmDelete'))) {
          const success = await deleteTransaction(transactionId);
          
          if (success) {
            // Обновление интерфейса
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
  
  // Функции для работы с фильтрами транзакций
  function toggleFilters() {
    const filtersForm = document.getElementById('filters-form');
    const toggleButton = document.getElementById('toggle-filters-btn');
    
    if (filtersForm.classList.contains('hidden')) {
      filtersForm.classList.remove('hidden');
      toggleButton.innerHTML = `<i class="fas fa-filter"></i> ${t('transactions.filters.hide')}`;
    } else {
      filtersForm.classList.add('hidden');
      toggleButton.innerHTML = `<i class="fas fa-filter"></i> ${t('transactions.filters.show')}`;
    }
  }
  
  // Применение фильтров транзакций
  function applyTransactionFilters() {
    // Получение значений фильтров
    appState.filters.startDate = document.getElementById('filter-date-start').value;
    appState.filters.endDate = document.getElementById('filter-date-end').value;
    appState.filters.accountId = document.getElementById('filter-account').value;
    appState.filters.category = document.getElementById('filter-category').value;
    appState.filters.type = document.getElementById('filter-type').value;
    appState.filters.search = document.getElementById('filter-search').value;
    appState.filters.page = 1; // Сброс страницы при применении новых фильтров
    
    // Обновление страницы транзакций
    renderTransactionsPage();
  }
  
  // Сброс фильтров транзакций
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
    
    // Обновление страницы транзакций
    renderTransactionsPage();
  }
  
  // One quoted CSV cell. Text starting with = + - @ TAB or CR is prefixed with
  // ' so spreadsheet apps do not evaluate it as a formula (CSV injection).
  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  // Экспорт данных
  async function handleDataExport() {
    const period = document.getElementById('export-period').value;
    let startDate = null;
    let endDate = null;
    
    // Определение периода
    if (period === 'custom') {
      startDate = document.getElementById('export-start-date').value;
      endDate = document.getElementById('export-end-date').value;
      
      if (!startDate || !endDate) {
        showNotification(t('transactions.export.needDates'), 'error');
        return;
      }
    } else if (period === 'month') {
      ({ start: startDate, end: endDate } = UI.monthRange(new Date()));
    } else if (period === 'year') {
      const year = new Date().getFullYear();
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
    }
    
    // Every page (the API caps a page at 500 rows).
    const transactions = await fetchAllTransactions({ startDate, endDate });
    
    if (!transactions.length) {
      showNotification(t('export.empty'), 'warning');
      return;
    }
    
    // Преобразование в CSV
    const headers = [t('common.date'), t('common.description'), t('common.category'), t('transactions.field.account'), t('common.amount'), t('common.type')];
    const csvRows = [headers.join(',')];
    
    transactions.forEach(transaction => {
      const rowData = [
        csvCell(transaction.date),
        csvCell(transaction.description),
        csvCell(transaction.category),
        csvCell(transaction.account_name),
        Number(transaction.amount) || 0,
        csvCell(transaction.type)
      ];
      
      csvRows.push(rowData.join(','));
    });
    
    const csvContent = csvRows.join('\n');
    
    // Создание временной ссылки для скачивания
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    link.href = url;
    link.setAttribute('download', `transactions_${startDate || 'all'}_${endDate || 'all'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showNotification(t('transactions.export.done'), 'success');
  }
  // Pure helpers for node/jsdom unit tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeTransactionStats, csvCell, transactionCurrency, renderTransactionsList };
  }
