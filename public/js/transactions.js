// Функции для работы с транзакциями

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
        throw new Error('Не удалось получить транзакции');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Ошибка получения транзакций:', error);
      showNotification('Ошибка получения транзакций', 'error');
      return [];
    }
  }
  
  // Получение категорий транзакций
  async function fetchCategories() {
    try {
      // Простая реализация - извлечение категорий из существующих транзакций
      const transactions = await fetchTransactions({ limit: 1000 });
      
      // Извлечение уникальных категорий
      const categories = [...new Set(transactions.map(t => t.category))].filter(Boolean);
      
      return categories.sort();
    } catch (error) {
      console.error('Ошибка получения категорий:', error);
      return [];
    }
  }
  
  // Получение статистики транзакций
  async function fetchTransactionStats() {
    try {
      // Получение текущей даты
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Получение транзакций за текущий месяц
      const monthlyTransactions = await fetchTransactions({
        startDate: firstDayOfMonth.toISOString().split('T')[0],
        limit: 1000
      });
      
      // Получение всех счетов для расчета общего баланса
      const accounts = await fetchAccounts();
      
      // Расчет статистики
      const stats = {
        monthlyIncome: 0,
        monthlyExpense: 0,
        totalBalance: accounts.reduce((sum, acc) => sum + acc.balance, 0),
        transactionsByCategory: {},
        transactionsByMonth: {}
      };
      
      // Расчет доходов и расходов за месяц
      monthlyTransactions.forEach(transaction => {
        if (transaction.type === 'income') {
          stats.monthlyIncome += transaction.amount;
        } else {
          stats.monthlyExpense += Math.abs(transaction.amount);
        }
        
        // Группировка по категориям
        const category = transaction.category || 'Без категории';
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
        
        // Группировка по месяцам
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
      console.error('Ошибка получения статистики:', error);
      return {
        monthlyIncome: 0,
        monthlyExpense: 0,
        totalBalance: 0,
        transactionsByCategory: {},
        transactionsByMonth: {}
      };
    }
  }
  
  // Создание новой транзакции
  async function createTransaction(transactionData) {
    try {
      const response = await fetchWithAuth('/api/transactions', {
        method: 'POST',
        body: JSON.stringify(transactionData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка создания транзакции', 'error');
        return null;
      }
      
      const newTransaction = await response.json();
      showNotification('Транзакция успешно создана', 'success');
      
      return newTransaction;
    } catch (error) {
      console.error('Ошибка создания транзакции:', error);
      showNotification('Произошла ошибка при создании транзакции', 'error');
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
        showNotification(data.message || 'Ошибка обновления транзакции', 'error');
        return false;
      }
      
      showNotification('Транзакция успешно обновлена', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка обновления транзакции:', error);
      showNotification('Произошла ошибка при обновлении транзакции', 'error');
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
        showNotification(data.message || 'Ошибка удаления транзакции', 'error');
        return false;
      }
      
      showNotification('Транзакция успешно удалена', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка удаления транзакции:', error);
      showNotification('Произошла ошибка при удалении транзакции', 'error');
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
        showNotification(data.message || 'Ошибка импорта транзакций', 'error');
        return null;
      }
      
      const result = await response.json();
      showNotification(`Успешно импортировано ${result.count} транзакций`, 'success');
      
      return result;
    } catch (error) {
      console.error('Ошибка импорта транзакций:', error);
      showNotification('Произошла ошибка при импорте транзакций', 'error');
      return null;
    }
  }
  
  // Модальное окно создания/редактирования транзакции
  function showAddTransactionModal(transactionData = null) {
    // Создание модального окна
    const modalId = 'transaction-modal';
    const isEditing = !!transactionData;
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${isEditing ? 'Редактирование транзакции' : 'Создание транзакции'}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">Счет</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">Выберите счет</option>
                ${appState.accounts.map(account => `
                  <option value="${account.id}" ${isEditing && transactionData.account_id == account.id ? 'selected' : ''}>
                    ${account.name} (${formatCurrency(account.balance, account.currency)})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-type" class="form-label">Тип транзакции</label>
              <select id="${modalId}-type" class="form-control" required>
                <option value="income" ${isEditing && transactionData.type === 'income' ? 'selected' : ''}>Доход</option>
                <option value="expense" ${isEditing && transactionData.type === 'expense' ? 'selected' : ''}>Расход</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-amount" class="form-label">Сумма</label>
              <input type="number" id="${modalId}-amount" class="form-control" step="0.01" value="${isEditing ? Math.abs(transactionData.amount) : ''}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-date" class="form-label">Дата</label>
              <input type="date" id="${modalId}-date" class="form-control" value="${isEditing ? transactionData.date : new Date().toISOString().split('T')[0]}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-category" class="form-label">Категория</label>
              <input type="text" id="${modalId}-category" class="form-control" list="${modalId}-categories" value="${isEditing ? transactionData.category : ''}">
              <datalist id="${modalId}-categories">
                <!-- Категории будут загружены динамически -->
              </datalist>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-description" class="form-label">Описание</label>
              <input type="text" id="${modalId}-description" class="form-control" value="${isEditing ? transactionData.description : ''}">
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Отмена</button>
              <button type="submit" class="btn btn-primary">${isEditing ? 'Сохранить' : 'Создать'}</button>
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
      categoriesDatalist.innerHTML = categories.map(category => `<option value="${category}">`).join('');
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
    
    // Обработчик отправки формы
    modalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const accountId = document.getElementById(`${modalId}-account`).value;
      const type = document.getElementById(`${modalId}-type`).value;
      let amount = parseFloat(document.getElementById(`${modalId}-amount`).value);
      
      // Если это расход, делаем сумму отрицательной
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
    });
  }
  
  // Модальное окно импорта транзакций
  function showImportTransactionsModal() {
    // Создание модального окна
    const modalId = 'import-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Импорт транзакций из CSV</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-account" class="form-label">Счет</label>
              <select id="${modalId}-account" class="form-control" required>
                <option value="">Выберите счет</option>
                ${appState.accounts.map(account => `
                  <option value="${account.id}">
                    ${account.name} (${formatCurrency(account.balance, account.currency)})
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-bank-type" class="form-label">Тип банка</label>
              <select id="${modalId}-bank-type" class="form-control">
                <option value="generic">Общий формат</option>
                <option value="tinkoff">Тинькофф</option>
                <option value="sberbank">Сбербанк</option>
                <option value="vtb">ВТБ</option>
                <option value="alfabank">Альфа-Банк</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-file" class="form-label">CSV-файл</label>
              <div class="file-upload">
                <input type="file" id="${modalId}-file" class="file-input" accept=".csv" required>
                <div class="file-label">
                  <span id="${modalId}-file-name">Выберите файл</span>
                </div>
              </div>
            </div>
            
            <div class="import-info">
              <p><i class="fas fa-info-circle"></i> Файл должен содержать заголовки и следующие колонки: дата, описание, сумма, категория (опционально).</p>
              <p>Выберите соответствующий тип банка для корректного импорта данных.</p>
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Отмена</button>
              <button type="submit" class="btn btn-primary">Импортировать</button>
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
        fileNameDisplay.textContent = 'Выберите файл';
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
    
    // Обработчик отправки формы
    modalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const accountId = document.getElementById(`${modalId}-account`).value;
      const bankType = document.getElementById(`${modalId}-bank-type`).value;
      const file = fileInput.files[0];
      
      if (!accountId || !file) {
        showNotification('Пожалуйста, выберите счет и файл', 'error');
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
    });
  }
  
  // Рендеринг списка транзакций
  function renderTransactionsList(transactions) {
    return transactions.map(transaction => `
      <tr data-transaction-id="${transaction.id}">
        <td>${formatDate(transaction.date)}</td>
        <td>${transaction.description || 'Без описания'}</td>
        <td>${transaction.category || 'Без категории'}</td>
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
        <a href="#" class="pagination-link ${currentPage <= 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" aria-label="Предыдущая">
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
        <a href="#" class="pagination-link ${currentPage >= totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" aria-label="Следующая">
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
      case 'edit':
        // Получение данных транзакции
        const transactions = await fetchTransactions();
        const transaction = transactions.find(t => t.id == transactionId);
        
        if (transaction) {
          showAddTransactionModal(transaction);
        }
        break;
        
      case 'delete':
        if (confirm('Вы действительно хотите удалить эту транзакцию?')) {
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
      toggleButton.innerHTML = '<i class="fas fa-filter"></i> Скрыть фильтры';
    } else {
      filtersForm.classList.add('hidden');
      toggleButton.innerHTML = '<i class="fas fa-filter"></i> Показать фильтры';
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
        showNotification('Пожалуйста, укажите начальную и конечную даты', 'error');
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
    
    // Получение транзакций за указанный период
    const transactions = await fetchTransactions({
      startDate,
      endDate,
      limit: 10000 // Большое значение для получения всех транзакций
    });
    
    if (!transactions.length) {
      showNotification('Нет данных для экспорта', 'warning');
      return;
    }
    
    // Преобразование в CSV
    const headers = ['Дата', 'Описание', 'Категория', 'Счет', 'Сумма', 'Тип'];
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
    
    // Создание временной ссылки для скачивания
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    link.href = url;
    link.setAttribute('download', `финансы_${startDate || 'все'}_${endDate || 'все'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showNotification('Данные успешно экспортированы', 'success');
  }