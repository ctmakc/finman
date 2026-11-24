// test/e2e/feedback-day3.cjs — the day-3 survey and the Feedback button in a real Chromium.
//
//   BASE=https://app.finman.money EMAIL=qa-fb-1123@finman-smoke.test PASSWORD=… SHOTS=/dir node test/e2e/feedback-day3.cjs
//
// register (vault + recovery key) → app → /?fm_qa_survey=day3 shows the card at once (QA flag) →
// full-page shots 390 and 1440 → score 4 + "what gets in the way" → Send → thank-you toast →
// Feedback button in the header (1440) and in the drawer (390) opens the dialog.
// Test accounts (*.test, +smoke) never reach live analytics or the Telegram inbox (is_test=1).
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const SHOTS = process.env.SHOTS || '/fast/claude-tmp/finman-fb3/shots';
const VAULT_PW = process.env.VAULT_PW || PASSWORD;
const COMMENT = process.env.COMMENT || 'QA 1123: would like automatic bank sync';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function answerPrompts(page, until) {
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (await page.locator(until).count()) return;
    if (await page.locator('#fmv-rktext').count()) {
      await page.check('#fmv-saved'); await page.click('.fmv-go'); log('recovery key confirmed');
    } else if (await page.locator('#fmv-secret2').count()) {
      await page.fill('#fmv-secret', VAULT_PW); await page.fill('#fmv-secret2', VAULT_PW);
      await page.click('.fmv-form button[type=submit]');
    } else if (await page.locator('#fmv-secret').count() && await page.locator('#fmv-secret').isVisible()) {
      await page.fill('#fmv-secret', VAULT_PW); await page.click('.fmv-form button[type=submit]');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('app did not open');
}

(async () => {
  const browser = await chromium.launch();
  // A normal desktop UA: HeadlessChrome is treated as a bot by some counters.
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const fbPosts = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/feedback') && r.request().method() === 'POST') fbPosts.push(`${r.status()} ${await r.text().catch(() => '')}`);
  });

  // ?fm_qa=1 marks this browser as QA: nothing goes to OpenPanel.
  await page.goto(BASE + '/?fm_qa=1');
  await page.click('.auth-tab[data-tab="register"]');
  await page.fill('#register-email', EMAIL);
  await page.fill('#register-password', PASSWORD);
  await page.click('#register-form button[type=submit]');
  await answerPrompts(page, '#main-content .page-header, #main-content .fm-firstrun, #main-content h1');
  log('app open');
  await page.waitForTimeout(2000);

  // Close the first-run panel if it covers the page, then call the survey by the QA flag.
  await page.goto(BASE + '/?fm_qa=1&fm_qa_survey=day3');
  await answerPrompts(page, '#main-content');
  await page.waitForSelector('#fb-card.in', { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'day3-1440.png'), fullPage: true });
  log('day3 card shown at 1440');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, 'day3-390.png'), fullPage: true });
  log('day3 card at 390');

  await page.click('#fb-card .fb-pick[data-rating="4"]');
  await page.fill('#fb-card textarea', COMMENT);
  await page.screenshot({ path: path.join(SHOTS, 'day3-390-filled.png'), fullPage: false });
  await page.click('#fb-card .fb-card-send');
  await page.waitForFunction(() => !document.getElementById('fb-card'), null, { timeout: 15000 });
  log('sent:', fbPosts.join(' | '));

  // Feedback in the drawer (phone).
  await page.click('#mobile-menu-toggle');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'drawer-390.png'), fullPage: false });
  await page.click('#drawer-fb-btn');
  await page.waitForSelector('#fb-modal, .fb-dialog', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'feedback-dialog-390.png'), fullPage: true });
  await page.keyboard.press('Escape');

  // Feedback in the header (desktop).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  await page.click('#fb-header-btn');
  await page.waitForSelector('.fb-dialog', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'feedback-dialog-1440.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'header-1440.png'), fullPage: false });

  log('errors:', errors.length ? errors.join(' / ') : 'none');
  await browser.close();
  if (!fbPosts.some((p) => /^201 /.test(p))) { console.error('FAIL: no 201 from /api/feedback'); process.exit(1); }
  log('OK');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
