// routes/ai.js — F4 AI Financial CFO.
// Монтируется в server.js как: apiAuthMiddleware, requireTier('pro'), aiRoutes
// => к моменту хендлера req.user уже заполнен и тариф >= pro проверен.
//
// Эндпоинты:
//   POST /api/ai/chat      body { conversationId?, message } -> { conversationId, reply, messages }
//   GET  /api/ai/insights  -> { analysis, insight }   (анализ трат, заземлённый на данные)
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
