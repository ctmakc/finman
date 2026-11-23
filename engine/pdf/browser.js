// engine/pdf/browser.js — entry of public/js/vault/invoice-pdf.js: the invoice PDF made in the
// browser for vault accounts (the same services/invoice/pdf.js as the server, pdfkit's browser
// build, fonts fetched from /vendor/invoice-fonts/ once). Loaded by the engine only when a PDF
// is asked for (engine/shims/invoicePdf.js).
import { Buffer } from 'buffer';
const pdf = require('../../services/invoice/pdf');

let fontsReady = null;
function loadFonts(base) {
  if (!fontsReady) {
    fontsReady = Promise.all(Object.values(pdf.FONT_FILES).map((f) => fetch(base + f, { credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error('font ' + f + ' ' + r.status); return r.arrayBuffer(); })
      .then((b) => [f, Buffer.from(b)])))
      .then((pairs) => { globalThis.__FM_INVOICE_FONTS = Object.fromEntries(pairs); })
      .catch((e) => { fontsReady = null; throw e; });
  }
  return fontsReady;
}

async function renderInvoicePdf(view, footer) {
  await loadFonts('/vendor/invoice-fonts/');
  const out = await pdf.renderInvoicePdf(view, footer);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

globalThis.FMInvoicePdf = { renderInvoicePdf };
