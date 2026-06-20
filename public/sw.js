// public/sw.js — Wave-2 "offline-sync" service worker.
//
// Стратегия кэширования:
//   - APP SHELL: precache статики при install (как было), + offline.js.
//   - НАВИГАЦИЯ: network-first -> при офлайне отдаём кэш index.html (app shell).
//   - СТАТИКА (GET, тот же origin): stale-while-revalidate — мгновенно из кэша,
//     обновление в фоне.
//   - /api/* : NETWORK-FIRST. GET-ответы кэшируем как "последнее известное"
//     значение и отдаём из кэша при офлайне; не-GET (POST/PUT/DELETE) при
//     офлайне возвращают понятный JSON-флаг offline:true, чтобы клиент положил
//     запись в IndexedDB-очередь (см. public/js/offline.js).
//   - BACKGROUND SYNC: тег 'sync-transactions' будит клиентов сообщением
//     { type:'replay-queue' } — реальная отправка очереди живёт в странице
//     (там есть localStorage-токен и доступ к IndexedDB-очереди).
//
// Версия кэша поднята до v2; activate чистит все НЕ-текущие кэши (старый
// finman-v1 будет удалён автоматически — существующее поведение не ломается).

const CACHE_VERSION = 'finman-v2';
const STATIC_CACHE = CACHE_VERSION + '-static';
const API_CACHE = CACHE_VERSION + '-api';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
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
  '/js/offline.js',
  '/manifest.json'
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
          .filter(key => key !== STATIC_CACHE && key !== API_CACHE)
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

// NETWORK-FIRST для /api: свежие данные, кэш как фолбэк (для GET).
async function apiNetworkFirst(request) {
  const url = new URL(request.url);
  try {
    const response = await fetch(request);
    // Кэшируем только успешные GET — это "последнее известное" состояние.
    if (request.method === 'GET' && response && response.ok) {
      const clone = response.clone();
      caches.open(API_CACHE).then(cache => cache.put(request, clone)).catch(() => {});
    }
    return response;
  } catch (err) {
    // Офлайн. Для GET пробуем кэш.
    if (request.method === 'GET') {
      const cached = await caches.match(request);
      if (cached) return cached;
    }
    // Для мутаций — сигналим клиенту, что мы офлайн и запись надо поставить
    // в очередь. Создание транзакций перехватывает offline.js на странице.
    const isTxCreate =
      request.method === 'POST' && url.pathname.replace(/\/+$/, '') === '/api/transactions';
    return new Response(
      JSON.stringify({
        error: true,
        offline: true,
        queued: isTxCreate,
        message: 'Нет подключения к сети. Изменение сохранено локально и будет синхронизировано.'
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
    return new Response('Офлайн', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
    event.respondWith(apiNetworkFirst(request));
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
    self.registration.showNotification(data.title || 'ФинМенеджер', {
      body: data.body || 'Новое уведомление',
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
