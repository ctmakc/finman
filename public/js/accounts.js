// Функции для работы со счетами

// Получение счета по ID
async function fetchAccount(accountId) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`);
      
      if (!response.ok) {
        throw new Error(t('accounts.fetchError'));
      }
      
      return await response.json();
    } catch (error) {
      console.error('Ошибка получения счета:', error);
      showNotification(t('accounts.fetchError'), 'error');
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
        showNotification(data.message || t('accounts.createError'), 'error');
        return null;
      }
      
      const newAccount = await response.json();
      
      // Обновление списка счетов
      appState.accounts.push(newAccount);
      
      showNotification(t('accounts.created'), 'success');
      return newAccount;
    } catch (error) {
      console.error('Ошибка создания счета:', error);
      showNotification(t('accounts.createFailed'), 'error');
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
        showNotification(data.message || t('accounts.updateError'), 'error');
        return false;
      }
      
      const updatedAccount = await response.json();
      
      // Обновление списка счетов
      const index = appState.accounts.findIndex(acc => acc.id === accountId);
      if (index !== -1) {
        appState.accounts[index] = updatedAccount;
      }
      
      showNotification(t('accounts.updated'), 'success');
      return true;
    } catch (error) {
      console.error('Ошибка обновления счета:', error);
      showNotification(t('accounts.updateFailed'), 'error');
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
        showNotification(data.message || t('accounts.deleteError'), 'error');
        return false;
      }
      
      // Обновление списка счетов
      appState.accounts = appState.accounts.filter(acc => acc.id !== accountId);
      
      showNotification(t('accounts.deleted'), 'success');
      return true;
    } catch (error) {
      console.error('Ошибка удаления счета:', error);
      showNotification(t('accounts.deleteFailed'), 'error');
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
            <h2 class="modal-title">${isEditing ? t('accounts.modal.editTitle') : t('accounts.modal.createTitle')}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-name" class="form-label">${t('accounts.field.name')}</label>
              <input type="text" id="${modalId}-name" class="form-control" value="${isEditing ? escapeHtml(accountData.name) : ''}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-type" class="form-label">${t('accounts.field.type')}</label>
              <select id="${modalId}-type" class="form-control">
                <option value="checking" ${isEditing && accountData.account_type === 'checking' ? 'selected' : ''}>${t('accounts.type.checking')}</option>
                <option value="savings" ${isEditing && accountData.account_type === 'savings' ? 'selected' : ''}>${t('accounts.type.savings')}</option>
                <option value="credit" ${isEditing && accountData.account_type === 'credit' ? 'selected' : ''}>${t('accounts.type.credit')}</option>
                <option value="loan" ${isEditing && accountData.account_type === 'loan' ? 'selected' : ''}>${t('accounts.type.loan')}</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-bank" class="form-label">${t('accounts.field.bank')}</label>
              <input type="text" id="${modalId}-bank" class="form-control" value="${isEditing ? escapeHtml(accountData.bank_name || '') : ''}">
            </div>
            
            <div class="form-group">
              <label for="${modalId}-number" class="form-label">${t('accounts.field.number')}</label>
              <input type="text" id="${modalId}-number" class="form-control" value="${isEditing ? escapeHtml(accountData.account_number || '') : ''}">
            </div>
            
            <div class="form-group">
              <label for="${modalId}-currency" class="form-label">${t('common.currency')}</label>
              <select id="${modalId}-currency" class="form-control">
                ${UI.currencyOptions(isEditing ? accountData.currency : (appState.baseCurrency || undefined))}
              </select>
            </div>
            
            ${!isEditing ? `
              <div class="form-group">
                <label for="${modalId}-balance" class="form-label">${t('accounts.field.openingBalance')}</label>
                <input type="number" id="${modalId}-balance" class="form-control" step="0.01" value="0">
              </div>
            ` : ''}
            
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
      UI.busy(modalForm, () => submitAccountForm()).catch((err) => console.error(err));
    });

    async function submitAccountForm() {
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
    }
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
        if (confirm(t('accounts.confirmDelete'))) {
          const success = await deleteAccount(accountId);
          
          if (success) {
            // Обновление интерфейса
            renderAccountsPage();
          }
        }
        break;
    }
  }