// Synthetic evaluation set for the Finman Statement Agent.
// All banks, people, addresses, merchants and numbers are FICTIONAL.
//
// Usage:  node make_eval.mjs
//   needs Playwright (chromium): PW_MODULE or /data/projects/finman-store-assets/node_modules/playwright
//   uses poppler `pdfinfo` / `pdftotext` (if present) to self-check the output.
// Output (this folder): t*.pdf (text layer), s*.pdf (image-only scans), p*.jpg (phone photos), manifest.json.
// Deterministic: seeded PRNG per file, PDF dates pinned, so re-running gives identical files.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/data/projects/finman-store-assets/node_modules/playwright');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const YEAR = 2026;
const STAMP = 'SAMPLE DATA · FICTIONAL';

// ---------------------------------------------------------------- helpers
function fail(msg) { throw new Error(msg); }
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dim = (m) => new Date(Date.UTC(YEAR, m, 0)).getUTCDate();
const iso = (m, d) => `${YEAR}-${pad(m)}-${pad(d)}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtAbs(c, nf) {
  const a = Math.abs(c); const maj = String(Math.floor(a / 100)); const min = pad(a % 100);
  const sep = nf === 'eu' ? '.' : ','; const dec = nf === 'eu' ? ',' : '.';
  return maj.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + dec + min;
}
const DF_NAME = { iso: 'YYYY-MM-DD', dmy: 'DD/MM/YYYY', mon_dd: 'Mon DD', dd_mon_yyyy: 'DD Mon YYYY' };
function fmtDate(isoDate, df) {
  const [y, m, d] = isoDate.split('-').map(Number);
  switch (df) {
    case 'iso': return isoDate;
    case 'dmy': return `${pad(d)}/${pad(m)}/${y}`;
    case 'mon_dd': return `${MON[m - 1]} ${pad(d)}`;
    case 'dd_mon_yyyy': return `${pad(d)} ${MON[m - 1]} ${y}`;
  }
  fail('bad df ' + df);
}
function periodText(m, df) {
  const e = dim(m);
  switch (df) {
    case 'iso': return `Statement period ${iso(m, 1)} to ${iso(m, e)}`;
    case 'dmy': return `Statement period 01/${pad(m)}/${YEAR} – ${e}/${pad(m)}/${YEAR}`;
    case 'mon_dd': return `Statement period ${MONTH[m - 1]} 1 – ${MONTH[m - 1]} ${e}, ${YEAR}`;
    case 'dd_mon_yyyy': return `Statement period 01 ${MON[m - 1]} ${YEAR} – ${e} ${MON[m - 1]} ${YEAR}`;
  }
}

// ---------------------------------------------------------------- fictional entities
const BANKS = {
  nhb: { name: 'Northwind Harbour Bank', ini: 'NH', addr: '400 Example Quay, Halifax NS · fictional institution' },
  qcu: { name: 'Quillmoor Credit Union', ini: 'QM', addr: '88 Sampleton Road, Kelowna BC · fictional institution' },
  lnb: { name: 'Larkhaven National Bank', ini: 'LH', addr: '1200 Placeholder Ave, Columbus OH · fictional institution' },
  pls: { name: 'Prairie Lantern Savings', ini: 'PL', addr: '15 Mockingbird Plaza, Omaha NE · fictional institution' },
  dwb: { name: 'Dunewell Bank', ini: 'DW', addr: 'Tower 7, Example Boulevard, Dubai · fictional institution' },
  srb: { name: 'Sarabel Bank', ini: 'SB', addr: 'Level 3, Demo Business Bay, Abu Dhabi · fictional institution' },
  vmb: { name: 'Velmora Bank', ini: 'VM', addr: 'Musterweg 12, 04109 Leipzig · fictional institution' },
  lvb: { name: 'Banque de Lorvenne', ini: 'BL', addr: "4 Rue de l'Exemple, 69002 Lyon · fictional institution" },
  hvb: { name: 'Halverine Bank', ini: 'HV', addr: 'PO Box 0000, Exampleville ON · fictional institution' },
};
const PEOPLE = {
  na: [['Alex Sample', '100 Example St, Unit 4', 'Exampleville ON K0A 0A0'], ['Jordan Example', '27 Placeholder Crescent', 'Sampleton BC V0X 0X0'],
    ['Morgan Testwell', '9 Mockingbird Lane, Apt 12', 'Demotown OH 00000'], ['Riley Placeholder', '450 Fiction Blvd', 'Specimen City NE 00000']],
  ae: [['Samira Demo', 'Villa 14, Example Gardens', 'Dubai, UAE (fictional)'], ['Omar Sampleton', 'Apt 908, Placeholder Tower', 'Abu Dhabi, UAE (fictional)']],
  eu: [['Lena Fictiva', 'Beispielstraße 5', '04109 Leipzig (fictional)'], ['Chris Mockford', '12 Rue du Modèle', '69002 Lyon (fictional)']],
};
const REGION = { CAD: 'na', USD: 'na', AED: 'ae', EUR: 'eu' };
const SYM = { CAD: '$', USD: '$', AED: 'AED ', EUR: '€' };

const MERCH = {
  na: [['GREENLEAF GROCERS #1123', 2400, 16500], ['HARVEST LANE MARKET', 1800, 12000], ['NORTHSTAR FUEL 8821', 3500, 8200],
    ['BEANHOUSE CAFE', 325, 1450], ['PINEWOOD PHARMACY #07', 900, 5200], ['CITYLINK TRANSIT RELOAD', 2000, 6000],
    ['PARCELBOX ONLINE MKTP', 1299, 11900], ['QUICKCART VARIETY #31', 300, 2800], ['SAFFRON NOODLE BAR', 1800, 5400],
    ['RIDEWAVE *TRIP', 900, 3600], ['HARBOUR HARDWARE CO', 1500, 9800], ['LUMEN STREAMING', 1099, 1899],
    ['PAGEFOLD BOOKS', 1200, 4500], ['SUNNYSIDE BAKERY', 450, 2200], ['POS PURCHASE CORNER DELI 44', 600, 2400]],
  ae: [['DESERT BLOOM HYPERMARKET', 4500, 52000], ['OASIS PETROL STN 12', 6000, 21000], ['SANDCASTLE CAFE', 1400, 6500],
    ['MARINA METRO CARD TOPUP', 2000, 10000], ['PEARL COVE PHARMACY', 2500, 18000], ['SOUQLANE ONLINE', 5000, 60000],
    ['FALCON TAXI SVC', 1500, 9000], ['SAFFRON SPICE KITCHEN', 3500, 22000], ['DUNEVIEW FITNESS CLUB', 9900, 30000],
    ['CORAL BAY LAUNDRY', 2500, 8000]],
  eu: [['MARKTHALLE FRISCH 0412', 1200, 9800], ['KAFFEEHAUS LINDE', 280, 1250], ['TANKSTELLE NORDLICHT', 3500, 8900],
    ['APOTHEKE AM WEIHER', 600, 4200], ['BOULANGERIE DU PONT', 250, 1800], ['MERCATO VERDE', 1500, 7600],
    ['LIBRERIA SOLE', 900, 3800], ['FARMACIA CENTRALE 3', 700, 3900], ['STADTRAD VERLEIH', 200, 1500], ['VELOCITE ONLINE SHOP', 1900, 14900]],
};
// [day ('L' = last), lines, lo, hi, sign]
const FIXED = {
  na: [[1, ['RENT PAYMENT · E-TRANSFER SENT'], 140000, 210000, -1], [15, ['PAYROLL DEPOSIT · NORTHWIND STUDIO'], 210000, 340000, 1],
    ['L', ['PAYROLL DEPOSIT · NORTHWIND STUDIO'], 210000, 340000, 1], [6, ['BRIGHTWIRE MOBILE PAD'], 5500, 9500, -1],
    [9, ['E-TRANSFER RECEIVED FROM JORDAN EXAMPLE', 'REF CA26{R} MEMO SHARED BILLS'], 5000, 60000, 1],
    [12, ['CITY POWER & WATER PAD'], 6000, 15000, -1], [20, ['ATM WITHDRAWAL · BRANCH 0442'], 4000, 20000, -1],
    [24, ['ONLINE TRANSFER TO SAVINGS', 'ACCT ****8812 RECURRING MONTHLY'], 20000, 50000, -1],
    [27, ['HOME INSURANCE · NORTHGUARD MUTUAL (FICT.)'], 3500, 9000, -1], [18, ['CHEQUE #000{C}'], 8000, 45000, -1],
    ['L', ['MONTHLY ACCOUNT FEE'], 495, 1695, -1], ['L', ['INTEREST PAID'], 3, 250, 1]],
  ae: [[1, ['RENT CHEQUE NO. 000{C}'], 550000, 900000, -1], [25, ['SALARY CREDIT · FALCONRIDGE TRADING LLC (FICT.)'], 1500000, 2600000, 1],
    [5, ['GULFSTAR TELECOM POSTPAID'], 19900, 45000, -1], [10, ['INWARD REMITTANCE FROM SAMIRA DEMO', 'REF AE26{R} FAMILY SUPPORT'], 100000, 500000, 1],
    [12, ['CITY UTILITY AUTHORITY BILL'], 30000, 120000, -1], [16, ['ATM CASH WITHDRAWAL · MALL BRANCH'], 20000, 100000, -1],
    [21, ['OWN ACCOUNT TRANSFER', 'TO SAVINGS ****3301 STANDING ORDER'], 100000, 300000, -1],
    [28, ['CAR LOAN INSTALMENT · CONTRACT 77{C}'], 150000, 250000, -1], ['L', ['ACCOUNT MAINTENANCE FEE'], 2500, 5250, -1],
    ['L', ['PROFIT CREDIT'], 100, 2500, 1]],
  eu: [[1, ['SEPA DIRECT DEBIT · RENT'], 75000, 140000, -1], [27, ['SALARY · LORENTA STUDIO GMBH (FICT.)'], 260000, 410000, 1],
    [4, ['MOBILFUNK KLARNETZ'], 1999, 4999, -1], [8, ['SEPA TRANSFER FROM CHRIS MOCKFORD', 'REF SEPA-26{R} HOLIDAY SHARE'], 5000, 40000, 1],
    [11, ['STROM UND GAS STADTWERKE DEMO'], 6000, 14000, -1], [17, ['CASH WITHDRAWAL ATM 2214'], 5000, 20000, -1],
    [22, ['STANDING ORDER TO SAVINGS', 'IBAN XX00 0000 0000 0000 4417'], 10000, 40000, -1], ['L', ['ACCOUNT FEE'], 490, 990, -1],
    ['L', ['CREDIT INTEREST'], 1, 90, 1]],
};

// ---------------------------------------------------------------- themes
const THEMES = [
  { font: '"Liberation Sans", Arial, sans-serif', fs: 10.5, a: '#12355b', tbl: 'ruled', hdr: 'line' },
  { font: 'Caladea, "Liberation Serif", serif', fs: 11, a: '#7a1f2b', tbl: 'grid', hdr: 'line' },
  { font: '"DejaVu Sans", sans-serif', fs: 9.5, a: '#1f6b3a', tbl: 'zebra', hdr: 'band' },
  { font: '"Liberation Mono", monospace', fs: 9.5, a: '#222222', tbl: 'min', hdr: 'line' },
  { font: 'Carlito, "Liberation Sans", sans-serif', fs: 11, a: '#0f6e7a', tbl: 'ruled', hdr: 'band' },
  { font: '"Liberation Serif", serif', fs: 10.5, a: '#3b3f46', tbl: 'grid', hdr: 'line' },
  { font: '"Bitstream Charter", serif', fs: 10, a: '#4b2a7b', tbl: 'zebra', hdr: 'line' },
  { font: 'FreeSans, "Liberation Sans", sans-serif', fs: 10, a: '#b0541a', tbl: 'zebra', hdr: 'band' },
];
const PAPER = { letter: { W: 816, H: 1056, css: '8.5in 11in' }, a4: { W: 794, H: 1122, css: '210mm 297mm' } };
const PT = 40, PX = 46, PB = 64;

// ---------------------------------------------------------------- file specs
// layout: wdb = Withdrawals/Deposits columns, signed = one signed Amount column, crdr = "CR"/"DR" suffix,
//         paren = negatives in parentheses, card = credit card (purchases positive on paper).
const SPECS = [
  // ---- text-layer PDFs
  { name: 't01-nhb-chequing-cad-2026-10.pdf', kind: 'text-pdf', bank: 'nhb', cur: 'CAD', layout: 'wdb', df: 'iso', rb: true, n: 46, m: 10, theme: 0, wrap: true, carry: true, open: 'box', close: 'box' },
  { name: 't02-lnb-checking-usd-2026-09.pdf', kind: 'text-pdf', bank: 'lnb', cur: 'USD', layout: 'signed', df: 'mon_dd', rb: true, n: 22, m: 9, theme: 4, open: 'row', close: 'row' },
  { name: 't03-dwb-current-aed-2026-08.pdf', kind: 'text-pdf', bank: 'dwb', cur: 'AED', layout: 'crdr', df: 'dmy', rb: true, n: 62, m: 8, theme: 2, paper: 'a4', wrap: true, fs: 11, roomy: true, open: 'box', close: 'box' },
  { name: 't04-vmb-giro-eur-2026-10.pdf', kind: 'text-pdf', bank: 'vmb', cur: 'EUR', nf: 'eu', layout: 'wdb', df: 'dmy', rb: true, n: 38, m: 10, theme: 5, paper: 'a4', wrap: true, open: 'row', close: 'row' },
  { name: 't05-qcu-chequing-cad-2026-07.pdf', kind: 'text-pdf', bank: 'qcu', cur: 'CAD', layout: 'paren', df: 'dd_mon_yyyy', rb: true, n: 50, m: 7, theme: 1, wrap: true, open: 'box', close: 'box', planted: { type: 'dropped_row', at: 0.55 } },
  { name: 't06-pls-savings-usd-2026-06.pdf', kind: 'text-pdf', bank: 'pls', cur: 'USD', layout: 'wdb', df: 'mon_dd', rb: false, n: 18, m: 6, theme: 7, open: 'box', close: 'box' },
  { name: 't07-hvb-rewards-card-cad-2026-10.pdf', kind: 'text-pdf', bank: 'hvb', cur: 'CAD', layout: 'card', cardCredit: 'minus', df: 'mon_dd', rb: false, n: 44, m: 10, theme: 6, wrap: true, open: 'box', close: 'box' },
  { name: 't08-lnb-checking-usd-2026-08.pdf', kind: 'text-pdf', bank: 'lnb', cur: 'USD', layout: 'wdb', df: 'iso', rb: true, n: 40, m: 8, theme: 4, open: 'row', close: 'row', planted: { type: 'flipped_sign', at: 0.4 } },
  { name: 't09-lvb-compte-eur-2026-09.pdf', kind: 'text-pdf', bank: 'lvb', cur: 'EUR', layout: 'signed', plus: true, df: 'dd_mon_yyyy', rb: false, n: 27, m: 9, theme: 3, paper: 'a4', open: 'box', close: 'box' },
  { name: 't10-srb-platinum-card-aed-2026-09.pdf', kind: 'text-pdf', bank: 'srb', cur: 'AED', layout: 'card', cardCredit: 'cr', df: 'dmy', rb: false, n: 28, m: 9, theme: 0, paper: 'a4', open: 'box', close: 'box' },
  { name: 't11-nhb-chequing-cad-2026-06.pdf', kind: 'text-pdf', bank: 'nhb', cur: 'CAD', layout: 'crdr', df: 'iso', rb: false, n: 33, m: 6, theme: 0, wrap: true, open: 'box', close: 'box', planted: { type: 'wrong_digit', at: 0.6 } },
  { name: 't12-vmb-giro-eur-2026-07.pdf', kind: 'text-pdf', bank: 'vmb', cur: 'EUR', nf: 'eu', layout: 'signed', df: 'dd_mon_yyyy', rb: true, n: 68, m: 7, theme: 5, paper: 'a4', wrap: true, carry: true, fs: 11.5, roomy: true, open: 'box', close: 'box' },
  { name: 't13-dwb-current-aed-2026-10.pdf', kind: 'text-pdf', bank: 'dwb', cur: 'AED', layout: 'wdb', df: 'dmy', rb: true, n: 44, m: 10, theme: 2, paper: 'a4', open: 'box', close: 'box', planted: { type: 'duplicated_row', at: 0.45 } },
  { name: 't14-pls-checking-usd-2026-10.pdf', kind: 'text-pdf', bank: 'pls', cur: 'USD', layout: 'paren', df: 'iso', rb: true, n: 15, m: 10, theme: 7, open: 'row', close: 'row' },
  { name: 't15-hvb-card-activity-cad-no-closing.pdf', kind: 'text-pdf', bank: 'hvb', cur: 'CAD', layout: 'card', cardCredit: 'minus', df: 'mon_dd', rb: false, n: 22, m: 10, theme: 6, noClosing: true, open: 'box' },
  { name: 't16-lnb-card-activity-usd-no-closing.pdf', kind: 'text-pdf', bank: 'lnb', cur: 'USD', layout: 'card', cardCredit: 'cr', df: 'iso', rb: false, n: 24, m: 9, theme: 4, noClosing: true, open: 'box' },
  { name: 't17-qcu-chequing-cad-2026-09.pdf', kind: 'text-pdf', bank: 'qcu', cur: 'CAD', layout: 'signed', df: 'dmy', rb: true, n: 70, m: 9, theme: 1, wrap: true, lowOpening: true, fs: 12, roomy: true, open: 'row', close: 'row' },
  { name: 't18-pls-checking-usd-2026-07.pdf', kind: 'text-pdf', bank: 'pls', cur: 'USD', layout: 'crdr', df: 'mon_dd', rb: true, n: 30, m: 7, theme: 3, open: 'box', close: 'box' },
  { name: 't19-srb-current-aed-2026-06.pdf', kind: 'text-pdf', bank: 'srb', cur: 'AED', layout: 'paren', df: 'dd_mon_yyyy', rb: false, n: 25, m: 6, theme: 6, paper: 'a4', wrap: true, open: 'box', close: 'box' },
  { name: 't20-lvb-compte-eur-2026-08.pdf', kind: 'text-pdf', bank: 'lvb', cur: 'EUR', layout: 'wdb', df: 'iso', rb: true, n: 52, m: 8, theme: 7, paper: 'a4', open: 'row', close: 'row' },
  // ---- scan-style PDFs (image only, no text layer)
  { name: 's01-nhb-chequing-cad-2026-09-scan.pdf', kind: 'scan-pdf', bank: 'nhb', cur: 'CAD', layout: 'wdb', df: 'iso', rb: true, n: 26, m: 9, theme: 0, open: 'box', close: 'box' },
  { name: 's02-lnb-checking-usd-2026-10-scan.pdf', kind: 'scan-pdf', bank: 'lnb', cur: 'USD', layout: 'signed', df: 'mon_dd', rb: true, n: 42, m: 10, theme: 5, wrap: true, open: 'row', close: 'row' },
  { name: 's03-srb-current-aed-2026-07-scan.pdf', kind: 'scan-pdf', bank: 'srb', cur: 'AED', layout: 'crdr', df: 'dmy', rb: false, n: 36, m: 7, theme: 1, paper: 'a4', open: 'box', close: 'box', planted: { type: 'dropped_row', at: 0.5 } },
  { name: 's04-lvb-compte-eur-2026-10-scan.pdf', kind: 'scan-pdf', bank: 'lvb', cur: 'EUR', layout: 'paren', df: 'dd_mon_yyyy', rb: true, n: 22, m: 10, theme: 3, paper: 'a4', open: 'box', close: 'box' },
  { name: 's05-qcu-chequing-cad-2026-08-scan.pdf', kind: 'scan-pdf', bank: 'qcu', cur: 'CAD', layout: 'wdb', df: 'iso', rb: true, n: 30, m: 8, theme: 2, wrap: true, open: 'row', close: 'row', planted: { type: 'wrong_digit', at: 0.35 } },
  { name: 's06-pls-checking-usd-2026-09-scan.pdf', kind: 'scan-pdf', bank: 'pls', cur: 'USD', layout: 'crdr', df: 'mon_dd', rb: true, n: 20, m: 9, theme: 4, open: 'box', close: 'box' },
  // ---- phone photos (one complete single-page statement each)
  { name: 'p01-nhb-chequing-cad-2026-08-photo.jpg', kind: 'photo', bank: 'nhb', cur: 'CAD', layout: 'wdb', df: 'mon_dd', rb: true, n: 18, m: 8, theme: 0, open: 'box', close: 'box', rot: -1.6 },
  { name: 'p02-lnb-checking-usd-2026-07-photo.jpg', kind: 'photo', bank: 'lnb', cur: 'USD', layout: 'signed', df: 'iso', rb: true, n: 20, m: 7, theme: 4, open: 'row', close: 'row', rot: 2.3, planted: { type: 'flipped_sign', at: 0.5 } },
  { name: 'p03-dwb-current-aed-2026-09-photo.jpg', kind: 'photo', bank: 'dwb', cur: 'AED', layout: 'wdb', df: 'dmy', rb: true, n: 16, m: 9, theme: 2, paper: 'a4', open: 'box', close: 'box', rot: -2.2 },
  { name: 'p04-vmb-giro-eur-2026-06-photo.jpg', kind: 'photo', bank: 'vmb', cur: 'EUR', layout: 'signed', df: 'dd_mon_yyyy', rb: false, n: 19, m: 6, theme: 5, paper: 'a4', open: 'box', close: 'box', rot: 1.2 },
  { name: 'p05-qcu-chequing-cad-2026-10-photo.jpg', kind: 'photo', bank: 'qcu', cur: 'CAD', layout: 'paren', df: 'iso', rb: true, n: 17, m: 10, theme: 1, open: 'box', close: 'box', rot: 1.9, planted: { type: 'duplicated_row', at: 0.4 } },
  { name: 'p06-pls-checking-usd-2026-08-photo.jpg', kind: 'photo', bank: 'pls', cur: 'USD', layout: 'crdr', df: 'mon_dd', rb: true, n: 21, m: 8, theme: 7, open: 'row', close: 'row', rot: -1.1 },
];

// ---------------------------------------------------------------- data
function buildDoc(spec) {
  const rnd = mulberry32(hash(spec.name) ^ 0x2026);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const d = { ...spec, nf: spec.nf || 'en', paper: spec.paper || 'letter', bankInfo: BANKS[spec.bank], theme: THEMES[spec.theme] };
  const reg = REGION[spec.cur];
  d.person = pick(PEOPLE[reg]);
  d.acct = `${pad(int(10, 99))}${pad(int(0, 99))}-${int(10000, 99999)}-${pad(int(10, 99))}`.replace(/^(\d{4})/, '0000');
  const e = dim(spec.m);
  const card = spec.layout === 'card';
  const truth = [];
  const fillRef = (s) => s.replace('{R}', String(int(10000000, 99999999))).replace('{C}', String(int(100, 999)));
  if (!card) {
    const fixed = FIXED[reg].slice();
    const nFixed = Math.min(fixed.length, Math.max(5, Math.round(spec.n * 0.4)));
    for (const [day, lines, lo, hi, sign] of fixed.slice(0, nFixed)) {
      const ls = lines.map(fillRef);
      truth.push({ day: day === 'L' ? e : day, desc: spec.wrap || ls.length === 1 ? ls : [ls[0]], cents: sign * int(lo, hi) });
    }
    while (truth.length < spec.n) {
      const [desc, lo, hi] = pick(MERCH[reg]);
      truth.push({ day: int(1, e), desc: [desc], cents: -int(lo, hi) });
    }
  } else {
    d.prevOwed = int(30000, 260000);
    truth.push({ day: int(3, 9), desc: ['PAYMENT RECEIVED · THANK YOU'], cents: Math.round(d.prevOwed * (0.6 + rnd() * 0.4)) });
    truth.push({ day: int(12, 24), desc: spec.wrap ? ['RETURN · PARCELBOX ONLINE MKTP', 'ORDER 26-{R} REFUND TO CARD'.replace('{R}', int(100000, 999999))] : ['RETURN · MERCHANT CREDIT'], cents: int(1500, 8000) });
    if (!spec.noClosing) truth.push({ day: e, desc: ['INTEREST CHARGE · PURCHASES'], cents: -int(500, 4200) });
    while (truth.length < spec.n) {
      const [desc, lo, hi] = pick(MERCH[reg]);
      truth.push({ day: int(1, spec.noClosing ? e - 6 : e), desc: [desc], cents: -int(lo, hi) });
    }
    if (spec.wrap) truth.push({ day: int(14, 20), desc: ['FOREIGN PURCHASE · CAFE LUMIERE EXEMPLE', 'EUR 42.10 @ 1.5023 INCL. FX FEE'], cents: -6325 }), truth.splice(5, 1);
  }
  truth.forEach((r, i) => (r.k = i));
  truth.sort((a, b) => a.day - b.day || a.k - b.k);
  for (const r of truth) {
    r.date = iso(spec.m, r.day);
    if (card) r.post = iso(spec.m, Math.min(e, r.day + int(0, 2)));
  }
  // opening chosen so the account mostly stays positive (t17 dips into overdraft on purpose)
  if (card) d.opening = -d.prevOwed;
  else {
    let run = 0, min = 0;
    for (const r of truth) { run += r.cents; min = Math.min(min, run); }
    d.opening = spec.lowOpening ? -min - int(20000, 60000) : -min + int(20000, 400000) * (reg === 'ae' ? 3 : 1);
  }
  let bal = d.opening;
  for (const r of truth) { bal += r.cents; r.balance = bal; }
  d.closing = bal;
  d.truth = truth;

  // ---- printed rows (planted errors applied here; balances/opening/closing stay true)
  const printed = truth.map((r) => ({ ...r }));
  d.planted = null;
  if (spec.planted) {
    const t = spec.planted.type;
    let k = Math.floor(truth.length * spec.planted.at);
    const show = (c) => cellText(d, c);
    if (t === 'flipped_sign') while (truth[k].cents > 0) k++; // flip a withdrawal so it lands in the deposits column / gets a + sign
    if (t === 'dropped_row') {
      const [gone] = printed.splice(k, 1);
      d.planted = { type: t, row_index: k, detail: `Row ${gone.date} "${gone.desc.join(' ')}" ${show(gone.cents)} (true cents ${gone.cents}) is missing from the table; opening, closing${spec.rb ? ' and running balances' : ''} still include it. row_index = printed row that now follows the gap.`, true_row: { date: gone.date, description: gone.desc.join(' '), cents: gone.cents } };
    } else if (t === 'duplicated_row') {
      printed.splice(k + 1, 0, { ...printed[k] });
      d.planted = { type: t, row_index: k + 1, detail: `Row ${truth[k].date} "${truth[k].desc.join(' ')}" ${show(truth[k].cents)} is printed twice (indexes ${k} and ${k + 1}); the copy at ${k + 1} is extra${spec.rb ? ' and repeats the same running balance' : ''}.` };
    } else if (t === 'flipped_sign') {
      printed[k].cents = -truth[k].cents;
      d.planted = { type: t, row_index: k, detail: spec.layout === 'wdb' ? `Withdrawal of ${fmtAbs(truth[k].cents, d.nf)} printed in the Deposits column (true cents ${truth[k].cents}).` : `Printed as ${show(printed[k].cents)}, true amount ${show(truth[k].cents)} (true cents ${truth[k].cents}).`, true_row: { date: truth[k].date, description: truth[k].desc.join(' '), cents: truth[k].cents } };
    } else if (t === 'wrong_digit') {
      const digits = String(Math.abs(truth[k].cents)).split('');
      const pos = int(0, digits.length - 1);
      let nd = int(0, 9);
      while (String(nd) === digits[pos] || (pos === 0 && nd === 0)) nd = (nd + 1) % 10;
      digits[pos] = String(nd);
      printed[k].cents = Math.sign(truth[k].cents) * Number(digits.join(''));
      d.planted = { type: t, row_index: k, detail: `Amount printed ${show(printed[k].cents)}, true ${show(truth[k].cents)} (true cents ${truth[k].cents}); one digit differs.`, true_row: { date: truth[k].date, description: truth[k].desc.join(' '), cents: truth[k].cents } };
    }
  }
  d.printed = printed;
  return d;
}

// ---------------------------------------------------------------- rendering
function cellText(d, c) {
  const a = fmtAbs(c, d.nf);
  switch (d.layout) {
    case 'wdb': return a;
    case 'signed': return c < 0 ? '-' + a : (d.plus ? '+' + a : a);
    case 'crdr': return `${a} ${c < 0 ? 'DR' : 'CR'}`;
    case 'paren': return c < 0 ? `(${a})` : a;
    case 'card': return c < 0 ? a : d.cardCredit === 'cr' ? `${a} CR` : '-' + a;
  }
}
function balText(d, b) {
  const a = fmtAbs(b, d.nf);
  if (d.layout === 'crdr') return `${a} ${b < 0 ? 'DR' : 'CR'}`;
  if (d.layout === 'paren') return b < 0 ? `(${a})` : a;
  return (b < 0 ? '-' : '') + a;
}
const owedText = (d, owed) => `${SYM[d.cur]}${fmtAbs(owed, d.nf)}${owed < 0 ? ' CR' : ''}`;
function amtCells(d, c) {
  if (d.layout === 'wdb') return `<td class="n">${c < 0 ? fmtAbs(c, d.nf) : ''}</td><td class="n">${c > 0 ? fmtAbs(c, d.nf) : ''}</td>`;
  return `<td class="n">${cellText(d, c)}</td>`;
}
const nAmtCols = (d) => (d.layout === 'wdb' ? 2 : 1);
function labels(d) {
  const reg = REGION[d.cur];
  if (d.layout === 'card') return [d.df === 'iso' ? 'Trans. date' : 'Trans.', d.df === 'iso' ? 'Post date' : 'Posted', 'Description', `Amount (${d.cur})`];
  const date = 'Date', desc = reg === 'ae' ? 'Narration' : reg === 'eu' ? 'Details' : 'Description';
  const out = d.layout === 'wdb' ? (reg === 'na' ? ['Withdrawals', 'Deposits'] : ['Debit', 'Credit']) : [`Amount (${d.cur})`];
  return [date, desc, ...out, ...(d.rb ? ['Balance'] : [])];
}
function colgroup(d) {
  const dw = { iso: 13, dmy: 13, mon_dd: 9, dd_mon_yyyy: 14 }[d.df];
  if (d.layout === 'card') return `<colgroup><col style="width:${dw}%"><col style="width:${dw}%"><col><col style="width:17%"></colgroup>`;
  const am = d.layout === 'wdb' ? '<col style="width:14%"><col style="width:14%">' : '<col style="width:17%">';
  return `<colgroup><col style="width:${dw}%"><col>${am}${d.rb ? '<col style="width:16%">' : ''}</colgroup>`;
}
function rowHtml(d, r) {
  const desc = r.desc.map(esc).join('<br>');
  if (d.layout === 'card') return `<tr class="r"><td class="d">${fmtDate(r.date, d.df)}</td><td class="d">${fmtDate(r.post, d.df)}</td><td>${desc}</td>${amtCells(d, r.cents)}</tr>`;
  return `<tr class="r"><td class="d">${fmtDate(r.date, d.df)}</td><td>${desc}</td>${amtCells(d, r.cents)}${d.rb ? `<td class="n">${balText(d, r.balance)}</td>` : ''}</tr>`;
}
const specialRow = (d, cls, date, label, bal) => `<tr class="sp ${cls}"><td class="d">${date}</td><td>${label}</td>${'<td></td>'.repeat(nAmtCols(d))}<td class="n">${balText(d, bal)}</td></tr>`;
const carryRow = (d, label, bal) => `<tr class="cf"><td></td><td><i>${label}</i></td>${'<td></td>'.repeat(nAmtCols(d))}<td class="n"><i>${balText(d, bal)}</i></td></tr>`;
const endDate = (d) => fmtDate(iso(d.m, dim(d.m)), d.df);
const startDate = (d) => fmtDate(iso(d.m, 1), d.df);

function css(d) {
  const { W, H, css: size } = PAPER[d.paper]; const t = d.theme;
  return `@page{size:${size};margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}
body{font-family:${t.font};font-size:${d.fs || t.fs}px;color:#16181d;-webkit-print-color-adjust:exact;print-color-adjust:exact;--a:${t.a}}
.page{width:${W}px;height:${H}px;padding:${PT}px ${PX}px ${PB}px;position:relative;overflow:hidden;background:#fff;break-after:page}
.page:last-child{break-after:auto}.measure .page{height:auto}.measure .content{height:auto}
.content{height:${H - PT - PB}px;overflow:hidden}
.foot{position:absolute;left:${PX}px;right:${PX}px;bottom:22px;font-size:8.5px;color:#666;display:flex;justify-content:space-between;border-top:1px solid #ccc;padding-top:5px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:8px;border-bottom:2px solid var(--a)}
.brand{display:flex;align-items:center;gap:10px}.logo{width:34px;height:34px;border-radius:6px;background:var(--a);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;letter-spacing:.04em}
.bname{font-size:17px;font-weight:700;color:var(--a)}.baddr{font-size:8.5px;color:#555}
.meta{text-align:right;font-size:9px;line-height:1.45}
.stamp{display:inline-block;color:#B42335;background:#fff;border:1.5px solid #B42335;font-weight:700;padding:1px 7px;font-size:9px;margin-top:4px}
.h-band .hdr{background:var(--a);color:#fff;padding:10px 12px;border:none;border-radius:3px}.h-band .bname{color:#fff}.h-band .baddr{color:#e6e6e6}.h-band .logo{background:#fff;color:var(--a)}
.cust{display:flex;justify-content:space-between;margin:10px 0 4px;font-size:9.5px;line-height:1.45}
.box{border:1px solid #aaa;padding:5px 8px;display:flex;justify-content:space-between;font-weight:700;margin:6px 0}
.box.closing{border-width:1.5px;border-color:#555;margin-top:8px}.note{font-size:8.5px;color:#555;margin-top:4px}
.cont{margin-top:10px;font-weight:700;text-align:center;border-top:1px dashed #888;padding-top:6px}
table.tx{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:6px}
table.tx th{background:var(--a);color:#fff;font-weight:700;text-align:left;padding:4px 5px;font-size:.92em}
table.tx td{padding:3px 5px;vertical-align:top;line-height:1.3}
td.n,th.n{text-align:right;white-space:nowrap}td.d{white-space:nowrap}tr.sp td{font-weight:700}
.tbl-ruled td{border-bottom:1px solid #d8d8d8}.tbl-zebra tbody tr:nth-child(even) td{background:#eef1f4}
.tbl-grid td,.tbl-grid th{border:1px solid #9a9a9a}.tbl-grid th{background:#e6e6e6;color:#111}
.roomy table.tx td{padding:5px 6px;line-height:1.4}.tbl-min th{background:none;color:#111;border-bottom:1.5px dashed #333}.tbl-min td{border-bottom:1px dotted #bbb}`;
}
function header(d, pno, ptotal, first) {
  const b = d.bankInfo; const card = d.layout === 'card';
  const title = card ? (d.noClosing ? 'Card activity (interim)' : 'Credit card statement') : d.layout === 'wdb' && REGION[d.cur] === 'na' ? 'Chequing account statement' : 'Current account statement';
  const acct = card ? `Card ending ${d.acct.replace(/\D/g, '').slice(-4)}` : `Account ${d.acct}`;
  const info = card ? `Credit limit: ${owedText(d, 500000 + (hash(d.name) % 6) * 100000)}` : `Account type: ${REGION[d.cur] === 'eu' ? 'Giro / current' : 'Personal'}`;
  return `<div class="hdr"><div class="brand"><div class="logo">${b.ini}</div><div><div class="bname">${b.name}</div><div class="baddr">${esc(b.addr)}</div></div></div>
<div class="meta"><div><b>${title}</b></div><div>${acct}</div><div>${periodText(d.m, d.df)}</div><div>Page ${pno} of ${ptotal}</div><div class="stamp">${STAMP}</div></div></div>
${first ? `<div class="cust"><div><b>${d.person[0]}</b><br>${esc(d.person[1])}<br>${esc(d.person[2])}</div><div style="text-align:right">Currency: <b>${d.cur}</b><br>${info}<br>Customer ID ${d.acct.replace(/\D/g, '').slice(-6)}</div></div>` : ''}`;
}
function openingHtml(d) {
  if (d.layout === 'card') return `<div class="box opening"><span>Previous balance (${startDate(d)})</span><span>${owedText(d, d.prevOwed)}</span></div>`;
  if (d.open === 'row') return '';
  return `<div class="box opening"><span>Opening balance ${startDate(d)}</span><span>${SYM[d.cur]}${balText(d, d.opening)}</span></div>`;
}
function closingHtml(d) {
  if (d.noClosing) return `<div class="closing cont">Continued on next page · Page 1 of 3</div>`;
  if (d.layout === 'card') {
    const owed = -d.closing;
    return `<div class="closing"><div class="box"><span>New balance (${endDate(d)})</span><span>${owedText(d, owed)}</span></div>
<div class="note">Minimum payment due: ${owedText(d, Math.max(1000, Math.round(owed * 0.03)))} · Payment due date: 21 days after statement date. Purchases are shown as positive amounts; payments and credits are shown ${d.cardCredit === 'cr' ? 'with CR' : 'with a minus sign'}.</div></div>`;
  }
  if (d.close === 'row') return ''; // rendered inside the table
  return `<div class="box closing"><span>Closing balance ${endDate(d)}</span><span>${SYM[d.cur]}${balText(d, d.closing)}</span></div>`;
}
function tableHtml(d, rowsHtml, { first, last }) {
  const th = labels(d).map((l, i) => `<th class="${i >= (d.layout === 'card' ? 3 : 2) ? 'n' : ''}">${l}</th>`).join('');
  const pre = first && d.open === 'row' && d.layout !== 'card' ? specialRow(d, 'opening', startDate(d), 'OPENING BALANCE', d.opening) : '';
  const post = last && d.close === 'row' && d.layout !== 'card' && !d.noClosing ? specialRow(d, 'closing', endDate(d), 'CLOSING BALANCE', d.closing) : '';
  return `<table class="tx">${colgroup(d)}<thead><tr>${th}</tr></thead><tbody>${pre}${rowsHtml}${post}</tbody></table>`;
}
const foot = (d, pno, ptotal) => `<div class="foot"><span>${d.bankInfo.name} · fictional institution · ${STAMP}</span><span>Page ${pno} of ${ptotal}</span></div>`;
const docHtml = (d, pagesHtml, measure = false) => `<!doctype html><html><head><meta charset="utf-8"><style>${css(d)}</style></head><body class="h-${d.theme.hdr} tbl-${d.theme.tbl}${d.roomy ? ' roomy' : ''}${measure ? ' measure' : ''}">${pagesHtml}</body></html>`;

async function paginate(page, d) {
  const { W, H } = PAPER[d.paper];
  const rows = d.printed.map((r) => rowHtml(d, r)).join('');
  const html = docHtml(d, `<div class="page" id="m1"><div class="content">${header(d, 1, 9, true)}${openingHtml(d)}${tableHtml(d, rows, { first: true, last: true })}${closingHtml(d)}</div></div>
<div class="page" id="m2"><div class="content">${header(d, 2, 9, false)}${tableHtml(d, d.rb ? carryRow(d, 'Balance brought forward', 0) : '', { first: false, last: false })}</div></div>`, true);
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(html);
  const m = await page.evaluate(() => {
    const c1 = document.querySelector('#m1 .content').getBoundingClientRect().top;
    const trs = [...document.querySelectorAll('#m1 tr.r')].map((t) => t.getBoundingClientRect());
    const cl = document.querySelector('#m1 .closing');
    const c2 = document.querySelector('#m2 .content').getBoundingClientRect().top;
    const cf = document.querySelector('#m2 tr.cf');
    const thead = document.querySelector('#m2 thead').getBoundingClientRect();
    return { top1: trs[0].top - c1, h: trs.map((r) => r.height), closeH: cl ? cl.getBoundingClientRect().bottom - trs[trs.length - 1].bottom : 0,
      top2: thead.bottom - c2, cfH: cf ? cf.getBoundingClientRect().height : 0 };
  });
  const limit = H - PT - PB - 4;
  const carry = d.carry ? m.cfH : 0;
  const pages = []; let cur = []; let y = m.top1;
  m.h.forEach((h, i) => {
    if (y + h + carry > limit && cur.length) { pages.push(cur); cur = []; y = m.top2 + carry; }
    cur.push(i); y += h;
  });
  if (y + m.closeH > limit) { // closing block does not fit: move the last rows to a fresh last page
    const moved = cur.splice(cur.length - 3, 3); pages.push(cur); cur = moved;
  }
  pages.push(cur);
  return pages;
}

function finalHtml(d, pages) {
  const N = pages.length; const ptotal = d.noClosing ? 3 : N;
  const out = pages.map((idx, p) => {
    const first = p === 0, last = p === N - 1;
    let rows = idx.map((i) => rowHtml(d, d.printed[i])).join('');
    if (d.carry && !first) rows = carryRow(d, 'Balance brought forward', d.printed[pages[p - 1].at(-1)].balance) + rows;
    if (d.carry && !last) rows += carryRow(d, 'Balance carried forward', d.printed[idx.at(-1)].balance);
    return `<div class="page"><div class="content">${header(d, p + 1, ptotal, first)}${first ? openingHtml(d) : ''}${tableHtml(d, rows, { first, last })}${last ? closingHtml(d) : ''}</div>${foot(d, p + 1, ptotal)}</div>`;
  }).join('');
  return docHtml(d, out);
}

async function checkNoClip(page, name) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('.page .content')].map((c, i) => [i, c.scrollHeight, c.clientHeight]).filter(([, s, h]) => s > h + 1));
  if (bad.length) fail(`${name}: content clipped on page(s) ${JSON.stringify(bad)}`);
}

// ---------------------------------------------------------------- image effects
const noise = (seed, freq = 0.85) => `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='2' seed='${seed}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`).replace(/%2523/g, '%23')}")`;
function scanHtml(png, w, h, i, seed) {
  const rot = ((seed % 7) - 3) * 0.12 + (i % 2 ? 0.1 : -0.05);
  return `<!doctype html><html><head><style>html,body{margin:0;background:#fff;overflow:hidden}
.w{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:#fbfbfa}
img{position:absolute;left:0;top:0;width:${w}px;height:${h}px;transform:translate(${(seed % 5) - 2}px,${(seed % 3) + 2}px) rotate(${rot}deg);filter:grayscale(1) contrast(1.28) brightness(1.04) blur(.35px)}
.n{position:absolute;inset:0;background-image:${noise(seed)};opacity:.13;mix-blend-mode:multiply}
.e{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.18),rgba(0,0,0,0) 2.5%,rgba(0,0,0,0) 97.5%,rgba(0,0,0,.12)),linear-gradient(180deg,rgba(0,0,0,.10),rgba(0,0,0,0) 2%);mix-blend-mode:multiply}
</style></head><body><div class="w"><img src="data:image/png;base64,${png.toString('base64')}"><div class="n"></div><div class="e"></div></div></body></html>`;
}
function scanPdfHtml(jpgs, paper) {
  const { W, H, css: size } = PAPER[paper];
  return `<!doctype html><html><head><style>@page{size:${size};margin:0}html,body{margin:0}div{width:${W}px;height:${H}px;overflow:hidden;break-after:page}div:last-child{break-after:auto}img{width:${W}px;height:${H}px;display:block}</style></head><body>${jpgs.map((j) => `<div><img src="data:image/jpeg;base64,${j.toString('base64')}"></div>`).join('')}</body></html>`;
}
function photoHtml(png, d, VW, VH, seed) {
  const { W, H } = PAPER[d.paper];
  const pw = Math.round(VW * 0.86), ph = Math.round((pw * H) / W);
  const left = Math.round((VW - pw) / 2) + ((seed % 9) - 4) * 4, top = Math.round((VH - ph) / 2) + ((seed % 5) - 2) * 6;
  const lx = 15 + (seed % 60), ly = 10 + (seed % 25);
  return `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}
.desk{position:relative;width:${VW}px;height:${VH}px;overflow:hidden;background:radial-gradient(ellipse at 40% 30%,#5a4a3e,#2a211c 70%,#18120f);}
.grain{position:absolute;inset:0;background:repeating-linear-gradient(${88 + (seed % 5)}deg,rgba(255,255,255,.025) 0 3px,rgba(0,0,0,.05) 3px 7px),${noise(seed + 3, 0.6)};opacity:.9;mix-blend-mode:overlay}
.sheet{position:absolute;left:${left}px;top:${top}px;width:${pw}px;height:${ph}px;transform:perspective(2400px) rotateX(${1.2 + (seed % 3) * 0.4}deg) rotate(${d.rot}deg);box-shadow:0 22px 45px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.4);background:#fffdf6}
.sheet img{width:100%;height:100%;display:block;filter:blur(.7px) contrast(.9) brightness(.98) sepia(.12) saturate(.85)}
.sheet .pn{position:absolute;inset:0;background-image:${noise(seed + 7, 0.9)};opacity:.07;mix-blend-mode:multiply}
.light{position:absolute;inset:0;background:radial-gradient(ellipse at ${lx}% ${ly}%,rgba(255,248,225,.35),rgba(255,248,225,0) 55%);mix-blend-mode:screen}
.shade{position:absolute;inset:0;background:radial-gradient(ellipse at ${100 - lx}% ${92 - (seed % 10)}%,rgba(0,0,0,.42),rgba(0,0,0,0) 52%),linear-gradient(${100 + (seed % 40)}deg,rgba(0,0,0,0) 55%,rgba(20,15,10,.22));mix-blend-mode:multiply}
</style></head><body><div class="desk"><div class="grain"></div><div class="sheet"><img src="data:image/png;base64,${png.toString('base64')}"><div class="pn"></div></div><div class="light"></div><div class="shade"></div></div></body></html>`;
}

// ---------------------------------------------------------------- PDF determinism + poppler checks
function pinPdfDates(buf) {
  const s = buf.toString('latin1').replace(/\/(CreationDate|ModDate)\s*\(D:([^)]*)\)/g, (m, k, v) => {
    const fixed = '20261120000000';
    let j = 0; return m.replace(v, v.replace(/\d/g, () => fixed[j++] || '0'));
  });
  return Buffer.from(s, 'latin1');
}
const have = (bin) => { try { execFileSync(bin, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };
const HAVE_POPPLER = have('pdftotext') && have('pdfinfo');
const pdfPages = (f) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [f]).toString())[1]);
const pdfText = (f) => execFileSync('pdftotext', ['-layout', f, '-']).toString();

// ---------------------------------------------------------------- proof assertions
function checkProof(d, entry) {
  const sum = entry.rows.reduce((s, r) => s + r.cents, 0);
  const holds = entry.closing_cents !== null && entry.opening_cents + sum === entry.closing_cents;
  let firstBreak = null; let prev = entry.opening_cents;
  if (entry.has_running_balance) entry.rows.forEach((r, i) => { if (firstBreak === null && prev + r.cents !== r.balance_cents) firstBreak = i; prev = r.balance_cents; });
  for (const r of entry.rows) {
    if (!Number.isInteger(r.cents) || r.cents === 0) fail(`${d.name}: bad cents ${r.cents}`);
    if (!r.date.startsWith(`${YEAR}-${pad(d.m)}-`)) fail(`${d.name}: date outside period ${r.date}`);
  }
  if (entry.rows.length < 15 || entry.rows.length > 70) fail(`${d.name}: ${entry.rows.length} rows, need 15..70`);
  if (entry.expect === 'proof_ok') {
    if (!holds) fail(`${d.name}: proof_ok but opening + sum != closing`);
    if (firstBreak !== null) fail(`${d.name}: proof_ok but running balance breaks at row ${firstBreak}`);
  } else if (entry.expect === 'proof_fail') {
    if (holds) fail(`${d.name}: proof_fail but opening + sum == closing`);
    if (entry.has_running_balance && firstBreak !== entry.planted.row_index) fail(`${d.name}: planted row_index ${entry.planted.row_index} but first balance break at ${firstBreak}`);
    if (!entry.has_running_balance && firstBreak !== null) fail(`${d.name}: no running balance expected`);
  } else if (entry.expect === 'needs_closing') {
    if (entry.closing_cents !== null) fail(`${d.name}: needs_closing but closing printed`);
  }
  // ground truth must still prove (true rows)
  if (d.closing !== null && d.opening + d.truth.reduce((s, r) => s + r.cents, 0) !== d.closing) fail(`${d.name}: truth does not prove`);
}

// ---------------------------------------------------------------- main
const browser = await chromium.launch();
const ctx1 = await browser.newContext({ deviceScaleFactor: 1 });
const ctxHi = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx1.newPage();
const hi = await ctxHi.newPage();
const manifest = {
  note: 'FICTIONAL synthetic bank statements for the Finman Statement Agent evaluation (fictional banks, people, addresses, merchants). All amounts are integer cents. ' +
    'rows[].cents is the amount AS PRINTED (planted errors included), negative = money out of the account holder\'s pocket. ' +
    'Bank accounts: opening_cents/closing_cents are the printed balances. Credit cards (sign_convention "card (purchases positive on paper)"): purchases/charges are printed positive and payments/credits negative or with CR; ' +
    'in this manifest purchases are negative and payments positive, opening_cents = -(Previous balance owed) and closing_cents = -(New balance owed), so opening + sum(rows) = closing holds in the same algebra. ' +
    'For cards, rows[].date is the transaction date (first column); the posting date is in rows[].post_date. balance_cents is the printed running balance or null. ' +
    '"Balance brought/carried forward" lines (t01, t12) and OPENING/CLOSING BALANCE table lines are not transactions and are not in rows. ' +
    'planted.row_index = index in rows of the bad row (flipped_sign, wrong_digit), of the extra copy (duplicated_row), or of the printed row right after the gap (dropped_row; with a running balance this is the first row whose balance breaks). ' +
    'expect: proof_ok = opening + sum(rows) == closing and every running balance matches; proof_fail = it does not (agent must flag, never force-fit); needs_closing = no closing balance printed, agent must ask for it. ' +
    'Regenerate: node make_eval.mjs',
  files: {},
};

for (const spec of SPECS) {
  const d = buildDoc(spec);
  if (spec.noClosing) d.closing = null;
  const pages = await paginate(page, d);
  pages.forEach((idx, p) => idx.forEach((i) => (d.printed[i].page = p + 1)));
  const html = finalHtml(d, pages);
  const file = path.join(DIR, spec.name);
  if (spec.kind === 'photo' && pages.length !== 1) fail(`${spec.name}: photo must be one page, got ${pages.length}`);
  if (pages.length > 3) fail(`${spec.name}: ${pages.length} pages (max 3)`);

  if (spec.kind === 'text-pdf') {
    await page.setContent(html); await checkNoClip(page, spec.name);
    fs.writeFileSync(file, pinPdfDates(await page.pdf({ preferCSSPageSize: true, printBackground: true })));
  } else {
    await hi.setViewportSize(PAPER[d.paper].W === 816 ? { width: 816, height: 1056 } : { width: 794, height: 1122 });
    await hi.setContent(html); await checkNoClip(hi, spec.name);
    const pngs = [];
    for (let i = 0; i < pages.length; i++) pngs.push(await hi.locator('.page').nth(i).screenshot({ type: 'png' }));
    const seed = hash(spec.name) % 997;
    if (spec.kind === 'scan-pdf') {
      const { W, H } = PAPER[d.paper]; const sw = Math.round(W * 1.5), sh = Math.round(H * 1.5);
      await page.setViewportSize({ width: sw, height: sh });
      const jpgs = [];
      for (let i = 0; i < pngs.length; i++) { await page.setContent(scanHtml(pngs[i], sw, sh, i, seed)); jpgs.push(await page.screenshot({ type: 'jpeg', quality: 55 })); }
      await page.setContent(scanPdfHtml(jpgs, d.paper));
      fs.writeFileSync(file, pinPdfDates(await page.pdf({ preferCSSPageSize: true, printBackground: true })));
    } else {
      const VW = 1240, VH = d.paper === 'a4' ? 1680 : 1620;
      await page.setViewportSize({ width: VW, height: VH });
      await page.setContent(photoHtml(pngs[0], d, VW, VH, seed));
      let q = 80, jpg;
      do { jpg = await page.screenshot({ type: 'jpeg', quality: q }); q -= 8; } while (jpg.length > 1.45 * 1024 * 1024 && q > 30);
      if (jpg.length > 1.5 * 1024 * 1024) fail(`${spec.name}: photo too large ${jpg.length}`);
      fs.writeFileSync(file, jpg);
    }
  }

  const card = d.layout === 'card';
  const entry = {
    kind: spec.kind,
    pages: pages.length,
    bank: d.bankInfo.name + ' (fictional)',
    layout: { wdb: 'withdrawals/deposits columns', signed: 'single signed amount column', crdr: 'amount with CR/DR suffix', paren: 'negatives in parentheses', card: card ? `credit card, payments shown ${d.cardCredit === 'cr' ? 'with CR' : 'with minus'}` : '' }[d.layout],
    paper: d.paper,
    currency: d.cur,
    number_format: d.nf === 'eu' ? '1.234,56' : '1,234.56',
    date_format: DF_NAME[d.df],
    sign_convention: card ? 'card (purchases positive on paper)' : 'bank',
    opening_cents: d.opening,
    closing_cents: d.closing,
    has_running_balance: !!d.rb,
    rows: d.printed.map((r) => ({ date: r.date, ...(card ? { post_date: r.post } : {}), description: r.desc.join(' '), cents: r.cents, balance_cents: d.rb ? r.balance : null, page: r.page, ...(r.desc.length > 1 ? { wrapped: true } : {}) })),
    planted: d.planted ? { type: d.planted.type, row_index: d.planted.row_index, page: d.printed[d.planted.row_index].page, detail: d.planted.detail, ...(d.planted.true_row ? { true_row: d.planted.true_row } : {}) } : null,
    expect: d.noClosing ? 'needs_closing' : d.planted ? 'proof_fail' : 'proof_ok',
  };
  if (card) entry.card_note = `Printed Previous balance ${owedText(d, d.prevOwed)} => opening_cents ${d.opening}; ${d.noClosing ? 'New balance not printed (interim activity page, "continued on next page")' : `printed New balance ${owedText(d, -d.closing)} => closing_cents ${d.closing}`}.`;
  if (d.carry) entry.carry_forward_lines = true;
  if (d.noClosing) entry.printed_page_label = 'Page 1 of 3 (only page 1 provided)';
  checkProof(d, entry);

  // poppler self-checks
  if (HAVE_POPPLER && spec.kind !== 'photo') {
    if (pdfPages(file) !== pages.length) fail(`${spec.name}: pdfinfo pages ${pdfPages(file)} != ${pages.length}`);
    const txt = pdfText(file);
    if (spec.kind === 'scan-pdf') {
      if (txt.replace(/\s/g, '').length > 5) fail(`${spec.name}: scan has a text layer: ${txt.slice(0, 80)}`);
    } else {
      const per = txt.split('\f');
      if ((txt.match(/SAMPLE DATA/g) || []).length < pages.length * 2) fail(`${spec.name}: stamp missing on a page`);
      entry.rows.forEach((r, i) => { const a = fmtAbs(r.cents, d.nf); if (!per[r.page - 1].includes(a)) fail(`${spec.name}: row ${i} amount ${a} not found on page ${r.page}`); });
      if (d.closing !== null && !per[pages.length - 1].includes(fmtAbs(d.closing, d.nf))) fail(`${spec.name}: closing not on last page`);
      if (!per[0].includes(fmtAbs(d.opening, d.nf))) fail(`${spec.name}: opening not on page 1`);
    }
  }
  manifest.files[spec.name] = entry;
  const sz = fs.statSync(file).size;
  console.log(`${spec.name.padEnd(46)} ${spec.kind.padEnd(8)} p${pages.length} rows ${String(entry.rows.length).padStart(2)} ${entry.expect.padEnd(13)} ${(sz / 1024).toFixed(0).padStart(5)} KB${d.planted ? ' planted=' + d.planted.type + '@' + d.planted.row_index : ''}`);
}
await browser.close();
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

const total = fs.readdirSync(DIR).reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0);
if (total > 25 * 1024 * 1024) fail(`folder is ${(total / 1048576).toFixed(1)} MB (> 25 MB)`);
const by = (k) => Object.values(manifest.files).reduce((m, e) => ((m[e[k]] = (m[e[k]] || 0) + 1), m), {});
console.log('files', Object.keys(manifest.files).length, JSON.stringify(by('kind')), JSON.stringify(by('expect')), `total ${(total / 1048576).toFixed(2)} MB`, HAVE_POPPLER ? '' : '(poppler checks skipped)');
