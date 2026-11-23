// engine/shims/invoicePdf.js — services/invoice/pdf.js inside the vault engine. The PDF code
// (pdfkit + fonts, ~2 MB) is not in engine.js: the first PDF loads /js/vault/invoice-pdf.js.
// In the Node build of the engine (consent MCP on the server) the real module is used.
'use strict';

let loading = null;
function load() {
  if (globalThis.FMInvoicePdf) return Promise.resolve(globalThis.FMInvoicePdf);
  if (typeof document === 'undefined') {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return Promise.resolve(globalThis.__FM_NODE_INVOICE_PDF || null);
  }
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vault/invoice-pdf.js?v=' + (globalThis.__FM_ENGINE_V || '1');
      s.async = true;
      s.onload = () => (globalThis.FMInvoicePdf ? resolve(globalThis.FMInvoicePdf) : reject(new Error('PDF module did not load')));
      s.onerror = () => { loading = null; reject(new Error('PDF module did not load')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

async function renderInvoicePdf(view, footer) {
  const m = await load();
  if (!m) throw Object.assign(new Error('PDF is made in the Finman app for encrypted accounts'), { status: 409 });
  const out = await m.renderInvoicePdf(view, footer);
  return Buffer.from(out);
}

module.exports = { renderInvoicePdf };
