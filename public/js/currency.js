// ==================== МУЛЬТИВАЛЮТА И ТЕГИ ====================

// Состояние модуля
const currencyState = {
  settings: null,
  rates: {},
  tags: [],
  supportedCurrencies: []
};

// Инициализация
async function initCurrencyModule() {
  try {
    const [settings, currencies] = await Promise.all([
      fetchCurrencySettings(),
      fetchSupportedCurrencies()
    ]);
    currencyState.settings = settings;
    currencyState.supportedCurrencies = currencies;
  } catch (error) {
    console.error('Ошибка инициализации модуля валют:', error);
  }
}

// ==================== API ФУНКЦИИ ====================

async function fetchCurrencySettings() {
  const response = await fetchWithAuth('/api/currency/settings');
  if (!response.ok) throw new Error('Ошибка получения настроек');
  return response.json();
}

async function fetchSupportedCurrencies() {
  const response = await fetchWithAuth('/api/currency/supported');
  if (!response.ok) throw new Error('Ошибка получения валют');
  return response.json();
}

async function fetchCurrencyRates(base) {
  const url = base ? `/api/currency/rates?base=${base}` : '/api/currency/rates';
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Ошибка получения курсов');
  return response.json();
}

async function updateCurrencySettings(settings) {
  const response = await fetchWithAuth('/api/currency/settings', {
    method: 'PUT',
    body: JSON.stringify(settings)
  });
  if (!response.ok) throw new Error('Ошибка обновления настроек');
  return response.json();
}

async function convertCurrency(amount, from, to) {
  const response = await fetchWithAuth(`/api/currency/convert?amount=${amount}&from=${from}&to=${to}`);
  if (!response.ok) throw new Error('Ошибка конвертации');
  return response.json();
}

async function fetchRatesFromNBU() {
  const response = await fetchWithAuth('/api/currency/fetch-nbu', { method: 'POST' });
  if (!response.ok) throw new Error('Ошибка обновления курсов');
  return response.json();
}

// ==================== ТЕГИ API ====================

async function fetchTags() {
  const response = await fetchWithAuth('/api/currency/tags');
  if (!response.ok) throw new Error('Ошибка получения тегов');
  const tags = await response.json();
  currencyState.tags = tags;
  return tags;
}

async function createTag(name, color) {
  const response = await fetchWithAuth('/api/currency/tags', {
    method: 'POST',
    body: JSON.stringify({ name, color })
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || 'Ошибка создания тега');
  }
  return response.json();
}

async function updateTag(id, data) {
  const response = await fetchWithAuth(`/api/currency/tags/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
  if (!response.ok) throw new Error('Ошибка обновления тега');
  return response.json();
}

async function deleteTag(id) {
  const response = await fetchWithAuth(`/api/currency/tags/${id}`, {
    method: 'DELETE'
  });
  if (!response.ok) throw new Error('Ошибка удаления тега');
  return response.json();
}

async function getTagStats(id) {
  const response = await fetchWithAuth(`/api/currency/tags/${id}/stats`);
  if (!response.ok) throw new Error('Ошибка получения статистики');
  return response.json();
}

async function setTransactionTags(transactionId, tagIds) {
  const response = await fetchWithAuth(`/api/currency/transaction/${transactionId}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tagIds })
  });
  if (!response.ok) throw new Error('Ошибка установки тегов');
  return response.json();
}

async function getTransactionTags(transactionId) {
  const response = await fetchWithAuth(`/api/currency/transaction/${transactionId}/tags`);
  if (!response.ok) throw new Error('Ошибка получения тегов');
  return response.json();
}

// ==================== СТРАНИЦА ВАЛЮТ И ТЕГОВ ====================

async function renderCurrencyPage() {
  const mainContent = document.getElementById('main-content');

  mainContent.innerHTML = `
    <div class="currency-page">
      <div class="page-header">
        <h1><i class="fas fa-coins"></i> Валюты и теги</h1>
      </div>

      <div class="currency-tabs">
        <button class="tab-btn active" data-tab="converter">
          <i class="fas fa-exchange-alt"></i> Конвертер
        </button>
        <button class="tab-btn" data-tab="rates">
          <i class="fas fa-chart-line"></i> Курсы
        </button>
        <button class="tab-btn" data-tab="settings">
          <i class="fas fa-cog"></i> Настройки
        </button>
        <button class="tab-btn" data-tab="tags">
          <i class="fas fa-tags"></i> Теги
        </button>
      </div>

      <div class="tab-content" id="currency-tab-content">
        <div class="loading">
          <div class="spinner"></div>
          <p>Загрузка...</p>
        </div>
      </div>
    </div>
  `;

  // Обработчики табов
  const tabBtns = document.querySelectorAll('.currency-tabs .tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      switch(tab) {
        case 'converter': renderConverterTab(); break;
        case 'rates': renderRatesTab(); break;
        case 'settings': renderCurrencySettingsTab(); break;
        case 'tags': renderTagsTab(); break;
      }
    });
  });

  // Загружаем данные и показываем первый таб
  await initCurrencyModule();
  renderConverterTab();
}

// ==================== ТАБ КОНВЕРТЕРА ====================

async function renderConverterTab() {
  const container = document.getElementById('currency-tab-content');
  const currencies = currencyState.supportedCurrencies;

  container.innerHTML = `
    <div class="converter-section">
      <div class="card">
        <h2><i class="fas fa-calculator"></i> Конвертер валют</h2>

        <div class="converter-form">
          <div class="converter-row">
            <div class="form-group">
              <label class="form-label">Сумма</label>
              <input type="number" id="convert-amount" class="form-control" value="100" min="0" step="0.01">
            </div>
          </div>

          <div class="converter-row">
            <div class="form-group">
              <label class="form-label">Из</label>
              <select id="convert-from" class="form-control">
                ${currencies.map(c => `
                  <option value="${c.code}" ${c.code === 'USD' ? 'selected' : ''}>
                    ${c.symbol} ${c.code} - ${c.name}
                  </option>
                `).join('')}
              </select>
            </div>

            <button type="button" id="swap-currencies" class="btn btn-outline btn-icon">
              <i class="fas fa-exchange-alt"></i>
            </button>

            <div class="form-group">
              <label class="form-label">В</label>
              <select id="convert-to" class="form-control">
                ${currencies.map(c => `
                  <option value="${c.code}" ${c.code === 'UAH' ? 'selected' : ''}>
                    ${c.symbol} ${c.code} - ${c.name}
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <button type="button" id="convert-btn" class="btn btn-primary w-100">
            <i class="fas fa-sync"></i> Конвертировать
          </button>
        </div>

        <div id="convert-result" class="convert-result hidden">
          <div class="result-amount">
            <span id="result-value">0.00</span>
            <span id="result-currency">UAH</span>
          </div>
          <div class="result-rate" id="result-rate">
            Курс: 1 USD = 0.00 UAH
          </div>
        </div>
      </div>

      <div class="card quick-convert">
        <h3>Быстрый расчет</h3>
        <div class="quick-amounts" id="quick-amounts">
          <!-- Заполняется динамически -->
        </div>
      </div>
    </div>
  `;

  // Обработчики
  document.getElementById('convert-btn').addEventListener('click', performConversion);
  document.getElementById('convert-amount').addEventListener('input', debounce(performConversion, 300));
  document.getElementById('convert-from').addEventListener('change', performConversion);
  document.getElementById('convert-to').addEventListener('change', performConversion);

  document.getElementById('swap-currencies').addEventListener('click', () => {
    const from = document.getElementById('convert-from');
    const to = document.getElementById('convert-to');
    const temp = from.value;
    from.value = to.value;
    to.value = temp;
    performConversion();
  });

  // Первая конвертация
  performConversion();
}

async function performConversion() {
  const amount = parseFloat(document.getElementById('convert-amount').value) || 0;
  const from = document.getElementById('convert-from').value;
  const to = document.getElementById('convert-to').value;

  try {
    const result = await convertCurrency(amount, from, to);

    const resultDiv = document.getElementById('convert-result');
    resultDiv.classList.remove('hidden');

    document.getElementById('result-value').textContent = result.result.toFixed(2);
    document.getElementById('result-currency').textContent = to;
    document.getElementById('result-rate').textContent = `Курс: 1 ${from} = ${result.rate.toFixed(4)} ${to}`;

    // Быстрый расчет
    const quickAmounts = [10, 50, 100, 500, 1000, 5000];
    const quickContainer = document.getElementById('quick-amounts');
    quickContainer.innerHTML = quickAmounts.map(amt => `
      <div class="quick-item">
        <span class="quick-from">${amt} ${from}</span>
        <span class="quick-arrow"><i class="fas fa-arrow-right"></i></span>
        <span class="quick-to">${(amt * result.rate).toFixed(2)} ${to}</span>
      </div>
    `).join('');

  } catch (error) {
    showNotification('Ошибка конвертации: ' + error.message, 'error');
  }
}

// ==================== ТАБ КУРСОВ ====================

async function renderRatesTab() {
  const container = document.getElementById('currency-tab-content');
  const settings = currencyState.settings || { base_currency: 'UAH' };

  container.innerHTML = `
    <div class="rates-section">
      <div class="card">
        <div class="rates-header">
          <h2><i class="fas fa-chart-line"></i> Текущие курсы</h2>
          <div class="rates-actions">
            <select id="rates-base" class="form-control">
              ${currencyState.supportedCurrencies.map(c => `
                <option value="${c.code}" ${c.code === settings.base_currency ? 'selected' : ''}>
                  ${c.code}
                </option>
              `).join('')}
            </select>
            <button id="refresh-rates" class="btn btn-outline">
              <i class="fas fa-sync"></i> Обновить с НБУ
            </button>
          </div>
        </div>

        <div id="rates-list" class="rates-list">
          <div class="loading">
            <div class="spinner"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('rates-base').addEventListener('change', loadRates);
  document.getElementById('refresh-rates').addEventListener('click', async () => {
    try {
      const result = await fetchRatesFromNBU();
      showNotification(`Обновлено ${result.count} курсов`, 'success');
      loadRates();
    } catch (error) {
      showNotification('Ошибка обновления курсов', 'error');
    }
  });

  loadRates();
}

async function loadRates() {
  const base = document.getElementById('rates-base').value;
  const container = document.getElementById('rates-list');

  try {
    const data = await fetchCurrencyRates(base);
    currencyState.rates = data.rates;

    const currencies = currencyState.supportedCurrencies;

    container.innerHTML = `
      <div class="rates-grid">
        ${currencies.filter(c => c.code !== base).map(c => {
          const rate = data.rates[c.code];
          return `
            <div class="rate-card">
              <div class="rate-currency">
                <span class="rate-symbol">${c.symbol}</span>
                <span class="rate-code">${c.code}</span>
              </div>
              <div class="rate-value">
                ${rate ? rate.toFixed(4) : 'Нет данных'}
              </div>
              <div class="rate-name">${c.name}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (error) {
    container.innerHTML = `
      <div class="empty-text">
        <i class="fas fa-exclamation-circle"></i>
        <p>Ошибка загрузки курсов</p>
      </div>
    `;
  }
}

// ==================== ТАБ НАСТРОЕК ====================

async function renderCurrencySettingsTab() {
  const container = document.getElementById('currency-tab-content');
  const settings = currencyState.settings || {
    base_currency: 'UAH',
    display_currencies: ['UAH', 'USD', 'EUR'],
    auto_convert: false
  };

  // Парсим display_currencies если это строка
  let displayCurrencies = settings.display_currencies;
  if (typeof displayCurrencies === 'string') {
    try {
      displayCurrencies = JSON.parse(displayCurrencies);
    } catch {
      displayCurrencies = ['UAH', 'USD', 'EUR'];
    }
  }

  container.innerHTML = `
    <div class="settings-section">
      <div class="card">
        <h2><i class="fas fa-cog"></i> Настройки валют</h2>

        <form id="currency-settings-form">
          <div class="form-group">
            <label class="form-label">Базовая валюта</label>
            <select id="base-currency" class="form-control">
              ${currencyState.supportedCurrencies.map(c => `
                <option value="${c.code}" ${c.code === settings.base_currency ? 'selected' : ''}>
                  ${c.symbol} ${c.code} - ${c.name}
                </option>
              `).join('')}
            </select>
            <small class="form-hint">Основная валюта для отображения баланса</small>
          </div>

          <div class="form-group">
            <label class="form-label">Отображаемые валюты</label>
            <div class="currency-checkboxes">
              ${currencyState.supportedCurrencies.map(c => `
                <label class="checkbox-label">
                  <input type="checkbox" name="display_currencies" value="${c.code}"
                    ${displayCurrencies.includes(c.code) ? 'checked' : ''}>
                  <span>${c.symbol} ${c.code}</span>
                </label>
              `).join('')}
            </div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="auto-convert" ${settings.auto_convert ? 'checked' : ''}>
              <span>Автоматически конвертировать в базовую валюту</span>
            </label>
          </div>

          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Сохранить настройки
          </button>
        </form>
      </div>
    </div>
  `;

  document.getElementById('currency-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const baseCurrency = document.getElementById('base-currency').value;
    const autoConvert = document.getElementById('auto-convert').checked;
    const displayCheckboxes = document.querySelectorAll('input[name="display_currencies"]:checked');
    const displayCurrencies = Array.from(displayCheckboxes).map(cb => cb.value);

    try {
      const result = await updateCurrencySettings({
        base_currency: baseCurrency,
        display_currencies: displayCurrencies,
        auto_convert: autoConvert
      });

      currencyState.settings = result.settings;
      showNotification('Настройки сохранены', 'success');
    } catch (error) {
      showNotification('Ошибка сохранения настроек', 'error');
    }
  });
}

// ==================== ТАБ ТЕГОВ ====================

async function renderTagsTab() {
  const container = document.getElementById('currency-tab-content');

  container.innerHTML = `
    <div class="tags-section">
      <div class="card">
        <div class="tags-header">
          <h2><i class="fas fa-tags"></i> Теги транзакций</h2>
          <button id="add-tag-btn" class="btn btn-primary">
            <i class="fas fa-plus"></i> Создать тег
          </button>
        </div>

        <div id="tags-list" class="tags-list">
          <div class="loading">
            <div class="spinner"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('add-tag-btn').addEventListener('click', showAddTagModal);

  loadTags();
}

async function loadTags() {
  const container = document.getElementById('tags-list');

  try {
    const tags = await fetchTags();

    if (tags.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-tags"></i>
          <h3>Нет тегов</h3>
          <p>Создайте теги для категоризации транзакций</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="tags-grid">
        ${tags.map(tag => `
          <div class="tag-card" data-tag-id="${tag.id}">
            <div class="tag-color" style="background-color: ${tag.color}"></div>
            <div class="tag-info">
              <h4>${escapeHtml(tag.name)}</h4>
              <span class="tag-usage">${tag.usage_count || 0} транзакций</span>
            </div>
            <div class="tag-actions">
              <button class="btn btn-sm btn-outline" onclick="showEditTagModal(${tag.id})">
                <i class="fas fa-edit"></i>
              </button>
              <button class="btn btn-sm btn-outline" onclick="showTagStats(${tag.id})">
                <i class="fas fa-chart-bar"></i>
              </button>
              <button class="btn btn-sm btn-danger" onclick="confirmDeleteTag(${tag.id})">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (error) {
    container.innerHTML = `
      <div class="empty-text">
        <i class="fas fa-exclamation-circle"></i>
        <p>Ошибка загрузки тегов</p>
      </div>
    `;
  }
}

function showAddTagModal() {
  const colors = ['#5D5CDE', '#38C172', '#E3342F', '#F9A826', '#3490dc', '#9561e2', '#f66d9b', '#6574cd'];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">Создать тег</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <form id="add-tag-form">
          <div class="form-group">
            <label class="form-label">Название тега</label>
            <input type="text" id="tag-name" class="form-control" required placeholder="Например: Работа">
          </div>

          <div class="form-group">
            <label class="form-label">Цвет</label>
            <div class="color-picker">
              ${colors.map((color, i) => `
                <label class="color-option">
                  <input type="radio" name="tag-color" value="${color}" ${i === 0 ? 'checked' : ''}>
                  <span class="color-swatch" style="background-color: ${color}"></span>
                </label>
              `).join('')}
            </div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" id="cancel-tag">Отмена</button>
        <button type="submit" form="add-tag-form" class="btn btn-primary">Создать</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('#cancel-tag').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.getElementById('add-tag-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('tag-name').value.trim();
    const color = document.querySelector('input[name="tag-color"]:checked').value;

    try {
      await createTag(name, color);
      modal.remove();
      showNotification('Тег создан', 'success');
      loadTags();
    } catch (error) {
      showNotification(error.message, 'error');
    }
  });
}

async function showEditTagModal(tagId) {
  const tag = currencyState.tags.find(t => t.id === tagId);
  if (!tag) return;

  const colors = ['#5D5CDE', '#38C172', '#E3342F', '#F9A826', '#3490dc', '#9561e2', '#f66d9b', '#6574cd'];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">Редактировать тег</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <form id="edit-tag-form">
          <div class="form-group">
            <label class="form-label">Название тега</label>
            <input type="text" id="tag-name" class="form-control" required value="${escapeHtml(tag.name)}">
          </div>

          <div class="form-group">
            <label class="form-label">Цвет</label>
            <div class="color-picker">
              ${colors.map(color => `
                <label class="color-option">
                  <input type="radio" name="tag-color" value="${color}" ${color === tag.color ? 'checked' : ''}>
                  <span class="color-swatch" style="background-color: ${color}"></span>
                </label>
              `).join('')}
            </div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" id="cancel-edit">Отмена</button>
        <button type="submit" form="edit-tag-form" class="btn btn-primary">Сохранить</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('#cancel-edit').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.getElementById('edit-tag-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('tag-name').value.trim();
    const color = document.querySelector('input[name="tag-color"]:checked').value;

    try {
      await updateTag(tagId, { name, color });
      modal.remove();
      showNotification('Тег обновлен', 'success');
      loadTags();
    } catch (error) {
      showNotification(error.message, 'error');
    }
  });
}

async function showTagStats(tagId) {
  const tag = currencyState.tags.find(t => t.id === tagId);
  if (!tag) return;

  try {
    const stats = await getTagStats(tagId);

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2 class="modal-title">
            <span class="tag-badge" style="background-color: ${tag.color}">${escapeHtml(tag.name)}</span>
            Статистика
          </h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-icon"><i class="fas fa-list"></i></div>
              <div class="stat-data">
                <div class="stat-value">${stats.transactionCount}</div>
                <div class="stat-label">Транзакций</div>
              </div>
            </div>

            <div class="stat-card income">
              <div class="stat-icon"><i class="fas fa-arrow-down"></i></div>
              <div class="stat-data">
                <div class="stat-value">${formatCurrency(stats.totalIncome)}</div>
                <div class="stat-label">Доходы</div>
              </div>
            </div>

            <div class="stat-card expense">
              <div class="stat-icon"><i class="fas fa-arrow-up"></i></div>
              <div class="stat-data">
                <div class="stat-value">${formatCurrency(stats.totalExpense)}</div>
                <div class="stat-label">Расходы</div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary" id="close-stats">Закрыть</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#close-stats').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

  } catch (error) {
    showNotification('Ошибка загрузки статистики', 'error');
  }
}

function confirmDeleteTag(tagId) {
  const tag = currencyState.tags.find(t => t.id === tagId);
  if (!tag) return;

  if (confirm(`Удалить тег "${tag.name}"? Он будет удален со всех транзакций.`)) {
    deleteTag(tagId)
      .then(() => {
        showNotification('Тег удален', 'success');
        loadTags();
      })
      .catch(error => {
        showNotification('Ошибка удаления тега', 'error');
      });
  }
}

// ==================== ВЫБОР ТЕГОВ ДЛЯ ТРАНЗАКЦИИ ====================

async function renderTagSelector(transactionId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const tags = currencyState.tags.length ? currencyState.tags : await fetchTags();
  const selectedTags = transactionId ? await getTransactionTags(transactionId) : [];
  const selectedIds = selectedTags.map(t => t.id);

  container.innerHTML = `
    <div class="tag-selector">
      <label class="form-label">Теги</label>
      <div class="selected-tags" id="selected-tags-${containerId}">
        ${selectedTags.map(t => `
          <span class="tag-badge" style="background-color: ${t.color}" data-tag-id="${t.id}">
            ${escapeHtml(t.name)}
            <button type="button" class="tag-remove" onclick="removeTagFromSelector(${t.id}, '${containerId}')">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="tag-dropdown">
        <input type="text" class="form-control tag-search" placeholder="Поиск или добавление тегов..."
               id="tag-search-${containerId}">
        <div class="tag-options hidden" id="tag-options-${containerId}">
          ${tags.filter(t => !selectedIds.includes(t.id)).map(t => `
            <div class="tag-option" data-tag-id="${t.id}" onclick="addTagToSelector(${t.id}, '${containerId}')">
              <span class="tag-color-dot" style="background-color: ${t.color}"></span>
              ${escapeHtml(t.name)}
            </div>
          `).join('')}
          ${tags.length === 0 ? '<div class="tag-option-empty">Нет тегов</div>' : ''}
        </div>
      </div>
      <input type="hidden" name="tagIds" id="tag-ids-${containerId}" value="${selectedIds.join(',')}">
    </div>
  `;

  // Поиск тегов
  const searchInput = document.getElementById(`tag-search-${containerId}`);
  const optionsDiv = document.getElementById(`tag-options-${containerId}`);

  searchInput.addEventListener('focus', () => {
    optionsDiv.classList.remove('hidden');
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => optionsDiv.classList.add('hidden'), 200);
  });

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase();
    const options = optionsDiv.querySelectorAll('.tag-option');
    options.forEach(opt => {
      const text = opt.textContent.toLowerCase();
      opt.style.display = text.includes(query) ? 'flex' : 'none';
    });
  });
}

function addTagToSelector(tagId, containerId) {
  const tag = currencyState.tags.find(t => t.id === tagId);
  if (!tag) return;

  const selectedContainer = document.getElementById(`selected-tags-${containerId}`);
  const hiddenInput = document.getElementById(`tag-ids-${containerId}`);
  const optionDiv = document.querySelector(`#tag-options-${containerId} [data-tag-id="${tagId}"]`);

  // Добавляем тег в выбранные
  const tagBadge = document.createElement('span');
  tagBadge.className = 'tag-badge';
  tagBadge.style.backgroundColor = tag.color;
  tagBadge.dataset.tagId = tagId;
  tagBadge.innerHTML = `
    ${escapeHtml(tag.name)}
    <button type="button" class="tag-remove" onclick="removeTagFromSelector(${tagId}, '${containerId}')">&times;</button>
  `;
  selectedContainer.appendChild(tagBadge);

  // Обновляем hidden input
  const currentIds = hiddenInput.value ? hiddenInput.value.split(',').map(Number) : [];
  currentIds.push(tagId);
  hiddenInput.value = currentIds.join(',');

  // Скрываем опцию
  if (optionDiv) optionDiv.style.display = 'none';
}

function removeTagFromSelector(tagId, containerId) {
  const selectedContainer = document.getElementById(`selected-tags-${containerId}`);
  const hiddenInput = document.getElementById(`tag-ids-${containerId}`);
  const optionDiv = document.querySelector(`#tag-options-${containerId} [data-tag-id="${tagId}"]`);

  // Удаляем бейдж
  const badge = selectedContainer.querySelector(`[data-tag-id="${tagId}"]`);
  if (badge) badge.remove();

  // Обновляем hidden input
  const currentIds = hiddenInput.value ? hiddenInput.value.split(',').map(Number) : [];
  hiddenInput.value = currentIds.filter(id => id !== tagId).join(',');

  // Показываем опцию
  if (optionDiv) optionDiv.style.display = 'flex';
}

function getSelectedTagIds(containerId) {
  const hiddenInput = document.getElementById(`tag-ids-${containerId}`);
  if (!hiddenInput || !hiddenInput.value) return [];
  return hiddenInput.value.split(',').map(Number).filter(id => !isNaN(id));
}

// ==================== УТИЛИТЫ ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Экспорт функций для глобального доступа
window.showEditTagModal = showEditTagModal;
window.showTagStats = showTagStats;
window.confirmDeleteTag = confirmDeleteTag;
window.addTagToSelector = addTagToSelector;
window.removeTagFromSelector = removeTagFromSelector;
window.renderTagSelector = renderTagSelector;
window.getSelectedTagIds = getSelectedTagIds;
