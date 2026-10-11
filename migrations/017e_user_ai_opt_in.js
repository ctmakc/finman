// 017e — users.ai_opt_in (ADDITIVE, idempotent).
//
// 0 = the user has not used/enabled the AI CFO: LLM-backed insight endpoints
// (dashboard monthly story / weekly brief) answer with deterministic numbers
// and nothing about the user's finances is sent to the AI provider; receipt
// OCR stays on local tesseract. Set to 1 when the user opens the AI page,
// sends a chat message, or enables AI explicitly (POST /api/ai/opt-in).
module.exports = {
  name: '017e_user_ai_opt_in',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'users', 'ai_opt_in'))) {
      await db.run(`ALTER TABLE users ADD COLUMN ai_opt_in INTEGER NOT NULL DEFAULT 0`);
    }
  },
};
