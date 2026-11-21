// Same helper lib/migrate.js hands to migrations (lib/migrate.js itself reads the
// migrations folder from disk, which the bundle cannot).
'use strict';

async function columnExists(dbHelpers, table, column) {
  const rows = await dbHelpers.query(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

module.exports = { columnExists };
