// lib/bodyFields.js — accept both camelCase and snake_case request bodies.
//
// The public API docs use camelCase (targetAmount, dueDate...) while the PWA
// posts snake_case (target_amount, due_date...). Routes normalise the body once
// through normalizeBody(body, FIELD_MAP) and validate with requireFields(), which
// returns the list of missing fields for a 400 with an English message.

function snakeToCamel(key) {
  return String(key).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Build { snake_case: value } from a body that may mix both styles.
// map: { snake_case: ['camelAlias', ...] } (the snakeToCamel form is always accepted).
// Explicit snake_case keys win over aliases; empty strings count as missing.
function normalizeBody(body, map) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const [snake, aliases] of Object.entries(map)) {
    const candidates = [snake, snakeToCamel(snake), ...(aliases || [])];
    for (const key of candidates) {
      if (src[key] !== undefined && src[key] !== null && src[key] !== '') {
        out[snake] = src[key];
        break;
      }
    }
  }
  return out;
}

// Returns the names of required fields that are missing (undefined/null/'').
function missingFields(data, required) {
  return required.filter((f) => data[f] === undefined || data[f] === null || data[f] === '');
}

// English 400 payload listing what is missing. Keeps the legacy
// { message } shape plus a machine-readable list.
function missingFieldsMessage(missing) {
  return `Missing required fields: ${missing.join(', ')}`;
}

module.exports = { snakeToCamel, normalizeBody, missingFields, missingFieldsMessage };
