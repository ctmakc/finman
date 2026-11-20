#!/usr/bin/env node
// eval/run_eval.js — runs the Statement Agent on every file of eval/statements (fictional,
// ground truth in manifest.json) with the instance AI and scores it.
//
//   STATEMENT_AI_PROVIDER=google GEMINI_API_KEY=… STATEMENT_AI_MODEL=gemini-3.5-flash-lite node eval/run_eval.js [filter]
//
// Metrics: proven to the cent (expected proof_ok), planted errors caught (expected proof_fail),
// missing closing detected, FALSE ACCEPTS (proven while the truth says it must not be, or proven
// with rows that differ from the truth — must be 0), row accuracy (date + cents), opening/closing
// read right, model calls, tokens and seconds per statement. Writes eval/results/<model>-<stamp>.json.
'use strict';

const fs = require('fs');
const path = require('path');
const agent = require('../services/statement/agent');

const DIR = path.join(__dirname, 'statements');
const OUT = path.join(__dirname, 'results');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS || 3000);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function rowMatches(got, truth) {
  const key = (r) => `${r.date}|${r.cents}`;
  const bag = new Map();
  for (const r of truth) bag.set(key(r), (bag.get(key(r)) || 0) + 1);
  let hit = 0;
  for (const r of got) { const k = key(r); const n = bag.get(k) || 0; if (n > 0) { hit += 1; bag.set(k, n - 1); } }
  return hit;
}

(async () => {
  const results = [];
  const names = Object.keys(manifest.files).filter((n) => !filter || filter.test(n));
  for (const name of names) {
    const truth = manifest.files[name];
    const buf = fs.readFileSync(path.join(DIR, name));
    const t0 = Date.now();
    let r = null; let err = null;
    try { r = await agent.read({ buffer: buf, mime: '', fileName: name, ai: { source: 'platform' } }); } catch (e) { err = `${e.code || ''} ${e.message}`.trim(); }
    const card = truth.sign_convention && truth.sign_convention.startsWith('card');
    const tOpen = truth.opening_cents === null || truth.opening_cents === undefined ? null : (card ? -truth.opening_cents : truth.opening_cents);
    const tClose = truth.closing_cents === null || truth.closing_cents === undefined ? null : (card ? -truth.closing_cents : truth.closing_cents);
    const rec = { file: name, kind: truth.kind, expect: truth.expect, planted: truth.planted ? truth.planted.type : null, truth_rows: truth.rows.length, ms: Date.now() - t0, error: err };
    if (r) {
      const hit = rowMatches(r.rows, truth.rows);
      const exact = hit === truth.rows.length && r.rows.length === truth.rows.length;
      const amountsOnly = rowMatches(r.rows.map((x) => ({ ...x, date: '' })), truth.rows.map((x) => ({ ...x, date: '' })));
      rec.amounts_right = amountsOnly;
      rec.mismatches = r.rows.map((x, i) => [i, x, truth.rows[i]]).filter(([, x, t]) => !t || x.date !== t.date || x.cents !== t.cents).slice(0, 4)
        .map(([i, x, t]) => ({ row: i, got: `${x.date} ${x.cents}`, truth: t ? `${t.date} ${t.cents}` : null }));
      Object.assign(rec, {
        status: r.proof.status, line: r.proof.line, mode: r.mode, statement_type: r.meta.statement_type,
        rows: r.rows.length, rows_right: hit, rows_exact: exact,
        opening_right: r.proof.opening_cents === tOpen, closing_right: r.meta.closing_cents === tClose,
        attempts: r.attempts.length, calls: r.usage.calls, tokens_in: r.usage.input, tokens_out: r.usage.output, model: r.usage.model,
        derived: (r.proof.derived_rows || []).length, ungrounded: (r.proof.ungrounded_rows || []).length,
        first_break: r.proof.first_break ? { row: r.proof.first_break.index, page: r.proof.first_break.page } : null,
      });
      const proven = r.proof.status === 'proven';
      rec.outcome = truth.expect === 'proof_ok' ? (proven ? (exact ? 'proven_correct' : 'FALSE_ACCEPT_wrong_rows') : 'not_proven')
        : truth.expect === 'proof_fail' ? (proven ? 'FALSE_ACCEPT_planted_error' : 'caught')
          : (['needs_closing', 'needs_opening'].includes(r.proof.status) ? 'asked_for_balance' : proven ? 'FALSE_ACCEPT_no_closing' : 'other');
    } else rec.outcome = 'error';
    results.push(rec);
    console.log(`${name.padEnd(44)} ${String(rec.outcome).padEnd(26)} ${rec.status || ''} rows ${rec.rows_right ?? '-'}/${rec.truth_rows} calls ${rec.calls ?? '-'} ${(rec.ms / 1000).toFixed(1)}s ${err || ''}`);
    await sleep(PAUSE_MS);
  }
  const ok = results.filter((x) => x.expect === 'proof_ok');
  const fail = results.filter((x) => x.expect === 'proof_fail');
  const nc = results.filter((x) => x.expect === 'needs_closing');
  const done = results.filter((x) => !x.error);
  const summary = {
    model: (done[0] && done[0].model) || process.env.STATEMENT_AI_MODEL || null,
    run_at: new Date().toISOString(),
    files: results.length,
    proven_correct: `${ok.filter((x) => x.outcome === 'proven_correct').length}/${ok.length}`,
    planted_errors_caught: `${fail.filter((x) => x.outcome === 'caught').length}/${fail.length}`,
    missing_closing_asked: `${nc.filter((x) => x.outcome === 'asked_for_balance').length}/${nc.length}`,
    false_accepts: results.filter((x) => String(x.outcome).startsWith('FALSE_ACCEPT')).length,
    errors: results.filter((x) => x.error).length,
    by_kind: Object.fromEntries(['text-pdf', 'scan-pdf', 'photo'].map((k) => {
      const o = ok.filter((x) => x.kind === k);
      return [k, `${o.filter((x) => x.outcome === 'proven_correct').length}/${o.length} proven`];
    })),
    row_accuracy: `${done.reduce((a, x) => a + (x.rows_right || 0), 0)}/${done.reduce((a, x) => a + x.truth_rows, 0)}`,
    amount_accuracy: `${done.reduce((a, x) => a + (x.amounts_right || 0), 0)}/${done.reduce((a, x) => a + x.truth_rows, 0)}`,
    median_seconds: median(done.map((x) => x.ms / 1000)),
    median_calls: median(done.map((x) => x.calls)),
    median_tokens_in: median(done.map((x) => x.tokens_in)),
    median_tokens_out: median(done.map((x) => x.tokens_out)),
  };
  console.log(JSON.stringify(summary, null, 1));
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${String(summary.model || 'model').replace(/[^\w.-]/g, '_')}-${summary.run_at.slice(0, 16).replace(/[:T]/g, '')}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
  console.log('written', path.relative(process.cwd(), file));
})();
