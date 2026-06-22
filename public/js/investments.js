// ==================== INVESTMENTS ====================
async function renderInvestmentsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const stats = await fetchWithAuth('/api/investments/stats').then(r => r.json());
    mainContent.innerHTML = `<div class="investments-page"><div class="page-header"><h1><i class="fas fa-chart-line"></i> Инвестиции</h1><div class="page-actions"><button class="btn btn-outline" onclick="refreshAllPrices(this)"><i class="fas fa-sync-alt"></i> Обновить цены</button><button class="btn btn-primary" onclick="showAddPortfolioModal()"><i class="fas fa-plus"></i> Новый портфель</button></div></div><div class="stats-grid"><div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${formatCurrency(stats.totalValue)}</div><div class="stat-label">Общая стоимость</div></div></div><div class="stat-card ${stats.totalProfitLoss >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-${stats.totalProfitLoss >= 0 ? 'arrow-up' : 'arrow-down'}"></i></div><div class="stat-data"><div class="stat-value">${stats.totalProfitLoss >= 0 ? '+' : ''}${formatCurrency(stats.totalProfitLoss)}</div><div class="stat-label">Прибыль/убыток (${stats.totalProfitLossPercent}%)</div></div></div></div><div class="card-grid" id="portfolios-list">${stats.portfolios.length === 0 ? '<div class="empty-state"><i class="fas fa-chart-line"></i><h3>Нет портфелей</h3></div>' : stats.portfolios.map(p => renderPortfolioCard(p)).join('')}</div></div>`;
  } catch (e) { mainContent.innerHTML = '<div class="alert alert-error">Ошибка загрузки</div>'; }
}
function renderPortfolioCard(p) { return `<div class="card" onclick="openPortfolio(${p.id})"><div class="card-header"><h3 class="card-title"><i class="fas fa-briefcase"></i> ${p.name}</h3></div><p>Стоимость: ${formatCurrency(p.totalValue)} ${p.currency}</p><p class="${p.totalProfitLoss >= 0 ? 'text-success' : 'text-error'}">${p.totalProfitLoss >= 0 ? '+' : ''}${formatCurrency(p.totalProfitLoss)} (${p.totalProfitLossPercent}%)</p></div>`; }
async function openPortfolio(id) { const mainContent = document.getElementById('main-content'); mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; try { const portfolio = await fetchWithAuth('/api/investments/portfolios/' + id).then(r => r.json()); const allocationCard = await renderAllocationCard(id); const netPL = (typeof portfolio.totalNetProfitLoss === 'number') ? portfolio.totalNetProfitLoss : portfolio.totalProfitLoss; const divLine = (typeof portfolio.totalDividends === 'number' && portfolio.totalDividends > 0) ? `<div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">+${formatCurrency(portfolio.totalDividends)}</div><div class="stat-label">Дивиденды</div></div></div>` : ''; mainContent.innerHTML = `<div class="investments-page"><div class="page-header"><button class="btn btn-outline" onclick="renderInvestmentsPage()"><i class="fas fa-arrow-left"></i></button><h1>${escapeHtmlInv(portfolio.name)}</h1><div class="page-actions"><button class="btn btn-outline" onclick="refreshPortfolioPrices(${id}, this)"><i class="fas fa-sync-alt"></i> Обновить цены</button><button class="btn btn-primary" onclick="showAddInvestmentModal(${id})"><i class="fas fa-plus"></i> Добавить актив</button></div></div><div class="stats-grid"><div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(portfolio.totalValue)}</div><div class="stat-label">Стоимость</div></div></div><div class="stat-card"><div class="stat-data"><div class="stat-value">${formatCurrency(portfolio.totalCost)}</div><div class="stat-label">Вложено</div></div></div><div class="stat-card ${portfolio.totalProfitLoss >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-data"><div class="stat-value">${portfolio.totalProfitLoss >= 0 ? '+' : ''}${formatCurrency(portfolio.totalProfitLoss)}</div><div class="stat-label">P/L (${portfolio.totalProfitLossPercent}%)</div></div></div><div class="stat-card ${netPL >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-data"><div class="stat-value">${netPL >= 0 ? '+' : ''}${formatCurrency(netPL)}</div><div class="stat-label">Чистый P/L</div></div></div>${divLine}</div><div class="card"><h3>Активы</h3><div class="table-container"><table class="table"><thead><tr><th>Символ</th><th>Кол-во</th><th>Цена покупки</th><th>Текущая цена</th><th>Стоимость</th><th>P/L</th><th></th></tr></thead><tbody>${portfolio.holdings.map(h => `<tr><td><strong>${escapeHtmlInv(h.symbol)}</strong><br><small>${escapeHtmlInv(h.name)}</small></td><td>${h.quantity}</td><td>${formatCurrency(h.buy_price)}</td><td>${formatCurrency(h.current_price)}</td><td>${formatCurrency(h.currentValue)}</td><td class="${h.profitLoss >= 0 ? 'text-success' : 'text-error'}">${h.profitLoss >= 0 ? '+' : ''}${formatCurrency(h.profitLoss)} (${h.profitLossPercent}%)</td><td><button class="btn btn-sm btn-outline" title="Дивиденд/комиссия" onclick="event.stopPropagation(); showAddEventModal(${h.id}, '${escapeHtmlInv(h.symbol)}')"><i class="fas fa-coins"></i></button> <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); sellInvestment(${h.id})"><i class="fas fa-minus"></i></button></td></tr>`).join('')}</tbody></table></div></div>${allocationCard}${renderFireCard(id)}</div>`; } catch (e) { mainContent.innerHTML = '<div class="alert alert-error">Ошибка</div>'; } }
async function showAddPortfolioModal() { const m = document.createElement('div'); m.className = 'modal-backdrop'; m.innerHTML = `<div class="modal"><div class="modal-header"><h2>Новый портфель</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="portfolio-form"><div class="form-group"><label class="form-label">Название</label><input type="text" name="name" class="form-control" required></div><div class="form-group"><label class="form-label">Описание</label><input type="text" name="description" class="form-control"></div><div class="form-group"><label class="form-label">Валюта</label><select name="currency" class="form-control"><option value="USD">USD</option><option value="EUR">EUR</option><option value="UAH">UAH</option></select></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Отмена</button><button class="btn btn-primary" onclick="savePortfolio()">Создать</button></div></div>`; document.body.appendChild(m); }
async function savePortfolio() { const f = document.getElementById('portfolio-form'); const d = Object.fromEntries(new FormData(f)); try { const r = await fetchWithAuth('/api/investments/portfolios', { method: 'POST', body: JSON.stringify(d) }); if (!r.ok) throw new Error('Ошибка'); document.querySelector('.modal-backdrop').remove(); showNotification('Портфель создан', 'success'); renderInvestmentsPage(); } catch (e) { showNotification(e.message, 'error'); } }
async function showAddInvestmentModal(portfolioId) { const types = await fetchWithAuth('/api/investments/types').then(r => r.json()); const m = document.createElement('div'); m.className = 'modal-backdrop'; m.innerHTML = `<div class="modal"><div class="modal-header"><h2>Новый актив</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="investment-form"><input type="hidden" name="portfolio_id" value="${portfolioId}"><div class="form-row"><div class="form-group"><label class="form-label">Символ</label><input type="text" name="symbol" class="form-control" required placeholder="AAPL"></div><div class="form-group"><label class="form-label">Тип</label><select name="type" class="form-control">${Object.entries(types).map(([k,v]) => `<option value="${v}">${k}</option>`).join('')}</select></div></div><div class="form-group"><label class="form-label">Название</label><input type="text" name="name" class="form-control" required placeholder="Apple Inc."></div><div class="form-row"><div class="form-group"><label class="form-label">Количество</label><input type="number" name="quantity" class="form-control" required min="0.0001" step="0.0001"></div><div class="form-group"><label class="form-label">Цена покупки</label><input type="number" name="buy_price" class="form-control" required min="0.01" step="0.01"></div></div><div class="form-group"><label class="form-label">Дата покупки</label><input type="date" name="buy_date" class="form-control" required value="${new Date().toISOString().split('T')[0]}"></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Отмена</button><button class="btn btn-primary" onclick="saveInvestment()">Добавить</button></div></div>`; document.body.appendChild(m); }
async function saveInvestment() { const f = document.getElementById('investment-form'); const d = Object.fromEntries(new FormData(f)); try { const r = await fetchWithAuth('/api/investments/portfolios/' + d.portfolio_id + '/investments', { method: 'POST', body: JSON.stringify(d) }); if (!r.ok) throw new Error('Ошибка'); document.querySelector('.modal-backdrop').remove(); showNotification('Актив добавлен', 'success'); openPortfolio(parseInt(d.portfolio_id)); } catch (e) { showNotification(e.message, 'error'); } }
async function sellInvestment(id) { const qty = prompt('Количество для продажи:'); if (!qty) return; const price = prompt('Цена продажи:'); if (!price) return; try { const r = await fetchWithAuth('/api/investments/investments/' + id + '/sell', { method: 'POST', body: JSON.stringify({ quantity: parseFloat(qty), price: parseFloat(price) }) }); if (!r.ok) throw new Error('Ошибка'); showNotification('Актив продан', 'success'); renderInvestmentsPage(); } catch (e) { showNotification(e.message, 'error'); } }
// ==================== ЖИВЫЕ ЦЕНЫ (Wave-2 price-feeds) ====================
// Хелпер «крутящейся» кнопки на время запроса.
function _setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.dataset._html = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Обновление...';
  } else {
    btn.disabled = false;
    if (btn.dataset._html) { btn.innerHTML = btn.dataset._html; delete btn.dataset._html; }
  }
}
// Сводка результата обновления цен в уведомление.
function _priceSummaryMsg(res) {
  const u = res && typeof res.updated === 'number' ? res.updated : 0;
  const f = res && typeof res.failed === 'number' ? res.failed : 0;
  if (u === 0 && f === 0) return 'Нет активов для обновления';
  let msg = `Обновлено цен: ${u}`;
  if (f > 0) msg += `, недоступно: ${f}`;
  return msg;
}
// Обновить цены ВСЕХ активов пользователя и перерисовать страницу инвестиций.
async function refreshAllPrices(btn) {
  _setBtnLoading(btn, true);
  try {
    const r = await fetchWithAuth('/api/investments/refresh-prices', { method: 'POST' });
    if (!r.ok) throw new Error('Не удалось обновить цены');
    const data = await r.json();
    showNotification(_priceSummaryMsg(data), data.failed > 0 ? 'warning' : 'success');
    await renderInvestmentsPage();
  } catch (e) {
    showNotification(e.message || 'Ошибка обновления цен', 'error');
    _setBtnLoading(btn, false);
  }
}
// Обновить цены активов конкретного портфеля и перерисовать его.
async function refreshPortfolioPrices(id, btn) {
  _setBtnLoading(btn, true);
  try {
    const r = await fetchWithAuth('/api/investments/portfolios/' + id + '/refresh-prices', { method: 'POST' });
    if (!r.ok) throw new Error('Не удалось обновить цены');
    const data = await r.json();
    showNotification(_priceSummaryMsg(data), data.failed > 0 ? 'warning' : 'success');
    await openPortfolio(id);
  } catch (e) {
    showNotification(e.message || 'Ошибка обновления цен', 'error');
    _setBtnLoading(btn, false);
  }
}

// ==================== INVESTMENT DEPTH (дивиденды/комиссии/аллокация/FIRE) ====================

// Локальное HTML-экранирование (в этом модуле своего ещё не было). Все
// пользовательские данные (символ, заметка) идут в innerHTML через него.
function escapeHtmlInv(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Дивиденды / комиссии: модалка ввода события по активу ---
function showAddEventModal(investmentId, symbol) {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  const sym = escapeHtmlInv(symbol || '');
  m.innerHTML = `<div class="modal"><div class="modal-header"><h2>Событие по активу ${sym}</h2><button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">&times;</button></div><div class="modal-body"><form id="event-form"><input type="hidden" name="investment_id" value="${Number(investmentId)}"><div class="form-group"><label class="form-label">Тип</label><select name="type" class="form-control"><option value="dividend">Дивиденд</option><option value="fee">Комиссия / налог</option><option value="split">Сплит (инфо)</option></select></div><div class="form-group"><label class="form-label">Сумма</label><input type="number" name="amount" class="form-control" min="0" step="0.01" placeholder="0.00"></div><div class="form-group"><label class="form-label">Дата</label><input type="date" name="date" class="form-control" value="${new Date().toISOString().split('T')[0]}"></div><div class="form-group"><label class="form-label">Заметка</label><input type="text" name="note" class="form-control"></div></form></div><div class="modal-footer"><button class="btn btn-outline" onclick="this.closest('.modal-backdrop').remove()">Отмена</button><button class="btn btn-primary" onclick="saveInvestmentEvent()">Сохранить</button></div></div>`;
  document.body.appendChild(m);
}

async function saveInvestmentEvent() {
  const f = document.getElementById('event-form');
  const d = Object.fromEntries(new FormData(f));
  try {
    const r = await fetchWithAuth('/api/investments/investments/' + Number(d.investment_id) + '/events', {
      method: 'POST',
      body: JSON.stringify({ type: d.type, amount: parseFloat(d.amount) || 0, date: d.date, note: d.note })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || 'Ошибка');
    }
    document.querySelector('.modal-backdrop').remove();
    showNotification('Событие сохранено', 'success');
  } catch (e) { showNotification(e.message, 'error'); }
}

// --- Карточка аллокации портфеля (% по типу и по символу) ---
function renderAllocationBar(rows, labelKey) {
  if (!rows || rows.length === 0) return '<p class="text-muted">Нет данных</p>';
  return rows.map(row => {
    const label = escapeHtmlInv(row[labelKey]);
    const pct = Number(row.percent) || 0;
    return `<div class="alloc-row"><div class="alloc-label">${label}</div><div class="alloc-track"><div class="alloc-fill" style="width:${Math.min(pct, 100)}%"></div></div><div class="alloc-pct">${pct}%</div></div>`;
  }).join('');
}

async function renderAllocationCard(portfolioId) {
  try {
    const a = await fetchWithAuth('/api/investments/portfolios/' + Number(portfolioId) + '/allocation').then(r => r.json());
    return `<div class="card alloc-card"><h3><i class="fas fa-chart-pie"></i> Аллокация</h3><div class="alloc-group"><h4>По типу</h4>${renderAllocationBar(a.byType, 'type')}</div><div class="alloc-group"><h4>По активам</h4>${renderAllocationBar(a.bySymbol, 'symbol')}</div></div>`;
  } catch (e) {
    return '<div class="card"><h3>Аллокация</h3><p class="text-error">Ошибка загрузки</p></div>';
  }
}

// --- FIRE-карточка: интерактивный расчёт лет до цели ---
function renderFireCard(portfolioId) {
  return `<div class="card fire-card"><h3><i class="fas fa-fire"></i> FIRE-проекция</h3><div class="form-row"><div class="form-group"><label class="form-label">Взнос/мес</label><input type="number" id="fire-contribution-${portfolioId}" class="form-control" value="500" min="0" step="50"></div><div class="form-group"><label class="form-label">Доходность %</label><input type="number" id="fire-rate-${portfolioId}" class="form-control" value="7" min="0" step="0.5"></div><div class="form-group"><label class="form-label">Цель</label><input type="number" id="fire-target-${portfolioId}" class="form-control" value="1000000" min="0" step="1000"></div></div><button class="btn btn-primary" onclick="calcFire(${Number(portfolioId)})"><i class="fas fa-calculator"></i> Рассчитать</button><div id="fire-result-${portfolioId}" class="fire-result"></div></div>`;
}

async function calcFire(portfolioId) {
  const c = document.getElementById('fire-contribution-' + portfolioId).value || 0;
  const rate = document.getElementById('fire-rate-' + portfolioId).value || 0;
  const target = document.getElementById('fire-target-' + portfolioId).value || 0;
  const out = document.getElementById('fire-result-' + portfolioId);
  out.innerHTML = '<div class="spinner"></div>';
  try {
    const qs = `contribution=${encodeURIComponent(c)}&rate=${encodeURIComponent(rate)}&target=${encodeURIComponent(target)}`;
    const res = await fetchWithAuth('/api/investments/portfolios/' + Number(portfolioId) + '/fire?' + qs).then(r => r.json());
    if (res.reachable) {
      out.innerHTML = `<div class="fire-ok"><strong>${res.years}</strong> лет (${res.months} мес.) до цели ${formatCurrency(res.target)}. Итог: ${formatCurrency(res.finalValue)}.</div>`;
    } else {
      out.innerHTML = `<div class="fire-no">Цель ${formatCurrency(res.target)} недостижима за 100 лет при этих параметрах.</div>`;
    }
  } catch (e) {
    out.innerHTML = '<div class="text-error">Ошибка расчёта</div>';
  }
}

window.showAddPortfolioModal = showAddPortfolioModal; window.savePortfolio = savePortfolio; window.openPortfolio = openPortfolio; window.showAddInvestmentModal = showAddInvestmentModal; window.saveInvestment = saveInvestment; window.sellInvestment = sellInvestment; window.refreshAllPrices = refreshAllPrices; window.refreshPortfolioPrices = refreshPortfolioPrices;
window.showAddEventModal = showAddEventModal; window.saveInvestmentEvent = saveInvestmentEvent; window.renderAllocationCard = renderAllocationCard; window.renderFireCard = renderFireCard; window.calcFire = calcFire;
