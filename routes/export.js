const express = require('express');
const router = express.Router();
const passport = require('passport');
const { query, run } = require('../db/database');

const authenticate = passport.authenticate('jwt', { session: false });
router.use(authenticate);

router.get('/transactions/csv', async (req, res) => {
  try {
    const { startDate, endDate, accountId } = req.query;
    let sql = `SELECT t.date, t.description, t.category, t.amount, t.type, a.name as account_name, a.currency
      FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id WHERE t.user_id = ?`;
    const params = [req.user.id];
    if (startDate) { sql += ' AND t.date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND t.date <= ?'; params.push(endDate); }
    if (accountId) { sql += ' AND t.account_id = ?'; params.push(accountId); }
    sql += ' ORDER BY t.date DESC';
    const transactions = await query(sql, params);
    const csvEsc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const headers = ['Date', 'Description', 'Category', 'Amount', 'Type', 'Account', 'Currency'];
    const rows = transactions.map(t => [
      csvEsc(t.date), csvEsc(t.description || ''), csvEsc(t.category || ''),
      Math.abs(t.amount), t.type || 'expense', csvEsc(t.account_name || ''), csvEsc(t.currency || '')
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions_' + new Date().toISOString().split('T')[0] + '.csv');
    res.send('\ufeff' + csv);
  } catch (error) { console.error(error); res.status(500).json({ message: 'Server error' }); }
});

router.get('/accounts/csv', async (req, res) => {
  try {
    const accounts = await query('SELECT name, account_number, bank_name, balance, currency, account_type, created_at FROM accounts WHERE user_id = ? AND is_active = 1', [req.user.id]);
    const headers = ['Name', 'Number', 'Bank', 'Balance', 'Currency', 'Type', 'Created'];
    const csvEsc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = accounts.map(a => [csvEsc(a.name), csvEsc(a.account_number || ''), csvEsc(a.bank_name || ''), a.balance, a.currency || 'USD', csvEsc(a.account_type || ''), csvEsc(a.created_at)]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=accounts_' + new Date().toISOString().split('T')[0] + '.csv');
    res.send('\ufeff' + csv);
  } catch (error) { console.error(error); res.status(500).json({ message: 'Server error' }); }
});

router.get('/full/json', async (req, res) => {
  try {
    const userId = req.user.id;
    const [accounts, transactions, budgets, goals, debts] = await Promise.all([
      query('SELECT * FROM accounts WHERE user_id = ? AND is_active = 1', [userId]),
      query('SELECT * FROM transactions WHERE user_id = ?', [userId]),
      query('SELECT * FROM budgets WHERE user_id = ? AND is_active = 1', [userId]),
      query('SELECT * FROM savings_goals WHERE user_id = ? AND is_active = 1', [userId]),
      query('SELECT * FROM debts WHERE user_id = ? AND is_active = 1', [userId])
    ]);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=finman_backup_' + new Date().toISOString().split('T')[0] + '.json');
    res.json({ exportDate: new Date().toISOString(), accounts, transactions, budgets, savingsGoals: goals, debts });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Server error' }); }
});

router.post('/transactions/csv', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ message: 'Account ID required' });

    // Verify the account belongs to this user
    const { get: dbGet } = require('../db/database');
    const account = await dbGet('SELECT id, user_id FROM accounts WHERE id = ? AND user_id = ?', [accountId, req.user.id]);
    if (!account) return res.status(404).json({ message: 'Account not found' });

    const lines = req.body.split('\n').filter(l => l.trim()).slice(1);
    let imported = 0;
    let balanceDelta = 0;

    await run('BEGIN TRANSACTION');
    try {
      for (const line of lines) {
        try {
          const parts = line.split(',');
          if (parts.length < 4) continue;
          const [date, description, category, rawAmount, rawType] = parts;
          const txType = rawType && rawType.trim() === 'income' ? 'income' : 'expense';
          const absAmount = Math.abs(parseFloat(rawAmount));
          if (!absAmount || !date) continue;
          const signedAmount = txType === 'income' ? absAmount : -absAmount;
          await run(
            'INSERT INTO transactions (user_id, account_id, date, description, category, amount, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.id, accountId, date.trim(), (description || '').replace(/"/g, '').trim(), (category || '').trim(), signedAmount, txType]
          );
          balanceDelta += signedAmount;
          imported++;
        } catch (e) {}
      }
      // Update account balance once for all imported transactions
      if (balanceDelta !== 0) {
        await run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [balanceDelta, accountId]);
      }
      await run('COMMIT');
    } catch (e) {
      await run('ROLLBACK');
      throw e;
    }

    res.json({ imported, balanceDelta });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Server error' }); }
});

router.post('/full/json', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const data = req.body, userId = req.user.id, results = { accounts: 0, budgets: 0, goals: 0, debts: 0 };
    if (data.accounts) for (const a of data.accounts) { try { await run('INSERT INTO accounts (user_id, name, bank_name, currency, balance, account_type) VALUES (?, ?, ?, ?, ?, ?)', [userId, a.name, a.bank_name, a.currency, a.balance, a.account_type]); results.accounts++; } catch(e){} }
    if (data.budgets) for (const b of data.budgets) { try { await run('INSERT INTO budgets (user_id, name, category, amount, period, start_date, currency) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, b.name, b.category, b.amount, b.period, b.start_date, b.currency]); results.budgets++; } catch(e){} }
    if (data.savingsGoals) for (const g of data.savingsGoals) { try { await run('INSERT INTO savings_goals (user_id, name, target_amount, current_amount, currency, target_date) VALUES (?, ?, ?, ?, ?, ?)', [userId, g.name, g.target_amount, g.current_amount || 0, g.currency, g.target_date]); results.goals++; } catch(e){} }
    if (data.debts) for (const d of data.debts) { try { await run('INSERT INTO debts (user_id, name, type, amount, paid_amount, currency, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [userId, d.name, d.type, d.amount, d.paid_amount || 0, d.currency, d.start_date, d.due_date]); results.debts++; } catch(e){} }
    res.json({ message: 'Import complete', results });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
