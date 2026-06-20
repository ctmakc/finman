// ==================== BILLING / ПОДПИСКА ====================
// Панель тарифов и апгрейда. Использует общие хелперы из app.js
// (fetchWithAuth, showNotification, formatCurrency) с защитным фолбэком,
// т.к. /api/billing/plans — публичный и может вызываться до логина.

(function () {
  'use strict';

  // --- Защитные обёртки над общими хелперами (feature-detect) -------------
  function _notify(msg, type) {
    if (typeof showNotification === 'function') return showNotification(msg, type);
    // фолбэк, если app.js ещё не загрузил хелпер
    try { console[type === 'error' ? 'error' : 'log']('[billing]', msg); } catch (e) { /* noop */ }
  }

  function _money(amount, currency) {
    if (typeof formatCurrency === 'function') return formatCurrency(amount, currency);
    const cur = (currency || 'USD').toUpperCase();
    return `${Number(amount || 0).toFixed(2)} ${cur}`;
  }

  // Аутентифицированный fetch, если доступен; иначе обычный fetch (для /plans).
  async function _fetch(url, options = {}) {
    if (typeof fetchWithAuth === 'function' && localStorage.getItem('token')) {
      return fetchWithAuth(url, options);
    }
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    return fetch(url, Object.assign({}, options, { headers }));
  }

  // Разворачивает унифицированный ответ { success, data, _meta } или сырой объект.
  function _unwrap(json) {
    if (json && typeof json === 'object' && 'success' in json) {
      return { data: json.data || {}, meta: (json.data && json.data._meta) || json._meta || {} };
    }
    return { data: json || {}, meta: (json && json._meta) || {} };
  }

  // --- Загрузка тарифов ---------------------------------------------------
  async function loadPlans() {
    const resp = await _fetch('/api/billing/plans');
    const json = await resp.json();
    const { data, meta } = _unwrap(json);
    const plans = (data && data.plans) || (Array.isArray(data) ? data : []);
    return { plans, meta };
  }

  // --- Рендер страницы тарифов -------------------------------------------
  async function renderBillingPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    mainContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const { plans, meta } = await loadPlans();
      const currentTier = _currentUserTier();
      const disabledBanner = meta && meta.billingConfigured === false
        ? `<div class="alert alert-warning"><i class="fas fa-info-circle"></i> Онлайн-оплата сейчас в демо-режиме (Stripe не настроен). Кнопки апгрейда покажут предупреждение, реальная оплата не произойдёт.</div>`
        : '';
      mainContent.innerHTML = `
        <div class="billing-page">
          <div class="page-header">
            <h1><i class="fas fa-crown"></i> Тарифы и подписка</h1>
          </div>
          ${disabledBanner}
          <div class="card-grid billing-plans">
            ${plans.map((p) => _renderPlanCard(p, currentTier)).join('')}
          </div>
        </div>`;
    } catch (e) {
      mainContent.innerHTML = '<div class="alert alert-error">Не удалось загрузить тарифы</div>';
    }
  }

  function _currentUserTier() {
    try {
      if (typeof appState !== 'undefined' && appState && appState.user && appState.user.subscription_tier) {
        return appState.user.subscription_tier;
      }
    } catch (e) { /* noop */ }
    return 'free';
  }

  function _renderPlanCard(p, currentTier) {
    const isCurrent = p.tier === currentTier || p.id === currentTier;
    const priceLabel = p.price > 0 ? `${_money(p.price, p.currency)}/мес` : 'Бесплатно';
    const features = (p.features || []).map((f) => `<li><i class="fas fa-check"></i> ${f}</li>`).join('');
    let action;
    if (isCurrent) {
      action = `<button class="btn btn-outline" disabled>Текущий план</button>`;
    } else if (p.tier === 'free' || p.id === 'free') {
      action = `<button class="btn btn-outline" disabled>Базовый</button>`;
    } else {
      action = `<button class="btn btn-primary" onclick="startCheckout('${p.id}')"><i class="fas fa-arrow-up"></i> Перейти на ${p.name}</button>`;
    }
    return `
      <div class="card billing-plan ${isCurrent ? 'billing-plan-current' : ''}">
        <div class="card-header"><h3 class="card-title">${p.name}</h3></div>
        <div class="billing-price">${priceLabel}</div>
        <ul class="billing-features">${features}</ul>
        <div class="card-footer">${action}</div>
      </div>`;
  }

  // --- Запуск оплаты ------------------------------------------------------
  async function startCheckout(planId) {
    try {
      const resp = await _fetch('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: planId }),
      });
      const json = await resp.json().catch(() => ({}));

      if (resp.status === 503 || (json && json.error && json.error.code === 'BILLING_DISABLED')) {
        _notify('Онлайн-оплата сейчас недоступна (демо-режим). Stripe не настроен на сервере.', 'error');
        return;
      }
      if (resp.status === 401) {
        _notify('Войдите в аккаунт, чтобы оформить подписку', 'error');
        return;
      }
      if (!resp.ok) {
        const msg = (json && json.error && json.error.message) || 'Не удалось начать оплату';
        _notify(msg, 'error');
        return;
      }

      const data = (json && json.data) || {};
      if (data.url) {
        window.location.href = data.url; // редирект на Stripe Checkout
      } else {
        _notify('Сессия оплаты создана, но ссылка не получена', 'error');
      }
    } catch (e) {
      _notify('Ошибка при создании сессии оплаты', 'error');
    }
  }

  // --- Экспорт в глобальную область (как другие feature-файлы) ------------
  window.renderBillingPage = renderBillingPage;
  window.startCheckout = startCheckout;
  window.loadBillingPlans = loadPlans;
})();
