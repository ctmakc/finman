const CACHE_NAME = 'finman-v8';
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
  '/js/ai-insights.js',
  '/js/ai-chat.js',
  '/manifest.json'
];

// Install - cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests - network only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return new Response(JSON.stringify({
            error: true,
            message: 'Нет подключения к сети'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // Static assets - cache first
  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          // Return cached, but also fetch and update cache
          fetch(request).then(response => {
            if (response.ok) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, response);
              });
            }
          }).catch(() => {});
          return cached;
        }

        // Not in cache - fetch from network
        return fetch(request)
          .then(response => {
            if (response.ok && request.method === 'GET') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, clone);
              });
            }
            return response;
          })
          .catch(() => {
            // Offline fallback for navigation
            if (request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
      })
  );
});

// Background sync for offline transactions
self.addEventListener('sync', event => {
  if (event.tag === 'sync-transactions') {
    event.waitUntil(syncTransactions());
  }
});

async function syncTransactions() {
  // Get pending transactions from IndexedDB and sync
  console.log('Syncing offline transactions...');
}

// Push notifications
self.addEventListener('push', event => {
  const data = event.data?.json() || {};

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
    clients.openWindow(event.notification.data)
  );
});
