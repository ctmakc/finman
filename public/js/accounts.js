// Функции для работы со счетами

// Получение счета по ID
async function fetchAccount(accountId) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`);
      
      if (!response.ok) {
        throw new Error('Не удалось получить данные счета');
      }
      
      return await response.json();
    } catch (error) {
      console.error('Ошибка получения счета:', error);
      showNotification('Ошибка получения счета', 'error');
      return null;
    }
  }
  
  // Создание нового счета
  async function createAccount(accountData) {
    try {
      const response = await fetchWithAuth('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(accountData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка создания счета', 'error');
        return null;
      }
      
      const newAccount = await response.json();
      
      // Обновление списка счетов
      appState.accounts.push(newAccount);
      
      showNotification('Счет успешно создан', 'success');
      return newAccount;
    } catch (error) {
      console.error('Ошибка создания счета:', error);
      showNotification('Произошла ошибка при создании счета', 'error');
      return null;
    }
  }
  
  // Обновление счета
  async function updateAccount(accountId, accountData) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`, {
        method: 'PUT',
        body: JSON.stringify(accountData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка обновления счета', 'error');
        return false;
      }
      
      const updatedAccount = await response.json();
      
      // Обновление списка счетов
      const index = appState.accounts.findIndex(acc => acc.id === accountId);
      if (index !== -1) {
        appState.accounts[index] = updatedAccount;
      }
      
      showNotification('Счет успешно обновлен', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка обновления счета:', error);
      showNotification('Произошла ошибка при обновлении счета', 'error');
      return false;
    }
  }
  
  // Удаление счета
  async function deleteAccount(accountId) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка удаления счета', 'error');
        return false;
      }
      
      // Обновление списка счетов
      appState.accounts = appState.accounts.filter(acc => acc.id !== accountId);
      
      showNotification('Счет успешно удален', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка удаления счета:', error);
      showNotification('Произошла ошибка при удалении счета', 'error');
      return false;
    }
  }
  
  // Модальное окно создания/редактирования счета
  function showAddAccountModal(accountData = null) {
    // Создание модального окна
    const modalId = 'account-modal';
    const isEditing = !!accountData;
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${isEditing ? 'Редактирование счета' : 'Создание счета'}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-name" class="form-label">Название счета</label>
              <input type="text" id="${modalId}-name" class="form-control" value="${isEditing ? accountData.name : ''}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-type" class="form-label">Тип счета</label>
              <select id="${modalId}-type" class="form-control">
                <option value="checking" ${isEditing && accountData.account_type === 'checking' ? 'selected' : ''}>Текущий счет</option>
                <option value="savings" ${isEditing && accountData.account_type === 'savings' ? 'selected' : ''}>Сберегательный счет</option>
                <option value="credit" ${isEditing && accountData.account_type === 'credit' ? 'selected' : ''}>Кредитная карта</option>
                <option value="loan" ${isEditing && accountData.account_type === 'loan' ? 'selected' : ''}>Кредит</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-bank" class="form-label">Банк</label>
              <input type="text" id="${modalId}-bank" class="form-control" value="${isEditing ? accountData.bank_name || '' : ''}">
            </div>
            
            <div class="form-group">
              <label for="${modalId}-number" class="form-label">Номер счета</label>
              <input type="text" id="${modalId}-number" class="form-control" value="${isEditing ? accountData.account_number || '' : ''}">
            </div>
            
            <div class="form-group">
              <label for="${modalId}-currency" class="form-label">Валюта</label>
              <select id="${modalId}-currency" class="form-control">
                <option value="RUB" ${isEditing && accountData.currency === 'RUB' ? 'selected' : ''}>Российский рубль (RUB)</option>
                <option value="USD" ${isEditing && accountData.currency === 'USD' ? 'selected' : ''}>Доллар США (USD)</option>
                <option value="EUR" ${isEditing && accountData.currency === 'EUR' ? 'selected' : ''}>Евро (EUR)</option>
                <option value="GBP" ${isEditing && accountData.currency === 'GBP' ? 'selected' : ''}>Фунт стерлингов (GBP)</option>
              </select>
            </div>
            
            ${!isEditing ? `
              <div class="form-group">
                <label for="${modalId}-balance" class="form-label">Начальный баланс</label>
                <input type="number" id="${modalId}-balance" class="form-control" step="0.01" value="0">
              </div>
            ` : ''}
            
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
      
      const accountFormData = {
        name: document.getElementById(`${modalId}-name`).value,
        accountType: document.getElementById(`${modalId}-type`).value,
        bankName: document.getElementById(`${modalId}-bank`).value,
        accountNumber: document.getElementById(`${modalId}-number`).value,
        currency: document.getElementById(`${modalId}-currency`).value
      };
      
      if (!isEditing) {
        accountFormData.balance = parseFloat(document.getElementById(`${modalId}-balance`).value) || 0;
      }
      
      // Создание или обновление счета
      let success = false;
      
      if (isEditing) {
        success = await updateAccount(accountData.id, accountFormData);
      } else {
        const newAccount = await createAccount(accountFormData);
        success = !!newAccount;
      }
      
      if (success) {
        closeModal();
        
        // Обновление интерфейса в зависимости от текущей страницы
        if (appState.currentPage === 'accounts') {
          renderAccountsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    });
  }
  
  // Обработка действий со счетами
  async function handleAccountAction(e) {
    const button = e.currentTarget;
    const action = button.dataset.accountAction;
    const accountId = button.dataset.accountId;
    
    if (!action || !accountId) return;
    
    switch (action) {
      case 'view':
        navigateTo('transactions');
        appState.filters.accountId = accountId;
        break;
        
      case 'edit':
        const accountData = await fetchAccount(accountId);
        if (accountData) {
          showAddAccountModal(accountData);
        }
        break;
        
      case 'delete':
        if (confirm('Вы действительно хотите удалить этот счет? Все связанные транзакции также будут удалены.')) {
          const success = await deleteAccount(accountId);
          
          if (success) {
            // Обновление интерфейса
            renderAccountsPage();
          }
        }
        break;
    }
  }