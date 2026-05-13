// Main application file

function renderPagination(currentPage, totalItems, perPage) {
  const totalPages = Math.max(1, Math.ceil((totalItems || 0) / (perPage || 50)));
  if (totalPages <= 1) return '';
  let html = '<ul class="pagination">';
  html += `<li class="pagination-item"><a href="#" class="pagination-link ${currentPage <= 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" aria-label="Previous"><i class="fas fa-chevron-left"></i></a></li>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<li class="pagination-item"><a href="#" class="pagination-link ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</a></li>`;
  }
  html += `<li class="pagination-item"><a href="#" class="pagination-link ${currentPage >= totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" aria-label="Next"><i class="fas fa-chevron-right"></i></a></li>`;
  html += '</ul>';
  return html;
}

document.addEventListener('DOMContentLoaded', () => {
    // Initialize application
    initApp();
  });
  
  // Global application state
  const appState = {
    isAuthenticated: false,
    user: null,
    token: null,
    currentPage: 'dashboard',
    accounts: [],
    transactions: [],
    categories: [],
    budgets: [],
    families: [],
    currentFamily: null,
    bankConnections: [],
    supportedBanks: [],
    filters: {
      startDate: null,
      endDate: null,
      accountId: null,
      category: null,
      type: null,
      search: '',
      page: 1
    }
  };
  
  // Initialize application
  async function initApp() {
    // Check authentication
    const token = localStorage.getItem('token');
    appState.token = token;

    if (token) {
      try {
        // Fetch user data
        await fetchCurrentUser();
        
        // Render authenticated user interface
        renderAuthenticatedUI();
        
        // Load main data
        Promise.all([
          fetchAccounts(),
          fetchSupportedBanks()
        ]).then(() => {
          // Отображение pagesы на основе URL
          const path = window.location.pathname;
          
          if (path.includes('/accounts')) {
            navigateTo('accounts');
          } else if (path.includes('/transactions')) {
            navigateTo('transactions');
          } else if (path.includes('/budgets')) {
            navigateTo('budgets');
          } else if (path.includes('/family')) {
            navigateTo('family');
          } else if (path.includes('/recurring')) {
            navigateTo('recurring');
          } else if (path.includes('/currency')) {
            navigateTo('currency');
          } else if (path.includes('/goals')) {
            navigateTo('goals');
          } else if (path.includes('/debts')) {
            navigateTo('debts');
          } else if (path.includes('/split')) {
            navigateTo('split');
          } else if (path.includes('/investments')) {
            navigateTo('investments');
          } else if (path.includes('/analytics')) {
            navigateTo('analytics');
          } else if (path.includes('/subscriptions')) {
            navigateTo('subscriptions');
          } else if (path.includes('/networth')) {
            navigateTo('networth');
          } else if (path.includes('/receipts')) {
            navigateTo('receipts');
          } else if (path.includes('/calendar')) {
            navigateTo('calendar');
          } else if (path.includes('/reports')) {
            navigateTo('reports');
          } else if (path.includes('/forecast')) {
            navigateTo('forecast');
          } else if (path.includes('/settings')) {
            navigateTo('settings');
          } else if (path.includes('/bank-connections')) {
            navigateTo('bank-connections');
          } else {
            navigateTo('dashboard');
          }
        });
      } catch (error) {
        console.error('Error checking authentication:', error);
        // Если invalid token, отображаем pagesу login
        renderLoginPage();
      }
    } else {
      // No token — show login page
      renderLoginPage();
    }
  }
  
  // Render authenticated user interface
  function renderAuthenticatedUI() {
    const app = document.getElementById('app');
    const initials = (appState.user.fullName || appState.user.username || '?').charAt(0).toUpperCase();

    app.innerHTML = `
      <div class="app-layout">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-logo">
            <span class="sidebar-logo-icon">💰</span>
            <span class="sidebar-logo-text">Finman</span>
            <button class="sidebar-collapse-btn" id="sidebar-collapse-btn" title="Collapse sidebar">
              <i class="fas fa-chevron-left"></i>
            </button>
          </div>

          <nav class="sidebar-nav">
            <div class="nav-group">
              <div class="nav-group-label">Main</div>
              <a href="#" class="nav-link" data-page="dashboard"><i class="fas fa-home"></i><span>Dashboard</span></a>
              <a href="#" class="nav-link" data-page="accounts"><i class="fas fa-wallet"></i><span>Accounts</span></a>
              <a href="#" class="nav-link" data-page="transactions"><i class="fas fa-arrows-alt-h"></i><span>Transactions</span></a>
            </div>
            <div class="nav-group">
              <div class="nav-group-label">Planning</div>
              <a href="#" class="nav-link" data-page="budgets"><i class="fas fa-piggy-bank"></i><span>Budgets</span></a>
              <a href="#" class="nav-link" data-page="goals"><i class="fas fa-bullseye"></i><span>Goals</span></a>
              <a href="#" class="nav-link" data-page="recurring"><i class="fas fa-sync-alt"></i><span>Recurring</span></a>
              <a href="#" class="nav-link" data-page="subscriptions"><i class="fas fa-box"></i><span>Subscriptions</span></a>
            </div>
            <div class="nav-group">
              <div class="nav-group-label">Analyze</div>
              <a href="#" class="nav-link" data-page="analytics"><i class="fas fa-chart-bar"></i><span>Analytics</span></a>
              <a href="#" class="nav-link" data-page="networth"><i class="fas fa-gem"></i><span>Net Worth</span></a>
              <a href="#" class="nav-link" data-page="investments"><i class="fas fa-chart-line"></i><span>Investments</span></a>
              <a href="#" class="nav-link" data-page="reports"><i class="fas fa-file-alt"></i><span>Reports</span></a>
              <a href="#" class="nav-link" data-page="forecast"><i class="fas fa-magic"></i><span>Forecast</span></a>
            </div>
            <div class="nav-group">
              <div class="nav-group-label">Tools</div>
              <a href="#" class="nav-link" data-page="receipts"><i class="fas fa-receipt"></i><span>Receipts</span></a>
              <a href="#" class="nav-link" data-page="debts"><i class="fas fa-hand-holding-usd"></i><span>Debts</span></a>
              <a href="#" class="nav-link" data-page="split"><i class="fas fa-user-friends"></i><span>Split</span></a>
              <a href="#" class="nav-link" data-page="family"><i class="fas fa-users"></i><span>Family</span></a>
              <a href="#" class="nav-link" data-page="currency"><i class="fas fa-coins"></i><span>Currencies</span></a>
              <a href="#" class="nav-link" data-page="bank-connections"><i class="fas fa-university"></i><span>Banks</span></a>
              <a href="#" class="nav-link" data-page="calendar"><i class="fas fa-calendar-alt"></i><span>Calendar</span></a>
            </div>
          </nav>

          <div class="sidebar-footer">
            <div class="sidebar-user">
              <div class="sidebar-avatar">${initials}</div>
              <div class="sidebar-user-info">
                <div class="sidebar-username">${appState.user.username}</div>
                <div class="sidebar-role">Personal account</div>
              </div>
            </div>
            <button id="logout-btn" class="sidebar-logout" title="Log out">
              <i class="fas fa-sign-out-alt"></i>
            </button>
          </div>
        </aside>

        <div class="main-area">
          <header class="topbar">
            <button class="topbar-menu-btn" id="sidebar-mobile-btn">
              <i class="fas fa-bars"></i>
            </button>
            <div class="topbar-breadcrumb" id="topbar-breadcrumb">Dashboard</div>
            <div class="topbar-actions">
              <button class="topbar-icon-btn" title="AI Assistant" id="ai-chat-open-btn">
                <i class="fas fa-robot"></i>
              </button>
              <button class="topbar-icon-btn" id="notif-btn" title="Notifications" style="position:relative">
                <i class="fas fa-bell"></i>
                <span class="notif-badge" id="notif-badge" style="display:none">0</span>
              </button>
              <button class="topbar-icon-btn" id="dark-toggle" title="Toggle dark mode">
                <i class="fas fa-moon" id="dark-toggle-icon"></i>
              </button>
            </div>
          </header>
          <main id="main-content" class="main-content">
            <div class="loading-state">
              <div class="spinner"></div>
            </div>
          </main>
        </div>
      </div>
    `;

    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(link.dataset.page);
        // Close mobile sidebar
        document.getElementById('sidebar').classList.remove('mobile-open');
      });
    });

    // Sidebar collapse toggle
    document.getElementById('sidebar-collapse-btn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
      localStorage.setItem('sidebarCollapsed', document.getElementById('sidebar').classList.contains('collapsed'));
    });
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
      document.getElementById('sidebar').classList.add('collapsed');
    }

    // Mobile sidebar toggle
    document.getElementById('sidebar-mobile-btn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('mobile-open');
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', logout);

    // AI chat button
    const aiBtn = document.getElementById('ai-chat-open-btn');
    if (aiBtn) {
      aiBtn.addEventListener('click', () => {
        const panel = document.getElementById('ai-chat-panel');
        if (panel) panel.classList.toggle('active');
      });
    }

    // Dark mode
    const darkToggle = document.getElementById('dark-toggle');
    const darkIcon = document.getElementById('dark-toggle-icon');
    function applyDarkMode(dark) {
      document.body.classList.toggle('dark', dark);
      if (darkIcon) { darkIcon.className = dark ? 'fas fa-sun' : 'fas fa-moon'; }
    }
    applyDarkMode(localStorage.getItem('darkMode') === 'true');
    darkToggle?.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark');
      localStorage.setItem('darkMode', isDark);
      if (darkIcon) { darkIcon.className = isDark ? 'fas fa-sun' : 'fas fa-moon'; }
    });

    // Notifications bell
    async function refreshNotifBadge() {
      try {
        const res = await fetch('/api/notifications/unread-count', { headers: { Authorization: `Bearer ${appState.token}` } });
        if (!res.ok) return;
        const { count } = await res.json();
        const badge = document.getElementById('notif-badge');
        if (!badge) return;
        if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = ''; }
        else { badge.style.display = 'none'; }
      } catch {}
    }
    refreshNotifBadge();
    setInterval(refreshNotifBadge, 60000);

    const notifBtn = document.getElementById('notif-btn');
    notifBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      let dropdown = document.getElementById('notif-dropdown');
      if (dropdown) { dropdown.remove(); return; }
      dropdown = document.createElement('div');
      dropdown.id = 'notif-dropdown';
      dropdown.className = 'notif-dropdown';
      dropdown.innerHTML = '<div class="notif-header">Notifications <button id="notif-mark-all" style="float:right;font-size:11px;background:none;border:none;cursor:pointer;color:var(--accent)">Mark all read</button></div><div class="notif-list"><div class="notif-empty"><i class="fas fa-check-circle"></i><p>All caught up!</p></div></div>';
      notifBtn.appendChild(dropdown);
      try {
        const res = await fetch('/api/notifications?limit=10', { headers: { Authorization: `Bearer ${appState.token}` } });
        if (res.ok) {
          const notifs = await res.json();
          const list = dropdown.querySelector('.notif-list');
          if (notifs.length) {
            list.innerHTML = notifs.map(n => `<div class="notif-item${n.is_read ? '' : ' unread'}"><div class="notif-icon ${n.type === 'budget_alert' ? 'warn' : n.type === 'goal_reached' ? 'ok' : 'info'}"><i class="fas fa-${n.type === 'budget_alert' ? 'exclamation-triangle' : n.type === 'goal_reached' ? 'trophy' : 'info-circle'}"></i></div><div class="notif-body"><div class="notif-msg">${DOMPurify.sanitize(n.message || n.title || '')}</div><div class="notif-time">${new Date(n.created_at).toLocaleDateString()}</div></div></div>`).join('');
          }
        }
      } catch {}
      dropdown.querySelector('#notif-mark-all')?.addEventListener('click', async () => {
        await fetch('/api/notifications/read-all', { method: 'PUT', headers: { Authorization: `Bearer ${appState.token}` } });
        dropdown.remove();
        refreshNotifBadge();
      });
      document.addEventListener('click', () => dropdown?.remove(), { once: true });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'n' || e.key === 'N') { document.getElementById('add-transaction-btn')?.click(); }
      else if (e.key === 'b' || e.key === 'B') { navigateTo('budgets'); }
      else if (e.key === 'g' || e.key === 'G') { navigateTo('goals'); }
      else if (e.key === 'Escape') { document.querySelector('.modal')?.remove(); }
      else if (e.key === '?') { showKeyboardHelp(); }
    });

    function showKeyboardHelp() {
      const existing = document.getElementById('kbd-help-modal');
      if (existing) { existing.remove(); return; }
      const modal = document.createElement('div');
      modal.id = 'kbd-help-modal';
      modal.className = 'modal';
      modal.innerHTML = `<div class="modal-content" style="max-width:360px"><div class="modal-header"><h3>Keyboard Shortcuts</h3><button class="modal-close" onclick="this.closest('.modal').remove()"><i class="fas fa-times"></i></button></div><div class="modal-body"><table style="width:100%;border-collapse:collapse"><tr><td><kbd>N</kbd></td><td>New transaction</td></tr><tr><td><kbd>B</kbd></td><td>Go to Budgets</td></tr><tr><td><kbd>G</kbd></td><td>Go to Goals</td></tr><tr><td><kbd>Esc</kbd></td><td>Close modal</td></tr><tr><td><kbd>?</kbd></td><td>This help</td></tr></table></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }
  }


  const PAGE_LABELS = {
    dashboard: 'Dashboard', accounts: 'Accounts', transactions: 'Transactions',
    budgets: 'Budgets', goals: 'Goals', recurring: 'Recurring', subscriptions: 'Subscriptions',
    analytics: 'Analytics', networth: 'Net Worth', investments: 'Investments',
    reports: 'Reports', forecast: 'Forecast', receipts: 'Receipts', debts: 'Debts',
    split: 'Split', family: 'Family', currency: 'Currencies', 'bank-connections': 'Banks',
    calendar: 'Calendar', settings: 'Settings'
  };

  function navigateTo(page) {
    appState.currentPage = page;

    // Update active nav link
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.page === page);
    });

    // Update topbar breadcrumb
    const bc = document.getElementById('topbar-breadcrumb');
    if (bc) bc.textContent = PAGE_LABELS[page] || page;

    window.history.pushState({}, '', '/' + page);

    const mainContent = document.getElementById('main-content');
    if (!mainContent) { console.warn('navigateTo: main-content not found, skipping'); return; }
    mainContent.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
    
    // Загрузка pagesы
    switch (page) {
      case 'dashboard':
        renderDashboard();
        break;
      case 'accounts':
        renderAccountsPage();
        break;
      case 'transactions':
        renderTransactionsPage();
        break;
      case 'budgets':
        renderBudgetsPage();
        break;
      case 'family':
        renderFamilyPage();
        break;
      case 'recurring':
        renderRecurringPage();
        break;
      case 'currency':
        renderCurrencyPage();
        break;
      case 'goals':
        renderGoalsPage();
        break;
      case 'debts':
        renderDebtsPage();
        break;
      case 'split':
        renderSplitPage();
        break;
      case 'investments':
        renderInvestmentsPage();
        break;
      case 'analytics':
        renderAnalyticsPage();
        break;
      case 'subscriptions':
        renderSubscriptionsPage();
        break;
      case 'networth':
        renderNetWorthPage();
        break;
      case 'receipts':
        renderReceiptsPage();
        break;
      case 'calendar':
        renderCalendarPage();
        break;
      case 'reports':
        renderReportsPage();
        break;
      case 'forecast':
        renderForecastPage();
        break;
      case 'bank-connections':
        renderBankConnectionsPage();
        break;
      case 'settings':
        renderSettingsPage();
        break;
      default:
        renderSmartDashboard();
    }
  }
  
  // HTTP request with authorization
  async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('token');
    
    if (!token) {
      throw new Error('Unauthorized');
    }
    
    const defaultOptions = {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    if (options.headers) {
      mergedOptions.headers = { ...defaultOptions.headers, ...options.headers };
    }
    
    const response = await fetch(url, mergedOptions);
    
    if (response.status === 401) {
      // Unauthorized, перенаправляем на pagesу login
      localStorage.removeItem('token');
      renderLoginPage();
      throw new Error('Unauthorized');
    }
    
    return response;
  }
  
  // Fetch current user data
  async function fetchCurrentUser() {
    try {
      const response = await fetchWithAuth('/api/auth/me');
      
      if (!response.ok) {
        throw new Error('Failed to fetch user data');
      }
      
      const data = await response.json();
      appState.isAuthenticated = true;
      appState.user = data;
      
      return data;
    } catch (error) {
      console.error('Error fetching user data:', error);
      appState.isAuthenticated = false;
      appState.user = null;
      throw error;
    }
  }
  
  // Fetch list accounts
  async function fetchAccounts() {
    try {
      const response = await fetchWithAuth('/api/accounts');
      
      if (!response.ok) {
        throw new Error('Failed to fetch list accounts');
      }
      
      const data = await response.json();
      appState.accounts = Array.isArray(data) ? data : (data.all || []);

      return appState.accounts;
    } catch (error) {
      console.error('Error fetching accounts:', error);
      showNotification('Error fetching accounts', 'error');
      return [];
    }
  }

  async function fetchTransactionStats() {
    try {
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const [statsResp, accsResp] = await Promise.all([
        fetchWithAuth('/api/transactions/stats/summary?startDate=' + startDate + '&groupBy=month'),
        fetchWithAuth('/api/accounts')
      ]);
      const rows = statsResp.ok ? await statsResp.json() : [];
      const accsData = accsResp.ok ? await accsResp.json() : [];
      const accs = Array.isArray(accsData) ? accsData : (accsData.all || []);
      const monthlyIncome = rows.reduce((s, r) => s + (r.income || 0), 0);
      const monthlyExpense = rows.reduce((s, r) => s + (r.expense || 0), 0);
      const totalBalance = accs.reduce((s, a) => s + (a.balance || 0), 0);
      return { monthlyIncome, monthlyExpense, totalBalance, rows };
    } catch (error) {
      console.error('Error fetching stats:', error);
      return { monthlyIncome: 0, monthlyExpense: 0, totalBalance: 0, rows: [] };
    }
  }
  
  // Fetch supported banks list
  async function fetchSupportedBanks() {
    try {
      const response = await fetchWithAuth('/api/bank-api/supported-banks');
      
      if (!response.ok) {
        throw new Error('Failed to fetch supported banks list');
      }
      
      const data = await response.json();
      appState.supportedBanks = data;
      
      return data;
    } catch (error) {
      console.error('Error fetching list banks:', error);
      return [];
    }
  }
  
  // Render login page
  function renderLoginPage() {
    const app = document.getElementById('app');
    
    app.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-header">
            <h1>💰 Finman</h1>
            <p>AI-powered personal finance manager</p>
          </div>
          <div class="auth-demo-hint">
            Demo: <code>admin</code> / <code>password123</code>
          </div>
          
          <div class="auth-tabs">
            <button class="auth-tab active" data-tab="login">Login</button>
            <button class="auth-tab" data-tab="register">Sign up</button>
          </div>
          
          <div class="auth-form-container">
            <!-- Login form -->
            <form id="login-form" class="auth-form">
              <div class="form-group">
                <label for="login-username" class="form-label">Username</label>
                <input type="text" id="login-username" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="login-password" class="form-label">Password</label>
                <input type="password" id="login-password" class="form-control" required>
              </div>
              
              <div id="login-error" class="auth-error"></div>
              
              <button type="submit" class="btn btn-primary w-100">Log in</button>
            </form>
            
            <!-- Registration form -->
            <form id="register-form" class="auth-form hidden">
              <div class="form-group">
                <label for="register-username" class="form-label">Username</label>
                <input type="text" id="register-username" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-email" class="form-label">Email</label>
                <input type="email" id="register-email" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-fullname" class="form-label">Full name</label>
                <input type="text" id="register-fullname" class="form-control">
              </div>
              
              <div class="form-group">
                <label for="register-password" class="form-label">Password</label>
                <input type="password" id="register-password" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-confirm-password" class="form-label">Confirm password</label>
                <input type="password" id="register-confirm-password" class="form-control" required>
              </div>
              
              <div id="register-error" class="auth-error"></div>
              
              <button type="submit" class="btn btn-primary w-100">Sign up</button>
            </form>
          </div>
        </div>
      </div>
    `;
    
    // Обработчики switching between формs
    const authTabs = document.querySelectorAll('.auth-tab');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    
    authTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        // Update active таба
        authTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Отображение соответствующей forms
        if (tabName === 'login') {
          loginForm.classList.remove('hidden');
          registerForm.classList.add('hidden');
        } else {
          loginForm.classList.add('hidden');
          registerForm.classList.remove('hidden');
        }
      });
    });
    
    // Handler for forms login
    loginForm.addEventListener('submit', handleLogin);
    
    // Handler for forms регистрации
    registerForm.addEventListener('submit', handleRegister);
  }
  
  // Processing login
  async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorElement = document.getElementById('login-error');
    
    if (!username || !password) {
      errorElement.textContent = 'Please fill in all fields';
      return;
    }
    
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        errorElement.textContent = data.message || 'Login error';
        return;
      }
      
      // Save token
      localStorage.setItem('token', data.token);
      
      // Update state
      appState.isAuthenticated = true;
      appState.user = data.user;
      
      // Reload application
      initApp();
    } catch (error) {
      console.error('Error login:', error);
      errorElement.textContent = 'An error occurred while logging in';
    }
  }
  
  // Processing регистрации
  async function handleRegister(e) {
    e.preventDefault();
    
    const username = document.getElementById('register-username').value;
    const email = document.getElementById('register-email').value;
    const fullName = document.getElementById('register-fullname').value;
    const password = document.getElementById('register-password').value;
    const confirmPassword = document.getElementById('register-confirm-password').value;
    const errorElement = document.getElementById('register-error');
    
    if (!username || !email || !password || !confirmPassword) {
      errorElement.textContent = 'Please fill in all required fields';
      return;
    }
    
    if (password !== confirmPassword) {
      errorElement.textContent = 'Passwords do not match';
      return;
    }
    
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, email, password, fullName })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        errorElement.textContent = data.message || 'Registration error';
        return;
      }
      
      // Save token
      localStorage.setItem('token', data.token);
      
      // Update state
      appState.isAuthenticated = true;
      appState.user = data.user;
      
      // Reload application
      initApp();
    } catch (error) {
      console.error('Registration error:', error);
      errorElement.textContent = 'An error occurred during registration';
    }
  }
  
  // Отрисовка dashboardа
  async function renderDashboard() {
    const mainContent = document.getElementById('main-content');

    // Parallel fetch everything needed for the dashboard
    const [recentTransactions, statsData, budgetsResp, goalsResp, nwResp, notifResp] = await Promise.allSettled([
      fetchTransactions({ limit: 5 }),
      fetchTransactionStats(),
      fetchWithAuth('/api/budgets/active').then(r => r.json()).catch(() => []),
      fetchWithAuth('/api/goals/stats').then(r => r.json()).catch(() => ({})),
      fetchWithAuth('/api/networth/current').then(r => r.json()).catch(() => null),
      fetchWithAuth('/api/notifications?limit=5').then(r => r.json()).catch(() => []),
    ]);

    const txList = budgetsResp.status === 'fulfilled' ? recentTransactions.value || [] : [];
    const stats = statsData.status === 'fulfilled' ? statsData.value : {};
    const budgets = budgetsResp.status === 'fulfilled' ? (budgetsResp.value || []) : [];
    const goals = goalsResp.status === 'fulfilled' ? (goalsResp.value || {}) : {};
    const nw = nwResp.status === 'fulfilled' ? nwResp.value : null;
    const notifications = notifResp.status === 'fulfilled' ? (notifResp.value || []) : [];

    const recentTx = recentTransactions.status === 'fulfilled' ? (recentTransactions.value || []) : [];

    // ── Savings rate
    const savingsRate = stats.monthlyIncome > 0
      ? Math.round(((stats.monthlyIncome - stats.monthlyExpense) / stats.monthlyIncome) * 100)
      : 0;

    // ── Accounts HTML
    const accountsHtml = appState.accounts.map(a => `
      <div class="account-summary">
        <div class="account-info">
          <div class="account-icon"><i class="fas fa-wallet"></i></div>
          <div class="account-details">
            <h3 class="account-name">${a.name}</h3>
            <p class="account-number">${a.account_number || a.type || ''}</p>
          </div>
        </div>
        <div class="account-balance">${formatCurrency(a.balance, a.currency)}</div>
      </div>`).join('') || '<p>No accounts yet. <a href="#" class="add-account-link">Add account</a></p>';

    // ── Recent transactions HTML
    const transactionsHtml = recentTx.length > 0
      ? recentTx.map(t => `
        <div class="transaction-item">
          <div class="transaction-info">
            <div class="transaction-date">${formatDate(t.date)}</div>
            <div class="transaction-description">${t.description}</div>
            <div class="transaction-category">${t.category || 'Uncategorized'}</div>
          </div>
          <div class="transaction-amount ${t.type === 'income' ? 'income' : 'expense'}">
            ${t.type === 'expense' ? '-' : '+'}${formatCurrency(t.amount)}
          </div>
        </div>`).join('')
      : '<p class="empty-hint">No transactions yet. <a href="#" class="add-transaction-link">Add one →</a></p>';

    // ── Budget progress bars
    const alertBudgets = budgets.filter(b => b.percentage >= 80);
    const budgetsHtml = budgets.length === 0
      ? '<p class="empty-hint">No active budgets. <a href="#" onclick="navigateTo(\'budgets\')">Create one →</a></p>'
      : budgets.slice(0, 4).map(b => {
          const pct = Math.min(b.percentage || 0, 100);
          const color = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warning)' : 'var(--success)';
          return `<div class="db-budget-row">
            <div class="db-budget-label">
              <span>${b.name}</span>
              <span style="color:${color};font-weight:600">${formatCurrency(b.spent || 0)} / ${formatCurrency(b.limit_amount)}</span>
            </div>
            <div class="db-progress-bar">
              <div class="db-progress-fill" style="width:${pct}%;background:${color}"></div>
            </div>
          </div>`;
        }).join('');

    // ── Goals widget
    const goalsHtml = goals.activeGoals > 0
      ? `<div class="db-goals-summary">
          <div class="db-goal-stat"><span class="db-goal-num">${goals.activeGoals}</span><span class="db-goal-lbl">Active</span></div>
          <div class="db-goal-stat"><span class="db-goal-num">${formatCurrency(goals.totalSaved || 0)}</span><span class="db-goal-lbl">Saved</span></div>
          <div class="db-goal-stat"><span class="db-goal-num">${goals.overallProgress || 0}%</span><span class="db-goal-lbl">Overall</span></div>
        </div>`
      : '<p class="empty-hint">No goals. <a href="#" onclick="navigateTo(\'goals\')">Set a goal →</a></p>';

    // ── Net worth snippet
    const nwHtml = nw
      ? `<div class="db-networth">
          <span class="db-networth-val">${formatCurrency(nw.netWorth || 0)}</span>
          <span class="db-networth-lbl">net worth</span>
        </div>`
      : '';

    // ── Financial health score (0-100, computed locally)
    let healthScore = 0;
    let healthTips = [];
    if (stats.monthlyIncome > 0) {
      healthScore += 20;
      if (savingsRate >= 20) { healthScore += 25; }
      else if (savingsRate >= 10) { healthScore += 12; healthTips.push('Save 20%+ of income for optimal health'); }
      else { healthTips.push('Your savings rate is low — aim for 10-20%'); }
    } else { healthTips.push('Add income transactions to track savings rate'); }
    if (budgets.length > 0) { healthScore += 20; } else { healthTips.push('Create budgets to control spending'); }
    if (goals.activeGoals > 0) { healthScore += 15; } else { healthTips.push('Set a savings goal to stay motivated'); }
    if (alertBudgets.filter(b => b.percentage >= 100).length === 0) { healthScore += 10; } else { healthTips.push('Some budgets are over limit'); }
    if (appState.accounts.length > 0) { healthScore += 10; }
    const healthColor = healthScore >= 70 ? 'var(--success,#38c172)' : healthScore >= 40 ? 'var(--warning,#f6993f)' : 'var(--danger,#e3342f)';
    const healthLabel = healthScore >= 70 ? 'Good' : healthScore >= 40 ? 'Fair' : 'Needs work';
    const healthScoreHtml = `
      <div class="card db-widget" style="padding:14px 16px">
        <div class="section-header" style="margin-bottom:8px">
          <h2><i class="fas fa-heartbeat" style="color:${healthColor}"></i> Financial health</h2>
        </div>
        <div style="display:flex;align-items:center;gap:16px">
          <div style="font-size:2rem;font-weight:700;color:${healthColor};line-height:1">${healthScore}</div>
          <div style="flex:1">
            <div style="background:var(--bg);border-radius:8px;height:8px;overflow:hidden">
              <div style="height:100%;width:${healthScore}%;background:${healthColor};border-radius:8px;transition:width .5s"></div>
            </div>
            <div style="font-size:12px;color:${healthColor};margin-top:4px;font-weight:600">${healthLabel}</div>
          </div>
        </div>
        ${healthTips.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px">${healthTips[0]}</div>` : ''}
      </div>`;

    // ── Budget alert banner
    const alertHtml = alertBudgets.length > 0
      ? `<div class="db-alert-banner">
          <i class="fas fa-exclamation-triangle"></i>
          ${alertBudgets.map(b => `<strong>${b.name}</strong> at ${Math.round(b.percentage)}%`).join(', ')} — near or over limit
        </div>`
      : '';

    mainContent.innerHTML = `
      ${alertHtml}
      <div id="ai-insight-banner" class="ai-insight-banner ai-insight-loading">
        <i class="fas fa-robot"></i> <span id="ai-insight-text">Generating weekly AI insight…</span>
        <button class="ai-insight-close" onclick="this.closest('.ai-insight-banner').remove()"><i class="fas fa-times"></i></button>
      </div>
      <div class="db-toprow">
        <h1 class="page-title" style="margin:0">Finance Overview</h1>
        <button class="btn btn-sm btn-primary" id="add-transaction-quick"><i class="fas fa-plus"></i> Add transaction</button>
      </div>

      <div class="dashboard-summary">
        <div class="summary-card income">
          <div class="summary-icon"><i class="fas fa-arrow-down"></i></div>
          <div class="summary-data">
            <h3>Income / month</h3>
            <div class="summary-amount">${formatCurrency(stats.monthlyIncome || 0)}</div>
          </div>
        </div>
        <div class="summary-card expense">
          <div class="summary-icon"><i class="fas fa-arrow-up"></i></div>
          <div class="summary-data">
            <h3>Expenses / month</h3>
            <div class="summary-amount">${formatCurrency(stats.monthlyExpense || 0)}</div>
          </div>
        </div>
        <div class="summary-card balance">
          <div class="summary-icon"><i class="fas fa-wallet"></i></div>
          <div class="summary-data">
            <h3>Total balance</h3>
            <div class="summary-amount">${formatCurrency(stats.totalBalance || 0)}</div>
          </div>
        </div>
        <div class="summary-card ${savingsRate >= 20 ? 'income' : savingsRate >= 0 ? 'balance' : 'expense'}">
          <div class="summary-icon"><i class="fas fa-piggy-bank"></i></div>
          <div class="summary-data">
            <h3>Savings rate</h3>
            <div class="summary-amount">${savingsRate}%</div>
          </div>
        </div>
      </div>

      <div class="db-grid">
        <!-- Left column -->
        <div class="db-col">
          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-wallet" style="color:var(--accent)"></i> Accounts</h2>
              <button id="add-account-btn" class="btn btn-sm btn-outline"><i class="fas fa-plus"></i></button>
            </div>
            <div class="accounts-list">${accountsHtml}</div>
          </div>

          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-arrows-alt-h" style="color:var(--accent)"></i> Recent transactions</h2>
              <button id="add-transaction-btn" class="btn btn-sm btn-outline"><i class="fas fa-plus"></i></button>
            </div>
            <div class="transactions-list">${transactionsHtml}</div>
            <div class="section-footer">
              <a href="#" class="btn btn-sm btn-outline" id="view-all-transactions">View all →</a>
            </div>
          </div>
        </div>

        <!-- Right column -->
        <div class="db-col">
          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-tachometer-alt" style="color:var(--warning)"></i> Budgets</h2>
              <a href="#" class="btn btn-sm btn-outline" onclick="navigateTo('budgets')">All</a>
            </div>
            ${budgetsHtml}
          </div>

          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-bullseye" style="color:var(--success)"></i> Goals</h2>
              <a href="#" class="btn btn-sm btn-outline" onclick="navigateTo('goals')">All</a>
            </div>
            ${goalsHtml}
            ${nwHtml}
          </div>

          ${healthScoreHtml}

          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-chart-bar" style="color:var(--accent)"></i> Spending trend</h2>
            </div>
            <div style="position:relative;height:180px"><canvas id="income-expense-chart"></canvas></div>
          </div>

          <div class="card db-widget">
            <div class="section-header">
              <h2><i class="fas fa-chart-pie" style="color:var(--accent)"></i> By category</h2>
            </div>
            <div style="position:relative;height:180px"><canvas id="expense-categories-chart"></canvas></div>
          </div>
        </div>
      </div>
    `;

    // Fetch category data for pie chart then init charts
    fetchWithAuth('/api/analytics/expenses-by-category')
      .then(r => r.json()).catch(() => [])
      .then(catData => initCharts(stats, catData));

    // Load AI weekly insight asynchronously
    (async () => {
      const banner = document.getElementById('ai-insight-banner');
      const textEl = document.getElementById('ai-insight-text');
      if (!banner || !textEl) return;
      try {
        const r = await fetch('/api/ai/insights/weekly', { headers: { Authorization: `Bearer ${appState.token}` } });
        if (!r.ok) throw new Error('non-ok');
        const data = await r.json();
        banner.classList.remove('ai-insight-loading');
        textEl.textContent = data.brief || 'No insights available.';
      } catch {
        banner.classList.add('ai-insight-error');
        textEl.textContent = 'AI insight unavailable right now.';
      }
    })();

    // Event handlers — use optional chaining since some may not exist with empty data
    document.getElementById('add-account-btn')?.addEventListener('click', showAddAccountModal);
    document.getElementById('add-transaction-btn')?.addEventListener('click', showAddTransactionModal);
    document.getElementById('add-transaction-quick')?.addEventListener('click', showAddTransactionModal);
    document.getElementById('view-all-transactions')?.addEventListener('click', (e) => {
      e.preventDefault(); navigateTo('transactions');
    });
    
    const addAccountLinks = document.querySelectorAll('.add-account-link');
    addAccountLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showAddAccountModal();
      });
    });
    
    const addTransactionLinks = document.querySelectorAll('.add-transaction-link');
    addTransactionLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showAddTransactionModal();
      });
    });
  }
  
  // Отрисовка pagesы accounts
  async function renderAccountsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Повторное fetch accounts для актуальности дан
    await fetchAccounts();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button id="add-account-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Add account
        </button>
      </div>
      
      <div class="accounts-container">
        <div id="accounts-list" class="card-grid">
          ${appState.accounts.length > 0 ? renderAccountsList(appState.accounts) : `
            <div class="empty-state">
              <div class="empty-state-icon">
                <i class="fas fa-wallet"></i>
              </div>
              <h2>You have no accounts yet</h2>
              <p>Add your first account to start tracking your finances</p>
              <button id="empty-add-account-btn" class="btn btn-primary">
                <i class="fas fa-plus"></i> Add account
              </button>
            </div>
          `}
        </div>
      </div>
    `;
    
    // Event handlers
    document.getElementById('add-account-btn').addEventListener('click', () => {
      showAddAccountModal();
    });
    
    const emptyAddAccountBtn = document.getElementById('empty-add-account-btn');
    if (emptyAddAccountBtn) {
      emptyAddAccountBtn.addEventListener('click', () => {
        showAddAccountModal();
      });
    }
    
    // Обработчики для кнопок управления accountsми
    const accountActionButtons = document.querySelectorAll('[data-account-action]');
    accountActionButtons.forEach(button => {
      button.addEventListener('click', handleAccountAction);
    });
  }
  
  // Render list accounts
  function renderAccountsList(accounts) {
    return accounts.map(account => `
      <div class="account-card card" data-account-id="${account.id}">
        <div class="account-header">
          <div class="account-icon">
            <i class="fas ${getAccountIcon(account.account_type)}"></i>
          </div>
          <div class="account-details">
            <h3 class="account-name">${account.name}</h3>
            <p class="account-number">${account.account_number || 'No number'}</p>
          </div>
        </div>
        
        <div class="account-balance">
          ${formatCurrency(account.balance, account.currency)}
        </div>
        
        <div class="account-info">
          <p class="account-bank">${account.bank_name || 'Personal account'}</p>
          <p class="account-type">${getAccountTypeName(account.account_type)}</p>
        </div>
        
        <div class="account-actions">
          <button class="btn btn-sm btn-outline" data-account-action="view" data-account-id="${account.id}">
            <i class="fas fa-eye"></i> Details
          </button>
          <button class="btn btn-sm btn-outline" data-account-action="edit" data-account-id="${account.id}">
            <i class="fas fa-edit"></i> Edit
          </button>
          <button class="btn btn-sm btn-danger" data-account-action="delete" data-account-id="${account.id}">
            <i class="fas fa-trash"></i> Delete
          </button>
        </div>
      </div>
    `).join('');
  }
  
  // Отрисовка transaction pages
  async function renderTransactionsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Fetch transactions with filters
    const transactions = await fetchTransactions(appState.filters);
    
    // Fetch categories для фильтра
    const categories = await fetchCategories();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Transactions</h1>
        <button id="add-transaction-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Add transaction
        </button>
      </div>
      
      <div class="filters-container card">
        <div class="filters-header">
          <h2>Filters</h2>
          <button id="toggle-filters-btn" class="btn btn-sm btn-outline">
            <i class="fas fa-filter"></i> Show filters
          </button>
        </div>
        
        <div id="filters-form" class="filters-form hidden">
          <div class="filters-row">
            <div class="form-group">
              <label for="filter-date-start" class="form-label">Start date</label>
              <input type="date" id="filter-date-start" class="form-control" value="${appState.filters.startDate || ''}">
            </div>
            
            <div class="form-group">
              <label for="filter-date-end" class="form-label">End date</label>
              <input type="date" id="filter-date-end" class="form-control" value="${appState.filters.endDate || ''}">
            </div>
            
            <div class="form-group">
              <label for="filter-account" class="form-label">Account</label>
              <select id="filter-account" class="form-control">
                <option value="">All accounts</option>
                ${appState.accounts.map(account => `
                  <option value="${account.id}" ${appState.filters.accountId == account.id ? 'selected' : ''}>
                    ${account.name}
                  </option>
                `).join('')}
              </select>
            </div>
          </div>
          
          <div class="filters-row">
            <div class="form-group">
              <label for="filter-category" class="form-label">Category</label>
              <select id="filter-category" class="form-control">
                <option value="">All categories</option>
                ${categories.map(category => `
                  <option value="${category}" ${appState.filters.category === category ? 'selected' : ''}>
                    ${category}
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="filter-type" class="form-label">Type</label>
              <select id="filter-type" class="form-control">
                <option value="">All types</option>
                <option value="income" ${appState.filters.type === 'income' ? 'selected' : ''}>Income</option>
                <option value="expense" ${appState.filters.type === 'expense' ? 'selected' : ''}>Expenses</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="filter-search" class="form-label">Search</label>
              <input type="text" id="filter-search" class="form-control" placeholder="Search by description" value="${appState.filters.search || ''}">
            </div>
          </div>
          
          <div class="filters-actions">
            <button id="apply-filters-btn" class="btn btn-primary">Apply</button>
            <button id="reset-filters-btn" class="btn btn-outline">Reset</button>
          </div>
        </div>
      </div>
      
      <div class="transactions-container card">
        <div class="transactions-header">
          <div class="transactions-summary">
            <span>Transactions found: <strong id="transactions-count">${transactions.length}</strong></span>
          </div>
          <div class="transactions-actions">
            <button id="import-transactions-btn" class="btn btn-sm btn-outline">
              <i class="fas fa-file-import"></i> Import from CSV
            </button>
          </div>
        </div>
        
        <div class="table-container">
          <table class="table transactions-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th>Account</th>
                <th class="text-right">Amount</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="transactions-list">
              ${transactions.length > 0 ? renderTransactionsList(transactions) : `
                <tr>
                  <td colspan="6" class="text-center">
                    <div class="empty-state-mini">
                      <p>No transactions found</p>
                    </div>
                  </td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
        
        <div class="pagination-container" id="pagination-container">
          ${renderPagination(appState.filters.page, transactions.length, appState.filters.limit || 50)}
        </div>
      </div>
    `;
    
    // Initialize event handlers
    document.getElementById('add-transaction-btn').addEventListener('click', () => {
      showAddTransactionModal();
    });
    
    document.getElementById('toggle-filters-btn').addEventListener('click', toggleFilters);
    document.getElementById('apply-filters-btn').addEventListener('click', applyTransactionFilters);
    document.getElementById('reset-filters-btn').addEventListener('click', resetTransactionFilters);
    document.getElementById('import-transactions-btn').addEventListener('click', showImportTransactionsModal);
    
    // Pagination button handlers
    const paginationButtons = document.querySelectorAll('.pagination-link');
    paginationButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        if (button.classList.contains('disabled')) return;
        
        const page = parseInt(button.dataset.page);
        appState.filters.page = page;
        renderTransactionsPage();
      });
    });
    
    // Transaction management button handlers
    const transactionActionButtons = document.querySelectorAll('[data-transaction-action]');
    transactionActionButtons.forEach(button => {
      button.addEventListener('click', handleTransactionAction);
    });
  }
  
  // Render bank connections page
  async function renderBankConnectionsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Fetch bank connections
    const bankConnections = await fetchBankConnections();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Bank connections</h1>
        <button id="add-connection-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Connect bank
        </button>
      </div>
      
      <div class="bank-connections-container">
        <div class="card bank-info-card">
          <div class="bank-info-content">
            <h2><i class="fas fa-info-circle"></i> Bank Integration</h2>
            <p>Connect your bank accounts for automatic transaction synchronization. Data is protected and processed securely.</p>
            <p>Supported banks: Tinkoff, Sberbank, VTB, Alfa-Bank and others.</p>
          </div>
        </div>
        
        <div id="bank-connections-list" class="card-grid">
          ${bankConnections.length > 0 ? renderBankConnectionsList(bankConnections) : `
            <div class="empty-state">
              <div class="empty-state-icon">
                <i class="fas fa-university"></i>
              </div>
              <h2>No bank connections</h2>
              <p>Connect your bank for automatic data sync</p>
              <button id="empty-add-connection-btn" class="btn btn-primary">
                <i class="fas fa-plus"></i> Connect bank
              </button>
            </div>
          `}
        </div>
      </div>
    `;
    
    // Event handlers
    document.getElementById('add-connection-btn').addEventListener('click', () => {
      showBankConnectionModal();
    });
    
    const emptyAddConnectionBtn = document.getElementById('empty-add-connection-btn');
    if (emptyAddConnectionBtn) {
      emptyAddConnectionBtn.addEventListener('click', () => {
        showBankConnectionModal();
      });
    }
    
    // Connection management button handlers
    const connectionActionButtons = document.querySelectorAll('[data-connection-action]');
    connectionActionButtons.forEach(button => {
      button.addEventListener('click', handleConnectionAction);
    });
  }
  
  // Render settings page
  function renderSettingsPage() {
    const mainContent = document.getElementById('main-content');
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>
      
      <div class="settings-container">
        <div class="card">
          <h2 class="card-title">Personal info</h2>
          
          <form id="profile-form" class="settings-form">
            <div class="form-group">
              <label for="settings-username" class="form-label">Username</label>
              <input type="text" id="settings-username" class="form-control" value="${appState.user.username}" disabled>
            </div>
            
            <div class="form-group">
              <label for="settings-email" class="form-label">Email</label>
              <input type="email" id="settings-email" class="form-control" value="${appState.user.email || ''}">
            </div>
            
            <div class="form-group">
              <label for="settings-fullname" class="form-label">Full name</label>
              <input type="text" id="settings-fullname" class="form-control" value="${appState.user.fullName || ''}">
            </div>
            
            <button type="submit" class="btn btn-primary">Save</button>
          </form>
        </div>
        
        <div class="card">
          <h2 class="card-title">Change password</h2>
          
          <form id="password-form" class="settings-form">
            <div class="form-group">
              <label for="settings-current-password" class="form-label">Current password</label>
              <input type="password" id="settings-current-password" class="form-control" required>
            </div>
            
            <div class="form-group">
              <label for="settings-new-password" class="form-label">New password</label>
              <input type="password" id="settings-new-password" class="form-control" required>
            </div>
            
            <div class="form-group">
              <label for="settings-confirm-password" class="form-label">Confirm password</label>
              <input type="password" id="settings-confirm-password" class="form-control" required>
            </div>
            
            <button type="submit" class="btn btn-primary">Change password</button>
          </form>
        </div>
        
        <div class="card">
          <h2 class="card-title">Import transactions</h2>
          <div class="settings-section">
            <p>Import transactions from a CSV file. Expected columns: <code>date, description, amount, type, category</code></p>
            <div id="import-drop-zone" class="import-drop-zone">
              <i class="fas fa-file-csv" style="font-size:2rem;color:var(--accent);margin-bottom:8px"></i>
              <p>Drag & drop CSV file here, or</p>
              <label class="btn btn-outline" style="cursor:pointer">
                Choose file <input type="file" id="import-file" accept=".csv" style="display:none">
              </label>
              <p id="import-filename" style="margin-top:8px;font-size:13px;color:#888"></p>
            </div>
            <div style="margin-top:10px">
              <select id="import-account" class="form-control" style="max-width:280px;margin-bottom:8px">
                <option value="">— Select account —</option>
                ${appState.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
              </select>
              <button id="import-btn" class="btn btn-primary" disabled><i class="fas fa-upload"></i> Import</button>
              <span id="import-status" style="margin-left:10px;font-size:13px"></span>
            </div>
          </div>
        </div>

        <div class="card">
          <h2 class="card-title">Export data</h2>

          <div class="settings-section">
            <p>Export your financial data to CSV format for use in other applications.</p>
            
            <div class="form-group">
              <label for="export-period" class="form-label">Period</label>
              <select id="export-period" class="form-control">
                <option value="all">All time</option>
                <option value="year">Current year</option>
                <option value="month">Current month</option>
                <option value="custom">Custom period</option>
              </select>
            </div>
            
            <div id="custom-period" class="custom-period hidden">
              <div class="form-group">
                <label for="export-start-date" class="form-label">Start date</label>
                <input type="date" id="export-start-date" class="form-control">
              </div>
              
              <div class="form-group">
                <label for="export-end-date" class="form-label">End date</label>
                <input type="date" id="export-end-date" class="form-control">
              </div>
            </div>
            
            <button id="export-btn" class="btn btn-primary">Export data</button>
          </div>
        </div>
      </div>
    `;
    
    // Event handlers
    document.getElementById('profile-form').addEventListener('submit', handleProfileUpdate);
    document.getElementById('password-form').addEventListener('submit', handlePasswordUpdate);
    document.getElementById('export-btn').addEventListener('click', handleDataExport);

    // CSV Import
    const importFile = document.getElementById('import-file');
    const importBtn = document.getElementById('import-btn');
    const importFilename = document.getElementById('import-filename');
    const importStatus = document.getElementById('import-status');
    const importDropZone = document.getElementById('import-drop-zone');
    let importSelectedFile = null;

    function setImportFile(file) {
      importSelectedFile = file;
      importFilename.textContent = file ? file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)' : '';
      importBtn.disabled = !file;
    }
    importFile?.addEventListener('change', e => setImportFile(e.target.files[0]));
    importDropZone?.addEventListener('dragover', e => { e.preventDefault(); importDropZone.classList.add('drag-over'); });
    importDropZone?.addEventListener('dragleave', () => importDropZone.classList.remove('drag-over'));
    importDropZone?.addEventListener('drop', e => {
      e.preventDefault(); importDropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith('.csv')) setImportFile(file);
    });
    importBtn?.addEventListener('click', async () => {
      if (!importSelectedFile) return;
      const accountId = document.getElementById('import-account').value;
      importBtn.disabled = true;
      importStatus.textContent = 'Importing…';
      importStatus.style.color = '#888';
      try {
        const text = await importSelectedFile.text();
        const r = await fetchWithAuth('/api/transactions/import', {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: text,
        });
        if (!r.ok) throw new Error('Server error ' + r.status);
        const result = await r.json();
        importStatus.textContent = `✓ Imported ${result.imported} transactions`;
        importStatus.style.color = 'var(--success, #38c172)';
        setImportFile(null);
        importFile.value = '';
      } catch (err) {
        importStatus.textContent = '✗ Import failed: ' + err.message;
        importStatus.style.color = 'var(--danger, #e3342f)';
        importBtn.disabled = false;
      }
    });
    
    // Export period change handler
    const exportPeriod = document.getElementById('export-period');
    const customPeriod = document.getElementById('custom-period');
    
    exportPeriod.addEventListener('change', () => {
      if (exportPeriod.value === 'custom') {
        customPeriod.classList.remove('hidden');
      } else {
        customPeriod.classList.add('hidden');
      }
    });
  }
  
  // Log out of system
  function logout() {
    // Clear local storage
    localStorage.removeItem('token');
    
    // Reset app state
    appState.isAuthenticated = false;
    appState.user = null;
    appState.accounts = [];
    appState.transactions = [];
    appState.categories = [];
    appState.bankConnections = [];
    appState.supportedBanks = [];
    
    // Render login page
    renderLoginPage();
  }
  
  // Format currency
  function formatCurrency(amount, currency = 'USD') {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2
    });
    
    return formatter.format(amount);
  }
  
  // Format date
  function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US');
  }
  
  // Get icon for account type
  function getAccountIcon(accountType) {
    switch (accountType) {
      case 'checking':
        return 'fa-wallet';
      case 'savings':
        return 'fa-piggy-bank';
      case 'credit':
        return 'fa-credit-card';
      case 'loan':
        return 'fa-hand-holding-usd';
      default:
        return 'fa-wallet';
    }
  }
  
  // Fetch названия type accounts
  function getAccountTypeName(accountType) {
    switch (accountType) {
      case 'checking':
        return 'Current account';
      case 'savings':
        return 'Savings account';
      case 'credit':
        return 'Credit card';
      case 'loan':
        return 'Credit';
      default:
        return 'Account';
    }
  }
  
  // Отображение notifications
  function showNotification(message, type = 'info') {
    // Create элемента notifications
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <div class="notification-content">
        <span>${message}</span>
      </div>
      <button class="notification-close">&times;</button>
    `;
    
    // Adding notifications на pagesу
    document.body.appendChild(notification);
    
    // Показ notifications с анимацией
    setTimeout(() => {
      notification.classList.add('show');
    }, 10);
    
    // Автоматическое скрытие notifications via 5 секунд
    const timeout = setTimeout(() => {
      hideNotification(notification);
    }, 5000);
    
    // Handler for closedия notifications
    const closeButton = notification.querySelector('.notification-close');
    closeButton.addEventListener('click', () => {
      clearTimeout(timeout);
      hideNotification(notification);
    });
  }
  
  // Скрытие notifications
  function hideNotification(notification) {
    notification.classList.remove('show');
    
    // Delete notifications после завершения анимации
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }
  
  // Initialize application
  window.addEventListener('popstate', () => {
    // Processing навигации по кнопкам браузера
    if (appState.isAuthenticated) {
      const path = window.location.pathname;
      
      if (path.includes('/accounts')) {
        navigateTo('accounts');
      } else if (path.includes('/transactions')) {
        navigateTo('transactions');
      } else if (path.includes('/budgets')) {
        navigateTo('budgets');
      } else if (path.includes('/family')) {
        navigateTo('family');
      } else if (path.includes('/recurring')) {
        navigateTo('recurring');
      } else if (path.includes('/currency')) {
        navigateTo('currency');
      } else if (path.includes('/goals')) {
        navigateTo('goals');
      } else if (path.includes('/debts')) {
        navigateTo('debts');
      } else if (path.includes('/split')) {
        navigateTo('split');
      } else if (path.includes('/investments')) {
        navigateTo('investments');
      } else if (path.includes('/analytics')) {
        navigateTo('analytics');
      } else if (path.includes('/subscriptions')) {
        navigateTo('subscriptions');
      } else if (path.includes('/networth')) {
        navigateTo('networth');
      } else if (path.includes('/receipts')) {
        navigateTo('receipts');
      } else if (path.includes('/calendar')) {
        navigateTo('calendar');
      } else if (path.includes('/reports')) {
        navigateTo('reports');
      } else if (path.includes('/forecast')) {
        navigateTo('forecast');
      } else if (path.includes('/settings')) {
        navigateTo('settings');
      } else if (path.includes('/bank-connections')) {
        navigateTo('bank-connections');
      } else {
        navigateTo('dashboard');
      }
    }
  });

  // Render wrapper functions for new modules
  function renderSubscriptionsPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = SubscriptionsModule.getPage();
    SubscriptionsModule.init();
  }

  function renderNetWorthPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = NetWorthModule.getPage();
    NetWorthModule.init();
    // Auto-save daily snapshot in background (idempotent via the API)
    fetchWithAuth('/api/networth/snapshot', { method: 'POST' }).catch(() => {});
  }

  function renderReceiptsPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = ReceiptsModule.getPage();
    ReceiptsModule.init();
  }

  function renderCalendarPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = CalendarModule.getPage();
    CalendarModule.init();
  }

  function renderReportsPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = ReportsModule.getPage();
    ReportsModule.init();
  }

  function renderForecastPage() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = ForecastModule.getPage();
    ForecastModule.init();
  }