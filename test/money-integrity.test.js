// test/money-integrity.test.js — целостность денежной арифметики в core-моделях.
//
// Проверяем, что:
//   1) баланс счёта остаётся точным до копеек при последовательностях вида
//      0.1 + 0.2 через create/delete транзакций;
//   2) переплата по телу долга (paid_amount > principal) отклоняется
//      с AppError(400, 'DEBT_OVERPAY');
//   3) P&L по инвестиции учитывает (вычитает) комиссии сделок;
//   4) budget.recalculateSpent / updateSpent округляют spent до 2 знаков.
//
// ВАЖНО: модели требуем ВНУТРИ beforeAll, ПОСЛЕ makeApp() — harness сбрасывает
// require-кэш моделей и привязывает их к свежей временной БД.

const { makeApp } = require('./helpers/app');

describe('money integrity: account balance (float-drift safe)', () => {
  let ctx;
  let Account;
  let Transaction;
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    Account = require('../models/account');
    Transaction = require('../models/transaction');

    const acc = await Account.create({
      userId: ctx.userId,
      name: 'Test Account',
      balance: 0,
      currency: 'UAH',
    });
    accountId = acc.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('0.1 + 0.2 через две транзакции -> баланс ровно 0.3', async () => {
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-01-01',
      amount: 0.1,
      type: 'income',
    });
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-01-02',
      amount: 0.2,
      type: 'income',
    });

    const acc = await Account.findById(accountId, ctx.userId);
    expect(acc.balance).toBe(0.3);
  });

  test('много мелких прибавлений и вычитаний возвращают баланс к ровному значению', async () => {
    // Добавляем 0.1 десять раз — должно дать ровно +1.00 поверх 0.3.
    for (let i = 0; i < 10; i++) {
      await Transaction.create({
        accountId,
        userId: ctx.userId,
        date: '2026-02-01',
        amount: 0.1,
        type: 'income',
      });
    }
    let acc = await Account.findById(accountId, ctx.userId);
    expect(acc.balance).toBe(1.3);

    // Снимаем 1.30 одной транзакцией -> ровно 0.
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-02-02',
      amount: -1.3,
      type: 'expense',
    });
    acc = await Account.findById(accountId, ctx.userId);
    expect(acc.balance).toBe(0);
  });

  test('delete транзакции откатывает баланс точно до копеек', async () => {
    const tx = await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-03-01',
      amount: 0.1,
      type: 'income',
    });
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-03-02',
      amount: 0.2,
      type: 'income',
    });

    let acc = await Account.findById(accountId, ctx.userId);
    expect(acc.balance).toBe(0.3);

    // Удаляем первую (0.1) -> остаётся ровно 0.2.
    await Transaction.delete(tx.id, ctx.userId);
    acc = await Account.findById(accountId, ctx.userId);
    expect(acc.balance).toBe(0.2);
  });

  test('update суммы транзакции корректирует баланс на округлённую разницу', async () => {
    // Стартуем с чистого счёта.
    const acc0 = await Account.findById(accountId, ctx.userId);
    const start = acc0.balance;

    const tx = await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: '2026-04-01',
      amount: 0.1,
      type: 'income',
    });

    // Меняем 0.1 -> 0.3 (разница 0.2).
    await Transaction.update(tx.id, ctx.userId, { amount: 0.3 });

    const acc = await Account.findById(accountId, ctx.userId);
    // start + 0.3
    expect(acc.balance).toBe(Math.round((start + 0.3) * 100) / 100);
  });
});

describe('money integrity: debt overpay rejection', () => {
  let ctx;
  let Debt;
  let debtId;

  beforeAll(async () => {
    ctx = await makeApp();
    Debt = require('../models/debt');

    const debt = await Debt.create({
      user_id: ctx.userId,
      name: 'Loan',
      type: 'i_owe',
      amount: 100,
      start_date: '2026-01-01',
    });
    debtId = debt.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('частичный платёж принимается и округляется', async () => {
    const updated = await Debt.addPayment(debtId, 30.005, 'principal');
    // 30.005 округляется до 30.01
    expect(updated.paid_amount).toBe(30.01);
    expect(updated.is_paid).toBe(0);
  });

  test('платёж, превышающий остаток тела долга, отклоняется DEBT_OVERPAY', async () => {
    // Остаток = 100 - 30.01 = 69.99; платим 80 -> переплата.
    let err;
    try {
      await Debt.addPayment(debtId, 80, 'principal');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('DEBT_OVERPAY');

    // paid_amount не должен измениться.
    const debt = await Debt.findById(debtId);
    expect(debt.paid_amount).toBe(30.01);
  });

  test('платёж ровно на остаток закрывает долг (is_paid=1)', async () => {
    const updated = await Debt.addPayment(debtId, 69.99, 'principal');
    expect(updated.paid_amount).toBe(100);
    expect(updated.is_paid).toBe(1);
  });

  test('неположительный платёж отклоняется', async () => {
    let err;
    try {
      await Debt.addPayment(debtId, 0, 'principal');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    expect(err.code).toBe('DEBT_INVALID_PAYMENT');
  });
});

describe('money integrity: investment P&L includes fees', () => {
  let ctx;
  let Investment;
  let portfolioId;

  beforeAll(async () => {
    ctx = await makeApp();
    Investment = require('../models/investment');

    const portfolio = await Investment.createPortfolio({
      user_id: ctx.userId,
      name: 'Test PF',
      currency: 'USD',
    });
    portfolioId = portfolio.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('P&L вычитает комиссию покупки', async () => {
    // 10 шт по 100, текущая цена 110, комиссия покупки 5.
    const inv = await Investment.addInvestment({
      portfolio_id: portfolioId,
      symbol: 'AAA',
      name: 'Asset A',
      type: 'stock',
      quantity: 10,
      buy_price: 100,
      current_price: 110,
      buy_date: '2026-01-01',
      fee: 5,
    });

    const valued = await Investment.calculateValue(inv.id);
    // currentValue = 1100, buyValue = 1000, gross = 100, fee = 5 -> net = 95
    expect(valued.currentValue).toBe(1100);
    expect(valued.buyValue).toBe(1000);
    expect(valued.fees).toBe(5);
    expect(valued.profitLoss).toBe(95);
  });

  test('дополнительная комиссия (продажа) ещё уменьшает P&L', async () => {
    const investments = await Investment.findByPortfolio(portfolioId);
    const inv = investments[0];

    // Продаём 2 шт по 110 с комиссией 3 -> ещё +3 к суммарным комиссиям.
    await Investment.sell(inv.id, 2, 110, 3, '2026-02-01');

    const valued = await Investment.calculateValue(inv.id);
    // Остаток 8 шт. currentValue = 880, buyValue = 800, gross = 80.
    // Суммарные комиссии = 5 (buy) + 3 (sell) = 8. net = 72.
    expect(valued.fees).toBe(8);
    expect(valued.currentValue).toBe(880);
    expect(valued.buyValue).toBe(800);
    expect(valued.profitLoss).toBe(72);
  });

  test('агрегаты портфеля учитывают комиссии', async () => {
    const stats = await Investment.calculatePortfolioValue(portfolioId);
    expect(stats.totalFees).toBe(8);
    // totalValue 880, totalCost 800 -> net 72.
    expect(stats.totalProfitLoss).toBe(72);
  });
});

describe('money integrity: budget spent rounds', () => {
  let ctx;
  let Account;
  let Transaction;
  let Budget;
  let accountId;

  beforeAll(async () => {
    ctx = await makeApp();
    Account = require('../models/account');
    Transaction = require('../models/transaction');
    Budget = require('../models/budget');

    const acc = await Account.create({
      userId: ctx.userId,
      name: 'Spend Account',
      balance: 1000,
      currency: 'UAH',
    });
    accountId = acc.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  test('updateSpent округляет значение до 2 знаков', async () => {
    const today = new Date().toISOString().split('T')[0];
    const b = await Budget.create({
      userId: ctx.userId,
      name: 'Food',
      category: 'Food',
      amount: 500,
      period: 'monthly',
      startDate: today,
    });

    await Budget.updateSpent(b.id, ctx.userId, 0.1 + 0.2); // 0.30000000000000004
    const budget = await Budget.findById(b.id, ctx.userId);
    expect(budget.spent).toBe(0.3);
  });

  test('addToSpent копит без float-дрейфа', async () => {
    const today = new Date().toISOString().split('T')[0];
    const b = await Budget.create({
      userId: ctx.userId,
      name: 'Fun',
      category: 'Fun',
      amount: 500,
      period: 'monthly',
      startDate: today,
    });

    await Budget.addToSpent(b.id, ctx.userId, 0.1);
    await Budget.addToSpent(b.id, ctx.userId, 0.2);
    const budget = await Budget.findById(b.id, ctx.userId);
    expect(budget.spent).toBe(0.3);
  });

  test('recalculateSpent округляет агрегат расходов до копеек', async () => {
    const now = new Date();
    const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const txDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;

    const b = await Budget.create({
      userId: ctx.userId,
      name: 'Travel',
      category: 'Travel',
      amount: 500,
      period: 'monthly',
      startDate: periodStart,
    });

    // Три расхода, дающие float-дрейф при наивном суммировании.
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: txDate,
      category: 'Travel',
      amount: -0.1,
      type: 'expense',
    });
    await Transaction.create({
      accountId,
      userId: ctx.userId,
      date: txDate,
      category: 'Travel',
      amount: -0.2,
      type: 'expense',
    });

    await Budget.recalculateSpent(ctx.userId, 'Travel');
    const budget = await Budget.findById(b.id, ctx.userId);
    expect(budget.spent).toBe(0.3);
    // remaining округлён.
    expect(budget.remaining).toBe(499.7);
  });
});
