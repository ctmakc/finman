// public/js/my-ai.js — "Your AI": the person's own ChatGPT / Claude / Gemini / … key
// and an assistant that works on their Finman data.
//
// API: /api/ai/my (routes/userAi.js). The key goes up once (password field) and comes
// back only as a mask. Every change to data arrives as a confirmation slip; nothing is
// written until the person presses Confirm. All text from the model and from the
// server is put into the page as DOM text (textContent), never as HTML.
//
// Exposes window.MyAiModule.init(); app.js mounts it on the `my-ai` route.
(function () {
  'use strict';

  const API = '/api/ai/my';

  function tr(key, vars) {
    const v = (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, vars) : key;
    return v == null ? key : v;
  }
  function lang() {
    try { return (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || 'en'; } catch (e) { return 'en'; }
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function icon(name) {
    const i = el('i', 'fas ' + name);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  function btn(label, cls, onClick, iconName) {
    const b = el('button', 'btn ' + (cls || ''));
    b.type = 'button';
    if (iconName) b.appendChild(icon(iconName));
    b.appendChild(document.createTextNode((iconName ? ' ' : '') + label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function toast(msg, kind) {
    if (typeof window.showNotification === 'function') window.showNotification(msg, kind || 'info');
  }
  function go(page) {
    if (typeof window.navigateTo === 'function') window.navigateTo(page);
    else location.href = '/' + page;
  }

  async function api(path, opts) {
    const o = opts || {};
    const headers = { Authorization: 'Bearer ' + (localStorage.getItem('token') || ''), 'Accept-Language': lang() };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, { method: o.method || 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    } catch (e) {
      const err = new Error(tr('myai.err.network')); err.code = 'NETWORK'; throw err;
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok || (body && body.error === true)) {
      const err = new Error((body && body.message) || tr('myai.err.generic'));
      err.code = (body && body.code) || 'HTTP_' + res.status;
      err.status = res.status;
      err.threadId = body && body.thread_id;
      throw err;
    }
    return body || {};
  }

  // Friendly line for a server/provider error code.
  function errorText(e) {
    const known = {
      AI_BUSY: 'myai.err.busy', AI_RATE_LIMIT: 'myai.err.rateLimit', AI_KEY_REJECTED: 'myai.err.keyRejected',
      AI_MODEL_NOT_FOUND: 'myai.err.model', AI_TIMEOUT: 'myai.err.timeout', AI_UNREACHABLE: 'myai.err.unreachable',
      AI_NO_KEY: 'myai.err.noKey', AI_SLOW_DOWN: 'myai.err.slowDown', AI_ACTION_DONE: 'myai.err.answered',
      NETWORK: 'myai.err.network',
    };
    const k = e && known[e.code];
    if (k) return tr(k);
    return (e && e.message) || tr('myai.err.generic');
  }

  // Markdown-light answer (bold, lists, paragraphs) as DOM nodes. Shares the AI CFO renderer.
  function rich(node, text) {
    const r = window.AiCfoModule && window.AiCfoModule.renderRich;
    if (typeof r === 'function') r.call(window.AiCfoModule, node, text);
    else node.textContent = String(text || '');
  }

  const FIELD_KEYS = {
    amount: 'myai.f.amount', type: 'myai.f.type', date: 'myai.f.date', description: 'myai.f.description',
    category: 'myai.f.category', account_id: 'myai.f.account', transaction_id: 'myai.f.transaction',
    invoice_id: 'myai.f.invoice', client_id: 'myai.f.client', status: 'myai.f.status', name: 'myai.f.name', email: 'myai.f.email',
  };
  const STATUS_KEYS = { done: 'myai.st.done', auto: 'myai.st.auto', declined: 'myai.st.declined', failed: 'myai.st.failed', running: 'myai.st.running', pending: 'myai.st.pending' };

  const MyAiModule = {
    providers: [],
    keys: [],
    threads: [],
    view: null,      // current thread view from the server
    threadId: null,
    busy: false,
    picked: null,    // provider chosen in the add-key form
    adding: false,
    lastFailed: null, // text of a message whose answer failed (for Retry)

    async init() {
      const host = document.getElementById('main-content');
      if (!host) return;
      host.textContent = '';
      this.root = el('section', 'ya');
      this.root.setAttribute('aria-labelledby', 'ya-title');
      host.appendChild(this.root);
      this.root.appendChild(this.headNode());
      this.body = el('div', 'ya-body');
      this.root.appendChild(this.body);
      this.body.appendChild(el('div', 'ya-loading', tr('common.loading')));
      try {
        const [p, k, th] = await Promise.all([api('/providers'), api('/keys'), api('/threads')]);
        this.providers = p.providers || [];
        this.keys = k.keys || [];
        this.threads = th.threads || [];
      } catch (e) {
        this.body.textContent = '';
        const box = el('div', 'ya-plate ya-error-plate');
        box.appendChild(el('p', '', errorText(e)));
        box.appendChild(btn(tr('myai.retry'), 'btn-primary', () => this.init()));
        this.body.appendChild(box);
        return;
      }
      if (this.threads.length && !this.threadId) this.threadId = this.threads[0].id;
      this.render();
      if (this.threadId && this.keys.length) this.openThread(this.threadId, true);
    },

    headNode() {
      const head = el('header', 'ya-head');
      const left = el('div', 'ya-head-text');
      const h = el('h1', 'ya-title', tr('myai.title'));
      h.id = 'ya-title';
      left.appendChild(h);
      left.appendChild(el('p', 'ya-sub', tr('myai.sub')));
      head.appendChild(left);
      const link = btn(tr('myai.toConnect'), 'ya-head-link', () => go('connect-ai'), 'fa-plug');
      head.appendChild(link);
      return head;
    },

    render() {
      this.body.textContent = '';
      if (!this.keys.length || this.adding) {
        this.body.appendChild(this.startNode());
        return;
      }
      const grid = el('div', 'ya-grid');
      grid.appendChild(this.chatNode());
      const side = el('aside', 'ya-side');
      side.setAttribute('aria-label', tr('myai.sideAria'));
      side.appendChild(this.keysNode());
      side.appendChild(this.threadsNode());
      side.appendChild(this.privacyNode());
      grid.appendChild(side);
      this.body.appendChild(grid);
      this.renderLog();
    },

    // ---------------- first run / add a key ----------------
    startNode() {
      const wrap = el('div', 'ya-start');
      const hero = el('div', 'ya-plate ya-hero');
      const copy = el('div', 'ya-hero-copy');
      copy.appendChild(el('h2', 'ya-hero-title', this.keys.length ? tr('myai.addAnother') : tr('myai.hero.title')));
      copy.appendChild(el('p', 'ya-hero-lead', tr('myai.hero.lead')));
      const pts = el('ul', 'ya-points');
      [['fa-lock', 'myai.hero.p1'], ['fa-hand-paper', 'myai.hero.p2'], ['fa-receipt', 'myai.hero.p3']].forEach(([ic, k]) => {
        const li = el('li');
        li.appendChild(icon(ic));
        li.appendChild(el('span', '', tr(k)));
        pts.appendChild(li);
      });
      copy.appendChild(pts);
      hero.appendChild(copy);
      const pic = el('picture', 'ya-hero-pic');
      ['', '-dark'].forEach((v) => {
        const img = el('img', v ? 'pic-d' : 'pic-l');
        img.src = '/img/connect/your-ai' + v + '.webp';
        img.alt = tr('myai.hero.alt');
        img.width = 900; img.height = 900;
        img.loading = 'lazy'; img.decoding = 'async';
        pic.appendChild(img);
      });
      hero.appendChild(pic);
      wrap.appendChild(hero);

      const pick = el('div', 'ya-plate ya-pick');
      pick.appendChild(el('h2', 'ya-h2', tr('myai.pick.title')));
      const grid = el('div', 'ya-providers');
      grid.setAttribute('role', 'radiogroup');
      grid.setAttribute('aria-label', tr('myai.pick.title'));
      this.providers.forEach((p) => {
        const b = el('button', 'ya-prov' + (this.picked === p.id ? ' is-on' : ''));
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', this.picked === p.id ? 'true' : 'false');
        b.dataset.provider = p.id;
        const mono = el('span', 'ya-prov-mono', (p.short || p.name || '?').slice(0, 2));
        mono.setAttribute('aria-hidden', 'true');
        b.appendChild(mono);
        const t = el('span', 'ya-prov-text');
        t.appendChild(el('span', 'ya-prov-name', p.id === 'custom' ? tr('myai.custom') : (p.brand || p.name)));
        t.appendChild(el('span', 'ya-prov-hint', p.id === 'custom' ? tr('myai.customHint') : (p.vendor || '')));
        if (p.free) t.appendChild(el('span', 'ya-chip ya-chip-pos', tr('myai.free')));
        b.appendChild(t);
        b.addEventListener('click', () => { this.picked = p.id; this.render(); const f = document.getElementById('ya-key'); if (f) f.focus(); });
        grid.appendChild(b);
      });
      pick.appendChild(grid);
      if (this.picked) pick.appendChild(this.keyForm());
      if (this.keys.length) {
        const back = btn(tr('myai.back'), 'btn-ghost ya-back', () => { this.adding = false; this.picked = null; this.render(); }, 'fa-arrow-left');
        pick.appendChild(back);
      }
      wrap.appendChild(pick);
      return wrap;
    },

    keyForm() {
      const p = this.providers.find((x) => x.id === this.picked) || {};
      const form = el('form', 'ya-keyform');
      form.noValidate = true;
      const name = p.id === 'custom' ? tr('myai.custom') : (p.brand || p.name);
      form.appendChild(el('h3', 'ya-h3', tr('myai.form.title', { name })));
      if (p.keyUrl) {
        const how = el('p', 'ya-how');
        how.appendChild(document.createTextNode(tr('myai.form.getKey') + ' '));
        const a = el('a', '', p.keyUrl.replace(/^https:\/\//, ''));
        a.href = p.keyUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
        how.appendChild(a);
        form.appendChild(how);
      }
      const field = (id, label, input, hint) => {
        const f = el('div', 'ya-field');
        const l = el('label', '', label);
        l.htmlFor = id;
        f.appendChild(l);
        input.id = id;
        input.className = 'form-control';
        f.appendChild(input);
        if (hint) f.appendChild(el('p', 'ya-hint', hint));
        form.appendChild(f);
        return input;
      };
      if (p.id === 'custom') {
        const u = el('input'); u.type = 'url'; u.placeholder = 'https://api.example.com/v1'; u.autocomplete = 'off'; u.spellcheck = false;
        field('ya-base', tr('myai.form.baseUrl'), u, tr('myai.form.baseHint'));
      }
      const k = el('input'); k.type = 'password'; k.autocomplete = 'off'; k.spellcheck = false; k.required = true;
      k.setAttribute('autocapitalize', 'off');
      k.placeholder = p.keyPlaceholder || tr('myai.form.keyPh');
      field('ya-key', tr('myai.form.key'), k, tr('myai.form.keyHint'));
      const lb = el('input'); lb.type = 'text'; lb.maxLength = 60; lb.placeholder = tr('myai.form.labelPh');
      field('ya-label', tr('myai.form.label'), lb);
      const err = el('p', 'ya-form-err');
      err.setAttribute('role', 'alert');
      form.appendChild(err);
      const row = el('div', 'ya-form-row');
      const save = el('button', 'btn btn-primary', tr('myai.form.save'));
      save.type = 'submit';
      row.appendChild(save);
      form.appendChild(row);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (save.disabled) return;
        err.textContent = '';
        save.disabled = true;
        save.textContent = tr('myai.form.checking');
        try {
          const base = document.getElementById('ya-base');
          const out = await api('/keys', { method: 'POST', body: { provider: p.id, key: k.value, label: lb.value, base_url: base ? base.value : undefined } });
          k.value = '';
          this.keys = (await api('/keys')).keys || [out.key];
          this.adding = false; this.picked = null;
          toast(tr('myai.form.saved', { name }), 'success');
          this.render();
          const input = document.getElementById('ya-input');
          if (input) input.focus();
        } catch (ex) {
          err.textContent = errorText(ex);
          save.disabled = false;
          save.textContent = tr('myai.form.save');
        }
      });
      return form;
    },

    // ---------------- side column ----------------
    keysNode() {
      const plate = el('section', 'ya-plate ya-keys');
      plate.setAttribute('aria-labelledby', 'ya-keys-h');
      const head = el('div', 'ya-plate-head');
      const h = el('h2', 'ya-h2', tr('myai.keys.title')); h.id = 'ya-keys-h';
      head.appendChild(h);
      head.appendChild(btn(tr('myai.keys.add'), 'btn-sm ya-tint', () => { this.adding = true; this.picked = null; this.render(); }, 'fa-plus'));
      plate.appendChild(head);
      const list = el('ul', 'ya-keylist');
      this.keys.forEach((k) => list.appendChild(this.keyRow(k)));
      plate.appendChild(list);
      return plate;
    },

    keyRow(k) {
      const li = el('li', 'ya-key' + (k.is_default ? ' is-default' : ''));
      const top = el('div', 'ya-key-top');
      const mono = el('span', 'ya-prov-mono is-sm', (k.provider_name || k.provider).slice(0, 2));
      mono.setAttribute('aria-hidden', 'true');
      top.appendChild(mono);
      const id = el('div', 'ya-key-id');
      id.appendChild(el('span', 'ya-key-name', k.label || k.provider_name));
      const sub = el('span', 'ya-key-sub');
      if (k.label) sub.appendChild(el('span', 'ya-key-prov', k.provider_name));
      sub.appendChild(el('span', 'ya-key-mask', k.key_mask));
      id.appendChild(sub);
      top.appendChild(id);
      if (k.is_default) top.appendChild(el('span', 'ya-chip', tr('myai.keys.default')));
      li.appendChild(top);

      const ms = el('select', 'form-control ya-model');
      ms.setAttribute('aria-label', tr('myai.keys.model', { name: k.label || k.provider_name }));
      const cur = el('option', '', k.model); cur.value = k.model; cur.selected = true;
      ms.appendChild(cur);
      let loaded = false;
      const load = async () => {
        if (loaded) return; loaded = true;
        const wait = el('option', '', tr('myai.keys.loadingModels')); wait.disabled = true;
        ms.appendChild(wait);
        try {
          const out = await api('/keys/' + k.id + '/models');
          ms.textContent = '';
          const list = (out.models || []).slice();
          if (!list.find((m) => m.id === k.model)) list.unshift({ id: k.model, name: k.model });
          list.forEach((m) => {
            const o = el('option', '', m.name && m.name !== m.id ? m.name + ' — ' + m.id : m.id);
            o.value = m.id; o.selected = m.id === k.model;
            ms.appendChild(o);
          });
        } catch (e) {
          wait.remove(); loaded = false;
          toast(errorText(e), 'error');
        }
      };
      ms.addEventListener('focus', load);
      ms.addEventListener('pointerdown', load);
      ms.addEventListener('change', async () => {
        try {
          const out = await api('/keys/' + k.id, { method: 'PATCH', body: { model: ms.value } });
          Object.assign(k, out.key);
          toast(tr('myai.keys.modelSaved', { model: k.model }), 'success');
        } catch (e) { toast(errorText(e), 'error'); }
      });
      li.appendChild(ms);

      if (k.last_error) li.appendChild(el('p', 'ya-key-err', tr('myai.keys.lastError') + ' ' + k.last_error));

      const acts = el('div', 'ya-key-acts');
      if (!k.is_default) {
        acts.appendChild(btn(tr('myai.keys.makeDefault'), 'btn-sm btn-ghost', async () => {
          try { await api('/keys/' + k.id, { method: 'PATCH', body: { is_default: true } }); this.keys = (await api('/keys')).keys || []; this.render(); }
          catch (e) { toast(errorText(e), 'error'); }
        }));
      }
      const del = btn(tr('myai.keys.delete'), 'btn-sm btn-ghost ya-danger', async () => {
        if (!window.confirm(tr('myai.keys.confirmDelete', { name: k.label || k.provider_name }))) return;
        try {
          await api('/keys/' + k.id, { method: 'DELETE' });
          this.keys = (await api('/keys')).keys || [];
          toast(tr('myai.keys.deleted'), 'success');
          this.render();
        } catch (e) { toast(errorText(e), 'error'); }
      }, 'fa-trash-alt');
      acts.appendChild(del);
      li.appendChild(acts);
      return li;
    },

    threadsNode() {
      const plate = el('section', 'ya-plate ya-threads');
      plate.setAttribute('aria-labelledby', 'ya-th-h');
      const head = el('div', 'ya-plate-head');
      const h = el('h2', 'ya-h2', tr('myai.threads.title')); h.id = 'ya-th-h';
      head.appendChild(h);
      head.appendChild(btn(tr('myai.threads.new'), 'btn-sm ya-tint', () => this.newChat(), 'fa-pen'));
      plate.appendChild(head);
      if (!this.threads.length) {
        plate.appendChild(el('p', 'ya-muted', tr('myai.threads.empty')));
        return plate;
      }
      const list = el('ul', 'ya-thlist');
      this.threads.slice(0, 20).forEach((th) => {
        const li = el('li', 'ya-th' + (th.id === this.threadId ? ' is-on' : ''));
        const open = el('button', 'ya-th-open', th.title || tr('myai.threads.untitled'));
        open.type = 'button';
        if (th.id === this.threadId) open.setAttribute('aria-current', 'true');
        open.addEventListener('click', () => this.openThread(th.id));
        li.appendChild(open);
        const del = el('button', 'ya-th-del');
        del.type = 'button';
        del.setAttribute('aria-label', tr('myai.threads.delete', { title: th.title || '' }));
        del.appendChild(icon('fa-times'));
        del.addEventListener('click', async () => {
          if (!window.confirm(tr('myai.threads.confirmDelete'))) return;
          try {
            await api('/threads/' + th.id, { method: 'DELETE' });
            this.threads = this.threads.filter((x) => x.id !== th.id);
            if (this.threadId === th.id) { this.threadId = null; this.view = null; }
            this.render();
          } catch (e) { toast(errorText(e), 'error'); }
        });
        li.appendChild(del);
        list.appendChild(li);
      });
      plate.appendChild(list);
      return plate;
    },

    privacyNode() {
      const p = el('section', 'ya-note');
      p.appendChild(icon('fa-shield-alt'));
      p.appendChild(el('p', '', tr('myai.privacy')));
      return p;
    },

    // ---------------- chat ----------------
    chatNode() {
      const chat = el('section', 'ya-plate ya-chat');
      chat.setAttribute('aria-label', tr('myai.chat.aria'));
      this.log = el('div', 'ya-log');
      this.log.setAttribute('aria-live', 'polite');
      this.log.setAttribute('aria-relevant', 'additions');
      chat.appendChild(this.log);

      const form = el('form', 'ya-compose');
      const ta = el('textarea', 'form-control ya-input');
      ta.id = 'ya-input';
      ta.rows = 1;
      ta.maxLength = 8000;
      ta.placeholder = tr('myai.chat.placeholder');
      ta.setAttribute('aria-label', tr('myai.chat.inputAria'));
      ta.setAttribute('enterkeyhint', 'send');
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
      ta.addEventListener('input', grow);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
      });
      form.appendChild(ta);
      const bar = el('div', 'ya-compose-bar');
      if (this.keys.length > 1) {
        const sel = el('select', 'form-control ya-who');
        sel.id = 'ya-who';
        sel.setAttribute('aria-label', tr('myai.chat.who'));
        const cur = (this.view && this.view.thread.key && this.view.thread.key.id) || (this.keys.find((k) => k.is_default) || this.keys[0]).id;
        this.keys.forEach((k) => { const o = el('option', '', (k.label || k.provider_name) + ' · ' + k.model); o.value = k.id; o.selected = k.id === cur; sel.appendChild(o); });
        bar.appendChild(sel);
      } else {
        const k = this.keys[0];
        bar.appendChild(el('span', 'ya-who-one', (k.label || k.provider_name) + ' · ' + k.model));
      }
      const send = el('button', 'btn btn-primary ya-send');
      send.type = 'submit';
      send.appendChild(icon('fa-arrow-up'));
      send.appendChild(el('span', '', ' ' + tr('myai.chat.send')));
      bar.appendChild(send);
      form.appendChild(bar);
      form.addEventListener('submit', (e) => { e.preventDefault(); this.send(ta.value); });
      chat.appendChild(form);
      return chat;
    },

    renderLog() {
      if (!this.log) return;
      this.log.textContent = '';
      const msgs = (this.view && this.view.messages) || [];
      if (!msgs.length) {
        const empty = el('div', 'ya-empty');
        empty.appendChild(el('p', 'ya-empty-title', tr('myai.chat.emptyTitle')));
        empty.appendChild(el('p', 'ya-muted', tr('myai.chat.emptyLead')));
        const sug = el('div', 'ya-suggest');
        ['myai.s1', 'myai.s2', 'myai.s3', 'myai.s4'].forEach((k) => {
          const b = el('button', 'ya-suggest-btn', tr(k));
          b.type = 'button';
          b.addEventListener('click', () => this.send(tr(k)));
          sug.appendChild(b);
        });
        empty.appendChild(sug);
        this.log.appendChild(empty);
      }
      msgs.forEach((m) => this.log.appendChild(this.msgNode(m)));
      if (this.busy) this.log.appendChild(this.typingNode());
      if (this.error) this.log.appendChild(this.errorNode(this.error));
      this.log.scrollTop = this.log.scrollHeight;
    },

    msgNode(m) {
      const row = el('div', 'ya-msg is-' + m.role);
      if (m.role === 'user') {
        row.appendChild(el('div', 'ya-bubble', m.text));
        return row;
      }
      if (m.text && m.text !== '…') {
        const b = el('div', 'ya-answer');
        rich(b, m.text);
        row.appendChild(b);
      }
      if (m.note === 'step_limit') row.appendChild(el('p', 'ya-muted', tr('myai.chat.stepLimit')));
      const used = (m.actions || []).filter((a) => a.status === 'auto');
      const slips = (m.actions || []).filter((a) => a.status !== 'auto');
      if (used.length) {
        const u = el('p', 'ya-used');
        u.appendChild(icon('fa-search'));
        u.appendChild(document.createTextNode(' ' + tr('myai.chat.used') + ' ' + used.map((a) => a.title).join(' · ')));
        row.appendChild(u);
      }
      slips.forEach((a) => row.appendChild(this.slipNode(a)));
      return row;
    },

    // The signature: a confirmation slip for every change the AI wants to make.
    slipNode(a) {
      const slip = el('div', 'ya-slip is-' + a.status);
      const head = el('div', 'ya-slip-head');
      head.appendChild(el('span', 'ya-slip-title', a.title));
      head.appendChild(el('span', 'ya-chip ya-st-' + a.status, tr(STATUS_KEYS[a.status] || 'myai.st.pending')));
      slip.appendChild(head);
      if (a.fields && a.fields.length) {
        const dl = el('dl', 'ya-slip-rows');
        a.fields.forEach(([k, v]) => {
          const r = el('div', 'ya-slip-row');
          r.appendChild(el('dt', '', FIELD_KEYS[k] ? tr(FIELD_KEYS[k]) : k));
          let shown = v;
          if (k === 'type') shown = tr('myai.type.' + v) === 'myai.type.' + v ? v : tr('myai.type.' + v);
          else if (k === 'amount' && Number.isFinite(Number(v))) {
            try { shown = new Intl.NumberFormat(lang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v)); } catch (e) { shown = Number(v).toFixed(2); }
          }
          r.appendChild(el('dd', k === 'amount' ? 'is-num' : '', shown));
          dl.appendChild(r);
        });
        slip.appendChild(dl);
      }
      if (a.needs_confirm) {
        slip.appendChild(el('p', 'ya-slip-ask', tr('myai.slip.ask')));
        const acts = el('div', 'ya-slip-acts');
        const yes = btn(tr('myai.slip.confirm'), 'btn-primary', () => this.answer(a.id, true, [yes, no]), 'fa-check');
        const no = btn(tr('myai.slip.decline'), '', () => this.answer(a.id, false, [yes, no]));
        acts.appendChild(yes); acts.appendChild(no);
        slip.appendChild(acts);
      } else if (a.status === 'failed' && a.result_preview) {
        slip.appendChild(el('p', 'ya-slip-err', a.result_preview.slice(0, 240)));
      }
      return slip;
    },

    typingNode() {
      const row = el('div', 'ya-msg is-assistant ya-typing');
      row.setAttribute('aria-label', tr('myai.chat.thinking'));
      const dots = el('span', 'ya-dots');
      dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
      row.appendChild(dots);
      row.appendChild(el('span', 'ya-muted', tr('myai.chat.thinking')));
      return row;
    },

    errorNode(e) {
      const box = el('div', 'ya-msg is-assistant');
      const p = el('div', 'ya-alert');
      p.setAttribute('role', 'alert');
      p.appendChild(el('p', '', errorText(e)));
      const acts = el('div', 'ya-alert-acts');
      if (this.lastFailed && this.retryThread) acts.appendChild(btn(tr('myai.retry'), 'btn-sm btn-primary', () => this.retry(), 'fa-redo'));
      if (['AI_BUSY', 'AI_MODEL_NOT_FOUND', 'AI_RATE_LIMIT'].includes(e.code)) {
        acts.appendChild(btn(tr('myai.err.switchModel'), 'btn-sm', () => { const s = document.querySelector('.ya-model'); if (s) { s.focus(); s.scrollIntoView({ block: 'center' }); } }));
      }
      if (acts.children.length) p.appendChild(acts);
      box.appendChild(p);
      return box;
    },

    setBusy(on) {
      this.busy = on;
      const send = document.querySelector('.ya-send');
      if (send) send.disabled = on;
      this.root.querySelectorAll('.ya-slip-acts .btn').forEach((b) => { b.disabled = on; });
    },

    retry() { this.send(this.lastFailed, true); },

    async send(text, isRetry) {
      const msg = String(text || '').trim();
      if (!msg || this.busy) return;
      const ta = document.getElementById('ya-input');
      if (ta && !isRetry) { ta.value = ''; ta.style.height = 'auto'; }
      this.error = null;
      // Show the message at once; the server returns the whole thread after the answer.
      if (!this.view) this.view = { thread: { id: null }, messages: [] };
      if (!isRetry) this.view.messages = this.view.messages.concat([{ id: 'local', role: 'user', text: msg, actions: [] }]);
      this.setBusy(true);
      this.renderLog();
      const who = document.getElementById('ya-who');
      const body = isRetry
        ? { thread_id: this.retryThread, retry: true, key_id: who ? Number(who.value) : undefined, locale: lang() }
        : { thread_id: this.threadId, message: msg, key_id: who ? Number(who.value) : undefined, locale: lang() };
      try {
        const out = await api('/chat', { method: 'POST', body });
        this.lastFailed = null; this.retryThread = null;
        this.view = out;
        const isNew = this.threadId !== out.thread.id;
        this.threadId = out.thread.id;
        if (isNew) await this.refreshThreads();
      } catch (e) {
        this.error = e;
        this.lastFailed = msg;
        if (e.threadId) {
          this.threadId = e.threadId; this.retryThread = e.threadId;
          await this.refreshThreads();
        }
        if (e.code === 'AI_KEY_REJECTED' || e.code === 'AI_BUSY') this.keys = (await api('/keys').catch(() => ({ keys: this.keys }))).keys;
      }
      this.setBusy(false);
      this.render();
      const input = document.getElementById('ya-input');
      if (input && !this.error) input.focus();
    },

    async answer(actionId, approve, buttons) {
      if (this.busy) return;
      (buttons || []).forEach((b) => { b.disabled = true; });
      this.error = null;
      this.setBusy(true);
      this.renderLog();
      try {
        const out = await api('/actions/' + actionId, { method: 'POST', body: { approve, locale: lang() } });
        this.view = out;
        if (out.error) this.error = { code: out.error.code, message: out.error.message };
        if (approve) toast(tr('myai.slip.done'), 'success');
      } catch (e) {
        this.error = e;
        if (e.code === 'AI_ACTION_DONE' && this.threadId) {
          try { this.view = await api('/threads/' + this.threadId); } catch (x) { /* keep */ }
        }
      }
      this.setBusy(false);
      this.renderLog();
    },

    async refreshThreads() {
      try { this.threads = (await api('/threads')).threads || []; } catch (e) { /* keep the old list */ }
    },

    async openThread(id, quiet) {
      this.threadId = id; this.error = null; this.lastFailed = null; this.retryThread = null;
      try {
        this.view = await api('/threads/' + id);
      } catch (e) {
        this.view = null;
        if (!quiet) toast(errorText(e), 'error');
      }
      this.render();
    },

    newChat() {
      this.threadId = null; this.view = null; this.error = null; this.lastFailed = null; this.retryThread = null;
      this.render();
      const input = document.getElementById('ya-input');
      if (input) input.focus();
    },
  };

  window.MyAiModule = MyAiModule;
})();
