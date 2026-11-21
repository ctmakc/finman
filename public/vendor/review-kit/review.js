/*!
 * MMIX Review Kit — "comment on elements" mode for any site. Vanilla JS, no dependencies,
 * all UI inside one Shadow DOM host, so the site's CSS never reaches it and it never reaches
 * the site. Loaded lazily by /review-kit/launcher.js (docs/REVIEW-KIT.md); a normal visitor never downloads it.
 *
 *   import('/review-kit/review.js').then((m) => m.start({ endpoint: '/api/review' }));
 *
 * Modes
 *   collect  — hover highlights, click/tap pins a numbered marker on an element, drag draws an
 *              area; comments live in localStorage across pages until "Send all".
 *   view     — ?review=<packetId>&t=<token>: draws a sent packet over the live page, with
 *              numbers, comment texts, statuses and a list across pages. &focus=<n> opens one.
 *
 * Anchoring works like heatmap tools: element selector (+XPath) and the point inside it in %,
 * areas as a % rectangle of their nearest common container; absolute document coordinates are
 * only the fallback, and a marker drawn from the fallback is flagged "lost".
 *
 * One copy for every site (canonical source: ctmakc/mmix-review-worker kit/review-kit/).
 * UI language: window.MMIX_REVIEW_LANG, window.PLAST_LANG or <html lang> → en / fr / uk / ru.
 *
 * Nothing typed is lost (1.1): every keystroke lands in localStorage within 300 ms, and the
 * unsent comments are also mirrored to the server (review.mmix.biz KV, key = site + session id,
 * throttled, flushed when the tab is hidden or closed). After a reload, a crash or a closed tab the
 * kit comes back by itself and says how many unsent comments it restored. "Send all" sends, clears
 * the drafts and closes the mode; when sending fails, the mode stays open with a Retry button.
 *
 * Site editor (Korvex): with <html data-review-editor="/api/admin"> and a signed-in editor, a sent
 * packet also becomes an edit request; without it the kit works as a plain comment tool.
 */
const VERSION = '1.2.0';

// ───────────────────────────── language
const LANG = (() => { const l = String(window.MMIX_REVIEW_LANG || window.PLAST_LANG || document.documentElement.lang || 'en').slice(0, 2).toLowerCase(); return l === 'ua' ? 'uk' : (['en', 'fr', 'uk', 'ru'].includes(l) ? l : 'en'); })();
// Ukrainian plural: one (1, 21…) · few (2–4, 22–24…) · many.
const ukN = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const NB = '\u00a0';
const DICT = {
  en: {
    mode: 'Comment mode', pick: 'Pick', area: 'Area', list: 'List', sendAll: 'Send all', exit: 'Exit', close: 'Close',
    pickTip: 'On: clicks place comments. Off: the site works normally, so you can move between pages.',
    areaTip: 'Drag to mark an area (on a phone: turn this on, then drag with one finger)',
    review: (id) => `Review ${id}`,
    countView: (n, p, h) => `${n} on ${p} page${p === 1 ? '' : 's'} · ${h} here`,
    count: (n, p) => `${n} on ${p} page${p === 1 ? '' : 's'}`,
    comment: 'Comment', commentN: (n) => `Comment ${n}`, areaWord: 'Area', inside: (n) => `${n} element${n === 1 ? '' : 's'} inside`,
    lostTip: 'Lost: the element changed, shown at the saved position', lostPre: 'Lost: this element changed since the comment. ', lost: 'lost',
    noText: '(no text)', empty: '(empty)', markOpen: 'Mark open', markFixed: 'Mark fixed',
    placeholder: 'What should change here?', del: 'Delete', cancel: 'Cancel', save: 'Save',
    all: 'All comments', comments: (n) => `Comments · ${n}`, name: 'Your name', nameOpt: 'Your name (optional)', sent: 'Sent: ',
    none: 'No comments yet. With Pick on, click any element, or drag to mark an area.', go: 'Go',
    sending: 'Sending…', openReview: 'open the review',
    sentMsg: (n, id) => `Sent: ${n} comment${n === 1 ? '' : 's'}, packet ${id}. `,
    notSent: (e) => `Not sent (${e}). Your comments are kept; try again.`,
    noLoad: (id, e) => `Review ${id} could not be loaded (${e}).`, noStatus: (e) => `Status not saved (${e}).`,
    st: { open: 'open', fixed: 'fixed', wontfix: 'won’t fix' },
    sentN: (n) => `Sent: ${n} comment${n === 1 ? '' : 's'}. `, retry: 'Retry',
    restored: (n) => `Restored ${n} unsent comment${n === 1 ? '' : 's'}`,
    why: { network: 'no connection', rate: 'too many sends, wait a few minutes', too_large: 'too much text', unknown_site: 'this site is not connected', server: 'server error' },
    editOk: ' Sent for editing: follow it in the editor panel (flag button).', editFail: ' Edit request failed — open the ', editor: 'site editor',
    editTip: (e) => `Signed in as ${e}: sent comments become edit requests (preview first, then Publish in the editor panel)`, editMode: 'Edit mode',
    voice: 'Voice', stop: 'Stop', attach: 'Photo / file', camera: 'Camera', dropHint: 'Paste a screenshot (Ctrl+V) or drop files here',
    tooBig: (n) => `${n}: larger than 25 MB`, tooMany: 'Up to 10 attachments per comment', noMic: 'No access to the microphone',
    uploading: (i, n) => `Uploading ${i}/${n}…`, missing: (n) => `Not found on this device, not sent: ${n}`, remove: 'Remove',
    transcript: 'Transcript', withFiles: (n) => `${n} attachment${n === 1 ? '' : 's'}`, voiceNote: 'voice note',
  },
  fr: {
    mode: 'Mode commentaire', pick: 'Pointer', area: 'Zone', list: 'Liste', sendAll: 'Tout envoyer', exit: 'Quitter', close: 'Fermer',
    pickTip: `Activé${NB}: un clic place un commentaire. Désactivé${NB}: le site fonctionne normalement, pour passer d’une page à l’autre.`,
    areaTip: `Faites glisser pour marquer une zone (sur un téléphone${NB}: activez ce bouton, puis glissez d’un doigt)`,
    review: (id) => `Revue ${id}`,
    countView: (n, p, h) => `${n} sur ${p} page${p > 1 ? 's' : ''} · ${h} ici`,
    count: (n, p) => `${n} sur ${p} page${p > 1 ? 's' : ''}`,
    comment: 'Commentaire', commentN: (n) => `Commentaire ${n}`, areaWord: 'Zone', inside: (n) => `${n} élément${n > 1 ? 's' : ''} à l’intérieur`,
    lostTip: `Introuvable${NB}: l’élément a changé, affiché à la position enregistrée`, lostPre: `Introuvable${NB}: cet élément a changé depuis le commentaire. `, lost: 'introuvable',
    noText: '(sans texte)', empty: '(vide)', markOpen: 'Marquer ouvert', markFixed: 'Marquer corrigé',
    placeholder: `Que faut-il changer ici${NB}?`, del: 'Supprimer', cancel: 'Annuler', save: 'Enregistrer',
    all: 'Tous les commentaires', comments: (n) => `Commentaires · ${n}`, name: 'Votre nom', nameOpt: 'Votre nom (facultatif)', sent: `Envoyé${NB}: `,
    none: `Aucun commentaire pour l’instant. Avec «${NB}Pointer${NB}» activé, cliquez sur un élément ou faites glisser pour marquer une zone.`, go: 'Voir',
    sending: 'Envoi…', openReview: 'ouvrir la revue',
    sentMsg: (n, id) => `Envoyé${NB}: ${n} commentaire${n > 1 ? 's' : ''}, paquet ${id}. `,
    notSent: (e) => `Non envoyé (${e}). Vos commentaires sont conservés${NB}; réessayez.`,
    noLoad: (id, e) => `Impossible de charger la revue ${id} (${e}).`, noStatus: (e) => `Statut non enregistré (${e}).`,
    st: { open: 'ouvert', fixed: 'corrigé', wontfix: 'non retenu' },
    sentN: (n) => `Envoyé${NB}: ${n} commentaire${n > 1 ? 's' : ''}. `, retry: 'Réessayer',
    restored: (n) => `${n} commentaire${n > 1 ? 's' : ''} non envoyé${n > 1 ? 's' : ''} restauré${n > 1 ? 's' : ''}`,
    why: { network: 'pas de connexion', rate: 'trop d’envois, attendez quelques minutes', too_large: 'texte trop long', unknown_site: 'ce site n’est pas connecté', server: 'erreur du serveur' },
    editOk: ' Envoyé pour modification', editFail: ' La demande de modification a échoué — ouvrez l’', editor: 'éditeur',
    editTip: (e) => `Connecté en tant que ${e}`, editMode: 'Mode édition',
    voice: 'Voix', stop: 'Arrêter', attach: 'Photo / fichier', camera: 'Caméra', dropHint: `Collez une capture (Ctrl+V) ou déposez des fichiers ici`,
    tooBig: (n) => `${n}${NB}: plus de 25 Mo`, tooMany: 'Jusqu’à 10 pièces jointes par commentaire', noMic: 'Pas d’accès au microphone',
    uploading: (i, n) => `Envoi des fichiers ${i}/${n}…`, missing: (n) => `Introuvable sur cet appareil, non envoyé${NB}: ${n}`, remove: 'Retirer',
    transcript: 'Transcription', withFiles: (n) => `${n} pièce${n > 1 ? 's' : ''} jointe${n > 1 ? 's' : ''}`, voiceNote: 'message vocal',
  },
  uk: {
    mode: 'Режим коментарів', pick: 'Вказати', area: 'Ділянка', list: 'Список', sendAll: 'Надіслати все', exit: 'Вийти', close: 'Закрити',
    pickTip: 'Увімкнено: натискання ставить коментар. Вимкнено: сайт працює як звичайно, і можна переходити між сторінками.',
    areaTip: 'Потягніть, щоб позначити ділянку (на телефоні: увімкніть, тоді ведіть одним пальцем)',
    review: (id) => `Огляд ${id}`,
    countView: (n, p, h) => `${n} на ${p} ${ukN(p, 'сторінці', 'сторінках', 'сторінках')} · ${h} тут`,
    count: (n, p) => `${n} на ${p} ${ukN(p, 'сторінці', 'сторінках', 'сторінках')}`,
    comment: 'Коментар', commentN: (n) => `Коментар ${n}`, areaWord: 'Ділянка', inside: (n) => `${n} ${ukN(n, 'елемент', 'елементи', 'елементів')} всередині`,
    lostTip: 'Втрачено: елемент змінився, показано на збереженому місці', lostPre: 'Втрачено: цей елемент змінився після коментаря. ', lost: 'втрачено',
    noText: '(без тексту)', empty: '(порожньо)', markOpen: 'Позначити відкритим', markFixed: 'Позначити виправленим',
    placeholder: 'Що тут треба змінити?', del: 'Видалити', cancel: 'Скасувати', save: 'Зберегти',
    all: 'Усі коментарі', comments: (n) => `Коментарі · ${n}`, name: 'Ваше ім’я', nameOpt: 'Ваше ім’я (необов’язково)', sent: 'Надіслано: ',
    none: 'Коментарів ще немає. Коли «Вказати» увімкнено, натисніть на будь-який елемент або потягніть, щоб позначити ділянку.', go: 'Показати',
    sending: 'Надсилаємо…', openReview: 'відкрити огляд',
    sentMsg: (n, id) => `Надіслано: ${n} ${ukN(n, 'коментар', 'коментарі', 'коментарів')}, пакет ${id}. `,
    notSent: (e) => `Не надіслано (${e}). Ваші коментарі збережено; спробуйте ще раз.`,
    noLoad: (id, e) => `Не вдалося завантажити огляд ${id} (${e}).`, noStatus: (e) => `Статус не збережено (${e}).`,
    st: { open: 'відкрите', fixed: 'виправлене', wontfix: 'без змін' },
    sentN: (n) => `Надіслано ${n} ${ukN(n, 'коментар', 'коментарі', 'коментарів')}. `, retry: 'Повторити',
    restored: (n) => `Відновлено ${n} ${ukN(n, 'ненадісланий коментар', 'ненадіслані коментарі', 'ненадісланих коментарів')}`,
    why: { network: 'немає зв’язку', rate: 'забагато надсилань, зачекайте кілька хвилин', too_large: 'забагато тексту', unknown_site: 'цей сайт не підключено', server: 'помилка сервера' },
    editOk: ' Надіслано на редагування: стежте в панелі редактора.', editFail: ' Запит на редагування не вдався — відкрийте ', editor: 'редактор',
    editTip: (e) => `Ви увійшли як ${e}: надіслані коментарі стають запитами на правки`, editMode: 'Режим правок',
    voice: 'Голос', stop: 'Стоп', attach: 'Фото / файл', camera: 'Камера', dropHint: 'Вставте скриншот (Ctrl+V) або перетягніть файли сюди',
    tooBig: (n) => `${n}: більше 25 МБ`, tooMany: 'До 10 вкладень на коментар', noMic: 'Немає доступу до мікрофона',
    uploading: (i, n) => `Завантажуємо ${i}/${n}…`, missing: (n) => `Немає на цьому пристрої, не надіслано: ${n}`, remove: 'Прибрати',
    transcript: 'Розшифровка', withFiles: (n) => `${n} ${ukN(n, 'вкладення', 'вкладення', 'вкладень')}`, voiceNote: 'голосове',
  },
  ru: {
    mode: 'Режим комментариев', pick: 'Указать', area: 'Область', list: 'Список', sendAll: 'Отправить всё', exit: 'Выйти', close: 'Закрыть',
    pickTip: 'Включено: клик ставит комментарий. Выключено: сайт работает как обычно, можно переходить между страницами.',
    areaTip: 'Потяните, чтобы отметить область (на телефоне: включите, затем ведите одним пальцем)',
    review: (id) => `Ревью ${id}`,
    countView: (n, p, h) => `${n} на ${p} ${ukN(p, 'странице', 'страницах', 'страницах')} · ${h} здесь`,
    count: (n, p) => `${n} на ${p} ${ukN(p, 'странице', 'страницах', 'страницах')}`,
    comment: 'Комментарий', commentN: (n) => `Комментарий ${n}`, areaWord: 'Область', inside: (n) => `${n} ${ukN(n, 'элемент', 'элемента', 'элементов')} внутри`,
    lostTip: 'Потерян: элемент изменился, показан на сохранённом месте', lostPre: 'Потерян: этот элемент изменился после комментария. ', lost: 'потерян',
    noText: '(без текста)', empty: '(пусто)', markOpen: 'Отметить открытым', markFixed: 'Отметить исправленным',
    placeholder: 'Что здесь поменять?', del: 'Удалить', cancel: 'Отмена', save: 'Сохранить',
    all: 'Все комментарии', comments: (n) => `Комментарии · ${n}`, name: 'Ваше имя', nameOpt: 'Ваше имя (необязательно)', sent: 'Отправлено: ',
    none: 'Комментариев пока нет. Когда «Указать» включено, кликните на любой элемент или потяните, чтобы отметить область.', go: 'Показать',
    sending: 'Отправляем…', openReview: 'открыть ревью',
    sentMsg: (n, id) => `Отправлено: ${n} ${ukN(n, 'комментарий', 'комментария', 'комментариев')}, пакет ${id}. `,
    notSent: (e) => `Не отправлено (${e}). Комментарии сохранены; попробуйте ещё раз.`,
    noLoad: (id, e) => `Не удалось загрузить ревью ${id} (${e}).`, noStatus: (e) => `Статус не сохранён (${e}).`,
    st: { open: 'открыто', fixed: 'исправлено', wontfix: 'без изменений' },
    sentN: (n) => `Отправлено ${n} ${ukN(n, 'комментарий', 'комментария', 'комментариев')}. `, retry: 'Повторить',
    restored: (n) => `Восстановлено ${n} ${ukN(n, 'неотправленный комментарий', 'неотправленных комментария', 'неотправленных комментариев')}`,
    why: { network: 'нет связи', rate: 'слишком много отправок, подождите несколько минут', too_large: 'слишком много текста', unknown_site: 'этот сайт не подключён', server: 'ошибка сервера' },
    editOk: ' Отправлено на правку: следите в панели редактора.', editFail: ' Запрос на правку не прошёл — откройте ', editor: 'редактор',
    editTip: (e) => `Вы вошли как ${e}: отправленные комментарии становятся запросами на правки`, editMode: 'Режим правок',
    voice: 'Голос', stop: 'Стоп', attach: 'Фото / файл', camera: 'Камера', dropHint: 'Вставьте скриншот (Ctrl+V) или перетащите файлы сюда',
    tooBig: (n) => `${n}: больше 25 МБ`, tooMany: 'До 10 вложений на комментарий', noMic: 'Нет доступа к микрофону',
    uploading: (i, n) => `Загружаем ${i}/${n}…`, missing: (n) => `Нет на этом устройстве, не отправлено: ${n}`, remove: 'Убрать',
    transcript: 'Расшифровка', withFiles: (n) => `${n} ${ukN(n, 'вложение', 'вложения', 'вложений')}`, voiceNote: 'голосовое',
  },
};
const T = DICT[LANG];
const LS = 'mmixrv:v1';
const Z = 2147483000;
const SVG_MIC = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';
const SVG_CLIP = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1"/></svg>';
const SVG_CAM = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/></svg>';

// ───────────────────────────── storage
// localStorage is per origin, so every site (and www / bare host) keeps its own session.
// The session id is also kept in a cookie: it is the key of the server copy, so the drafts can
// come back from the server even when localStorage was lost.
const SID_COOKIE = 'mmixrv_sid';
const sidCookie = () => { try { return (document.cookie.match(/(?:^|;\s*)mmixrv_sid=([a-z0-9]{6,20})/) || [])[1] || ''; } catch { return ''; } };
const setSidCookie = (id) => { try { document.cookie = `${SID_COOKIE}=${id}; path=/; max-age=${60 * 60 * 24 * 60}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`; } catch {} };
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
const writeLocal = (s) => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} };
let localT = 0;
// save(): now (local) + the server copy soon. saveSoon(): while typing — local within 300 ms.
const save = (s, remoteDelay = 1500) => { if (!s) return; clearTimeout(localT); localT = 0; s.updated = Date.now(); writeLocal(s); if (s === S) queueDraft(remoteDelay); };
const saveSoon = () => { if (!localT) localT = setTimeout(() => { localT = 0; if (S) { S.updated = Date.now(); writeLocal(S); queueDraft(DRAFT_THROTTLE); } }, 300); };
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const newSession = () => ({ id: rid(10), tester: '', startedAt: Date.now(), active: true, picking: true, area: false, seq: 0, items: [], sent: [] });
const unsent = (s) => (s?.items || []).filter((i) => String(i.comment || '').trim() || i.files?.length);

// ───────────────────────────── attachments: blobs in IndexedDB until "Send all"
// item.files = [{lid, name, type, size, kind, dur, id?, url?}] lives with the comment (localStorage +
// server draft); the bytes stay in IndexedDB on this device and go up only when the packet is sent.
const FILE_MAX = 25e6, FILES_MAX = 10, VOICE_MAX = 180;
let idbP = null;
const idb = () => (idbP ||= new Promise((res, rej) => {
  const r = indexedDB.open('mmixrv', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('files');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
const idbDo = (mode, fn) => idb().then((db) => new Promise((res, rej) => {
  const tx = db.transaction('files', mode); const rq = fn(tx.objectStore('files'));
  tx.oncomplete = () => res(rq?.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
}));
const blobPut = (lid, blob) => idbDo('readwrite', (st) => st.put(blob, lid));
const blobGet = (lid) => idbDo('readonly', (st) => st.get(lid)).catch(() => null);
const blobDel = (lid) => idbDo('readwrite', (st) => st.delete(lid)).catch(() => {});
const kindOf = (t) => (/^audio\//.test(t) ? 'audio' : /^image\//.test(t) ? 'image' : /^video\//.test(t) ? 'video' : 'file');
const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const urls = new Map(); // lid → object URL for previews
async function previewUrl(f) {
  if (f.url && !f.lid) return f.url;
  if (urls.has(f.lid)) return urls.get(f.lid);
  const b = await blobGet(f.lid);
  if (!b) return f.url || '';
  const u = URL.createObjectURL(b); urls.set(f.lid, u); return u;
}

// ───────────────────────────── server copy of the drafts
// POST {action:'draft', site, session, tester, items} to the review endpoint (the site's /api/review
// proxy → review.mmix.biz); an empty list deletes it. Sites whose /api/review is their own function
// (Korvex, Plast) answer "not ours", and the kit then talks to review.mmix.biz directly (CORS).
// Throttled to one write per DRAFT_THROTTLE while typing: the KV free plan has 1000 writes a day.
const DRAFT_THROTTLE = 20000;
const DRAFT_HOST = 'https://review.mmix.biz/api/review';
let draftT = 0, draftBusy = false, draftSent = '', draftUrl = null, draftOff = false;
const draftItems = () => unsent(S).map(({ _lost, ...i }) => i);
// What the server already holds, so a page change does not rewrite the same draft.
const draftKey = (tester, items) => JSON.stringify([tester || '', items || []]);
// website:'mmix-draft' — an older backend (own /api/review of Korvex, Plast) reads it as the honeypot and
// stores nothing; only review.mmix.biz answers kind:'draft', and only that answer counts as saved.
const draftBody = () => JSON.stringify({ action: 'draft', website: 'mmix-draft', site: opts.site, session: S.id, tester: S.tester || '', v: VERSION, items: draftItems() });
function queueDraft(delay) {
  if (draftOff || !S || V) return;
  if (draftT && delay >= DRAFT_THROTTLE) return; // a write is already planned: throttle, do not postpone
  clearTimeout(draftT); draftT = setTimeout(pushDraft, delay);
}
async function draftFetch(url, init) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok && j.kind === 'draft', status: r.status, j };
}
async function pushDraft() {
  draftT = 0;
  if (draftOff || !S || V) return;
  if (draftBusy) { queueDraft(3000); return; }
  const key = draftKey(S.tester, draftItems());
  if (key === draftSent) return;
  const body = draftBody();
  draftBusy = true;
  try {
    const urls = draftUrl ? [draftUrl] : [opts.drafts || opts.endpoint, DRAFT_HOST].filter((u, k, a) => a.indexOf(u) === k);
    for (const u of urls) {
      let res;
      try { res = await draftFetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60000 }); } catch { res = { ok: false, status: 0 }; }
      if (res.ok) { draftUrl = u; draftSent = key; return; }
      if (res.status === 0 || res.status === 429 || res.status >= 500) { queueDraft(DRAFT_THROTTLE); return; } // offline: try later
      // 2xx without kind:'draft' or 4xx = this endpoint does not keep drafts: try the next one
    }
    draftOff = true; // no endpoint keeps drafts here: the local copy still does
  } finally { draftBusy = false; }
}
// Tab hidden / closed: flush both copies right away.
function flushNow() {
  if (!S || V) return;
  if (localT) { clearTimeout(localT); localT = 0; S.updated = Date.now(); writeLocal(S); }
  if (draftOff) return;
  const key = draftKey(S.tester, draftItems());
  if (key === draftSent) return;
  const body = draftBody();
  if (!draftUrl) { queueDraft(0); return; } // the draft endpoint is not known yet: the normal path finds it
  try { fetch(draftUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60000 }).then((r) => { if (r.ok) draftSent = key; }, () => {}); } catch {}
}
async function pullDraft(id) {
  for (const u of draftUrl ? [draftUrl] : [opts.drafts || opts.endpoint, DRAFT_HOST].filter((x, k, a) => a.indexOf(x) === k)) {
    try {
      const res = await draftFetch(`${u}?draft=${encodeURIComponent(id)}&site=${encodeURIComponent(opts.site)}`, { cache: 'no-store' });
      if (res.ok) { draftUrl = u; const d = res.j.draft || null; draftSent = draftKey(d?.tester, d?.items); return d; }
    } catch {}
  }
  return null;
}
// Server items the local copy does not have (or has an older text of) come back.
function mergeDraft(d) {
  if (!d || !Array.isArray(d.items) || !S) return 0;
  let n = 0;
  for (const it of d.items) {
    if (!it || !it.id || !String(it.comment || '').trim()) continue;
    if ((S.sent || []).some((x) => (x.items || []).includes(it.id))) continue;
    const mine = S.items.find((i) => i.id === it.id);
    if (!mine) { S.items.push(it); n++; }
    else if (!String(mine.comment || '').trim() || (it.edited || 0) > (mine.edited || 0)) { if (mine.comment !== it.comment) { mine.comment = it.comment; mine.edited = it.edited; n++; } }
  }
  if (n) { S.seq = S.items.reduce((m, i) => Math.max(m, i.n || 0), 0); if (!S.tester && d.tester) S.tester = d.tester; }
  return n;
}

// ───────────────────────────── element description
const BAD_CLASS = /^(astro-|is-|js-|has-|active|open|hover|focus|visible|hidden|show|css-|sc-|jsx-|svelte-|_)|[0-9a-f]{6,}|\d{3,}/i;
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

function cssPath(el) {
  if (!(el instanceof Element)) return '';
  if (el.id && !/\d{3,}|[:.]/.test(el.id) && unique('#' + cssEsc(el.id))) return '#' + cssEsc(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.localName;
    if (node.id && !/\d{3,}/.test(node.id)) { parts.unshift('#' + cssEsc(node.id)); break; }
    for (const a of ['data-testid', 'data-track', 'data-slide', 'name', 'for', 'aria-label']) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v && v.length < 60) { part += `[${a}="${v.replace(/"/g, '\\"')}"]`; break; }
    }
    const cls = Array.from(node.classList || []).filter((c) => !BAD_CLASS.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.map(cssEsc).join('.');
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
      if (same.length > 1 && Array.from(parent.children).filter((c) => { try { return c.matches(part); } catch { return false; } }).length > 1) {
        part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    const sel = parts.join(' > ');
    if (unique(sel)) return sel;
    node = parent;
  }
  return parts.join(' > ');
}
function xPath(el) {
  const seg = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) i++;
    seg.unshift(`${n.localName}[${i}]`);
  }
  return '/' + seg.join('/');
}
const byXPath = (xp) => { try { return document.evaluate(xp, document, null, 9, null).singleNodeValue; } catch { return null; } };
const txt = (el, n) => (el.innerText || el.textContent || el.getAttribute?.('alt') || el.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, n);
const html = (el, n) => (el.outerHTML || '').replace(/\s+/g, ' ').replace(/ data-astro-cid-[\w-]+(="[^"]*")?/g, '').slice(0, n);
const docRect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const device = () => (matchMedia('(pointer: coarse)').matches ? (Math.min(screen.width, screen.height) < 700 ? 'phone' : 'tablet') : 'desktop');
const pagePath = (u = location) => u.pathname;

// ───────────────────────────── styles (inside the shadow root only)
const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.mk { position: absolute; transform: translate(-50%, -50%); width: 28px; height: 28px; border-radius: 50%; background: #FFD60A; color: #111; border: 2px solid #111;
  font: 700 13px/24px ui-sans-serif, system-ui, sans-serif; text-align: center; pointer-events: auto; cursor: pointer; box-shadow: 0 0 0 2px #FFD60A66, 0 2px 8px #0006; padding: 0; }
.mk.fixed { background: #30D158; }
.mk.lost { background: #fff; border-style: dashed; }
.mk:focus-visible { outline: 3px solid #0A84FF; outline-offset: 2px; }
.area { position: absolute; border: 2px dashed #FFD60A; background: #FFD60A1f; box-shadow: 0 0 0 1px #1119 inset, 0 0 0 1px #1119; pointer-events: none; }
.area.fixed { border-color: #30D158; background: #30D1581a; }
.area.lost { border-color: #fff; }
.call { position: absolute; width: max-content; max-width: 260px; background: #111; color: #fff; font: 13px/1.35 ui-sans-serif, system-ui, sans-serif; padding: 6px 9px; border-radius: 6px;
  pointer-events: auto; box-shadow: 0 4px 16px #0007; transform: translate(18px, -50%); white-space: pre-wrap; overflow-wrap: anywhere; }
.call b { color: #FFD60A; margin-right: 4px; }
.call .st { display: inline-block; margin-left: 6px; font-size: 11px; color: #aaa; }
.hl { position: fixed; pointer-events: none; border: 2px solid #0A84FF; background: #0A84FF14; border-radius: 2px; transition: all 60ms linear; display: none; }
.drag { position: fixed; pointer-events: none; border: 2px dashed #FFD60A; background: #FFD60A22; display: none; }
.bar { position: fixed; left: 50%; bottom: max(12px, env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  background: #111; color: #fff; border-radius: 12px; padding: 6px; box-shadow: 0 8px 30px #0008; max-width: calc(100vw - 16px); width: max-content; pointer-events: auto; }
.bar .ttl { font: 600 13px/1 ui-sans-serif, system-ui, sans-serif; padding: 0 8px; color: #FFD60A; white-space: nowrap; }
.bar .cnt { font-size: 12px; color: #bbb; padding: 0 6px; white-space: nowrap; }
button.b { appearance: none; border: 1px solid #333; background: #1d1d1f; color: #fff; font: 600 13px/1 ui-sans-serif, system-ui, sans-serif; padding: 0 12px; min-height: 40px; border-radius: 8px; cursor: pointer; }
button.b:hover { background: #2a2a2d; }
button.b[aria-pressed="true"] { background: #FFD60A26; color: #FFD60A; border-color: #FFD60A; }
button.b.pri { background: #FFD60A; color: #111; border-color: #FFD60A; }
button.b.ghost { background: transparent; border-color: transparent; color: #bbb; }
button.b:focus-visible, textarea:focus-visible, input:focus-visible { outline: 3px solid #0A84FF; outline-offset: 1px; }
button.b:disabled { opacity: .5; cursor: default; }
.pop { max-height: calc(100vh - 90px); overflow: auto; position: fixed; width: min(340px, calc(100vw - 16px)); background: #111; color: #fff; border-radius: 12px; padding: 12px; box-shadow: 0 12px 40px #000a; pointer-events: auto; display: grid; gap: 8px; }
.pop h3 { margin: 0; font: 700 14px/1.2 ui-sans-serif, system-ui, sans-serif; display: flex; gap: 8px; align-items: center; }
.pop h3 i { font-style: normal; width: 22px; height: 22px; border-radius: 50%; background: #FFD60A; color: #111; font-size: 12px; line-height: 22px; text-align: center; }
.pop .meta { font-size: 11px; color: #999; overflow-wrap: anywhere; }
.pop textarea, .panel input { width: 100%; min-height: 96px; resize: vertical; background: #1d1d1f; color: #fff; border: 1px solid #444; border-radius: 8px; padding: 8px; font: 15px/1.4 ui-sans-serif, system-ui, sans-serif; }
.panel input { min-height: 40px; }
.row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); background: #111; color: #fff; box-shadow: -8px 0 30px #0008; pointer-events: auto; display: flex; flex-direction: column; }
.panel header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 8px; border-bottom: 1px solid #2a2a2d; font: 700 15px/1.2 ui-sans-serif, system-ui, sans-serif; }
.panel .body { overflow: auto; padding: 8px 12px 16px; display: grid; gap: 12px; align-content: start; }
.panel .pg { font: 600 12px/1.3 ui-sans-serif, system-ui, sans-serif; color: #FFD60A; margin: 6px 0 2px; overflow-wrap: anywhere; }
.panel .it { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: start; background: #1a1a1c; border-radius: 8px; padding: 8px; }
.panel .it i { font-style: normal; width: 24px; height: 24px; border-radius: 50%; background: #FFD60A; color: #111; font: 700 12px/24px ui-sans-serif, system-ui, sans-serif; text-align: center; }
.panel .it.fixed i { background: #30D158; }
.panel .it p { margin: 0; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.panel .it small { display: block; color: #888; font-size: 11px; margin-top: 2px; }
.panel .it button.b { min-height: 32px; padding: 0 8px; font-size: 12px; }
.tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tools button.b { min-height: 34px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.tools button.b.rec { background: #FF453A; border-color: #FF453A; color: #fff; }
.tools .hint { font-size: 11px; color: #888; flex: 1 1 100%; }
.att { display: grid; gap: 6px; }
.att:empty { display: none; }
.chip { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; background: #1d1d1f; border: 1px solid #333; border-radius: 8px; padding: 6px; font-size: 12px; color: #ddd; min-width: 0; }
.chip img, .chip video { width: 64px; height: 48px; object-fit: cover; border-radius: 4px; background: #000; display: block; }
.chip audio { width: 100%; height: 34px; grid-column: 1 / -1; }
.chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.chip .nm small { display: block; color: #888; }
.chip button.b { min-height: 28px; padding: 0 8px; font-size: 12px; }
.chip p { grid-column: 1 / -1; margin: 0; font-size: 12px; color: #ccc; white-space: pre-wrap; }
.chip a { color: #FFD60A; }
.pop.dropping { outline: 2px dashed #FFD60A; outline-offset: -6px; }
.pop .att .chip img { cursor: zoom-in; }
.note { font-size: 12px; color: #bbb; line-height: 1.4; }
.note a { color: #FFD60A; }
.toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #111; color: #fff; padding: 10px 14px; border-radius: 10px; font: 600 13px/1.3 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 8px 30px #0008; pointer-events: auto; max-width: calc(100vw - 24px); display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; }
.toast button.b { min-height: 32px; }
@media (max-width: 640px) {
  .bar { left: 8px; right: 8px; transform: none; justify-content: space-between; width: auto; }
  .bar .ttl { display: none; }
  .bar { gap: 4px; }
  .bar .cnt { order: -1; width: 100%; text-align: center; padding: 2px 0 0; }
  .bar button.b { flex: 1 1 0; padding: 0 6px; }
  button.b { min-height: 44px; }
  .panel { top: auto; height: 70vh; width: 100vw; border-radius: 14px 14px 0 0; }
  .pop { left: 8px !important; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)) !important; top: auto !important; width: auto; max-height: 82vh; overflow: auto; overscroll-behavior: contain; }
}
`;

// ───────────────────────────── the kit
let S = null;            // collect-mode session (localStorage)
let V = null;            // view-mode packet
let opts = {};
let host, root, layer, ui, hl, dragBox, bar, pop, panel;
let started = false;

// Site editor (optional, host-specific): when the visitor is signed in to /admin/ (Cloudflare
// Access), a sent packet also becomes an edit request (opts.editor = '/api/admin'). A visitor who
// is not signed in gets a redirect from Access, and the kit works exactly as before.
let EDITOR = null;
async function probeEditor() {
  if (!opts.editor) return;
  try {
    const r = await fetch(`${opts.editor}/me`, { redirect: 'manual', credentials: 'same-origin', cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    EDITOR = j?.email || null;
  } catch { EDITOR = null; }
  if (bar && S && !V) renderBar();
}

// "Restored N" is said when the comments come back after a reload, a crash, a closed tab or an
// earlier Exit — not on every page of a normal walk through the site (same tab, same session).
const TAB = 'mmixrv:tab';
const navType = () => { try { return performance.getEntriesByType('navigation')[0]?.type || ''; } catch { return ''; } };
function comeback(s, wasActive) {
  let tab = '';
  try { tab = sessionStorage.getItem(TAB) || ''; sessionStorage.setItem(TAB, s.id); } catch {}
  return !wasActive || tab !== s.id || navType() === 'reload';
}

export function start(o = {}) {
  // Static hosts without a proxy (Firebase Hosting Spark, GitHub Pages) set <meta name="mmix-review-endpoint" content="https://review.mmix.biz/api/review">.
  opts = { endpoint: document.querySelector('meta[name="mmix-review-endpoint"]')?.content || '/api/review', site: location.hostname, build: document.querySelector('meta[name="build-id"]')?.content || '',
    editor: document.querySelector('[data-review-editor]')?.getAttribute('data-review-editor') || '', drafts: '', ...o };
  const q = new URLSearchParams(location.search);
  if (!started) mount();
  started = true;
  if (q.get('review') && q.get('t') && !/^[01]$/.test(q.get('review'))) return startView(q.get('review'), q.get('t'), q.get('focus'));
  probeEditor();
  S = load();
  const lostLocal = !S && !o.fresh && sidCookie();
  const wasActive = !!S?.active && !o.picking;
  if (!S || o.fresh) S = newSession();
  if (lostLocal) S.id = lostLocal; // localStorage was wiped: keep the old id, the server copy comes back below
  setSidCookie(S.id);
  S.active = true;
  if (o.picking !== undefined) S.picking = o.picking;
  writeLocal(S);
  bind();
  render();
  const back = comeback(S, wasActive);
  const local = unsent(S).length;
  if (back && local) toast(T.restored(local), 9000);
  // The server copy may hold what this browser lost (crash before the disk write, wiped storage).
  pullDraft(S.id).then((d) => { const n = mergeDraft(d); if (n) { writeLocal(S); render(); toast(T.restored(unsent(S).length), 9000); } else queueDraft(DRAFT_THROTTLE); });
  const h = location.hash.match(/mmixrv=([\w-]+)/);
  if (h) setTimeout(() => focusItem(h[1]), 400);
}
export function resume() { S = load(); if (S && S.active) start({}); }
export const version = VERSION;

function mount() {
  host = document.createElement('mmix-review');
  host.setAttribute('data-nosnippet', '');
  host.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;z-index:${Z};display:block;`;
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS_TEXT}</style><div class="layer"></div><div class="ui"><div class="hl"></div><div class="drag"></div></div>`;
  layer = root.querySelector('.layer');
  ui = root.querySelector('.ui');
  hl = root.querySelector('.hl');
  dragBox = root.querySelector('.drag');
  let t = 0;
  const re = () => { if (t) return; t = requestAnimationFrame(() => { t = 0; place(); }); };
  addEventListener('scroll', re, { passive: true });
  addEventListener('resize', re);
  new ResizeObserver(re).observe(document.body);
  setInterval(re, 1500);
  addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
}
const ours = (e) => e.composedPath && e.composedPath().includes(host);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (label, cls = '', on) => { const b = el('button', 'b ' + cls, label); b.type = 'button'; if (on) b.addEventListener('click', on); return b; };
function toast(msg, ms = 3500, action) {
  ui.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = el('div', 'toast'); t.setAttribute('role', 'status'); t.append(msg);
  if (action) t.append(btn(action.label, 'pri', () => { t.remove(); action.run(); }));
  ui.appendChild(t); setTimeout(() => t.remove(), ms);
}

// ───────────────────────────── picking (collect mode)
let down = null; let bound = false;
function bind() {
  if (bound) return; bound = true;
  const opt = { capture: true, passive: false };
  addEventListener('pointermove', (e) => {
    if (!S?.active || !S.picking || ours(e)) { hl.style.display = 'none'; return; }
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (down.drag || Math.hypot(dx, dy) > 5 && (e.pointerType === 'mouse' || S.area)) {
        down.drag = true; hl.style.display = 'none';
        Object.assign(dragBox.style, { display: 'block', left: Math.min(e.clientX, down.x) + 'px', top: Math.min(e.clientY, down.y) + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
        e.preventDefault();
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const t = target(e.clientX, e.clientY); if (!t) return;
    const r = t.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }, opt);
  addEventListener('pointerdown', (e) => {
    if (!S?.active || !S.picking || ours(e) || e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY, type: e.pointerType, drag: false };
    if (e.pointerType === 'mouse' || S.area) e.preventDefault();
  }, opt);
  addEventListener('pointercancel', () => { down = null; dragBox.style.display = 'none'; }, opt);
  addEventListener('pointerup', (e) => {
    if (!down || ours(e)) { down = null; return; }
    const d = down; down = null; dragBox.style.display = 'none';
    if (Math.abs(scrollX - d.sx) + Math.abs(scrollY - d.sy) > 5) return; // a touch scroll, not a tap
    e.preventDefault(); e.stopPropagation();
    if (d.drag) addArea(d.x, d.y, e.clientX, e.clientY); else addElement(e.clientX, e.clientY);
  }, opt);
  for (const type of ['click', 'auxclick', 'dblclick', 'submit', 'contextmenu']) {
    addEventListener(type, (e) => { if (S?.active && S.picking && !ours(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, opt);
  }
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(S?.active || V)) return;
    if (pop) { closePop(); return; }
    if (panel) { panel.remove(); panel = null; return; }
    if (S?.active) exit();
  }, true);
}
function target(x, y) {
  const list = document.elementsFromPoint(x, y).filter((n) => n !== host && n !== document.documentElement && n !== document.body);
  return list[0] || document.body;
}
function anchorFor(t, cx, cy) {
  const r = t.getBoundingClientRect();
  return { selector: cssPath(t), xpath: xPath(t), tag: t.localName, text: txt(t, 120), html: html(t, 300),
    px: round(r.width ? ((cx - r.left) / r.width) * 100 : 50), py: round(r.height ? ((cy - r.top) / r.height) * 100 : 50) };
}
function common(a, b) { const set = new Set(); for (let n = a; n; n = n.parentElement) set.add(n); for (let n = b; n; n = n.parentElement) if (set.has(n)) return n; return document.body; }
function context() {
  return { url: location.href, page: pagePath(), title: document.title.slice(0, 120), vw: innerWidth, vh: innerHeight, dpr: round(devicePixelRatio, 2), device: device(),
    scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), build: opts.build, at: new Date().toISOString() };
}
function addElement(cx, cy) {
  const t = target(cx, cy);
  const item = { id: rid(6), n: ++S.seq, kind: 'element', ...context(), anchor: anchorFor(t, cx, cy), abs: { x: Math.round(cx + scrollX), y: Math.round(cy + scrollY) }, comment: '', edited: Date.now() };
  S.items.push(item); save(S); render(); openPop(item, true);
}
function addArea(x1, y1, x2, y2) {
  const l = Math.min(x1, x2), t = Math.min(y1, y2), r = Math.max(x1, x2), b = Math.max(y1, y2);
  const corners = [[l + 2, t + 2], [r - 2, t + 2], [l + 2, b - 2], [r - 2, b - 2]].map(([x, y]) => target(x, y));
  let box = corners.reduce((a, c) => common(a, c));
  if (box === document.documentElement) box = document.body;
  const br = box.getBoundingClientRect();
  const inside = [];
  const all = box.querySelectorAll('a,button,img,picture,svg,h1,h2,h3,h4,p,li,label,input,select,textarea,figure,span,div');
  for (const n of all) {
    if (inside.length >= 12) break;
    const q = n.getBoundingClientRect();
    if (!q.width || !q.height || q.left < l - 1 || q.top < t - 1 || q.right > r + 1 || q.bottom > b + 1) continue;
    if (inside.some((x) => x.node.contains(n))) continue;
    const s = txt(n, 50); if (!s && !/^(img|picture|svg|input|select|textarea|button|a)$/.test(n.localName)) continue;
    inside.push({ node: n, selector: cssPath(n), text: s });
  }
  const item = { id: rid(6), n: ++S.seq, kind: 'area', ...context(),
    anchor: { selector: cssPath(box), xpath: xPath(box), tag: box.localName, text: txt(box, 80),
      rx: round(((l - br.left) / (br.width || 1)) * 100), ry: round(((t - br.top) / (br.height || 1)) * 100),
      rw: round(((r - l) / (br.width || 1)) * 100), rh: round(((b - t) / (br.height || 1)) * 100) },
    abs: { x: Math.round(l + scrollX), y: Math.round(t + scrollY), w: Math.round(r - l), h: Math.round(b - t) },
    view: { x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) },
    elements: inside.map(({ selector, text }) => ({ selector, text })), comment: '', edited: Date.now() };
  S.items.push(item); save(S); render(); openPop(item, true);
}

// ───────────────────────────── resolving anchors → document coordinates
function resolve(item) {
  const a = item.anchor || {};
  let node = null;
  try { node = a.selector ? document.querySelector(a.selector) : null; } catch {}
  if (!node && a.xpath) node = byXPath(a.xpath);
  if (node && a.tag && node.localName !== a.tag) node = null;
  const rect = node ? docRect(node) : null;
  if (!rect || (!rect.w && !rect.h)) {
    return item.kind === 'area' ? { lost: true, x: item.abs.x, y: item.abs.y, w: item.abs.w, h: item.abs.h } : { lost: true, x: item.abs.x, y: item.abs.y };
  }
  if (item.kind === 'area') return { x: rect.x + (a.rx / 100) * rect.w, y: rect.y + (a.ry / 100) * rect.h, w: (a.rw / 100) * rect.w, h: (a.rh / 100) * rect.h };
  return { x: rect.x + (a.px / 100) * rect.w, y: rect.y + (a.py / 100) * rect.h };
}
const visibleItems = () => (V ? V.items : S ? S.items : []).filter((i) => i.page === pagePath());
const statusOf = (i) => (V ? (V.statuses?.[i.id] || 'open') : 'open');

function render() {
  layer.textContent = '';
  if (!(S?.active || V)) { bar?.remove(); bar = null; return; }
  for (const it of visibleItems()) {
    const st = statusOf(it);
    if (it.kind === 'area') { const a = el('div', `area ${st}`); a.dataset.id = it.id; layer.appendChild(a); }
    const m = btn(String(it.n), `mk ${st}`); m.className = `mk ${st}`; m.dataset.id = it.id;
    m.setAttribute('aria-label', `${T.commentN(it.n)}${it.comment ? ': ' + it.comment.slice(0, 60) : ''}`);
    m.addEventListener('click', (e) => { e.stopPropagation(); openPop(it, false); });
    layer.appendChild(m);
    if (V && it.comment) { const c = el('div', 'call'); c.dataset.id = it.id; const b = el('b', '', `${it.n}`); c.append(b, it.comment.length > 140 && V.focus !== String(it.n) ? it.comment.slice(0, 140) + '…' : it.comment); if (st !== 'open') c.append(el('span', 'st', T.st[st] || st)); layer.appendChild(c); }
  }
  renderBar();
  place();
}
function place() {
  if (!layer) return;
  const items = visibleItems();
  for (const it of items) {
    const p = resolve(it);
    const lost = !!p.lost;
    const mk = layer.querySelector(`.mk[data-id="${it.id}"]`);
    const ar = layer.querySelector(`.area[data-id="${it.id}"]`);
    const call = layer.querySelector(`.call[data-id="${it.id}"]`);
    const mx = it.kind === 'area' ? p.x : p.x, my = it.kind === 'area' ? p.y : p.y;
    if (ar) Object.assign(ar.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });
    if (ar) ar.classList.toggle('lost', lost);
    if (mk) { Object.assign(mk.style, { left: mx + 'px', top: my + 'px' }); mk.classList.toggle('lost', lost); mk.title = lost ? T.lostTip : ''; }
    if (call) Object.assign(call.style, { left: mx + 'px', top: my + 'px' });
    it._lost = lost;
  }
  if (pop && pop._item) positionPop(pop._item);
  layer.querySelectorAll('.call').forEach((c) => { c.style.visibility = pop && pop._item && c.dataset.id === pop._item.id ? 'hidden' : ''; });
}

// ───────────────────────────── bar, popover, list
function renderBar() {
  bar?.remove();
  bar = el('div', 'bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', T.mode);
  if (V) {
    const pages = new Set(V.items.map((i) => i.page)).size;
    bar.append(el('span', 'ttl', T.review(V.id)), el('span', 'cnt', T.countView(V.items.length, pages, visibleItems().length)),
      btn(T.list, '', openPanel), btn(T.close, 'ghost', () => { const u = new URL(location.href); ['review', 't', 'focus'].forEach((k) => u.searchParams.delete(k)); location.href = u.href; }));
  } else {
    const pages = new Set(S.items.map((i) => i.page)).size;
    const pick = btn(T.pick, '', () => { S.picking = !S.picking; save(S); renderBar(); });
    pick.setAttribute('aria-pressed', String(!!S.picking)); pick.title = T.pickTip;
    const area = btn(T.area, '', () => { S.area = !S.area; if (S.area) S.picking = true; save(S); document.documentElement.style.touchAction = S.area ? 'none' : ''; renderBar(); });
    area.setAttribute('aria-pressed', String(!!S.area)); area.title = T.areaTip;
    document.documentElement.style.touchAction = S.area && S.picking ? 'none' : '';
    const send = btn(T.sendAll, 'pri', sendAll); send.disabled = !unsent(S).length;
    const ttl = el('span', 'ttl', EDITOR ? T.editMode : T.mode);
    if (EDITOR) ttl.title = T.editTip(EDITOR);
    bar.append(ttl, pick, area, el('span', 'cnt', T.count(S.items.length, pages)), btn(T.list, '', openPanel), send, btn(T.exit, 'ghost', exit));
  }
  ui.appendChild(bar);
}
function openPop(item, fresh) {
  closePop(false);
  pop = el('div', 'pop'); pop._item = item; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', T.commentN(item.n));
  const h = el('h3'); h.append(el('i', '', String(item.n)), item.kind === 'area' ? T.areaWord : `<${item.anchor.tag}>`);
  const meta = el('div', 'meta', (item.kind === 'area' ? T.inside(item.elements?.length || 0) : item.anchor.text || item.anchor.selector).slice(0, 120));
  if (item._lost) meta.textContent = T.lostPre + meta.textContent;
  pop.append(h, meta);
  if (V) {
    const p = el('p', 'note', item.comment || (item.files?.length ? '' : T.noText)); p.style.cssText = 'margin:0;font-size:14px;color:#fff;white-space:pre-wrap';
    if (item.files?.length) { const att = el('div', 'att'); renderFiles(att, item, true); pop.append(p); pop.append(att); }
    const st = statusOf(item);
    const tog = btn(st === 'fixed' ? T.markOpen : T.markFixed, 'pri', () => setStatus(item, st === 'fixed' ? 'open' : 'fixed'));
    const row = el('div', 'row'); row.append(btn(T.close, 'ghost', () => closePop()), tog);
    if (!item.files?.length) pop.append(p);
    pop.append(row);
  } else {
    const ta = el('textarea'); ta.value = item.comment; ta.placeholder = T.placeholder; ta.maxLength = 2000; ta.setAttribute('aria-label', T.comment);
    // Every keystroke is the comment: kept in localStorage within 300 ms, on the server soon after.
    pop._prev = item.comment;
    ta.addEventListener('input', () => { item.comment = ta.value; item.edited = Date.now(); saveSoon(); if (bar) { const sb = bar.querySelector('.pri'); if (sb && sb.textContent === T.sendAll) sb.disabled = !unsent(S).length; } });
    ta.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(item, fs); } });
    const att = el('div', 'att'); pop._att = att;
    const tools = el('div', 'tools');
    const pick = (accept, capture) => { const inp = el('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = !capture; if (capture) inp.setAttribute('capture', capture);
      inp.style.display = 'none'; inp.addEventListener('change', () => { addFiles(item, [...inp.files]); inp.remove(); }); ui.appendChild(inp); inp.click(); };
    const ico = (svg, label, cls, on) => { const b = btn('', cls, on); b.innerHTML = svg; b.append(label); return b; };
    const mic = ico(SVG_MIC, T.voice, '', () => (rec ? stopRec() : startRec(item, mic)));
    pop._mic = mic;
    tools.append(mic, ico(SVG_CLIP, T.attach, '', () => pick('image/*,video/*,audio/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.heic,.heif')));
    if (matchMedia('(pointer: coarse)').matches) tools.append(ico(SVG_CAM, T.camera, '', () => pick('image/*', 'environment')));
    if (!matchMedia('(pointer: coarse)').matches) tools.append(el('span', 'hint', T.dropHint));
    pop.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); pop.classList.add('dropping'); } });
    pop.addEventListener('dragleave', () => pop.classList.remove('dropping'));
    pop.addEventListener('drop', (e) => { e.preventDefault(); pop.classList.remove('dropping'); addFiles(item, [...(e.dataTransfer?.files || [])]); });
    renderFiles(att, item, false);
    const row = el('div', 'row');
    row.append(btn(T.del, 'ghost', () => { (item.files || []).forEach((f) => f.lid && blobDel(f.lid)); S.items = S.items.filter((i) => i !== item); save(S); closePop(false); render(); }),
      btn(T.cancel, '', () => { item.comment = pop._prev; save(S); closePop(); render(); }),
      btn(T.save, 'pri', () => { if (rec) stopRec(); item.comment = ta.value.trim(); item.edited = Date.now(); save(S); closePop(false); render(); }));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) row.lastChild.click(); });
    pop.append(ta, tools, att, row);
    setTimeout(() => ta.focus(), 0);
  }
  ui.appendChild(pop);
  if (innerWidth <= 640) { const r = targetRect(item); if (r.y + r.h > innerHeight * 0.45 || r.y < 0) scrollBy({ top: r.y - 80, behavior: 'auto' }); }
  positionPop(item);
  pop._fresh = fresh;
}
// The note never sits on what it is about: it goes beside the marked element or area (right,
// then left), else below or above it, whichever side has the room. On a phone it is a bottom
// sheet (CSS) and the page scrolls so the target sits in the upper part of the screen.
function targetRect(item) {
  const p = resolve(item);
  if (item.kind === 'area' && p.w) return { x: p.x - scrollX, y: p.y - scrollY, w: p.w, h: p.h };
  let node = null; try { node = item.anchor.selector ? document.querySelector(item.anchor.selector) : null; } catch {}
  if (!node && item.anchor.xpath) node = byXPath(item.anchor.xpath);
  if (node) { const r = node.getBoundingClientRect(); if (r.width || r.height) return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  return { x: p.x - scrollX - 14, y: p.y - scrollY - 14, w: 28, h: 28 };
}
function positionPop(item) {
  if (!pop) return;
  if (innerWidth <= 640) return; // bottom sheet
  let r = targetRect(item);
  // A whole section is too big to sit beside: anchor to the marker itself instead.
  if (r.w > innerWidth * 0.6 && r.h > innerHeight * 0.4) { const p = resolve(item); r = { x: p.x - scrollX - 14, y: p.y - scrollY - 14, w: 28, h: 28 }; }
  const w = pop.offsetWidth || 340, h = pop.offsetHeight || 200, gap = 14, m = 8, barH = 70;
  const fitsY = (top) => Math.max(m, Math.min(innerHeight - h - barH, top));
  let left, top;
  if (innerWidth - (r.x + r.w) >= w + gap + m) { left = r.x + r.w + gap; top = fitsY(r.y); }
  else if (r.x >= w + gap + m) { left = r.x - w - gap; top = fitsY(r.y); }
  else if (innerHeight - barH - (r.y + r.h) >= h + gap) { top = r.y + r.h + gap; left = Math.max(m, Math.min(innerWidth - w - m, r.x)); }
  else if (r.y >= h + gap + m) { top = r.y - h - gap; left = Math.max(m, Math.min(innerWidth - w - m, r.x)); }
  else { left = innerWidth - w - m; top = m; }
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
}
function closePop(cancel = true) {
  if (!pop) return;
  const recording = !!rec;
  if (rec) stopRec(); // the voice note being recorded is kept (it lands in the item a moment later)
  const it = pop._item;
  if (cancel && pop._fresh && S && !String(it.comment || '').trim() && !it.files?.length && !recording) { S.items = S.items.filter((i) => i !== it); save(S); render(); }
  pop.remove(); pop = null;
}
function openPanel() {
  panel?.remove();
  panel = el('div', 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', T.all);
  const items = V ? V.items : S.items;
  const head = el('header'); head.append(el('span', '', V ? `${T.review(V.id)} · ${items.length}` : T.comments(items.length)), btn(T.close, 'ghost', () => { panel.remove(); panel = null; }));
  const body = el('div', 'body');
  if (!V) {
    const who = el('input'); who.placeholder = T.nameOpt; who.value = S.tester || ''; who.setAttribute('aria-label', T.name);
    who.addEventListener('input', () => { S.tester = who.value.trim().slice(0, 60); saveSoon(); });
    body.append(who);
    if (S.sent?.length) { const n = el('div', 'note'); n.append(T.sent); S.sent.slice(-3).forEach((s, k) => { const a = el('a', '', s.id); a.href = s.view; if (k) n.append(' · '); n.append(a); }); body.append(n); }
  }
  const byPage = new Map();
  for (const i of items) { if (!byPage.has(i.page)) byPage.set(i.page, []); byPage.get(i.page).push(i); }
  if (!items.length) body.append(el('p', 'note', T.none));
  for (const [page, list] of byPage) {
    body.append(el('div', 'pg', page));
    for (const i of list) {
      const row = el('div', `it ${statusOf(i)}`);
      const p = el('p', '', i.comment || (i.files?.length ? '' : T.empty)); p.append(el('small', '', `${i.files?.length ? T.withFiles(i.files.length) + ' · ' : ''}${i.kind === 'area' ? T.areaWord : i.anchor.tag}${i._lost ? ' · ' + T.lost : ''} · ${i.device} ${i.vw}×${i.vh}`));
      row.append(el('i', '', String(i.n)), p, btn(T.go, '', () => goTo(i)));
      body.append(row);
    }
  }
  panel.append(head, body); ui.appendChild(panel);
}
function goTo(i) {
  if (i.page === pagePath()) { panel?.remove(); panel = null; focusItem(i.id); return; }
  const u = new URL(i.url, location.origin);
  if (V) { u.search = ''; u.searchParams.set('review', V.id); u.searchParams.set('t', V.t); u.searchParams.set('focus', String(i.n)); }
  u.hash = 'mmixrv=' + i.id;
  location.href = u.href;
}
function focusItem(id) {
  const it = (V ? V.items : S?.items || []).find((i) => i.id === id || String(i.n) === String(id));
  if (!it) return;
  const p = resolve(it);
  scrollTo({ top: Math.max(0, p.y - (innerWidth <= 640 ? 90 : innerHeight / 3)), left: 0, behavior: 'auto' });
  setTimeout(() => { place(); openPop(it, false); }, 60);
}
function exit() {
  closePop(false); panel?.remove(); panel = null;
  if (S) { S.active = false; save(S, 0); }
  hl.style.display = 'none'; document.documentElement.style.touchAction = '';
  render();
}

// ───────────────────────────── sending and viewing
// ───────────────────────────── attachments: add, list, record, upload
async function addFiles(item, list) {
  item.files ||= [];
  for (const f of list) {
    if (!f || !f.size) continue;
    if (item.files.length >= FILES_MAX) { toast(T.tooMany, 4000); break; }
    if (f.size > FILE_MAX) { toast(T.tooBig(f.name || 'file'), 5000); continue; }
    const type = f.type || 'application/octet-stream';
    const meta = { lid: rid(12), name: (f.name || `${kindOf(type)}-${Date.now()}`).slice(0, 120), type, size: f.size, kind: f._kind || kindOf(type), dur: f._dur || 0 };
    try { await blobPut(meta.lid, f); } catch { meta.mem = true; urls.set(meta.lid, URL.createObjectURL(f)); memBlobs.set(meta.lid, f); } // private mode: keep in memory
    item.files.push(meta); item.edited = Date.now();
  }
  save(S);
  if (pop && pop._item === item && pop._att) renderFiles(pop._att, item, false);
  if (bar && !V) { const sb = bar.querySelector('.pri'); if (sb && sb.textContent === T.sendAll) sb.disabled = !unsent(S).length; }
}
const memBlobs = new Map();
function renderFiles(box, item, view) {
  box.textContent = '';
  for (const f of item.files || []) {
    const c = el('div', 'chip');
    const nm = el('span', 'nm', f.kind === 'audio' ? `${T.voiceNote}${f.dur ? ' ' + fmtDur(f.dur) : ''}` : f.name);
    nm.append(el('small', '', fmtSize(f.size || 0)));
    let media = el('span');
    if (f.kind === 'image') { media = el('img'); media.alt = f.name; }
    else if (f.kind === 'video') { media = el('video'); media.muted = true; media.preload = 'metadata'; media.playsInline = true; }
    c.append(media, nm);
    if (view) { const a = el('a', '', '↗'); a.href = f.url; a.target = '_blank'; a.rel = 'noopener'; c.append(a); }
    else c.append(btn(T.remove, 'ghost', () => { if (f.lid) blobDel(f.lid); item.files = item.files.filter((x) => x !== f); item.edited = Date.now(); save(S); renderFiles(box, item, false); if (bar) renderBar(); }));
    if (f.kind === 'audio' || f.kind === 'video') { const m = el(f.kind === 'audio' ? 'audio' : 'video'); m.controls = true; m.preload = 'metadata'; if (f.kind === 'video') { m.playsInline = true; m.style.cssText = 'width:100%;height:auto;max-height:200px;grid-column:1/-1'; } c.append(m); previewUrl(f).then((u) => { m.src = u; }); }
    if (f.kind === 'image') { previewUrl(f).then((u) => { media.src = u; }); media.addEventListener('click', () => previewUrl(f).then((u) => open(u, '_blank'))); }
    if (f.transcript && !f.dict) c.append(el('p', '', `${T.transcript}: ${f.transcript}`)); // a dictation's text is the comment itself
    else if (view && f.kind === 'audio' && f.id) { // text lives on review.mmix.biz for every site (Korvex/Plast packets too)
      fetch(`${DRAFT_HOST}?stt=${encodeURIComponent(f.id)}`).then((r) => r.json()).then((j) => { if (j?.text) { f.transcript = j.text; c.append(el('p', '', `${T.transcript}: ${j.text}`)); } }).catch(() => {});
    }
    box.appendChild(c);
  }
}
// Voice note: MediaRecorder, opus in webm/ogg where the browser has it, mp4/aac on iOS Safari; 3 min max.
let rec = null;
async function startRec(item, b) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { toast(T.noMic, 5000); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined); } catch { stream.getTracks().forEach((t) => t.stop()); toast(T.noMic, 5000); return; }
  const chunks = []; const t0 = Date.now();
  rec = { mr, stream, item, b, t0, timer: 0 };
  mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = (mr.mimeType || mime || 'audio/webm').split(';')[0];
    const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
    const blob = new Blob(chunks, { type });
    const file = new File([blob], `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type });
    file._kind = 'audio'; file._dur = Math.round((Date.now() - t0) / 1000);
    addFiles(item, [file]);
  };
  mr.start(1000);
  b.classList.add('rec');
  const tick = () => { if (!rec) return; const sec = (Date.now() - t0) / 1000; b.lastChild.textContent = `${T.stop} ${fmtDur(sec)}`; if (sec >= VOICE_MAX) stopRec(); };
  tick(); rec.timer = setInterval(tick, 500);
}
function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  clearInterval(r.timer);
  try { r.mr.state !== 'inactive' && r.mr.stop(); } catch {}
  r.b.classList.remove('rec'); r.b.lastChild.textContent = T.voice;
}
// Bytes go up at send time: first the site's own /api/review proxy (first-party), then review.mmix.biz directly.
let fileBase = null; // the endpoint that took the last file: the next ones go there first
async function uploadFile(f) {
  const blob = memBlobs.get(f.lid) || (await blobGet(f.lid));
  if (!blob) return 'missing';
  const qs = new URLSearchParams({ file: '1', site: opts.site, session: S.id, name: f.name, kind: f.kind, dur: String(f.dur || 0) });
  let last = 'network';
  for (const base of [fileBase, opts.endpoint, DRAFT_HOST].filter((u, k, a) => u && a.indexOf(u) === k)) {
    try {
      const r = await fetch(`${base}?${qs}`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: blob });
      const j = await r.json().catch(() => ({}));
      // a proxy that reads the body as text (some Pages functions) mangles the bytes: the size tells, then go direct
      if (r.ok && j.ok && j.kind === 'file' && j.file.size === blob.size) { f.id = j.file.id; f.url = j.file.url; fileBase = base; return 'ok'; }
      if (r.ok && j.ok) { last = 'proxy'; continue; }
      last = j.error || (r.status >= 500 ? 'server' : String(r.status));
      if (r.status === 413 || r.status === 429) break;
    } catch { last = 'network'; }
  }
  throw new Error(last);
}

// Success: the drafts are cleared (here and on the server) and the mode closes by itself.
// Failure: the mode stays, every comment stays, the toast says why and offers Retry.
let sending = false;
async function sendAll() {
  if (sending || !S) return;
  if (pop && pop._item && !V) { const ta = pop.querySelector('textarea'); if (ta) { pop._item.comment = ta.value.trim(); pop._item.edited = Date.now(); } closePop(false); }
  S.items.forEach((i) => { i.comment = String(i.comment || '').trim(); });
  save(S, DRAFT_THROTTLE);
  const items = unsent(S);
  if (!items.length) return;
  sending = true;
  if (rec) stopRec();
  const b = bar?.querySelector('.pri'); if (b) { b.disabled = true; b.textContent = T.sending; }
  let j;
  try {
    const pending = items.flatMap((i) => (i.files || []).filter((f) => !f.url));
    const lost = [];
    for (let k = 0; k < pending.length; k++) {
      if (b) b.textContent = T.uploading(k + 1, pending.length);
      if ((await uploadFile(pending[k])) === 'missing') lost.push(pending[k]);
      save(S, DRAFT_THROTTLE); // uploaded ones are not uploaded twice after a failure
    }
    if (lost.length) { items.forEach((i) => { i.files = (i.files || []).filter((f) => !lost.includes(f)); }); toast(T.missing(lost.map((f) => f.name).join(', ')), 8000); }
    if (b) b.textContent = T.sending;
    const packet = { v: VERSION, site: opts.site, build: opts.build, session: S.id, tester: S.tester, startedAt: S.startedAt, website: '',
      items: items.filter((i) => String(i.comment || '').trim() || i.files?.length)
        .map(({ _lost, edited, files, ...i }) => ({ ...i, files: (files || []).map(({ lid, mem, ...f }) => f) })) };
    if (!packet.items.length) throw new Error('empty');
    let r;
    try { r = await fetch(opts.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet) }); } catch { throw new Error('network'); }
    j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || (r.status >= 500 ? 'server' : String(r.status)));
  } catch (e) {
    sending = false;
    renderBar();
    toast(T.notSent(T.why[e.message] || e.message), 15000, { label: T.retry, run: sendAll });
    return;
  }
  sending = false;
  const first = new URL(items[0].url); first.search = ''; first.hash = '';
  first.searchParams.set('review', j.id); first.searchParams.set('t', j.viewToken);
  const ids = new Set(items.map((i) => i.id));
  S.sent = [...(S.sent || []), { id: j.id, view: first.href, at: Date.now(), n: items.length, items: [...ids] }].slice(-10);
  items.forEach((i) => (i.files || []).forEach((f) => { if (f.lid) blobDel(f.lid); if (urls.has(f.lid)) { URL.revokeObjectURL(urls.get(f.lid)); urls.delete(f.lid); } }));
  S.items = S.items.filter((i) => !ids.has(i.id) && (String(i.comment || '').trim() || i.files?.length)); // empty markers go too
  S.seq = S.items.reduce((m, i) => Math.max(m, i.n), 0);
  const a = el('a', '', T.openReview); a.href = first.href; a.style.color = '#FFD60A';
  const msg = el('span'); msg.append(T.sentN(items.length), a);
  if (EDITOR) {
    const e = await fetch(`${opts.editor}/requests`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', packetId: j.id, t: j.viewToken }) }).then((x) => x.json()).catch(() => ({}));
    const ed = el('a', '', T.editor); ed.href = '/admin/'; ed.style.color = '#FFD60A';
    if (e.ok) msg.append(T.editOk); else msg.append(T.editFail, ed, '.');
    // The host page's editor panel (if any) opens on this and shows the new request.
    if (e.ok) window.dispatchEvent(new CustomEvent('mmixreview:edit-request', { detail: { id: e.id } }));
  }
  // the server copy goes right away (a backend of its own, like Korvex, never tells review.mmix.biz the packet is in)
  clearTimeout(draftT); draftT = 0;
  if (draftUrl && !draftOff) { const body = draftBody(); const key = draftKey(S.tester, draftItems());
    await fetch(draftUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).then((r) => { if (r.ok) draftSent = key; }, () => {}); }
  if (S.items.length) { save(S, 0); render(); } else exit(); // the mode closes: no extra Exit click
  window.dispatchEvent(new CustomEvent('mmixreview:sent', { detail: { id: j.id, n: items.length } }));
  toast(msg, 8000);
}
async function startView(id, t, focus) {
  try {
    const r = await fetch(`${opts.endpoint}?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`);
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    V = { ...j.packet, t, focus };
  } catch (e) { toast(T.noLoad(id, e.message), 8000); return; }
  bind(); render();
  document.documentElement.setAttribute('data-mmixrv-ready', String(visibleItems().length));
  if (focus) setTimeout(() => focusItem(focus), 300);
}
async function setStatus(item, status) {
  try {
    const r = await fetch(opts.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', id: V.id, t: V.t, itemId: item.id, status }) });
    const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    V.statuses = j.statuses; closePop(false); render();
  } catch (e) { toast(T.noStatus(e.message)); }
}

// Script-tag use (no bundler): <script type="module" src="/review-kit/review.js"> exposes the API.
window.MMIXReview = { start, resume, version: VERSION };
window.dispatchEvent(new CustomEvent('mmixreview:ready'));
