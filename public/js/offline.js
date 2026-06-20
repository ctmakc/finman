// public/js/offline.js — Wave-2 "offline-sync" stream.
//
// Делает PWA-офлайн НАСТОЯЩИМ: пока сети нет, создание транзакций кладётся в
// устойчивую очередь (IndexedDB в браузере), а при восстановлении связи
// проигрывается на POST /api/transactions — по порядку, идемпотентно и с
// видимым индикатором "queued / syncing / synced".
//
// АРХИТЕКТУРА (чтобы это можно было юнит-тестить в node):
//   - Вся логика очереди — ЧИСТАЯ и работает поверх абстрактного асинхронного
//     "store" (адаптера хранилища). enqueue / list / markSynced / dequeue /
//     replayQueue не знают ни про IndexedDB, ни про DOM.
//   - В браузере store = IndexedDB-адаптер; в node (юнит-тесты) — память.
//   - replayQueue(store, sender, opts) принимает sender(item) -> Promise:
//     это POST-функция, которую в тестах мокают, а в браузере она реально
//     стучится в /api/transactions с Bearer-токеном.
//
// ИДЕМПОТЕНТНОСТЬ:
//   - У каждого элемента очереди есть стабильный clientId (uuid). Он кладётся
//     в payload (поле clientTxId) и в заголовок Idempotency-Key, чтобы при
//     повторной отправке (двойной reconnect, гонка) бэкенд/будущая дедупликация
//     могли распознать дубль.
//   - На клиенте дубль не допускается тремя барьерами: (1) элементы со
//     статусом 'synced' пропускаются и удаляются; (2) повторный вызов
//     replayQueue под флагом-локом не запускается параллельно; (3) перед
//     отправкой элемент помечается 'sending', и уже отправленные не шлются
//     второй раз в рамках одного прогона.
//
// СТАТУСЫ элемента: 'pending' -> 'sending' -> 'synced' (успех) | 'pending'
// (временная сетевая ошибка, попробуем позже) | 'failed' (4xx — не ретраим).
//
// Экспортируется чистое ядро через module.exports для node-тестов и через
// window.offlineSync для браузера.

(function (root) {
  'use strict';

  var DB_NAME = 'finman-offline';
  var DB_VERSION = 1;
  var STORE_NAME = 'tx_queue';
  var API_URL = '/api/transactions';

  // -----------------------------------------------------------------------
  // Утилиты
  // -----------------------------------------------------------------------

  // Стабильный идентификатор клиента (RFC4122-подобный). Без внешних зависимостей.
  function makeClientId() {
    var c =
      (typeof root !== 'undefined' && root.crypto) ||
      (typeof globalThis !== 'undefined' && globalThis.crypto) ||
      null;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
    // Фолбэк: time + random (для node без crypto.randomUUID и старых браузеров).
    var rnd = function () {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .slice(1);
    };
    return (
      rnd() + rnd() + '-' + rnd() + '-' + rnd() + '-' + rnd() + '-' +
      rnd() + rnd() + rnd() + '+' + Date.now().toString(16)
    );
  }

  // Нормализуем "сырой" payload транзакции в стабильную форму очереди.
  // Возвращает НОВЫЙ объект-элемент очереди (item), не мутируя вход.
  function makeQueueItem(payload, now) {
    var ts = typeof now === 'number' ? now : Date.now();
    var clientId =
      (payload && (payload.clientTxId || payload.clientId)) || makeClientId();
    // Копируем payload, гарантируя наличие clientTxId внутри тела запроса.
    var body = {};
    if (payload && typeof payload === 'object') {
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) {
          body[k] = payload[k];
        }
      }
    }
    body.clientTxId = clientId;
    return {
      clientId: clientId, // первичный ключ в IndexedDB-сторе
      payload: body, // тело для POST /api/transactions
      status: 'pending', // pending | sending | synced | failed
      attempts: 0,
      createdAt: ts,
      updatedAt: ts,
      lastError: null,
    };
  }

  // -----------------------------------------------------------------------
  // ЧИСТОЕ ЯДРО ОЧЕРЕДИ (store = асинхронный адаптер)
  //
  // Контракт store:
  //   store.put(item)            -> Promise<void>   (upsert по item.clientId)
  //   store.getAll()             -> Promise<item[]> (произвольный порядок)
  //   store.get(clientId)        -> Promise<item|undefined>
  //   store.delete(clientId)     -> Promise<void>
  //   store.clear()              -> Promise<void>
  // -----------------------------------------------------------------------

  // Положить транзакцию в очередь. Идемпотентно по clientTxId: если элемент с
  // таким clientId уже есть и ещё не синхронизирован — не дублируем.
  async function enqueue(store, payload, now) {
    var item = makeQueueItem(payload, now);
    var existing = await store.get(item.clientId);
    if (existing && existing.status !== 'failed') {
      // Уже в очереди (или уже синхронизирован) — возвращаем как есть.
      return existing;
    }
    await store.put(item);
    return item;
  }

  // Все элементы в порядке создания (FIFO) — детерминированный порядок replay.
  async function list(store) {
    var all = await store.getAll();
    all.sort(function (a, b) {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      // tie-break по clientId для полной детерминированности
      return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
    });
    return all;
  }

  // Только ожидающие отправки (pending). 'sending' исключаем, чтобы не слать
  // одно и то же дважды; 'synced'/'failed' — терминальные для прогона.
  async function pending(store) {
    var all = await list(store);
    return all.filter(function (it) {
      return it.status === 'pending';
    });
  }

  async function markSynced(store, clientId, serverId) {
    var it = await store.get(clientId);
    if (!it) return;
    it.status = 'synced';
    it.serverId = serverId != null ? serverId : it.serverId;
    it.updatedAt = Date.now();
    await store.put(it);
  }

  // Удалить синхронизированный (или любой) элемент из очереди.
  async function dequeue(store, clientId) {
    await store.delete(clientId);
  }

  async function count(store) {
    var all = await store.getAll();
    return all.length;
  }

  async function pendingCount(store) {
    return (await pending(store)).length;
  }

  // Проиграть очередь. sender(payload, item) -> Promise<{ ok, id?, status? }>
  //
  // Семантика результата sender:
  //   { ok: true, id }              — успех, помечаем synced и удаляем.
  //   { ok: false, permanent:true } — 4xx, помечаем failed (не ретраим).
  //   { ok: false }                 — временная ошибка (offline/5xx) — оставляем
  //                                   pending, прерываем прогон (порядок важен).
  //
  // opts.lock — объект-лок { busy:false }, чтобы не запускать два прогона разом.
  // opts.removeSynced (default true) — удалять успешные элементы из стора.
  // opts.onProgress(state) — колбэк прогресса (для индикатора).
  async function replayQueue(store, sender, opts) {
    opts = opts || {};
    var lock = opts.lock;
    var removeSynced = opts.removeSynced !== false;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    if (lock) {
      if (lock.busy) {
        return { skipped: true, reason: 'busy', sent: 0, failed: 0, remaining: await pendingCount(store) };
      }
      lock.busy = true;
    }

    var sent = 0;
    var failed = 0;

    try {
      var queue = await pending(store);
      if (onProgress) onProgress({ phase: 'start', remaining: queue.length });

      for (var i = 0; i < queue.length; i++) {
        var item = queue[i];

        // Помечаем 'sending' — барьер против повторной отправки в этом прогоне.
        item.status = 'sending';
        item.attempts = (item.attempts || 0) + 1;
        item.updatedAt = Date.now();
        await store.put(item);

        var result;
        try {
          result = await sender(item.payload, item);
        } catch (e) {
          result = { ok: false, permanent: false, error: e && e.message };
        }

        if (result && result.ok) {
          sent++;
          if (removeSynced) {
            await dequeue(store, item.clientId);
          } else {
            await markSynced(store, item.clientId, result.id);
          }
          if (onProgress) {
            onProgress({ phase: 'item', ok: true, remaining: queue.length - (i + 1) });
          }
        } else if (result && result.permanent) {
          // 4xx — не ретраим, помечаем failed и идём дальше.
          failed++;
          item.status = 'failed';
          item.lastError = (result && result.error) || 'permanent_failure';
          item.updatedAt = Date.now();
          await store.put(item);
          if (onProgress) {
            onProgress({ phase: 'item', ok: false, permanent: true, remaining: queue.length - (i + 1) });
          }
        } else {
          // Временная ошибка — откатываем в pending и ПРЕРЫВАЕМ прогон, чтобы
          // сохранить FIFO-порядок (следующие зависят от связи).
          item.status = 'pending';
          item.lastError = (result && result.error) || 'network';
          item.updatedAt = Date.now();
          await store.put(item);
          if (onProgress) {
            onProgress({ phase: 'aborted', remaining: queue.length - i });
          }
          break;
        }
      }

      var remaining = await pendingCount(store);
      if (onProgress) onProgress({ phase: 'done', sent: sent, failed: failed, remaining: remaining });
      return { skipped: false, sent: sent, failed: failed, remaining: remaining };
    } finally {
      if (lock) lock.busy = false;
    }
  }

  // -----------------------------------------------------------------------
  // IndexedDB-адаптер (только браузер)
  // -----------------------------------------------------------------------

  function idbAvailable() {
    return typeof root !== 'undefined' && !!root.indexedDB;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'clientId' });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function idbTx(db, mode) {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  // Создаёт store-адаптер поверх IndexedDB.
  function createIdbStore() {
    var dbPromise = null;
    function db() {
      if (!dbPromise) dbPromise = openDb();
      return dbPromise;
    }
    return {
      put: async function (item) {
        var d = await db();
        await reqToPromise(idbTx(d, 'readwrite').put(item));
      },
      get: async function (clientId) {
        var d = await db();
        return reqToPromise(idbTx(d, 'readonly').get(clientId));
      },
      getAll: async function () {
        var d = await db();
        var res = await reqToPromise(idbTx(d, 'readonly').getAll());
        return res || [];
      },
      delete: async function (clientId) {
        var d = await db();
        await reqToPromise(idbTx(d, 'readwrite').delete(clientId));
      },
      clear: async function () {
        var d = await db();
        await reqToPromise(idbTx(d, 'readwrite').clear());
      },
    };
  }

  // Память-адаптер (фолбэк/тесты): тот же контракт, без IndexedDB.
  function createMemoryStore() {
    var map = new Map();
    return {
      put: async function (item) {
        // клонируем, чтобы внешние мутации не текли в стор
        map.set(item.clientId, JSON.parse(JSON.stringify(item)));
      },
      get: async function (clientId) {
        var v = map.get(clientId);
        return v ? JSON.parse(JSON.stringify(v)) : undefined;
      },
      getAll: async function () {
        var out = [];
        map.forEach(function (v) {
          out.push(JSON.parse(JSON.stringify(v)));
        });
        return out;
      },
      delete: async function (clientId) {
        map.delete(clientId);
      },
      clear: async function () {
        map.clear();
      },
    };
  }

  // -----------------------------------------------------------------------
  // БРАУЗЕРНЫЙ КОНТРОЛЛЕР: индикатор, перехват, авто-replay по reconnect.
  // -----------------------------------------------------------------------

  function getToken() {
    try {
      return root.localStorage ? root.localStorage.getItem('token') : null;
    } catch (e) {
      return null;
    }
  }

  // Реальный sender: POST /api/transactions. Классифицирует ответ:
  //   2xx                 -> { ok:true, id }
  //   4xx (кроме 408/429) -> { ok:false, permanent:true }
  //   5xx / network / 408 -> { ok:false } (ретраим позже)
  async function httpSender(payload) {
    var token = getToken();
    if (!token) {
      // Нет токена — это не "успех" и не permanent; подождём логина.
      return { ok: false, permanent: false, error: 'no_token' };
    }
    var resp;
    try {
      resp = await root.fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Idempotency-Key': payload && payload.clientTxId ? String(payload.clientTxId) : '',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { ok: false, permanent: false, error: 'network' };
    }
    if (resp.ok) {
      var id = null;
      try {
        var data = await resp.json();
        id = (data && (data.id || (data.data && data.data.id))) || null;
      } catch (e) {
        /* тело может быть пустым — не критично */
      }
      return { ok: true, id: id };
    }
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
      return { ok: false, permanent: true, error: 'http_' + resp.status };
    }
    return { ok: false, permanent: false, error: 'http_' + resp.status };
  }

  // Видимый индикатор "queued / syncing / synced".
  function ensureIndicator() {
    if (typeof root === 'undefined' || !root.document) return null;
    var el = root.document.getElementById('offline-sync-indicator');
    if (!el) {
      el = root.document.createElement('div');
      el.id = 'offline-sync-indicator';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText =
        'position:fixed;bottom:16px;left:16px;z-index:9999;padding:8px 14px;' +
        'border-radius:8px;font:13px/1.3 system-ui,sans-serif;color:#fff;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25);display:none;transition:opacity .3s';
      root.document.body.appendChild(el);
    }
    return el;
  }

  function setIndicator(state, info) {
    var el = ensureIndicator();
    if (!el) return;
    var n = (info && info.remaining) || 0;
    var map = {
      offline: { bg: '#b45309', text: '⚠ Офлайн' + (n ? ' · в очереди: ' + n : '') },
      queued: { bg: '#b45309', text: '⏳ В очереди: ' + n + ' (синхр. при сети)' },
      syncing: { bg: '#5D5CDE', text: '↻ Синхронизация…' + (n ? ' (' + n + ')' : '') },
      synced: { bg: '#15803d', text: '✓ Синхронизировано' },
      failed: { bg: '#b91c1c', text: '✕ Часть транзакций не отправлена' },
    };
    var conf = map[state];
    if (!conf) {
      el.style.display = 'none';
      return;
    }
    el.style.background = conf.bg;
    el.textContent = conf.text;
    el.style.display = 'block';
    el.style.opacity = '1';
    if (state === 'synced') {
      // Спрятать после паузы.
      root.setTimeout(function () {
        el.style.opacity = '0';
        root.setTimeout(function () {
          el.style.display = 'none';
        }, 350);
      }, 2500);
    }
  }

  // Контроллер инкапсулирует store + лок + индикатор и навешивает слушатели.
  function createController(options) {
    options = options || {};
    var store =
      options.store || (idbAvailable() ? createIdbStore() : createMemoryStore());
    var sender = options.sender || httpSender;
    var lock = { busy: false };

    function isOnline() {
      if (typeof root === 'undefined' || typeof root.navigator === 'undefined') {
        return true;
      }
      return root.navigator.onLine !== false;
    }

    // Поставить транзакцию в очередь (вызывается, когда POST не прошёл / офлайн).
    async function queueTransaction(payload) {
      var item = await enqueue(store, payload);
      var remaining = await pendingCount(store);
      setIndicator('queued', { remaining: remaining });
      // Зарегистрировать background sync, если поддерживается.
      requestBackgroundSync();
      return item;
    }

    // Прогнать очередь (если онлайн).
    async function sync() {
      if (!isOnline()) {
        var rem = await pendingCount(store);
        if (rem > 0) setIndicator('offline', { remaining: rem });
        return { skipped: true, reason: 'offline' };
      }
      var rem0 = await pendingCount(store);
      if (rem0 === 0) return { skipped: true, reason: 'empty', sent: 0, failed: 0, remaining: 0 };

      setIndicator('syncing', { remaining: rem0 });
      var res = await replayQueue(store, sender, {
        lock: lock,
        onProgress: function (s) {
          if (s.phase === 'item' || s.phase === 'start') {
            setIndicator('syncing', { remaining: s.remaining });
          }
        },
      });
      if (res.skipped) return res;
      if (res.failed > 0 && res.remaining === 0) {
        setIndicator('failed', { remaining: 0 });
      } else if (res.remaining === 0) {
        setIndicator('synced', {});
      } else {
        setIndicator('queued', { remaining: res.remaining });
      }
      return res;
    }

    function requestBackgroundSync() {
      try {
        if (
          root.navigator &&
          'serviceWorker' in root.navigator &&
          root.navigator.serviceWorker.ready &&
          typeof root.SyncManager !== 'undefined'
        ) {
          root.navigator.serviceWorker.ready
            .then(function (reg) {
              if (reg.sync && reg.sync.register) {
                return reg.sync.register('sync-transactions');
              }
            })
            .catch(function () {});
        }
      } catch (e) {
        /* ignore */
      }
    }

    // Слушатель сообщений от service worker (фоновый sync будит клиента).
    function listenForSwSync() {
      try {
        if (root.navigator && 'serviceWorker' in root.navigator) {
          root.navigator.serviceWorker.addEventListener('message', function (ev) {
            if (ev.data && ev.data.type === 'replay-queue') {
              sync();
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
    }

    function start() {
      if (typeof root === 'undefined' || !root.addEventListener) return api;
      root.addEventListener('online', function () {
        sync();
      });
      root.addEventListener('offline', function () {
        pendingCount(store).then(function (n) {
          setIndicator('offline', { remaining: n });
        });
      });
      listenForSwSync();
      // Догоняем то, что осталось с прошлой сессии.
      if (isOnline()) {
        sync();
      } else {
        pendingCount(store).then(function (n) {
          if (n > 0) setIndicator('offline', { remaining: n });
        });
      }
      return api;
    }

    var api = {
      store: store,
      queueTransaction: queueTransaction,
      sync: sync,
      start: start,
      isOnline: isOnline,
      pendingCount: function () {
        return pendingCount(store);
      },
      _lock: lock,
    };
    return api;
  }

  // -----------------------------------------------------------------------
  // Публичный API (чистое ядро + фабрики + контроллер).
  // -----------------------------------------------------------------------

  var publicApi = {
    // чистое ядро (юнит-тесты целятся сюда)
    makeClientId: makeClientId,
    makeQueueItem: makeQueueItem,
    enqueue: enqueue,
    list: list,
    pending: pending,
    pendingCount: pendingCount,
    count: count,
    markSynced: markSynced,
    dequeue: dequeue,
    replayQueue: replayQueue,
    // фабрики хранилищ
    createMemoryStore: createMemoryStore,
    createIdbStore: createIdbStore,
    idbAvailable: idbAvailable,
    // браузерный контроллер
    createController: createController,
    httpSender: httpSender,
    setIndicator: setIndicator,
    // константы
    DB_NAME: DB_NAME,
    STORE_NAME: STORE_NAME,
    API_URL: API_URL,
  };

  // Браузер: глобал + авто-инициализация контроллера.
  if (typeof root !== 'undefined' && root.document) {
    root.offlineSync = publicApi;
    try {
      var controller = createController();
      root.offlineSync.controller = controller;
      // Перехват: позволяем другим модулям положить транзакцию в очередь.
      root.queueOfflineTransaction = function (payload) {
        return controller.queueTransaction(payload);
      };
      if (root.document.readyState === 'complete' || root.document.readyState === 'interactive') {
        controller.start();
      } else {
        root.addEventListener('DOMContentLoaded', function () {
          controller.start();
        });
      }
    } catch (e) {
      /* в браузере без поддержки — деградируем тихо */
    }
  }

  // Node (юнит-тесты): экспорт чистого ядра.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicApi;
  }
})(
  typeof window !== 'undefined'
    ? window
    : typeof globalThis !== 'undefined'
    ? globalThis
    : this
);
