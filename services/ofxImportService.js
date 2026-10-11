// services/ofxImportService.js — OFX / QFX / QBO statement parser.
//
// Handles both flavours Canadian banks export:
//   OFX 1.x  — SGML: "OFXHEADER:100 ... <OFX><SIGNONMSGSRSV1>..." with leaf
//              elements that have NO closing tag: <TRNAMT>-45.67
//   OFX 2.x  — XML:  "<?xml ...?><?OFX OFXHEADER="200" ...?><OFX>...</OFX>"
// QFX (Quicken) and QBO (QuickBooks) are OFX with Intuit extensions; same parser.
//
// Output uses the same normalized shape as csvImportService so the preview /
// commit route treats both identically:
//   { kind:'ofx', version:'1'|'2', accounts:[{accountId, bankId, accountType,
//     currency, balance, balanceDate}], rows:[{date, description, amount, type,
//     category, currency, externalId, fingerprint, raw}], stats }

const money = require('../lib/money');
const { categorizeByDescription } = require('./importCategorizer');
const { fingerprintOf, markDuplicates, summarize, parseAmount } = require('./csvImportService');

function stripBom(text) {
  return text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isOfx(text) {
  const head = stripBom(String(text || '')).slice(0, 2000);
  return /OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(head) || /<\?OFX/i.test(head);
}

function detectVersion(text) {
  const head = stripBom(String(text || '')).slice(0, 2000);
  if (/<\?xml/i.test(head) || /<\?OFX/i.test(head) || /OFXHEADER="2/i.test(head)) return '2';
  return '1';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      // Out-of-range code points (&#x110000;) made String.fromCodePoint throw.
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const KNOWN_AGGREGATES = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI', 'BANKMSGSRSV1', 'CREDITCARDMSGSRSV1',
  'STMTTRNRS', 'CCSTMTTRNRS', 'STMTRS', 'CCSTMTRS', 'BANKACCTFROM', 'CCACCTFROM', 'BANKACCTTO',
  'CCACCTTO', 'BANKTRANLIST', 'STMTTRN', 'LEDGERBAL', 'AVAILBAL', 'PAYEE', 'CURRENCY',
  'ORIGCURRENCY', 'BALLIST', 'BAL', 'INVSTMTMSGSRSV1', 'INVSTMTTRNRS', 'INVSTMTRS', 'INVACCTFROM',
  'INVTRANLIST', 'INVBANKTRAN', 'SIGNUPMSGSRSV1', 'ACCTINFOTRNRS', 'ACCTINFORS', 'ACCTINFO',
  'BANKACCTINFO', 'CCACCTINFO'
]);
const KNOWN_LEAVES = new Set([
  'CODE', 'SEVERITY', 'MESSAGE', 'DTSERVER', 'LANGUAGE', 'DTPROFUP', 'DTACCTUP', 'ORG', 'FID',
  'INTU.BID', 'INTU.USERID', 'TRNUID', 'CLTCOOKIE', 'CURDEF', 'BANKID', 'BRANCHID', 'ACCTID',
  'ACCTTYPE', 'ACCTKEY', 'DTSTART', 'DTEND', 'TRNTYPE', 'DTPOSTED', 'DTUSER', 'DTAVAIL', 'TRNAMT',
  'FITID', 'CORRECTFITID', 'CORRECTACTION', 'SRVRTID', 'CHECKNUM', 'REFNUM', 'SIC', 'PAYEEID',
  'NAME', 'MEMO', 'EXTDNAME', 'BALAMT', 'DTASOF', 'CURRATE', 'CURSYM', 'MKTGINFO', 'ADDR1', 'ADDR2',
  'ADDR3', 'CITY', 'STATE', 'POSTALCODE', 'COUNTRY', 'PHONE', 'BALTYPE', 'VALUE', 'DESC'
]);

// Tokenize the body (everything from the first "<OFX>") into tags and text.
// Builds a tree where aggregates are { name, children: [] } and leaves are
// { name, value }. Works for SGML (no leaf closing tags) and XML alike.
function parseOfxTree(text) {
  const src = stripBom(String(text || ''));
  const start = src.search(/<OFX>/i);
  if (start === -1) throw new Error('Not an OFX file: <OFX> element not found');
  const body = src.slice(start);
  const re = /<\/?([A-Za-z0-9_.:]+)[^>]*>|([^<]+)/g;
  const root = { name: 'ROOT', children: [] };
  const stack = [root];
  let pendingLeaf = null; // SGML leaf waiting for text

  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[2] !== undefined) {
      const txt = m[2].replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      if (pendingLeaf) {
        pendingLeaf.value = decodeEntities(txt);
        pendingLeaf = null;
      }
      continue;
    }
    const raw = m[0];
    const name = m[1].toUpperCase();
    if (raw.startsWith('<?')) continue; // processing instruction
    if (raw.startsWith('</')) {
      // Closing tag: an XML leaf "</TRNAMT>" closes a leaf we already filled; otherwise pop aggregate.
      if (pendingLeaf && pendingLeaf.name === name) {
        pendingLeaf = null;
        continue;
      }
      pendingLeaf = null;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    // Opening tag. If a previous SGML leaf never got text, it stays with empty value.
    pendingLeaf = null;
    const node = { name, children: null, value: '' };
    stack[stack.length - 1].children.push(node);
    // Leaf vs aggregate: known OFX names first, then peek at what follows
    // (SGML leaves have no closing tag, so an empty leaf looks like an aggregate).
    let isAggregate;
    if (KNOWN_AGGREGATES.has(name)) isAggregate = true;
    else if (KNOWN_LEAVES.has(name)) isAggregate = false;
    else {
      const rest = body.slice(re.lastIndex);
      const closeNow = rest.match(/^\s*<\/([A-Za-z0-9_.:]+)>/);
      isAggregate = /^\s*</.test(rest) && !(closeNow && closeNow[1].toUpperCase() === name);
    }
    if (isAggregate) {
      node.children = [];
      stack.push(node);
    } else {
      pendingLeaf = node; // text (possibly empty) follows -> leaf
    }
  }
  return root;
}

// --- tree helpers -------------------------------------------------------------
function findAll(node, name, acc = []) {
  if (!node || !node.children) return acc;
  for (const ch of node.children) {
    if (ch.name === name) acc.push(ch);
    findAll(ch, name, acc);
  }
  return acc;
}
function child(node, name) {
  return node && node.children ? node.children.find((c) => c.name === name) : undefined;
}
function leaf(node, name) {
  const c = child(node, name);
  return c ? (c.value || '').trim() : '';
}
function deepLeaf(node, name) {
  const hits = findAll(node, name);
  return hits.length ? (hits[0].value || '').trim() : '';
}

// OFX dates: YYYYMMDD, YYYYMMDDHHMMSS, YYYYMMDDHHMMSS.XXX[-5:EST]. Calendar
// date is taken verbatim (bank-local), no timezone shifting.
function parseOfxDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Real calendar check: 20240231 is not a date (the commit route would reject it anyway).
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseOfxAmount(s) {
  const v = parseAmount(s);
  return v == null ? null : money.round(v);
}

const TRNTYPE_CATEGORY = {
  INT: 'Investments',
  DIV: 'Investments',
  FEE: 'Bank Fees',
  SRVCHG: 'Bank Fees',
  ATM: 'Cash',
  CASH: 'Cash',
  XFER: 'Transfer',
  DIRECTDEP: 'Salary',
  REPEATPMT: 'Subscriptions'
};

function describe(trn) {
  const name = leaf(trn, 'NAME');
  const memo = leaf(trn, 'MEMO');
  const payee = deepLeaf(child(trn, 'PAYEE'), 'NAME');
  const parts = [];
  for (const p of [name || payee, memo]) {
    const t = String(p || '').replace(/\s+/g, ' ').trim();
    if (t && !parts.some((x) => x.toLowerCase() === t.toLowerCase() || x.toLowerCase().includes(t.toLowerCase()))) {
      // drop memo when it merely repeats the name
      if (parts.length && t.toLowerCase().includes(parts[0].toLowerCase())) parts[0] = t;
      else parts.push(t);
    }
  }
  return parts.join(' · ') || 'Transaction';
}

// Parse a whole file -> { version, accounts, rows }
function parseOfx(text) {
  const version = detectVersion(text);
  const root = parseOfxTree(text);
  const statements = [...findAll(root, 'STMTRS'), ...findAll(root, 'CCSTMTRS')];
  if (statements.length === 0) {
    throw new Error('No bank or credit-card statement (STMTRS/CCSTMTRS) in this OFX file');
  }
  const accounts = [];
  const rows = [];
  let seq = 0;
  for (const st of statements) {
    const currency = leaf(st, 'CURDEF').toUpperCase() || null;
    const acctFrom = child(st, 'BANKACCTFROM') || child(st, 'CCACCTFROM');
    const account = {
      accountId: acctFrom ? leaf(acctFrom, 'ACCTID') : null,
      bankId: acctFrom ? leaf(acctFrom, 'BANKID') || null : null,
      accountType: acctFrom ? leaf(acctFrom, 'ACCTTYPE') || (child(st, 'CCACCTFROM') ? 'CREDITCARD' : null) : null,
      currency,
      balance: null,
      balanceDate: null,
      dateStart: null,
      dateEnd: null
    };
    const ledger = child(st, 'LEDGERBAL');
    if (ledger) {
      account.balance = parseOfxAmount(leaf(ledger, 'BALAMT'));
      account.balanceDate = parseOfxDate(leaf(ledger, 'DTASOF'));
    }
    const tranList = child(st, 'BANKTRANLIST');
    if (tranList) {
      account.dateStart = parseOfxDate(leaf(tranList, 'DTSTART'));
      account.dateEnd = parseOfxDate(leaf(tranList, 'DTEND'));
    }
    accounts.push(account);

    for (const trn of findAll(st, 'STMTTRN')) {
      seq++;
      const row = { index: seq, raw: {}, error: null, skipped: null, accountId: account.accountId };
      const trntype = leaf(trn, 'TRNTYPE').toUpperCase();
      const dtposted = leaf(trn, 'DTPOSTED');
      const trnamt = leaf(trn, 'TRNAMT');
      const fitid = leaf(trn, 'FITID') || null;
      row.raw = { TRNTYPE: trntype, DTPOSTED: dtposted, TRNAMT: trnamt, FITID: fitid, NAME: leaf(trn, 'NAME'), MEMO: leaf(trn, 'MEMO'), CHECKNUM: leaf(trn, 'CHECKNUM') };
      const date = parseOfxDate(dtposted);
      if (!date) {
        row.error = dtposted ? `Unrecognised date "${dtposted}"` : 'Missing DTPOSTED';
        rows.push(row);
        continue;
      }
      let amount = parseOfxAmount(trnamt);
      if (amount == null) {
        row.error = trnamt ? `Unrecognised amount "${trnamt}"` : 'Missing TRNAMT';
        rows.push(row);
        continue;
      }
      // TRNAMT is signed per spec; some exports send DEBIT with a positive amount.
      if (trntype === 'DEBIT' && amount > 0) amount = -amount;
      if (trntype === 'CREDIT' && amount < 0) amount = -amount;
      const description = describe(trn);
      const checknum = leaf(trn, 'CHECKNUM');
      Object.assign(row, {
        date,
        description: checknum ? `${description} · cheque ${checknum}` : description,
        amount,
        type: amount >= 0 ? 'income' : 'expense',
        category: TRNTYPE_CATEGORY[trntype] || categorizeByDescription(description),
        // <CURRENCY> (an aggregate) means TRNAMT itself is in CURSYM; <ORIGCURRENCY>
        // only records the original currency, TRNAMT stays in CURDEF.
        currency: (child(trn, 'CURRENCY') && leaf(child(trn, 'CURRENCY'), 'CURSYM').toUpperCase()) || currency,
        externalId: fitid,
        accountId: account.accountId,
        trnType: trntype || null
      });
      row.fingerprint = fingerprintOf(row.date, row.amount, row.description);
      rows.push(row);
    }
  }
  return { version, accounts, rows };
}

// options: { existingFingerprints: Map fingerprint->count (or Set), existingExternalIds: Set,
//            statementAccountId: ACCTID to take from a multi-statement file }
// markDuplicates treats rows with distinct FITIDs as distinct transactions even
// when date, amount and name match (two coffees at the same shop on one day).
//
// One import goes into one app account, so a file with several statements
// (chequing + credit card, CAD + USD) is refused unless the caller names the
// statement's ACCTID; otherwise every row would land in one account.
function previewOfx(text, options = {}) {
  const parsed = parseOfx(text);
  const { version } = parsed;
  let { accounts, rows } = parsed;
  if (accounts.length > 1) {
    const wanted = options.statementAccountId != null ? String(options.statementAccountId).trim() : '';
    const list = accounts.map((a) => `${a.accountId || '?'}${a.accountType ? ` (${a.accountType})` : ''}${a.currency ? ` ${a.currency}` : ''}`).join(', ');
    if (!wanted) {
      const err = new Error(`This OFX file holds ${accounts.length} statements: ${list}. One import goes into one account: export a separate file for each account and import them one at a time.`);
      err.code = 'OFX_MULTIPLE_STATEMENTS';
      err.statements = accounts.map((a) => ({ accountId: a.accountId, accountType: a.accountType, currency: a.currency }));
      throw err;
    }
    const chosen = accounts.filter((a) => a.accountId === wanted);
    if (chosen.length !== 1) {
      const err = new Error(`Statement "${wanted}" is not in this file. It holds: ${list}.`);
      err.code = 'OFX_MULTIPLE_STATEMENTS';
      throw err;
    }
    accounts = chosen;
    rows = rows.filter((r) => r.accountId === wanted);
  }
  markDuplicates(rows, options.existingFingerprints);
  // FITID is the bank's own stable id: a match is a duplicate even if the text changed.
  if (options.existingExternalIds && options.existingExternalIds.size) {
    for (const r of rows) {
      if (!r.duplicate && r.externalId && options.existingExternalIds.has(r.externalId)) r.duplicate = 'existing';
    }
  }
  return {
    kind: 'ofx',
    version,
    accounts,
    preset: { id: `ofx${version}`, name: version === '2' ? 'OFX 2.x (XML)' : 'OFX 1.x / QFX (SGML)', verified: true },
    detected: true,
    mapping: null,
    columnNames: ['Date', 'Type', 'Description', 'Amount', 'FITID'],
    rows,
    stats: summarize(rows)
  };
}

module.exports = { isOfx, detectVersion, parseOfxTree, parseOfxDate, parseOfx, previewOfx };
