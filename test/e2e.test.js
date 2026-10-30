'use strict';

// Browser test of the real front end. It runs only when Playwright and a
// Chromium binary are available, and otherwise reports itself as skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openDatabase } = require('../src/db');
const { createServer } = require('../src/server');

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const playwright = loadPlaywright();
const chromiumAvailable = fs.existsSync(CHROMIUM);
const skip = !playwright || !chromiumAvailable ? 'Playwright or Chromium not installed' : false;

test('the main user journey works in a real browser', { skip }, async (t) => {
  const db = openDatabase(':memory:');
  const server = createServer({
    db,
    config: { appUrl: 'http://127.0.0.1' },
    today: () => '2026-10-30',
    now: () => Date.parse('2026-10-30T12:00:00Z'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await playwright.chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401')) problems.push(`console: ${message.text()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(base + '/');
  await page.click('text=Create an account');
  await page.fill('input[name=email]', 'e2e@example.com');
  await page.fill('input[name=password]', 'e2e-password-1');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Your properties');

  await page.fill('input[name=address]', '7 Browser Street');
  await page.fill('input[name=postcode]', 'SE1 7AA');
  await page.click('text=Add property');
  await page.waitForSelector('text=Compliance checklist');

  // Record a gas certificate, then check the readiness score reflects it.
  await page.fill('input[name=completed_on] >> nth=0', '2026-06-01');
  await page.click('button[aria-label^="Save Gas safety"]');
  await page.waitForSelector('text=Valid · 214 days left');
  // Keyboard users stay on the control they just used, rather than jumping to the top of the page.
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
  assert.equal(focused, 'Save Gas safety certificate (CP12)');

  // Add a tenancy whose deposit was received 40 days ago, so its deadline has passed.
  await page.click('summary:has-text("Add a tenancy")');
  await page.fill('details:has-text("Add a tenancy") input[name=tenant_name]', 'Test Tenant');
  await page.fill('details:has-text("Add a tenancy") input[name=start_date]', '2026-09-01');
  await page.fill('details:has-text("Add a tenancy") input[name=deposit_received_on]', '2026-09-01');
  await page.click('button:has-text("Add tenancy")');
  await page.waitForSelector('text=Deposit protected for Test Tenant');
  await page.waitForSelector('text=Expired');

  await page.screenshot({ path: `${process.env.TMPDIR || '/tmp'}/letready-e2e-property.png`, fullPage: true });

  // Dashboard shows the tenancy issue.
  await page.goto(base + '/#/');
  await page.waitForSelector('text=Needs attention');
  await page.waitForSelector('text=7 Browser Street');

  // Settings: turn reminders off and confirm the change is saved.
  await page.goto(base + '/#/settings');
  await page.waitForSelector('h1:has-text("Settings")');
  await page.uncheck('input[name=email_reminders]');
  await page.waitForSelector('text=Email reminders are off.');

  // Log out returns to the login screen.
  await page.click('button:has-text("Log out")');
  await page.waitForSelector('text=Log in to Let Ready');

  assert.deepEqual(problems, [], problems.join('\n'));
});
