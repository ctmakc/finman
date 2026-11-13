// services/invoice/pdf.js — invoice -> PDF (pdfkit).
//
// Two layouts:
//   classic — replicates the INNOVA HTML templates (docs-templates/innova/invoice-template*.html):
//             A4, Arial-metric font (Liberation Sans), bold monospace bank fields, bordered tables.
//   light   — replicates OH! Catering's invoice: Letter, Montserrat, airy grey tables.
// Every page carries the Finman Online footer line with a sign-up link.

const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const core = require('./core');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const PX = 0.75; // CSS px -> pt
const MM = 72 / 25.4;

const FOOTER_TEXT = 'Made with Finman Online — free invoicing and money app. Sign up free: app.finman.money';

function registerFonts(doc) {
  doc.registerFont('Sans', path.join(FONT_DIR, 'LiberationSans-Regular.ttf'));
  doc.registerFont('Sans-Bold', path.join(FONT_DIR, 'LiberationSans-Bold.ttf'));
  doc.registerFont('Mono-Bold', path.join(FONT_DIR, 'LiberationMono-Bold.ttf'));
  doc.registerFont('Mono', path.join(FONT_DIR, 'LiberationMono-Regular.ttf'));
  doc.registerFont('Mont', path.join(FONT_DIR, 'Montserrat-Regular.ttf'));
  doc.registerFont('Mont-Medium', path.join(FONT_DIR, 'Montserrat-Medium.ttf'));
  doc.registerFont('Mont-Semi', path.join(FONT_DIR, 'Montserrat-SemiBold.ttf'));
}

function dataUrlToBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(v));
  return m ? Buffer.from(m[2], 'base64') : null;
}

// "**bold** rest" -> [{t:'bold', b:true}, {t:' rest'}]
function parseRich(s) {
  const out = [];
  String(s || '').split(/(\*\*[^*]+\*\*)/).forEach((p) => {
    if (!p) return;
    if (p.startsWith('**') && p.endsWith('**')) out.push({ t: p.slice(2, -2), b: true });
    else out.push({ t: p, b: false });
  });
  return out;
}

class Writer {
  constructor(doc) { this.doc = doc; }

  // Sets font+size and returns the pdfkit lineGap that yields CSS line-height `lh`.
  setFont(font, size, lh) {
    this.doc.font(font).fontSize(size);
    return lh ? Math.max(0, lh * size - this.doc.currentLineHeight(true)) : 0;
  }

  // Half-leading offset so a CSS line box starting at `top` puts glyphs where the browser does.
  halfLeading(size, lh) {
    const f = this.doc._font;
    const content = ((f.ascender - f.descender) / 1000) * size;
    return (lh * size - content) / 2;
  }

  height(str, { font, size, lh = 1.35, width, characterSpacing = 0 }) {
    const lineGap = this.setFont(font, size, lh);
    if (!str) return 0;
    return this.doc.heightOfString(String(str), { width, lineGap, characterSpacing });
  }

  // Draws text whose CSS line box starts at `top`; returns the block height.
  text(str, x, top, { font, size, lh = 1.35, width, align = 'left', color = '#000', characterSpacing = 0, link, underline = false } = {}) {
    if (str === null || str === undefined || str === '') return 0;
    const lineGap = this.setFont(font, size, lh);
    const doc = this.doc;
    doc.fillColor(color);
    const h = doc.heightOfString(String(str), { width, lineGap, characterSpacing });
    doc.text(String(str), x, top + this.halfLeading(size, lh), { width, align, lineGap, characterSpacing, link, underline, lineBreak: true });
    return h;
  }

  // Mixed regular/bold runs (bold font for **…** parts). Returns height.
  rich(str, x, top, { font, bold, size, boldSize, lh = 1.35, width, color = '#000', align = 'left' }) {
    const segs = parseRich(str);
    if (!segs.length) return 0;
    if (segs.length === 1 && !segs[0].b) return this.text(segs[0].t, x, top, { font, size, lh, width, color, align });
    const doc = this.doc;
    const lineGap = this.setFont(font, size, lh);
    // Height: measure the plain string in the regular font (bold runs are short codes).
    const h = doc.heightOfString(segs.map((s) => s.t).join(''), { width, lineGap });
    doc.fillColor(color);
    const y0 = top + this.halfLeading(size, lh);
    segs.forEach((s, i) => {
      doc.font(s.b ? bold : font).fontSize(s.b ? (boldSize || size) : size);
      const opts = { width, lineGap, continued: i < segs.length - 1, align };
      if (i === 0) doc.text(s.t, x, y0, opts);
      else doc.text(s.t, opts);
    });
    return h;
  }

  rect(x, y, w, h, { stroke = '#000', lineWidth = 0.75, fill } = {}) {
    const doc = this.doc;
    doc.save();
    if (fill) doc.rect(x, y, w, h).fill(fill);
    if (stroke) doc.lineWidth(lineWidth).strokeColor(stroke).rect(x, y, w, h).stroke();
    doc.restore();
  }

  hline(x1, x2, y, { color = '#000', width = 0.75 } = {}) {
    const doc = this.doc;
    doc.save().lineWidth(width).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
  }
}

function moneyFmt(view) {
  const d = view.data;
  if (d.money_style === 'symbol') return (c) => `${c < 0 ? '-' : ''}${d.symbol || '$'}${core.fmtCents(Math.abs(c))}`;
  return (c) => `${view.currency} ${core.fmtCents(c)}`;
}

function placeholders(view) {
  return {
    title: view.data.title || 'INVOICE',
    number: view.number,
    currency: view.currency,
    date: view.issue_date,
    date_long: core.longDate(view.issue_date),
    date_dmy: core.dmy(view.issue_date),
    date_dmy_long: core.dayMonthYear(view.issue_date),
    due: view.due_date || '',
    due_long: view.due_date ? core.longDate(view.due_date) : '',
    due_dmy: view.due_date ? core.dmy(view.due_date) : '',
    due_days: view.due_date ? core.daysBetween(view.issue_date, view.due_date) : '',
    count: view.items.length,
    total: core.fmtCents(view.total_cents),
  };
}

async function qrPng(url) {
  return QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 1, scale: 8, type: 'png' });
}

function drawImage(doc, buf, x, y, opts) {
  if (!buf) return 0;
  try {
    const img = doc.openImage(buf);
    const w = opts.width;
    const h = (img.height / img.width) * w;
    doc.image(img, x, opts.bottom !== undefined ? opts.bottom - h : y, { width: w });
    return h;
  } catch (_) {
    return 0;
  }
}

function stripScheme(u) { return String(u).replace(/^https?:\/\//, ''); }

// ------------------------------------------------------------------ classic
async function renderClassic(doc, view) {
  const W_ = new Writer(doc);
  const d = view.data;
  const ph = placeholders(view);
  const money = moneyFmt(view);
  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const ML = 18 * MM, MR = 16 * MM, MT = 15 * MM;
  const W = PAGE_W - ML - MR;
  const BOTTOM = PAGE_H - 34; // keep clear of the footer line
  const S = 'Sans', SB = 'Sans-Bold';
  let y = MT;

  const ensure = (h) => {
    if (y + h > BOTTOM) { doc.addPage(); y = MT; return true; }
    return false;
  };

  // Header: heading + due line, logo on the right.
  const logoW = 64 * PX;
  if (view.logo) drawImage(doc, view.logo, ML + W - logoW, MT - 4 * PX, { width: logoW });
  const headW = W - (view.logo ? logoW + 8 : 0);
  const h1 = W_.text(core.fill(d.heading, ph), ML, y, { font: SB, size: 16, width: headW });
  y += h1 + 2 * PX;
  const dueLine = core.fill(d.due_line, ph).trim();
  if (dueLine) y += W_.text(dueLine, ML, y, { font: S, size: 10.5, width: headW });
  if (view.logo) y = Math.max(y, MT - 4 * PX + logoW * 0.86);
  y += 8 * PX;
  W_.hline(ML, ML + W, y + PX, { width: 2 * PX });
  y += 2 * PX + 14 * PX;

  const party = (label, name, lines) => {
    const lw = 120 * PX;
    const body = [name ? `**${name}**` : null, ...(lines || [])].filter((s) => s !== null && s !== undefined && s !== '');
    let h = 0;
    W_.text(label, ML, y, { font: S, size: 10.5, width: lw });
    body.forEach((ln) => {
      h += W_.rich(ln, ML + lw, y + h, { font: S, bold: SB, size: 10.5, width: W - lw });
    });
    y += Math.max(h, 14) + 10 * PX;
  };

  const clientLines = String(view.client_details || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  const bankBox = () => {
    const b = d.bank;
    if (!b || !((b.key && b.key.length) || (b.rest && b.rest.length))) return;
    const padT = 9 * PX, padX = 14 * PX, padB = 8 * PX, kw = 180 * PX;
    const iw = W - 2 * padX - 2 * PX;
    const ix = ML + PX + padX;
    // measure
    const ttlH = b.title ? W_.height(String(b.title).toUpperCase(), { font: SB, size: 10, width: iw, characterSpacing: 0.6 }) + 5 * PX : 0;
    const keys = (b.key || []).filter((r) => r && (r.k || r.v));
    const rowH = 15 * 1.35;
    const keyH = keys.length ? keys.length * rowH + (keys.length - 1) * 3 * PX : 0;
    const rest = (b.rest || []).filter((r) => r && (r.k || r.v));
    const restRowsH = rest.map((r) => Math.max(
      W_.height(r.k, { font: S, size: 8.8, lh: 1.3, width: kw - 4 }),
      W_.height(String(r.v).replace(/\*\*/g, ''), { font: S, size: 8.8, lh: 1.3, width: iw - kw }),
    ));
    const noteH = b.note ? W_.height(b.note, { font: S, size: 8.8, lh: 1.3, width: iw }) + 3 * PX : 0;
    const restH = rest.length || b.note ? 7 * PX + 6 * PX + restRowsH.reduce((a, v) => a + v, 0) + noteH : 0;
    const boxH = 2 * PX + padT + ttlH + keyH + restH + padB + 2 * PX;
    ensure(boxH);
    const top = y;
    W_.rect(ML + PX, top + PX, W - 2 * PX, boxH - 2 * PX, { lineWidth: 2 * PX });
    let yy = top + 2 * PX + padT;
    if (b.title) {
      W_.text(String(b.title).toUpperCase(), ix, yy, { font: SB, size: 10, width: iw, characterSpacing: 0.6 });
      yy += ttlH;
    }
    keys.forEach((r, i) => {
      // value: monospace bold 15pt; label baseline-aligned to it
      W_.setFont('Mono-Bold', 15, 1.35);
      const vy = yy + W_.halfLeading(15, 1.35);
      const baseline = vy + (doc._font.ascender / 1000) * 15;
      doc.fillColor('#000').text(String(r.v || ''), ix + kw, vy, { width: iw - kw, lineBreak: false, characterSpacing: 0.45 });
      W_.setFont(S, 9.5);
      doc.fillColor('#333').text(String(r.k || ''), ix, baseline - (doc._font.ascender / 1000) * 9.5, { width: kw - 4, lineBreak: false });
      yy += rowH + (i < keys.length - 1 ? 3 * PX : 0);
    });
    if (restH) {
      yy += 7 * PX;
      W_.hline(ix, ix + iw, yy, { color: '#999', width: PX });
      yy += 6 * PX;
      rest.forEach((r, i) => {
        W_.text(r.k, ix, yy, { font: S, size: 8.8, lh: 1.3, width: kw - 4, color: '#222' });
        W_.rich(r.v, ix + kw, yy, { font: S, bold: 'Mono-Bold', size: 8.8, lh: 1.3, width: iw - kw, color: '#222' });
        yy += restRowsH[i];
      });
      if (b.note) {
        yy += 3 * PX;
        W_.text(b.note, ix, yy, { font: S, size: 8.8, lh: 1.3, width: iw, color: '#333' });
      }
    }
    y = top + boxH + 14 * PX;
  };

  party(d.seller.label || 'Supplier:', d.seller.name, d.seller.lines);
  if (d.bank_before_client) { bankBox(); party(d.client_label || 'Bill to:', view.client_name, clientLines); } else { party(d.client_label || 'Bill to:', view.client_name, clientLines); bankBox(); }

  // Items table
  y += 6 * PX - 0; // .items margin-top (bank margin already applied)
  const colNo = 40 * PX, colQty = (d.qty_width || 50) * PX, colPrice = 100 * PX, colAmt = 104 * PX;
  const colDesc = W - colNo - colQty - colPrice - colAmt;
  const cols = [colNo, colDesc, colQty, colPrice, colAmt];
  const padX = 7 * PX, padY = 5 * PX;
  const headers = ['No.', core.fill(d.item_header || 'Services', ph), core.fill(d.qty_header || 'Qty', ph), core.fill(d.price_header || 'Price', ph), core.fill(d.amount_header || 'Amount', ph)];
  const drawRow = (cells, { header = false } = {}) => {
    const heights = cells.map((c, i) => {
      const w = cols[i] - 2 * padX;
      if (header) return W_.height(c, { font: SB, size: 10.5, width: w });
      if (i === 1) {
        return c.reduce((a, part) => a + W_.height(part.t, { font: part.b ? SB : S, size: part.size || 10.5, lh: part.size ? 1.3 : 1.35, width: w }), 0);
      }
      return W_.height(c, { font: S, size: 10.5, width: w });
    });
    const rowH = Math.max(...heights) + 2 * padY;
    if (ensure(rowH) && !header) drawRow(headers, { header: true });
    let x = ML;
    cells.forEach((c, i) => {
      const w = cols[i];
      W_.rect(x, y, w, rowH, { fill: header ? '#efefef' : null });
      const tw = w - 2 * padX;
      if (header) W_.text(c, x + padX, y + padY, { font: SB, size: 10.5, width: tw, align: 'center' });
      else if (i === 1) {
        let yy = y + padY;
        c.forEach((part) => { yy += W_.text(part.t, x + padX, yy, { font: part.b ? SB : S, size: part.size || 10.5, lh: part.size ? 1.3 : 1.35, width: tw, color: part.color || '#000' }); });
      } else W_.text(c, x + padX, y + padY, { font: S, size: 10.5, width: tw, align: i === 0 || i === 2 ? 'center' : 'right' });
      x += w;
    });
    y += rowH;
  };
  drawRow(headers, { header: true });
  view.items.forEach((it, idx) => {
    const desc = [{ t: it.description || '' }];
    if (it.detail) desc.push({ t: it.detail, b: true });
    if (it.note) desc.push({ t: it.note, size: 8.8, color: '#333' });
    drawRow([String(idx + 1), desc, core.fmtQty(it.qty), core.fmtCents(it.price_cents), core.fmtCents(it.amount_cents)]);
  });

  // Totals
  y += 8 * PX;
  const valW = 130 * PX;
  const lblW = W - valW - 2 * padX;
  // The source HTML has no doctype (quirks mode), so the totals table renders at the
  // browser default 16px = 12pt; .sm stays 8.8pt.
  const TS = 12, TLH = 1.15;
  const totalRow = (label, sub, value, bold) => {
    const lh = W_.height(label, { font: bold ? SB : S, size: TS, lh: TLH, width: lblW - padX });
    const sh = sub ? W_.height(sub, { font: S, size: 8.8, lh: TLH, width: lblW - padX }) : 0;
    const h = lh + sh + 4 * PX;
    ensure(h);
    W_.text(label, ML + padX, y + 2 * PX, { font: bold ? SB : S, size: TS, lh: TLH, width: lblW - padX, align: 'right' });
    if (sub) W_.text(sub, ML + padX, y + 2 * PX + lh, { font: S, size: 8.8, lh: TLH, width: lblW - padX, align: 'right', color: '#222' });
    W_.text(value, ML + lblW + padX, y + 2 * PX, { font: SB, size: TS, lh: TLH, width: valW, align: 'right' });
    y += h;
  };
  totalRow('Subtotal:', '', money(view.subtotal_cents));
  if (view.tax_label || view.tax_rate !== null) {
    const taxVal = view.tax_rate === null || view.tax_rate === undefined ? (view.tax_text || '—') : money(view.tax_cents);
    totalRow(core.fill(view.tax_label || 'Tax:', { ...ph, rate: view.tax_rate }), view.tax_sub || '', taxVal);
  }
  totalRow('Total due:', '', money(view.total_cents), true);

  // Amount in words
  const words = d.words || {};
  if (words.enabled !== false) {
    const w1 = core.fill(words.prefix || 'Total items {count}, amount due:', ph);
    const w2 = core.amountInWords(view.total_cents, view.currency, words.unit || null);
    const note = words.note || '';
    const hh = W_.height(w1, { font: S, size: 10.5, width: W }) + W_.height(w2, { font: SB, size: 10.5, width: W }) + (note ? W_.height(note, { font: S, size: 8.5, width: W }) + 3 * PX : 0);
    y += 10 * PX;
    ensure(hh);
    y += W_.text(w1, ML, y, { font: S, size: 10.5, width: W });
    y += W_.text(w2, ML, y, { font: SB, size: 10.5, width: W });
    if (note) { y += 3 * PX; y += W_.text(note, ML, y, { font: S, size: 8.5, width: W, color: '#333' }); }
  }

  // Payment reference / pay online
  const ref = core.fill(d.payment_reference || '', ph).trim();
  if (view.pay_url) {
    const qr = await qrPng(view.pay_url);
    const qrS = 15 * MM, pX = 12 * PX, pY = 6 * PX;
    const tx = ML + pX + qrS + 12 * PX;
    const tw = W - (tx - ML) - pX;
    const lines = [];
    if (ref) lines.push({ rich: `**Payment reference:** ${ref}` });
    lines.push({ rich: `**Or pay online** ${d.pay_online.label || ''}`.trim() });
    lines.push({ url: view.pay_url });
    const th = lines.reduce((a, l) => a + (l.url
      ? W_.height(stripScheme(l.url), { font: 'Mono', size: 9.5, width: tw })
      : W_.height(l.rich.replace(/\*\*/g, ''), { font: S, size: 10.5, width: tw })), 0);
    const boxH = Math.max(qrS, th) + 2 * pY;
    y += 12 * PX;
    ensure(boxH);
    W_.rect(ML, y, W, boxH);
    doc.image(qr, ML + pX, y + (boxH - qrS) / 2, { width: qrS, height: qrS, link: view.pay_url });
    let yy = y + (boxH - th) / 2;
    lines.forEach((l) => {
      if (l.url) {
        const label = stripScheme(l.url);
        yy += W_.text(label, tx, yy, { font: 'Mono', size: 9.5, width: tw, link: l.url, underline: true });
      } else yy += W_.rich(l.rich, tx, yy, { font: S, bold: SB, size: 10.5, width: tw });
    });
    y += boxH;
  } else if (ref) {
    const pX = 12 * PX, pY = 8 * PX;
    const th = W_.height(`Payment reference: ${ref}`, { font: S, size: 10.5, width: W - 2 * pX });
    y += 12 * PX;
    ensure(th + 2 * pY);
    W_.rect(ML, y, W, th + 2 * pY);
    W_.rich(`**Payment reference:** ${ref}`, ML + pX, y + pY, { font: S, bold: SB, size: 10.5, width: W - 2 * pX });
    y += th + 2 * pY;
  }

  // Terms
  const terms = core.fill(view.terms || '', ph).trim();
  if (terms) {
    const th = W_.height(terms, { font: S, size: 9.3, width: W });
    y += 10 * PX;
    ensure(th);
    y += W_.text(terms, ML, y, { font: S, size: 9.3, width: W, color: '#222' });
  }
  if (view.notes) {
    const th = W_.height(view.notes, { font: S, size: 9.3, width: W });
    y += 6 * PX;
    ensure(th);
    y += W_.text(view.notes, ML, y, { font: S, size: 9.3, width: W, color: '#222' });
  }

  // Signature block
  if (d.signer && (d.signer.title || (d.signer.lines || []).length)) {
    const whoW = 340 * PX;
    const body = [d.signer.title ? `**${d.signer.title}**` : null, ...(d.signer.lines || [])].filter(Boolean);
    const hh = body.reduce((a, l) => a + W_.height(l.replace(/\*\*/g, ''), { font: S, size: 10.5, width: whoW }), 0);
    y += 30 * PX;
    ensure(hh + 12);
    let yy = y;
    body.forEach((l) => { yy += W_.rich(l, ML, yy, { font: S, bold: SB, size: 10.5, width: whoW }); });
    const lineX = ML + whoW + 16 * PX;
    const lineW = 220 * PX;
    W_.hline(lineX, lineX + lineW, yy, { width: PX });
    if (view.signature) {
      drawImage(doc, view.signature, lineX + 10 * PX, 0, { width: (d.signature_width || 200) * PX, bottom: yy + (d.signature_drop === undefined ? 14 : d.signature_drop) * PX });
    }
    y = yy;
  }
}

// ------------------------------------------------------------------ light
async function renderLight(doc, view) {
  const W_ = new Writer(doc);
  const d = view.data;
  const ph = placeholders(view);
  const money = moneyFmt(view);
  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const ML = 82, MR = PAGE_W - 530;
  const W = PAGE_W - ML - MR;
  const BOTTOM = PAGE_H - 40;
  const R = 'Mont', M = 'Mont-Medium', SB = 'Mont-Semi';
  const GREY = '#6b6b6b';
  const LINE = '#dcdcdc';
  let y = 31;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 50; return true; } return false; };

  if (view.logo) drawImage(doc, view.logo, ML, 31, { width: 58.5 });
  y = view.logo ? 104 : 60;

  // Seller (left) and invoice number/date (right)
  const top = y;
  let ly = top;
  const sellerLines = [d.seller.name, ...(d.seller.lines || [])].filter(Boolean);
  sellerLines.forEach((l) => { ly += W_.text(l, ML, ly, { font: R, size: 9.4, lh: 1.34, width: W / 2 }); });
  let ry = top - 4;
  ry += W_.text(core.fill(d.heading || '{title} N°: {number}', ph), ML + W / 2, ry, { font: SB, size: 11.5, lh: 1.4, width: W / 2, align: 'right' });
  const dl = core.fill(d.date_line || 'Date: {date_dmy_long}', ph).trim();
  if (dl) ry += W_.text(dl, ML + W / 2, ry, { font: R, size: 9, lh: 1.5, width: W / 2, align: 'right' });
  const due = core.fill(d.due_line || '', ph).trim();
  if (due) ry += W_.text(due, ML + W / 2, ry, { font: R, size: 9, lh: 1.5, width: W / 2, align: 'right' });
  y = Math.max(ly, ry) + 36;

  // Client
  y += W_.text(d.client_label || "Client's Information:", ML, y, { font: M, size: 9.4, lh: 1.4, width: W });
  y += 1.5;
  const clientLines = [view.client_name, ...String(view.client_details || '').split(/\r?\n/).map((s) => s.trim())].filter(Boolean);
  clientLines.forEach((l) => { y += W_.text(l, ML, y, { font: R, size: 9.4, lh: 1.34, width: W }); });
  y += 62;

  // Items table: description | qty | price | total, cells separated by small gaps.
  const gap = 2;
  const cw = [227, 73, 70, W - 227 - 73 - 70 - 3 * gap];
  const cx = [ML, ML + cw[0] + gap, ML + cw[0] + cw[1] + 2 * gap, ML + cw[0] + cw[1] + cw[2] + 3 * gap];
  const pad = 10;
  const cellLine = (yy) => cw.forEach((w, i) => W_.hline(cx[i], cx[i] + w, yy, { color: LINE, width: 0.9 }));
  const header = () => {
    cellLine(y);
    const hh = 32;
    const ty = y + (hh - 9 * 1.3) / 2;
    W_.text(core.fill(d.item_header || 'Description / Product', ph), cx[0] + pad, ty, { font: SB, size: 8.6, lh: 1.3, width: cw[0] - 2 * pad });
    W_.text(core.fill(d.qty_header || 'Qty', ph), cx[1] + pad, ty, { font: R, size: 8.6, lh: 1.3, width: cw[1] - 2 * pad, align: 'center' });
    W_.text(core.fill(d.price_header || 'Price', ph), cx[2] + pad, ty, { font: R, size: 8.6, lh: 1.3, width: cw[2] - 2 * pad, align: 'center' });
    W_.text(core.fill(d.amount_header || 'Total', ph), cx[3] + pad, ty, { font: SB, size: 8.6, lh: 1.3, width: cw[3] - 2 * pad, align: 'right' });
    y += hh;
    cellLine(y);
  };
  header();
  view.items.forEach((it) => {
    const desc = [it.description, it.detail, it.note].filter(Boolean).join('\n');
    const th = W_.height(desc, { font: R, size: 8.6, lh: 1.45, width: cw[0] - 2 * pad });
    const rh = Math.max(45, th + 20);
    if (ensure(rh)) header();
    const ty = y + (rh - th) / 2;
    W_.text(desc, cx[0] + pad, ty, { font: R, size: 8.6, lh: 1.45, width: cw[0] - 2 * pad, color: GREY });
    const cy = y + (rh - 8.6 * 1.45) / 2;
    W_.text(core.fmtQty(it.qty), cx[1] + pad, cy, { font: R, size: 8.6, lh: 1.45, width: cw[1] - 2 * pad, align: 'center', color: GREY });
    W_.text(it.price_cents ? money(it.price_cents) : '', cx[2] + pad, cy, { font: R, size: 8.6, lh: 1.45, width: cw[2] - 2 * pad, align: 'center', color: GREY });
    W_.text(money(it.amount_cents), cx[3] + pad, cy, { font: R, size: 8.6, lh: 1.45, width: cw[3] - 2 * pad, align: 'right', color: GREY });
    y += rh;
    cellLine(y);
  });

  // Totals: label | rate | value
  y += 95;
  const tw = [87, 33, 78];
  const tx0 = ML + W - (tw[0] + tw[1] + tw[2] + 2 * gap);
  const tx = [tx0, tx0 + tw[0] + gap, tx0 + tw[0] + tw[1] + 2 * gap];
  const tLine = (yy) => tw.forEach((w, i) => W_.hline(tx[i], tx[i] + w, yy, { color: LINE, width: 0.9 }));
  const rowH = 32;
  ensure(rowH * 3 + 10);
  tLine(y);
  const trow = (label, rate, value, bold) => {
    const ty = y + (rowH - 8.6 * 1.3) / 2;
    W_.text(label, tx[0] + pad, ty, { font: bold ? SB : R, size: 8.6, lh: 1.3, width: tw[0] - pad, color: bold ? '#000' : GREY });
    if (rate) W_.text(rate, tx[1], ty, { font: R, size: 8.6, lh: 1.3, width: tw[1], align: 'center', color: GREY });
    W_.text(value, tx[2], ty, { font: bold ? SB : R, size: 8.6, lh: 1.3, width: tw[2] - pad, align: 'right', color: bold ? '#000' : GREY });
    y += rowH;
    tLine(y);
  };
  if (view.tax_rate !== null && view.tax_rate !== undefined) {
    trow('Subtotal', '', money(view.subtotal_cents));
    trow(core.fill(view.tax_label || 'TAX', ph), `${core.fmtQty(view.tax_rate)}%`, money(view.tax_cents));
  } else if (view.tax_text) {
    trow(core.fill(view.tax_label || 'TAX', ph), '', view.tax_text);
  }
  trow('Total', '', money(view.total_cents), true);

  // Payment: reference, online link with QR, terms
  const ref = core.fill(d.payment_reference || '', ph).trim();
  const terms = core.fill(view.terms || '', ph).trim();
  if (view.pay_url || ref || terms || view.notes) {
    y += 34;
    const qrS = view.pay_url ? 56 : 0;
    const txX = ML + (qrS ? qrS + 14 : 0);
    const txW = W - (txX - ML);
    const parts = [];
    if (view.pay_url) parts.push({ t: d.pay_online.label || 'Pay online:', font: M, color: '#000' }, { t: stripScheme(view.pay_url), font: R, color: '#000', link: view.pay_url });
    if (ref) parts.push({ t: ref, font: R, color: GREY });
    if (terms) parts.push({ t: terms, font: R, color: GREY });
    if (view.notes) parts.push({ t: view.notes, font: R, color: GREY });
    const th = parts.reduce((a, p) => a + W_.height(p.t, { font: p.font, size: 8.6, lh: 1.45, width: txW }), 0);
    ensure(Math.max(qrS, th));
    if (view.pay_url) doc.image(await qrPng(view.pay_url), ML, y, { width: qrS, height: qrS, link: view.pay_url });
    let yy = y + (qrS && th < qrS ? (qrS - th) / 2 : 0);
    parts.forEach((p) => { yy += W_.text(p.t, txX, yy, { font: p.font, size: 8.6, lh: 1.45, width: txW, color: p.color, link: p.link }); });
    y = Math.max(y + qrS, yy);
  }
}

// ------------------------------------------------------------------ footer
function drawFooters(doc, footer, layout) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const font = layout === 'light' ? 'Mont' : 'Sans';
    doc.font(font).fontSize(7.5).fillColor('#8a8a8a');
    const y = doc.page.height - 24;
    doc.text(footer.text || FOOTER_TEXT, 30, y, {
      width: doc.page.width - 60, align: 'center', lineBreak: false, link: footer.url,
    });
    doc.page.margins.bottom = bottom;
  }
}

// view: { layout, number, issue_date, due_date, currency, client_name, client_details,
//         items:[{description, detail, note, qty, price_cents, amount_cents}],
//         subtotal_cents, tax_cents, total_cents, tax_rate, tax_label, tax_sub, tax_text,
//         terms, notes, pay_url, data, logo, signature, seller_name }
// footer: { url, text? }
function renderInvoicePdf(view, footer) {
  return new Promise((resolve, reject) => {
    const layout = view.layout === 'light' ? 'light' : 'classic';
    const doc = new PDFDocument({
      size: layout === 'light' ? 'LETTER' : 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `Invoice ${view.number}`,
        Author: view.seller_name || '',
        Creator: 'Finman Online — app.finman.money',
        Producer: 'Finman Online',
      },
    });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const v = { ...view, logo: dataUrlToBuffer(view.logo), signature: dataUrlToBuffer(view.signature) };
    (layout === 'light' ? renderLight(doc, v) : renderClassic(doc, v))
      .then(() => { drawFooters(doc, footer || {}, layout); doc.end(); })
      .catch((e) => { try { doc.end(); } catch (_) { /* ignore */ } reject(e); });
  });
}

module.exports = { renderInvoicePdf, dataUrlToBuffer, parseRich, FOOTER_TEXT };
