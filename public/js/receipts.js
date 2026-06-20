// Receipts Scanner Module
const ReceiptsModule = {
  receipts: [],
  stats: null,

  async init() {
    await Promise.all([this.loadReceipts(), this.loadStats()]);
  },

  async loadReceipts() {
    try {
      const response = await fetch('/api/receipts', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      this.receipts = await response.json();
      this.render();
    } catch (error) {
      console.error('Error loading receipts:', error);
    }
  },

  async loadStats() {
    try {
      const response = await fetch('/api/receipts/stats/summary', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
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
      container.innerHTML = '<div class="empty-state"><p>Нет загруженных чеков</p></div>';
      return;
    }

    container.innerHTML = this.receipts.map(r => `
      <div class="card receipt-card ${r.is_processed ? 'processed' : 'pending'}" data-id="${r.id}">
        <div class="receipt-header">
          <div class="receipt-info">
            <h3>${r.merchant || 'Неизвестный магазин'}</h3>
            <small>${r.receipt_date || 'Дата не указана'} | ${r.category || 'Без категории'}</small>
          </div>
          <div class="receipt-amount">
            <strong>${r.total_amount ? r.total_amount.toLocaleString() + ' ' + (r.currency || '₴') : 'Не распознано'}</strong>
          </div>
        </div>
        <div class="receipt-status">
          <span class="badge ${r.ocr_status === 'completed' ? 'badge-success' : r.ocr_status === 'failed' ? 'badge-danger' : 'badge-warning'}">
            ${r.ocr_status === 'completed' ? '✓ Распознан' : r.ocr_status === 'failed' ? '✕ Ошибка' : r.ocr_status === 'manual' ? '✎ Вручную' : '⏳ Обработка'}
          </span>
          ${r.is_processed ? '<span class="badge badge-success">Транзакция создана</span>' : ''}
        </div>
        ${r.items && r.items.length > 0 ? `<div class="receipt-items"><small>${r.items.map(i => i.name).join(', ')}</small></div>` : ''}
        <div class="receipt-actions">
          ${!r.is_processed ? `<button class="btn btn-sm btn-primary" onclick="ReceiptsModule.createTransaction(${r.id})">Создать транзакцию</button>` : ''}
          <button class="btn btn-sm" onclick="ReceiptsModule.edit(${r.id})">✏️ Редактировать</button>
          <button class="btn btn-sm btn-danger" onclick="ReceiptsModule.delete(${r.id})">🗑</button>
        </div>
      </div>
    `).join('');
  },

  renderStats() {
    const container = document.getElementById('receipts-stats');
    if (!container || !this.stats) return;

    container.innerHTML = `
      <div class="stat-card"><div class="stat-value">${this.stats.total}</div><div class="stat-label">Всего чеков</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.processed}</div><div class="stat-label">Обработано</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.pending}</div><div class="stat-label">Ожидают</div></div>
      <div class="stat-card"><div class="stat-value">${this.stats.totalAmount.toLocaleString()} ₴</div><div class="stat-label">Сумма</div></div>
    `;
  },

  showUploadModal() {
    document.getElementById('upload-form').reset();
    document.getElementById('image-preview').innerHTML = '';
    document.getElementById('upload-modal').classList.add('active');
  },

  showManualModal() {
    document.getElementById('manual-form').reset();
    document.getElementById('receipt-id').value = '';
    document.getElementById('manual-modal-title').textContent = 'Добавить чек вручную';
    document.getElementById('manual-modal').classList.add('active');
  },

  handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('image-preview').innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:200px;">`;
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ image_data: imageData })
      });
      const result = await response.json();
      document.getElementById('upload-modal').classList.remove('active');

      await this.loadReceipts();
      await this.loadStats();

      // Показываем РЕАЛЬНЫЕ распознанные поля и даём исправить перед сохранением.
      if (result && result.id) {
        if (result.ocr_status === 'completed') {
          this.openReview(result.id, result);
        } else {
          alert('Не удалось распознать чек автоматически. Заполните данные вручную.');
          this.openReview(result.id, result || {});
        }
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
      hint.style.display = 'block';
    }

    // Список позиций, если распознаны.
    const itemsBox = document.getElementById('ocr-items');
    if (itemsBox) {
      const items = Array.isArray(data.items) ? data.items : [];
      itemsBox.innerHTML = items.length
        ? '<small>Позиции: ' + items.map(i => `${i.name} — ${i.price}`).join('; ') + '</small>'
        : '';
    }

    document.getElementById('manual-modal').classList.add('active');
  },

  async edit(id) {
    const receipt = this.receipts.find(r => r.id === id);
    if (!receipt) return;

    document.getElementById('receipt-id').value = receipt.id;
    document.getElementById('receipt-merchant').value = receipt.merchant || '';
    document.getElementById('receipt-amount').value = receipt.total_amount || '';
    document.getElementById('receipt-date').value = receipt.receipt_date || '';
    document.getElementById('receipt-category').value = receipt.category || '';
    document.getElementById('manual-modal-title').textContent = 'Редактировать чек';
    document.getElementById('manual-modal').classList.add('active');
  },

  async saveManual() {
    const id = document.getElementById('receipt-id').value;
    const data = {
      merchant: document.getElementById('receipt-merchant').value,
      total_amount: parseFloat(document.getElementById('receipt-amount').value),
      receipt_date: document.getElementById('receipt-date').value,
      category: document.getElementById('receipt-category').value
    };

    try {
      const url = id ? `/api/receipts/${id}` : '/api/receipts/manual';
      const method = id ? 'PUT' : 'POST';
      await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(data) });
      document.getElementById('manual-modal').classList.remove('active');
      await this.loadReceipts();
      await this.loadStats();
    } catch (error) {
      alert('Ошибка');
    }
  },

  async createTransaction(id) {
    const accounts = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }).then(r => r.json());
    if (accounts.length === 0) { alert('Сначала создайте счёт'); return; }

    const accountId = prompt('Выберите ID счёта:\n' + accounts.map(a => `${a.id}: ${a.name}`).join('\n'));
    if (!accountId) return;

    try {
      await fetch(`/api/receipts/${id}/create-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ account_id: parseInt(accountId) })
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
      await fetch(`/api/receipts/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
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
            <button class="btn btn-primary" onclick="ReceiptsModule.showUploadModal()">📷 Загрузить фото</button>
            <button class="btn btn-secondary" onclick="ReceiptsModule.showManualModal()">✏️ Ввести вручную</button>
          </div>
        </div>
        <div class="stats-grid" id="receipts-stats"></div>
        <div id="receipts-list"></div>
      </div>
      <div class="modal" id="upload-modal">
        <div class="modal-content">
          <div class="modal-header"><h2>Загрузить чек</h2><button class="modal-close" onclick="document.getElementById('upload-modal').classList.remove('active')">&times;</button></div>
          <form id="upload-form" onsubmit="event.preventDefault(); ReceiptsModule.uploadReceipt()">
            <input type="hidden" id="image-data">
            <div class="form-group"><label>Фото чека</label><input type="file" accept="image/*" class="form-control" onchange="ReceiptsModule.handleFileSelect(event)"></div>
            <div id="image-preview"></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('upload-modal').classList.remove('active')">Отмена</button><button type="submit" class="btn btn-primary">Загрузить</button></div>
          </form>
        </div>
      </div>
      <div class="modal" id="manual-modal">
        <div class="modal-content">
          <div class="modal-header"><h2 id="manual-modal-title">Добавить чек</h2><button class="modal-close" onclick="document.getElementById('manual-modal').classList.remove('active')">&times;</button></div>
          <form id="manual-form" onsubmit="event.preventDefault(); ReceiptsModule.saveManual()">
            <input type="hidden" id="receipt-id">
            <div id="ocr-hint" class="ocr-hint" style="display:none;font-size:0.85em;color:#5D5CDE;margin-bottom:8px;"></div>
            <div id="ocr-items" class="ocr-items" style="margin-bottom:8px;"></div>
            <div class="form-group"><label>Магазин</label><input type="text" id="receipt-merchant" class="form-control" required></div>
            <div class="form-row">
              <div class="form-group"><label>Сумма</label><input type="number" id="receipt-amount" class="form-control" step="0.01" required></div>
              <div class="form-group"><label>Дата</label><input type="date" id="receipt-date" class="form-control" required></div>
            </div>
            <div class="form-group"><label>Категория</label><input type="text" id="receipt-category" class="form-control"></div>
            <div class="form-actions"><button type="button" class="btn btn-secondary" onclick="document.getElementById('manual-modal').classList.remove('active')">Отмена</button><button type="submit" class="btn btn-primary">Сохранить</button></div>
          </form>
        </div>
      </div>
    `;
  }
};
