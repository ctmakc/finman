// services/invoice/publicPage.js — the client's page of ONE published invoice (/i/<token>).
//
// No account, no app shell: the invoice as the PDF shows it, the amount due, the issuer's own
// payment methods (card link, PayPal.me, Interac e-Transfer, bank details), the PDF.
// Card / PayPal amounts include the card fee when the issuer turned that option on.
// Language: en / ru / uk from Accept-Language (the invoice text itself is the issuer's).
// Styles: /css/invoice-public.css (CLEAR DAY tokens of the app); behaviour: /js/invoice-public.js
// (view beacon, copy buttons). Never indexed (X-Robots-Tag + meta).
'use strict';

const core = require('./core');

const T = {
  en: {
    title: 'Invoice {number}', from: 'From', billTo: 'Bill to', issued: 'Issued', due: 'Due',
    amountDue: 'Amount due', total: 'Total', subtotal: 'Subtotal', paidSoFar: 'Paid so far',
    item: 'Description', qty: 'Qty', price: 'Price', amount: 'Amount',
    payCard: 'Pay by card', payPaypal: 'Pay with PayPal', cardFee: 'includes {pct}% card fee, paid by the payer',
    etransfer: 'Interac e-Transfer', etransferTo: 'Send to', bank: 'Bank transfer', reference: 'Reference',
    copy: 'Copy', copied: 'Copied', pdf: 'Download PDF', payTitle: 'How to pay',
    payNone: 'Payment details are in the PDF.',
    paid: 'This invoice is paid. Thank you.', void: 'This invoice was cancelled by the issuer.',
    overdue: 'Payment is overdue', dueOn: 'Due {date}',
    goneTitle: 'This link is turned off', goneText: 'The issuer turned this invoice link off. Ask them for a new one.',
    missingTitle: 'Invoice not found', missingText: 'Check the link, or ask the issuer to send it again.',
    note: 'Payment goes straight to {seller}. Finman shows the invoice and never takes the money.',
    made: 'Invoice made with Finman', madeCta: 'Make your own invoices',
  },
  ru: {
    title: 'Счёт {number}', from: 'От кого', billTo: 'Кому', issued: 'Выставлен', due: 'Оплатить до',
    amountDue: 'К оплате', total: 'Итого', subtotal: 'Сумма', paidSoFar: 'Уже оплачено',
    item: 'Описание', qty: 'Кол-во', price: 'Цена', amount: 'Сумма',
    payCard: 'Оплатить картой', payPaypal: 'Оплатить через PayPal', cardFee: 'включая комиссию карты {pct}%, её платит плательщик',
    etransfer: 'Interac e-Transfer', etransferTo: 'Получатель', bank: 'Банковский перевод', reference: 'Назначение',
    copy: 'Копировать', copied: 'Скопировано', pdf: 'Скачать PDF', payTitle: 'Как оплатить',
    payNone: 'Реквизиты для оплаты — в PDF.',
    paid: 'Счёт оплачен. Спасибо.', void: 'Выставитель отменил этот счёт.',
    overdue: 'Срок оплаты прошёл', dueOn: 'Оплатить до {date}',
    goneTitle: 'Ссылка выключена', goneText: 'Выставитель выключил ссылку на этот счёт. Попросите у него новую.',
    missingTitle: 'Счёт не найден', missingText: 'Проверьте ссылку или попросите выставителя прислать её снова.',
    note: 'Деньги идут напрямую к {seller}. Finman показывает счёт и денег не касается.',
    made: 'Счёт сделан в Finman', madeCta: 'Выставлять свои счета',
  },
  uk: {
    title: 'Рахунок {number}', from: 'Від кого', billTo: 'Кому', issued: 'Виставлено', due: 'Сплатити до',
    amountDue: 'До сплати', total: 'Разом', subtotal: 'Сума', paidSoFar: 'Вже сплачено',
    item: 'Опис', qty: 'К-сть', price: 'Ціна', amount: 'Сума',
    payCard: 'Сплатити карткою', payPaypal: 'Сплатити через PayPal', cardFee: 'разом із комісією картки {pct}%, її сплачує платник',
    etransfer: 'Interac e-Transfer', etransferTo: 'Отримувач', bank: 'Банківський переказ', reference: 'Призначення',
    copy: 'Копіювати', copied: 'Скопійовано', pdf: 'Завантажити PDF', payTitle: 'Як сплатити',
    payNone: 'Реквізити для оплати — у PDF.',
    paid: 'Рахунок сплачено. Дякуємо.', void: 'Виставник скасував цей рахунок.',
    overdue: 'Термін оплати минув', dueOn: 'Сплатити до {date}',
    goneTitle: 'Посилання вимкнено', goneText: 'Виставник вимкнув посилання на цей рахунок. Попросіть у нього нове.',
    missingTitle: 'Рахунок не знайдено', missingText: 'Перевірте посилання або попросіть виставника надіслати його знову.',
    note: 'Гроші йдуть напряму до {seller}. Finman показує рахунок і грошей не торкається.',
    made: 'Рахунок зроблено у Finman', madeCta: 'Виставляти свої рахунки',
  },
};

function langOf(req) {
  const h = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase();
  for (const part of h.split(',')) {
    const code = part.trim().slice(0, 2);
    if (code === 'uk') return 'uk';
    if (code === 'ru') return 'ru';
    if (code === 'en') return 'en';
  }
  return 'en';
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
const strip = (s) => String(s || '').replace(/\*\*/g, '');

function moneyText(cents, cur) {
  return `${core.fmtCents(cents)} ${String(cur || '').toUpperCase()}`;
}
function dateText(ymd, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  try {
    return new Intl.DateTimeFormat(lang === 'en' ? 'en-CA' : lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  } catch (_) { return ymd; }
}

function shell(lang, title, body) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/css/invoice-public.css?v=1122">
</head>
<body>
${body}
<script src="/js/invoice-public.js?v=1122" defer></script>
</body>
</html>`;
}

function footer(t, signupUrl) {
  return `<footer class="ip-made"><span>${esc(t.made)}</span> <a href="${esc(signupUrl)}" rel="noopener">${esc(t.madeCta)}</a></footer>`;
}

function messagePage(lang, kind, signupUrl) {
  const t = T[lang] || T.en;
  const title = kind === 'gone' ? t.goneTitle : t.missingTitle;
  const text = kind === 'gone' ? t.goneText : t.missingText;
  return shell(lang, title, `<main class="ip-wrap ip-msg"><section class="ip-plate"><h1>${esc(title)}</h1><p>${esc(text)}</p></section>${footer(t, signupUrl)}</main>`);
}

function linesBlock(lines) {
  return (lines || []).filter(Boolean).map((l) => `<span>${esc(strip(l))}</span>`).join('');
}

// "HST 13%" stays as written; "HST" becomes "HST 13%".
function taxName(view) {
  const label = strip(core.fill(view.tax_label || 'Tax', {})).trim();
  return /%/.test(label) ? label : `${label} ${core.fmtQty(view.tax_rate)}%`;
}

function itemsTable(view, t) {
  const cur = view.currency;
  const rows = (view.items || []).map((it) => `
      <tr><td class="ip-desc"><b>${esc(it.description)}</b>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}<small class="ip-qp">${esc(core.fmtQty(it.qty))} × ${esc(core.fmtCents(it.price_cents))}</small></td>
      <td class="ip-num">${esc(core.fmtQty(it.qty))}</td><td class="ip-num">${esc(core.fmtCents(it.price_cents))}</td>
      <td class="ip-num">${esc(core.fmtCents(it.amount_cents != null ? it.amount_cents : Math.round((it.qty || 0) * (it.price_cents || 0))))}</td></tr>`).join('');
  const taxRow = view.tax_rate != null
    ? `<tr><th colspan="3">${esc(taxName(view))}</th><td class="ip-num">${esc(core.fmtCents(view.tax_cents))}</td></tr>`
    : (view.tax_text ? `<tr><th colspan="3">${esc(strip(view.tax_label || 'Tax'))}</th><td class="ip-num">${esc(view.tax_text)}</td></tr>` : '');
  return `<table class="ip-items">
    <thead><tr><th>${esc(t.item)}</th><th class="ip-num">${esc(t.qty)}</th><th class="ip-num">${esc(t.price)}</th><th class="ip-num">${esc(t.amount)}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${view.tax_rate != null ? `<tr><th colspan="3">${esc(t.subtotal)}</th><td class="ip-num">${esc(core.fmtCents(view.subtotal_cents))}</td></tr>` : ''}
      ${taxRow}
      <tr class="ip-grand"><th colspan="3">${esc(t.total)}</th><td class="ip-num">${esc(moneyText(view.total_cents, cur))}</td></tr>
    </tfoot></table>`;
}

function copyRow(label, value, t) {
  return `<div class="ip-copy"><span class="ip-copy-k">${esc(label)}</span><span class="ip-copy-v" data-copy-src>${esc(value)}</span>`
    + `<button type="button" class="ip-btn ip-btn-ghost" data-copy data-copied="${esc(t.copied)}">${esc(t.copy)}</button></div>`;
}

function payBlock(p, t) {
  const cur = p.view.currency;
  const pay = p.pay;
  const open = p.status !== 'paid' && p.status !== 'void' && p.balance_cents > 0;
  if (!open) return '';
  const parts = [];
  const feeNote = pay.fee_cents > 0 ? `<small class="ip-fee">${esc(fill(t.cardFee, { pct: core.fmtQty(pay.fee_pct) }))}</small>` : '';
  if (pay.card_url) {
    parts.push(`<a class="ip-btn ip-btn-primary" href="${esc(pay.card_url)}" rel="noopener noreferrer" target="_blank" data-pay="card">${esc(t.payCard)} · ${esc(moneyText(pay.card_total_cents, cur))}</a>${feeNote}`);
  }
  if (pay.paypal_url) {
    parts.push(`<a class="ip-btn ${pay.card_url ? 'ip-btn-soft' : 'ip-btn-primary'}" href="${esc(pay.paypal_url)}" rel="noopener noreferrer" target="_blank" data-pay="paypal">${esc(t.payPaypal)} · ${esc(moneyText(pay.card_total_cents, cur))}</a>${pay.card_url ? '' : feeNote}`);
  }
  if (pay.etransfer) {
    parts.push(`<div class="ip-way"><h3>${esc(t.etransfer)} · ${esc(moneyText(p.balance_cents, cur))}</h3>${copyRow(t.etransferTo, pay.etransfer, t)}${copyRow(t.reference, pay.reference, t)}</div>`);
  }
  if (pay.bank) {
    const rows = [].concat(pay.bank.key || [], pay.bank.rest || []).filter((r) => r && (r.k || r.v));
    if (rows.length) {
      parts.push(`<div class="ip-way"><h3>${esc(strip(pay.bank.title) || t.bank)} · ${esc(moneyText(p.balance_cents, cur))}</h3>`
        + rows.map((r) => copyRow(strip(r.k), strip(r.v), t)).join('')
        + copyRow(t.reference, pay.reference, t)
        + (pay.bank.note ? `<p class="ip-small">${esc(strip(pay.bank.note))}</p>` : '') + '</div>');
    }
  }
  if (!parts.length) parts.push(`<p class="ip-small">${esc(t.payNone)}</p>`);
  return `<section class="ip-plate ip-pay" id="pay"><h2>${esc(t.payTitle)}</h2>${parts.join('')}</section>`;
}

function invoicePage(lang, p, { pdfUrl, signupUrl }) {
  const t = T[lang] || T.en;
  const v = p.view;
  const d = v.data || {};
  const seller = d.seller || {};
  const cur = v.currency;
  const title = fill(t.title, { number: v.number });
  const sellerName = v.seller_name || '';
  let state = '';
  if (p.status === 'paid') state = `<p class="ip-state ip-state-paid">${esc(t.paid)}</p>`;
  else if (p.status === 'void') state = `<p class="ip-state ip-state-void">${esc(t.void)}</p>`;
  else if (p.status === 'overdue') state = `<p class="ip-state ip-state-late">${esc(t.overdue)} · ${esc(fill(t.dueOn, { date: dateText(v.due_date, lang) }))}</p>`;
  const open = p.status !== 'paid' && p.status !== 'void' && p.balance_cents > 0;
  const primaryPay = open && (p.pay.card_url || p.pay.paypal_url);

  const body = `<main class="ip-wrap" data-token="${esc(p.token)}">
  <header class="ip-head ip-plate">
    <div class="ip-seller">
      ${v.logo ? `<img class="ip-logo" src="${esc(pdfUrl.replace(/\/pdf$/, '/logo'))}" alt="${esc(sellerName)}">` : ''}
      <div><p class="ip-k">${esc(t.from)}</p><p class="ip-seller-name">${esc(sellerName)}</p></div>
    </div>
    <h1>${esc(title)}</h1>
    <div class="ip-due">
      <p class="ip-k">${esc(t.amountDue)}</p>
      <p class="ip-amount">${esc(core.fmtCents(open ? p.balance_cents : 0))} <span>${esc(String(cur).toUpperCase())}</span></p>
      ${v.due_date ? `<p class="ip-k">${esc(fill(t.dueOn, { date: dateText(v.due_date, lang) }))}</p>` : ''}
    </div>
    ${state}
    <div class="ip-actions">
      ${primaryPay ? `<a class="ip-btn ip-btn-primary" href="#pay">${esc(t.payTitle)}</a>` : ''}
      <a class="ip-btn ip-btn-soft" href="${esc(pdfUrl)}?download=1" data-pdf>${esc(t.pdf)}</a>
    </div>
  </header>
  <div class="ip-grid">
    <section class="ip-plate ip-doc">
      <div class="ip-parties">
        <div><p class="ip-k">${esc(t.from)}</p><p class="ip-strong">${esc(sellerName)}</p><p class="ip-lines">${linesBlock(seller.lines)}</p></div>
        <div><p class="ip-k">${esc(strip(d.client_label) || t.billTo)}</p><p class="ip-strong">${esc(v.client_name)}</p><p class="ip-lines">${linesBlock(String(v.client_details || '').split('\n'))}</p></div>
        <div class="ip-dates"><p><span class="ip-k">${esc(t.issued)}</span> ${esc(dateText(v.issue_date, lang))}</p>${v.due_date ? `<p><span class="ip-k">${esc(t.due)}</span> ${esc(dateText(v.due_date, lang))}</p>` : ''}</div>
      </div>
      ${itemsTable(v, t)}
      ${p.paid_cents > 0 && p.status !== 'paid' ? `<p class="ip-small">${esc(t.paidSoFar)}: ${esc(moneyText(p.paid_cents, cur))}</p>` : ''}
      ${v.terms ? `<p class="ip-small ip-terms">${esc(strip(core.fill(v.terms, { number: v.number })))}</p>` : ''}
      ${v.notes ? `<p class="ip-small">${esc(v.notes)}</p>` : ''}
    </section>
    ${payBlock(p, t)}
  </div>
  <p class="ip-note">${esc(fill(t.note, { seller: sellerName || '—' }))}</p>
  ${footer(t, signupUrl)}
  ${primaryPay ? `<div class="ip-sticky" hidden><span><small>${esc(t.amountDue)}</small><b>${esc(moneyText(p.balance_cents, cur))}</b></span><a class="ip-btn ip-btn-primary" href="#pay">${esc(t.payTitle)}</a></div>` : ''}
</main>`;
  return shell(lang, sellerName ? `${title} · ${sellerName}` : title, body);
}

module.exports = { T, langOf, invoicePage, messagePage };
