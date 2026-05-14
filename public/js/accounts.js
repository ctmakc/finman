// Functions for working with accounts

// Fetch account by ID
async function fetchAccount(accountId) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`);

      if (!response.ok) {
        throw new Error('Failed to retrieve account data');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching account:', error);
      showNotification('Error fetching account', 'error');
      return null;
    }
  }

  // Create a new account
  async function createAccount(accountData) {
    try {
      const response = await fetchWithAuth('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(accountData)
      });

      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error creating account', 'error');
        return null;
      }

      const newAccount = await response.json();

      // Update accounts list
      appState.accounts.push(newAccount);

      showNotification('Account created successfully', 'success');
      return newAccount;
    } catch (error) {
      console.error('Error creating account:', error);
      showNotification('An error occurred while creating the account', 'error');
      return null;
    }
  }

  // Update account
  async function updateAccount(accountId, accountData) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`, {
        method: 'PUT',
        body: JSON.stringify(accountData)
      });

      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error updating account', 'error');
        return false;
      }

      const updatedAccount = await response.json();

      // Update accounts list
      const index = appState.accounts.findIndex(acc => acc.id === accountId);
      if (index !== -1) {
        appState.accounts[index] = updatedAccount;
      }

      showNotification('Account updated successfully', 'success');
      return true;
    } catch (error) {
      console.error('Error updating account:', error);
      showNotification('An error occurred while updating the account', 'error');
      return false;
    }
  }

  // Delete account
  async function deleteAccount(accountId) {
    try {
      const response = await fetchWithAuth(`/api/accounts/${accountId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || 'Error deleting account', 'error');
        return false;
      }

      // Update accounts list
      appState.accounts = appState.accounts.filter(acc => acc.id !== accountId);

      showNotification('Account deleted successfully', 'success');
      return true;
    } catch (error) {
      console.error('Error deleting account:', error);
      showNotification('An error occurred while deleting the account', 'error');
      return false;
    }
  }

  // Create/edit account modal
  function showAddAccountModal(accountData = null) {
    // Create modal
    const modalId = 'account-modal';
    const isEditing = !!accountData;

    const modalHtml = `
      <div class="modal-backdrop" id="${modalId}-backdrop">
        <div class="modal" id="${modalId}">
          <div class="modal-header">
            <h2 class="modal-title">${isEditing ? 'Edit Account' : 'Create Account'}</h2>
            <button type="button" class="modal-close" id="${modalId}-close">&times;</button>
          </div>

          <form id="${modalId}-form" class="modal-body">
            <div class="form-group">
              <label for="${modalId}-name" class="form-label">Account Name</label>
              <input type="text" id="${modalId}-name" class="form-control" value="${isEditing ? esc(accountData.name || '') : ''}" required>
            </div>

            <div class="form-group">
              <label for="${modalId}-type" class="form-label">Account Type</label>
              <select id="${modalId}-type" class="form-control">
                <option value="checking" ${isEditing && accountData.account_type === 'checking' ? 'selected' : ''}>Checking Account</option>
                <option value="savings" ${isEditing && accountData.account_type === 'savings' ? 'selected' : ''}>Savings Account</option>
                <option value="credit" ${isEditing && accountData.account_type === 'credit' ? 'selected' : ''}>Credit Card</option>
                <option value="loan" ${isEditing && accountData.account_type === 'loan' ? 'selected' : ''}>Loan</option>
              </select>
            </div>

            <div class="form-group">
              <label for="${modalId}-bank" class="form-label">Bank</label>
              <input type="text" id="${modalId}-bank" class="form-control" value="${isEditing ? esc(accountData.bank_name || '') : ''}">
            </div>

            <div class="form-group">
              <label for="${modalId}-number" class="form-label">Account Number</label>
              <input type="text" id="${modalId}-number" class="form-control" value="${isEditing ? esc(accountData.account_number || '') : ''}">
            </div>

            <div class="form-group">
              <label for="${modalId}-currency" class="form-label">Currency</label>
              <select id="${modalId}-currency" class="form-control">
                <option value="RUB" ${isEditing && accountData.currency === 'RUB' ? 'selected' : ''}>Russian Ruble (RUB)</option>
                <option value="USD" ${isEditing && accountData.currency === 'USD' ? 'selected' : ''}>US Dollar (USD)</option>
                <option value="EUR" ${isEditing && accountData.currency === 'EUR' ? 'selected' : ''}>Euro (EUR)</option>
                <option value="GBP" ${isEditing && accountData.currency === 'GBP' ? 'selected' : ''}>British Pound (GBP)</option>
              </select>
            </div>

            ${!isEditing ? `
              <div class="form-group">
                <label for="${modalId}-balance" class="form-label">Opening Balance</label>
                <input type="number" id="${modalId}-balance" class="form-control" step="0.01" value="0">
              </div>
            ` : ''}

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

    // Close modal function
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

      // Create or update account
      let success = false;

      if (isEditing) {
        success = await updateAccount(accountData.id, accountFormData);
      } else {
        const newAccount = await createAccount(accountFormData);
        success = !!newAccount;
      }

      if (success) {
        closeModal();

        // Update UI based on current page
        if (appState.currentPage === 'accounts') {
          renderAccountsPage();
        } else if (appState.currentPage === 'dashboard') {
          renderDashboard();
        }
      }
    });
  }

  // Handle account actions
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
        showConfirm('Delete this account? All associated transactions will also be deleted.', async () => {
          const success = await deleteAccount(accountId);
          if (success) renderAccountsPage();
        });
        break;
    }
  }
