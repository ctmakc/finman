const express = require('express');
const passport = require('passport');
const { query, get, run } = require('../db/database');
const aiService = require('../services/aiService');

const router = express.Router();
const auth = passport.authenticate('jwt', { session: false });

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/status', auth, async (req, res) => {
  try {
    const org = await get('SELECT ai_provider, ai_model FROM organizations WHERE id = ?', [req.user.orgId]);
    res.json({
      provider: org?.ai_provider || aiService.PROVIDER,
      model: org?.ai_model || aiService.resolveModel(org?.ai_provider),
      available: ['anthropic', 'openai', 'google'],
    });
  } catch (error) {
    console.error('AI status error:', error);
    res.status(500).json({ error: true, message: 'Failed to get AI status' });
  }
});

// ─── CFO Chat (tool-calling agentic loop) ────────────────────────────────────

const CFO_TOOLS = [
  {
    name: 'get_balance_summary',
    description: 'Get total balances across all accounts for the current user',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_transactions',
    description: 'Get recent transactions, optionally filtered by category or account',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of transactions (default 20)' },
        category: { type: 'string', description: 'Filter by category name' },
        account_id: { type: 'integer', description: 'Filter by account ID' },
      },
      required: [],
    },
  },
  {
    name: 'get_spending_by_category',
    description: 'Get spending totals grouped by category for a given month',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Month in YYYY-MM format, defaults to current month' },
      },
      required: [],
    },
  },
  {
    name: 'get_budget_status',
    description: 'Get current budget limits and spending progress',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_top_expenses',
    description: 'Get the top N largest expenses in a period',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of top expenses (default 5)' },
        days: { type: 'integer', description: 'Look back N days (default 30)' },
      },
      required: [],
    },
  },
];

async function executeTool(toolName, toolInput, userId, orgId) {
  switch (toolName) {
    case 'get_balance_summary': {
      const rows = await query(
        `SELECT name, balance, currency FROM accounts WHERE user_id = ? AND is_active = 1`,
        [userId]
      );
      const total = rows.reduce((s, r) => s + (r.balance || 0), 0);
      return { accounts: rows, total_balance: total };
    }

    case 'get_recent_transactions': {
      const limit = toolInput.limit || 20;
      let sql = `SELECT t.id, t.amount, t.description, t.date, t.type, COALESCE(t.category, 'Uncategorized') as category, a.name as account
                 FROM transactions t
                 LEFT JOIN accounts a ON a.id = t.account_id
                 WHERE t.user_id = ?`;
      const params = [userId];
      if (toolInput.category) { sql += ` AND t.category = ?`; params.push(toolInput.category); }
      if (toolInput.account_id) { sql += ` AND t.account_id = ?`; params.push(toolInput.account_id); }
      sql += ` ORDER BY t.date DESC LIMIT ?`;
      params.push(limit);
      return await query(sql, params);
    }

    case 'get_spending_by_category': {
      const month = toolInput.month || new Date().toISOString().slice(0, 7);
      return await query(
        `SELECT COALESCE(t.category, 'Uncategorized') as category, SUM(ABS(t.amount)) as total, COUNT(*) as count
         FROM transactions t
         WHERE t.user_id = ? AND t.type = 'expense' AND strftime('%Y-%m', t.date) = ?
         GROUP BY t.category ORDER BY total DESC`,
        [userId, month]
      );
    }

    case 'get_budget_status': {
      const month = new Date().toISOString().slice(0, 7);
      return await query(
        `SELECT b.category, b.amount as budget_limit,
                COALESCE(SUM(ABS(t.amount)), 0) as spent
         FROM budgets b
         LEFT JOIN transactions t ON t.category = b.category
           AND t.user_id = b.user_id AND t.type = 'expense'
           AND strftime('%Y-%m', t.date) = ?
         WHERE b.user_id = ?
         GROUP BY b.category`,
        [month, userId]
      );
    }

    case 'get_top_expenses': {
      const limit = toolInput.limit || 5;
      const days = toolInput.days || 30;
      return await query(
        `SELECT t.amount, t.description, t.date, COALESCE(t.category, 'Uncategorized') as category, a.name as account
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? AND t.type = 'expense'
           AND t.date >= date('now', ?)
         ORDER BY ABS(t.amount) DESC LIMIT ?`,
        [userId, `-${days} days`, limit]
      );
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

router.post('/chat', auth, async (req, res) => {
  try {
    const { message, session_id, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: true, message: 'Message is required' });

    const org = await get('SELECT ai_provider, ai_model FROM organizations WHERE id = ?', [req.user.orgId]);
    const provider = org?.ai_provider || aiService.PROVIDER;

    const systemPrompt = `You are a personal CFO assistant for a finance tracking app.
You have access to the user's financial data via tools.
Be concise, insightful, and actionable. Format numbers with currency symbols.
Today's date: ${new Date().toISOString().slice(0, 10)}`;

    let messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    let finalText = '';
    const MAX_ROUNDS = 5;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await aiService.chat(messages, CFO_TOOLS, provider);

      const toolUses = aiService.extractToolUses(response);
      const text = aiService.extractText(response);

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        finalText = text;
        break;
      }

      // Execute all tool calls
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await executeTool(tu.name, tu.input, req.user.id, req.user.orgId);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }

      // Append assistant response + tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      if (round === MAX_ROUNDS - 1) {
        finalText = text || 'I was unable to complete the analysis. Please try again.';
      }
    }

    // Persist session if session_id provided
    if (session_id) {
      const userMessages = messages.filter(m => m.role !== 'system');
      userMessages.push({ role: 'assistant', content: finalText });
      await run(
        `INSERT INTO ai_chat_sessions (org_id, user_id, session_id, messages)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET messages = excluded.messages`,
        [req.user.orgId, req.user.id, session_id, JSON.stringify(userMessages)]
      );
    }

    res.json({ reply: finalText, provider });
  } catch (error) {
    console.error('AI chat error:', error);
    res.status(500).json({ error: true, message: 'AI chat failed' });
  }
});

// ─── Auto-categorize ──────────────────────────────────────────────────────────

router.post('/categorize', auth, async (req, res) => {
  try {
    const { description, amount } = req.body;
    if (!description) return res.status(400).json({ error: true, message: 'Description is required' });

    const categories = await query('SELECT id, name FROM categories WHERE user_id = ? OR user_id IS NULL', [req.user.id]);
    const catList = categories.map(c => c.name).join(', ');

    const org = await get('SELECT ai_provider FROM organizations WHERE id = ?', [req.user.orgId]);
    const provider = org?.ai_provider || aiService.PROVIDER;

    const response = await aiService.chat([
      {
        role: 'user',
        content: `Categorize this transaction. Reply with ONLY the category name from the list, nothing else.
Transaction: "${description}"${amount ? `, amount: ${amount}` : ''}
Available categories: ${catList}
If none fit, reply "Other".`,
      },
    ], null, provider);

    const suggested = aiService.extractText(response).trim().replace(/['"]/g, '');
    const match = categories.find(c => c.name.toLowerCase() === suggested.toLowerCase());

    res.json({ category: match ? match.name : 'Other', category_id: match?.id || null, provider });
  } catch (error) {
    console.error('AI categorize error:', error);
    res.status(500).json({ error: true, message: 'Categorization failed' });
  }
});

// ─── Receipt scan (vision) ────────────────────────────────────────────────────

router.post('/receipt', auth, async (req, res) => {
  try {
    const { image, mimeType = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: true, message: 'Image (base64) is required' });

    const org = await get('SELECT ai_provider FROM organizations WHERE id = ?', [req.user.orgId]);
    const provider = org?.ai_provider || aiService.PROVIDER;

    const prompt = `Extract transaction details from this receipt image.
Return a JSON object with these fields: total (number), currency (3-letter code), date (YYYY-MM-DD or null), merchant (string or null), items (array of {name, amount} or empty array).
Reply with ONLY the JSON object, no markdown, no explanation.`;

    const result = await aiService.vision(image, mimeType, prompt, provider);

    let parsed;
    try {
      parsed = JSON.parse(result.text.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      parsed = { total: null, currency: 'USD', date: null, merchant: result.text, items: [] };
    }

    res.json({ ...parsed, provider });
  } catch (error) {
    console.error('AI receipt error:', error);
    res.status(500).json({ error: true, message: 'Receipt scan failed' });
  }
});

// ─── Monthly financial story ──────────────────────────────────────────────────

router.get('/insights/monthly', auth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const org = await get('SELECT ai_provider, ai_model FROM organizations WHERE id = ?', [req.user.orgId]);
    const provider = org?.ai_provider || aiService.PROVIDER;

    // Check cache
    const cached = await get(
      `SELECT content FROM ai_insights WHERE org_id = ? AND user_id = ? AND period = ? AND type = 'monthly'`,
      [req.user.orgId, req.user.id, month]
    );
    if (cached) return res.json({ insight: JSON.parse(cached.content), cached: true, provider });

    // Gather data
    const [spending, income, topExpenses, budgets] = await Promise.all([
      query(
        `SELECT COALESCE(t.category, 'Uncategorized') as category, SUM(ABS(t.amount)) as total
         FROM transactions t
         WHERE t.user_id = ? AND t.type = 'expense' AND strftime('%Y-%m', t.date) = ?
         GROUP BY t.category ORDER BY total DESC LIMIT 10`,
        [req.user.id, month]
      ),
      query(
        `SELECT SUM(t.amount) as total FROM transactions t
         WHERE t.user_id = ? AND t.type = 'income' AND strftime('%Y-%m', t.date) = ?`,
        [req.user.id, month]
      ),
      query(
        `SELECT t.description, t.amount, t.date FROM transactions t
         WHERE t.user_id = ? AND t.type = 'expense' AND strftime('%Y-%m', t.date) = ?
         ORDER BY ABS(t.amount) DESC LIMIT 5`,
        [req.user.id, month]
      ),
      query(
        `SELECT b.category as name, b.amount as budget, COALESCE(SUM(ABS(t.amount)),0) as spent
         FROM budgets b
         LEFT JOIN transactions t ON t.category = b.category AND t.user_id = b.user_id
           AND t.type = 'expense' AND strftime('%Y-%m', t.date) = ?
         WHERE b.user_id = ? GROUP BY b.category`,
        [month, req.user.id]
      ),
    ]);

    const totalSpent = spending.reduce((s, r) => s + r.total, 0);
    const totalIncome = income[0]?.total || 0;

    const dataContext = JSON.stringify({ month, totalIncome, totalSpent, spending, topExpenses, budgets });

    const response = await aiService.chat([
      {
        role: 'user',
        content: `You are a personal CFO. Write a brief monthly financial story (3-4 sentences) based on this data.
Be specific with numbers. Highlight the most important insight. End with one actionable tip.
Data: ${dataContext}`,
      },
    ], null, provider);

    const insight = { text: aiService.extractText(response), month, totalIncome, totalSpent };

    // Cache it
    await run(
      `INSERT INTO ai_insights (org_id, user_id, period, type, content, model)
       VALUES (?, ?, ?, 'monthly', ?, ?)
       ON CONFLICT(org_id, period, type) DO UPDATE SET content = excluded.content, model = excluded.model`,
      [req.user.orgId, req.user.id, month, JSON.stringify(insight), aiService.resolveModel(provider)]
    );

    res.json({ insight, cached: false, provider });
  } catch (error) {
    console.error('AI monthly insight error:', error);
    res.status(500).json({ error: true, message: 'Failed to generate monthly insight' });
  }
});

// ─── Weekly brief ─────────────────────────────────────────────────────────────

router.get('/insights/weekly', auth, async (req, res) => {
  try {
    const org = await get('SELECT ai_provider FROM organizations WHERE id = ?', [req.user.orgId]);
    const provider = org?.ai_provider || aiService.PROVIDER;

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const since = weekStart.toISOString().slice(0, 10);

    const [transactions, dailyTotals] = await Promise.all([
      query(
        `SELECT t.amount, t.description, t.date, t.type, COALESCE(t.category, 'Uncategorized') as category
         FROM transactions t
         WHERE t.user_id = ? AND t.date >= ? ORDER BY t.date DESC`,
        [req.user.id, since]
      ),
      query(
        `SELECT date, SUM(CASE WHEN type='expense' THEN ABS(amount) ELSE 0 END) as spent,
                SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as earned
         FROM transactions WHERE user_id = ? AND date >= ?
         GROUP BY date ORDER BY date`,
        [req.user.id, since]
      ),
    ]);

    const totalSpent = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);
    const totalEarned = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);

    const response = await aiService.chat([
      {
        role: 'user',
        content: `Write a 2-3 sentence weekly spending brief. Be specific, casual, and friendly.
Data: ${JSON.stringify({ since, totalSpent, totalEarned, dailyTotals, recentTransactions: transactions.slice(0, 10) })}`,
      },
    ], null, provider);

    res.json({
      brief: aiService.extractText(response),
      totalSpent,
      totalEarned,
      transactionCount: transactions.length,
      provider,
    });
  } catch (error) {
    console.error('AI weekly brief error:', error);
    res.status(500).json({ error: true, message: 'Failed to generate weekly brief' });
  }
});

module.exports = router;
