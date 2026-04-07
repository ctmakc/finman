// Main application file
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
    
    app.innerHTML = `
      <header class="header">
        <div class="container header-content">
          <div class="logo">
            <a href="/">Finance Manager</a>
          </div>
          <div class="user-info">
            <span class="user-name">${appState.user.username}</span>
            <button id="logout-btn" class="btn btn-sm btn-outline">Log out</button>
          </div>
        </div>
      </header>
      
      <nav class="navigation">
        <div class="container nav-container">
          <button class="mobile-menu-toggle" id="mobile-menu-toggle">
            <i class="fas fa-bars"></i>
          </button>
          <ul class="nav-list" id="nav-list">
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="dashboard">
                <i class="fas fa-chart-line"></i> Dashboard
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="accounts">
                <i class="fas fa-wallet"></i> Accounts
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="transactions">
                <i class="fas fa-exchange-alt"></i> Transactions
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="budgets">
                <i class="fas fa-piggy-bank"></i> Budgets
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="bank-connections">
                <i class="fas fa-university"></i> Banks
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="family">
                <i class="fas fa-users"></i> Family
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="recurring">
                <i class="fas fa-sync-alt"></i> Payments
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="currency">
                <i class="fas fa-coins"></i> Currencies
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="goals">
                <i class="fas fa-bullseye"></i> Goals
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="debts">
                <i class="fas fa-hand-holding-usd"></i> Debts
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="split">
                <i class="fas fa-user-friends"></i> Split
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="investments">
                <i class="fas fa-chart-line"></i> Investments
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="analytics">
                <i class="fas fa-chart-bar"></i> Analytics
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="subscriptions">
                <i class="fas fa-box"></i> Subscriptions
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="networth">
                <i class="fas fa-gem"></i> Net Worth
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="receipts">
                <i class="fas fa-receipt"></i> Receipts
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="calendar">
                <i class="fas fa-calendar"></i> Calendar
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="reports">
                <i class="fas fa-file-alt"></i> Reports
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="forecast">
                <i class="fas fa-crystal-ball"></i> Forecast
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="settings">
                <i class="fas fa-cog"></i> Settings
              </a>
            </li>
          </ul>
        </div>
      </nav>
      
      <main class="main">
        <div class="container" id="main-content">
          <div class="loading">
            <div class="spinner"></div>
            <p>Loading...</p>
          </div>
        </div>
      </main>
    `;
    
    // Navigation event handlers
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        navigateTo(page);
      });
    });
    
    // Mobile menu
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const navList = document.getElementById('nav-list');
    
    mobileMenuToggle.addEventListener('click', () => {
      navList.classList.toggle('open');
    });
    
    // Log out handler
    document.getElementById('logout-btn').addEventListener('click', logout);
  }
  
  // Навигация between pagess
  function navigateTo(page) {
    // Update active pagesы
    appState.currentPage = page;
    
    // Update active пункта меню
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      if (link.dataset.page === page) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
    
    // Update URL без перезагрузки pagesы
    window.history.pushState({}, '', `/${page}`);
    
    // Отрисовка соответствующей pagesы
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p>Loading...</p>
      </div>
    `;
    
    // Close mobile menu on navigation
    const navList = document.getElementById('nav-list');
    navList.classList.remove('open');
    
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
      appState.accounts = data;
      
      return data;
    } catch (error) {
      console.error('Error fetching accounts:', error);
      showNotification('Error fetching accounts', 'error');
      return [];
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
            <h1>Finance Manager</h1>
            <p>Manage your finances simply and effectively</p>
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
    
    // Fetch последних transactions
    const recentTransactions = await fetchTransactions({ limit: 5 });
    
    // Fetch statistics
    const statsData = await fetchTransactionStats();
    
    // Build list accounts
    const accountsHtml = appState.accounts.map(account => `
      <div class="account-summary">
        <div class="account-info">
          <div class="account-icon">
            <i class="fas fa-wallet"></i>
          </div>
          <div class="account-details">
            <h3 class="account-name">${account.name}</h3>
            <p class="account-number">${account.account_number || ''}</p>
          </div>
        </div>
        <div class="account-balance">${formatCurrency(account.balance, account.currency)}</div>
      </div>
    `).join('') || '<p>У вас еще нет accounts. <a href="#" class="add-account-link">Add account</a></p>';
    
    // Build list последних transactions
    const transactionsHtml = recentTransactions.length > 0 
      ? recentTransactions.map(transaction => `
        <div class="transaction-item">
          <div class="transaction-info">
            <div class="transaction-date">${formatDate(transaction.date)}</div>
            <div class="transaction-description">${transaction.description}</div>
            <div class="transaction-category">${transaction.category}</div>
          </div>
          <div class="transaction-amount ${transaction.type === 'income' ? 'income' : 'expense'}">
            ${formatCurrency(transaction.amount)}
          </div>
        </div>
      `).join('')
      : '<p>У вас еще no transactions. <a href="#" class="add-transaction-link">Add transaction</a></p>';
    
    mainContent.innerHTML = `
      <h1 class="page-title">Finance Overview</h1>
      
      <div class="dashboard-summary">
        <div class="summary-card income">
          <div class="summary-icon">
            <i class="fas fa-arrow-down"></i>
          </div>
          <div class="summary-data">
            <h3>Income per month</h3>
            <div class="summary-amount">${formatCurrency(statsData.monthlyIncome || 0)}</div>
          </div>
        </div>
        
        <div class="summary-card expense">
          <div class="summary-icon">
            <i class="fas fa-arrow-up"></i>
          </div>
          <div class="summary-data">
            <h3>Expenses per month</h3>
            <div class="summary-amount">${formatCurrency(statsData.monthlyExpense || 0)}</div>
          </div>
        </div>
        
        <div class="summary-card balance">
          <div class="summary-icon">
            <i class="fas fa-wallet"></i>
          </div>
          <div class="summary-data">
            <h3>Total balance</h3>
            <div class="summary-amount">${formatCurrency(statsData.totalBalance || 0)}</div>
          </div>
        </div>
      </div>
      
      <div class="dashboard-content">
        <div class="dashboard-section">
          <div class="section-header">
            <h2>Your accounts</h2>
            <button id="add-account-btn" class="btn btn-sm btn-primary">
              <i class="fas fa-plus"></i> Add account
            </button>
          </div>
          
          <div class="accounts-list">
            ${accountsHtml}
          </div>
        </div>
        
        <div class="dashboard-section">
          <div class="section-header">
            <h2>Recent transactions</h2>
            <button id="add-transaction-btn" class="btn btn-sm btn-primary">
              <i class="fas fa-plus"></i> Add transaction
            </button>
          </div>
          
          <div class="transactions-list">
            ${transactionsHtml}
          </div>
          
          <div class="section-footer">
            <a href="#" class="btn btn-sm btn-outline" id="view-all-transactions">
              Посмотреть all transactions
            </a>
          </div>
        </div>
      </div>
      
      <div class="dashboard-charts">
        <div class="chart-container">
          <h2>Income and expenses trend</h2>
          <canvas id="income-expense-chart"></canvas>
        </div>
        
        <div class="chart-container">
          <h2>Expenses by category</h2>
          <canvas id="expense-categories-chart"></canvas>
        </div>
      </div>
    `;
    
    // Initialize графиков
    initCharts(statsData);
    
    // Event handlers
    document.getElementById('add-account-btn').addEventListener('click', () => {
      showAddAccountModal();
    });
    
    document.getElementById('add-transaction-btn').addEventListener('click', () => {
      showAddTransactionModal();
    });
    
    document.getElementById('view-all-transactions').addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo('transactions');
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
              <p>Добавьте свой первый account, to начать отслеживать финансы</p>
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
            <i class="fas fa-eye"></i> Детали
          </button>
          <button class="btn btn-sm btn-outline" data-account-action="edit" data-account-id="${account.id}">
            <i class="fas fa-edit"></i> Изменить
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
          ${renderPagination(appState.filters.page)}
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