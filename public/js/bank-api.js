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
    const locale = typeof numberLocale === 'function' ? numberLocale() : undefined;
    body = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
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

// ==================== Statement Agent (PDF / photo) ====================
// The AI reads the statement, Finman proves it: opening + rows = closing to the
// cent. Nothing is written until the proof holds and the person presses Import.
//   POST /api/statements (multipart file) -> task view
//   GET  /api/statements/:id?accountId=   -> task view (duplicates marked)
//   POST /api/statements/:id/balances     -> typed opening / closing, proved again
//   POST /api/statements/:id/commit       -> { inserted, skipped, balance_delta, new_balance }

const BANK_AGENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
const BANK_FILE_ACCEPT = `.csv,.txt,.tsv,.ofx,.qfx,.qbo,text/csv,application/x-ofx,${BANK_AGENT_ACCEPT}`;
const BANK_CATEGORIES = ['Groceries', 'Food & Dining', 'Transport', 'Fuel', 'Health', 'Shopping', 'Entertainment', 'Utilities', 'Phone & Internet', 'Housing', 'Bank Fees', 'Subscriptions', 'Salary', 'Investments', 'Refund', 'Transfer', 'Cash', 'Travel', 'Education', 'Taxes & Government', 'Other'];

// PDF and photos go to the Statement Agent; CSV / OFX / QFX keep the column-mapping path.
function bankIsAgentFile(file) {
  if (!file) return false;
  if (/\.(pdf|jpe?g|png|webp)$/i.test(file.name || '')) return true;
  return /^(application\/pdf|image\/(jpeg|png|webp))$/i.test(file.type || '');
}

async function bankStatementCall(url, options = {}) {
  const response = await fetchWithAuth(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || 'The statement could not be read; nothing was written');
    err.code = data.code || null;
    err.status = response.status;
    throw err;
  }
  return data;
}

function uploadStatementFile(file, accountId) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (accountId) form.append('accountId', String(accountId));
  return bankStatementCall('/api/statements', { method: 'POST', body: form });
}

function bankCents(cents, currency) {
  if (!Number.isInteger(cents)) return '—';
  return typeof fmFormatCurrency === 'function' ? fmFormatCurrency(cents / 100, currency) : bankMoney(cents / 100, currency);
}

// Balance column: no plus sign, a real minus for a negative balance.
function bankPlainCents(cents) {
  if (!Number.isInteger(cents)) return '';
  return bankMoney(cents / 100, '').replace(/^\+/, '');
}

function bankShortDate(iso, withYear) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

function bankPeriod(period) {
  const p = period || {};
  if (p.start && p.end) {
    const sameYear = p.start.slice(0, 4) === p.end.slice(0, 4);
    return `${bankShortDate(p.start, !sameYear)} – ${bankShortDate(p.end, true)}`;
  }
  return bankShortDate(p.start || p.end, true);
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
          <p>Only have a PDF statement or a paper one? Drop the PDF or a photo: your AI reads it, Finman checks that the opening balance plus every row equals the closing balance to the cent, and nothing is written until it does.</p>
          <p>Monobank has a real read-only personal API: paste the token from the Monobank app and sync accounts and transactions directly.</p>
        </div>
      </section>

      <section class="bank-section">
        <h2 class="bank-section-title">Connected banks</h2>
        <div id="bank-connections-list" class="card-grid">
          ${
            connections.length > 0
              ? renderBankConnectionsList(connections)
              : window.FMEmpty ? FMEmpty.html({
                icon: 'fa-plug',
                title: t('empty.banks.title'), body: t('empty.banks.body'),
                primary: { label: t('empty.action.import'), do: 'import', icon: 'fa-file-import' },
                secondary: { label: t('empty.banks.connect'), id: 'empty-add-connection-btn', icon: 'fa-key' }
              })
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
        <p class="bank-footnote">Any other bank: export a CSV and use “Import statement” — the wizard detects columns automatically and lets you correct the mapping. A PDF or a photo of the statement works too.</p>
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
        <button type="button" class="btn btn-outline" id="bank-picker-generic"><i class="fas fa-file-csv"></i> Other bank — import any CSV, OFX, PDF or photo</button>
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

async function showImportWizard({ bank = null, presetId = null, file = null } = {}) {
  if (typeof fetchAccounts === 'function' && bankAccountsList().length === 0) await fetchAccounts();
  const presetsData = appState.importPresets || (await fetchImportPresets());
  const presets = presetsData.presets || [];
  let accounts = bankAccountsList();

  const state = { file: file || null, preview: null, accountId: accounts[0] ? accounts[0].id : null, presetId: presetId || '', options: {}, selected: new Set(), updateBalance: true, task: null, error: null, categories: {} };

  const m = bankModal('bank-import-wizard', bank ? `Import ${bankEsc(bank.name)} statement` : 'Import a bank statement', '', { size: 'lg', sticky: true });

  const stepHeader = (n, agent) => `
    <ol class="bank-steps" aria-label="Import steps">
      <li class="${n === 1 ? 'is-active' : n > 1 ? 'is-done' : ''}"><span>1</span> File</li>
      <li class="${n === 2 ? 'is-active' : n > 2 ? 'is-done' : ''}"><span>2</span> <em class="bank-step-label" id="biw-step2-label">${agent ? 'Balance check' : 'Preview &amp; mapping'}</em></li>
      <li class="${n === 3 ? 'is-active' : ''}"><span>3</span> Done</li>
    </ol>`;

  // ---------- step 1 ----------
  const renderStep1 = () => {
    layout(false);
    m.body.innerHTML = `
      ${stepHeader(1, bankIsAgentFile(state.file))}
      ${state.error ? errorHtml(state.error) : ''}
      ${accounts.length === 0 ? '<div class="bank-alert bank-alert-warning">You have no accounts yet. A PDF or photo statement can create one for you; for CSV / OFX, create an account first.</div>' : ''}
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
          <select id="biw-preset" class="form-control" ${bankIsAgentFile(state.file) ? 'disabled' : ''}>
            <option value="">Auto-detect</option>
            ${presets.map((p) => `<option value="${bankEsc(p.id)}" ${p.id === state.presetId ? 'selected' : ''}>${bankEsc(p.name)}${p.verified ? '' : ' — layout unverified'}</option>`).join('')}
          </select>
          <p class="form-hint">OFX / QFX / QBO files and PDF / photo statements are recognised on their own.</p>
        </div>
      </div>
      <div class="bank-dropzone" id="biw-drop" tabindex="0" role="button" aria-label="Choose a statement file">
        <input type="file" id="biw-file" class="bank-file-input" accept="${BANK_FILE_ACCEPT}">
        <i class="fas fa-file-upload" aria-hidden="true"></i>
        <p><strong id="biw-file-name">${state.file ? bankEsc(state.file.name) : 'Drop a statement here or click to choose'}</strong></p>
        <p class="form-hint">CSV, OFX, QFX, QBO, or a PDF / photo of your statement</p>
        <p class="form-hint bank-agent-hint" id="biw-agent-hint" ${bankIsAgentFile(state.file) ? '' : 'hidden'}><i class="fas fa-shield-halved" aria-hidden="true"></i> The AI reads it, then Finman checks the balance to the cent before anything is written.</p>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="biw-next" ${state.file && (accounts.length || bankIsAgentFile(state.file)) ? '' : 'disabled'}>${bankIsAgentFile(state.file) ? 'Read statement' : 'Preview'}</button>
      </div>`;

    const fileInput = document.getElementById('biw-file');
    const drop = document.getElementById('biw-drop');
    const nextBtn = document.getElementById('biw-next');
    const setFile = (picked) => {
      if (!picked) return;
      state.file = picked;
      const agent = bankIsAgentFile(picked);
      document.getElementById('biw-file-name').textContent = picked.name;
      document.getElementById('biw-agent-hint').hidden = !agent;
      document.getElementById('biw-preset').disabled = agent;
      nextBtn.textContent = agent ? 'Read statement' : 'Preview';
      document.getElementById('biw-step2-label').textContent = agent ? 'Balance check' : 'Preview & mapping';
      nextBtn.disabled = !agent && accounts.length === 0;
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
    bindErrorLinks();
    nextBtn.addEventListener('click', async () => {
      state.options = {};
      state.error = null;
      if (bankIsAgentFile(state.file)) return runStatement();
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
        // Send every role: the visible ones (null = "—", which clears a preset
        // role on the server) plus the roles the wizard does not show (fee,
        // state, transaction type, MCC, ...), so a re-read keeps them.
        const mapping = { description: [] };
        const usedByVisible = new Set();
        m.body.querySelectorAll('.bank-map-grid select[data-role]').forEach((sel) => {
          const role = sel.dataset.role;
          const idx = sel.value === '' ? null : Number(sel.value);
          if (idx != null) usedByVisible.add(idx);
          if (role === 'description' || role === 'description2') {
            if (idx != null) mapping.description.push(idx);
          } else {
            mapping[role] = idx;
          }
        });
        if (mapping.description.length === 0) mapping.description = null;
        const prev = p.mapping || {};
        ['fee', 'balance', 'externalId', 'mcc', 'typeColumn', 'stateColumn'].forEach((role) => {
          const idx = prev[role];
          if (Number.isInteger(idx) && !usedByVisible.has(idx)) mapping[role] = idx;
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

  // ==================== Statement Agent path (PDF / photo) ====================

  // The statement steps take a wider, taller modal (the rows table has balance,
  // page and category columns); every new step starts at the top.
  function layout(wide, keepScroll) {
    m.modal.classList.toggle('bank-modal-wide', !!wide);
    if (!keepScroll) {
      m.body.scrollTop = 0;
      m.modal.scrollTop = 0;
    }
  }

  const goTo = (page) => {
    m.close();
    if (typeof navigateTo === 'function') navigateTo(page);
  };

  // Errors from the agent; the ones that need an AI key point at the Your AI page.
  const errorHtml = (err) => {
    const needsAi = err.code === 'STATEMENT_NO_AI' || err.code === 'STATEMENT_DAILY_LIMIT';
    return `<div class="bank-alert bank-alert-error" role="alert">${bankEsc(err.message || 'The statement could not be read; nothing was written')}${
      needsAi ? ` <a href="/my-ai" class="bank-link" data-biw-go="my-ai">Open Your AI</a>` : ''
    }</div>`;
  };
  const bindErrorLinks = () => {
    m.body.querySelectorAll('[data-biw-go]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        goTo(a.dataset.biwGo);
      })
    );
  };

  // Import target for a statement: the chosen account if its currency matches,
  // else the first account in the statement's currency, else a new account.
  const pickAccountFor = (task) => {
    const cur = task.currency;
    const chosen = accounts.find((a) => String(a.id) === String(state.accountId));
    if (chosen && (!cur || !chosen.currency || chosen.currency === cur)) return String(chosen.id);
    const same = cur ? accounts.find((a) => a.currency === cur) : null;
    if (same) return String(same.id);
    return '__new';
  };

  const newAccountName = (task) => {
    const parts = [task.institution || (task.statement_type === 'card' ? 'Credit card' : 'Bank account')];
    if (task.account_last4) parts.push(`••${task.account_last4}`);
    return parts.join(' ');
  };

  const refreshTask = async () => {
    const q = state.accountId && state.accountId !== '__new' ? `?accountId=${encodeURIComponent(state.accountId)}` : '';
    state.task = await bankStatementCall(`/api/statements/${encodeURIComponent(state.task.id)}${q}`);
  };

  const runStatement = async () => {
    const f = state.file;
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) {
      state.error = { message: 'The file is larger than 15 MB. Export a shorter period or take a smaller photo.' };
      return renderStep1();
    }
    state.task = null;
    state.categories = {};
    layout(true);
    m.body.innerHTML = `
      ${stepHeader(2, true)}
      <div class="bank-agent-busy" role="status" aria-live="polite">
        <span class="spinner bank-agent-spinner" aria-hidden="true"></span>
        <p class="bank-agent-busy-title" id="biw-busy-text">Reading the statement…</p>
        <p class="form-hint"><i class="fas ${/pdf/i.test(f.type) || /\.pdf$/i.test(f.name) ? 'fa-file-pdf' : 'fa-image'}" aria-hidden="true"></i> ${bankEsc(f.name)} · usually 3 to 30 seconds</p>
        <p class="form-hint">Nothing is written to your accounts at this step.</p>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-busy-cancel">Cancel</button>
      </div>`;
    document.getElementById('biw-busy-cancel').addEventListener('click', m.close);
    const steps = [
      [6000, 'Checking the balance…'],
      [16000, 'Reading it again where the numbers need a second look…'],
      [32000, 'Still working. Long statements and photos take a little longer.']
    ];
    const timers = steps.map(([ms, text]) =>
      setTimeout(() => {
        const el = document.getElementById('biw-busy-text');
        if (el) el.textContent = text;
      }, ms)
    );
    try {
      const accountId = state.accountId && state.accountId !== '__new' ? state.accountId : null;
      state.task = await uploadStatementFile(f, accountId);
      timers.forEach(clearTimeout);
      if (!m.backdrop.isConnected) return;
      const target = pickAccountFor(state.task);
      if (target !== String(accountId || '')) {
        state.accountId = target;
        try { await refreshTask(); } catch (_) { /* keep the first view */ }
      }
      renderStatement();
    } catch (err) {
      timers.forEach(clearTimeout);
      if (!m.backdrop.isConnected) return;
      state.error = { message: err.message, code: err.code };
      renderStep1();
    }
  };

  const STATUS_HEAD = {
    proven: ['ok', 'fa-check', 'Balance proven'],
    gap: ['bad', 'fa-xmark', 'The balance does not add up'],
    needs_closing: ['ask', 'fa-keyboard', 'The statement prints no closing balance'],
    needs_opening: ['ask', 'fa-keyboard', 'The statement prints no opening balance'],
    unclear: ['ask', 'fa-eye-slash', 'Some rows could not be read']
  };

  const renderStatement = (opts = {}) => {
    const t = state.task;
    const p = t.proof || {};
    const cur = t.currency || '';
    const rows = t.rows || [];
    const [tone, icon, title] = STATUS_HEAD[t.status] || ['ask', 'fa-circle-question', 'Not checked'];
    const brk = p.first_break || null;
    const breakIndex = t.status === 'gap' && brk ? brk.index : null;
    const dateIssues = new Set(p.date_issue_rows || []);
    rows.forEach((r) => { if (!r.date) dateIssues.add(r.index); });
    const unclearSet = new Set(p.unclear_rows || []);
    const rowNo = (i) => i + 1;
    const rowRef = (i) => {
      const r = rows[i];
      return `row ${rowNo(i)}${r && r.page ? ` (page ${r.page})` : ''}`;
    };

    // ---------- header ----------
    const headBits = [
      t.institution ? `<strong>${bankEsc(t.institution)}</strong>` : `<strong>${t.statement_type === 'card' ? 'Card statement' : 'Bank statement'}</strong>`,
      t.account_last4 ? `<span class="bank-agent-last4">••${bankEsc(t.account_last4)}</span>` : '',
      t.period && (t.period.start || t.period.end) ? bankEsc(bankPeriod(t.period)) : '',
      cur ? bankEsc(cur) : ''
    ].filter(Boolean);

    // ---------- proof block ----------
    let detail = '';
    if (t.status === 'gap') {
      const facts = [];
      if (brk) facts.push(`First break at <strong>row ${rowNo(brk.index)}</strong>${brk.page ? ` (page ${brk.page})` : ''}: the balance should be ${bankCents(brk.expected_balance_cents, cur)}, the statement prints ${bankCents(brk.printed_balance_cents, cur)}`);
      const ung = p.ungrounded_rows || [];
      if (ung.length) facts.push(`${ung.length === 1 ? 'This amount is' : 'These amounts are'} not printed on ${ung.length === 1 ? 'its' : 'their'} page: ${ung.slice(0, 8).map(rowRef).join(', ')}${ung.length > 8 ? '…' : ''}`);
      detail = `${facts.length ? `<ul class="bank-proof-facts">${facts.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${brk ? `<button type="button" class="btn btn-sm btn-outline" id="biw-show-break"><i class="fas fa-crosshairs" aria-hidden="true"></i> Show row ${rowNo(brk.index)}</button>` : ''}
        <p class="bank-proof-hint">Check the row against the paper, or read a clearer copy (the PDF from online banking works best).</p>`;
    } else if (t.status === 'needs_closing' || t.status === 'needs_opening') {
      const wantOpen = t.status === 'needs_opening';
      const typed = wantOpen ? 'opening' : 'closing';
      detail = `
        <form class="bank-proof-form" id="biw-balances" novalidate>
          <p class="bank-proof-hint">Type the ${typed} balance from your banking app or the paper statement${t.period && (wantOpen ? t.period.start : t.period.end) ? ` for ${bankEsc(bankShortDate(wantOpen ? t.period.start : t.period.end, true))}` : ''}. Finman checks every row against it; no AI is used.</p>
          <div class="bank-proof-inputs">
            ${wantOpen ? `<label class="bank-map-field"><span>Opening balance${cur ? ` (${bankEsc(cur)})` : ''}</span><input type="text" inputmode="decimal" class="form-control" id="biw-open" autocomplete="off" placeholder="1234.56"></label>` : ''}
            <label class="bank-map-field"><span>Closing balance${cur ? ` (${bankEsc(cur)})` : ''}${wantOpen ? ' — if you have it' : ''}</span><input type="text" inputmode="decimal" class="form-control" id="biw-close" autocomplete="off" placeholder="1234.56" ${Number.isInteger(t.closing_cents) ? `value="${(t.closing_cents / 100).toFixed(2)}"` : ''}></label>
            <button type="submit" class="btn btn-primary btn-sm" id="biw-balances-go">Check the balance</button>
          </div>
          ${t.statement_type === 'card' ? '<p class="form-hint">For a credit card, type what you owe as a positive number.</p>' : ''}
          ${opts.balanceError ? `<p class="bank-error" role="alert">${bankEsc(opts.balanceError)}</p>` : ''}
        </form>`;
    } else if (t.status === 'unclear') {
      const list = [...new Set([...unclearSet, ...dateIssues])].sort((a, b) => a - b);
      detail = list.length
        ? `<ul class="bank-proof-rows">${list.slice(0, 12).map((i) => {
            const r = rows[i] || {};
            const why = unclearSet.has(i) ? 'amount unreadable' : !r.date ? 'no readable date' : 'date outside the period or out of order';
            return `<li><button type="button" class="bank-link" data-biw-row="${i}">${bankEsc(rowRef(i))}</button> · ${bankEsc(r.date_raw || bankShortDate(r.date) || '')} ${bankEsc(r.description || '')} <span class="bank-proof-why">${why}</span></li>`;
          }).join('')}${list.length > 12 ? `<li>…and ${list.length - 12} more</li>` : ''}</ul>
          <p class="bank-proof-hint">Nothing is guessed. Read a sharper photo or the PDF from online banking.</p>`
        : '';
    }
    const notes = Array.isArray(p.notes) ? p.notes : [];
    // The server appends the notes to a proven line; they are shown once, below it.
    let line = p.line || '';
    if (notes.length && line.endsWith(` (${notes.join('; ')})`)) line = line.slice(0, -(notes.join('; ').length + 3));
    if (t.status === 'gap' && brk) line = line.replace(/; the balance chain first breaks at row \d+( \(page \d+\))?$/, '');
    const attempts = Array.isArray(t.attempts) ? t.attempts : [];
    const statusWord = { proven: 'proven', gap: 'gap', needs_closing: 'no closing balance', needs_opening: 'no opening balance', unclear: 'unclear rows' };
    const attemptsHtml = attempts.length
      ? `<details class="bank-proof-attempts"><summary>Read ${attempts.length === 1 ? 'once' : `${attempts.length} times`}</summary><ol>${attempts
          .map((a) => `<li>${bankEsc(a.scope || 'all pages')} · ${bankEsc(statusWord[a.status] || a.status || '')}${Number.isInteger(a.gap_cents) && a.gap_cents !== 0 ? ` · gap ${bankCents(a.gap_cents, cur)}` : ''}</li>`)
          .join('')}</ol></details>`
      : '';

    const proofHtml = `
      <section class="bank-proof bank-proof-${tone}" aria-live="polite">
        <div class="bank-proof-icon" aria-hidden="true"><i class="fas ${icon}"></i></div>
        <div class="bank-proof-main">
          <h3 class="bank-proof-title">${title}</h3>
          ${line ? `<p class="bank-proof-line">${t.status === 'proven' ? 'Balance proof: ' : ''}${bankEsc(line)}</p>` : ''}
          ${detail}
          ${notes.length || attemptsHtml ? `<div class="bank-proof-notes">${notes.map((n) => `<span><i class="fas fa-circle-info" aria-hidden="true"></i> ${bankEsc(n.charAt(0).toUpperCase() + n.slice(1))}</span>`).join('')}${attemptsHtml}</div>` : ''}
        </div>
      </section>`;

    // ---------- rows ----------
    const catOptions = (value) => {
      const list = BANK_CATEGORIES.includes(value) || !value ? BANK_CATEGORIES : [value, ...BANK_CATEGORIES];
      return list.map((c) => `<option ${c === value ? 'selected' : ''}>${bankEsc(c)}</option>`).join('');
    };
    const rowsHtml = rows
      .map((r) => {
        const cat = state.categories[r.index] || r.category;
        const badges = [];
        if (r.derived) badges.push('<span class="bank-status bank-status-derived" title="The amount was unreadable; it is worked out from the printed balances before and after it">from balances</span>');
        if (r.unclear || unclearSet.has(r.index)) badges.push('<span class="bank-status bank-status-error">unclear</span>');
        if (r.ungrounded) badges.push('<span class="bank-status bank-status-warn" title="This amount is not printed on the page the AI said it came from">not on page</span>');
        if (dateIssues.has(r.index)) badges.push('<span class="bank-status bank-status-warn" title="The date is missing, outside the statement period, or out of order">date issue</span>');
        if (r.duplicate === 'existing') badges.push('<span class="bank-status bank-status-dup">already in account</span>');
        const cls = [
          'bank-row',
          r.index === breakIndex ? 'bank-row-break' : '',
          r.duplicate ? 'bank-row-dup' : '',
          r.unclear || unclearSet.has(r.index) ? 'bank-row-unclear' : ''
        ].filter(Boolean).join(' ');
        const amount = Number.isInteger(r.cents) ? bankMoney(r.cents / 100, '') : '<span class="bank-error">unreadable</span>';
        return `
        <tr class="${cls}" data-index="${r.index}">
          <td class="bank-col-n">${rowNo(r.index)}</td>
          <td class="bank-col-date">${r.date ? bankEsc(bankShortDate(r.date)) : `<span class="bank-error">${bankEsc(r.date_raw || 'no date')}</span>`}</td>
          <td class="bank-col-desc" title="${bankEsc(r.description || '')}"><span class="bank-m-date">${r.date ? bankEsc(bankShortDate(r.date)) : bankEsc(r.date_raw || 'no date')}${r.page ? ` · p.${bankEsc(r.page)}` : ''}</span><span class="bank-desc-text">${bankEsc(r.description || '')}</span>${badges.length ? `<span class="bank-row-badges">${badges.join('')}</span>` : ''}</td>
          <td class="bank-col-amount ${r.cents < 0 ? 'is-neg' : 'is-pos'}">${amount}</td>
          <td class="bank-col-amount bank-col-bal">${bankPlainCents(r.balance_cents)}</td>
          <td class="bank-col-page">${r.page ? bankEsc(r.page) : ''}</td>
          <td class="bank-col-cat">${Number.isInteger(r.cents) ? `<select class="form-control bank-cat-select" data-index="${r.index}" aria-label="Category for row ${rowNo(r.index)}">${catOptions(cat)}</select>` : ''}</td>
        </tr>`;
      })
      .join('');

    // ---------- footer ----------
    const c = t.counts || {};
    const target = state.accountId;
    const account = accounts.find((a) => String(a.id) === String(target));
    const mismatch = target !== '__new' && !!t.currency_mismatch;
    const n = c.new != null ? c.new : rows.length;
    let reason = '';
    if (t.committed) reason = 'This statement is already imported.';
    else if (t.status !== 'proven') reason = 'Nothing is written until the balance proves.';
    else if (!t.can_import) reason = 'Some rows have no readable date; nothing is written.';
    else if (n === 0 && !mismatch) reason = 'Every row is already in this account.';
    // A currency mismatch is explained by the warning above the button.
    const canImport = !reason && !mismatch;
    const u = t.usage || {};
    const usageBits = [
      u.ai === 'platform' ? 'Shared AI' : u.ai === 'user' ? 'Your AI' : '',
      u.model || u.provider || '',
      Number.isInteger(u.calls) ? `${u.calls} call${u.calls === 1 ? '' : 's'}` : '',
      Number.isInteger(u.tokens_in) || Number.isInteger(u.tokens_out) ? `${((u.tokens_in || 0) + (u.tokens_out || 0)).toLocaleString('en-CA')} tokens` : '',
      Number.isInteger(u.ms) ? `${(u.ms / 1000).toFixed(1)} s` : ''
    ].filter(Boolean);

    const scrollBefore = m.body.scrollTop;
    m.body.innerHTML = `
      ${stepHeader(2, true)}
      <div class="bank-preview-head">
        <div class="bank-preview-file bank-agent-head">${headBits.map((x) => `<span class="bank-head-bit">${x}</span>`).join('')}</div>
        <div class="bank-preview-format"><span class="badge">${t.statement_type === 'card' ? 'Card' : 'Bank account'}</span> <span class="bank-agent-file">${bankEsc(t.file_name || (state.file && state.file.name) || '')}</span></div>
      </div>
      ${proofHtml}
      <div class="bank-summary">
        <span><strong>${rows.length}</strong> rows</span>
        ${Number.isInteger(t.opening_cents) ? `<span>Opening ${bankCents(t.opening_cents, cur)}</span>` : ''}
        ${Number.isInteger(t.closing_cents) ? `<span>Closing ${bankCents(t.closing_cents, cur)}</span>` : ''}
        ${c.duplicates ? `<span class="bank-status bank-status-dup">${c.duplicates} already in account</span>` : ''}
      </div>
      <div class="table-container bank-table-wrap" id="biw-agent-table">
        <table class="table bank-table bank-agent-table${rows.some((r) => Number.isInteger(r.balance_cents)) ? '' : ' no-bal'}${rows.some((r) => r.page) ? '' : ' no-page'}">
          <thead>
            <tr>
              <th class="bank-col-n">#</th><th class="bank-col-date">Date</th><th>Description</th><th class="bank-col-amount">Amount${cur ? ` (${bankEsc(cur)})` : ''}</th><th class="bank-col-amount bank-col-bal">Balance</th><th class="bank-col-page">Page</th><th class="bank-col-cat">Category</th>
            </tr>
          </thead>
          <tbody>${rowsHtml || '<tr><td colspan="7" class="bank-empty-row">No rows were read from this file.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="bank-agent-foot">
        <div class="form-group bank-agent-account">
          <label for="biw-agent-account" class="form-label">Import into account</label>
          <select id="biw-agent-account" class="form-control">
            ${accounts.map((a) => `<option value="${bankEsc(a.id)}" ${String(a.id) === String(target) ? 'selected' : ''}>${bankEsc(a.name)} (${bankEsc(a.currency)})</option>`).join('')}
            <option value="__new" ${target === '__new' ? 'selected' : ''}>New account: ${bankEsc(newAccountName(t))}${cur ? ` (${bankEsc(cur)})` : ''}</option>
          </select>
        </div>
        ${mismatch ? `<div class="bank-alert bank-alert-warning">The statement is in ${bankEsc(cur)} but ${bankEsc(account ? account.name : 'this account')} is in ${bankEsc(account ? account.currency : '')}. Choose a ${bankEsc(cur)} account or a new one.</div>` : ''}
        ${reason ? `<p class="bank-agent-reason"><i class="fas fa-lock" aria-hidden="true"></i> ${bankEsc(reason)}</p>` : ''}
      </div>
      ${usageBits.length ? `<p class="bank-agent-usage">${bankEsc(usageBits.join(' · '))}</p>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-back">Back</button>
        <button type="button" class="btn btn-primary" id="biw-commit" ${canImport ? '' : 'disabled'}>${canImport ? `Import ${n} row${n === 1 ? '' : 's'}` : 'Import'}</button>
      </div>`;

    layout(true, !!opts.keepScroll);
    if (opts.keepScroll) m.body.scrollTop = scrollBefore;
    const wrap = document.getElementById('biw-agent-table');
    const scrollToRow = (i, withPage) => {
      const tr = wrap.querySelector(`tr[data-index="${i}"]`);
      if (!tr) return;
      const head = wrap.querySelector('thead');
      const top = tr.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
      wrap.scrollTop = Math.max(0, top - (head ? head.offsetHeight : 0) - wrap.clientHeight / 3);
      if (withPage) wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      tr.classList.remove('is-flash');
      void tr.offsetWidth;
      tr.classList.add('is-flash');
    };
    if (breakIndex !== null) requestAnimationFrame(() => scrollToRow(breakIndex, false));
    const showBreak = document.getElementById('biw-show-break');
    if (showBreak) showBreak.addEventListener('click', () => scrollToRow(breakIndex, true));
    m.body.querySelectorAll('[data-biw-row]').forEach((b) => b.addEventListener('click', () => scrollToRow(Number(b.dataset.biwRow), true)));

    m.body.querySelectorAll('.bank-cat-select').forEach((sel) =>
      sel.addEventListener('change', () => {
        const idx = Number(sel.dataset.index);
        const row = rows.find((r) => r.index === idx);
        if (row && sel.value === row.category) delete state.categories[idx];
        else state.categories[idx] = sel.value;
      })
    );

    const form = document.getElementById('biw-balances');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const open = document.getElementById('biw-open');
        const close = document.getElementById('biw-close');
        const clean = (el) => (el && el.value.trim() ? el.value.trim().replace(/[\s,$€£₴]/g, '') : undefined);
        const body = { opening_balance: clean(open), closing_balance: clean(close) };
        if (state.accountId && state.accountId !== '__new') body.accountId = state.accountId;
        if (body.opening_balance === undefined && body.closing_balance === undefined) {
          return renderStatement({ balanceError: 'Type the balance first, e.g. 1234.56', keepScroll: true });
        }
        const go = document.getElementById('biw-balances-go');
        go.disabled = true;
        go.textContent = 'Checking…';
        try {
          state.task = await bankStatementCall(`/api/statements/${encodeURIComponent(t.id)}/balances`, { method: 'POST', body: JSON.stringify(body) });
          renderStatement();
        } catch (err) {
          renderStatement({ balanceError: err.message, keepScroll: true });
        }
      });
    }

    document.getElementById('biw-agent-account').addEventListener('change', async (e) => {
      state.accountId = e.target.value;
      try {
        await refreshTask();
      } catch (err) {
        showNotification(err.message, 'error');
      }
      renderStatement({ keepScroll: true });
    });
    document.getElementById('biw-back').addEventListener('click', () => {
      if (state.accountId === '__new') state.accountId = accounts[0] ? accounts[0].id : null;
      renderStep1();
    });

    document.getElementById('biw-commit').addEventListener('click', async () => {
      const btn = document.getElementById('biw-commit');
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        let accountId = state.accountId;
        let accountName = account ? account.name : '';
        if (accountId === '__new') {
          // A new account starts at the statement's opening balance, so after the
          // import it holds the printed closing balance (a card owes: negative).
          const opening = Number.isInteger(t.opening_cents) ? t.opening_cents / 100 : 0;
          const res = await fetchWithAuth('/api/accounts', {
            method: 'POST',
            body: JSON.stringify({
              name: newAccountName(t),
              bankName: t.institution || undefined,
              currency: String(cur || (appState.baseCurrency || 'CAD')).toUpperCase(),
              balance: t.statement_type === 'card' ? -opening : opening,
              accountType: t.statement_type === 'card' ? 'credit' : 'checking'
            })
          });
          const created = await res.json().catch(() => ({}));
          if (!res.ok || !created.id) throw new Error(created.message || 'Could not create the account');
          accountId = created.id;
          accountName = created.name || newAccountName(t);
          state.accountId = String(created.id);
        }
        const result = await bankStatementCall(`/api/statements/${encodeURIComponent(t.id)}/commit`, {
          method: 'POST',
          body: JSON.stringify({ accountId, categories: state.categories })
        });
        if (typeof fetchAccounts === 'function') await fetchAccounts();
        accounts = bankAccountsList();
        renderStatementDone(result, accountName || result.account || '');
        bankRefreshCurrentPage();
      } catch (err) {
        showNotification(err.message || 'Import failed', 'error');
        if (state.accountId !== '__new' && !accounts.some((x) => String(x.id) === String(state.accountId)) && typeof fetchAccounts === 'function') {
          await fetchAccounts();
          accounts = bankAccountsList();
          return renderStatement();
        }
        btn.disabled = false;
        btn.textContent = `Import ${n} row${n === 1 ? '' : 's'}`;
      }
    });
  };

  // ---------- statement step 3: imported + the next 30 days ----------
  const renderStatementDone = (result, accountName) => {
    const t = state.task;
    const cur = t.currency || '';
    const plan = t.plan;
    const fig = (cents, cls) => `<dd class="${cls || ''}">${bankCents(cents, cur)}</dd>`;
    // The person's own AI lives on Your AI; read with the shared AI, the AI CFO page answers.
    const askPage = t.usage && t.usage.ai === 'user' ? 'my-ai' : 'ai';
    const planHtml = plan
      ? `
      <section class="bank-plan" aria-labelledby="biw-plan-h">
        <h3 class="bank-plan-title" id="biw-plan-h">Next 30 days <span>(estimate)</span></h3>
        <dl class="bank-plan-figs">
          <div><dt>Money in</dt>${fig(plan.income_30d_cents, 'is-pos')}</div>
          <div><dt>Spending</dt>${fig(-Math.abs(plan.spending_30d_cents || 0), 'is-neg')}</div>
          ${Number.isInteger(plan.projected_balance_cents) ? `<div><dt>Balance in 30 days</dt>${fig(plan.projected_balance_cents)}</div>` : `<div><dt>Net</dt>${fig(plan.net_30d_cents)}</div>`}
          ${Number.isInteger(plan.flexible_per_day_cents) ? `<div><dt>Free to spend</dt><dd>${bankCents(plan.flexible_per_day_cents, cur)}<small> a day</small></dd></div>` : ''}
        </dl>
        ${plan.bills && plan.bills.length
          ? `<h4 class="bank-plan-sub">Repeating bills <span>${bankCents(plan.bills_30d_cents, cur)} in 30 days</span></h4>
             <ul class="bank-plan-bills">${plan.bills.map((b) => `<li><span class="bank-plan-payee">${bankEsc(b.payee)}</span><span class="bank-plan-times">${b.times > 1 ? `seen ${b.times} times` : 'seen once'}</span><span class="bank-plan-fig">${bankCents(b.cents_30d, cur)}</span></li>`).join('')}</ul>`
          : '<p class="bank-plan-note">No bill repeats in this statement.</p>'}
        <p class="bank-plan-note">Worked out from the ${plan.basis_days || 30} days of this statement${Number.isInteger(plan.flexible_per_day_cents) ? '; free to spend = money in minus repeating bills, spread over 30 days' : ''}. A plain projection, no AI.</p>
      </section>`
      : '';
    layout(true);
    m.body.innerHTML = `
      ${stepHeader(3, true)}
      <div class="bank-done bank-agent-done">
        <div class="bank-done-icon"><i class="fas fa-check-circle"></i></div>
        <h3>${result.inserted} transaction${result.inserted === 1 ? '' : 's'} imported</h3>
        <p>into <strong>${bankEsc(accountName)}</strong>${result.skipped ? ` · ${result.skipped} already there, skipped` : ''}</p>
        ${result.balance_delta ? `<p>Balance adjusted by <strong>${bankMoney(result.balance_delta, cur)}</strong>${result.new_balance != null ? ` → ${bankMoney(result.new_balance, cur).replace(/^[+−]/, '')}` : ''}</p>` : ''}
      </div>
      ${planHtml}
      <div class="bank-agent-links">
        <a href="/transactions" class="bank-link" data-biw-go="transactions"><i class="fas fa-list" aria-hidden="true"></i> Open transactions</a>
        <a href="${askPage === 'ai' ? '/ai' : '/my-ai'}" class="bank-link" id="biw-ask-ai"><i class="fas fa-comments" aria-hidden="true"></i> Ask your AI about this statement</a>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="biw-another">Import another file</button>
        <button type="button" class="btn btn-primary" id="biw-done">Done</button>
      </div>`;
    bindErrorLinks();
    document.getElementById('biw-ask-ai').addEventListener('click', (e) => {
      e.preventDefault();
      const label = [t.institution, t.period && t.period.end ? bankPeriod(t.period) : ''].filter(Boolean).join(', ');
      const question = `I just imported my statement${label ? ` (${label})` : ''}. What stands out, and where could I spend less next month?`;
      goTo(askPage);
      let tries = 0;
      (function fill() {
        const input = document.getElementById(askPage === 'ai' ? 'ai-input' : 'ya-input');
        if (input) {
          if (!input.value) input.value = question;
          input.focus();
          return;
        }
        if (++tries < 40) setTimeout(fill, 100);
      })();
    });
    document.getElementById('biw-done').addEventListener('click', m.close);
    document.getElementById('biw-another').addEventListener('click', () => {
      state.file = null;
      state.task = null;
      state.categories = {};
      if (state.accountId === '__new') state.accountId = accounts[0] ? accounts[0].id : null;
      renderStep1();
    });
  };

  renderStep1();
  if (state.file && bankIsAgentFile(state.file)) runStatement();
}
