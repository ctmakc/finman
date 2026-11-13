/**
 * @jest-environment jsdom
 */
// AI CFO replies come back in markdown; the chat draws bold, lists and
// paragraphs as DOM nodes and never turns reply text into HTML.
const fs = require('fs');
const path = require('path');

beforeAll(() => {
  window.t = (k) => k;
  window.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ai.js'), 'utf8'));
});

test('bold, bullet list and paragraphs render without raw asterisks', () => {
  const el = document.createElement('span');
  window.AiCfoModule.renderRich(el, 'Your **Groceries** ran $580.\n\n- Cut **delivery**\n- Cook twice a week\n\n1. First\n2. Second');
  expect(el.textContent).not.toMatch(/\*\*/);
  expect(el.querySelectorAll('strong').length).toBe(2);
  expect(el.querySelector('ul.ai-msg-list').children.length).toBe(2);
  expect(el.querySelector('ol.ai-msg-list').children.length).toBe(2);
  expect(el.querySelector('p.ai-msg-p').textContent).toBe('Your Groceries ran $580.');
});

test('HTML in a reply stays text', () => {
  const el = document.createElement('span');
  window.AiCfoModule.renderRich(el, '**<img src=x onerror=alert(1)>** <script>x</script>');
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelector('script')).toBeNull();
  expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
});
