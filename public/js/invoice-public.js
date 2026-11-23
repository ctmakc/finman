// invoice-public.js — the client's invoice page (/i/<token>): view beacon, copy buttons,
// the sticky pay bar on phones (shown once the first screen is scrolled past, hidden on the pay block).
(function () {
  'use strict';
  var main = document.querySelector('[data-token]');
  if (!main) return;
  var token = main.getAttribute('data-token');

  // The issuer opening their own link from Finman adds #own: not a client view.
  function beacon() {
    if (location.hash === '#own') return;
    try {
      var url = '/i/' + encodeURIComponent(token) + '/seen';
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' }));
      else fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { /* the page works without it */ }
  }
  if (document.visibilityState === 'visible') setTimeout(beacon, 800);
  else document.addEventListener('visibilitychange', function once() {
    if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', once); setTimeout(beacon, 800); }
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var v = b.parentNode.querySelector('[data-copy-src]');
    var text = v ? v.textContent : '';
    var done = function () { var t = b.textContent; b.textContent = b.getAttribute('data-copied') || 'Copied'; setTimeout(function () { b.textContent = t; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else { var r = document.createRange(); r.selectNodeContents(v); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (x) { /* ignore */ } }
  });

  var bar = document.querySelector('.ip-sticky');
  var pay = document.getElementById('pay');
  if (bar && pay && 'IntersectionObserver' in window) {
    bar.hidden = false;
    var pastFirst = false, payVisible = false;
    var paint = function () { bar.classList.toggle('is-off', !pastFirst || payVisible); };
    paint();
    window.addEventListener('scroll', function () { pastFirst = window.scrollY > window.innerHeight * 0.6; paint(); }, { passive: true });
    new IntersectionObserver(function (es) { payVisible = es[0].isIntersecting; paint(); }, { threshold: 0.15 }).observe(pay);
  }
})();
