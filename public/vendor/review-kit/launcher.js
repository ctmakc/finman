/*!
 * MMIX Review Kit launcher (~3 KB). Include on every page:
 *   <script type="module" src="/review-kit/launcher.js"></script>
 * - <mmix-review-entry></mmix-review-entry> renders the entry card (animated demo of the mode;
 *   texts: title-text, sub-text, go-text); clicking it starts comment mode. It fires `mmixreview:entry` first, so a host dialog can close.
 * - Starts the kit by itself when a comment session is active in this browser, or when the URL
 *   opens a sent review (?review=<id>&t=<token>).
 * - window.mmixReviewStart() starts the mode from any other button.
 * The kit itself (review.js) is downloaded only in those cases.
 * Card texts in EN / FR / UK / RU (window.MMIX_REVIEW_LANG, window.PLAST_LANG or <html lang>); card colours
 * and fonts follow the --rv-* custom properties when the page sets them. Canonical copy: ctmakc/mmix-review-worker kit/.
 * Unsent comments of a session that was not closed (reload, crash, closed tab) bring the kit back by themselves.
 *
 * Dictation (1.2, dictate.js): <mmix-review-voice></mmix-review-voice> is one big "Dictate changes" button
 * (speech-lang="uk-UA" sets the recognition language; title-text / sub-text override the texts);
 * window.mmixReviewDictate() opens the same panel; a link with #dictate (or ?dictate=1) opens it on arrival.
 * A dictation that was recording continues by itself on the next page of the walk.
 */
const LANG = (() => { const l = String(window.MMIX_REVIEW_LANG || window.PLAST_LANG || document.documentElement.lang || 'en').slice(0, 2).toLowerCase(); return l === 'ua' ? 'uk' : (['en', 'fr', 'uk', 'ru'].includes(l) ? l : 'en'); })();
const TT = {
  en: { title: 'Comment right on the page', sub: 'Click any element or drag over an area and leave a note. Works across pages; send everything at the end.', go: 'Start commenting →',
    vTitle: 'Dictate your changes', vSub: 'Press, scroll the site and say what to change. The text writes and saves itself.' },
  fr: { title: 'Commentez directement sur la page', sub: 'Cliquez sur un élément ou encadrez une zone, puis laissez une note. Fonctionne sur plusieurs pages\u00a0; envoyez tout à la fin.', go: 'Commencer à commenter →',
    vTitle: 'Dictez vos corrections', vSub: 'Appuyez, faites défiler le site et dites quoi changer. Le texte s’écrit et s’enregistre tout seul.' },
  uk: { title: 'Коментуйте просто на сторінці', sub: 'Натисніть на будь-який елемент або обведіть ділянку і залиште нотатку. Працює на всіх сторінках; усе надсилаєте в кінці.', go: 'Почати коментувати →',
    vTitle: 'Надиктувати правки', vSub: 'Натисніть, гортайте сайт і кажіть, що змінити. Текст пишеться й зберігається сам.' },
  ru: { title: 'Комментируйте прямо на странице', sub: 'Кликните на любой элемент или обведите область и оставьте заметку. Работает на всех страницах; всё отправляете в конце.', go: 'Начать комментировать →',
    vTitle: 'Надиктовать правки', vSub: 'Нажмите, листайте сайт и говорите, что поменять. Текст пишется и сохраняется сам.' },
};
const T = TT[LANG];
const SRC = new URL('./review.js?v=1.2.0', import.meta.url).href;
const DSRC = new URL('./dictate.js?v=1.2.0', import.meta.url).href;
let kitP = null, dictP = null;
const kit = () => (kitP ||= import(SRC));
const start = (o = {}) => kit().then((m) => m.start(o));
window.mmixReviewStart = () => start({ picking: true });
const SPEECH_LANG = () => window.MMIX_REVIEW_SPEECH_LANG || document.querySelector('mmix-review-voice[speech-lang]')?.getAttribute('speech-lang') || '';
const dictate = (o = {}) => (dictP ||= import(DSRC)).then((m) => m.start({ lang: SPEECH_LANG(), ...o }));
window.mmixReviewDictate = (o) => dictate(o || {});
try {
  const d = JSON.parse(localStorage.getItem('mmixdict:v1') || 'null');
  const q = new URLSearchParams(location.search);
  if (d?.active) dictate({ resume: true });
  else if (/^#dictate\b/.test(location.hash) || q.has('dictate')) {
    dictate({});
    if (/^#dictate/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }
  addEventListener('hashchange', () => { if (/^#dictate\b/.test(location.hash)) { dictate({}); history.replaceState(null, '', location.pathname + location.search); } });
} catch {}

try {
  const q = new URLSearchParams(location.search);
  const s = JSON.parse(localStorage.getItem('mmixrv:v1') || 'null');
  if ((q.get('review') && q.get('t') && !/^[01]$/.test(q.get('review'))) || s?.active) start({});
} catch {}

const CSS = `
:host { display: block; }
button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 136px 1fr; gap: 14px; align-items: center; width: 100%;
  padding: 12px; border-radius: var(--rv-radius, 10px); background: var(--rv-bg, #15171A); color: var(--rv-fg, #F3F4F1); cursor: pointer; font: 15px/1.35 var(--rv-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif); }
button:hover { background: var(--rv-bg-hover, #202428); }
button:focus-visible { outline: 3px solid var(--rv-focus, #0A84FF); outline-offset: 2px; }
.t { display: block; font-weight: 700; font-size: var(--rv-title-size, 16px); margin-bottom: 3px; font-family: var(--rv-title-font, inherit); text-transform: var(--rv-title-case, none); letter-spacing: var(--rv-title-track, normal); line-height: 1.15; }
.s { display: block; color: var(--rv-fg-2, #C9CCC9); font-size: 13px; }
.go { display: inline-block; margin-top: 6px; color: var(--rv-accent, #FFD60A); font-weight: 700; font-size: 13px; }
svg { width: 136px; height: 102px; display: block; border-radius: 6px; background: var(--rv-paper, #F3F4F1); }
.cur { animation: cur 4.2s cubic-bezier(.65,0,.35,1) infinite; transform-origin: 0 0; }
.sel { stroke-dasharray: 4 3; animation: sel 4.2s linear infinite; }
.mk, .bub { animation: pop 4.2s cubic-bezier(.16,1,.3,1) infinite; transform-box: fill-box; transform-origin: center; }
.bub { animation-name: bub; transform-origin: left center; }
@keyframes cur { 0% { transform: translate(92px, 70px); } 30%, 38% { transform: translate(40px, 32px); } 40% { transform: translate(40px, 32px) scale(.85); } 44%, 100% { transform: translate(40px, 32px); } }
@keyframes sel { 0%, 39% { opacity: 0; } 42%, 92% { opacity: 1; } 100% { opacity: 0; } }
@keyframes pop { 0%, 42% { opacity: 0; transform: scale(.3); } 50%, 92% { opacity: 1; transform: scale(1); } 100% { opacity: 0; } }
@keyframes bub { 0%, 52% { opacity: 0; transform: scaleX(.2); } 60%, 92% { opacity: 1; transform: scaleX(1); } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .cur { animation: none; transform: translate(40px, 32px); } .sel, .mk, .bub { animation: none; opacity: 1; transform: none; }
}
@media (max-width: 480px) { button { grid-template-columns: 1fr; } svg { width: 100%; height: auto; aspect-ratio: 112 / 84; max-height: 150px; } }
`;
const SVG = `<svg viewBox="0 0 112 84" aria-hidden="true">
  <rect x="8" y="8" width="96" height="8" rx="2" fill="#D6D9D5"/>
  <rect x="8" y="22" width="44" height="30" rx="2" fill="#C5CAC5"/>
  <rect x="58" y="24" width="46" height="5" rx="2" fill="#D6D9D5"/><rect x="58" y="33" width="38" height="5" rx="2" fill="#D6D9D5"/><rect x="58" y="42" width="30" height="5" rx="2" fill="#D6D9D5"/>
  <rect x="8" y="58" width="96" height="6" rx="2" fill="#D6D9D5"/><rect x="8" y="68" width="70" height="6" rx="2" fill="#D6D9D5"/>
  <rect class="sel" x="5" y="19" width="50" height="36" rx="2" fill="#FFD60A22" stroke="#15171A" stroke-width="1.5"/>
  <g class="bub"><rect x="60" y="10" width="46" height="16" rx="4" fill="#15171A"/><rect x="65" y="15" width="30" height="2.5" rx="1" fill="#F3F4F1"/><rect x="65" y="20" width="22" height="2.5" rx="1" fill="#9EA39E"/></g>
  <g class="mk"><circle cx="54" cy="19" r="7" fill="#FFD60A" stroke="#15171A" stroke-width="1.5"/><text x="54" y="22.3" text-anchor="middle" font-size="9" font-weight="700" font-family="system-ui, sans-serif" fill="#15171A">1</text></g>
  <path class="cur" d="M0 0 L0 13 L3.6 9.6 L6.2 15 L8.4 14 L5.9 8.7 L10.6 8.4 Z" fill="#15171A" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>
</svg>`;

class Entry extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const r = this.attachShadow({ mode: 'open' });
    const title = this.getAttribute('title-text') || T.title;
    const sub = this.getAttribute('sub-text') || T.sub;
    r.innerHTML = `<style>${CSS}</style><button type="button">${SVG}<span><span class="t"></span><span class="s"></span><span class="go"></span></span></button>`;
    r.querySelector('.t').textContent = title;
    r.querySelector('.s').textContent = sub;
    r.querySelector('.go').textContent = this.getAttribute('go-text') || T.go;
    r.querySelector('button').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('mmixreview:entry', { bubbles: true, composed: true }));
      start({ picking: true });
    });
  }
}
if (!customElements.get('mmix-review-entry')) customElements.define('mmix-review-entry', Entry);

// ───────── «Надиктовать правки»: one big button (the texts follow speech-lang when it is set)
const VCSS = `
:host { display: block; }
button { all: unset; box-sizing: border-box; display: flex; gap: 16px; align-items: center; width: 100%; min-height: 84px; padding: 14px 16px; border-radius: var(--rv-radius, 14px);
  background: var(--rv-voice-bg, #111214); color: var(--rv-fg, #fff); cursor: pointer; font: 16px/1.35 var(--rv-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif); }
button:hover { background: var(--rv-bg-hover, #202428); }
button:focus-visible { outline: 3px solid var(--rv-focus, #0A84FF); outline-offset: 2px; }
.m { flex: none; width: 60px; height: 60px; border-radius: 50%; background: #FF453A; color: #fff; display: grid; place-items: center; box-shadow: 0 0 0 6px #FF453A2e; }
.m svg { width: 30px; height: 30px; }
.t { display: block; font-weight: 800; font-size: var(--rv-voice-title-size, 19px); line-height: 1.15; margin-bottom: 4px; font-family: var(--rv-title-font, inherit); }
.s { display: block; color: var(--rv-fg-2, #C9CCC9); font-size: 14px; }
`;
class Voice extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const r = this.attachShadow({ mode: 'open' });
    const l = String(this.getAttribute('speech-lang') || window.MMIX_REVIEW_SPEECH_LANG || '').slice(0, 2).toLowerCase();
    const t = TT[l === 'ua' ? 'uk' : l] || T;
    r.innerHTML = `<style>${VCSS}</style><button type="button"><span class="m" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg></span><span><span class="t"></span><span class="s"></span></span></button>`;
    r.querySelector('.t').textContent = this.getAttribute('title-text') || t.vTitle;
    r.querySelector('.s').textContent = this.getAttribute('sub-text') || t.vSub;
    r.querySelector('button').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('mmixreview:entry', { bubbles: true, composed: true }));
      dictate({});
    });
  }
}
if (!customElements.get('mmix-review-voice')) customElements.define('mmix-review-voice', Voice);

// ───────── the site's own bug-report form: its text survives a reload or a crash too
// Applies to a <textarea> inside the bug dialog (the element holding <mmix-review-entry>, or any
// element marked data-mmix-bug). Typed text goes to localStorage within 400 ms; an empty field gets
// it back when the dialog opens again or the field is focused. The draft is dropped when the form
// was sent (submit, then the site clears or removes the field) or the site resets the field itself.
const BUG = 'mmixbug:draft';
const BOX = '[data-mmix-bug], dialog, [role="dialog"], [aria-modal="true"]';
const bugBox = (t) => {
  if (!(t instanceof HTMLTextAreaElement)) return null;
  const c = t.closest(BOX) || t.form?.parentElement;
  return c && (c.hasAttribute('data-mmix-bug') || c.querySelector('mmix-review-entry')) ? c : null;
};
let bugDraft = null;
try { bugDraft = JSON.parse(localStorage.getItem(BUG) || 'null'); } catch {}
const bugPut = (v) => { bugDraft = v; try { v ? localStorage.setItem(BUG, JSON.stringify(v)) : localStorage.removeItem(BUG); } catch {} };
let bugT = 0, bugField = null, armed = 0;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!e.isTrusted || !bugBox(t)) return;
  bugField = t;
  clearTimeout(bugT);
  bugT = setTimeout(() => bugPut(t.value.trim() ? { text: t.value, page: location.pathname, at: Date.now() } : null), 400);
}, true);
const bugFill = (t) => {
  if (!bugDraft || t.value || !bugBox(t)) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, bugDraft.text); // React-safe
  t.dispatchEvent(new Event('input', { bubbles: true }));
  bugField = t;
};
document.addEventListener('focusin', (e) => { if (e.target instanceof HTMLTextAreaElement) bugFill(e.target); }, true);
const sent = (e) => { const c = e.target.closest?.(BOX) || e.target; if (c.querySelector?.('textarea') && bugBox(c.querySelector('textarea'))) armed = Date.now(); };
document.addEventListener('submit', sent, true);
document.addEventListener('click', (e) => { if (e.target.closest?.('button[type="submit"], input[type="submit"]')) sent(e); }, true);
let bugRaf = 0;
new MutationObserver(() => {
  if (!bugDraft || bugRaf) return;
  bugRaf = requestAnimationFrame(() => {
    bugRaf = 0;
    document.querySelectorAll('mmix-review-entry').forEach((en) => { const t = (en.closest(BOX) || en.parentElement)?.querySelector('textarea'); if (t && t.offsetParent) bugFill(t); });
  });
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'aria-hidden'] });
setInterval(() => {
  const t = bugField;
  if (!bugDraft || !t) return;
  const recent = armed && Date.now() - armed < 30000;
  if (t.isConnected ? !t.value.trim() : recent) { bugPut(null); bugField = null; armed = 0; } // sent (or reset by the site)
}, 1000);
