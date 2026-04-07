/**
 * AI CFO floating chat panel.
 * XSS-safe: user input via textContent; AI responses via DOM construction
 * with a strict inline-formatting whitelist (no innerHTML from untrusted input).
 */
(function () {
  'use strict';

  let sessionId = 'session-' + Date.now();
  let history = [];
  let isOpen = false;
  let isLoading = false;

  // Safe AI text renderer — escape everything, then allow **bold** *italic* `code`
  function renderAIText(container, text) {
    const lines = String(text).split('\n');
    let first = true;
    for (const line of lines) {
      if (!first) container.appendChild(document.createElement('br'));
      first = false;
      appendInline(container, line);
    }
  }

  function appendInline(parent, text) {
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
    const matches = [...text.matchAll(pattern)];
    let last = 0;
    for (const m of matches) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const tag = m[2] !== undefined ? 'strong' : m[3] !== undefined ? 'em' : 'code';
      const inner = m[2] || m[3] || m[4];
      const el = document.createElement(tag);
      el.textContent = inner;
      parent.appendChild(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function buildBotMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ai-msg-bot';
    const content = document.createElement('div');
    content.className = 'ai-msg-content';
    renderAIText(content, text);
    wrap.appendChild(content);
    return wrap;
  }

  function buildUserMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ai-msg-user';
    const content = document.createElement('div');
    content.className = 'ai-msg-content';
    content.textContent = text;
    wrap.appendChild(content);
    return wrap;
  }

  function buildTypingIndicator() {
    const wrap = document.createElement('div');
    wrap.id = 'ai-typing-indicator';
    wrap.className = 'ai-msg ai-msg-bot';
    const content = document.createElement('div');
    content.className = 'ai-msg-content ai-typing';
    for (let i = 0; i < 3; i++) content.appendChild(document.createElement('span'));
    wrap.appendChild(content);
    return wrap;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'ai-chat-panel';

    const header = document.createElement('div');
    header.className = 'ai-chat-header';
    const title = document.createElement('span');
    title.textContent = '🤖 CFO Assistant';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'ai-chat-close-btn';
    closeBtn.className = 'ai-chat-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    header.appendChild(title);
    header.appendChild(closeBtn);

    const messages = document.createElement('div');
    messages.className = 'ai-chat-messages';
    messages.id = 'ai-chat-messages';
    messages.appendChild(buildBotMessage('Hey! I\'m your CFO assistant. Ask me anything about your finances — balances, spending, budgets, trends.'));

    const inputRow = document.createElement('div');
    inputRow.className = 'ai-chat-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'ai-chat-input';
    input.className = 'ai-chat-input';
    input.placeholder = 'Ask about your finances...';
    input.autocomplete = 'off';
    input.maxLength = 500;
    const sendBtn = document.createElement('button');
    sendBtn.id = 'ai-chat-send';
    sendBtn.className = 'ai-chat-send-btn';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.textContent = '➤';
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputRow);
    return panel;
  }

  function buildToggle() {
    const btn = document.createElement('button');
    btn.id = 'ai-chat-toggle';
    btn.className = 'ai-chat-toggle';
    btn.setAttribute('aria-label', 'Open CFO Assistant');
    btn.textContent = '🤖';
    return btn;
  }

  function appendToMessages(el) {
    const messages = document.getElementById('ai-chat-messages');
    if (!messages) return;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage(text) {
    if (isLoading || !text.trim()) return;
    isLoading = true;

    const input = document.getElementById('ai-chat-input');
    const sendBtn = document.getElementById('ai-chat-send');
    if (input) { input.disabled = true; input.value = ''; }
    if (sendBtn) sendBtn.disabled = true;

    appendToMessages(buildUserMessage(text));
    history.push({ role: 'user', content: text });
    appendToMessages(buildTypingIndicator());

    try {
      const token = localStorage.getItem('token');
      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ message: text, session_id: sessionId, history: history.slice(-10) }),
      });

      const typingEl = document.getElementById('ai-typing-indicator');
      if (typingEl) typingEl.remove();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        appendToMessages(buildBotMessage(err.message || 'Something went wrong. Please try again.'));
        return;
      }

      const data = await resp.json();
      const reply = data.reply || 'No response generated.';
      appendToMessages(buildBotMessage(reply));
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history = history.slice(-20);
    } catch (_err) {
      const typingEl = document.getElementById('ai-typing-indicator');
      if (typingEl) typingEl.remove();
      appendToMessages(buildBotMessage('Network error — please check your connection.'));
    } finally {
      isLoading = false;
      if (input) { input.disabled = false; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function openPanel() {
    const panel = document.getElementById('ai-chat-panel');
    if (panel) { panel.classList.add('open'); isOpen = true; }
    const input = document.getElementById('ai-chat-input');
    if (input) input.focus();
  }

  function closePanel() {
    const panel = document.getElementById('ai-chat-panel');
    if (panel) { panel.classList.remove('open'); isOpen = false; }
  }

  function init() {
    if (document.getElementById('ai-chat-panel')) return;
    const panel = buildPanel();
    const toggle = buildToggle();
    document.body.appendChild(panel);
    document.body.appendChild(toggle);

    toggle.addEventListener('click', () => { if (isOpen) closePanel(); else openPanel(); });
    document.getElementById('ai-chat-close-btn').addEventListener('click', closePanel);
    document.getElementById('ai-chat-send').addEventListener('click', () => {
      const inp = document.getElementById('ai-chat-input');
      if (inp) sendMessage(inp.value.trim());
    });
    document.getElementById('ai-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const inp = document.getElementById('ai-chat-input');
        if (inp) sendMessage(inp.value.trim());
      }
    });
  }

  function waitForAuth() {
    if (localStorage.getItem('token')) { init(); return; }
    const interval = setInterval(() => {
      if (localStorage.getItem('token')) { clearInterval(interval); init(); }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForAuth);
  } else {
    waitForAuth();
  }
})();
