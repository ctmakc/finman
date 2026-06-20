// test/offline.test.js — Wave-2 "offline-sync" unit tests.
//
// Тестируем ЧИСТОЕ ЯДРО очереди из public/js/offline.js: enqueue/dequeue,
// порядок replay (FIFO), идемпотентность (двойной reconnect / повторная
// постановка не плодит дубли), классификация ответов sender (успех /
// временная ошибка с прерыванием порядка / permanent 4xx).
//
// Полностью офлайн и детерминированно: используем createMemoryStore() и
// мок-sender'ы. Никаких сетевых, IndexedDB или DOM-зависимостей — offline.js
// под node экспортирует только чистое ядро (module.exports), браузерная
// инициализация под node не запускается (нет window.document).

const path = require('path');

const offline = require(path.join(
  __dirname,
  '..',
  'public',
  'js',
  'offline.js'
));

describe('offline.js — экспорт чистого ядра в node', () => {
  test('module.exports содержит ядро очереди и фабрики', () => {
    expect(typeof offline.enqueue).toBe('function');
    expect(typeof offline.dequeue).toBe('function');
    expect(typeof offline.replayQueue).toBe('function');
    expect(typeof offline.list).toBe('function');
    expect(typeof offline.pending).toBe('function');
    expect(typeof offline.markSynced).toBe('function');
    expect(typeof offline.createMemoryStore).toBe('function');
    expect(typeof offline.makeQueueItem).toBe('function');
    expect(typeof offline.makeClientId).toBe('function');
  });

  test('браузерный контроллер НЕ инициализируется под node (нет window)', () => {
    // offlineSync вешается только на root с document; в node его быть не должно
    // в глобале (а module.exports — это публичный API, что норм).
    expect(global.offlineSync).toBeUndefined();
    expect(global.queueOfflineTransaction).toBeUndefined();
  });
});

describe('makeClientId / makeQueueItem', () => {
  test('makeClientId уникален между вызовами', () => {
    const a = offline.makeClientId();
    const b = offline.makeClientId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  test('makeQueueItem нормализует payload и проставляет clientTxId', () => {
    const item = offline.makeQueueItem(
      { accountId: 1, amount: -10, description: 'Coffee' },
      1000
    );
    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(0);
    expect(item.createdAt).toBe(1000);
    expect(item.payload.clientTxId).toBe(item.clientId);
    // не мутирует исходные поля
    expect(item.payload.accountId).toBe(1);
    expect(item.payload.amount).toBe(-10);
  });

  test('makeQueueItem уважает уже заданный clientTxId (стабильность id)', () => {
    const item = offline.makeQueueItem(
      { accountId: 1, amount: 5, clientTxId: 'fixed-id-123' },
      1
    );
    expect(item.clientId).toBe('fixed-id-123');
    expect(item.payload.clientTxId).toBe('fixed-id-123');
  });

  test('makeQueueItem не мутирует переданный объект', () => {
    const src = { accountId: 2, amount: 1 };
    offline.makeQueueItem(src, 1);
    expect(src.clientTxId).toBeUndefined();
  });
});

describe('enqueue / list / dequeue', () => {
  let store;
  beforeEach(() => {
    store = offline.createMemoryStore();
  });

  test('enqueue кладёт элемент, list его возвращает', async () => {
    await offline.enqueue(store, { accountId: 1, amount: -10 }, 100);
    const all = await offline.list(store);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
    expect(all[0].payload.accountId).toBe(1);
  });

  test('list сортирует по createdAt (FIFO)', async () => {
    await offline.enqueue(store, { accountId: 1, amount: 1, clientTxId: 'c' }, 300);
    await offline.enqueue(store, { accountId: 1, amount: 2, clientTxId: 'a' }, 100);
    await offline.enqueue(store, { accountId: 1, amount: 3, clientTxId: 'b' }, 200);
    const all = await offline.list(store);
    expect(all.map(i => i.payload.amount)).toEqual([2, 3, 1]);
  });

  test('dequeue удаляет элемент', async () => {
    const it = await offline.enqueue(store, { accountId: 1, amount: -10 }, 1);
    expect(await offline.count(store)).toBe(1);
    await offline.dequeue(store, it.clientId);
    expect(await offline.count(store)).toBe(0);
  });

  test('idempotency: повторный enqueue того же clientTxId не плодит дубль', async () => {
    await offline.enqueue(store, { accountId: 1, amount: -10, clientTxId: 'dup-1' }, 1);
    await offline.enqueue(store, { accountId: 1, amount: -10, clientTxId: 'dup-1' }, 2);
    expect(await offline.count(store)).toBe(1);
  });

  test('markSynced меняет статус и проставляет serverId', async () => {
    const it = await offline.enqueue(store, { accountId: 1, amount: -10 }, 1);
    await offline.markSynced(store, it.clientId, 42);
    const got = await store.get(it.clientId);
    expect(got.status).toBe('synced');
    expect(got.serverId).toBe(42);
  });

  test('store клонирует элементы (внешняя мутация не течёт внутрь)', async () => {
    const it = await offline.enqueue(store, { accountId: 1, amount: -10 }, 1);
    it.payload.amount = 999; // мутируем возвращённую копию
    const got = await store.get(it.clientId);
    expect(got.payload.amount).toBe(-10);
  });
});

describe('replayQueue — порядок, успех, удаление', () => {
  let store;
  beforeEach(() => {
    store = offline.createMemoryStore();
  });

  test('replay отправляет элементы в FIFO-порядке и удаляет успешные', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 100);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 200);
    await offline.enqueue(store, { amount: 3, clientTxId: 't3' }, 300);

    const order = [];
    const sender = jest.fn(async (payload) => {
      order.push(payload.clientTxId);
      return { ok: true, id: payload.clientTxId };
    });

    const res = await offline.replayQueue(store, sender);
    expect(order).toEqual(['t1', 't2', 't3']);
    expect(res.sent).toBe(3);
    expect(res.failed).toBe(0);
    expect(res.remaining).toBe(0);
    expect(await offline.count(store)).toBe(0);
  });

  test('replay с removeSynced:false помечает synced, но не удаляет', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 100);
    const sender = jest.fn(async () => ({ ok: true, id: 7 }));
    const res = await offline.replayQueue(store, sender, { removeSynced: false });
    expect(res.sent).toBe(1);
    expect(await offline.count(store)).toBe(1);
    const it = await store.get('t1');
    expect(it.status).toBe('synced');
    expect(it.serverId).toBe(7);
  });
});

describe('replayQueue — идемпотентность отправки', () => {
  let store;
  beforeEach(() => {
    store = offline.createMemoryStore();
  });

  test('каждый успешный элемент отправляется РОВНО один раз', async () => {
    for (let i = 0; i < 5; i++) {
      await offline.enqueue(store, { amount: i, clientTxId: 'k' + i }, i);
    }
    const seen = {};
    const sender = jest.fn(async (payload) => {
      seen[payload.clientTxId] = (seen[payload.clientTxId] || 0) + 1;
      return { ok: true, id: payload.clientTxId };
    });
    await offline.replayQueue(store, sender);
    expect(sender).toHaveBeenCalledTimes(5);
    Object.keys(seen).forEach(k => expect(seen[k]).toBe(1));
  });

  test('повторный replay после успеха НЕ шлёт ничего (всё уже dequeued)', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 1);
    const sender = jest.fn(async () => ({ ok: true, id: 1 }));
    await offline.replayQueue(store, sender);
    expect(sender).toHaveBeenCalledTimes(1);

    // второй прогон — очередь пуста
    await offline.replayQueue(store, sender);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test('лок не даёт двум прогонам слать одно и то же параллельно', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 1);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 2);

    const lock = { busy: false };
    let resolveFirst;
    const gate = new Promise((r) => { resolveFirst = r; });

    const sender = jest.fn(async (payload) => {
      if (payload.clientTxId === 't1') {
        await gate; // держим первый прогон на первом элементе
      }
      return { ok: true, id: payload.clientTxId };
    });

    const p1 = offline.replayQueue(store, sender, { lock });
    // второй прогон стартует, пока первый ещё держит лок
    const r2 = await offline.replayQueue(store, sender, { lock });
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('busy');

    resolveFirst();
    const r1 = await p1;
    expect(r1.sent).toBe(2);
    // каждый элемент ушёл один раз несмотря на два вызова replay
    const counts = {};
    sender.mock.calls.forEach(([p]) => {
      counts[p.clientTxId] = (counts[p.clientTxId] || 0) + 1;
    });
    expect(counts.t1).toBe(1);
    expect(counts.t2).toBe(1);
  });
});

describe('replayQueue — временные ошибки и порядок', () => {
  let store;
  beforeEach(() => {
    store = offline.createMemoryStore();
  });

  test('временная ошибка прерывает прогон и сохраняет FIFO (элемент остаётся pending)', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 100);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 200);
    await offline.enqueue(store, { amount: 3, clientTxId: 't3' }, 300);

    const sender = jest.fn(async (payload) => {
      if (payload.clientTxId === 't2') return { ok: false }; // временная (offline/5xx)
      return { ok: true, id: payload.clientTxId };
    });

    const res = await offline.replayQueue(store, sender);
    // t1 ушёл, на t2 прервались, t3 НЕ трогали
    expect(res.sent).toBe(1);
    expect(sender).toHaveBeenCalledTimes(2); // t1, t2 (t3 не пробовали)

    const remaining = await offline.list(store);
    expect(remaining.map(i => i.payload.clientTxId)).toEqual(['t2', 't3']);
    remaining.forEach(it => expect(it.status).toBe('pending'));
    expect(res.remaining).toBe(2);
  });

  test('повторный replay после восстановления связи дослыает остаток по порядку', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 100);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 200);

    let online = false;
    const order = [];
    const sender = jest.fn(async (payload) => {
      if (!online) return { ok: false };
      order.push(payload.clientTxId);
      return { ok: true, id: payload.clientTxId };
    });

    // офлайн: ничего не уходит
    const r0 = await offline.replayQueue(store, sender);
    expect(r0.sent).toBe(0);
    expect(r0.remaining).toBe(2);

    // онлайн: дослыает всё в порядке
    online = true;
    const r1 = await offline.replayQueue(store, sender);
    expect(r1.sent).toBe(2);
    expect(order).toEqual(['t1', 't2']);
    expect(await offline.count(store)).toBe(0);
  });
});

describe('replayQueue — permanent (4xx) ошибки', () => {
  let store;
  beforeEach(() => {
    store = offline.createMemoryStore();
  });

  test('permanent ошибка помечает failed и НЕ прерывает остальные', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 100);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 200); // 4xx
    await offline.enqueue(store, { amount: 3, clientTxId: 't3' }, 300);

    const sender = jest.fn(async (payload) => {
      if (payload.clientTxId === 't2') {
        return { ok: false, permanent: true, error: 'http_400' };
      }
      return { ok: true, id: payload.clientTxId };
    });

    const res = await offline.replayQueue(store, sender);
    expect(res.sent).toBe(2); // t1, t3
    expect(res.failed).toBe(1); // t2
    expect(sender).toHaveBeenCalledTimes(3);

    // t1/t3 удалены (успех), t2 остался как failed
    const left = await offline.list(store);
    expect(left).toHaveLength(1);
    expect(left[0].payload.clientTxId).toBe('t2');
    expect(left[0].status).toBe('failed');
    // failed не считается pending -> remaining 0
    expect(res.remaining).toBe(0);
  });

  test('failed элемент можно переочередить (enqueue заменяет failed)', async () => {
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 1);
    const failSender = jest.fn(async () => ({ ok: false, permanent: true }));
    await offline.replayQueue(store, failSender);
    let it = await store.get('t1');
    expect(it.status).toBe('failed');

    // повторный enqueue с тем же clientTxId переочередит failed (status !== failed -> false)
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 2);
    it = await store.get('t1');
    expect(it.status).toBe('pending');
  });
});

describe('onProgress индикатор-колбэк', () => {
  test('replayQueue зовёт onProgress на старте/элементах/завершении', async () => {
    const store = offline.createMemoryStore();
    await offline.enqueue(store, { amount: 1, clientTxId: 't1' }, 1);
    await offline.enqueue(store, { amount: 2, clientTxId: 't2' }, 2);

    const phases = [];
    const sender = async () => ({ ok: true, id: 1 });
    await offline.replayQueue(store, sender, {
      onProgress: (s) => phases.push(s.phase),
    });
    expect(phases[0]).toBe('start');
    expect(phases).toContain('item');
    expect(phases[phases.length - 1]).toBe('done');
  });
});

describe('createMemoryStore — контракт адаптера', () => {
  test('put/get/getAll/delete/clear работают', async () => {
    const store = offline.createMemoryStore();
    await store.put({ clientId: 'a', payload: { x: 1 }, status: 'pending', createdAt: 1 });
    await store.put({ clientId: 'b', payload: { x: 2 }, status: 'pending', createdAt: 2 });
    expect((await store.getAll()).length).toBe(2);
    expect((await store.get('a')).payload.x).toBe(1);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    await store.clear();
    expect((await store.getAll()).length).toBe(0);
  });
});
