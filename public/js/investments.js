// ==================== INVESTMENTS ====================
// Portfolios carry their own currency: every portfolio figure is formatted
// with it. The overview totals come from the API summed across portfolios,
// so they show a currency only when all portfolios share one.
// Requires: lib/ui.js (window.UI), app.js (fetchWithAuth, showNotification).

async function renderInvestmentsPage() {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    await UI.loadBaseCurrency();
    const stats = await fetchWithAuth('/api/investments/stats').then(r => r.json());
    const portfolios = Array.isArray(stats.portfolios) ? stats.portfolios : [];
    const currencies = UI.uniqueCurrencies(portfolios.map(p => p.currency));
    const total = (v) => UI.esc(UI.aggregateMoney(v || 0, currencies));
    const plPositive = (stats.totalProfitLoss || 0) >= 0;
    mainContent.innerHTML = `
      <div class="investments-page">
        <div class="page-header">
          <h1><i class="fas fa-chart-line"></i> Инвестиции</h1>
          <div class="page-actions">
            <button type="button" class="btn btn-outline" data-action="inv:refresh-all"><i class="fas fa-sync-alt"></i> Обновить цены</button>
            <button type="button" class="btn btn-primary" data-action="inv:add-portfolio"><i class="fas fa-plus"></i> Новый портфель</button>
          </div>
        </div>
        ${UI.mixedCurrencyNote(currencies, 'Портфели')}
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-icon"><i class="fas fa-wallet"></i></div><div class="stat-data"><div class="stat-value">${total(stats.totalValue)}</div><div class="stat-label">Общая стоимость</div></div></div>
          <div class="stat-card ${plPositive ? 'stat-ok' : 'stat-over'}"><div class="stat-icon"><i class="fas fa-${plPositive ? 'arrow-up' : 'arrow-down'}"></i></div><div class="stat-data"><div class="stat-value">${plPositive ? '+' : ''}${total(stats.totalProfitLoss)}</div><div class="stat-label">Прибыль/убыток (${UI.esc(stats.totalProfitLossPercent)}%)</div></div></div>
        </div>
        <div class="card-grid" id="portfolios-list">
          ${portfolios.length === 0
            ? UI.emptyState({ icon: 'fa-chart-line', title: 'Нет портфелей', text: 'Создайте портфель и добавьте активы — стоимость, прибыль и аллокация считаются автоматически.', action: { label: 'Новый портфель', action: 'inv:add-portfolio', icon: 'fa-plus' } })
            : portfolios.map(p => renderPortfolioCard(p)).join('')}
        </div>
      </div>`;
  } catch (e) {
    console.error('investments:', e);
    mainContent.innerHTML = '<div class="alert alert-error">Ошибка загрузки</div>';
  }
}

function renderPortfolioCard(p) {
  const pl = Number(p.totalProfitLoss) || 0;
  return `
    <div class="card" data-action="inv:open" data-id="${Number(p.id)}" role="button" tabindex="0">
      <div class="card-header"><h3 class="card-title"><i class="fas fa-briefcase"></i> ${UI.esc(p.name)}</h3></div>
      <p>Стоимость: ${UI.esc(UI.money(p.totalValue, p.currency))}</p>
      <p class="${pl >= 0 ? 'text-success' : 'text-error'}">${pl >= 0 ? '+' : ''}${UI.esc(UI.money(pl, p.currency))} (${UI.esc(p.totalProfitLossPercent)}%)</p>
    </div>`;
}

async function openPortfolio(id) {
  const mainContent = document.getElementById('main-content');
  mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const portfolio = await fetchWithAuth('/api/investments/portfolios/' + Number(id)).then(r => r.json());
    const allocationCard = await renderAllocationCard(id);
    const cur = portfolio.currency || UI.baseCurrency();
    const money = (v, c) => UI.esc(UI.money(v || 0, c || cur));
    const esc = UI.esc;
    const netPL = (typeof portfolio.totalNetProfitLoss === 'number') ? portfolio.totalNetProfitLoss : portfolio.totalProfitLoss;
    const divLine = (typeof portfolio.totalDividends === 'number' && portfolio.totalDividends > 0)
      ? `<div class="stat-card stat-ok"><div class="stat-data"><div class="stat-value">+${money(portfolio.totalDividends)}</div><div class="stat-label">Дивиденды</div></div></div>`
      : '';
    const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
    mainContent.innerHTML = `
      <div class="investments-page">
        <div class="page-header">
          <button type="button" class="btn btn-outline" data-action="inv:back" aria-label="Назад к портфелям"><i class="fas fa-arrow-left"></i></button>
          <h1>${esc(portfolio.name)} <small class="text-secondary">${esc(cur)}</small></h1>
          <div class="page-actions">
            <button type="button" class="btn btn-outline" data-action="inv:refresh-portfolio" data-id="${Number(id)}"><i class="fas fa-sync-alt"></i> Обновить цены</button>
            <button type="button" class="btn btn-primary" data-action="inv:add-investment" data-id="${Number(id)}"><i class="fas fa-plus"></i> Добавить актив</button>
          </div>
        </div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(portfolio.totalValue)}</div><div class="stat-label">Стоимость</div></div></div>
          <div class="stat-card"><div class="stat-data"><div class="stat-value">${money(portfolio.totalCost)}</div><div class="stat-label">Вложено</div></div></div>
          <div class="stat-card ${portfolio.totalProfitLoss >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-data"><div class="stat-value">${portfolio.totalProfitLoss >= 0 ? '+' : ''}${money(portfolio.totalProfitLoss)}</div><div class="stat-label">P/L (${esc(portfolio.totalProfitLossPercent)}%)</div></div></div>
          <div class="stat-card ${netPL >= 0 ? 'stat-ok' : 'stat-over'}"><div class="stat-data"><div class="stat-value">${netPL >= 0 ? '+' : ''}${money(netPL)}</div><div class="stat-label">Чистый P/L</div></div></div>
          ${divLine}
        </div>
        <div class="card"><h3>Активы</h3>
          <div class="table-container">
            <table class="table">
              <thead><tr><th>Символ</th><th>Кол-во</th><th>Цена покупки</th><th>Текущая цена</th><th>Стоимость</th><th>P/L</th><th></th></tr></thead>
              <tbody>
                ${holdings.map(h => `<tr>
                  <td><strong>${esc(h.symbol)}</strong><br><small>${esc(h.name)}</small></td>
                  <td>${esc(h.quantity)}</td>
                  <td>${money(h.buy_price, h.currency)}</td>
                  <td>${money(h.current_price, h.currency)}</td>
                  <td>${money(h.currentValue, h.currency)}</td>
                  <td class="${h.profitLoss >= 0 ? 'text-success' : 'text-error'}">${h.profitLoss >= 0 ? '+' : ''}${money(h.profitLoss, h.currency)} (${esc(h.profitLossPercent)}%)</td>
                  <td>
                    <button type="button" class="btn btn-sm btn-outline" title="Дивиденд/комиссия" aria-label="Дивиденд или комиссия" data-action="inv:add-event" data-id="${Number(h.id)}" data-symbol="${esc(h.symbol)}" data-stop><i class="fas fa-coins"></i></button>
                    <button type="button" class="btn btn-sm btn-danger" title="Продать" aria-label="Продать" data-action="inv:sell" data-id="${Number(h.id)}" data-stop><i class="fas fa-minus"></i></button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="7" class="text-secondary">В портфеле пока нет активов</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
        ${allocationCard}
        ${renderFireCard(id, cur)}
      </div>`;
  } catch (e) {
    console.error('portfolio:', e);
    mainContent.innerHTML = '<div class="alert alert-error">Ошибка</div>';
  }
}

function showAddPortfolioModal() {
  UI.modal({
    id: 'portfolio-modal',
    title: 'Новый портфель',
    body: `
      <form id="portfolio-form" data-submit="inv:save-portfolio">
        <div class="form-group"><label class="form-label" for="pf-name">Название</label><input type="text" id="pf-name" name="name" class="form-control" required></div>
        <div class="form-group"><label class="form-label" for="pf-description">Описание</label><input type="text" id="pf-description" name="description" class="form-control"></div>
        <div class="form-group"><label class="form-label" for="pf-currency">Валюта</label><select id="pf-currency" name="currency" class="form-control">${UI.currencyOptions('USD')}</select></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Создать</button>
        </div>
      </form>`
  });
}

async function savePortfolio(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/investments/portfolios', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error('Ошибка');
    UI.closeModal('portfolio-modal');
    showNotification('Портфель создан', 'success');
    renderInvestmentsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

async function showAddInvestmentModal(portfolioId) {
  const types = await fetchWithAuth('/api/investments/types').then(r => r.json());
  UI.modal({
    id: 'investment-modal',
    title: 'Новый актив',
    body: `
      <form id="investment-form" data-submit="inv:save-investment">
        <input type="hidden" name="portfolio_id" value="${Number(portfolioId)}">
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="inv-symbol">Символ</label><input type="text" id="inv-symbol" name="symbol" class="form-control" required placeholder="AAPL"></div>
          <div class="form-group"><label class="form-label" for="inv-type">Тип</label><select id="inv-type" name="type" class="form-control">${Object.entries(types || {}).map(([k, v]) => `<option value="${UI.esc(v)}">${UI.esc(k)}</option>`).join('')}</select></div>
        </div>
        <div class="form-group"><label class="form-label" for="inv-name">Название</label><input type="text" id="inv-name" name="name" class="form-control" required placeholder="Apple Inc."></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="inv-qty">Количество</label><input type="number" id="inv-qty" name="quantity" class="form-control" required min="0.0001" step="0.0001"></div>
          <div class="form-group"><label class="form-label" for="inv-price">Цена покупки</label><input type="number" id="inv-price" name="buy_price" class="form-control" required min="0.01" step="0.01"></div>
        </div>
        <div class="form-group"><label class="form-label" for="inv-date">Дата покупки</label><input type="date" id="inv-date" name="buy_date" class="form-control" required value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Добавить</button>
        </div>
      </form>`
  });
}

async function saveInvestment(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/investments/portfolios/' + Number(d.portfolio_id) + '/investments', { method: 'POST', body: JSON.stringify(d) });
    if (!r.ok) throw new Error('Ошибка');
    UI.closeModal('investment-modal');
    showNotification('Актив добавлен', 'success');
    openPortfolio(parseInt(d.portfolio_id, 10));
  } catch (e) { showNotification(e.message, 'error'); }
}

async function sellInvestment(id) {
  const qty = prompt('Количество для продажи:');
  if (!qty) return;
  const price = prompt('Цена продажи:');
  if (!price) return;
  try {
    const r = await fetchWithAuth('/api/investments/investments/' + Number(id) + '/sell', { method: 'POST', body: JSON.stringify({ quantity: parseFloat(qty), price: parseFloat(price) }) });
    if (!r.ok) throw new Error('Ошибка');
    showNotification('Актив продан', 'success');
    renderInvestmentsPage();
  } catch (e) { showNotification(e.message, 'error'); }
}

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
    const r = await fetchWithAuth('/api/investments/portfolios/' + Number(id) + '/refresh-prices', { method: 'POST' });
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

// Локальное HTML-экранирование оставлено для обратной совместимости (делегирует в UI.esc).
function escapeHtmlInv(text) {
  return UI.esc(text);
}

// --- Дивиденды / комиссии: модалка ввода события по активу ---
function showAddEventModal(investmentId, symbol) {
  const sym = escapeHtmlInv(symbol || '');
  UI.modal({
    id: 'investment-event-modal',
    title: `Событие по активу ${symbol || ''}`,
    body: `
      <form id="investment-event-form" data-submit="inv:save-event">
        <input type="hidden" name="investment_id" value="${Number(investmentId)}">
        <div class="form-group"><label class="form-label" for="ev-type">Тип</label><select id="ev-type" name="type" class="form-control"><option value="dividend">Дивиденд</option><option value="fee">Комиссия / налог</option><option value="split">Сплит (инфо)</option></select></div>
        <div class="form-group"><label class="form-label" for="ev-amount">Сумма</label><input type="number" id="ev-amount" name="amount" class="form-control" min="0" step="0.01" placeholder="0.00"></div>
        <div class="form-group"><label class="form-label" for="ev-date">Дата</label><input type="date" id="ev-date" name="date" class="form-control" value="${new Date().toISOString().split('T')[0]}"></div>
        <div class="form-group"><label class="form-label" for="ev-note">Заметка</label><input type="text" id="ev-note" name="note" class="form-control" aria-describedby="ev-sym"><small id="ev-sym" class="text-secondary">${sym}</small></div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" data-action="ui:close">Отмена</button>
          <button type="submit" class="btn btn-primary">Сохранить</button>
        </div>
      </form>`
  });
}

async function saveInvestmentEvent(form) {
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await fetchWithAuth('/api/investments/investments/' + Number(d.investment_id) + '/events', {
      method: 'POST',
      body: JSON.stringify({ type: d.type, amount: parseFloat(d.amount) || 0, date: d.date, note: d.note })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || 'Ошибка');
    }
    UI.closeModal('investment-event-modal');
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

// --- FIRE-карточка: интерактивный расчёт лет до цели (в валюте портфеля) ---
function renderFireCard(portfolioId, currency) {
  const pid = Number(portfolioId);
  const cur = UI.esc(currency || UI.baseCurrency());
  return `<div class="card fire-card"><h3><i class="fas fa-fire"></i> FIRE-проекция <small class="text-secondary">${cur}</small></h3>
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="fire-contribution-${pid}">Взнос/мес</label><input type="number" id="fire-contribution-${pid}" class="form-control" value="500" min="0" step="50"></div>
      <div class="form-group"><label class="form-label" for="fire-rate-${pid}">Доходность %</label><input type="number" id="fire-rate-${pid}" class="form-control" value="7" min="0" step="0.5"></div>
      <div class="form-group"><label class="form-label" for="fire-target-${pid}">Цель</label><input type="number" id="fire-target-${pid}" class="form-control" value="1000000" min="0" step="1000"></div>
    </div>
    <button type="button" class="btn btn-primary" data-action="inv:fire" data-id="${pid}" data-currency="${cur}"><i class="fas fa-calculator"></i> Рассчитать</button>
    <div id="fire-result-${pid}" class="fire-result"></div></div>`;
}

async function calcFire(portfolioId, currency) {
  const c = document.getElementById('fire-contribution-' + portfolioId).value || 0;
  const rate = document.getElementById('fire-rate-' + portfolioId).value || 0;
  const target = document.getElementById('fire-target-' + portfolioId).value || 0;
  const out = document.getElementById('fire-result-' + portfolioId);
  out.innerHTML = '<div class="spinner"></div>';
  const money = (v) => UI.esc(UI.money(v, currency));
  try {
    const qs = `contribution=${encodeURIComponent(c)}&rate=${encodeURIComponent(rate)}&target=${encodeURIComponent(target)}`;
    const res = await fetchWithAuth('/api/investments/portfolios/' + Number(portfolioId) + '/fire?' + qs).then(r => r.json());
    if (res.reachable) {
      out.innerHTML = `<div class="fire-ok"><strong>${Number(res.years)}</strong> лет (${Number(res.months)} мес.) до цели ${money(res.target)}. Итог: ${money(res.finalValue)}.</div>`;
    } else {
      out.innerHTML = `<div class="fire-no">Цель ${money(res.target)} недостижима за 100 лет при этих параметрах.</div>`;
    }
  } catch (e) {
    out.innerHTML = '<div class="text-error">Ошибка расчёта</div>';
  }
}

// Регистрация делегированных обработчиков. lib/ui.js подключён в index.html
// после app.js; если он окажется ниже этого модуля — регистрируемся на DOMContentLoaded.
(function registerActions() {
  if (typeof window === 'undefined') return;
  if (!window.UI) { document.addEventListener('DOMContentLoaded', registerActions, { once: true }); return; }
  UI.actions({
    'inv:add-portfolio': () => showAddPortfolioModal(),
    'inv:save-portfolio': (form) => savePortfolio(form),
    'inv:open': (el) => openPortfolio(Number(el.dataset.id)),
    'inv:back': () => renderInvestmentsPage(),
    'inv:refresh-all': (el) => refreshAllPrices(el),
    'inv:refresh-portfolio': (el) => refreshPortfolioPrices(Number(el.dataset.id), el),
    'inv:add-investment': (el) => showAddInvestmentModal(Number(el.dataset.id)),
    'inv:save-investment': (form) => saveInvestment(form),
    'inv:sell': (el) => sellInvestment(Number(el.dataset.id)),
    'inv:add-event': (el) => showAddEventModal(Number(el.dataset.id), el.dataset.symbol),
    'inv:save-event': (form) => saveInvestmentEvent(form),
    'inv:fire': (el) => calcFire(Number(el.dataset.id), el.dataset.currency),
  });
  window.showAddPortfolioModal = showAddPortfolioModal; window.savePortfolio = savePortfolio; window.openPortfolio = openPortfolio; window.showAddInvestmentModal = showAddInvestmentModal; window.saveInvestment = saveInvestment; window.sellInvestment = sellInvestment; window.refreshAllPrices = refreshAllPrices; window.refreshPortfolioPrices = refreshPortfolioPrices;
  window.showAddEventModal = showAddEventModal; window.saveInvestmentEvent = saveInvestmentEvent; window.renderAllocationCard = renderAllocationCard; window.renderFireCard = renderFireCard; window.calcFire = calcFire;
})();
