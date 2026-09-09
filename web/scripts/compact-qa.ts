import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { mkdir } from 'node:fs/promises';
process.chdir(new URL('../..', import.meta.url).pathname);
const base = process.env.QA_BASE_URL ?? 'http://localhost:3074';
if (
  new URL(process.env.DATABASE_URL!).hostname !== process.env.TEST_DATABASE_HOST ||
  !['localhost', '127.0.0.1'].includes(new URL(base).hostname)
)
  throw Error('Isolated local QA required');
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
await context.route('https://usedatix.com/tracker.js', (r) => r.fulfill({ body: '' }));
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const db = new Client({ connectionString: process.env.DATABASE_URL });
let owner = '';
await mkdir('web/artifacts/compact', { recursive: true });
try {
  await db.connect();
  await page.goto(base);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const hero = await page.locator('.landing-hero').boundingBox();
  await expect(page.locator('.landing-hero')).toHaveCSS('text-align', 'center');
  expect(hero!.height).toBeLessThan(560);
  const cta = page.locator('.landing-actions a');
  await expect(cta).toHaveCSS('min-height', '40px');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('font-size', '36px');
  expect((await cta.boundingBox())!.y).toBeLessThan(500);
  await page.screenshot({ path: 'web/artifacts/compact/landing-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Take a look' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await cta.click();
  await expect(page).toHaveURL(/signup/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'web/artifacts/compact/landing-mobile.png', fullPage: true });
  const r = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: 'Compact preview',
      email: `compact-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
    },
  });
  expect(r.status()).toBe(200);
  owner = (await r.json()).user.id;
  await seedPro(db, owner);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { Origin: base },
    data: { name: 'North Studio', domain: 'example.com' },
  });
  expect(created.status()).toBe(201);
  const site = (await created.json()).site.id;
  for (const [width, name] of [
    [1440, 'desktop'],
    [390, 'mobile'],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/site/${site}/${site}/overview`);
    await expect(page.getByTestId('traffic-chart')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.dashboard-workspace')).not.toHaveClass(/compact-workspace/);
    await expect(page.locator('#main-content')).toHaveCSS('max-width', '960px');
    await expect(page.getByTestId('traffic-chart')).toHaveCSS(
      'height',
      width === 1440 ? '200px' : '190px',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `web/artifacts/compact/dashboard-${name}.png`, fullPage: true });
  }
  await context.addCookies([{ name: 'ab-theme', value: 'dark', url: base }]);
  await page.goto(base);
  await page.screenshot({ path: 'web/artifacts/compact/landing-dark.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, heroHeight: hero!.height }));
} finally {
  await browser.close();
  if (owner) {
    await cleanupPro(db, [owner]);
    await db.query('delete from "user" where id=$1', [owner]);
  }
  await db.end();
}
