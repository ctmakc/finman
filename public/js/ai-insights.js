/**
 * AI insights widget — loads monthly financial story and weekly brief.
 * Rendered via safe DOM construction (no innerHTML from untrusted content).
 */
(function () {
  'use strict';

  // Safe AI text renderer (same approach as ai-chat.js)
  function renderAIText(container, text) {
    const lines = String(text).split('\n');
    let first = true;
    for (const line of lines) {
      if (!first) container.appendChild(document.createElement('br'));
      first = false;
      appendInlineFmt(container, line);
    }
  }

  function appendInlineFmt(parent, text) {
    const matches = [...text.matchAll(/(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g)];
    let last = 0;
    for (const m of matches) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tag = m[2] !== undefined ? 'strong' : m[3] !== undefined ? 'em' : 'code';
      const el = document.createElement(tag);
      el.textContent = m[2] || m[3] || m[4];
      parent.appendChild(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function formatCurrency(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
  }

  // ─── Monthly insight card ─────────────────────────────────────────────────

  async function loadMonthlyInsight(container) {
    const token = localStorage.getItem('token');
    if (!token) return;

    container.textContent = 'Loading monthly story...';

    try {
      const resp = await fetch('/api/ai/insights/monthly', {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!resp.ok) { container.textContent = 'Could not load monthly insight.'; return; }
      const data = await resp.json();
      const insight = data.insight;

      container.textContent = '';

      // Stats row
      const stats = document.createElement('div');
      stats.className = 'ai-insight-stats';

      const incomeEl = document.createElement('div');
      incomeEl.className = 'ai-insight-stat';
      const incomeLabel = document.createElement('span');
      incomeLabel.className = 'ai-stat-label';
      incomeLabel.textContent = 'Income';
      const incomeVal = document.createElement('span');
      incomeVal.className = 'ai-stat-value text-success';
      incomeVal.textContent = formatCurrency(insight.totalIncome);
      incomeEl.appendChild(incomeLabel);
      incomeEl.appendChild(incomeVal);

      const spentEl = document.createElement('div');
      spentEl.className = 'ai-insight-stat';
      const spentLabel = document.createElement('span');
      spentLabel.className = 'ai-stat-label';
      spentLabel.textContent = 'Spent';
      const spentVal = document.createElement('span');
      spentVal.className = 'ai-stat-value text-error';
      spentVal.textContent = formatCurrency(insight.totalSpent);
      spentEl.appendChild(spentLabel);
      spentEl.appendChild(spentVal);

      stats.appendChild(incomeEl);
      stats.appendChild(spentEl);
      container.appendChild(stats);

      // Story text
      const story = document.createElement('p');
      story.className = 'ai-insight-text';
      renderAIText(story, insight.text);
      container.appendChild(story);

      if (data.cached) {
        const badge = document.createElement('span');
        badge.className = 'ai-cached-badge';
        badge.textContent = '📋 cached';
        container.appendChild(badge);
      }
    } catch (_err) {
      container.textContent = 'Failed to load monthly insight.';
    }
  }

  // ─── Weekly brief card ────────────────────────────────────────────────────

  async function loadWeeklyBrief(container) {
    const token = localStorage.getItem('token');
    if (!token) return;

    container.textContent = 'Loading weekly brief...';

    try {
      const resp = await fetch('/api/ai/insights/weekly', {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!resp.ok) { container.textContent = 'Could not load weekly brief.'; return; }
      const data = await resp.json();

      container.textContent = '';

      const brief = document.createElement('p');
      brief.className = 'ai-insight-text';
      renderAIText(brief, data.brief);
      container.appendChild(brief);

      const meta = document.createElement('div');
      meta.className = 'ai-insight-meta';
      const spentSpan = document.createElement('span');
      spentSpan.textContent = `Spent: ${formatCurrency(data.totalSpent)}`;
      const earnedSpan = document.createElement('span');
      earnedSpan.textContent = `Earned: ${formatCurrency(data.totalEarned)}`;
      const countSpan = document.createElement('span');
      countSpan.textContent = `${data.transactionCount} transactions`;
      meta.appendChild(spentSpan);
      meta.appendChild(earnedSpan);
      meta.appendChild(countSpan);
      container.appendChild(meta);
    } catch (_err) {
      container.textContent = 'Failed to load weekly brief.';
    }
  }

  // ─── Render insight slot in dashboard ────────────────────────────────────

  function renderInsightWidget(slot) {
    slot.textContent = '';
    slot.className = 'ai-insights-widget';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'ai-tabs';
    const tabMonthly = document.createElement('button');
    tabMonthly.className = 'ai-tab active';
    tabMonthly.textContent = '📅 Monthly Story';
    const tabWeekly = document.createElement('button');
    tabWeekly.className = 'ai-tab';
    tabWeekly.textContent = '📊 Weekly Brief';
    tabs.appendChild(tabMonthly);
    tabs.appendChild(tabWeekly);

    const content = document.createElement('div');
    content.className = 'ai-insight-content';

    slot.appendChild(tabs);
    slot.appendChild(content);

    function showMonthly() {
      tabMonthly.classList.add('active');
      tabWeekly.classList.remove('active');
      content.textContent = '';
      loadMonthlyInsight(content);
    }
    function showWeekly() {
      tabWeekly.classList.add('active');
      tabMonthly.classList.remove('active');
      content.textContent = '';
      loadWeeklyBrief(content);
    }

    tabMonthly.addEventListener('click', showMonthly);
    tabWeekly.addEventListener('click', showWeekly);

    // Load monthly by default
    loadMonthlyInsight(content);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.AIInsights = { renderInsightWidget, loadMonthlyInsight, loadWeeklyBrief };
})();
