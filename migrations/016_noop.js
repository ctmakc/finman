// 016_noop — placeholder migration for the "ledger-export" stream.
//
// The Beancount/Ledger export is READ-ONLY: it derives its output entirely
// from existing accounts/transactions and adds no schema. This no-op simply
// reserves the 016 migration prefix so the export stream owns a slot in the
// numbered migration sequence and future schema additions (if ever needed)
// have a reserved home without colliding with other streams.
module.exports = {
  name: '016_noop',
  async up() {
    // Intentionally empty — no schema changes for the ledger-export stream.
  },
};
