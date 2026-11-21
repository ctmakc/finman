/*!
 * MMIX Review Kit — «Надиктовать правки» (dictation mode). Loaded lazily by launcher.js.
 *
 * One big button turns the microphone on; the tester scrolls the site and talks. Speech becomes a
 * growing sheet of text in a floating panel; every phrase remembers the page, the scroll position
 * and the nearest section heading. Text and audio go up to review.mmix.biz every few seconds
 * (one session = one server record), so nothing is lost on a dropped connection, a closed tab or a
 * page change: the session comes back by itself on the next page and keeps recording.
 *
 * Recognition: Web Speech API in the browser where it works (Chrome, Edge, Safari), continuous with
 * interim results; where it is missing or fails (Firefox, some iOS, a blocked speech service) the
 * kit records MediaRecorder chunks for our whisper (mmix-review-stt --live) and shows its text as it
 * comes back. Audio is recorded in both modes (in the Web Speech mode it is the safety copy).
 * "Send" turns the session into an ordinary Review Kit packet (same view, same Telegram path).
 *
 * Language: opts.lang / window.MMIX_REVIEW_SPEECH_LANG / <html lang>; the panel speaks the same
 * language and the tester can switch it (uk / ru / en). Canonical copy: ctmakc/mmix-review-worker kit/.
 */
const VERSION = '1.2.0';
const DIRECT = 'https://review.mmix.biz/api/review';
const LS = 'mmixdict:v1';
const SID_COOKIE = 'mmixdict_sid';
const Z = 2147483001;

// ───────────────────────────── language
const SPEECH = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US', fr: 'fr-CA' };
const base = (l) => { const x = String(l || '').slice(0, 2).toLowerCase(); return x === 'ua' ? 'uk' : x; };
const ukN = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const DICT = {
  uk: {
    region: 'Надиктувати правки', title: 'Надиктуйте правки голосом',
    intro: 'Натисніть велику кнопку й говоріть. Гортайте сайт і розповідайте, що змінити: текст з’являтиметься тут і збережеться сам. Можна переходити між сторінками — запис триває.',
    start: 'Почати запис', close: 'Закрити', rec: 'Йде запис', paused: 'Пауза', pause: 'Пауза', resume: 'Продовжити', send: 'Надіслати',
    sending: 'Надсилаємо…', finishing: (s) => `Дописуємо останні слова… ${s} с`, sent: 'Надіслано! Дякуємо.', sentSub: 'Ми все прочитаємо й виправимо. Запис можна закрити.',
    open: 'переглянути', min: 'Згорнути', max: 'Розгорнути', phrases: (n) => `${n} ${ukN(n, 'фраза', 'фрази', 'фраз')}`,
    saved: (t) => `Збережено · ${t}`, saving: 'Зберігаємо…', offline: 'Немає зв’язку. Текст збережено на цьому пристрої, надішлемо сам, щойно з’явиться.',
    listening: 'Слухаю… говоріть', empty: 'Тут з’являтиметься ваш текст.', hint: 'Гортайте сайт і кажіть, що змінити.',
    lang: 'Мова', del: 'Видалити запис', delSure: 'Так, видалити все', resumeTitle: 'Запис на паузі', resumeSub: 'Натисніть, щоб продовжити — текст нікуди не дівся.',
    restored: (n) => `Відновлено: ${n} ${ukN(n, 'фраза', 'фрази', 'фраз')}`, noMic: 'Немає доступу до мікрофона. Дозвольте його в налаштуваннях браузера (значок біля адреси сайту) і натисніть ще раз.',
    notSent: (e) => `Не надіслано (${e}). Усе збережено — спробуйте ще раз.`, retry: 'Ще раз', whisper: 'Розпізнаємо на нашому сервері — текст з’являється із затримкою в кілька секунд.',
    why: { network: 'немає зв’язку', rate: 'забагато запитів, зачекайте хвилину', empty: 'ще нічого не сказано', server: 'помилка сервера', unknown_site: 'сайт не підключено' },
    page: 'Сторінка', names: { uk: 'українська', ru: 'русский', en: 'English', fr: 'français' },
  },
  ru: {
    region: 'Надиктовать правки', title: 'Надиктуйте правки голосом',
    intro: 'Нажмите большую кнопку и говорите. Листайте сайт и рассказывайте, что поменять: текст появится здесь и сохранится сам. Можно переходить между страницами — запись продолжится.',
    start: 'Начать запись', close: 'Закрыть', rec: 'Идёт запись', paused: 'Пауза', pause: 'Пауза', resume: 'Продолжить', send: 'Отправить',
    sending: 'Отправляем…', finishing: (s) => `Дописываем последние слова… ${s} с`, sent: 'Отправлено! Спасибо.', sentSub: 'Мы всё прочитаем и исправим. Запись можно закрыть.',
    open: 'посмотреть', min: 'Свернуть', max: 'Развернуть', phrases: (n) => `${n} ${ukN(n, 'фраза', 'фразы', 'фраз')}`,
    saved: (t) => `Сохранено · ${t}`, saving: 'Сохраняем…', offline: 'Нет связи. Текст сохранён на этом устройстве, отправим сами, как только появится.',
    listening: 'Слушаю… говорите', empty: 'Здесь появится ваш текст.', hint: 'Листайте сайт и говорите, что поменять.',
    lang: 'Язык', del: 'Удалить запись', delSure: 'Да, удалить всё', resumeTitle: 'Запись на паузе', resumeSub: 'Нажмите, чтобы продолжить — текст никуда не делся.',
    restored: (n) => `Восстановлено: ${n} ${ukN(n, 'фраза', 'фразы', 'фраз')}`, noMic: 'Нет доступа к микрофону. Разрешите его в настройках браузера (значок у адреса сайта) и нажмите ещё раз.',
    notSent: (e) => `Не отправлено (${e}). Всё сохранено — попробуйте ещё раз.`, retry: 'Ещё раз', whisper: 'Распознаём на нашем сервере — текст появляется с задержкой в несколько секунд.',
    why: { network: 'нет связи', rate: 'слишком много запросов, подождите минуту', empty: 'пока ничего не сказано', server: 'ошибка сервера', unknown_site: 'сайт не подключён' },
    page: 'Страница', names: { uk: 'українська', ru: 'русский', en: 'English', fr: 'français' },
  },
  en: {
    region: 'Dictate changes', title: 'Dictate your changes',
    intro: 'Press the big button and talk. Scroll the site and say what should change: the text appears here and saves itself. You can move between pages — recording goes on.',
    start: 'Start recording', close: 'Close', rec: 'Recording', paused: 'Paused', pause: 'Pause', resume: 'Resume', send: 'Send',
    sending: 'Sending…', finishing: (s) => `Writing down the last words… ${s} s`, sent: 'Sent! Thank you.', sentSub: 'We will read it all and fix it. You can close this now.',
    open: 'view', min: 'Minimise', max: 'Expand', phrases: (n) => `${n} phrase${n === 1 ? '' : 's'}`,
    saved: (t) => `Saved · ${t}`, saving: 'Saving…', offline: 'No connection. The text is kept on this device and goes up by itself once you are back online.',
    listening: 'Listening… go ahead', empty: 'Your text will appear here.', hint: 'Scroll the site and say what to change.',
    lang: 'Language', del: 'Delete recording', delSure: 'Yes, delete everything', resumeTitle: 'Recording paused', resumeSub: 'Press to go on — your text is still here.',
    restored: (n) => `Restored ${n} phrase${n === 1 ? '' : 's'}`, noMic: 'No access to the microphone. Allow it in the browser settings (the icon next to the address) and press again.',
    notSent: (e) => `Not sent (${e}). Everything is kept — try again.`, retry: 'Retry', whisper: 'Recognised on our server — text appears a few seconds late.',
    why: { network: 'no connection', rate: 'too many requests, wait a minute', empty: 'nothing said yet', server: 'server error', unknown_site: 'this site is not connected' },
    page: 'Page', names: { uk: 'українська', ru: 'русский', en: 'English', fr: 'français' },
  },
  fr: {
    region: 'Dicter des corrections', title: 'Dictez vos corrections',
    intro: 'Appuyez sur le gros bouton et parlez. Faites défiler le site et dites ce qu’il faut changer : le texte s’affiche ici et s’enregistre tout seul. Vous pouvez changer de page — l’enregistrement continue.',
    start: 'Commencer', close: 'Fermer', rec: 'Enregistrement', paused: 'En pause', pause: 'Pause', resume: 'Reprendre', send: 'Envoyer',
    sending: 'Envoi…', finishing: (s) => `Derniers mots… ${s} s`, sent: 'Envoyé ! Merci.', sentSub: 'Nous allons tout lire et corriger. Vous pouvez fermer.',
    open: 'voir', min: 'Réduire', max: 'Agrandir', phrases: (n) => `${n} phrase${n > 1 ? 's' : ''}`,
    saved: (t) => `Enregistré · ${t}`, saving: 'Enregistrement…', offline: 'Pas de connexion. Le texte est gardé sur cet appareil et partira tout seul.',
    listening: 'J’écoute… parlez', empty: 'Votre texte s’affichera ici.', hint: 'Faites défiler le site et dites quoi changer.',
    lang: 'Langue', del: 'Supprimer', delSure: 'Oui, tout supprimer', resumeTitle: 'En pause', resumeSub: 'Appuyez pour continuer — votre texte est là.',
    restored: (n) => `${n} phrase${n > 1 ? 's' : ''} restaurée${n > 1 ? 's' : ''}`, noMic: 'Pas d’accès au micro. Autorisez-le dans le navigateur et appuyez à nouveau.',
    notSent: (e) => `Non envoyé (${e}). Tout est gardé — réessayez.`, retry: 'Réessayer', whisper: 'Reconnu sur notre serveur — le texte arrive avec quelques secondes de retard.',
    why: { network: 'pas de connexion', rate: 'trop de requêtes', empty: 'rien n’a été dit', server: 'erreur du serveur', unknown_site: 'site non connecté' },
    page: 'Page', names: { uk: 'українська', ru: 'русский', en: 'English', fr: 'français' },
  },
};
let T = DICT.en;

// ───────────────────────────── helpers
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (label, cls, on) => { const b = el('button', 'b ' + (cls || ''), label); b.type = 'button'; if (on) b.addEventListener('click', on); return b; };
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sidCookie = () => { try { return (document.cookie.match(/(?:^|;\s*)mmixdict_sid=([a-z0-9]{6,20})/) || [])[1] || ''; } catch { return ''; } };
const setSid = (id) => { try { document.cookie = `${SID_COOKIE}=${id}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`; } catch {} };
const dropSid = () => { try { document.cookie = `${SID_COOKIE}=; path=/; max-age=0`; } catch {} };
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
let saveT = 0;
const writeNow = () => { clearTimeout(saveT); saveT = 0; if (S) try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} };
const save = () => { if (!saveT) saveT = setTimeout(writeNow, 250); };
const device = () => (matchMedia('(pointer: coarse)').matches ? (Math.min(screen.width, screen.height) < 700 ? 'phone' : 'tablet') : 'desktop');

// element → short unique CSS path (same idea as review.js)
const BAD = /^(astro-|is-|js-|has-|active|open|hover|focus|visible|hidden|show|css-|sc-|jsx-|svelte-|_)|[0-9a-f]{6,}|\d{3,}/i;
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
const unique = (q) => { try { return document.querySelectorAll(q).length === 1; } catch { return false; } };
function cssPath(n0) {
  if (n0.id && !/\d{3,}|[:.]/.test(n0.id) && unique('#' + cssEsc(n0.id))) return '#' + cssEsc(n0.id);
  const parts = [];
  for (let n = n0; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    if (n.id && !/\d{3,}/.test(n.id)) { parts.unshift('#' + cssEsc(n.id)); break; }
    let part = n.localName;
    const cls = [...n.classList].filter((c) => !BAD.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.map(cssEsc).join('.');
    const p = n.parentElement;
    if (p && [...p.children].filter((c) => { try { return c.matches(part); } catch { return false; } }).length > 1) part += `:nth-of-type(${[...p.children].filter((c) => c.localName === n.localName).indexOf(n) + 1})`;
    parts.unshift(part);
    if (unique(parts.join(' > '))) break;
  }
  return parts.join(' > ');
}
// the section the tester is looking at: the last heading above the upper third of the screen
function section() {
  const line = innerHeight * 0.38;
  let best = null, firstBelow = null;
  for (const h of document.querySelectorAll('h1, h2, h3, [data-section-title]')) {
    if (host && host.contains(h)) continue;
    const r = h.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.top <= line) best = h; else if (!firstBelow && r.top < innerHeight) firstBelow = h;
  }
  const h = best || firstBelow;
  if (!h) return { sel: '', text: '', tag: '' };
  return { sel: cssPath(h), text: (h.getAttribute('data-section-title') || h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140), tag: h.localName };
}
function ctx() {
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  return { url: location.href, page: location.pathname, title: document.title.slice(0, 120), sec: section(), sy: Math.round(scrollY), sp: Math.round((scrollY / max) * 100),
    vw: innerWidth, vh: innerHeight, dev: device() };
}

// ───────────────────────────── state
// S = { id, active, phase: 'intro'|'rec'|'paused'|'finishing'|'sent', lang, mode: 'web'|'stt', rec, seq, n, segs:[…], marks:[…],
//       since, recMs, recAt, startedAt, tester, min, saveAt, sentView }
let S = null;
let opts = {};
const newSession = (lang) => ({ id: rid(10), active: true, phase: 'intro', lang, mode: 'web', rec: -1, seq: 0, n: 0, segs: [], marks: [], since: 0, recMs: 0, recAt: 0, startedAt: Date.now(), tester: '', min: false, saveAt: 0 });
const hasText = () => (S?.segs || []).some((g) => g.text && !g.del);

// ───────────────────────────── network
let base0 = null; // the endpoint that answered kind:'dict'
const bases = () => [base0, opts.endpoint, DIRECT].filter((u, k, a) => u && a.indexOf(u) === k);
let online = true;
async function call(path, init, check = (j) => j.kind === 'dict') {
  let last = 'network';
  for (const b of bases()) {
    try {
      const r = await fetch(b + path, init);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok && check(j)) { base0 = b; online = true; return j; }
      if (r.ok && j.ok) { last = 'proxy'; continue; } // an older backend of the site's own: go direct
      last = j.error || (r.status >= 500 ? 'server' : String(r.status));
      if (r.status === 429 || r.status === 409) break;
      if (r.status === 400 && j.error && j.error !== 'invalid') break;
    } catch { last = 'network'; }
  }
  if (last === 'network') online = false;
  throw new Error(last);
}
const post = (body) => call('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ website: 'mmix-dict', v: VERSION, site: opts.site, session: S.id, ...body }) });

// text: segments whose local version is newer than what the server confirmed
let syncT = 0, syncBusy = false;
function queueSync(ms = 2500) { if (!syncT) syncT = setTimeout(sync, ms); }
async function sync() {
  syncT = 0;
  if (!S || S.phase === 'sent') return;
  if (syncBusy) { queueSync(1500); return; }
  const segs = S.segs.filter((g) => g.src !== 'stt' && (g.v || 0) > (g.sv || 0)).slice(0, 150);
  const marks = S.marks.filter((m) => !m.ok).slice(0, 150);
  syncBusy = true;
  try {
    const sent = segs.map((g) => [g, g.v]);
    const from = sttFrom;
    const j = await post({ action: 'dict', lang: S.lang, mode: S.mode, tester: S.tester || '', since: S.since, ...(from ? { sttFrom: from } : {}),
      segs: segs.map(({ v, sv, src, ...g }) => g), marks: marks.map(({ ok, ...m }) => m) });
    if (from === sttFrom) sttFrom = null;
    for (const [g, v] of sent) g.sv = v;
    marks.forEach((m) => { m.ok = 1; });
    S.marks = S.marks.filter((m, k, a) => !m.ok || k >= a.length - 3);
    took(j);
    S.saveAt = Date.now(); save();
    if (S.segs.some((g) => g.src !== 'stt' && (g.v || 0) > (g.sv || 0)) || S.marks.some((m) => !m.ok)) queueSync(1500);
  } catch (e) {
    if (e.message !== 'sent') queueSync(online ? 6000 : 10000);
  } finally { syncBusy = false; renderStatus(); }
}
// whisper text and live tails that came back with any answer
let tails = {};
function took(j) {
  if (!j) return;
  let changed = false;
  for (const g of j.stt || []) {
    const mine = S.segs.find((x) => x.id === g.id);
    if (mine) { if (mine.text !== g.text) { mine.text = g.text; changed = true; } }
    else { S.segs.push({ ...g, src: 'stt' }); changed = true; }
    S.since = Math.max(S.since, g.upd || 0);
  }
  if (j.tails && JSON.stringify(j.tails) !== JSON.stringify(tails)) { tails = j.tails; changed = true; }
  if (changed) { S.segs.sort((a, b) => a.at - b.at); save(); renderSheet(); }
}

// audio: chunks queued in IndexedDB until the server has them (a reload or offline does not lose them)
let idbP = null;
const idb = () => (idbP ||= new Promise((res, rej) => { const r = indexedDB.open('mmixdict', 1); r.onupgradeneeded = () => r.result.createObjectStore('q'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
const idbDo = (mode, fn) => idb().then((db) => new Promise((res, rej) => { const tx = db.transaction('q', mode); const rq = fn(tx.objectStore('q')); tx.oncomplete = () => res(rq?.result); tx.onerror = () => rej(tx.error); }));
const memQ = new Map();
async function qPut(c) { const key = `${c.sid}:${c.rec}:${String(c.seq).padStart(6, '0')}`; memQ.set(key, c); try { await idbDo('readwrite', (st) => st.put(c, key)); memQ.delete(key); } catch {} return key; }
async function qAll() { let out = []; try { const keys = await idbDo('readonly', (st) => st.getAllKeys()); for (const k of keys) out.push([k, await idbDo('readonly', (st) => st.get(k))]); } catch {} return [...out, ...memQ.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
async function qDel(key) { memQ.delete(key); try { await idbDo('readwrite', (st) => st.delete(key)); } catch {} }
let upBusy = false, upT = 0;
async function upload() {
  clearTimeout(upT); upT = 0;
  if (upBusy || !S) return;
  upBusy = true;
  try {
    for (const [key, c] of await qAll()) {
      if (!c || c.sid !== S.id) { await qDel(key); continue; } // a finished session's leftovers
      const qs = chunkQs(c);
      try {
        const j = await call('?' + qs, { method: 'POST', headers: { 'content-type': c.mime || 'audio/webm' }, body: c.blob }, (x) => x.kind === 'dict' && x.chunk?.size === c.blob.size);
        await qDel(key); took(j); S.saveAt = Date.now();
      } catch (e) {
        if (['sent', 'too_large', 'invalid'].includes(e.message)) { await qDel(key); continue; }
        upT = setTimeout(upload, online ? 5000 : 10000); break;
      }
    }
  } finally { upBusy = false; renderStatus(); }
}

// ───────────────────────────── microphone, recorder, speech
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let stream = null, mr = null, cutT = 0, actx = null, analyser = null; // mr = { m: MediaRecorder, rec, seq, buf, bufAt, done }
let sr = null, srOn = false, srStarts = [], ctxOf = {}, interim = '', lastHeard = 0, voiceMs = 0, lastResult = 0;
const MIME = () => ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
const cadence = () => (S.mode === 'stt' ? 5000 : 10000);

async function micOn() {
  if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return true;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { stream = null; return e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'none'; }
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser(); analyser.fftSize = 512;
    actx.createMediaStreamSource(stream).connect(analyser);
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  } catch { analyser = null; }
  return true;
}
function recStart() {
  if (!stream || !window.MediaRecorder) return;
  const mime = MIME();
  let m;
  try { m = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); } catch { mr = null; return; }
  S.rec += 1; S.seq = 0; S.recAt = Date.now(); save();
  const R = { m, rec: S.rec, seq: 0, buf: [], bufAt: Date.now(), startAt: Date.now(), mode: S.mode, done: false };
  R.closed = new Promise((res) => { R.close = res; }); // resolves when the last chunk of this recording is queued
  mr = R;
  m.ondataavailable = (e) => { if (e.data?.size) R.buf.push(e.data); if (R.stopping && m.state === 'inactive') cut(R, true); };
  m.onstop = () => cut(R, true);
  m.start(1000);
  clearInterval(cutT); cutT = setInterval(() => { if (mr === R && Date.now() - R.bufAt >= cadence()) cut(R, false); }, 1000);
}
// buffered recorder data → one chunk (the first one of a recording carries the container header)
function cut(R, end) {
  if (!S || !R || R.done || (!R.buf.length && !end)) return;
  if (end) R.done = true;
  const blob = new Blob(R.buf, { type: (R.m.mimeType || MIME() || 'audio/webm').split(';')[0] });
  const c = { sid: S.id, rec: R.rec, seq: R.seq, at: R.bufAt, dur: (Date.now() - R.bufAt) / 1000, mime: blob.type, mode: R.mode, end: !!end, blob };
  R.buf = []; R.bufAt = Date.now();
  if (!blob.size && !end) return;
  if (!blob.size) { if (!c.seq) { R.close?.(); return; } c.blob = new Blob([new Uint8Array(1)], { type: blob.type }); } // an empty closing marker
  R.seq += 1; if (R.rec === S.rec) S.seq = R.seq; save();
  qPut(c).then(() => { if (end) R.close?.(); upload(); });
  return c;
}
const chunkQs = (c) => { const q = new URLSearchParams({ dict: 'chunk', site: opts.site, session: c.sid, rec: c.rec, seq: c.seq, at: c.at, dur: c.dur.toFixed(2), mode: c.mode, lang: S.lang, since: S.since }); if (c.end) q.set('end', '1'); return q; };
function recStop() {
  clearInterval(cutT); cutT = 0;
  const R = mr; mr = null;
  if (!R) return Promise.resolve();
  if (R.m.state !== 'inactive') { R.stopping = true; try { R.m.requestData(); } catch {} try { R.m.stop(); } catch { cut(R, true); } }
  else cut(R, true);
  if (S?.recAt) { S.recMs += Date.now() - S.recAt; S.recAt = 0; }
  return R.closed;
}
function micOff() {
  const closed = recStop(); srStop();
  // the tracks stop after the recorder has handed over its last data
  const s0 = stream; stream = null; analyser = null;
  closed.finally(() => s0?.getTracks().forEach((t) => t.stop()));
  setTimeout(() => s0?.getTracks().forEach((t) => t.stop()), 3000);
  return closed;
}

function srStart() {
  if (!SR || S.mode !== 'web') return;
  if (!sr) {
    sr = new SR();
    sr.continuous = !/Android/i.test(navigator.userAgent); // Android repeats results in continuous mode
    sr.interimResults = true; sr.maxAlternatives = 1;
    sr.onresult = (e) => {
      lastResult = Date.now(); voiceMs = 0;
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], t = (r[0]?.transcript || '').trim();
        if (!ctxOf[i]) ctxOf[i] = { ...ctx(), at: Date.now() };
        if (r.isFinal) { if (t) addSeg(t, ctxOf[i]); delete ctxOf[i]; if (mr) mr.lastFinal = Date.now(); } else live += (live ? ' ' : '') + t;
      }
      interim = live; renderSheet();
    };
    sr.onerror = (e) => {
      const err = e.error;
      if (err === 'no-speech' || err === 'aborted') return;
      if (err === 'not-allowed' && !stream) { srOn = false; pauseRec(); toast(T.noMic, 9000); return; }
      // the speech service is not there (Firefox-like builds, blocked network, unsupported language): our whisper takes over
      if (['network', 'service-not-allowed', 'not-allowed', 'language-not-supported', 'bad-grammar', 'audio-capture'].includes(err)) toWhisper();
    };
    sr.onend = () => {
      flushInterim();
      if (!srOn || S?.phase !== 'rec' || S.mode !== 'web') return;
      srStarts = [...srStarts.filter((t) => Date.now() - t < 10000), Date.now()];
      if (srStarts.length > 6 && Date.now() - lastResult > 10000) { toWhisper(); return; } // ends at once, again and again
      setTimeout(() => { try { srOn && S?.phase === 'rec' && S.mode === 'web' && sr.start(); } catch {} }, srStarts.length > 3 ? 600 : 50);
    };
  }
  sr.lang = SPEECH[S.lang] || S.lang;
  srOn = true; ctxOf = {};
  try { sr.start(); } catch {}
}
function srStop() { srOn = false; if (sr) { try { sr.stop(); } catch {} } }
function flushInterim() { if (interim.trim()) { addSeg(interim.trim(), ctxOf[Object.keys(ctxOf)[0]] || { ...ctx(), at: Date.now() }, true); } interim = ''; ctxOf = {}; renderSheet(); }
// The speech service is gone or deaf: our whisper takes over the SAME recording from the moment of the
// last phrase the browser did recognise (nothing said in between is lost), and every chunk after it.
let sttFrom = null;
function toWhisper() {
  if (S.mode === 'stt') return;
  srStop(); interim = ''; ctxOf = {};
  S.mode = 'stt';
  setTimeout(() => toast(T.whisper, 6000), 50);
  if (mr) {
    mr.mode = 'stt';
    sttFrom = { rec: mr.rec, off: mr.lastFinal ? Math.max(0, (mr.lastFinal - mr.startAt) / 1000 - 0.3) : 0 };
  }
  save(); renderAll(); queueSync(200);
}
function addSeg(text, c, partial) {
  const g = { id: `c${Math.max(0, S.rec)}-${++S.n}`, rec: Math.max(0, S.rec), src: 'web', text, ...c, at: c.at || Date.now(), v: 1, ...(partial ? { partial: 1 } : {}) };
  S.segs.push(g); save(); queueSync(1200); renderSheet();
}

// voice activity (level meter, and the hint that Web Speech hears nothing although the mic does)
let meterRaf = 0;
function meter() {
  cancelAnimationFrame(meterRaf);
  const bars = ui?.querySelectorAll('.lvl i');
  const data = analyser ? new Uint8Array(analyser.fftSize) : null;
  let prev = performance.now();
  const step = (t) => {
    meterRaf = requestAnimationFrame(step);
    const dt = t - prev; prev = t;
    if (!analyser || S?.phase !== 'rec') { bars?.forEach((b) => { b.style.transform = 'scaleY(.15)'; }); return; }
    analyser.getByteTimeDomainData(data);
    let sum = 0; for (const v of data) sum += (v - 128) ** 2;
    const lvl = Math.min(1, Math.sqrt(sum / data.length) / 28);
    if (bars?.length && bars[0].isConnected) bars.forEach((b, k) => { b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, lvl * (1.4 - Math.abs(k - 2) * 0.25)))})`; });
    if (lvl > 0.18) { voiceMs += dt; lastHeard = Date.now(); }
    // talking for a while, the speech service says nothing: switch to whisper rather than lose words
    if (S.mode === 'web' && voiceMs > 4000 && Date.now() - lastResult > 8000 && Date.now() - recBegan > 8000) toWhisper();
  };
  meterRaf = requestAnimationFrame(step);
}
let recBegan = 0;

// ───────────────────────────── phases
let ticker = 0, pageWatch = 0, lastMark = '';
async function startRec(gesture) {
  if (!S) return;
  const ok = await micOn();
  if (ok !== true) { S.phase = hasText() || S.rec >= 0 ? 'paused' : 'intro'; save(); renderAll(); if (gesture || ok === 'denied') toast(T.noMic, 9000); return false; }
  if (!SR) S.mode = 'stt';
  S.phase = 'rec'; save();
  recBegan = Date.now(); voiceMs = 0; lastResult = Date.now();
  recStart(); srStart(); mark(true);
  renderAll(); meter();
  clearInterval(ticker); ticker = setInterval(() => { renderClock(); mark(false); if (S.mode === 'stt' && Date.now() - (S.saveAt || 0) > 6000 && !upBusy) poll(); }, 1000);
  queueSync(300);
  return true;
}
function pauseRec() {
  if (!S) return;
  flushInterim(); micOff();
  S.phase = 'paused'; save(); renderAll(); queueSync(200);
}
// page / section changes become marks (whisper text gets its page and section from them)
function mark(force) {
  if (!S || S.phase !== 'rec') return;
  const c = ctx();
  const key = c.page + '|' + c.sec.sel;
  if (!force && key === lastMark) return;
  const pageChanged = lastMark && lastMark.split('|')[0] !== c.page;
  lastMark = key;
  S.marks.push({ at: Date.now(), ...c }); save(); queueSync(pageChanged ? 300 : 2500);
  if (pageChanged) renderSheet();
}
let pollBusy = false;
async function poll() {
  if (pollBusy || !S) return;
  pollBusy = true;
  try { took(await call(`?dict=${S.id}&site=${encodeURIComponent(opts.site)}&since=${S.since}`, { cache: 'no-store' }, (j) => j.kind === 'dict')); S.saveAt = Date.now(); } catch {}
  finally { pollBusy = false; renderStatus(); }
}

// Send: stop, let the last audio and text land, wait (≤ 60 s) for whisper to finish, make the packet.
let sending = false;
async function send() {
  if (sending || !S) return;
  sending = true;
  const wasRec = S.phase === 'rec';
  flushInterim();
  const closed = micOff();
  S.phase = 'finishing'; save(); renderAll();
  try {
    // the recorder's last chunk is queued, the speech service's last result is in
    await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))]);
    await new Promise((r) => setTimeout(r, wasRec ? 500 : 50));
    flushInterim();
    for (let k = 0; k < 20 && ((await qAll()).some(([, c]) => c?.sid === S.id)); k++) { await upload(); if ((await qAll()).some(([, c]) => c?.sid === S.id)) await new Promise((r) => setTimeout(r, 1500)); }
    clearTimeout(syncT); syncT = 0; await sync();
    if (S.segs.some((g) => g.src !== 'stt' && (g.v || 0) > (g.sv || 0))) throw new Error(online ? 'server' : 'network');
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const j = await call(`?dict=${S.id}&site=${encodeURIComponent(opts.site)}&since=${S.since}`, { cache: 'no-store' }, (x) => x.kind === 'dict');
      took(j);
      const waiting = (j.chunks || []).some((c) => c.stt === 1) || Object.keys(j.tails || {}).length;
      if (!waiting) break;
      setFinishing(Math.round((Date.now() - t0) / 1000));
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!hasText() && !Object.keys(tails).length) throw new Error('empty');
    const j = await call('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dict-send', website: 'mmix-dict', v: VERSION, site: opts.site, session: S.id, tester: S.tester || '' }) }, (x) => !!x.id && x.id !== 'ignored' && !!x.viewToken);
    const view = new URL(j.view || location.href); if (!j.view) { view.search = ''; view.searchParams.set('review', j.id); view.searchParams.set('t', j.viewToken); }
    S.phase = 'sent'; S.active = false; S.sentView = view.href; writeNow(); dropSid();
    try { localStorage.removeItem(LS); } catch {}
    window.dispatchEvent(new CustomEvent('mmixreview:sent', { detail: { id: j.id, voice: true, n: S.segs.length } }));
  } catch (e) {
    S.phase = 'paused'; save();
    toast(T.notSent(T.why[e.message] || e.message), 15000, { label: T.retry, run: send });
  } finally { sending = false; renderAll(); }
}
async function drop() {
  const id = S?.id;
  micOff();
  for (const [key, c] of await qAll()) if (c?.sid === id) await qDel(key);
  try { localStorage.removeItem(LS); } catch {}
  dropSid();
  if (id) call('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dict-drop', website: 'mmix-dict', site: opts.site, session: id }) }).catch(() => {});
  S = null; close();
}
function close() {
  clearInterval(ticker); clearInterval(pageWatch); cancelAnimationFrame(meterRaf);
  if (S && S.phase !== 'sent') { if (S.phase === 'rec') pauseRec(); S.active = hasText(); writeNow(); if (!S.active) { try { localStorage.removeItem(LS); } catch {} } }
  host?.remove(); host = null; ui = null; S = S?.phase === 'sent' ? null : S;
}

// ───────────────────────────── tab hidden / closed: nothing may be lost
function flushOut() {
  if (!S || S.phase === 'sent') return;
  flushInterim();
  // the audio since the last chunk: into IndexedDB (uploaded on the next page) and, when small, out right now
  const c = mr && mr.buf.length ? cut(mr, false) : null;
  if (c && c.blob.size < 48000) try { fetch(`${bases()[0]}?${chunkQs(c)}`, { method: 'POST', headers: { 'content-type': c.mime || 'audio/webm' }, body: c.blob, keepalive: true }).catch(() => {}); } catch {}
  if (S.recAt) { S.recMs += Date.now() - S.recAt; S.recAt = Date.now(); }
  writeNow();
  const segs = S.segs.filter((g) => g.src !== 'stt' && (g.v || 0) > (g.sv || 0));
  const marks = S.marks.filter((m) => !m.ok);
  if (!segs.length && !marks.length) return;
  const body = JSON.stringify({ action: 'dict', website: 'mmix-dict', v: VERSION, site: opts.site, session: S.id, lang: S.lang, mode: S.mode, tester: S.tester || '',
    segs: segs.map(({ v, sv, src, ...g }) => g), marks: marks.map(({ ok, ...m }) => m) });
  if (body.length < 60000) try { fetch(bases()[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).then((r) => r.json()).then((j) => { if (j?.kind === 'dict') { segs.forEach((g) => { g.sv = g.v; }); marks.forEach((m) => { m.ok = 1; }); writeNow(); } }).catch(() => {}); } catch {}
}

// ───────────────────────────── UI (one shadow root, the site's CSS never reaches it)
let host = null, root = null, ui = null;
const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.dk { position: fixed; right: 16px; bottom: 16px; width: min(420px, calc(100vw - 32px)); background: #111214; color: #fff; border-radius: 18px; box-shadow: 0 18px 50px #000b, 0 0 0 1px #ffffff14;
  display: flex; flex-direction: column; max-height: calc(100vh - 32px); pointer-events: auto; overflow: hidden; }
header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 8px 18px; }
.dot { width: 14px; height: 14px; border-radius: 50%; background: #6b6e73; flex: none; }
.dk.rec .dot { background: #FF453A; box-shadow: 0 0 0 0 #FF453A88; animation: pulse 1.6s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 #FF453A99; } 70% { box-shadow: 0 0 0 12px #FF453A00; } 100% { box-shadow: 0 0 0 0 #FF453A00; } }
.st { font: 700 18px/1.2 inherit; font-family: inherit; }
.tm { font: 600 17px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #c9cbcf; font-variant-numeric: tabular-nums; }
.lvl { display: inline-flex; gap: 3px; align-items: center; height: 22px; margin-left: 2px; }
.lvl i { display: block; width: 4px; height: 22px; border-radius: 2px; background: #FFD60A; transform: scaleY(.15); transition: transform 80ms linear; }
.dk:not(.rec) .lvl { display: none; }
.sp { flex: 1; }
button.b { appearance: none; border: 1px solid #3a3c40; background: #1e1f22; color: #fff; font: 700 16px/1.1 inherit; font-family: inherit; min-height: 48px; padding: 0 16px; border-radius: 12px; cursor: pointer; }
button.b:hover { background: #2a2b2f; }
button.b:focus-visible { outline: 3px solid #0A84FF; outline-offset: 2px; }
button.b:disabled { opacity: .55; cursor: default; }
button.b.pri { background: #FFD60A; border-color: #FFD60A; color: #111; }
button.b.pri:hover { background: #ffe14d; }
button.b.ghost { background: transparent; border-color: transparent; color: #b9bbbf; font-weight: 600; font-size: 15px; min-height: 40px; padding: 0 10px; }
button.b.icon { min-height: 40px; min-width: 40px; padding: 0; font-size: 22px; line-height: 1; background: transparent; border-color: transparent; color: #c9cbcf; }
.saved { padding: 0 18px 10px; font-size: 14px; color: #8fd19e; display: flex; align-items: center; gap: 6px; }
.saved.wait { color: #c9cbcf; } .saved.off { color: #ffb340; }
.sheet { margin: 0 12px; padding: 12px 14px; background: #1a1b1e; border-radius: 12px; overflow: auto; min-height: 120px; max-height: 38vh; font-size: 18px; line-height: 1.5; overscroll-behavior: contain; }
.sheet p { margin: 0 0 6px; overflow-wrap: anywhere; }
.sheet .int { color: #9a9ca1; font-style: italic; }
.sheet .pg { font: 700 12px/1.3 inherit; font-family: inherit; color: #FFD60A; letter-spacing: .04em; text-transform: uppercase; margin: 10px 0 4px; }
.sheet .pg:first-child { margin-top: 0; }
.sheet .sec { font-size: 13px; color: #8e9196; margin: 2px 0 4px; }
.sheet .empty { color: #8e9196; font-size: 16px; }
.note { padding: 8px 18px 0; font-size: 14px; color: #a7a9ad; line-height: 1.4; }
.acts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; }
.acts button.b { min-height: 58px; font-size: 18px; }
.foot { display: flex; justify-content: space-between; gap: 6px; padding: 0 8px 10px; flex-wrap: wrap; }
.intro { padding: 4px 18px 18px; display: grid; gap: 14px; justify-items: center; text-align: center; }
.intro h2 { margin: 0; font: 800 22px/1.2 inherit; font-family: inherit; }
.intro p { margin: 0; font-size: 16px; line-height: 1.45; color: #d0d2d6; }
.mic { width: 116px; height: 116px; border-radius: 50%; border: 0; background: #FF453A; color: #fff; display: grid; place-items: center; cursor: pointer; box-shadow: 0 10px 30px #ff453a55, 0 0 0 8px #ff453a22; }
.mic:hover { background: #ff5b52; } .mic:focus-visible { outline: 4px solid #0A84FF; outline-offset: 4px; }
.mic svg { width: 52px; height: 52px; }
.intro .lbl { font: 800 20px/1.2 inherit; font-family: inherit; }
.done { padding: 8px 18px 18px; display: grid; gap: 10px; justify-items: center; text-align: center; }
.done .ok { width: 72px; height: 72px; border-radius: 50%; background: #30D158; color: #111; display: grid; place-items: center; font-size: 40px; font-weight: 800; }
.done h2 { margin: 0; font: 800 22px/1.2 inherit; font-family: inherit; } .done p { margin: 0; color: #d0d2d6; font-size: 16px; } .done a { color: #FFD60A; }
.pill { position: fixed; left: 50%; bottom: max(14px, env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; align-items: center; gap: 10px; background: #111214; color: #fff;
  border-radius: 999px; padding: 8px 8px 8px 16px; box-shadow: 0 10px 34px #000b, 0 0 0 1px #ffffff14; pointer-events: auto; font-size: 16px; font-weight: 700; max-width: calc(100vw - 24px); }
.pill .dot { width: 12px; height: 12px; } .pill.rec .dot { background: #FF453A; animation: pulse 1.6s ease-out infinite; }
.pill button.b { min-height: 44px; }
.toast { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); background: #111214; color: #fff; padding: 12px 14px; border-radius: 12px; font: 600 15px/1.35 inherit; font-family: inherit;
  box-shadow: 0 8px 30px #000a; pointer-events: auto; width: max-content; max-width: calc(100vw - 24px); display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.lang { display: inline-flex; gap: 4px; align-items: center; }
.lang button.b { min-height: 36px; padding: 0 10px; font-size: 14px; }
.lang button.b[aria-pressed="true"] { border-color: #FFD60A; color: #FFD60A; background: #FFD60A1f; }
@media (max-width: 640px) {
  .dk { left: 8px; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)); width: auto; border-radius: 18px; }
  header { padding: 10px 10px 4px 16px; }
  .saved { padding-bottom: 6px; font-size: 13px; }
  .sheet { max-height: 22vh; min-height: 84px; font-size: 17px; padding: 10px 12px; }
  .dk .note { display: none; }
  .acts { padding: 10px; gap: 8px; }
  .acts button.b { min-height: 54px; }
  .foot { padding: 0 6px 6px; }
  .lang button.b, .foot button.b.ghost { min-height: 34px; font-size: 13px; }
  .intro p { font-size: 15px; }
}
@media (prefers-reduced-motion: reduce) { .dk.rec .dot, .pill.rec .dot { animation: none; } .lvl i { transition: none; } }
`;
const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';

function mount() {
  if (host) return;
  host = document.createElement('mmix-dictate');
  host.setAttribute('data-nosnippet', '');
  host.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;z-index:${Z};display:block;`;
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS_TEXT}</style><div class="ui"></div>`;
  ui = root.querySelector('.ui');
}
function toast(msg, ms = 4000, action) {
  if (!ui) return;
  ui.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = el('div', 'toast'); t.setAttribute('role', 'status'); t.append(msg);
  if (action) t.append(btn(action.label, 'pri', () => { t.remove(); action.run(); }));
  ui.appendChild(t); setTimeout(() => t.remove(), ms);
}
let panel = null, sheetEl = null, statusEl = null, clockEl = null, stuck = true;
const elapsed = () => (S ? S.recMs + (S.recAt ? Date.now() - S.recAt : 0) : 0);
function langRow() {
  const row = el('div', 'lang');
  row.append(el('span', '', ''));
  const list = [...new Set([S.lang, 'uk', 'ru', 'en'])].filter((l) => DICT[l]);
  for (const l of list) {
    const b = btn(l === 'uk' ? 'UA' : l.toUpperCase(), '', () => setLang(l));
    b.setAttribute('aria-pressed', String(l === S.lang)); b.title = `${T.lang}: ${T.names[l]}`; b.setAttribute('aria-label', `${T.lang}: ${T.names[l]}`);
    row.append(b);
  }
  return row;
}
function setLang(l) {
  if (!S || S.lang === l) return;
  S.lang = l; T = DICT[l] || DICT.en; save();
  if (S.phase === 'rec' && S.mode === 'web') { flushInterim(); srStop(); setTimeout(() => { srOn = true; srStart(); }, 300); }
  queueSync(300); renderAll();
}
function renderAll() {
  if (!S || !ui) return;
  mount();
  ui.querySelectorAll('.dk, .pill').forEach((x) => x.remove());
  sheetEl = statusEl = clockEl = null;
  if (S.min && ['rec', 'paused'].includes(S.phase)) {
    const p = el('div', `pill ${S.phase === 'rec' ? 'rec' : ''}`); p.setAttribute('role', 'region'); p.setAttribute('aria-label', T.region);
    clockEl = el('span', 'tm', fmt(elapsed()));
    p.append(el('span', 'dot'), el('span', '', S.phase === 'rec' ? T.rec : T.paused), clockEl, el('span', '', '· ' + T.phrases(S.segs.filter((g) => g.text).length)),
      btn(T.max, '', () => { S.min = false; save(); renderAll(); }));
    ui.appendChild(p); panel = p; return;
  }
  const d = el('div', `dk ${S.phase === 'rec' ? 'rec' : ''}`); d.setAttribute('role', 'region'); d.setAttribute('aria-label', T.region);
  panel = d;
  const head = el('header');
  if (S.phase === 'intro') {
    head.append(el('span', 'sp'), btn('×', 'icon', () => close()));
    head.lastChild.setAttribute('aria-label', T.close);
    const box = el('div', 'intro');
    const mic = el('button', 'mic'); mic.type = 'button'; mic.innerHTML = MIC_SVG; mic.setAttribute('aria-label', T.start);
    mic.addEventListener('click', () => startRec(true));
    box.append(el('h2', '', T.title), mic, el('div', 'lbl', T.start), el('p', '', T.intro), langRow());
    d.append(head, box); ui.appendChild(d); return;
  }
  if (S.phase === 'sent') {
    head.append(el('span', 'sp'), btn('×', 'icon', () => { S = null; close(); }));
    const box = el('div', 'done');
    const a = el('a', '', T.open); a.href = S.sentView || '#'; a.target = '_blank'; a.rel = 'noopener';
    const p = el('p', '', T.sentSub + ' '); p.append(a);
    box.append(el('div', 'ok', '✓'), el('h2', '', T.sent), p, btn(T.close, 'pri', () => { S = null; close(); }));
    d.append(head, box); ui.appendChild(d); return;
  }
  clockEl = el('span', 'tm', fmt(elapsed()));
  const lvl = el('span', 'lvl'); for (let k = 0; k < 5; k++) lvl.append(el('i'));
  const st = S.phase === 'rec' ? T.rec : S.phase === 'finishing' ? T.sending : T.paused;
  const mn = btn('–', 'icon', () => { S.min = true; save(); renderAll(); }); mn.setAttribute('aria-label', T.min); mn.title = T.min;
  head.append(el('span', 'dot'), el('span', 'st', st), clockEl, lvl, el('span', 'sp'), mn);
  statusEl = el('div', 'saved');
  sheetEl = el('div', 'sheet'); sheetEl.setAttribute('aria-live', 'polite');
  sheetEl.addEventListener('scroll', () => { stuck = sheetEl.scrollTop + sheetEl.clientHeight >= sheetEl.scrollHeight - 30; }, { passive: true });
  d.append(head, statusEl, sheetEl);
  if (S.mode === 'stt' && S.phase !== 'finishing') d.append(el('div', 'note', T.whisper));
  if (S.phase === 'paused' && !hasText()) d.append(el('div', 'note', T.resumeSub));
  const acts = el('div', 'acts');
  if (S.phase === 'finishing') {
    const b1 = btn(T.sending, '', null); b1.disabled = true; b1.className = 'b fin'; b1.style.gridColumn = '1 / -1';
    acts.append(b1);
  } else {
    const p = S.phase === 'rec' ? btn('⏸ ' + T.pause, '', pauseRec) : btn('● ' + T.resume, '', () => startRec(true));
    const s = btn(T.send + ' ✓', 'pri', send); s.disabled = !hasText() && !Object.keys(tails).length && S.phase !== 'rec';
    acts.append(p, s);
  }
  const foot = el('div', 'foot');
  const del = btn(T.del, 'ghost', () => { if (del._sure) drop(); else { del._sure = true; del.textContent = T.delSure; del.style.color = '#FF6961'; setTimeout(() => { if (del.isConnected) { del._sure = false; del.textContent = T.del; del.style.color = ''; } }, 5000); } });
  foot.append(langRow(), del);
  d.append(acts, foot);
  ui.appendChild(d);
  renderSheet(); renderStatus(); meter();
}
function setFinishing(s) { const b = panel?.querySelector('.fin'); if (b) b.textContent = T.finishing(s); }
function renderClock() { if (clockEl) clockEl.textContent = fmt(elapsed()); }
function renderStatus() {
  if (!statusEl || !S) return;
  const pending = S.segs.some((g) => g.src !== 'stt' && (g.v || 0) > (g.sv || 0)) || memQ.size || upBusy || syncBusy;
  statusEl.className = 'saved' + (!online ? ' off' : pending ? ' wait' : '');
  statusEl.textContent = !online ? '⚠ ' + T.offline : pending || !S.saveAt ? T.saving : '✓ ' + T.saved(clock(S.saveAt));
}
function renderSheet() {
  if (!sheetEl || !S) return;
  sheetEl.textContent = '';
  const segs = S.segs.filter((g) => g.text);
  const live = [interim, ...Object.values(tails)].filter(Boolean).join(' ');
  if (!segs.length && !live) sheetEl.append(el('p', 'empty', S.phase === 'rec' ? T.listening : T.empty));
  let page = null, sec = null;
  for (const g of segs) {
    if (g.page !== page) { page = g.page; sec = null; sheetEl.append(el('div', 'pg', `${T.page}: ${shortTitle(g)}`)); }
    const sx = g.sec?.text || '';
    if (sx && sx !== sec) { sec = sx; sheetEl.append(el('div', 'sec', `§ ${sx.slice(0, 80)}`)); }
    sheetEl.append(el('p', '', g.text));
  }
  if (live) {
    if (location.pathname !== page && segs.length) sheetEl.append(el('div', 'pg', `${T.page}: ${shortTitle({ page: location.pathname, title: document.title })}`));
    sheetEl.append(el('p', 'int', live));
  }
  if (stuck) sheetEl.scrollTop = sheetEl.scrollHeight;
  const s = panel?.querySelector('.acts .pri'); if (s && S.phase !== 'finishing') s.disabled = !segs.length && !live && S.phase !== 'rec';
}
const shortTitle = (g) => { const t = String(g.title || '').split(/\s+[·|—–-]\s+/)[0].trim(); return (t && t.length < 70 ? t : '') || g.page || '/'; };

// ───────────────────────────── entry
let bound = false;
export async function start(o = {}) {
  opts = { endpoint: '/api/review', site: location.hostname, ...o };
  const lang0 = base(o.lang || window.MMIX_REVIEW_SPEECH_LANG || document.documentElement.lang || 'en');
  S = load();
  if (S && S.phase === 'sent') S = null;
  const lost = !S && sidCookie();
  if (!S) { S = newSession(DICT[lang0] ? lang0 : 'en'); if (lost) { S.id = lost; S.phase = 'paused'; } }
  if (o.lang && !S.segs.length && DICT[base(o.lang)]) S.lang = base(o.lang);
  T = DICT[S.lang] || DICT.en;
  S.active = true; setSid(S.id); writeNow();
  mount();
  if (!bound) {
    bound = true;
    addEventListener('pagehide', flushOut);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOut(); else if (S) { upload(); queueSync(500); } });
    addEventListener('online', () => { online = true; upload(); queueSync(200); });
    document.addEventListener('pointerdown', () => { if (actx?.state === 'suspended') actx.resume().catch(() => {}); }, { capture: true, passive: true });
  }
  // single-page sites (Next, Astro view transitions): the kit stays, the page changes
  let href = location.href;
  clearInterval(pageWatch); pageWatch = setInterval(() => { if (location.href !== href) { href = location.href; mark(false); } }, 500);
  if (S.recAt) S.recAt = 0; // the time since the last flush of a closed tab is not recording time
  const wasRec = S.phase === 'rec';
  const localN = S.segs.filter((g) => g.text).length;
  if (S.phase === 'rec') S.phase = 'paused'; // until the microphone is really back
  if (S.phase === 'finishing') S.phase = 'paused';
  renderAll();
  upload(); // chunks a closed tab left behind
  // the server copy: whisper text that came in meanwhile, or everything when this browser lost it
  call(`?dict=${S.id}&site=${encodeURIComponent(opts.site)}&since=0`, { cache: 'no-store' }, (j) => j.kind === 'dict').then((j) => {
    if (!S) return;
    if (j.session?.sent) { S = null; try { localStorage.removeItem(LS); } catch {} dropSid(); close(); return; }
    let n = 0;
    for (const g of j.segs || []) {
      if (S.segs.some((x) => x.id === g.id)) continue;
      S.segs.push({ ...g, v: 1, sv: 1 }); n++;
      if (g.src !== 'stt') { const m = /^c\d+-(\d+)$/.exec(g.id); if (m) S.n = Math.max(S.n, +m[1]); }
      if (g.src === 'stt') S.since = Math.max(S.since, g.upd || 0);
    }
    for (const c of j.chunks || []) S.rec = Math.max(S.rec, c.rec);
    if (j.session?.mode === 'stt') S.mode = 'stt';
    S.segs.sort((a, b) => a.at - b.at);
    tails = j.tails || {}; S.saveAt = Date.now(); save(); renderAll();
    if (n && o.resume) toast(T.restored(S.segs.filter((g) => g.text).length), 6000);
  }).catch(() => {});
  if (o.resume && localN && !wasRec) toast(T.restored(localN), 6000);
  if (wasRec || o.record) {
    // the next page of a walk: recording goes on by itself where the browser allows it, else one tap
    const ok = await startRec(!!o.record).catch(() => false);
    if (!ok && S) { S.phase = hasText() || S.rec >= 0 ? 'paused' : 'intro'; save(); renderAll(); }
  }
  return S?.id;
}
export const version = VERSION;
// tester name for the packet (agents' smoke tests use "TEST …": stored, never sent to Telegram)
export function setTester(name) { if (S) { S.tester = String(name || '').slice(0, 60); save(); queueSync(300); } }
window.MMIXDictate = { start, setTester, version: VERSION };
