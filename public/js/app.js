// Основной файл приложения
document.addEventListener('DOMContentLoaded', () => {
    // Инициализация приложения
    initApp();
  });
  
  // Глобальное состояние приложения
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
  
  // Инициализация приложения
  async function initApp() {
    // Проверка аутентификации
    const token = localStorage.getItem('token');
    appState.token = token;

    if (token) {
      try {
        // Получение данных пользователя
        await fetchCurrentUser();
        
        // Отрисовка интерфейса для аутентифицированного пользователя
        renderAuthenticatedUI();
        
        // Загрузка основных данных
        Promise.all([
          fetchAccounts(),
          fetchSupportedBanks()
        ]).then(() => {
          // Отображение страницы на основе URL
          const path = window.location.pathname;
          
          if (path.includes('/accounts')) {
            navigateTo('accounts');
          } else if (path.includes('/transactions')) {
            navigateTo('transactions');
          } else if (path.includes('/budgets')) {
            navigateTo('budgets');
          } else if (path.includes('/family')) {
            navigateTo('family');
          } else if (path.includes('/settings')) {
            navigateTo('settings');
          } else if (path.includes('/bank-connections')) {
            navigateTo('bank-connections');
          } else {
            navigateTo('dashboard');
          }
        });
      } catch (error) {
        console.error('Ошибка проверки аутентификации:', error);
        // Если токен невалидный, отображаем страницу входа
        renderLoginPage();
      }
    } else {
      // Если токена нет, отображаем страницу входа
      renderLoginPage();
    }
  }
  
  // Отрисовка интерфейса для аутентифицированного пользователя
  function renderAuthenticatedUI() {
    const app = document.getElementById('app');
    
    app.innerHTML = `
      <header class="header">
        <div class="container header-content">
          <div class="logo">
            <a href="/">Финансовый менеджер</a>
          </div>
          <div class="user-info">
            <span class="user-name">${appState.user.username}</span>
            <button id="logout-btn" class="btn btn-sm btn-outline">Выйти</button>
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
                <i class="fas fa-chart-line"></i> Дашборд
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="accounts">
                <i class="fas fa-wallet"></i> Счета
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="transactions">
                <i class="fas fa-exchange-alt"></i> Транзакции
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="budgets">
                <i class="fas fa-piggy-bank"></i> Бюджеты
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="bank-connections">
                <i class="fas fa-university"></i> Банки
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="family">
                <i class="fas fa-users"></i> Семья
              </a>
            </li>
            <li class="nav-item">
              <a href="#" class="nav-link" data-page="settings">
                <i class="fas fa-cog"></i> Настройки
              </a>
            </li>
          </ul>
        </div>
      </nav>
      
      <main class="main">
        <div class="container" id="main-content">
          <div class="loading">
            <div class="spinner"></div>
            <p>Загрузка...</p>
          </div>
        </div>
      </main>
    `;
    
    // Обработчики событий для навигации
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        navigateTo(page);
      });
    });
    
    // Мобильное меню
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const navList = document.getElementById('nav-list');
    
    mobileMenuToggle.addEventListener('click', () => {
      navList.classList.toggle('open');
    });
    
    // Обработчик выхода из системы
    document.getElementById('logout-btn').addEventListener('click', logout);
  }
  
  // Навигация между страницами
  function navigateTo(page) {
    // Обновление активной страницы
    appState.currentPage = page;
    
    // Обновление активного пункта меню
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
      if (link.dataset.page === page) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
    
    // Обновление URL без перезагрузки страницы
    window.history.pushState({}, '', `/${page}`);
    
    // Отрисовка соответствующей страницы
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p>Загрузка...</p>
      </div>
    `;
    
    // Закрыть мобильное меню при навигации
    const navList = document.getElementById('nav-list');
    navList.classList.remove('open');
    
    // Загрузка страницы
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
      case 'bank-connections':
        renderBankConnectionsPage();
        break;
      case 'settings':
        renderSettingsPage();
        break;
      default:
        renderDashboard();
    }
  }
  
  // HTTP-запрос с авторизацией
  async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('token');
    
    if (!token) {
      throw new Error('Не авторизован');
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
      // Неавторизован, перенаправляем на страницу входа
      localStorage.removeItem('token');
      renderLoginPage();
      throw new Error('Не авторизован');
    }
    
    return response;
  }
  
  // Получение данных текущего пользователя
  async function fetchCurrentUser() {
    try {
      const response = await fetchWithAuth('/api/auth/me');
      
      if (!response.ok) {
        throw new Error('Не удалось получить данные пользователя');
      }
      
      const data = await response.json();
      appState.isAuthenticated = true;
      appState.user = data;
      
      return data;
    } catch (error) {
      console.error('Ошибка получения данных пользователя:', error);
      appState.isAuthenticated = false;
      appState.user = null;
      throw error;
    }
  }
  
  // Получение списка счетов
  async function fetchAccounts() {
    try {
      const response = await fetchWithAuth('/api/accounts');
      
      if (!response.ok) {
        throw new Error('Не удалось получить список счетов');
      }
      
      const data = await response.json();
      appState.accounts = data;
      
      return data;
    } catch (error) {
      console.error('Ошибка получения счетов:', error);
      showNotification('Ошибка получения счетов', 'error');
      return [];
    }
  }
  
  // Получение списка поддерживаемых банков
  async function fetchSupportedBanks() {
    try {
      const response = await fetchWithAuth('/api/bank-api/supported-banks');
      
      if (!response.ok) {
        throw new Error('Не удалось получить список поддерживаемых банков');
      }
      
      const data = await response.json();
      appState.supportedBanks = data;
      
      return data;
    } catch (error) {
      console.error('Ошибка получения списка банков:', error);
      return [];
    }
  }
  
  // Отрисовка страницы входа
  function renderLoginPage() {
    const app = document.getElementById('app');
    
    app.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-header">
            <h1>Финансовый менеджер</h1>
            <p>Управляйте своими финансами просто и эффективно</p>
          </div>
          
          <div class="auth-tabs">
            <button class="auth-tab active" data-tab="login">Вход</button>
            <button class="auth-tab" data-tab="register">Регистрация</button>
          </div>
          
          <div class="auth-form-container">
            <!-- Форма входа -->
            <form id="login-form" class="auth-form">
              <div class="form-group">
                <label for="login-username" class="form-label">Имя пользователя</label>
                <input type="text" id="login-username" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="login-password" class="form-label">Пароль</label>
                <input type="password" id="login-password" class="form-control" required>
              </div>
              
              <div id="login-error" class="auth-error"></div>
              
              <button type="submit" class="btn btn-primary w-100">Войти</button>
            </form>
            
            <!-- Форма регистрации -->
            <form id="register-form" class="auth-form hidden">
              <div class="form-group">
                <label for="register-username" class="form-label">Имя пользователя</label>
                <input type="text" id="register-username" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-email" class="form-label">Email</label>
                <input type="email" id="register-email" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-fullname" class="form-label">Полное имя</label>
                <input type="text" id="register-fullname" class="form-control">
              </div>
              
              <div class="form-group">
                <label for="register-password" class="form-label">Пароль</label>
                <input type="password" id="register-password" class="form-control" required>
              </div>
              
              <div class="form-group">
                <label for="register-confirm-password" class="form-label">Подтверждение пароля</label>
                <input type="password" id="register-confirm-password" class="form-control" required>
              </div>
              
              <div id="register-error" class="auth-error"></div>
              
              <button type="submit" class="btn btn-primary w-100">Зарегистрироваться</button>
            </form>
          </div>
        </div>
      </div>
    `;
    
    // Обработчики переключения между формами
    const authTabs = document.querySelectorAll('.auth-tab');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    
    authTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        // Обновление активного таба
        authTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Отображение соответствующей формы
        if (tabName === 'login') {
          loginForm.classList.remove('hidden');
          registerForm.classList.add('hidden');
        } else {
          loginForm.classList.add('hidden');
          registerForm.classList.remove('hidden');
        }
      });
    });
    
    // Обработчик формы входа
    loginForm.addEventListener('submit', handleLogin);
    
    // Обработчик формы регистрации
    registerForm.addEventListener('submit', handleRegister);
  }
  
  // Обработка входа
  async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorElement = document.getElementById('login-error');
    
    if (!username || !password) {
      errorElement.textContent = 'Пожалуйста, заполните все поля';
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
        errorElement.textContent = data.message || 'Ошибка входа в систему';
        return;
      }
      
      // Сохранение токена
      localStorage.setItem('token', data.token);
      
      // Обновление состояния
      appState.isAuthenticated = true;
      appState.user = data.user;
      
      // Перезагрузка приложения
      initApp();
    } catch (error) {
      console.error('Ошибка входа:', error);
      errorElement.textContent = 'Произошла ошибка при входе в систему';
    }
  }
  
  // Обработка регистрации
  async function handleRegister(e) {
    e.preventDefault();
    
    const username = document.getElementById('register-username').value;
    const email = document.getElementById('register-email').value;
    const fullName = document.getElementById('register-fullname').value;
    const password = document.getElementById('register-password').value;
    const confirmPassword = document.getElementById('register-confirm-password').value;
    const errorElement = document.getElementById('register-error');
    
    if (!username || !email || !password || !confirmPassword) {
      errorElement.textContent = 'Пожалуйста, заполните все обязательные поля';
      return;
    }
    
    if (password !== confirmPassword) {
      errorElement.textContent = 'Пароли не совпадают';
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
        errorElement.textContent = data.message || 'Ошибка регистрации';
        return;
      }
      
      // Сохранение токена
      localStorage.setItem('token', data.token);
      
      // Обновление состояния
      appState.isAuthenticated = true;
      appState.user = data.user;
      
      // Перезагрузка приложения
      initApp();
    } catch (error) {
      console.error('Ошибка регистрации:', error);
      errorElement.textContent = 'Произошла ошибка при регистрации';
    }
  }
  
  // Отрисовка дашборда
  async function renderDashboard() {
    const mainContent = document.getElementById('main-content');
    
    // Получение последних транзакций
    const recentTransactions = await fetchTransactions({ limit: 5 });
    
    // Получение статистики
    const statsData = await fetchTransactionStats();
    
    // Формирование списка счетов
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
    `).join('') || '<p>У вас еще нет счетов. <a href="#" class="add-account-link">Добавить счет</a></p>';
    
    // Формирование списка последних транзакций
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
      : '<p>У вас еще нет транзакций. <a href="#" class="add-transaction-link">Добавить транзакцию</a></p>';
    
    mainContent.innerHTML = `
      <h1 class="page-title">Обзор финансов</h1>
      
      <div class="dashboard-summary">
        <div class="summary-card income">
          <div class="summary-icon">
            <i class="fas fa-arrow-down"></i>
          </div>
          <div class="summary-data">
            <h3>Доходы за месяц</h3>
            <div class="summary-amount">${formatCurrency(statsData.monthlyIncome || 0)}</div>
          </div>
        </div>
        
        <div class="summary-card expense">
          <div class="summary-icon">
            <i class="fas fa-arrow-up"></i>
          </div>
          <div class="summary-data">
            <h3>Расходы за месяц</h3>
            <div class="summary-amount">${formatCurrency(statsData.monthlyExpense || 0)}</div>
          </div>
        </div>
        
        <div class="summary-card balance">
          <div class="summary-icon">
            <i class="fas fa-wallet"></i>
          </div>
          <div class="summary-data">
            <h3>Общий баланс</h3>
            <div class="summary-amount">${formatCurrency(statsData.totalBalance || 0)}</div>
          </div>
        </div>
      </div>
      
      <div class="dashboard-content">
        <div class="dashboard-section">
          <div class="section-header">
            <h2>Ваши счета</h2>
            <button id="add-account-btn" class="btn btn-sm btn-primary">
              <i class="fas fa-plus"></i> Добавить счет
            </button>
          </div>
          
          <div class="accounts-list">
            ${accountsHtml}
          </div>
        </div>
        
        <div class="dashboard-section">
          <div class="section-header">
            <h2>Последние транзакции</h2>
            <button id="add-transaction-btn" class="btn btn-sm btn-primary">
              <i class="fas fa-plus"></i> Добавить транзакцию
            </button>
          </div>
          
          <div class="transactions-list">
            ${transactionsHtml}
          </div>
          
          <div class="section-footer">
            <a href="#" class="btn btn-sm btn-outline" id="view-all-transactions">
              Посмотреть все транзакции
            </a>
          </div>
        </div>
      </div>
      
      <div class="dashboard-charts">
        <div class="chart-container">
          <h2>Динамика доходов и расходов</h2>
          <canvas id="income-expense-chart"></canvas>
        </div>
        
        <div class="chart-container">
          <h2>Расходы по категориям</h2>
          <canvas id="expense-categories-chart"></canvas>
        </div>
      </div>
    `;
    
    // Инициализация графиков
    initCharts(statsData);
    
    // Обработчики событий
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
  
  // Отрисовка страницы счетов
  async function renderAccountsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Повторное получение счетов для актуальности данных
    await fetchAccounts();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Счета</h1>
        <button id="add-account-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Добавить счет
        </button>
      </div>
      
      <div class="accounts-container">
        <div id="accounts-list" class="card-grid">
          ${appState.accounts.length > 0 ? renderAccountsList(appState.accounts) : `
            <div class="empty-state">
              <div class="empty-state-icon">
                <i class="fas fa-wallet"></i>
              </div>
              <h2>У вас пока нет счетов</h2>
              <p>Добавьте свой первый счет, чтобы начать отслеживать финансы</p>
              <button id="empty-add-account-btn" class="btn btn-primary">
                <i class="fas fa-plus"></i> Добавить счет
              </button>
            </div>
          `}
        </div>
      </div>
    `;
    
    // Обработчики событий
    document.getElementById('add-account-btn').addEventListener('click', () => {
      showAddAccountModal();
    });
    
    const emptyAddAccountBtn = document.getElementById('empty-add-account-btn');
    if (emptyAddAccountBtn) {
      emptyAddAccountBtn.addEventListener('click', () => {
        showAddAccountModal();
      });
    }
    
    // Обработчики для кнопок управления счетами
    const accountActionButtons = document.querySelectorAll('[data-account-action]');
    accountActionButtons.forEach(button => {
      button.addEventListener('click', handleAccountAction);
    });
  }
  
  // Рендеринг списка счетов
  function renderAccountsList(accounts) {
    return accounts.map(account => `
      <div class="account-card card" data-account-id="${account.id}">
        <div class="account-header">
          <div class="account-icon">
            <i class="fas ${getAccountIcon(account.account_type)}"></i>
          </div>
          <div class="account-details">
            <h3 class="account-name">${account.name}</h3>
            <p class="account-number">${account.account_number || 'Без номера'}</p>
          </div>
        </div>
        
        <div class="account-balance">
          ${formatCurrency(account.balance, account.currency)}
        </div>
        
        <div class="account-info">
          <p class="account-bank">${account.bank_name || 'Личный счет'}</p>
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
            <i class="fas fa-trash"></i> Удалить
          </button>
        </div>
      </div>
    `).join('');
  }
  
  // Отрисовка страницы транзакций
  async function renderTransactionsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Получение транзакций с учетом фильтров
    const transactions = await fetchTransactions(appState.filters);
    
    // Получение категорий для фильтра
    const categories = await fetchCategories();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Транзакции</h1>
        <button id="add-transaction-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Добавить транзакцию
        </button>
      </div>
      
      <div class="filters-container card">
        <div class="filters-header">
          <h2>Фильтры</h2>
          <button id="toggle-filters-btn" class="btn btn-sm btn-outline">
            <i class="fas fa-filter"></i> Показать фильтры
          </button>
        </div>
        
        <div id="filters-form" class="filters-form hidden">
          <div class="filters-row">
            <div class="form-group">
              <label for="filter-date-start" class="form-label">Начальная дата</label>
              <input type="date" id="filter-date-start" class="form-control" value="${appState.filters.startDate || ''}">
            </div>
            
            <div class="form-group">
              <label for="filter-date-end" class="form-label">Конечная дата</label>
              <input type="date" id="filter-date-end" class="form-control" value="${appState.filters.endDate || ''}">
            </div>
            
            <div class="form-group">
              <label for="filter-account" class="form-label">Счет</label>
              <select id="filter-account" class="form-control">
                <option value="">Все счета</option>
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
              <label for="filter-category" class="form-label">Категория</label>
              <select id="filter-category" class="form-control">
                <option value="">Все категории</option>
                ${categories.map(category => `
                  <option value="${category}" ${appState.filters.category === category ? 'selected' : ''}>
                    ${category}
                  </option>
                `).join('')}
              </select>
            </div>
            
            <div class="form-group">
              <label for="filter-type" class="form-label">Тип</label>
              <select id="filter-type" class="form-control">
                <option value="">Все типы</option>
                <option value="income" ${appState.filters.type === 'income' ? 'selected' : ''}>Доходы</option>
                <option value="expense" ${appState.filters.type === 'expense' ? 'selected' : ''}>Расходы</option>
              </select>
            </div>
            
            <div class="form-group">
              <label for="filter-search" class="form-label">Поиск</label>
              <input type="text" id="filter-search" class="form-control" placeholder="Поиск по описанию" value="${appState.filters.search || ''}">
            </div>
          </div>
          
          <div class="filters-actions">
            <button id="apply-filters-btn" class="btn btn-primary">Применить</button>
            <button id="reset-filters-btn" class="btn btn-outline">Сбросить</button>
          </div>
        </div>
      </div>
      
      <div class="transactions-container card">
        <div class="transactions-header">
          <div class="transactions-summary">
            <span>Найдено транзакций: <strong id="transactions-count">${transactions.length}</strong></span>
          </div>
          <div class="transactions-actions">
            <button id="import-transactions-btn" class="btn btn-sm btn-outline">
              <i class="fas fa-file-import"></i> Импорт из CSV
            </button>
          </div>
        </div>
        
        <div class="table-container">
          <table class="table transactions-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Описание</th>
                <th>Категория</th>
                <th>Счет</th>
                <th class="text-right">Сумма</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody id="transactions-list">
              ${transactions.length > 0 ? renderTransactionsList(transactions) : `
                <tr>
                  <td colspan="6" class="text-center">
                    <div class="empty-state-mini">
                      <p>Транзакции не найдены</p>
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
    
    // Инициализация обработчиков событий
    document.getElementById('add-transaction-btn').addEventListener('click', () => {
      showAddTransactionModal();
    });
    
    document.getElementById('toggle-filters-btn').addEventListener('click', toggleFilters);
    document.getElementById('apply-filters-btn').addEventListener('click', applyTransactionFilters);
    document.getElementById('reset-filters-btn').addEventListener('click', resetTransactionFilters);
    document.getElementById('import-transactions-btn').addEventListener('click', showImportTransactionsModal);
    
    // Обработчики для кнопок пагинации
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
    
    // Обработчики для кнопок управления транзакциями
    const transactionActionButtons = document.querySelectorAll('[data-transaction-action]');
    transactionActionButtons.forEach(button => {
      button.addEventListener('click', handleTransactionAction);
    });
  }
  
  // Отрисовка страницы банковских подключений
  async function renderBankConnectionsPage() {
    const mainContent = document.getElementById('main-content');
    
    // Получение банковских подключений
    const bankConnections = await fetchBankConnections();
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Банковские подключения</h1>
        <button id="add-connection-btn" class="btn btn-primary">
          <i class="fas fa-plus"></i> Подключить банк
        </button>
      </div>
      
      <div class="bank-connections-container">
        <div class="card bank-info-card">
          <div class="bank-info-content">
            <h2><i class="fas fa-info-circle"></i> Интеграция с банками</h2>
            <p>Подключите ваши банковские счета для автоматической синхронизации транзакций и счетов. Данные защищены и обрабатываются безопасно.</p>
            <p>Поддерживаемые банки: Тинькофф, Сбербанк, ВТБ, Альфа-Банк и другие.</p>
          </div>
        </div>
        
        <div id="bank-connections-list" class="card-grid">
          ${bankConnections.length > 0 ? renderBankConnectionsList(bankConnections) : `
            <div class="empty-state">
              <div class="empty-state-icon">
                <i class="fas fa-university"></i>
              </div>
              <h2>Нет подключений к банкам</h2>
              <p>Подключите свой банк для автоматической синхронизации данных</p>
              <button id="empty-add-connection-btn" class="btn btn-primary">
                <i class="fas fa-plus"></i> Подключить банк
              </button>
            </div>
          `}
        </div>
      </div>
    `;
    
    // Обработчики событий
    document.getElementById('add-connection-btn').addEventListener('click', () => {
      showBankConnectionModal();
    });
    
    const emptyAddConnectionBtn = document.getElementById('empty-add-connection-btn');
    if (emptyAddConnectionBtn) {
      emptyAddConnectionBtn.addEventListener('click', () => {
        showBankConnectionModal();
      });
    }
    
    // Обработчики для кнопок управления подключениями
    const connectionActionButtons = document.querySelectorAll('[data-connection-action]');
    connectionActionButtons.forEach(button => {
      button.addEventListener('click', handleConnectionAction);
    });
  }
  
  // Отрисовка страницы настроек
  function renderSettingsPage() {
    const mainContent = document.getElementById('main-content');
    
    mainContent.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Настройки</h1>
      </div>
      
      <div class="settings-container">
        <div class="card">
          <h2 class="card-title">Личные данные</h2>
          
          <form id="profile-form" class="settings-form">
            <div class="form-group">
              <label for="settings-username" class="form-label">Имя пользователя</label>
              <input type="text" id="settings-username" class="form-control" value="${appState.user.username}" disabled>
            </div>
            
            <div class="form-group">
              <label for="settings-email" class="form-label">Email</label>
              <input type="email" id="settings-email" class="form-control" value="${appState.user.email || ''}">
            </div>
            
            <div class="form-group">
              <label for="settings-fullname" class="form-label">Полное имя</label>
              <input type="text" id="settings-fullname" class="form-control" value="${appState.user.fullName || ''}">
            </div>
            
            <button type="submit" class="btn btn-primary">Сохранить</button>
          </form>
        </div>
        
        <div class="card">
          <h2 class="card-title">Изменение пароля</h2>
          
          <form id="password-form" class="settings-form">
            <div class="form-group">
              <label for="settings-current-password" class="form-label">Текущий пароль</label>
              <input type="password" id="settings-current-password" class="form-control" required>
            </div>
            
            <div class="form-group">
              <label for="settings-new-password" class="form-label">Новый пароль</label>
              <input type="password" id="settings-new-password" class="form-control" required>
            </div>
            
            <div class="form-group">
              <label for="settings-confirm-password" class="form-label">Подтверждение пароля</label>
              <input type="password" id="settings-confirm-password" class="form-control" required>
            </div>
            
            <button type="submit" class="btn btn-primary">Изменить пароль</button>
          </form>
        </div>
        
        <div class="card">
          <h2 class="card-title">Экспорт данных</h2>
          
          <div class="settings-section">
            <p>Экспортируйте ваши финансовые данные в CSV-формат для использования в других приложениях.</p>
            
            <div class="form-group">
              <label for="export-period" class="form-label">Период</label>
              <select id="export-period" class="form-control">
                <option value="all">Все время</option>
                <option value="year">Текущий год</option>
                <option value="month">Текущий месяц</option>
                <option value="custom">Указать период</option>
              </select>
            </div>
            
            <div id="custom-period" class="custom-period hidden">
              <div class="form-group">
                <label for="export-start-date" class="form-label">Начальная дата</label>
                <input type="date" id="export-start-date" class="form-control">
              </div>
              
              <div class="form-group">
                <label for="export-end-date" class="form-label">Конечная дата</label>
                <input type="date" id="export-end-date" class="form-control">
              </div>
            </div>
            
            <button id="export-btn" class="btn btn-primary">Экспортировать данные</button>
          </div>
        </div>
      </div>
    `;
    
    // Обработчики событий
    document.getElementById('profile-form').addEventListener('submit', handleProfileUpdate);
    document.getElementById('password-form').addEventListener('submit', handlePasswordUpdate);
    document.getElementById('export-btn').addEventListener('click', handleDataExport);
    
    // Обработчик изменения периода экспорта
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
  
  // Выход из системы
  function logout() {
    // Очистка локального хранилища
    localStorage.removeItem('token');
    
    // Сброс состояния приложения
    appState.isAuthenticated = false;
    appState.user = null;
    appState.accounts = [];
    appState.transactions = [];
    appState.categories = [];
    appState.bankConnections = [];
    appState.supportedBanks = [];
    
    // Отрисовка страницы входа
    renderLoginPage();
  }
  
  // Форматирование валюты
  function formatCurrency(amount, currency = 'RUB') {
    const formatter = new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2
    });
    
    return formatter.format(amount);
  }
  
  // Форматирование даты
  function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('ru-RU');
  }
  
  // Получение иконки для типа счета
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
  
  // Получение названия типа счета
  function getAccountTypeName(accountType) {
    switch (accountType) {
      case 'checking':
        return 'Текущий счет';
      case 'savings':
        return 'Сберегательный счет';
      case 'credit':
        return 'Кредитная карта';
      case 'loan':
        return 'Кредит';
      default:
        return 'Счет';
    }
  }
  
  // Отображение уведомления
  function showNotification(message, type = 'info') {
    // Создание элемента уведомления
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <div class="notification-content">
        <span>${message}</span>
      </div>
      <button class="notification-close">&times;</button>
    `;
    
    // Добавление уведомления на страницу
    document.body.appendChild(notification);
    
    // Показ уведомления с анимацией
    setTimeout(() => {
      notification.classList.add('show');
    }, 10);
    
    // Автоматическое скрытие уведомления через 5 секунд
    const timeout = setTimeout(() => {
      hideNotification(notification);
    }, 5000);
    
    // Обработчик закрытия уведомления
    const closeButton = notification.querySelector('.notification-close');
    closeButton.addEventListener('click', () => {
      clearTimeout(timeout);
      hideNotification(notification);
    });
  }
  
  // Скрытие уведомления
  function hideNotification(notification) {
    notification.classList.remove('show');
    
    // Удаление уведомления после завершения анимации
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }
  
  // Инициализация приложения
  window.addEventListener('popstate', () => {
    // Обработка навигации по кнопкам браузера
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
      } else if (path.includes('/settings')) {
        navigateTo('settings');
      } else if (path.includes('/bank-connections')) {
        navigateTo('bank-connections');
      } else {
        navigateTo('dashboard');
      }
    }
  });