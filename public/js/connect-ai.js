// public/js/connect-ai.js — "Connect to AI": use Finman from ChatGPT, Claude, Gemini,
// Cursor, VS Code and other MCP apps. Step-by-step per app, the MCP address with a copy
// button, one-click install links where the app has them, and the list of apps already
// connected (from /api/mcp/connections, with Disconnect).
//
// Exposes window.ConnectAiModule.init(); app.js mounts it on the `connect-ai` route.
(function () {
  'use strict';

  function tr(key, vars) {
    const v = (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, vars) : key;
    return v == null ? key : v;
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
  function toast(msg, kind) {
    if (typeof window.showNotification === 'function') window.showNotification(msg, kind || 'info');
  }
  function go(page) {
    if (typeof window.navigateTo === 'function') window.navigateTo(page);
    else location.href = '/' + page;
  }
  function authHeaders() {
    return { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') };
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.className = 'sr-only'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (x) { /* nothing more to try */ }
      ta.remove();
    }
    toast(tr('connect.copied'), 'success');
  }
  function b64(s) {
    try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return btoa(s); }
  }

  const mcpUrl = () => location.origin + '/mcp';

  // Text with **bold** UI labels and {url} / {code} placeholders → DOM nodes.
  function line(parent, text, slots) {
    String(text).split(/(\*\*[^*]+\*\*|\{\w+\})/).forEach((part) => {
      if (!part) return;
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      const slot = part.match(/^\{(\w+)\}$/);
      if (bold) parent.appendChild(el('strong', '', bold[1]));
      else if (slot && slots && slots[slot[1]]) parent.appendChild(slots[slot[1]]());
      else parent.appendChild(document.createTextNode(part));
    });
    return parent;
  }

  function urlChip() {
    const wrap = el('span', 'ca-chip');
    wrap.appendChild(el('code', '', mcpUrl()));
    const b = el('button', 'ca-chip-copy');
    b.type = 'button';
    b.setAttribute('aria-label', tr('connect.copyUrl'));
    b.appendChild(icon('fa-copy'));
    b.addEventListener('click', () => copy(mcpUrl()));
    wrap.appendChild(b);
    return wrap;
  }

  function codeBlock(text) {
    const box = el('div', 'ca-code');
    box.appendChild(el('pre', '', text));
    const b = el('button', 'btn btn-sm ca-code-copy');
    b.type = 'button';
    b.appendChild(icon('fa-copy'));
    b.appendChild(document.createTextNode(' ' + tr('connect.copy')));
    b.addEventListener('click', () => copy(text));
    box.appendChild(b);
    return box;
  }

  function linkBtn(label, href, primary, iconName) {
    const a = el('a', 'btn ' + (primary ? 'btn-primary' : ''));
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    if (iconName) a.appendChild(icon(iconName));
    a.appendChild(document.createTextNode((iconName ? ' ' : '') + label));
    return a;
  }

  // Each app: tab label, a note on where it works, ordered steps, optional buttons,
  // code blocks and a screenshot. Step texts live in the locale files.
  function apps() {
    const url = mcpUrl();
    const cursorCfg = b64(JSON.stringify({ url }));
    const vsCfg = encodeURIComponent(JSON.stringify({ name: 'finman', type: 'http', url }));
    return [
      {
        id: 'chatgpt', name: 'ChatGPT', note: 'connect.chatgpt.note',
        steps: ['connect.chatgpt.s1', 'connect.chatgpt.s2', 'connect.chatgpt.s3', 'connect.chatgpt.s4', 'connect.chatgpt.s5'],
        links: [[tr('connect.chatgpt.open'), 'https://chatgpt.com/plugins', true, 'fa-external-link-alt']],
        shot: { src: '/img/connect/chatgpt.webp', alt: 'connect.chatgpt.shotAlt' },
      },
      {
        id: 'claude', name: 'Claude', note: 'connect.claude.note',
        steps: ['connect.claude.s1', 'connect.claude.s2', 'connect.claude.s3', 'connect.claude.s4'],
        links: [[tr('connect.claude.open'), 'https://claude.ai/settings/connectors', true, 'fa-external-link-alt']],
        shot: { src: '/img/connect/claude.webp', alt: 'connect.claude.shotAlt' },
      },
      {
        id: 'gemini', name: 'Gemini', note: 'connect.gemini.note',
        steps: ['connect.gemini.s1', 'connect.gemini.s2', 'connect.gemini.s3'],
        links: [[tr('connect.gemini.open'), 'https://gemini.google.com/', false, 'fa-external-link-alt']],
        extra: [
          ['connect.gemini.cli', 'gemini mcp add --transport http finman ' + url + '\n# then inside Gemini CLI:\n/mcp auth finman'],
          ['connect.gemini.agy', JSON.stringify({ mcpServers: { finman: { serverUrl: url } } }, null, 2)],
        ],
      },
      {
        id: 'cursor', name: 'Cursor', note: 'connect.cursor.note',
        steps: ['connect.cursor.s1', 'connect.cursor.s2', 'connect.cursor.s3'],
        links: [[tr('connect.cursor.install'), 'cursor://anysphere.cursor-deeplink/mcp/install?name=finman&config=' + encodeURIComponent(cursorCfg), true, 'fa-bolt']],
        extra: [['connect.cursor.manual', JSON.stringify({ mcpServers: { finman: { url } } }, null, 2)]],
      },
      {
        id: 'vscode', name: 'VS Code', note: 'connect.vscode.note',
        steps: ['connect.vscode.s1', 'connect.vscode.s2', 'connect.vscode.s3'],
        links: [
          [tr('connect.vscode.install'), 'vscode:mcp/install?' + vsCfg, true, 'fa-bolt'],
          [tr('connect.vscode.insiders'), 'vscode-insiders:mcp/install?' + vsCfg, false],
        ],
        extra: [['connect.vscode.manual', JSON.stringify({ servers: { finman: { type: 'http', url } } }, null, 2)]],
      },
      {
        id: 'claude-code', name: 'Claude Code', note: 'connect.cc.note',
        steps: ['connect.cc.s1', 'connect.cc.s2'],
        extra: [['connect.cc.cmd', 'claude mcp add --transport http finman ' + url + '\n# then inside Claude Code:\n/mcp']],
      },
      {
        id: 'other', name: tr('connect.other.tab'), note: 'connect.other.note',
        steps: ['connect.other.s1', 'connect.other.s2', 'connect.other.s3'],
        links: [[tr('connect.other.tokens'), '#api-tokens', false, 'fa-key']],
      },
    ];
  }

  const ConnectAiModule = {
    current: 'chatgpt',

    init() {
      const host = document.getElementById('main-content');
      if (!host) return;
      host.textContent = '';
      const want = (location.hash || '').replace('#', '');
      if (apps().some((a) => a.id === want)) this.current = want;
      const root = el('section', 'ca');
      root.setAttribute('aria-labelledby', 'ca-title');
      host.appendChild(root);
      this.root = root;

      // Head
      const head = el('header', 'ca-head');
      const h = el('h1', 'ca-title', tr('connect.title')); h.id = 'ca-title';
      head.appendChild(h);
      head.appendChild(el('p', 'ca-sub', tr('connect.sub')));
      root.appendChild(head);

      // Hero: the address + a product shot of the sign-in step.
      const hero = el('div', 'ca-hero');
      const left = el('div', 'ca-hero-copy');
      left.appendChild(el('p', 'ca-hero-k', tr('connect.addrLabel')));
      const addr = el('div', 'ca-addr');
      addr.appendChild(el('code', 'ca-addr-url', mcpUrl()));
      const cb = el('button', 'btn ca-addr-copy');
      cb.type = 'button';
      cb.appendChild(icon('fa-copy'));
      cb.appendChild(document.createTextNode(' ' + tr('connect.copy')));
      cb.addEventListener('click', () => copy(mcpUrl()));
      addr.appendChild(cb);
      left.appendChild(addr);
      const pts = el('ul', 'ca-hero-points');
      ['connect.hero.p1', 'connect.hero.p2', 'connect.hero.p3'].forEach((k) => {
        const li = el('li'); const t = icon('fa-check'); t.classList.add('ca-tick');
        li.appendChild(t); li.appendChild(document.createTextNode(tr(k))); pts.appendChild(li);
      });
      left.appendChild(pts);
      hero.appendChild(left);
      const pic = el('picture', 'ca-hero-pic');
      ['', '-dark'].forEach((v) => {
        const img = el('img', v ? 'pic-d' : 'pic-l');
        img.src = '/img/connect/consent' + v + '.webp';
        img.alt = tr('connect.hero.alt');
        img.width = 900; img.height = 900;
        img.loading = 'lazy'; img.decoding = 'async';
        pic.appendChild(img);
      });
      hero.appendChild(pic);
      root.appendChild(hero);

      // Tabs
      const tabs = el('div', 'ca-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', tr('connect.tabsAria'));
      root.appendChild(tabs);
      this.tabs = tabs;
      this.panel = el('div', 'ca-panel');
      this.panel.setAttribute('role', 'tabpanel');
      root.appendChild(this.panel);

      // Below: connected apps + what it can do + Finman's own AI
      const below = el('div', 'ca-below');
      this.connBox = el('section', 'ca-plate ca-conn');
      below.appendChild(this.connBox);
      below.appendChild(this.toolsNode());
      root.appendChild(below);

      const own = el('div', 'ca-own');
      own.appendChild(el('p', '', tr('connect.own')));
      const ob = el('button', 'btn', tr('connect.ownBtn'));
      ob.type = 'button';
      ob.addEventListener('click', () => go('my-ai'));
      own.appendChild(ob);
      root.appendChild(own);

      this.renderTabs();
      this.renderPanel();
      this.loadConnections();
    },

    renderTabs() {
      this.tabs.textContent = '';
      const list = apps();
      list.forEach((a, i) => {
        const b = el('button', 'ca-tab' + (a.id === this.current ? ' is-on' : ''), a.name);
        b.type = 'button';
        b.id = 'ca-tab-' + a.id;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', a.id === this.current ? 'true' : 'false');
        b.setAttribute('aria-controls', 'ca-panel');
        b.tabIndex = a.id === this.current ? 0 : -1;
        b.addEventListener('click', () => this.pick(a.id));
        b.addEventListener('keydown', (e) => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const next = list[(i + d + list.length) % list.length];
          this.pick(next.id);
          const nb = document.getElementById('ca-tab-' + next.id);
          if (nb) nb.focus();
        });
        this.tabs.appendChild(b);
      });
    },

    pick(id) {
      this.current = id;
      try { history.replaceState(history.state, '', location.pathname + location.search + '#' + id); } catch (e) { /* ignore */ }
      this.renderTabs();
      this.renderPanel();
    },

    renderPanel() {
      const a = apps().find((x) => x.id === this.current) || apps()[0];
      const p = this.panel;
      p.textContent = '';
      p.id = 'ca-panel';
      p.setAttribute('aria-labelledby', 'ca-tab-' + a.id);
      p.className = 'ca-panel ca-plate' + (a.shot ? ' has-shot' : '');

      const main = el('div', 'ca-panel-main');
      main.appendChild(el('h2', 'ca-h2', tr('connect.panelTitle', { name: a.name })));
      main.appendChild(el('p', 'ca-note', tr(a.note)));
      const ol = el('ol', 'ca-steps');
      const slots = { url: urlChip };
      a.steps.forEach((k, i) => {
        const li = el('li', 'ca-step');
        const n = el('span', 'ca-step-n', String(i + 1));
        n.setAttribute('aria-hidden', 'true');
        li.appendChild(n);
        li.appendChild(line(el('p', 'ca-step-t'), tr(k), slots));
        ol.appendChild(li);
      });
      main.appendChild(ol);
      if (a.links && a.links.length) {
        const row = el('div', 'ca-links');
        a.links.forEach(([label, href, primary, ic]) => {
          if (href === '#api-tokens') {
            const b = el('button', 'btn', '');
            b.type = 'button';
            if (ic) b.appendChild(icon(ic));
            b.appendChild(document.createTextNode(' ' + label));
            b.addEventListener('click', () => go('api-tokens'));
            row.appendChild(b);
          } else row.appendChild(linkBtn(label, href, primary, ic));
        });
        main.appendChild(row);
      }
      (a.extra || []).forEach(([k, code]) => {
        main.appendChild(el('p', 'ca-extra-t', tr(k)));
        main.appendChild(codeBlock(code));
      });
      p.appendChild(main);

      if (a.shot) {
        const fig = el('figure', 'ca-shot');
        const img = el('img');
        img.src = a.shot.src; img.alt = tr(a.shot.alt); img.loading = 'lazy'; img.decoding = 'async';
        img.width = 1200; img.height = 900;
        img.addEventListener('error', () => { fig.remove(); p.classList.remove('has-shot'); });
        fig.appendChild(img);
        fig.appendChild(el('figcaption', '', tr(a.shot.alt)));
        p.appendChild(fig);
      }
    },

    toolsNode() {
      const box = el('section', 'ca-plate ca-tools');
      box.appendChild(el('h2', 'ca-h2', tr('connect.tools.title')));
      const grid = el('div', 'ca-tools-grid');
      [['fa-eye', 'connect.tools.read', 'connect.tools.readList'], ['fa-pen', 'connect.tools.write', 'connect.tools.writeList']].forEach(([ic, h, l]) => {
        const col = el('div', 'ca-tools-col');
        const t = el('p', 'ca-tools-h');
        t.appendChild(icon(ic));
        t.appendChild(document.createTextNode(' ' + tr(h)));
        col.appendChild(t);
        col.appendChild(el('p', 'ca-muted', tr(l)));
        grid.appendChild(col);
      });
      box.appendChild(grid);
      box.appendChild(el('p', 'ca-foot', tr('connect.tools.foot')));
      return box;
    },

    async loadConnections() {
      const box = this.connBox;
      box.textContent = '';
      box.appendChild(el('h2', 'ca-h2', tr('connect.conn.title')));
      let list = [];
      try {
        const res = await fetch('/api/mcp/connections', { headers: authHeaders() });
        const body = await res.json();
        list = (body && body.connections) || [];
      } catch (e) { list = []; }
      if (!list.length) {
        box.appendChild(el('p', 'ca-muted', tr('connect.conn.empty')));
        return;
      }
      const ul = el('ul', 'ca-conn-list');
      list.forEach((c) => {
        const li = el('li', 'ca-conn-row');
        const txt = el('div', 'ca-conn-text');
        txt.appendChild(el('span', 'ca-conn-name', c.app || 'App'));
        const when = c.last_used_at || c.created_at;
        let d = '';
        if (when) { const dt = new Date(String(when).replace(' ', 'T') + (String(when).includes('Z') ? '' : 'Z')); if (!isNaN(dt)) d = dt.toLocaleDateString(); }
        txt.appendChild(el('span', 'ca-muted', c.last_used_at ? tr('connect.conn.used', { date: d }) : tr('connect.conn.since', { date: d })));
        li.appendChild(txt);
        const b = el('button', 'btn btn-sm btn-ghost ca-danger', tr('connect.conn.disconnect'));
        b.type = 'button';
        b.addEventListener('click', async () => {
          if (!window.confirm(tr('connect.conn.confirm', { name: c.app || 'App' }))) return;
          try {
            const r = await fetch('/api/mcp/connections/' + encodeURIComponent(c.id), { method: 'DELETE', headers: authHeaders() });
            if (!r.ok) throw new Error('fail');
            toast(tr('connect.conn.done'), 'success');
          } catch (e) { toast(tr('connect.conn.error'), 'error'); }
          this.loadConnections();
        });
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    },
  };

  window.ConnectAiModule = ConnectAiModule;
})();
