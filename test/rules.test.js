// test/rules.test.js — движок и модель правил категоризации.
// Роутер /api/rules ещё НЕ смонтирован в server.js, поэтому тестируем
// СЕРВИС + МОДЕЛЬ напрямую против ctx.db (raw sqlite для сидинга).
const { makeApp } = require('./helpers/app');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

describe('Rules engine + model', () => {
  let ctx;
  let uid;
  let CategoryRule;
  let rulesEngine;

  beforeEach(async () => {
    ctx = await makeApp();
    uid = ctx.userId;
    // require ПОСЛЕ makeApp -> модули привязаны к тестовой БД (как в других тестах).
    CategoryRule = require('../models/categoryRule');
    rulesEngine = require('../services/rulesEngine');

    await dbRun(
      ctx.db,
      `INSERT INTO accounts (user_id,name,currency,balance,account_type,is_active) VALUES (?,?,?,?,?,1)`,
      [uid, 'Main', 'UAH', 100000, 'card']
    );
  });

  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  // helper: вставить расходную транзакцию, вернуть id
  async function tx(desc, amount, category) {
    const r = await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,description,category,amount,type)
       VALUES (1,?,?,?,?,?, 'expense')`,
      [uid, '2026-06-01', desc, category === undefined ? null : category, -Math.abs(amount)]
    );
    return r.id;
  }

  test('migration created the category_rules table', async () => {
    const row = await dbGet(
      ctx.db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='category_rules'`
    );
    expect(row).toBeTruthy();
    expect(row.name).toBe('category_rules');
  });

  test("'contains Netflix -> Entertainment' recategorizes matching tx", async () => {
    const netflixId = await tx('Netflix UA 12345', 199, null);
    const groceriesId = await tx('ATB market', 850, null);

    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].to).toBe('Entertainment');

    const netflix = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [netflixId]);
    expect(netflix.category).toBe('Entertainment');
    // не совпавшая транзакция осталась без категории
    const groc = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [groceriesId]);
    expect(groc.category).toBeNull();
  });

  test('priority order respected — lower priority wins (applied first)', async () => {
    const id = await tx('Netflix Premium', 199, null);

    // более общее правило с БОЛЬШИМ priority (позже)
    await CategoryRule.create(uid, {
      priority: 100,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Premium',
      set_category: 'Subscriptions',
    });
    // более специфичное правило с МЕНЬШИМ priority (раньше -> выигрывает)
    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(1);

    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [id]);
    expect(row.category).toBe('Entertainment');
  });

  test('inactive rules are skipped', async () => {
    const id = await tx('Netflix UA', 199, null);

    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
      is_active: false,
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(0);
    expect(result.suggestions).toHaveLength(0);

    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [id]);
    expect(row.category).toBeNull();
  });

  test("placeholder category 'Прочее' is treated as uncategorized", async () => {
    const id = await tx('Netflix UA', 199, 'Прочее');

    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(1);
    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [id]);
    expect(row.category).toBe('Entertainment');
  });

  test('already-categorized (real category) tx is not touched', async () => {
    const id = await tx('Netflix UA', 199, 'Housing');

    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(0);
    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [id]);
    expect(row.category).toBe('Housing');
  });

  test('amount gt/lt operators match on absolute value', async () => {
    const bigId = await tx('Big purchase', 5000, null);
    const smallId = await tx('Small purchase', 50, null);

    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'amount',
      match_op: 'gt',
      match_value: '1000',
      set_category: 'BigSpend',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(1);

    const big = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [bigId]);
    expect(big.category).toBe('BigSpend');
    const small = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [smallId]);
    expect(small.category).toBeNull();
  });

  test('regex operator matches and invalid regex never throws', async () => {
    const matchId = await tx('UBER trip 42', 300, null);
    const otherId = await tx('Taxi local', 200, null);

    await CategoryRule.create(uid, {
      priority: 5,
      match_field: 'description',
      match_op: 'regex',
      match_value: '^UBER',
      set_category: 'Transport',
    });
    // невалидный regex — не должен ломать прогон
    await CategoryRule.create(uid, {
      priority: 6,
      match_field: 'description',
      match_op: 'regex',
      match_value: '([',
      set_category: 'Broken',
    });

    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(1);
    const m = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [matchId]);
    expect(m.category).toBe('Transport');
    const o = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [otherId]);
    expect(o.category).toBeNull();
  });

  test('dryRun produces suggestions without writing', async () => {
    const id = await tx('Netflix UA', 199, null);
    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });

    const result = await rulesEngine.applyToUncategorized(uid, { dryRun: true });
    expect(result.updated).toBe(0);
    expect(result.suggestions).toHaveLength(1);
    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [id]);
    expect(row.category).toBeNull();
  });

  test('income transactions are never categorized by rules', async () => {
    const r = await dbRun(
      ctx.db,
      `INSERT INTO transactions (account_id,user_id,date,description,category,amount,type)
       VALUES (1,?,?,?,?,?, 'income')`,
      [uid, '2026-06-01', 'Netflix refund', null, 199]
    );
    await CategoryRule.create(uid, {
      priority: 10,
      match_field: 'description',
      match_op: 'contains',
      match_value: 'Netflix',
      set_category: 'Entertainment',
    });
    const result = await rulesEngine.applyToUncategorized(uid);
    expect(result.updated).toBe(0);
    const row = await dbGet(ctx.db, `SELECT category FROM transactions WHERE id = ?`, [r.id]);
    expect(row.category).toBeNull();
  });

  describe('CategoryRule model CRUD', () => {
    test('create validates required fields', async () => {
      const noCat = await CategoryRule.create(uid, { match_value: 'x' });
      expect(noCat.error).toBe(true);
      const noVal = await CategoryRule.create(uid, { set_category: 'X' });
      expect(noVal.error).toBe(true);
    });

    test('create normalizes invalid field/op to defaults', async () => {
      const rule = await CategoryRule.create(uid, {
        match_field: 'bogus',
        match_op: 'nope',
        match_value: 'x',
        set_category: 'Cat',
      });
      expect(rule.match_field).toBe('description');
      expect(rule.match_op).toBe('contains');
    });

    test('findByUserId returns rules in priority order', async () => {
      await CategoryRule.create(uid, { priority: 50, match_value: 'b', set_category: 'B' });
      await CategoryRule.create(uid, { priority: 10, match_value: 'a', set_category: 'A' });
      const rules = await CategoryRule.findByUserId(uid);
      expect(rules.map((r) => r.set_category)).toEqual(['A', 'B']);
    });

    test('update + delete + tenant isolation', async () => {
      const rule = await CategoryRule.create(uid, {
        match_value: 'x',
        set_category: 'Old',
      });
      const updated = await CategoryRule.update(rule.id, uid, { set_category: 'New', is_active: false });
      expect(updated.set_category).toBe('New');
      expect(updated.is_active).toBe(0);

      // другой пользователь не видит/не трогает чужое правило
      const other = await CategoryRule.findById(rule.id, uid + 999);
      expect(other).toBeFalsy();
      const delOther = await CategoryRule.delete(rule.id, uid + 999);
      expect(delOther).toBe(false);

      const del = await CategoryRule.delete(rule.id, uid);
      expect(del).toBe(true);
      const gone = await CategoryRule.findById(rule.id, uid);
      expect(gone).toBeFalsy();
    });

    test('activeOnly filter excludes inactive rules', async () => {
      await CategoryRule.create(uid, { match_value: 'a', set_category: 'A', is_active: true });
      await CategoryRule.create(uid, { match_value: 'b', set_category: 'B', is_active: false });
      const all = await CategoryRule.findByUserId(uid);
      const active = await CategoryRule.findByUserId(uid, { activeOnly: true });
      expect(all).toHaveLength(2);
      expect(active).toHaveLength(1);
      expect(active[0].set_category).toBe('A');
    });
  });

  test('previewRules is pure (no DB) and respects priority', () => {
    const rules = [
      { id: 2, priority: 100, match_field: 'description', match_op: 'contains', match_value: 'Premium', set_category: 'Sub', is_active: 1 },
      { id: 1, priority: 10, match_field: 'description', match_op: 'contains', match_value: 'Netflix', set_category: 'Ent', is_active: 1 },
    ];
    const out = rulesEngine.previewRules(rules, [{ id: 7, description: 'Netflix Premium', amount: -199 }]);
    expect(out).toEqual([{ transactionId: 7, to: 'Ent', ruleId: 1 }]);
  });
});
