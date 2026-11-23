// pdf-drop.js — /p/<id>#<key>: fetch the encrypted invoice PDF, decrypt it here (AES-256-GCM,
// services/mcp/pdfDrop.js format), offer the file. The key never leaves this browser.
(function () {
  'use strict';
  var main = document.querySelector('[data-drop]');
  var title = document.getElementById('pd-title');
  var text = document.getElementById('pd-text');
  var dl = document.getElementById('pd-dl');
  function fail(t, d) { title.textContent = t; text.textContent = d; }
  function b64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s); var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var key = (location.hash || '').slice(1);
  if (!main || !/^[A-Za-z0-9_-]{40,50}$/.test(key)) { fail('This link is incomplete', 'Copy the whole link from the chat, including the part after #.'); return; }
  fetch('/p/' + main.getAttribute('data-drop') + '/blob', { credentials: 'omit' }).then(function (r) {
    if (!r.ok) throw new Error(r.status === 404 ? 'expired' : 'http');
    return r.arrayBuffer();
  }).then(function (buf) {
    var b = new Uint8Array(buf);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'FMP1') throw new Error('format');
    return crypto.subtle.importKey('raw', b64u(key), 'AES-GCM', false, ['decrypt']).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(4, 16), additionalData: b.slice(0, 4) }, k, b.slice(16));
    });
  }).then(function (plain) {
    var p = new Uint8Array(plain);
    var n = (p[0] << 8) | p[1];
    var name = new TextDecoder().decode(p.slice(2, 2 + n)) || 'invoice.pdf';
    var url = URL.createObjectURL(new Blob([p.slice(2 + n)], { type: 'application/pdf' }));
    title.textContent = name;
    text.textContent = 'Ready. The file opened in this browser only.';
    dl.href = url; dl.download = name; dl.hidden = false;
    history.replaceState(null, '', location.pathname); // the key leaves the address bar
  }).catch(function (e) {
    if (e && e.message === 'expired') fail('This link has expired', 'Ask the assistant for the invoice PDF again.');
    else fail('This file could not be opened', 'The link may be cut short. Copy the whole link from the chat.');
  });
})();
