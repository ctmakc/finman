// public/sw.js — Wave-2 "offline-sync" service worker.
//
// Стратегия кэширования:
//   - APP SHELL: precache статики при install (как было), + offline.js.
//   - НАВИГАЦИЯ: network-first -> при офлайне отдаём кэш index.html (app shell).
//   - СТАТИКА (GET, тот же origin): stale-while-revalidate — мгновенно из кэша,
//     обновление в фоне.
//   - /api/* : NETWORK-ONLY. Ответы API персональные (Bearer-токен), а Cache
//     API ключует только по URL: кэш отдавал бы данные прошлого пользователя
//     следующему на том же устройстве. Поэтому /api НЕ кэшируется; при офлайне
//     любой запрос получает 503 JSON { offline:true } — POST /api/transactions
//     страница сама кладёт в IndexedDB-очередь (transactions.js → offline.js).
//   - BACKGROUND SYNC: тег 'sync-transactions' будит клиентов сообщением
//     { type:'replay-queue' } — реальная отправка очереди живёт в странице
//     (там есть localStorage-токен и доступ к IndexedDB-очереди).
//
// Версия кэша v4 (review/fix-fe: /api больше не кэшируется, + lib/ui.js в
// precache); activate удаляет все НЕ-текущие кэши, включая старый finman-v3-api
// с ответами API.

const CACHE_VERSION = 'finman-v5';
const STATIC_CACHE = CACHE_VERSION + '-static';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/css/style.css',
  '/css/parts/dashboard.css',
  '/css/parts/transactions.css',
  '/css/parts/finance.css',
  '/css/parts/ai.css',
  '/vendor/chart.min.js',
  '/vendor/fa.min.css',
  '/vendor/webfonts/fa-solid-900.woff2',
  '/vendor/webfonts/fa-regular-400.woff2',
  '/vendor/webfonts/fa-brands-400.woff2',
  '/js/locales/en.js',
  '/js/locales/uk.js',
  '/js/locales/ru.js',
  '/js/i18n.js',
  '/js/theme.js',
  '/js/lib/a11y.js',
  '/js/app.js',
  '/js/lib/ui.js',
  '/js/auth.js',
  '/js/accounts.js',
  '/js/transactions.js',
  '/js/budgets.js',
  '/js/family.js',
  '/js/recurring.js',
  '/js/currency.js',
  '/js/goals.js',
  '/js/debts.js',
  '/js/split.js',
  '/js/investments.js',
  '/js/analytics.js',
  '/js/subscriptions.js',
  '/js/networth.js',
  '/js/receipts.js',
  '/js/calendar.js',
  '/js/reports.js',
  '/js/forecast.js',
  '/js/dashboard.js',
  '/js/bank-api.js',
  '/js/charts.js',
  '/js/ai.js',
  '/js/widgets.js',
  '/js/onboarding.js',
  '/js/offline.js',
  '/js/data-export.js',
  '/js/rules.js',
  '/js/reconcile.js',
  '/js/api-tokens.js',
  '/js/billing.js',
];

// Install — precache app shell. Используем addAll по одному с защитой, чтобы
// один отсутствующий ресурс не валил весь install (новые wave-2 файлы могут
// появляться/исчезать у разных стримов).
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        return Promise.all(
          STATIC_ASSETS.map(url =>
            cache.add(url).catch(() => {
              // тихо пропускаем недоступный ресурс
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Activate — удаляем все кэши, не относящиеся к текущей версии.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// -------------------------------------------------------------------------
// Fetch-стратегии
// -------------------------------------------------------------------------

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

// NETWORK-ONLY для /api (персональные данные не кэшируем). Офлайн -> 503
// { offline:true }. queueable подсказывает странице, что этот запрос она
// может положить в офлайн-очередь; сам SW ничего не сохраняет, поэтому и не
// обещает пользователю, что изменение сохранено.
async function apiNetworkOnly(request) {
  const url = new URL(request.url);
  try {
    return await fetch(request);
  } catch (err) {
    const queueable =
      request.method === 'POST' && url.pathname.replace(/\/+$/, '') === '/api/transactions';
    return new Response(
      JSON.stringify({
        error: true,
        offline: true,
        queued: false,
        queueable,
        message: 'You are offline. This change was not sent; please try again when you reconnect.'
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// NETWORK-FIRST для навигации: при офлайне — app shell из кэша.
async function navigationNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// STALE-WHILE-REVALIDATE для статики: отдаём кэш, обновляем в фоне.
async function staticStaleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(response => {
      if (response && response.ok && request.method === 'GET') {
        const clone = response.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(request, clone)).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // не ждём сеть — обновление пойдёт в фоне
    return cached;
  }
  const fromNet = await network;
  if (fromNet) return fromNet;
  // последний фолбэк для навигаций
  if (request.mode === 'navigate') {
    const shell = await caches.match('/index.html');
    if (shell) return shell;
  }
  return new Response('', { status: 504 });
}

self.addEventListener('fetch', event => {
  const { request } = event;

  // Не вмешиваемся в не-GET к не-API (например, OPTIONS) и в кросс-схемы.
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(apiNetworkOnly(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  // Прочие GET того же origin — stale-while-revalidate.
  if (request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(staticStaleWhileRevalidate(request));
    return;
  }
  // Остальное (кросс-origin GET, напр. CDN) — сеть с фолбэком в кэш.
  if (request.method === 'GET') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then(c => c || new Response('', { status: 504 })))
    );
  }
});

// -------------------------------------------------------------------------
// Background Sync — будит клиентов, чтобы они проиграли очередь.
// -------------------------------------------------------------------------

self.addEventListener('sync', event => {
  if (event.tag === 'sync-transactions') {
    event.waitUntil(notifyClientsToReplay());
  }
});

async function notifyClientsToReplay() {
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of all) {
    client.postMessage({ type: 'replay-queue', tag: 'sync-transactions' });
  }
  // Если открытых окон нет, ничего не делаем: при следующем открытии страница
  // сама догонит очередь на событии 'online'/'load' (см. offline.js controller).
}

// Сообщения от страницы (например, ручной триггер sync или skipWaiting).
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'clear-api-cache') {
    // Logout: drop any API responses an older SW version may have cached.
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.filter(k => /-api$/.test(k)).map(k => caches.delete(k))))
        .catch(() => {})
    );
  } else if (data.type === 'trigger-sync') {
    // Зарегистрировать background sync по запросу страницы.
    if (self.registration && self.registration.sync) {
      self.registration.sync.register('sync-transactions').catch(() => {});
    }
  }
});

// -------------------------------------------------------------------------
// Push-уведомления (существующее поведение — без изменений).
// -------------------------------------------------------------------------

self.addEventListener('push', event => {
  const data = (event.data && event.data.json && event.data.json()) || {};

  event.waitUntil(
    self.registration.showNotification(data.title || 'Finman', {
      body: data.body || 'New notification',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      data: data.url || '/'
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data)
  );
});
