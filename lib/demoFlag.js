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

'use strict';

// Глобальный демо-режим через env DEMO_MODE (1/true/yes/on).
function isDemo() {
  const v = String(process.env.DEMO_MODE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

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

module.exports = { isDemo, annotate, demoNotice };
