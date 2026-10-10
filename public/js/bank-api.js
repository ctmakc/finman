// public/js/bank-api.js — Banks & statement import.
//
// Honest connectivity: Monobank connects with a personal token (real API);
// every other bank is a statement import (CSV / OFX / QFX) through the wizard:
//   file -> preview table with column mapping -> commit.
// Globals consumed by app.js are kept: fetchBankConnections,
// renderBankConnectionsList, handleConnectionAction, showBankConnectionModal.
// renderBankConnectionsPage is redefined here (this script loads after app.js).
// No inline onclick handlers — everything is wired with addEventListener.

// ==================== helpers ====================

function bankEsc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bankMoney(amount, currency) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  let body;
  try {
    body = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
  } catch (e) {
    body = Math.abs(n).toFixed(2);
  }
  return `${sign}${body}${currency ? ' ' + bankEsc(currency) : ''}`;
}

// Build a modal and return handles. Reuses the app's .modal-* classes.
function bankModal(id, title, bodyHtml, options = {}) {
  const old = document.getElementById(`${id}-backdrop`);
  if (old) old.remove();
  const html = `
    <div class="modal-backdrop" id="${id}-backdrop">
      <div class="modal ${options.size === 'lg' ? 'modal-lg' : ''} bank-modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
        <div class="modal-header">
          <h2 class="modal-title" id="${id}-title">${title}</h2>
          <button type="button" class="modal-close" id="${id}-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" id="${id}-body">${bodyHtml}</div>
        ${options.footer ? `<div class="modal-footer" id="${id}-footer">${options.footer}</div>` : ''}
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  const backdrop = document.getElementById(`${id}-backdrop`);
  const modal = document.getElementById(id);
  const body = document.getElementById(`${id}-body`);
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 250);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  document.getElementById(`${id}-close`).addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && !options.sticky) close();
  });
  return { backdrop, modal, body, footer: document.getElementById(`${id}-footer`), close };
}

// /api/accounts answers either an array or { own, shared, all }; app.js stores
// whichever came back, so read both shapes.
function bankAccountsList() {
  const a = appState.accounts;
  if (Array.isArray(a)) return a;
  if (a && Array.isArray(a.all)) return a.all;
  if (a && Array.isArray(a.own)) return a.own;
  return [];
}

function bankRefreshCurrentPage() {
  const page = appState.currentPage;
  if (page === 'bank-connections' && typeof renderBankConnectionsPage === 'function') renderBankConnectionsPage();
  else if (page === 'transactions' && typeof renderTransactionsPage === 'function') renderTransactionsPage();
  else if (page === 'accounts' && typeof renderAccountsPage === 'function') renderAccountsPage();
  else if (page === 'dashboard' && typeof renderDashboard === 'function') renderDashboard();
}

// ==================== API ====================

async function fetchBanks() {
  try {
    const response = await fetchWithAuth('/api/bank-api/banks');
    if (!response.ok) throw new Error('Failed to load the bank list');
    const data = await response.json();
    appState.banks = data;
    appState.supportedBanks = data;
    return data;
  } catch (error) {
    console.error('Error loading banks:', error);
    return appState.banks || [];
  }
}

async function fetchBankConnections() {
  try {
    const response = await fetchWithAuth('/api/bank-api/connections');
    if (!response.ok) throw new Error('Failed to load bank connections');
    const data = await response.json();
    appState.bankConnections = data;
    return data;
  } catch (error) {
    console.error('Error loading bank connections:', error);
    showNotification('Could not load bank connections', 'error');
    return [];
  }
}

async function fetchImportPresets() {
  try {
    const response = await fetchWithAuth('/api/bank-api/import/presets');
    if (!response.ok) throw new Error('Failed to load import presets');
    const data = await response.json();
    appState.importPresets = data;
    return data;
  } catch (error) {
    console.error('Error loading import presets:', error);
    return appState.importPresets || { presets: [], banks: [], formats: [] };
  }
}

async function connectBankWithToken(bankId, token) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/connect/${encodeURIComponent(bankId)}/direct`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: token })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(data.message || 'The bank rejected this token', 'error');
      return null;
    }
    showNotification(data.clientName ? `Connected ${data.bankName} for ${data.clientName}` : `${data.bankName} connected`, 'success');
    return data;
  } catch (error) {
    console.error('Error connecting bank:', error);
    showNotification('Could not connect the bank', 'error');
    return null;
  }
}

async function disconnectBank(connectionId) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/disconnect/${encodeURIComponent(connectionId)}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(data.message || 'Could not disconnect the bank', 'error');
      return false;
    }
    showNotification('Bank disconnected', 'success');
    return true;
  } catch (error) {
    console.error('Error disconnecting bank:', error);
    showNotification('Could not disconnect the bank', 'error');
    return false;
  }
}

async function syncBankAccounts(connectionId) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/sync-accounts/${encodeURIComponent(connectionId)}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(data.message || 'Account sync failed', 'error');
      return null;
    }
    if (typeof fetchAccounts === 'function') await fetchAccounts();
    showNotification(`Synced ${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`, 'success');
    return data;
  } catch (error) {
    console.error('Error syncing accounts:', error);
    showNotification('Account sync failed', 'error');
    return null;
  }
}

async function syncBankTransactions(accountId, startDate, endDate) {
  try {
    const response = await fetchWithAuth(`/api/bank-api/sync-transactions/${encodeURIComponent(accountId)}`, {
      method: 'POST',
      body: JSON.stringify({ startDate, endDate })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(data.message || 'Transaction sync failed', 'error');
      return null;
    }
    const skipped = data.skipped ? `, ${data.skipped} already there` : '';
    showNotification(`Imported ${data.inserted} transaction${data.inserted === 1 ? '' : 's'}${skipped}`, 'success');
    return data;
  } catch (error) {
    console.error('Error syncing transactions:', error);
    showNotification('Transaction sync failed', 'error');
    return null;
  }
}

async function previewStatementFile(file, options = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (options.accountId) form.append('accountId', String(options.accountId));
  if (options.presetId) form.append('presetId', options.presetId);
  if (typeof options.hasHeader === 'boolean') form.append('hasHeader', String(options.hasHeader));
  if (options.delimiter) form.append('delimiter', options.delimiter);
  if (options.dateOrder) form.append('dateOrder', options.dateOrder);
  if (options.mapping) form.append('mapping', JSON.stringify(options.mapping));
  // Multipart: the browser must set Content-Type (with the boundary) itself,
  // so this bypasses fetchWithAuth's JSON default.
  const token = localStorage.getItem('token');
  if (!token) throw new Error('Not signed in');
  const response = await fetch('/api/bank-api/import/preview', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (response.status === 401) {
    localStorage.removeItem('token');
    if (typeof renderLoginPage === 'function') renderLoginPage();
    throw new Error('Session expired. Sign in again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Could not read this file');
  return data;
}

async function commitStatementImport(accountId, rows, options = {}) {
  const response = await fetchWithAuth('/api/bank-api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ accountId, rows, updateBalance: options.updateBalance !== false, skipDuplicates: options.skipDuplicates !== false })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Import failed');
  return data;
}

// ==================== page ====================

function bankCard(bank) {
  const formats = (bank.formats || []).filter((f) => f !== 'api').map((f) => f.toUpperCase()).join(' · ');
  const kind = bank.type === 'token' ? 'Personal token' : formats || 'Statement file';
  const unverified = bank.type === 'file-import' && !bank.verified ? '<span class="badge badge-warning bank-badge" title="Column layout not yet confirmed against a real export — check the preview before importing">layout unverified</span>' : '';
  const action = bank.type === 'token' ? 'Connect' : 'Import statement';
  return `
    <div class="bank-item" data-bank-id="${bankEsc(bank.id)}">
      <div class="bank-icon" aria-hidden="true"><i class="fas ${bank.type === 'token' ? 'fa-key' : 'fa-file-import'}"></i></div>
      <div class="bank-info">
        <h4>${bankEsc(bank.name)}</h4>
        <p class="bank-auth-type">${bankEsc(kind)} ${unverified}</p>
      </div>
      <button type="button" class="btn btn-sm ${bank.type === 'token' ? 'btn-primary' : 'btn-outline'} bank-action-btn" data-bank-id="${bankEsc(bank.id)}" data-bank-type="${bankEsc(bank.type)}">${action}</button>
    </div>`;
}

function renderBankConnectionsList(connections) {
  return connections
    .map(
      (c) => `
      <div class="bank-connection-card card" data-connection-id="${bankEsc(c.id)}">
        <div class="bank-connection-header">
          <div class="bank-connection-icon" aria-hidden="true"><i class="fas fa-university"></i></div>
          <div class="bank-connection-details">
            <h3 class="bank-connection-name">${bankEsc(c.bankName)}</h3>
            <p class="bank-connection-status">
              <span class="status-indicator ${c.isActive ? 'active' : 'inactive'}"></span>
              ${c.isActive ? 'Active' : 'Inactive'} · personal token
            </p>
          </div>
        </div>
        <div class="bank-connection-info">
          <p class="bank-connection-date">Connected ${new Date(c.createdAt).toLocaleDateString()}</p>
          <p class="bank-connection-accounts">${c.accountIds && c.accountIds.length ? `${c.accountIds.length} linked account${c.accountIds.length === 1 ? '' : 's'}` : 'No accounts synced yet'}</p>
        </div>
        <div class="bank-connection-actions">
          <button type="button" class="btn btn-sm btn-primary" data-connection-action="sync-accounts" data-connection-id="${bankEsc(c.id)}"><i class="fas fa-sync"></i> Sync accounts</button>
          <button type="button" class="btn btn-sm btn-outline" data-connection-action="sync-transactions" data-connection-id="${bankEsc(c.id)}"><i class="fas fa-exchange-alt"></i> Sync transactions</button>
          <button type="button" class="btn btn-sm btn-danger" data-connection-action="disconnect" data-connection-id="${bankEsc(c.id)}"><i class="fas fa-unlink"></i> Disconnect</button>
        </div>
      </div>`
    )
    .join('');
}

async function renderBankConnectionsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="bank-loading">Loading banks…</div>';
  const [connections, banks] = await Promise.all([fetchBankConnections(), fetchBanks()]);
  const tokenBanks = banks.filter((b) => b.type === 'token');
  const fileBanks = banks.filter((b) => b.type === 'file-import');

  mainContent.innerHTML = `
    <div class="page-header bank-page-header">
      <h1 class="page-title"><i class="fas fa-university"></i> Banks &amp; imports</h1>
      <div class="page-actions">
        <button type="button" id="bank-import-btn" class="btn btn-primary"><i class="fas fa-file-import"></i> Import statement</button>
        <button type="button" id="add-connection-btn" class="btn btn-outline"><i class="fas fa-key"></i> Connect with token</button>
      </div>
    </div>

    <div class="bank-connections-container bank-page">
      <section class="card bank-info-card">
        <div class="bank-info-content">
          <h2><i class="fas fa-info-circle"></i> How bank data gets in</h2>
          <p>Canadian banks do not offer a free personal API, so the reliable path is the statement file you can download from online banking: CSV, OFX or QFX. The import wizard reads the file, shows every row with its column mapping, flags duplicates, and only then writes to the account you choose.</p>
          <p>Monobank has a real read-only personal API: paste the token from the Monobank app and sync accounts and transactions directly.</p>
        </div>
      </section>

      <section class="bank-section">
        <h2 class="bank-section-title">Connected banks</h2>
        <div id="bank-connections-list" class="card-grid">
          ${
            connections.length > 0
              ? renderBankConnectionsList(connections)
              : `<div class="empty-state bank-empty">
                   <div class="empty-state-icon"><i class="fas fa-plug"></i></div>
                   <h2>No token connections yet</h2>
                   <p>Connect Monobank with a personal token, or skip this and import a statement file below.</p>
                   <button type="button" id="empty-add-connection-btn" class="btn btn-outline"><i class="fas fa-key"></i> Connect Monobank</button>
                 </div>`
          }
        </div>
      </section>

      <section class="bank-section">
        <h2 class="bank-section-title">Supported banks</h2>
        <div class="banks-grid bank-catalogue">
          ${tokenBanks.map(bankCard).join('')}
          ${fileBanks.map(bankCard).join('')}
        </div>
        <p class="bank-footnote">Any other bank: export a CSV and use “Import statement” — the wizard detects columns automatically and lets you correct the mapping.</p>
      </section>
    </div>`;

  document.getElementById('bank-import-btn').addEventListener('click', () => showImportWizard({}));
  document.getElementById('add-connection-btn').addEventListener('click', () => showBankConnectionModal());
  const emptyBtn = document.getElementById('empty-add-connection-btn');
  if (emptyBtn) emptyBtn.addEventListener('click', () => showBankConnectionModal());

  mainContent.querySelectorAll('.bank-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bank = banks.find((b) => b.id === btn.dataset.bankId);
      if (!bank) return;
      if (bank.type === 'token') showTokenConnectModal(bank);
      else showImportWizard({ bank, presetId: bank.csvPreset });
    });
  });
  mainContent.querySelectorAll('[data-connection-action]').forEach((btn) => btn.addEventListener('click', handleConnectionAction));
}

async function handleConnectionAction(e) {
  const button = e.currentTarget;
  const action = button.dataset.connectionAction;
  const connectionId = button.dataset.connectionId;
  if (!action || !connectionId) return;

  if (action === 'sync-accounts') {
    button.disabled = true;
    const result = await syncBankAccounts(connectionId);
    button.disabled = false;
    if (result) {
      await fetchBankConnections();
      bankRefreshCurrentPage();
    }
    return;
  }
  if (action === 'sync-transactions') {
    const connection = (appState.bankConnections || []).find((c) => String(c.id) === String(connectionId));
    if (!connection || !connection.accountIds || connection.accountIds.length === 0) {
      showNotification('Sync accounts first, then transactions', 'warning');
      return;
    }
    showAccountSelectionModal(connection);
    return;
  }
  if (action === 'disconnect') {
    if (!window.confirm('Disconnect this bank? Imported transactions stay in place.')) return;
    const ok = await disconnectBank(connectionId);
    if (ok) {
      await fetchBankConnections();
      bankRefreshCurrentPage();
    }
  }
}

// ==================== connect (token) ====================

async function showBankConnectionModal() {
  const banks = appState.banks && appState.banks.length ? appState.banks : await fetchBanks();
  const tokenBanks = banks.filter((b) => b.type === 'token');
  const fileBanks = banks.filter((b) => b.type === 'file-import');
  const m = bankModal(
    'bank-connection-modal',
    'Connect a bank',
    `
    <div class="bank-picker">
      <h3 class="bank-picker-title">With a personal token</h3>
      <div class="banks-grid">${tokenBanks.map(bankCard).join('')}</div>
      <h3 class="bank-picker-title">From a statement file</h3>
      <div class="banks-grid">${fileBanks.map(bankCard).join('')}</div>
      <div class="bank-picker-other">
        <button type="button" class="btn btn-outline" id="bank-picker-generic"><i class="fas fa-file-csv"></i> Other bank — import any CSV / OFX</button>
      </div>
    </div>`,
    { size: 'lg' }
  );
  m.body.querySelectorAll('.bank-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bank = banks.find((b) => b.id === btn.dataset.bankId);
      if (!bank) return;
      m.close();
      if (bank.type === 'token') showTokenConnectModal(bank);
      else showImportWizard({ bank, presetId: bank.csvPreset });
    });
  });
  document.getElementById('bank-picker-generic').addEventListener('click', () => {
    m.close();
    showImportWizard({});
  });
}

function showTokenConnectModal(bank) {
  const m = bankModal(
    'bank-token-modal',
    `Connect ${bankEsc(bank.name)}`,
    `
    <form id="bank-token-form" class="bank-token-form">
      <p class="bank-instructions">${bankEsc(bank.tokenInstructions || 'Paste the personal API token issued by the bank.')}</p>
      ${bank.rateLimitNote ? `<p class="form-hint">${bankEsc(bank.rateLimitNote)}</p>` : ''}
      ${bank.docsUrl ? `<p class="form-hint">API documentation: <a href="${bankEsc(bank.docsUrl)}" target="_blank" rel="noopener noreferrer">${bankEsc(bank.docsUrl)}</a></p>` : ''}
      <div class="form-group">
        <label for="bank-token-input" class="form-label">Personal token</label>
        <input type="password" id="bank-token-input" class="form-control" autocomplete="off" spellcheck="false" placeholder="Paste the token" required>
        <p class="form-hint">The token is checked with the bank before it is stored, and stored encrypted.</p>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="bank-token-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="bank-token-submit">Connect</button>
      </div>
    </form>`
  );
  document.getElementById('bank-token-cancel').addEventListener('click', m.close);
  document.getElementById('bank-token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('bank-token-input');
    const submit = document.getElementById('bank-token-submit');
    const token = input.value.trim();
    if (!token) {
      showNotification('Paste the token first', 'warning');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Checking with the bank…';
    const result = await connectBankWithToken(bank.id, token);
    submit.disabled = false;
    submit.textContent = 'Connect';
    if (result) {
      m.close();
      await fetchBankConnections();
      bankRefreshCurrentPage();
    }
  });
  setTimeout(() => document.getElementById('bank-token-input').focus(), 50);
}

// ==================== sync transactions (token banks) ====================

function showAccountSelectionModal(connection) {
  const accounts = bankAccountsList().filter((a) => connection.accountIds.includes(a.id));
  if (accounts.length === 0) {
    showNotification('No synced accounts for this connection yet', 'warning');
    return;
  }
  const m = bankModal(
    'account-selection-modal',
    'Choose the account to sync',
    `
    <p>Transactions from ${bankEsc(connection.bankName)} will be added to the account you pick. Rows already present are skipped.</p>
    <div class="accounts-selection-list">
      ${accounts
        .map(
          (a) => `
        <div class="account-selection-item" data-account-id="${bankEsc(a.id)}">
          <div class="account-selection-icon" aria-hidden="true"><i class="fas ${typeof getAccountIcon === 'function' ? getAccountIcon(a.account_type) : 'fa-wallet'}"></i></div>
          <div class="account-selection-details">
            <h3 class="account-selection-name">${bankEsc(a.name)}</h3>
            <p class="account-selection-number">${bankEsc(a.account_number || 'No number')}</p>
          </div>
          <div class="account-selection-balance">${typeof formatCurrency === 'function' ? formatCurrency(a.balance, a.currency) : bankMoney(a.balance, a.currency)}</div>
          <button type="button" class="btn btn-sm btn-primary select-account-btn" data-account-id="${bankEsc(a.id)}">Select</button>
        </div>`
        )
        .join('')}
    </div>`
  );
  m.body.querySelectorAll('.select-account-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const account = accounts.find((a) => String(a.id) === btn.dataset.accountId);
      if (account) {
        m.close();
        showSyncTransactionsModal(account);
      }
    });
  });
}

function showSyncTransactionsModal(account) {
  const today = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(today.getDate() - 30);
  const iso = (d) => d.toISOString().slice(0, 10);
  const m = bankModal(
    'sync-transactions-modal',
    'Sync transactions',
    `
    <form id="sync-transactions-form">
      <p>Fetch transactions for <strong>${bankEsc(account.name)}</strong>. The bank allows up to 31 days per request.</p>
      <div class="form-row">
        <div class="form-group">
          <label for="sync-start-date" class="form-label">From</label>
          <input type="date" id="sync-start-date" class="form-control" value="${iso(monthAgo)}" required>
        </div>
        <div class="form-group">
          <label for="sync-end-date" class="form-label">To</label>
          <input type="date" id="sync-end-date" class="form-control" value="${iso(today)}" required>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="sync-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="sync-submit">Sync</button>
      </div>
    </form>`
  );
  document.getElementById('sync-cancel').addEventListener('click', m.close);
  document.getElementById('sync-transactions-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const startDate = document.getElementById('sync-start-date').value;
    const endDate = document.getElementById('sync-end-date').value;
    if (!startDate || !endDate) return showNotification('Pick both dates', 'error');
    if (new Date(startDate) > new Date(endDate)) return showNotification('The start date is after the end date', 'error');
    const submit = document.getElementById('sync-submit');
    submit.disabled = true;
    const result = await syncBankTransactions(account.id, startDate, endDate);
    submit.disabled = false;
    if (result) {
      m.close();
      bankRefreshCurrentPage();
    }
  });
}

// ==================== import wizard ====================

const BANK_WIZARD_ROLES = [
  ['date', 'Date'],
  ['description', 'Description'],
  ['description2', 'Description (extra)'],
  ['amount', 'Amount (signed)'],
  ['debit', 'Debit / money out'],
  ['credit', 'Credit / money in'],
  ['category', 'Category'],
  ['currency', 'Currency']
];

function bankStatusLabel(row) {
  if (row.error) return ['error', 'Error'];
  if (row.skipped) return ['skipped', `Skipped (${row.skipped})`];
  if (row.duplicate === 'existing') return ['dup', 'Already imported'];
  if (row.duplicate === 'file') return ['dup', 'Duplicate in file'];
  return ['new', 'New'];
}

async function showImportWizard({ bank = null, presetId = null } = {}) {
  if (typeof fetchAccounts === 'function' && bankAccountsList().length === 0) await fetchAccounts();
  const presetsData = appState.importPresets || (await fetchImportPresets());
  const presets = presetsData.presets || [];
  const accounts = bankAccountsList();

  const state = { file: null, preview: null, accountId: accounts[0] ? accounts[0].id : null, presetId: presetId || '', options: {}, selected: new Set(), updateBalance: true };

  const m = bankModal('bank-import-wizard', bank ? `Import ${bankEsc(bank.name)} statement` : 'Import a bank statement', '', { size: 'lg', sticky: true });

  const stepHeader = (n) => `
    <ol class="bank-steps" aria-label="Import steps">
      <li class="${n === 1 ? 'is-active' : n > 1 ? 'is-done' : ''}"><span>1</span> File</li>
      <li class="${n === 2 ? 'is-active' : n > 2 ? 'is-done' : ''}"><span>2</span> Preview &amp; mapping</li>
      <li class="${n === 3 ? 'is-active' : ''}"><span>3</span> Done</li>
    </ol>`;

  // ---------- step 1 ----------
  const renderStep1 = () => {
    m.body.innerHTML = `
      ${stepHeader(1)}
      ${accounts.length === 0 ? '<div class="bank-alert bank-alert-warning">You have no accounts yet. Create an account first, then import a statement into it.</div>' : ''}
      ${bank && bank.exportHint ? `<div class="bank-alert"><strong>Where to get the file:</strong> ${bankEsc(bank.exportHint)}</div>` : ''}
      <div class="form-row">
        <div class="form-group">
          <label for="biw-account" class="form-label">Import into account</label>
          <select id="biw-account" class="form-control" ${accounts.length === 0 ? 'disabled' : ''}>
            ${accounts.map((a) => `<option value="${bankEsc(a.id)}" ${String(a.id) === String(state.accountId) ? 'selected' : ''}>${bankEsc(a.name)} (${bankEsc(a.currency)})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="biw-preset" class="form-label">Bank format</label>
          <select id="biw-preset" class="form-control">
            <option value="">Auto-detect</option>
            ${presets.map((p) => `<option value="${bankEsc(p.id)}" ${p.id === state.presetId ? 'selected' : ''}>${bankEsc(p.name)}${p.verified ? '' : ' — layout unverified'}</option>`).join('')}
          </select>
          <p class="form-hint">OFX / QFX / QBO files are recognised on their own.</p>
        </div>
      </div>
      <div class="bank-dropzone" id="biw-drop" tabindex="0" role="button" aria-label="Choose a statement file">
        <input type="file" id="biw-file" class="bank-file-input" accept=".csv,.txt,.tsv,.ofx,.qfx,.qbo,text/csv,application/x-ofx">
        <i class="fas fa-file-upload" aria-hidden="true"></i>
        <p><strong id="biw-file-name">${state.file ? bankEsc(state.file.name) : 'Drop a statement here or click to choose'}</strong></p>
        <p class="form-hint">CSV, OFX, QFX or QBO · up to 10 MB</p>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="biw-next" ${state.file && accounts.length ? '' : 'disabled'}>Preview</button>
      </div>`;

    const fileInput = document.getElementById('biw-file');
    const drop = document.getElementById('biw-drop');
    const nextBtn = document.getElementById('biw-next');
    const setFile = (file) => {
      if (!file) return;
      state.file = file;
      document.getElementById('biw-file-name').textContent = file.name;
      nextBtn.disabled = accounts.length === 0;
    };
    fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
    drop.addEventListener('click', (e) => {
      if (e.target !== fileInput) fileInput.click();
    });
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('is-over');
      })
    );
    drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files && e.dataTransfer.files[0]));
    document.getElementById('biw-account').addEventListener('change', (e) => {
      state.accountId = e.target.value;
    });
    document.getElementById('biw-preset').addEventListener('change', (e) => {
      state.presetId = e.target.value;
    });
    document.getElementById('biw-cancel').addEventListener('click', m.close);
    nextBtn.addEventListener('click', async () => {
      state.options = {};
      await runPreview(nextBtn);
    });
  };

  const runPreview = async (busyBtn) => {
    if (!state.file) return;
    const label = busyBtn ? busyBtn.textContent : '';
    if (busyBtn) {
      busyBtn.disabled = true;
      busyBtn.textContent = 'Reading…';
    }
    try {
      state.preview = await previewStatementFile(state.file, { accountId: state.accountId, presetId: state.presetId || undefined, ...state.options });
      state.selected = new Set(state.preview.rows.filter((r) => !r.error && !r.skipped && !r.duplicate).map((r) => r.index));
      renderStep2();
    } catch (error) {
      showNotification(error.message || 'Could not read this file', 'error');
      if (busyBtn) {
        busyBtn.disabled = false;
        busyBtn.textContent = label;
      }
    }
  };

  // ---------- step 2 ----------
  const renderStep2 = () => {
    const p = state.preview;
    const isCsv = p.kind === 'csv';
    const columnNames = p.columnNames || [];
    const account = accounts.find((a) => String(a.id) === String(state.accountId));
    const currency = p.accountCurrency || (account && account.currency) || '';
    const presetLine = p.preset
      ? `<span class="badge badge-primary">${bankEsc(p.preset.name)}</span> ${p.detected ? 'detected automatically' : 'selected'}${p.kind === 'csv' && p.preset.verified === false ? ' <span class="badge badge-warning">layout unverified</span>' : ''}`
      : '<span class="badge">Generic CSV</span> columns guessed from the header — check the mapping';
    const verifiedNote = p.preset && p.kind === 'csv' && p.preset.verified === false ? '<div class="bank-alert bank-alert-warning">This bank\'s column layout has not been confirmed against a real export. Check the Date and Amount columns below before importing.</div>' : '';
    const fileCurrency = p.rows.find((r) => r.currency)?.currency;
    const currencyNote = fileCurrency && currency && fileCurrency !== currency ? `<div class="bank-alert bank-alert-warning">The file is in ${bankEsc(fileCurrency)} but the account is ${bankEsc(currency)}. Amounts are imported as they are, without conversion.</div>` : '';

    const mappingSelect = (role, value) => `
      <label class="bank-map-field">
        <span>${BANK_WIZARD_ROLES.find(([r]) => r === role)[1]}</span>
        <select class="form-control" data-role="${role}">
          <option value="">—</option>
          ${columnNames.map((name, i) => `<option value="${i}" ${value === i ? 'selected' : ''}>${bankEsc(name)}</option>`).join('')}
        </select>
      </label>`;
    const mp = p.mapping || {};
    const desc = Array.isArray(mp.description) ? mp.description : [];
    const mappingPanel = isCsv
      ? `
      <details class="bank-mapping" ${p.mappingSource === 'auto' && !p.preset ? 'open' : ''}>
        <summary>Column mapping <span class="form-hint">(${bankEsc(p.mappingSource)}${p.delimiter === '\t' ? ', tab-separated' : p.delimiter === ';' ? ', semicolon-separated' : ''})</span></summary>
        <div class="bank-map-grid">
          ${mappingSelect('date', mp.date)}
          ${mappingSelect('description', desc[0])}
          ${mappingSelect('description2', desc[1])}
          ${mappingSelect('amount', mp.amount)}
          ${mappingSelect('debit', mp.debit)}
          ${mappingSelect('credit', mp.credit)}
          ${mappingSelect('category', mp.category)}
          ${mappingSelect('currency', mp.currency)}
          <label class="bank-map-field">
            <span>Day/month order</span>
            <select class="form-control" id="biw-date-order">
              <option value="MDY" ${p.dateOrder === 'MDY' ? 'selected' : ''}>Month / Day / Year (10/09/2026)</option>
              <option value="DMY" ${p.dateOrder === 'DMY' ? 'selected' : ''}>Day / Month / Year (09/10/2026)</option>
              <option value="YMD" ${p.dateOrder === 'YMD' ? 'selected' : ''}>Year-Month-Day (2026-10-09)</option>
            </select>
          </label>
          <label class="bank-map-field bank-map-check">
            <input type="checkbox" id="biw-has-header" ${p.hasHeader ? 'checked' : ''}> <span>First row is a header</span>
          </label>
        </div>
        <div class="form-actions bank-map-actions">
          <button type="button" class="btn btn-outline btn-sm" id="biw-reparse"><i class="fas fa-redo"></i> Re-read with this mapping</button>
        </div>
      </details>`
      : `<div class="bank-alert">${p.accounts && p.accounts[0] ? `Statement for account <strong>${bankEsc(p.accounts[0].accountId || '')}</strong> ${p.accounts[0].accountType ? '(' + bankEsc(p.accounts[0].accountType) + ')' : ''} ${p.accounts[0].currency ? 'in ' + bankEsc(p.accounts[0].currency) : ''}${p.accounts[0].balance != null ? `, ledger balance ${bankMoney(p.accounts[0].balance, p.accounts[0].currency)}${p.accounts[0].balanceDate ? ' as of ' + bankEsc(p.accounts[0].balanceDate) : ''}` : ''}.` : 'OFX statement.'}</div>`;

    const s = p.stats;
    const rowsHtml = p.rows
      .map((r) => {
        const [cls, label] = bankStatusLabel(r);
        const selectable = !r.error && !r.skipped;
        const checked = state.selected.has(r.index);
        return `
        <tr class="bank-row bank-row-${cls}" data-index="${r.index}">
          <td class="bank-col-check"><input type="checkbox" class="bank-row-check" data-index="${r.index}" ${selectable ? '' : 'disabled'} ${checked ? 'checked' : ''} aria-label="Import row ${r.index}"></td>
          <td class="bank-col-n">${r.index}</td>
          <td class="bank-col-date">${r.error ? `<span class="bank-error" title="${bankEsc(r.error)}">${bankEsc(r.error)}</span>` : bankEsc(r.date || '')}</td>
          <td class="bank-col-desc" title="${bankEsc(Array.isArray(r.raw) ? r.raw.join(' | ') : '')}">${bankEsc(r.description || (Array.isArray(r.raw) ? r.raw.join(' | ') : ''))}</td>
          <td class="bank-col-amount ${r.amount < 0 ? 'is-neg' : 'is-pos'}">${r.amount != null ? bankMoney(r.amount, r.currency && r.currency !== currency ? r.currency : '') : ''}</td>
          <td class="bank-col-cat">${bankEsc(r.category || '')}</td>
          <td class="bank-col-status"><span class="bank-status bank-status-${cls}">${label}</span></td>
        </tr>`;
      })
      .join('');

    m.body.innerHTML = `
      ${stepHeader(2)}
      <div class="bank-preview-head">
        <div class="bank-preview-file"><i class="fas fa-file-alt"></i> <strong>${bankEsc(p.fileName || state.file.name)}</strong> → <strong>${bankEsc(account ? account.name : 'account')}</strong></div>
        <div class="bank-preview-format">${presetLine}</div>
      </div>
      ${verifiedNote}
      ${currencyNote}
      ${p.truncated ? `<div class="bank-alert bank-alert-warning">The file has ${p.truncated} rows; only the first ${p.rows.length} are shown and can be imported in this pass.</div>` : ''}
      ${mappingPanel}
      <div class="bank-summary" id="biw-summary"></div>
      <div class="table-container bank-table-wrap">
        <table class="table bank-table">
          <thead>
            <tr>
              <th class="bank-col-check"><input type="checkbox" id="biw-check-all" aria-label="Select all new rows"></th>
              <th>#</th><th>Date</th><th>Description</th><th class="bank-col-amount">Amount${currency ? ' (' + bankEsc(currency) + ')' : ''}</th><th>Category</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <label class="bank-map-check bank-balance-opt"><input type="checkbox" id="biw-update-balance" ${state.updateBalance ? 'checked' : ''}> <span>Adjust the account balance by the imported total</span></label>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-back">Back</button>
        <button type="button" class="btn btn-primary" id="biw-commit">Import</button>
      </div>`;

    const updateSummary = () => {
      const chosen = p.rows.filter((r) => state.selected.has(r.index));
      const net = chosen.reduce((a, r) => a + (Number(r.amount) || 0), 0);
      document.getElementById('biw-summary').innerHTML = `
        <span><strong>${s.total}</strong> rows</span>
        <span class="bank-status bank-status-new">${s.valid} new</span>
        ${s.duplicates ? `<span class="bank-status bank-status-dup">${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'}</span>` : ''}
        ${s.skipped ? `<span class="bank-status bank-status-skipped">${s.skipped} skipped</span>` : ''}
        ${s.errors ? `<span class="bank-status bank-status-error">${s.errors} error${s.errors === 1 ? '' : 's'}</span>` : ''}
        <span class="bank-summary-net">Selected <strong>${chosen.length}</strong> · net ${bankMoney(net, currency)}</span>`;
      const commitBtn = document.getElementById('biw-commit');
      commitBtn.disabled = chosen.length === 0;
      commitBtn.textContent = chosen.length ? `Import ${chosen.length} row${chosen.length === 1 ? '' : 's'}` : 'Nothing to import';
    };
    updateSummary();

    m.body.querySelectorAll('.bank-row-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const idx = Number(cb.dataset.index);
        if (cb.checked) state.selected.add(idx);
        else state.selected.delete(idx);
        updateSummary();
      });
    });
    document.getElementById('biw-check-all').addEventListener('change', (e) => {
      p.rows.forEach((r) => {
        if (r.error || r.skipped) return;
        if (e.target.checked) state.selected.add(r.index);
        else state.selected.delete(r.index);
      });
      m.body.querySelectorAll('.bank-row-check:not(:disabled)').forEach((cb) => {
        cb.checked = state.selected.has(Number(cb.dataset.index));
      });
      updateSummary();
    });
    document.getElementById('biw-update-balance').addEventListener('change', (e) => {
      state.updateBalance = e.target.checked;
    });
    document.getElementById('biw-back').addEventListener('click', renderStep1);

    const reparse = document.getElementById('biw-reparse');
    if (reparse) {
      reparse.addEventListener('click', async () => {
        const mapping = {};
        m.body.querySelectorAll('.bank-map-grid select[data-role]').forEach((sel) => {
          if (sel.value === '') return;
          const role = sel.dataset.role;
          const idx = Number(sel.value);
          if (role === 'description' || role === 'description2') {
            mapping.description = mapping.description || [];
            mapping.description.push(idx);
          } else {
            mapping[role] = idx;
          }
        });
        state.options = {
          mapping,
          dateOrder: document.getElementById('biw-date-order').value,
          hasHeader: document.getElementById('biw-has-header').checked,
          delimiter: p.delimiter
        };
        state.presetId = p.preset ? p.preset.id : '';
        await runPreview(reparse);
      });
    }

    document.getElementById('biw-commit').addEventListener('click', async () => {
      const btn = document.getElementById('biw-commit');
      const rows = p.rows
        .filter((r) => state.selected.has(r.index))
        .map((r) => ({ date: r.date, description: r.description, amount: r.amount, category: r.category, type: r.type }));
      if (rows.length === 0) return;
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        const result = await commitStatementImport(state.accountId, rows, { updateBalance: state.updateBalance, skipDuplicates: false });
        renderStep3(result, account);
        if (typeof fetchAccounts === 'function') await fetchAccounts();
        bankRefreshCurrentPage();
      } catch (error) {
        showNotification(error.message || 'Import failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Import';
      }
    });
  };

  // ---------- step 3 ----------
  const renderStep3 = (result, account) => {
    const currency = account ? account.currency : '';
    m.body.innerHTML = `
      ${stepHeader(3)}
      <div class="bank-done">
        <div class="bank-done-icon"><i class="fas fa-check-circle"></i></div>
        <h3>${result.inserted} transaction${result.inserted === 1 ? '' : 's'} imported</h3>
        <p>into <strong>${bankEsc(account ? account.name : '')}</strong>${result.skipped ? ` · ${result.skipped} already present, skipped` : ''}${result.rejected ? ` · ${result.rejected} rejected` : ''}</p>
        ${result.balanceDelta ? `<p>Balance adjusted by <strong>${bankMoney(result.balanceDelta, currency)}</strong>${result.newBalance != null ? ` → ${bankMoney(result.newBalance, currency).replace(/^[+−]/, '')}` : ''}</p>` : '<p>Balance left unchanged.</p>'}
        ${result.errors && result.errors.length ? `<ul class="bank-errors">${result.errors.slice(0, 5).map((e) => `<li>${bankEsc(e.message)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-another">Import another file</button>
        <button type="button" class="btn btn-primary" id="biw-done">Done</button>
      </div>`;
    document.getElementById('biw-done').addEventListener('click', m.close);
    document.getElementById('biw-another').addEventListener('click', () => {
      state.file = null;
      state.preview = null;
      state.options = {};
      renderStep1();
    });
  };

  renderStep1();
}
