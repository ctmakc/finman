// 019 — client-generated id for idempotent POST /api/transactions (ADDITIVE, idempotent).
//
// The offline queue (public/js/offline.js) replays a transaction with the same
// clientTxId / Idempotency-Key. Without a stored id a replay after a lost
// response created the transaction twice. Unique per ledger owner, NULLs free.
module.exports = {
  name: '019_transactions_client_tx_id',
  async up(db, { columnExists }) {
    if (!(await columnExists(db, 'transactions', 'client_tx_id'))) {
      await db.run(`ALTER TABLE transactions ADD COLUMN client_tx_id TEXT`);
    }
    await db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_client_tx_id
       ON transactions (user_id, client_tx_id) WHERE client_tx_id IS NOT NULL`
    );
  },
};
