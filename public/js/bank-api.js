// Функции для работы с банковскими API

// ==================== КАСТОМНЫЕ БАНКИ ====================

// Получение кастомных банков пользователя
async function fetchCustomBanks() {
  try {
    const response = await fetchWithAuth('/api/bank-api/custom-banks');
    if (!response.ok) {
      throw new Error('Не удалось получить список кастомных банков');
    }
    const data = await response.json();
    appState.customBanks = data;
    return data;
  } catch (error) {
    console.error('Ошибка получения кастомных банков:', error);
    return [];
  }
}

// Создание кастомного банка
async function createCustomBank(bankData) {
  try {
    const response = await fetchWithAuth('/api/bank-api/custom-banks', {
      method: 'POST',
      body: JSON.stringify(bankData)
    });

    const data = await response.json();

    if (!response.ok) {
      showNotification(data.message || 'Ошибка создания банка', 'error');
      return null;
    }

    showNotification('Кастомный банк успешно создан', 'success');
    return data.bank;
  } catch (error) {
    console.error('Ошибка создания кастомного банка:', error);
    showNotification('Произошла ошибка при создании банка', 'error');
    return null;
  }
}

// Удаление кастомного банка
async function deleteCustomBank(bankId) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/custom-banks/${bankId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const data = await response.json();
      showNotification(data.message || 'Ошибка удаления банка', 'error');
      return false;
    }

    showNotification('Кастомный банк удален', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка удаления кастомного банка:', error);
    showNotification('Произошла ошибка при удалении банка', 'error');
    return false;
  }
}

// Подключение к кастомному банку
async function connectToCustomBank(bankKey, apiKey) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/connect-custom/${bankKey}/direct`, {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });

    if (!response.ok) {
      const data = await response.json();
      showNotification(data.message || 'Ошибка подключения к банку', 'error');
      return false;
    }

    showNotification('Банк успешно подключен', 'success');
    return true;
  } catch (error) {
    console.error('Ошибка подключения к кастомному банку:', error);
    showNotification('Произошла ошибка при подключении', 'error');
    return false;
  }
}

// Модальное окно создания кастомного банка
function showCreateCustomBankModal() {
  const modalId = 'create-custom-bank-modal';

  const modalHtml = `
    <div class="modal-backdrop" id="${modalId}-backdrop">
      <div class="modal" id="${modalId}">
        <div class="modal-header">
          <h2 class="modal-title">Добавить свой банк</h2>
          <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
        </div>

        <form id="${modalId}-form" class="modal-body">
          <div class="form-group">
            <label for="${modalId}-name" class="form-label">Название банка *</label>
            <input type="text" id="${modalId}-name" class="form-control" placeholder="Например: My Bank" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-country" class="form-label">Код страны *</label>
            <input type="text" id="${modalId}-country" class="form-control" placeholder="UA, CA, US, etc." maxlength="3" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-api-url" class="form-label">URL API *</label>
            <input type="url" id="${modalId}-api-url" class="form-control" placeholder="https://api.mybank.com" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-auth-type" class="form-label">Тип авторизации</label>
            <select id="${modalId}-auth-type" class="form-control">
              <option value="api_key">API Key / Token</option>
              <option value="bearer">Bearer Token</option>
              <option value="oauth2">OAuth 2.0</option>
              <option value="merchant">Merchant ID + Password</option>
            </select>
          </div>

          <div class="form-group">
            <label for="${modalId}-instructions" class="form-label">Инструкции получения токена</label>
            <textarea id="${modalId}-instructions" class="form-control" rows="2" placeholder="Как получить API ключ..."></textarea>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Отмена</button>
            <button type="submit" class="btn btn-primary">Создать банк</button>
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
      document.body.removeChild(modalBackdrop);
    }, 300);
  };

  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const bankData = {
      name: document.getElementById(`${modalId}-name`).value.trim(),
      country: document.getElementById(`${modalId}-country`).value.trim().toUpperCase(),
      apiUrl: document.getElementById(`${modalId}-api-url`).value.trim(),
      authType: document.getElementById(`${modalId}-auth-type`).value,
      tokenInstructions: document.getElementById(`${modalId}-instructions`).value.trim()
    };

    const result = await createCustomBank(bankData);

    if (result) {
      closeModal();
      // Обновляем список банков
      await fetchBanksByRegion();
      // Если открыто модальное окно подключения банков - обновляем его
      const bankConnectionModal = document.getElementById('bank-connection-modal-backdrop');
      if (bankConnectionModal) {
        bankConnectionModal.remove();
        showBankConnectionModal();
      }
    }
  });
}

// ==================== ОСНОВНЫЕ ФУНКЦИИ ====================

// Получение банков по регионам
async function fetchBanksByRegion() {
  try {
    const response = await fetchWithAuth('/api/bank-api/banks-by-region');

    if (!response.ok) {
      throw new Error('Не удалось получить список банков');
    }

    const data = await response.json();
    appState.banksByRegion = data;
    return data;
  } catch (error) {
    console.error('Ошибка получения списка банков:', error);
    return {};
  }
}

// Получение банковских подключений
async function fetchBankConnections() {
    try {
      const response = await fetchWithAuth('/api/bank-api/connections');
      
      if (!response.ok) {
        throw new Error('Не удалось получить подключения к банкам');
      }
      
      const data = await response.json();
      appState.bankConnections = data;
      
      return data;
    } catch (error) {
      console.error('Ошибка получения банковских подключений:', error);
      showNotification('Ошибка получения банковских подключений', 'error');
      return [];
    }
  }
  
  // Подключение к банку (получение URL авторизации)
  async function connectToBank(bankId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка подключения к банку', 'error');
        return null;
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Ошибка подключения к банку:', error);
      showNotification('Произошла ошибка при подключении к банку', 'error');
      return null;
    }
  }
  
  // Прямое подключение к банку (через API-ключ)
  async function directConnectToBank(bankId, apiKey) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}/direct`, {
        method: 'POST',
        body: JSON.stringify({ apiKey })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка подключения к банку', 'error');
        return false;
      }
      
      showNotification('Банк успешно подключен', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка подключения к банку:', error);
      showNotification('Произошла ошибка при подключении к банку', 'error');
      return false;
    }
  }
  
  // Обработка callback при подключении к банку
  async function handleBankCallback(bankId, code, state) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}/callback`, {
        method: 'POST',
        body: JSON.stringify({ code, state })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка завершения подключения к банку', 'error');
        return false;
      }
      
      showNotification('Банк успешно подключен', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка обработки callback:', error);
      showNotification('Произошла ошибка при завершении подключения к банку', 'error');
      return false;
    }
  }
  
  // Отключение от банка
  async function disconnectBank(connectionId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/disconnect/${connectionId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка отключения от банка', 'error');
        return false;
      }
      
      showNotification('Подключение к банку успешно удалено', 'success');
      return true;
    } catch (error) {
      console.error('Ошибка отключения от банка:', error);
      showNotification('Произошла ошибка при отключении от банка', 'error');
      return false;
    }
  }
  
  // Синхронизация счетов с банком
  async function syncBankAccounts(connectionId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/sync-accounts/${connectionId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка синхронизации счетов', 'error');
        return null;
      }
      
      const result = await response.json();
      
      // Обновление списка счетов
      await fetchAccounts();
      
      showNotification(`Синхронизировано ${result.accounts.length} счетов`, 'success');
      return result;
    } catch (error) {
      console.error('Ошибка синхронизации счетов:', error);
      showNotification('Произошла ошибка при синхронизации счетов', 'error');
      return null;
    }
  }
  
  // Синхронизация транзакций с банком
  async function syncBankTransactions(accountId, startDate, endDate) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/sync-transactions/${accountId}`, {
        method: 'POST',
        body: JSON.stringify({ startDate, endDate })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Ошибка синхронизации транзакций', 'error');
        return null;
      }
      
      const result = await response.json();
      showNotification(`Синхронизировано ${result.count} транзакций`, 'success');
      return result;
    } catch (error) {
      console.error('Ошибка синхронизации транзакций:', error);
      showNotification('Произошла ошибка при синхронизации транзакций', 'error');
      return null;
    }
  }
  
  // Модальное окно подключения к банку
  async function showBankConnectionModal() {
    // Загружаем банки по регионам если ещё не загружены
    if (!appState.banksByRegion || Object.keys(appState.banksByRegion).length === 0) {
      await fetchBanksByRegion();
    }

    // Создание модального окна
    const modalId = 'bank-connection-modal';

    // Генерация HTML для банков по регионам
    const renderBanksByRegion = () => {
      const regions = appState.banksByRegion || {};
      let html = '';

      for (const [regionId, regionData] of Object.entries(regions)) {
        if (regionId === 'test' && window.location.hostname !== 'localhost') continue;

        html += `
          <div class="region-section" data-region="${regionId}">
            <h3 class="region-title">${regionData.flag} ${regionData.name}</h3>
            <div class="banks-grid">
              ${regionData.banks.map(bank => `
                <div class="bank-item" data-bank-id="${bank.id}">
                  <div class="bank-icon">
                    <i class="fas fa-university"></i>
                  </div>
                  <div class="bank-info">
                    <h4>${bank.name}</h4>
                    <p class="bank-auth-type">${bank.authType === 'api_key' ? '🔑 API Key' : bank.authType === 'oauth2' ? '🔐 OAuth2' : '🔒 ' + bank.authType}</p>
                  </div>
                  <button class="btn btn-sm btn-primary connect-bank-btn" data-bank-id="${bank.id}" data-auth-type="${bank.authType}" data-requires-redirect="${bank.requiresRedirect}">
                    Підключити
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
      return html;
    };

    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal modal-lg" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Підключення банку / Connect Bank</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>

          <div class="modal-body">
            <div class="add-custom-bank-section">
              <button type="button" class="btn btn-outline" id="${modalId}-add-custom">
                <i class="fas fa-plus"></i> Добавить свой банк
              </button>
            </div>

            <div class="banks-list" id="${modalId}-banks-list">
              ${renderBanksByRegion()}
            </div>

            <!-- Форма для прямого подключения (API key) -->
            <div id="${modalId}-direct-form" class="direct-connection-form hidden">
              <h3 id="${modalId}-bank-name"></h3>
              <p id="${modalId}-instructions" class="bank-instructions"></p>

              <div class="form-group">
                <label for="${modalId}-api-key" class="form-label">API Token / Токен</label>
                <input type="text" id="${modalId}-api-key" class="form-control" placeholder="Вставте ваш токен..." required>
              </div>

              <div class="form-actions">
                <button type="button" class="btn btn-outline" id="${modalId}-back-btn">
                  ← Назад / Back
                </button>
                <button type="button" class="btn btn-primary" id="${modalId}-connect-btn">
                  Підключити / Connect
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Добавление модального окна на страницу
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Получение ссылок на элементы
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const directForm = document.getElementById(`${modalId}-direct-form`);
    const bankNameElement = document.getElementById(`${modalId}-bank-name`);
    const instructionsElement = document.getElementById(`${modalId}-instructions`);
    const apiKeyInput = document.getElementById(`${modalId}-api-key`);
    const backBtn = document.getElementById(`${modalId}-back-btn`);
    const connectBtn = document.getElementById(`${modalId}-connect-btn`);
    
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
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });

    // Кнопка добавления кастомного банка
    const addCustomBtn = document.getElementById(`${modalId}-add-custom`);
    if (addCustomBtn) {
      addCustomBtn.addEventListener('click', () => {
        closeModal();
        showCreateCustomBankModal();
      });
    }

    // Находим банк по ID из всех регионов
    const findBank = (bankId) => {
      for (const regionData of Object.values(appState.banksByRegion || {})) {
        const bank = regionData.banks.find(b => b.id === bankId);
        if (bank) return bank;
      }
      return appState.supportedBanks?.find(b => b.id === bankId);
    };

    // Обработчик для кнопок подключения
    const connectBankButtons = document.querySelectorAll('.connect-bank-btn');
    connectBankButtons.forEach(button => {
      button.addEventListener('click', async () => {
        const bankId = button.dataset.bankId;
        const requiresRedirect = button.dataset.requiresRedirect === 'true';
        const authType = button.dataset.authType;
        const bank = findBank(bankId);

        if (!bank) return;

        if (requiresRedirect && authType === 'oauth2') {
          // Банк требует OAuth2 авторизацию
          const authData = await connectToBank(bankId);

          if (authData && authData.url) {
            window.open(authData.url, '_blank');
            localStorage.setItem('bank_auth_state', authData.state);
            localStorage.setItem('bank_auth_id', bankId);
            closeModal();
            showBankAuthInstructionsModal(bank.name);
          } else if (authData && authData.directAuth) {
            // Банк поддерживает прямую авторизацию несмотря на requiresRedirect
            bankNameElement.textContent = bank.name;
            instructionsElement.textContent = bank.tokenInstructions || '';
            instructionsElement.style.display = bank.tokenInstructions ? 'block' : 'none';
            directForm.classList.remove('hidden');
            modal.querySelector('.banks-list').classList.add('hidden');
            directForm.dataset.bankId = bankId;
          }
        } else {
          // Прямое подключение через API-ключ/токен
          bankNameElement.textContent = bank.name;
          instructionsElement.textContent = bank.tokenInstructions || '';
          instructionsElement.style.display = bank.tokenInstructions ? 'block' : 'none';
          directForm.classList.remove('hidden');
          modal.querySelector('.banks-list').classList.add('hidden');
          modal.querySelector('.add-custom-bank-section').classList.add('hidden');
          directForm.dataset.bankId = bankId;
          directForm.dataset.isCustom = bank.isCustom ? 'true' : 'false';
        }
      });
    });
    
    // Обработчик для кнопки "Назад"
    backBtn.addEventListener('click', () => {
      directForm.classList.add('hidden');
      modal.querySelector('.banks-list').classList.remove('hidden');
      modal.querySelector('.add-custom-bank-section').classList.remove('hidden');
    });
    
    // Обработчик для кнопки "Подключить" в форме прямого подключения
    connectBtn.addEventListener('click', async () => {
      const bankId = directForm.dataset.bankId;
      const isCustomBank = directForm.dataset.isCustom === 'true';
      const apiKey = apiKeyInput.value.trim();

      if (!apiKey) {
        showNotification('Пожалуйста, введите API-ключ', 'error');
        return;
      }

      // Используем разные функции для кастомных и обычных банков
      const success = isCustomBank
        ? await connectToCustomBank(bankId, apiKey)
        : await directConnectToBank(bankId, apiKey);

      if (success) {
        closeModal();

        // Обновление списка подключений
        await fetchBankConnections();

        // Обновление интерфейса
        if (appState.currentPage === 'bank-connections') {
          renderBankConnectionsPage();
        }
      }
    });
  }
  
  // Модальное окно с инструкциями по авторизации
  function showBankAuthInstructionsModal(bankName) {
    // Создание модального окна
    const modalId = 'bank-auth-instructions-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Авторизация ${bankName}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <div class="modal-body">
            <div class="auth-instructions">
              <h3>Инструкции по авторизации</h3>
              <ol>
                <li>В открывшемся окне войдите в свой аккаунт ${bankName}.</li>
                <li>Предоставьте доступ к запрашиваемым данным.</li>
                <li>После завершения вернитесь в это окно и нажмите "Я авторизовался".</li>
              </ol>
              
              <div class="auth-code-form">
                <div class="form-group">
                  <label for="${modalId}-code" class="form-label">Код авторизации</label>
                  <input type="text" id="${modalId}-code" class="form-control" placeholder="Вставьте код из адресной строки...">
                  <p class="form-hint">Если вы были перенаправлены на страницу с кодом, скопируйте его и вставьте сюда.</p>
                </div>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Отмена</button>
            <button type="button" class="btn btn-primary" id="${modalId}-complete">Я авторизовался</button>
          </div>
        </div>
      </div>
    `;
    
    // Добавление модального окна на страницу
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Получение ссылок на элементы
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const cancelBtn = document.getElementById(`${modalId}-cancel`);
    const completeBtn = document.getElementById(`${modalId}-complete`);
    const codeInput = document.getElementById(`${modalId}-code`);
    
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
    cancelBtn.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Обработчик завершения авторизации
    completeBtn.addEventListener('click', async () => {
      const code = codeInput.value.trim();
      const state = localStorage.getItem('bank_auth_state');
      const bankId = localStorage.getItem('bank_auth_id');
      
      if (!state || !bankId) {
        showNotification('Ошибка авторизации: данные не сохранены', 'error');
        return;
      }
      
      if (!code) {
        showNotification('Пожалуйста, введите код авторизации', 'warning');
        return;
      }
      
      const success = await handleBankCallback(bankId, code, state);
      
      if (success) {
        // Очистка временных данных
        localStorage.removeItem('bank_auth_state');
        localStorage.removeItem('bank_auth_id');
        
        closeModal();
        
        // Обновление списка подключений
        await fetchBankConnections();
        
        // Обновление интерфейса
        if (appState.currentPage === 'bank-connections') {
          renderBankConnectionsPage();
        }
      }
    });
  }
  
  // Модальное окно синхронизации транзакций
  function showSyncTransactionsModal(account) {
    // Создание модального окна
    const modalId = 'sync-transactions-modal';
    
    // Получение текущей даты и даты 30 дней назад
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    
    const todayStr = today.toISOString().split('T')[0];
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Синхронизация транзакций</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <p>Синхронизация транзакций для счета <strong>${account.name}</strong>.</p>
            
            <div class="form-group">
              <label for="${modalId}-start-date" class="form-label">Начальная дата</label>
              <input type="date" id="${modalId}-start-date" class="form-control" value="${thirtyDaysAgoStr}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-end-date" class="form-label">Конечная дата</label>
              <input type="date" id="${modalId}-end-date" class="form-control" value="${todayStr}" required>
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Отмена</button>
              <button type="submit" class="btn btn-primary">Синхронизировать</button>
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
      
      const startDate = document.getElementById(`${modalId}-start-date`).value;
      const endDate = document.getElementById(`${modalId}-end-date`).value;
      
      if (!startDate || !endDate) {
        showNotification('Пожалуйста, укажите даты', 'error');
        return;
      }
      
      // Проверка корректности дат
      if (new Date(startDate) > new Date(endDate)) {
        showNotification('Начальная дата не может быть позже конечной', 'error');
        return;
      }
      
      // Синхронизация транзакций
      const result = await syncBankTransactions(account.id, startDate, endDate);
      
      if (result) {
        closeModal();
        
        // Обновление интерфейса в зависимости от текущей страницы
        if (appState.currentPage === 'transactions') {
          renderTransactionsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    });
  }
  
  // Рендеринг списка банковских подключений
  function renderBankConnectionsList(connections) {
    return connections.map(connection => `
      <div class="bank-connection-card card" data-connection-id="${connection.id}">
        <div class="bank-connection-header">
          <div class="bank-connection-icon">
            <i class="fas fa-university"></i>
          </div>
          <div class="bank-connection-details">
            <h3 class="bank-connection-name">${connection.bankName}</h3>
            <p class="bank-connection-status">
              <span class="status-indicator ${connection.isActive ? 'active' : 'inactive'}"></span>
              ${connection.isActive ? 'Активно' : 'Неактивно'}
            </p>
          </div>
        </div>
        
        <div class="bank-connection-info">
          <p class="bank-connection-date">Подключено: ${new Date(connection.createdAt).toLocaleDateString()}</p>
          ${connection.expiresAt ? `<p class="bank-connection-expires">Действует до: ${new Date(connection.expiresAt).toLocaleDateString()}</p>` : ''}
        </div>
        
        <div class="bank-connection-actions">
          <button class="btn btn-sm btn-primary" data-connection-action="sync-accounts" data-connection-id="${connection.id}">
            <i class="fas fa-sync"></i> Синхронизировать счета
          </button>
          <button class="btn btn-sm btn-outline" data-connection-action="sync-transactions" data-connection-id="${connection.id}">
            <i class="fas fa-exchange-alt"></i> Синхронизировать транзакции
          </button>
          <button class="btn btn-sm btn-danger" data-connection-action="disconnect" data-connection-id="${connection.id}">
            <i class="fas fa-unlink"></i> Отключить
          </button>
        </div>
      </div>
    `).join('');
  }
  
  // Обработка действий с банковскими подключениями
  async function handleConnectionAction(e) {
    const button = e.currentTarget;
    const action = button.dataset.connectionAction;
    const connectionId = button.dataset.connectionId;
    
    if (!action || !connectionId) return;
    
    switch (action) {
      case 'sync-accounts':
        // Синхронизация счетов
        const result = await syncBankAccounts(connectionId);
        
        if (result) {
          // Обновление интерфейса
          if (appState.currentPage === 'bank-connections') {
            renderBankConnectionsPage();
          } else if (appState.currentPage === 'accounts') {
            renderAccountsPage();
          }
        }
        break;
        
      case 'sync-transactions':
        // Получение счетов для данного подключения
        const connection = appState.bankConnections.find(conn => conn.id == connectionId);
        
        if (!connection || !connection.accountIds || connection.accountIds.length === 0) {
          showNotification('Сначала необходимо синхронизировать счета', 'warning');
          return;
        }
        
        // Показ списка счетов для выбора
        showAccountSelectionModal(connection);
        break;
        
      case 'disconnect':
        if (confirm('Вы действительно хотите отключить этот банк?')) {
          const success = await disconnectBank(connectionId);
          
          if (success) {
            // Обновление списка подключений
            await fetchBankConnections();
            
            // Обновление интерфейса
            renderBankConnectionsPage();
          }
        }
        break;
    }
  }
  
  // Модальное окно выбора счета для синхронизации транзакций
  function showAccountSelectionModal(connection) {
    // Фильтрация счетов по ID из подключения
    const accountsForConnection = appState.accounts.filter(account => 
      connection.accountIds.includes(account.id)
    );
    
    if (accountsForConnection.length === 0) {
      showNotification('Нет доступных счетов для синхронизации', 'warning');
      return;
    }
    
    // Создание модального окна
    const modalId = 'account-selection-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Выберите счет для синхронизации</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <div class="modal-body">
            <p>Выберите счет для синхронизации транзакций из банка ${connection.bankName}:</p>
            
            <div class="accounts-selection-list">
              ${accountsForConnection.map(account => `
                <div class="account-selection-item" data-account-id="${account.id}">
                  <div class="account-selection-icon">
                    <i class="fas ${getAccountIcon(account.account_type)}"></i>
                  </div>
                  <div class="account-selection-details">
                    <h3 class="account-selection-name">${account.name}</h3>
                    <p class="account-selection-number">${account.account_number || 'Без номера'}</p>
                  </div>
                  <div class="account-selection-balance">
                    ${formatCurrency(account.balance, account.currency)}
                  </div>
                  <button class="btn btn-sm btn-primary select-account-btn" data-account-id="${account.id}">
                    Выбрать
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Добавление модального окна на страницу
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Получение ссылок на элементы
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    
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
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Обработчик выбора счета
    const selectAccountButtons = document.querySelectorAll('.select-account-btn');
    selectAccountButtons.forEach(button => {
      button.addEventListener('click', () => {
        const accountId = button.dataset.accountId;
        const account = appState.accounts.find(acc => acc.id == accountId);
        
        if (account) {
          closeModal();
          showSyncTransactionsModal(account);
        }
      });
    });
  }