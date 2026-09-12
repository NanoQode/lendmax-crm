/**
 * Opens every screen as every role and reports anything that breaks.
 *
 * The cheapest check in the build, and the one that has found the most:
 * a screen that renders is not necessarily a screen that works, but a
 * screen that does not render is definitely broken, and typechecking will
 * not tell you — a renamed API field produces a blank panel, not an error.
 *
 * What counts as a failure: a JavaScript error, a 5xx, a blank page, or a
 * red error panel. What does not: a calm refusal on a screen the role
 * cannot open, a 401 before sign-in, or a 403 behind one of those
 * refusals — all three are the system working.
 *
 *   node scripts/smoke.mjs            (against localhost:3400)
 *   BASE=https://lendmax.ca/crm node scripts/smoke.mjs
 *
 * Needs two accounts with the dev password; it is a development tool and
 * is not wired into `npm run verify` for that reason.
 */
import { chromium } from 'playwright';

const PAGES = ['/', '/customers', '/pipeline', '/tasks', '/calendar', '/documents',
               '/automations', '/campaigns', '/renewals', '/compliance', '/reports',
               '/integrations', '/settings'];
const ROLES = [
  ['broker@lendmax.ca', 'manager'],
  ['compliance@lendmax.ca', 'compliance manager'],
];

const BASE = process.env.BASE ?? 'http://localhost:3400/crm';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'dev-password-abc12345';

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failures = 0;

for (const [email, label] of ROLES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`JS: ${e.message}`));
  // A 401 before sign-in and a 403 on a screen this role cannot open are
  // both correct behaviour, not faults.
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !/\b(401|403)\b/.test(text)) problems.push(`console: ${text}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${r.url().replace(/.*\/api/, '')}`);
  });

  await page.goto(`${BASE}/`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('.login-card button.btn-primary');
  await page.waitForSelector('.shell', { timeout: 10000 });

  console.log(`\n${label}`);
  for (const path of PAGES) {
    problems.length = 0;
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(700);
    const errorPanels = await page.locator('.alert-error').count();
    const refusal = await page.locator('.empty h3').count();
    const forbidden = await page.locator('text=/cannot|not permitted/i').count();
    const text = await page.locator('.main').innerText().catch(() => '');
    const blank = text.trim().length < 40;
    // An error panel is a failure unless the page is a calm refusal — a role
    // that cannot open a screen is told so, and that is the right outcome.
    const bad = problems.length > 0 || (errorPanels > 0 && refusal === 0) || blank;
    if (bad) failures++;
    console.log(`  ${bad ? 'FAIL' : ' ok '} ${path.padEnd(14)}`
      + (blank ? ' blank' : '')
      + (errorPanels ? ` ${errorPanels} error panel(s)` : '')
      + (forbidden ? ' (permission notice)' : '')
      + (problems.length ? ` ${problems.join('; ')}` : ''));
  }
  await page.close();
}

console.log(failures === 0 ? '\nEvery screen renders.' : `\n${failures} screen(s) need attention.`);
await browser.close();
