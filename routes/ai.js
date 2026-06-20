// routes/ai.js — F4 AI Financial CFO (+ Wave-2: streaming, autocat, summary).
// Монтируется в server.js как: apiAuthMiddleware, requireTier('pro'), aiRoutes
// => к моменту хендлера req.user уже заполнен и тариф >= pro проверен.
//
// Эндпоинты:
//   POST /api/ai/chat         body { conversationId?, message } -> { conversationId, reply, messages }
//   POST /api/ai/chat/stream  body { conversationId?, message } -> text/event-stream (SSE)
//                             события: start | chunk | done | error
//   GET  /api/ai/insights     -> { analysis, insight }   (анализ трат, заземлённый на данные)
//   GET  /api/ai/categorize   -> { suggestions, categories, uncategorizedCount, aiUsed }
//   POST /api/ai/categorize   body { accepted: [{transactionId, category}] } -> { applied, appliedIds }
//   GET  /api/ai/summary      ?month=YYYY-MM -> { month, stats, narrative, aiUsed }
//   GET  /api/ai/conversations              -> список разговоров пользователя
//   GET  /api/ai/conversations/:id          -> разговор с сообщениями
//
// Если AI-провайдер не настроен — корректный 503 AI_NOT_CONFIGURED (через AppError).
// Ошибки бросаются как AppError и форматируются центральным errorHandler.

const express = require('express');
const router = express.Router();

const { ok } = require('../lib/respond');
const { AppError } = require('../middleware/error');
const aiService = require('../services/aiService');
const provider = require('../lib/ai/provider');
const AiConversation = require('../models/aiConversation');

// Обёртка для async-хендлеров: пробрасывает ошибки в errorHandler.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// POST /api/ai/chat — диалог с CFO.
router.post(
  '/chat',
  wrap(async (req, res) => {
    const { conversationId, message } = req.body || {};
    if (!message || !String(message).trim()) {
      throw new AppError(400, 'EMPTY_MESSAGE', 'Field "message" is required');
    }
    if (!provider.isConfigured()) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
    }
    const result = await aiService.chat(req.user.id, conversationId, message);
    return ok(res, result);
  })
);

// POST /api/ai/chat/stream — потоковый диалог через Server-Sent Events.
// Тело: { conversationId?, message }. Ответ: text/event-stream.
// События (каждое — `event: <name>\ndata: <json>\n\n`):
//   start { conversationId }
//   chunk { text }            (несколько; склейка даёт полный ответ)
//   done  { conversationId, reply }
//   error { code, message }   (если генерация упала после открытия потока)
// Валидацию входа/конфиг провайдера делаем ДО открытия SSE, чтобы вернуть
// нормальный JSON-код ошибки (400/503) через errorHandler.
router.post(
  '/chat/stream',
  wrap(async (req, res) => {
    const { conversationId, message } = req.body || {};
    if (!message || !String(message).trim()) {
      throw new AppError(400, 'EMPTY_MESSAGE', 'Field "message" is required');
    }
    if (!provider.isConfigured()) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider not configured');
    }

    // Открываем SSE-поток.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await aiService.chatStream(req.user.id, conversationId, message, {
        onStart: ({ conversationId: cid }) => send('start', { conversationId: cid }),
        onChunk: (text) => send('chunk', { text }),
        onDone: ({ conversationId: cid, reply }) =>
          send('done', { conversationId: cid, reply }),
      });
    } catch (err) {
      // Поток уже открыт — отдаём ошибку как SSE-событие, затем закрываем.
      send('error', {
        code: err.code || 'AI_STREAM_FAILED',
        message: err.message || 'Streaming failed',
      });
    } finally {
      res.end();
    }
  })
);

// GET /api/ai/categorize — предложения авто-категоризации (без записи в БД).
router.get(
  '/categorize',
  wrap(async (req, res) => {
    const result = await aiService.autoCategorize(req.user.id);
    return ok(res, result);
  })
);

// POST /api/ai/categorize — применить ПРИНЯТЫЕ назначения категорий.
// Тело: { accepted: [{ transactionId, category }, ...] }.
router.post(
  '/categorize',
  wrap(async (req, res) => {
    const accepted = (req.body && req.body.accepted) || [];
    if (!Array.isArray(accepted)) {
      throw new AppError(400, 'INVALID_BODY', 'Field "accepted" must be an array');
    }
    const result = await aiService.applyCategorizations(req.user.id, accepted);
    return ok(res, result);
  })
);

// GET /api/ai/summary — месячная «история денег».
// Query: month=YYYY-MM (опционально; по умолчанию текущий месяц).
router.get(
  '/summary',
  wrap(async (req, res) => {
    const month = (req.query && req.query.month) || undefined;
    const result = await aiService.monthlyNarrative(req.user.id, month);
    return ok(res, result);
  })
);

// GET /api/ai/insights — анализ трат + (если провайдер настроен) ИИ-инсайт.
router.get(
  '/insights',
  wrap(async (req, res) => {
    const result = await aiService.analyzeSpending(req.user.id);
    return ok(res, {
      analysis: result.analysis,
      insight: result.insight,
      aiConfigured: provider.isConfigured(),
    });
  })
);

// GET /api/ai/plan — проактивный финансовый план (CFO-коучинг): целевые сбережения,
// сокращения по категориям, финансирование целей, стратегия долгов, топ-3 действия.
router.get(
  '/plan',
  wrap(async (req, res) => {
    const result = await aiService.buildFinancialPlan(req.user.id);
    return ok(res, {
      plan: result.plan,
      planText: result.planText,
      aiConfigured: provider.isConfigured(),
    });
  })
);

// POST /api/ai/whatif — симуляция «что если»: cuts[{category,percent}] + extraMonthlySaving.
router.post(
  '/whatif',
  wrap(async (req, res) => {
    const body = req.body || {};
    const scenario = {
      cuts: Array.isArray(body.cuts) ? body.cuts : [],
      extraMonthlySaving: body.extraMonthlySaving,
    };
    const out = await aiService.simulateScenario(req.user.id, scenario);
    return ok(res, {
      result: out.result,
      narrative: out.narrative,
      aiConfigured: provider.isConfigured(),
    });
  })
);

// GET /api/ai/conversations — список разговоров пользователя.
router.get(
  '/conversations',
  wrap(async (req, res) => {
    const conversations = await AiConversation.findByUser(req.user.id);
    return ok(res, conversations);
  })
);

// GET /api/ai/conversations/:id — разговор с сообщениями (с проверкой владения).
router.get(
  '/conversations/:id',
  wrap(async (req, res) => {
    const conversation = await AiConversation.findById(req.params.id);
    if (!conversation) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    if (conversation.user_id !== req.user.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not your conversation');
    }
    const full = await AiConversation.getWithMessages(conversation.id);
    return ok(res, full);
  })
);

module.exports = router;
