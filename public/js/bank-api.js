// Functions for banks connections API

// ==================== CUSTOM BANKS ====================

// Fetch custom banks user
async function fetchCustomBanks() {
  try {
    const response = await fetchWithAuth('/api/bank-api/custom-banks');
    if (!response.ok) {
      throw new Error('Failed to fetch custom banks list');
    }
    const data = await response.json();
    appState.customBanks = data;
    return data;
  } catch (error) {
    console.error('Error fetching custom banks:', error);
    return [];
  }
}

// Create custom bank
async function createCustomBank(bankData) {
  try {
    const response = await fetchWithAuth('/api/bank-api/custom-banks', {
      method: 'POST',
      body: JSON.stringify(bankData)
    });

    const data = await response.json();

    if (!response.ok) {
      showNotification(data.message || 'Failed to create bank', 'error');
      return null;
    }

    showNotification('Custom bank created successfully', 'success');
    return data.bank;
  } catch (error) {
    console.error('Failed to create custom bank:', error);
    showNotification('An error occurred on create bank', 'error');
    return null;
  }
}

// Delete custom bank
async function deleteCustomBank(bankId) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/custom-banks/${bankId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const data = await response.json();
      showNotification(data.message || 'Failed to delete bank', 'error');
      return false;
    }

    showNotification('Custom bank deleted', 'success');
    return true;
  } catch (error) {
    console.error('Failed to delete custom bank:', error);
    showNotification('An error occurred on delete bank', 'error');
    return false;
  }
}

// Connect to custom bank
async function connectToCustomBank(bankKey, apiKey) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/connect-custom/${bankKey}/direct`, {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });

    if (!response.ok) {
      const data = await response.json();
      showNotification(data.message || 'Error bank connection', 'error');
      return false;
    }

    showNotification('Bank successfully connected', 'success');
    return true;
  } catch (error) {
    console.error('Error connecting to custom bank:', error);
    showNotification('An error occurred during connection', 'error');
    return false;
  }
}

// Create modal custom bank
function showCreateCustomBankModal() {
  const modalId = 'create-custom-bank-modal';

  const modalHtml = `
    <div class="modal-backdrop" id="${modalId}-backdrop">
      <div class="modal" id="${modalId}">
        <div class="modal-header">
          <h2 class="modal-title">Add your bank</h2>
          <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
        </div>

        <form id="${modalId}-form" class="modal-body">
          <div class="form-group">
            <label for="${modalId}-name" class="form-label">Bank name *</label>
            <input type="text" id="${modalId}-name" class="form-control" placeholder="E.g.: My Bank" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-country" class="form-label">Country code *</label>
            <input type="text" id="${modalId}-country" class="form-control" placeholder="UA, CA, US, etc." maxlength="3" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-api-url" class="form-label">URL API *</label>
            <input type="url" id="${modalId}-api-url" class="form-control" placeholder="https://api.mybank.com" required>
          </div>

          <div class="form-group">
            <label for="${modalId}-auth-type" class="form-label">Authorization type</label>
            <select id="${modalId}-auth-type" class="form-control">
              <option value="api_key">API Key / Token</option>
              <option value="bearer">Bearer Token</option>
              <option value="oauth2">OAuth 2.0</option>
              <option value="merchant">Merchant ID + Password</option>
            </select>
          </div>

          <div class="form-group">
            <label for="${modalId}-instructions" class="form-label">Instructions for fetching token</label>
            <textarea id="${modalId}-instructions" class="form-control" rows="2" placeholder="How to fetch API key..."></textarea>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create bank</button>
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
      // Updating list banks
      await fetchBanksByRegion();
      // Update bank connection modal if open
      const bankConnectionModal = document.getElementById('bank-connection-modal-backdrop');
      if (bankConnectionModal) {
        bankConnectionModal.remove();
        showBankConnectionModal();
      }
    }
  });
}

// ==================== MAIN FUNCTIONS ====================

// Fetch banks by region
async function fetchBanksByRegion() {
  try {
    const response = await fetchWithAuth('/api/bank-api/banks-by-region');

    if (!response.ok) {
      throw new Error('Failed to fetch list banks');
    }

    const data = await response.json();
    appState.banksByRegion = data;
    return data;
  } catch (error) {
    console.error('Error fetching list banks:', error);
    return {};
  }
}

// Fetch bank connections
async function fetchBankConnections() {
    try {
      const response = await fetchWithAuth('/api/bank-api/connections');
      
      if (!response.ok) {
        throw new Error('Failed to fetch bank connections');
      }
      
      const data = await response.json();
      appState.bankConnections = data;
      
      return data;
    } catch (error) {
      console.error('Error fetching banks connections connections:', error);
      showNotification('Error fetching banks connections connections', 'error');
      return [];
    }
  }
  
  // Bank connection (fetch OAuth URL)
  async function connectToBank(bankId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error bank connection', 'error');
        return null;
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error bank connection:', error);
      showNotification('An error occurred connecting to bank', 'error');
      return null;
    }
  }
  
  // Direct connection via API key
  async function directConnectToBank(bankId, apiKey) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}/direct`, {
        method: 'POST',
        body: JSON.stringify({ apiKey })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error bank connection', 'error');
        return false;
      }
      
      showNotification('Bank successfully connected', 'success');
      return true;
    } catch (error) {
      console.error('Error bank connection:', error);
      showNotification('An error occurred connecting to bank', 'error');
      return false;
    }
  }
  
  // Processing callback connecting to bank
  async function handleBankCallback(bankId, code, state) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/connect/${bankId}/callback`, {
        method: 'POST',
        body: JSON.stringify({ code, state })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error completing bank connection', 'error');
        return false;
      }
      
      showNotification('Bank successfully connected', 'success');
      return true;
    } catch (error) {
      console.error('Error processing callback:', error);
      showNotification('An error occurred completing bank connection', 'error');
      return false;
    }
  }
  
  // Disconnect from bank
  async function disconnectBank(connectionId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/disconnect/${connectionId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error disconnecting from bank', 'error');
        return false;
      }
      
      showNotification('Bank connection deleted successfully', 'success');
      return true;
    } catch (error) {
      console.error('Error disconnecting from bank:', error);
      showNotification('An error occurred disconnecting from bank', 'error');
      return false;
    }
  }
  
  // Sync accounts with bank
  async function syncBankAccounts(connectionId) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/sync-accounts/${connectionId}`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error syncing accounts', 'error');
        return null;
      }
      
      const result = await response.json();
      
      // Update list accounts
      await fetchAccounts();
      
      showNotification(`Synced ${result.accounts.length} accounts`, 'success');
      return result;
    } catch (error) {
      console.error('Error syncing accounts:', error);
      showNotification('An error occurred syncing accounts', 'error');
      return null;
    }
  }
  
  // Sync transactions with bank
  async function syncBankTransactions(accountId, startDate, endDate) {
    try {
      const response = await fetchWithAuth(`/api/bank-api/sync-transactions/${accountId}`, {
        method: 'POST',
        body: JSON.stringify({ startDate, endDate })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error syncing transactions', 'error');
        return null;
      }
      
      const result = await response.json();
      showNotification(`Synced ${result.count} transactions`, 'success');
      return result;
    } catch (error) {
      console.error('Error syncing transactions:', error);
      showNotification('An error occurred syncing transactions', 'error');
      return null;
    }
  }
  
  // Bank connection modal
  async function showBankConnectionModal() {
    // Load banks by region if not yet loaded
    if (!appState.banksByRegion || Object.keys(appState.banksByRegion).length === 0) {
      await fetchBanksByRegion();
    }

    // Create modal
    const modalId = 'bank-connection-modal';

    // Generate HTML for banks by region
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
                    <h4>${esc(bank.name)}</h4>
                    <p class="bank-auth-type">${bank.authType === 'api_key' ? '🔑 API Key' : bank.authType === 'oauth2' ? '🔐 OAuth2' : '🔒 ' + esc(bank.authType)}</p>
                  </div>
                  <button class="btn btn-sm btn-primary connect-bank-btn" data-bank-id="${bank.id}" data-auth-type="${bank.authType}" data-requires-redirect="${bank.requiresRedirect}">
                    Connect
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
            <h2 class="modal-title">Connect Bank</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>

          <div class="modal-body">
            <div class="add-custom-bank-section">
              <button type="button" class="btn btn-outline" id="${modalId}-add-custom">
                <i class="fas fa-plus"></i> Add your bank
              </button>
            </div>

            <div class="banks-list" id="${modalId}-banks-list">
              ${renderBanksByRegion()}
            </div>

            <!-- Direct connection form (API key) -->
            <div id="${modalId}-direct-form" class="direct-connection-form hidden">
              <h3 id="${modalId}-bank-name"></h3>
              <p id="${modalId}-instructions" class="bank-instructions"></p>

              <div class="form-group">
                <label for="${modalId}-api-key" class="form-label">API Token</label>
                <input type="text" id="${modalId}-api-key" class="form-control" placeholder="Paste your token..." required>
              </div>

              <div class="form-actions">
                <button type="button" class="btn btn-outline" id="${modalId}-back-btn">
                  ← Back / Back
                </button>
                <button type="button" class="btn btn-primary" id="${modalId}-connect-btn">
                  Connect / Connect
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add modal to page
    safeInsertHTML(document.body, 'beforeend', modalHtml);
    
    // Get element references
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const directForm = document.getElementById(`${modalId}-direct-form`);
    const bankNameElement = document.getElementById(`${modalId}-bank-name`);
    const instructionsElement = document.getElementById(`${modalId}-instructions`);
    const apiKeyInput = document.getElementById(`${modalId}-api-key`);
    const backBtn = document.getElementById(`${modalId}-back-btn`);
    const connectBtn = document.getElementById(`${modalId}-connect-btn`);
    
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
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });

    // Add custom bank button
    const addCustomBtn = document.getElementById(`${modalId}-add-custom`);
    if (addCustomBtn) {
      addCustomBtn.addEventListener('click', () => {
        closeModal();
        showCreateCustomBankModal();
      });
    }

    // Find bank by ID across all regions
    const findBank = (bankId) => {
      for (const regionData of Object.values(appState.banksByRegion || {})) {
        const bank = regionData.banks.find(b => b.id === bankId);
        if (bank) return bank;
      }
      return appState.supportedBanks?.find(b => b.id === bankId);
    };

    // Handler for connection buttons
    const connectBankButtons = document.querySelectorAll('.connect-bank-btn');
    connectBankButtons.forEach(button => {
      button.addEventListener('click', async () => {
        const bankId = button.dataset.bankId;
        const requiresRedirect = button.dataset.requiresRedirect === 'true';
        const authType = button.dataset.authType;
        const bank = findBank(bankId);

        if (!bank) return;

        if (requiresRedirect && authType === 'oauth2') {
          // Bank requires OAuth2
          const authData = await connectToBank(bankId);

          if (authData && authData.url) {
            window.open(authData.url, '_blank');
            localStorage.setItem('bank_auth_state', authData.state);
            localStorage.setItem('bank_auth_id', bankId);
            closeModal();
            showBankAuthInstructionsModal(bank.name);
          } else if (authData && authData.directAuth) {
            // Bank supports direct auth despite requiresRedirect
            bankNameElement.textContent = bank.name;
            instructionsElement.textContent = bank.tokenInstructions || '';
            instructionsElement.style.display = bank.tokenInstructions ? 'block' : 'none';
            directForm.classList.remove('hidden');
            modal.querySelector('.banks-list').classList.add('hidden');
            directForm.dataset.bankId = bankId;
          }
        } else {
          // Direct connection via API key
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
    
    // Handler for Back button
    backBtn.addEventListener('click', () => {
      directForm.classList.add('hidden');
      modal.querySelector('.banks-list').classList.remove('hidden');
      modal.querySelector('.add-custom-bank-section').classList.remove('hidden');
    });
    
    // Handler for для кнопки "Подkeyить" в форме прям connection
    connectBtn.addEventListener('click', async () => {
      const bankId = directForm.dataset.bankId;
      const isCustomBank = directForm.dataset.isCustom === 'true';
      const apiKey = apiKeyInput.value.trim();

      if (!apiKey) {
        showNotification('Please, enter API-key', 'error');
        return;
      }

      // Используем разные функции для custom и обыч banks
      const success = isCustomBank
        ? await connectToCustomBank(bankId, apiKey)
        : await directConnectToBank(bankId, apiKey);

      if (success) {
        closeModal();

        // Update list connections
        await fetchBankConnections();

        // Update UI
        if (appState.currentPage === 'bank-connections') {
          renderBankConnectionsPage();
        }
      }
    });
  }
  
  // Модальное окно с инструкциями по авторизации
  function showBankAuthInstructionsModal(bankName) {
    // Create modal
    const modalId = 'bank-auth-instructions-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Connect to ${bankName}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <div class="modal-body">
            <div class="auth-instructions">
              <h3>Authorization instructions</h3>
              <ol>
                <li>In the opened window, sign in to your ${bankName} account.</li>
                <li>Grant access to the requested data.</li>
                <li>After completing, return to this window and click "I signed in".</li>
              </ol>

              <div class="auth-code-form">
                <div class="form-group">
                  <label for="${modalId}-code" class="form-label">Authorization code</label>
                  <input type="text" id="${modalId}-code" class="form-control" placeholder="Paste the code from the address bar...">
                  <p class="form-hint">If you were redirected to a page with a code, copy and paste it here.</p>
                </div>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="${modalId}-complete">I signed in</button>
          </div>
        </div>
      </div>
    `;
    
    // Add modal to page
    safeInsertHTML(document.body, 'beforeend', modalHtml);
    
    // Get element references
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    const cancelBtn = document.getElementById(`${modalId}-cancel`);
    const completeBtn = document.getElementById(`${modalId}-complete`);
    const codeInput = document.getElementById(`${modalId}-code`);
    
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
    cancelBtn.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Handler for завершения авторизации
    completeBtn.addEventListener('click', async () => {
      const code = codeInput.value.trim();
      const state = localStorage.getItem('bank_auth_state');
      const bankId = localStorage.getItem('bank_auth_id');
      
      if (!state || !bankId) {
        showNotification('Authorization error: state data missing', 'error');
        return;
      }
      
      if (!code) {
        showNotification('Please enter the authorization code', 'warning');
        return;
      }
      
      const success = await handleBankCallback(bankId, code, state);
      
      if (success) {
        // Очистка времен дан
        localStorage.removeItem('bank_auth_state');
        localStorage.removeItem('bank_auth_id');
        
        closeModal();
        
        // Update list connections
        await fetchBankConnections();
        
        // Update UI
        if (appState.currentPage === 'bank-connections') {
          renderBankConnectionsPage();
        }
      }
    });
  }
  
  // Модальное окно синхронизации transactions
  function showSyncTransactionsModal(account) {
    // Create modal
    const modalId = 'sync-transactions-modal';
    
    // Fetch current date и даты 30 days назад
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    
    const todayStr = today.toISOString().split('T')[0];
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Sync transactions</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <form id="${modalId}-form" class="modal-body">
            <p>Sync transactions for account <strong>${esc(account.name)}</strong>.</p>
            
            <div class="form-group">
              <label for="${modalId}-start-date" class="form-label">Start date</label>
              <input type="date" id="${modalId}-start-date" class="form-control" value="${thirtyDaysAgoStr}" required>
            </div>
            
            <div class="form-group">
              <label for="${modalId}-end-date" class="form-label">End date</label>
              <input type="date" id="${modalId}-end-date" class="form-control" value="${todayStr}" required>
            </div>
            
            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="${modalId}-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">Sync</button>
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
      
      const startDate = document.getElementById(`${modalId}-start-date`).value;
      const endDate = document.getElementById(`${modalId}-end-date`).value;
      
      if (!startDate || !endDate) {
        showNotification('Please specify both dates', 'error');
        return;
      }
      
      // Проверка корректности дат
      if (new Date(startDate) > new Date(endDate)) {
        showNotification('Start date cannot be after end date', 'error');
        return;
      }
      
      // Sync transactions
      const result = await syncBankTransactions(account.id, startDate, endDate);
      
      if (result) {
        closeModal();
        
        // Update UI depending on current page
        if (appState.currentPage === 'transactions') {
          renderTransactionsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    });
  }
  
  // Render list banks connections connections
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
              ${connection.isActive ? 'Active' : 'Inactive'}
            </p>
          </div>
        </div>
        
        <div class="bank-connection-info">
          <p class="bank-connection-date">Connected: ${new Date(connection.createdAt).toLocaleDateString()}</p>
          ${connection.expiresAt ? `<p class="bank-connection-expires">Expires: ${new Date(connection.expiresAt).toLocaleDateString()}</p>` : ''}
        </div>
        
        <div class="bank-connection-actions">
          <button class="btn btn-sm btn-primary" data-connection-action="sync-accounts" data-connection-id="${connection.id}">
            <i class="fas fa-sync"></i> Sync accounts
          </button>
          <button class="btn btn-sm btn-outline" data-connection-action="sync-transactions" data-connection-id="${connection.id}">
            <i class="fas fa-exchange-alt"></i> Sync transactions
          </button>
          <button class="btn btn-sm btn-danger" data-connection-action="disconnect" data-connection-id="${connection.id}">
            <i class="fas fa-unlink"></i> Disconnect
          </button>
        </div>
      </div>
    `).join('');
  }
  
  // Processing действий с banks connections connectionми
  async function handleConnectionAction(e) {
    const button = e.currentTarget;
    const action = button.dataset.connectionAction;
    const connectionId = button.dataset.connectionId;
    
    if (!action || !connectionId) return;
    
    switch (action) {
      case 'sync-accounts':
        // Sync accounts
        const result = await syncBankAccounts(connectionId);
        
        if (result) {
          // Update UI
          if (appState.currentPage === 'bank-connections') {
            renderBankConnectionsPage();
          } else if (appState.currentPage === 'accounts') {
            renderAccountsPage();
          }
        }
        break;
        
      case 'sync-transactions':
        // Fetch accounts для данн connection
        const connection = appState.bankConnections.find(conn => conn.id == connectionId);
        
        if (!connection || !connection.accountIds || connection.accountIds.length === 0) {
          showNotification('Please sync accounts first', 'warning');
          return;
        }
        
        // Показ list accounts для выбора
        showAccountSelectionModal(connection);
        break;
        
      case 'disconnect':
        showConfirm('Disconnect this bank connection?', async () => {
          const success = await disconnectBank(connectionId);
          if (success) {
            await fetchBankConnections();
            renderBankConnectionsPage();
          }
        }, { title: 'Disconnect bank' });
        break;
    }
  }
  
  // Модальное окно выбора accounts для синхронизации transactions
  function showAccountSelectionModal(connection) {
    // Фильтрация accounts by ID of connection
    const accountsForConnection = appState.accounts.filter(account => 
      connection.accountIds.includes(account.id)
    );
    
    if (accountsForConnection.length === 0) {
      showNotification('No linked accounts available to sync', 'warning');
      return;
    }
    
    // Create modal
    const modalId = 'account-selection-modal';
    
    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">Select account to sync</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>
          
          <div class="modal-body">
            <p>Select account to sync transactions from ${connection.bankName}:</p>
            
            <div class="accounts-selection-list">
              ${accountsForConnection.map(account => `
                <div class="account-selection-item" data-account-id="${account.id}">
                  <div class="account-selection-icon">
                    <i class="fas ${getAccountIcon(account.account_type)}"></i>
                  </div>
                  <div class="account-selection-details">
                    <h3 class="account-selection-name">${esc(account.name)}</h3>
                    <p class="account-selection-number">${account.account_number || 'No number'}</p>
                  </div>
                  <div class="account-selection-balance">
                    ${formatCurrency(account.balance, account.currency)}
                  </div>
                  <button class="btn btn-sm btn-primary select-account-btn" data-account-id="${account.id}">
                    Select
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add modal to page
    safeInsertHTML(document.body, 'beforeend', modalHtml);
    
    // Get element references
    const modal = document.getElementById(modalId);
    const modalBackdrop = document.getElementById(`${modalId}-backdrop`);
    const modalClose = document.getElementById(`${modalId}-close`);
    
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
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeModal();
      }
    });
    
    // Handler for выбора accounts
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