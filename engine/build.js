#!/usr/bin/env node
// engine/build.js — builds the Finman Vault engine (docs/E2E-ENCRYPTION.md §4).
//
//   node engine/build.js            (npm run build:engine)
//
// 1. engine/schema.sql — a fresh SQLite DB built by the real initDatabase() + every
//    migration (lib/migrate.js) in a temp file, schema dumped (tables, indexes, triggers,
//    views; data only for schema_migrations so later upgrades know what already ran).
// 2. public/js/vault/engine.js   — IIFE, global FinmanEngine, platform browser, minified.
// 3. engine/dist/engine.node.cjs — the same engine as CommonJS for Node (consent-MCP).
// 4. public/vendor/sqljs/sql-wasm.js + sql-wasm.wasm — sql.js browser build.
//
// The bundles contain the server's own routes/ models/ services/ with server-only modules
// swapped for engine/shims (see PLUGIN below). Nothing in them reads process.env, the disk,
// or the server database.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = __dirname;
const SHIMS = path.join(ENGINE, 'shims');
const OUT_BROWSER = path.join(ROOT, 'public', 'js', 'vault', 'engine.js');
const OUT_NODE = path.join(ENGINE, 'dist', 'engine.node.cjs');
const OUT_SQLJS = path.join(ROOT, 'public', 'vendor', 'sqljs');
const SCHEMA_FILE = path.join(ENGINE, 'schema.sql');

// ---------------------------------------------------------------- schema.sql
// CREATE TABLE IF NOT EXISTS blocks written inline in routes/ services/ models/ (lazy tables).
function lazyTables() {
  const out = [];
  for (const dir of ['routes', 'services', 'models']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js')) {
          const src = fs.readFileSync(f, 'utf8');
          const re = /CREATE TABLE IF NOT EXISTS\s+\w+\s*\(/g;
          let m;
          while ((m = re.exec(src))) {
            let depth = 1; let i = m.index + m[0].length;
            while (i < src.length && depth) { if (src[i] === '(') depth += 1; else if (src[i] === ')') depth -= 1; i += 1; }
            out.push(src.slice(m.index, i));
          }
        }
      }
    };
    walk(path.join(ROOT, dir));
  }
  return out;
}

function buildSchema() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'finman-engine-schema-'));
  const dbFile = path.join(tmp, 'schema.db');
  const script = `
    const { initDatabase, closeDatabase, query } = require(${JSON.stringify(path.join(ROOT, 'db', 'database'))});
    (async () => {
      await initDatabase();
      // Tables some routes create lazily on first use (e.g. routes/onboarding.js onboarding_progress).
      const { run } = require(${JSON.stringify(path.join(ROOT, 'db', 'database'))});
      for (const ddl of ${JSON.stringify(lazyTables())}) await run(ddl);
      const objs = await query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid");
      const migs = await query('SELECT name FROM schema_migrations ORDER BY id');
      require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'schema.json'))}, JSON.stringify({ objs, migs: migs.map((m) => m.name) }));
      await closeDatabase();
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      TMPDIR: tmp,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_PATH: dbFile,
      JWT_SECRET: 'schema-build',
      SESSION_SECRET: 'schema-build',
      ENCRYPTION_KEY: '0'.repeat(64),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`schema build failed:\n${r.stderr}`); }
  const { objs, migs } = JSON.parse(fs.readFileSync(path.join(tmp, 'schema.json'), 'utf8'));
  fs.rmSync(tmp, { recursive: true, force: true });

  const ifNotExists = (sql, type) => {
    const re = {
      table: /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS)/i,
      index: /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i,
      trigger: /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(?!IF\s+NOT\s+EXISTS)/i,
      view: /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\s+(?!IF\s+NOT\s+EXISTS)/i,
    }[type];
    if (!re) return sql;
    return sql.trim().replace(re, (m) => `${m}IF NOT EXISTS `);
  };
  const rank = { table: 0, index: 1, view: 2, trigger: 3 };
  const sorted = objs.filter((o) => rank[o.type] !== undefined).sort((a, b) => rank[a.type] - rank[b.type]);
  const parts = sorted.map((o) => `${ifNotExists(o.sql, o.type)};`);
  for (const name of migs) parts.push(`INSERT OR IGNORE INTO schema_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`);
  const header = `-- engine/schema.sql — GENERATED by engine/build.js from db/database.js initDatabase() + migrations/.\n-- Do not edit. ${sorted.filter((o) => o.type === 'table').length} tables, ${migs.length} migrations.\n`;
  // Blocks separated by a line holding only ';;' (engine/src/schema.js splits on it).
  const text = header + parts.join('\n;;\n') + '\n';
  fs.writeFileSync(SCHEMA_FILE, text);
  return { tables: sorted.filter((o) => o.type === 'table').length, migrations: migs.length };
}

// ---------------------------------------------------------------- esbuild plugin
const p = (...a) => path.join(...a);
const FILE_SWAPS = new Map([
  [p(ROOT, 'db', 'database.js'), p(SHIMS, 'database.js')],
  [p(ROOT, 'config', 'config.js'), p(SHIMS, 'config.js')],
  [p(ROOT, 'lib', 'ai', 'provider.js'), p(ENGINE, 'src', 'aiProvider.js')],
  [p(ROOT, 'services', 'tracker.js'), p(SHIMS, 'tracker.js')],
  // Invoice PDF: loaded on demand from public/js/vault/invoice-pdf.js (pdfkit is ~2 MB).
  [p(ROOT, 'services', 'invoice', 'pdf.js'), p(SHIMS, 'invoicePdf.js')],
]);
const OUT_PDF = path.join(ROOT, 'public', 'js', 'vault', 'invoice-pdf.js');

const MODULE_SHIMS = {
  express: p(SHIMS, 'express.js'),
  passport: p(SHIMS, 'passport.js'),
  multer: p(SHIMS, 'multer.js'),
  axios: p(SHIMS, 'axios.js'),
  pino: p(SHIMS, 'pino.js'),
  crypto: p(SHIMS, 'crypto.js'),
  fs: p(SHIMS, 'fs.js'),
  'fs/promises': null, // virtual below
  path: p(SHIMS, 'path.js'),
};
const VIRTUAL = {
  net: `module.exports = require(${JSON.stringify(p(SHIMS, 'node-net.js'))}).net;`,
  dns: `module.exports = require(${JSON.stringify(p(SHIMS, 'node-net.js'))}).dns;`,
  http: `module.exports = require(${JSON.stringify(p(SHIMS, 'node-net.js'))}).http;`,
  https: `module.exports = require(${JSON.stringify(p(SHIMS, 'node-net.js'))}).https;`,
  os: `module.exports = require(${JSON.stringify(p(SHIMS, 'node-net.js'))}).os;`,
  'fs/promises': `module.exports = require(${JSON.stringify(p(SHIMS, 'fs.js'))}).promises;`,
  'express-rate-limit': `module.exports = require(${JSON.stringify(p(SHIMS, 'misc.js'))}).rateLimit;`,
  dotenv: `module.exports = require(${JSON.stringify(p(SHIMS, 'misc.js'))}).dotenv;`,
  async_hooks: `module.exports = require(${JSON.stringify(p(SHIMS, 'misc.js'))}).asyncHooks;`,
};
const STUBS = ['bcrypt', 'bcryptjs', 'stripe', 'web-push', 'node-cron', 'pdfkit', 'qrcode', 'tesseract.js', 'maxmind', 'sqlite3',
  'jsonwebtoken', 'passport-jwt', 'passport-local', 'passport-google-oauth20', 'cookie-parser', 'cors', 'helmet', 'express-session',
  'pino-http', 'child_process', 'worker_threads', 'zlib', 'stream', 'tls', 'cluster', 'v8', 'vm', 'readline'];
// Real Node builtins that have browser stand-ins we may want instead of a stub.
const REAL_BROWSER_OK = new Set(['buffer']);

function migrationsModule() {
  const dir = p(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d.*\.js$/.test(f)).sort(); // lib/migrate.js order
  return `module.exports = [\n${files.map((f) => `  { file: ${JSON.stringify(f)}, mod: require(${JSON.stringify(p(dir, f))}) },`).join('\n')}\n];`;
}

const plugin = {
  name: 'finman-vault-shims',
  setup(build) {
    build.onResolve({ filter: /^finman-engine:migrations$/ }, () => ({ path: 'migrations', namespace: 'finman-virtual' }));
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.namespace === 'finman-virtual' && !args.path.startsWith('/')) { /* fallthrough to bare handling */ }
      let spec = args.path;
      if (spec.startsWith('node:')) spec = spec.slice(5);
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const base = path.resolve(args.resolveDir || ROOT, spec);
        for (const cand of [base, `${base}.js`, p(base, 'index.js')]) {
          if (FILE_SWAPS.has(cand)) return { path: FILE_SWAPS.get(cand) };
        }
        return undefined;
      }
      if (MODULE_SHIMS[spec]) return { path: MODULE_SHIMS[spec] };
      if (VIRTUAL[spec]) return { path: spec, namespace: 'finman-virtual' };
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (STUBS.includes(root)) return { path: root, namespace: 'finman-stub' };
      if (REAL_BROWSER_OK.has(root)) return undefined;
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'finman-virtual' }, (args) => ({
      contents: args.path === 'migrations' ? migrationsModule() : VIRTUAL[args.path],
      loader: 'js',
      resolveDir: ROOT,
    }));
    build.onLoad({ filter: /.*/, namespace: 'finman-stub' }, (args) => ({
      contents: `module.exports = require(${JSON.stringify(p(SHIMS, 'stub.js'))})(${JSON.stringify(args.path)});`,
      loader: 'js',
      resolveDir: ROOT,
    }));
  },
};

function common() {
  return {
    entryPoints: [p(ENGINE, 'src', 'index.js')],
    bundle: true,
    plugins: [plugin],
    inject: [p(SHIMS, 'globals.js')],
    define: { global: 'globalThis', __dirname: '"/vault"', __filename: '"/vault/index.js"' },
    loader: { '.sql': 'text' },
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  };
}

function copySqlJs() {
  const dist = p(ROOT, 'node_modules', 'sql.js', 'dist');
  fs.mkdirSync(OUT_SQLJS, { recursive: true });
  // sql-wasm-browser.js is the browser build (no Node fs/path branches) of sql-wasm.js.
  const js = fs.existsSync(p(dist, 'sql-wasm-browser.js')) ? 'sql-wasm-browser.js' : 'sql-wasm.js';
  const wasm = fs.existsSync(p(dist, 'sql-wasm-browser.wasm')) ? 'sql-wasm-browser.wasm' : 'sql-wasm.wasm';
  fs.copyFileSync(p(dist, js), p(OUT_SQLJS, 'sql-wasm.js'));
  fs.copyFileSync(p(dist, wasm), p(OUT_SQLJS, 'sql-wasm.wasm'));
  return { js, wasm };
}

function nodeBuiltinsLeft(metafile) {
  const left = new Set();
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const imp of info.imports) if (imp.external && !imp.path.startsWith('/') && imp.path !== '<runtime>') left.add(`${imp.path} (${file})`);
  }
  return [...left];
}

async function main() {
  const t0 = Date.now();
  const schema = buildSchema();
  fs.mkdirSync(path.dirname(OUT_BROWSER), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_NODE), { recursive: true });

  const browser = await esbuild.build({
    ...common(),
    outfile: OUT_BROWSER,
    platform: 'browser',
    format: 'iife',
    globalName: 'FinmanEngine',
    minify: true,
    sourcemap: false,
    banner: { js: '/* Finman Vault engine — generated by engine/build.js; do not edit. */' },
  });
  const node = await esbuild.build({
    ...common(),
    outfile: OUT_NODE,
    platform: 'node',
    format: 'cjs',
    minify: false,
    banner: { js: '/* Finman Vault engine (Node build) — generated by engine/build.js; do not edit. */' },
  });
  // The invoice PDF for vault accounts: services/invoice/pdf.js + pdfkit's browser build.
  const pdfBundle = await esbuild.build({
    entryPoints: [p(ENGINE, 'pdf', 'browser.js')],
    bundle: true,
    outfile: OUT_PDF,
    platform: 'browser',
    format: 'iife',
    minify: true,
    target: ['es2020'],
    legalComments: 'none',
    logLevel: 'warning',
    inject: [p(SHIMS, 'globals.js')],
    define: { global: 'globalThis', __dirname: '"/vault"', __filename: '"/vault/pdf.js"' },
    alias: { pdfkit: p(ROOT, 'node_modules', 'pdfkit', 'js', 'pdfkit.standalone.js'), path: p(SHIMS, 'path.js'), fs: p(SHIMS, 'fs.js') },
    banner: { js: '/* Finman invoice PDF (vault) — generated by engine/build.js; do not edit. */' },
    metafile: true,
  });
  const extPdf = nodeBuiltinsLeft(pdfBundle.metafile);
  if (extPdf.length) throw new Error(`invoice PDF bundle left unresolved imports: ${extPdf.join(', ')}`);
  const sqljs = copySqlJs();

  const extBrowser = nodeBuiltinsLeft(browser.metafile);
  const extNode = nodeBuiltinsLeft(node.metafile);
  if (extBrowser.length) throw new Error(`browser bundle left unresolved imports: ${extBrowser.join(', ')}`);
  const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
  console.log(`engine: schema.sql ${schema.tables} tables / ${schema.migrations} migrations`);
  console.log(`engine: ${path.relative(ROOT, OUT_BROWSER)} ${kb(OUT_BROWSER)}, ${path.relative(ROOT, OUT_NODE)} ${kb(OUT_NODE)}${extNode.length ? ` (node externals: ${extNode.join(', ')})` : ''}`);
  console.log(`engine: ${path.relative(ROOT, OUT_PDF)} ${kb(OUT_PDF)}`);
  console.log(`engine: public/vendor/sqljs/sql-wasm.js <- ${sqljs.js}, sql-wasm.wasm <- ${sqljs.wasm}; ${Date.now() - t0} ms`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = { main, buildSchema };
