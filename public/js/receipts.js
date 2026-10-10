// Receipts Scanner Module
// Amounts are shown in the receipt's own currency (plain number when the
// receipt has none). Stats read the API shape (/api/receipts/stats/summary:
// totalReceipts, pendingReceipts, thisMonthCount, thisMonthTotal).
// Modals use the shared hidden / is-open convention (lib/ui.js).
const ReceiptsModule = {
  receipts: [],
  stats: null,

  headers() {
    return { 'Authorization': `Bearer ${localStorage.getItem('token')}` };
  },

  amount(r) {
    if (!r || r.total_amount == null) return 'Не распознано';
    return UI.esc(r.currency && /^[A-Za-z]{3}$/.test(r.currency) ? UI.money(r.total_amount, r.currency) : UI.fmtNumber(r.total_amount));
  },

  async init() {
    await UI.loadBaseCurrency();
    await Promise.all([this.loadReceipts(), this.loadStats()]);
  },

  async loadReceipts() {
    try {
      const response = await fetch('/api/receipts', { headers: this.headers() });
      const data = await response.json();
      this.receipts = Array.isArray(data) ? data : [];
      this.render();
      this.renderStats();
    } catch (error) {
      console.error('Error loading receipts:', error);
    }
  },

  async loadStats() {
    try {
      const response = await fetch('/api/receipts/stats/summary', { headers: this.headers() });
      this.stats = await response.json();
      this.renderStats();
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  },

  render() {
    const container = document.getElementById('receipts-list');
    if (!container) return;

    if (this.receipts.length === 0) {
      container.innerHTML = UI.emptyState({
        icon: 'fa-receipt',
        title: 'Нет загруженных чеков',
        text: 'Сфотографируйте чек — магазин, сумма и дата распознаются автоматически, остаётся подтвердить и создать транзакцию.',
        action: { label: 'Загрузить фото', action: 'rcpt:upload-modal', icon: 'fa-camera' }
      });
      return;
    }

    container.innerHTML = this.receipts.map(r => `
      <div class="card receipt-card ${r.is_processed ? 'processed' : 'pending'}" data-id="${r.id}">
        <div class="receipt-header">
          <div class="receipt-info">
            <h3>${UI.esc(r.merchant || 'Неизвестный магазин')}</h3>
            <small>${UI.esc(r.receipt_date || 'Дата не указана')} | ${UI.esc(r.category || 'Без категории')}</small>
          </div>
          <div class="receipt-amount">
            <strong>${this.amount(r)}</strong>
          </div>
        </div>
        <div class="receipt-status">
          <span class="badge ${r.ocr_status === 'completed' ? 'badge-success' : r.ocr_status === 'failed' ? 'badge-danger' : 'badge-warning'}">
            ${r.ocr_status === 'completed' ? '✓ Распознан' : r.ocr_status === 'failed' ? '✕ Ошибка' : r.ocr_status === 'manual' ? '✎ Вручную' : '⏳ Обработка'}
          </span>
          ${r.is_processed ? '<span class="badge badge-success">Транзакция создана</span>' : ''}
        </div>
        ${r.items && r.items.length > 0 ? `<div class="receipt-items"><small>${UI.esc(r.items.map(i => i.name).join(', '))}</small></div>` : ''}
        <div class="receipt-actions">
          ${!r.is_processed ? `<button type="button" class="btn btn-sm btn-primary" data-action="rcpt:create-tx" data-id="${r.id}">Создать транзакцию</button>` : ''}
          <button type="button" class="btn btn-sm" data-action="rcpt:edit" data-id="${r.id}">✏️ Редактировать</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="rcpt:delete" data-id="${r.id}" aria-label="Удалить чек" title="Удалить">🗑</button>
        </div>
      </div>
    `).join('');
  },

  renderStats() {
    const container = document.getElementById('receipts-stats');
    if (!container || !this.stats) return;
    const s = this.stats;
    // thisMonthTotal is a raw SUM over receipts; format it with a currency only
    // when every receipt shares one.
    const currencies = UI.uniqueCurrencies(this.receipts.map(r => r.currency));
    const total = s.thisMonthTotal != null ? s.thisMonthTotal : s.totalAmount;
    container.innerHTML = `
      <div class="stat-card"><div class="stat-value">${Number(s.totalReceipts != null ? s.totalReceipts : s.total) || 0}</div><div class="stat-label">Всего чеков</div></div>
      <div class="stat-card"><div class="stat-value">${Number(s.pendingReceipts != null ? s.pendingReceipts : s.pending) || 0}</div><div class="stat-label">Ожидают</div></div>
      <div class="stat-card"><div class="stat-value">${Number(s.thisMonthCount) || 0}</div><div class="stat-label">За этот месяц</div></div>
      <div class="stat-card"><div class="stat-value">${UI.esc(UI.aggregateMoney(total || 0, currencies))}</div><div class="stat-label">Сумма за месяц</div></div>
    `;
  },

  showUploadModal() {
    document.getElementById('upload-form').reset();
    document.getElementById('image-preview').innerHTML = '';
    document.getElementById('image-data').value = '';
    UI.openModal('upload-modal');
  },

  showManualModal() {
    document.getElementById('manual-form').reset();
    document.getElementById('receipt-id').value = '';
    document.getElementById('manual-modal-title').textContent = 'Добавить чек вручную';
    this.fillCurrencySelect(UI.baseCurrency());
    this.resetHints();
    UI.openModal('manual-modal');
  },

  fillCurrencySelect(selected) {
    const sel = document.getElementById('receipt-currency');
    if (sel) sel.innerHTML = UI.currencyOptions(selected);
  },

  resetHints() {
    const hint = document.getElementById('ocr-hint');
    if (hint) { hint.textContent = ''; hint.hidden = true; }
    const items = document.getElementById('ocr-items');
    if (items) items.innerHTML = '';
  },

  handleFileSelect(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.alt = 'Предпросмотр чека';
      const preview = document.getElementById('image-preview');
      preview.innerHTML = '';
      preview.appendChild(img);
      document.getElementById('image-data').value = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  async uploadReceipt() {
    const imageData = document.getElementById('image-data').value;
    if (!imageData) { alert('Выберите изображение'); return; }

    const submitBtn = document.querySelector('#upload-form button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Распознаём…'; }

    try {
      // Синхронный режим: сервер вернёт распознанные поля сразу.
      const response = await fetch('/api/receipts/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify({ image_data: imageData })
      });
      const result = await response.json();
      UI.closeModal('upload-modal');

      await this.loadReceipts();
      await this.loadStats();

      // Показываем РЕАЛЬНЫЕ распознанные поля и даём исправить перед сохранением.
      if (result && result.id) {
        if (result.ocr_status !== 'completed') {
          alert('Не удалось распознать чек автоматически. Заполните данные вручную.');
        }
        this.openReview(result.id, result || {});
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Ошибка загрузки');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Загрузить'; }
    }
  },

  // Открыть форму проверки/коррекции распознанных полей перед сохранением
  // как транзакции. Переиспользуем manual-modal: предзаполняем распознанным.
  openReview(id, data) {
    const elId = document.getElementById('receipt-id');
    const elMerchant = document.getElementById('receipt-merchant');
    const elAmount = document.getElementById('receipt-amount');
    const elDate = document.getElementById('receipt-date');
    const elCategory = document.getElementById('receipt-category');
    const title = document.getElementById('manual-modal-title');
    if (!elId) { return; }

    elId.value = id;
    if (elMerchant) elMerchant.value = data.merchant || '';
    if (elAmount) elAmount.value = (data.total_amount != null ? data.total_amount : '');
    if (elDate) elDate.value = data.receipt_date || new Date().toISOString().split('T')[0];
    if (elCategory) elCategory.value = data.category || '';
    this.fillCurrencySelect(data.currency || UI.baseCurrency());
    if (title) title.textContent = 'Проверьте распознанный чек';

    // Подсказка пользователю об источнике данных.
    const hint = document.getElementById('ocr-hint');
    if (hint) {
      const parts = [];
      if (data.merchant) parts.push('магазин');
      if (data.total_amount != null) parts.push('сумма');
      if (data.receipt_date) parts.push('дата');
      hint.textContent = parts.length
        ? `Распознано: ${parts.join(', ')}. Проверьте и при необходимости поправьте.`
        : 'Автораспознавание не дало результата — введите данные вручную.';
      hint.hidden = false;
    }

    // Список позиций, если распознаны.
    const itemsBox = document.getElementById('ocr-items');
    if (itemsBox) {
      const items = Array.isArray(data.items) ? data.items : [];
      itemsBox.innerHTML = items.length
        ? '<small>Позиции: ' + UI.esc(items.map(i => `${i.name} — ${i.price}`).join('; ')) + '</small>'
        : '';
    }

    UI.openModal('manual-modal');
  },

  async edit(id) {
    const receipt = this.receipts.find(r => r.id === Number(id));
    if (!receipt) return;

    document.getElementById('receipt-id').value = receipt.id;
    document.getElementById('receipt-merchant').value = receipt.merchant || '';
    document.getElementById('receipt-amount').value = receipt.total_amount != null ? receipt.total_amount : '';
    document.getElementById('receipt-date').value = receipt.receipt_date || '';
    document.getElementById('receipt-category').value = receipt.category || '';
    this.fillCurrencySelect(receipt.currency || UI.baseCurrency());
    this.resetHints();
    document.getElementById('manual-modal-title').textContent = 'Редактировать чек';
    UI.openModal('manual-modal');
  },

  async saveManual() {
    const id = document.getElementById('receipt-id').value;
    const data = {
      merchant: document.getElementById('receipt-merchant').value,
      total_amount: parseFloat(document.getElementById('receipt-amount').value),
      currency: document.getElementById('receipt-currency').value,
      receipt_date: document.getElementById('receipt-date').value,
      category: document.getElementById('receipt-category').value
    };

    try {
      const url = id ? `/api/receipts/${id}` : '/api/receipts/manual';
      const method = id ? 'PUT' : 'POST';
      await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...this.headers() }, body: JSON.stringify(data) });
      UI.closeModal('manual-modal');
      await this.loadReceipts();
      await this.loadStats();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async createTransaction(id) {
    const raw = await fetch('/api/accounts', { headers: this.headers() }).then(r => r.json());
    const accounts = Array.isArray(raw) ? raw : (raw && (raw.all || raw.data)) || [];
    if (accounts.length === 0) { alert('Сначала создайте счёт'); return; }

    const accountId = prompt('Выберите ID счёта:\n' + accounts.map(a => `${a.id}: ${a.name} (${a.currency || ''})`).join('\n'));
    if (!accountId) return;

    try {
      await fetch(`/api/receipts/${Number(id)}/create-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify({ account_id: parseInt(accountId, 10) })
      });
      alert('Транзакция создана');
      await this.loadReceipts();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async delete(id) {
    if (!confirm('Удалить чек?')) return;
    try {
      await fetch(`/api/receipts/${Number(id)}`, { method: 'DELETE', headers: this.headers() });
      await this.loadReceipts();
      await this.loadStats();
    } catch (error) {
      alert('Ошибка');
    }
  },

  getPage() {
    return `
      <div class="receipts-page">
        <div class="page-header"><h1>🧾 Сканер чеков</h1>
          <div class="btn-group">
            <button type="button" class="btn btn-primary" data-action="rcpt:upload-modal">📷 Загрузить фото</button>
            <button type="button" class="btn btn-secondary" data-action="rcpt:manual-modal">✏️ Ввести вручную</button>
          </div>
        </div>
        <div class="stats-grid" id="receipts-stats"></div>
        <div id="receipts-list"></div>
      </div>
      <div class="modal-backdrop" id="upload-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title">Загрузить чек</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
          <div class="modal-body">
            <form id="upload-form" data-submit="rcpt:upload">
              <input type="hidden" id="image-data">
              <div class="form-group"><label for="receipt-file">Фото чека</label><input type="file" id="receipt-file" accept="image/*" class="form-control" data-change="rcpt:file"></div>
              <div id="image-preview" class="image-preview"></div>
              <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button><button type="submit" class="btn btn-primary">Загрузить</button></div>
            </form>
          </div>
        </div>
      </div>
      <div class="modal-backdrop" id="manual-modal" hidden>
        <div class="modal">
          <div class="modal-header"><h2 class="modal-title" id="manual-modal-title">Добавить чек</h2><button type="button" class="modal-close" data-action="ui:close" aria-label="Закрыть">&times;</button></div>
          <div class="modal-body">
            <form id="manual-form" data-submit="rcpt:save-manual">
              <input type="hidden" id="receipt-id">
              <div id="ocr-hint" class="ocr-hint" hidden></div>
              <div id="ocr-items" class="ocr-items"></div>
              <div class="form-group"><label for="receipt-merchant">Магазин</label><input type="text" id="receipt-merchant" class="form-control" required></div>
              <div class="form-row">
                <div class="form-group"><label for="receipt-amount">Сумма</label><input type="number" id="receipt-amount" class="form-control" step="0.01" required></div>
                <div class="form-group"><label for="receipt-currency">Валюта</label><select id="receipt-currency" class="form-control">${UI.currencyOptions()}</select></div>
                <div class="form-group"><label for="receipt-date">Дата</label><input type="date" id="receipt-date" class="form-control" required></div>
              </div>
              <div class="form-group"><label for="receipt-category">Категория</label><input type="text" id="receipt-category" class="form-control"></div>
              <div class="form-actions"><button type="button" class="btn btn-secondary" data-action="ui:close">Отмена</button><button type="submit" class="btn btn-primary">Сохранить</button></div>
            </form>
          </div>
        </div>
      </div>
    `;
  }
};

if (typeof window !== 'undefined' && window.UI) {
  UI.actions({
    'rcpt:upload-modal': () => ReceiptsModule.showUploadModal(),
    'rcpt:manual-modal': () => ReceiptsModule.showManualModal(),
    'rcpt:file': (el) => ReceiptsModule.handleFileSelect(el),
    'rcpt:upload': () => ReceiptsModule.uploadReceipt(),
    'rcpt:save-manual': () => ReceiptsModule.saveManual(),
    'rcpt:create-tx': (el) => ReceiptsModule.createTransaction(el.dataset.id),
    'rcpt:edit': (el) => ReceiptsModule.edit(el.dataset.id),
    'rcpt:delete': (el) => ReceiptsModule.delete(el.dataset.id),
  });
}
