# PR notes — cloud/tests-1102: behaviour tests for untested logic

Test-only change. No application code was modified.

## Numbers (`npx jest --runInBand`, Node, full suite)

| Run    | Suites (failed/total) | Tests total | Passed | Failed | Skipped |
|--------|-----------------------|-------------|--------|--------|---------|
| Before | 2 / 67                | 899         | 897    | 2      | 0       |
| After  | 2 / 72                | 990         | 986    | 2      | 2       |

+5 suites, +91 tests (89 passing, 2 skipped as confirmed bugs). The 2 failures
are pre-existing and identical before and after (see below).

## New test files

- `test/unit-sanitize-bodyfields-txfilter.test.js` — `lib/sanitize` (had no tests:
  HTML escaping, control-char stripping, maxLength, filename path traversal),
  `lib/bodyFields` precedence (snake > camel > alias, empty/null fall through, 0/false kept),
  `lib/txFilter.cashflowOnly` SQL fragment/params, `lib/money` edge cases.
- `test/unit-import-categorizer.test.js` — `categorizeByMcc` (had no tests: exact codes,
  range fallbacks, exact-beats-range, gaps/junk), keyword rule order and word boundaries.
- `test/unit-rules-ledger.test.js` — `rulesEngine.ruleMatches` (abs amounts, case-insensitive
  text, empty needle, invalid regex), `previewRules` ordering, `applyToUncategorized` with a
  mocked DB (dry run, user-scoped writes, changed-row count); `ledgerExport` Beancount helpers.
- `test/unit-subscriptions-fx-tier.test.js` — subscription detector frequency bands and the
  full `detectRecurring` pipeline on mocked rows; `lib/fx.createConverter` (rate cache,
  service fallback, 1:1 fallback + `missingRates`, `regroup`/`totals`); `requireTier`
  (401/402, DB fallback + caching, DB error -> free); `validateEnv` (prod throw, dev warn).
- `test/unit-ofx-parse.test.js` — inline SGML statements: DEBIT/CREDIT sign normalisation,
  TRNTYPE category, entity decoding, memo de-duplication, cheque number, per-row errors,
  FITID duplicate detection.

DB-touching modules are tested with `jest.mock('../db/database')`; no SQLite file is used.

## Confirmed bugs (tests are `test.skip('bug: ...')`; each fails when un-skipped)

- **rulesEngine: amount rules with op `regex` never match.** `ruleMatches` does
  `Number(match_value)` for `match_field = 'amount'` and returns `false` when it is not finite,
  before reaching its own `regex` branch. The model accepts `amount` + `regex`, so a rule such as
  `^19\d$` or `\.99$` is silently dead. (`services/rulesEngine.js`, amount path of `ruleMatches`.)
- **ledgerExport: `normalizeDate` shifts non-ISO dates one day back east of UTC.**
  `new Date('March 5, 2026').toISOString()` parses local midnight and prints UTC, so with
  `TZ=Europe/Kyiv` the export writes `2026-03-04`. ISO `YYYY-MM-DD` dates (the normal storage
  format) are not affected. (`services/ledgerExport.js`, `normalizeDate`.)

## Pre-existing failures (not touched, present before and after)

- `test/demo-seed.test.js` — "bootHook seeds the household once": expected 200 transactions,
  got 199.
- `test/fe-review.test.js` — "ymd uses the local calendar, late evening included": expected
  `2026-11-01`, got `2026-10-31`. Likely date/timezone dependent (run on 2026-11-02, UTC container).

## Observation (not filed as a bug)

- `lib/sanitize.sanitizeFilename` turns non-Latin names into underscores (`отчёт.pdf` -> `_.pdf`),
  so distinct Cyrillic names collide. The helper is not used anywhere in the app today.
