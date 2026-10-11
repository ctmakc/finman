// lib/demoFlag.js — единый источник правды о «демо/мок» режиме.
//
// Назначение: некоторые фичи (биллинг Stripe, AI-провайдер) могут быть НЕ
// настроены в окружении (нет ключей). Вместо того чтобы делать вид, что они
// работают, мы помечаем такие ответы как demo/disabled — честно и явно, чтобы
// фронтенд и тесты могли это отличить от реальных данных.
//
// Экспорт:
//   isDemo()                       -> boolean   (включён ли глобальный демо-режим)
//   annotate(data, meta)           -> object    (добавляет блок _meta к ответу)
//   demoNotice(feature, reason)    -> object    (готовый _meta для отключённой фичи)
//   isSeedOnEmpty()                -> boolean   (DEMO_SEED_ON_EMPTY: засеять демо-данные в пустую БД)
//   demoPassword()                 -> string    (DEMO_PASSWORD, по умолчанию 'finman-demo-2026')
//   DEMO_USER / DEMO_PARTNER       -> объекты   (логин/почта демо-пользователей, lib/demoSeed.js)

'use strict';

// Истинные значения env-флагов: 1/true/yes/on (без учёта регистра).
function truthy(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Глобальный демо-режим через env DEMO_MODE (1/true/yes/on).
function isDemo() {
  return truthy(process.env.DEMO_MODE);
}

// DEMO_SEED_ON_EMPTY: при старте, если таблица users пуста, засеять демо-хозяйство
// (lib/demoSeed.js). Нужно staging-у без постоянного volume: SQLite там
// обнуляется на каждом деплое, а жюри/инвесторам нужен живой кабинет.
function isSeedOnEmpty() {
  return truthy(process.env.DEMO_SEED_ON_EMPTY);
}

const DEFAULT_DEMO_PASSWORD = 'finman-demo-2026';

// Пароль демо-пользователей. Публичный по замыслу (демо-стенд), но переопределяем.
function demoPassword() {
  const v = String(process.env.DEMO_PASSWORD || '').trim();
  return v || DEFAULT_DEMO_PASSWORD;
}

const DEMO_USER = Object.freeze({
  username: 'demo',
  email: 'demo@finman.money',
  fullName: 'Alex Demo',
});

const DEMO_PARTNER = Object.freeze({
  username: 'demo-partner',
  email: 'demo-partner@finman.money',
  fullName: 'Sam Demo',
});

// Добавляет/мерджит служебный блок _meta к payload-у ответа.
// Не мутирует исходный объект. Если data — не объект (массив/строка/число),
// оборачиваем в { items|value, _meta }, чтобы аннотация всегда доезжала.
function annotate(data, meta = {}) {
  const base = {
    demo: isDemo(),
    ...meta,
  };

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...data, _meta: { ...(data._meta || {}), ...base } };
  }
  if (Array.isArray(data)) {
    return { items: data, _meta: base };
  }
  return { value: data, _meta: base };
}

// Готовый _meta-блок для «фича выключена / работает в мок-режиме».
// Используется, когда реальный провайдер (Stripe/AI) не сконфигурирован.
function demoNotice(feature, reason = 'not configured') {
  return {
    demo: true,
    mode: 'disabled',
    feature,
    reason,
    message: `Feature "${feature}" is running in demo/disabled mode (${reason}). No real action was performed.`,
  };
}

module.exports = {
  truthy,
  isDemo,
  isSeedOnEmpty,
  demoPassword,
  DEFAULT_DEMO_PASSWORD,
  DEMO_USER,
  DEMO_PARTNER,
  annotate,
  demoNotice,
};
