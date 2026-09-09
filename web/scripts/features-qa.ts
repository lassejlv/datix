import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
process.chdir(new URL('../..', import.meta.url).pathname);
const production = process.argv.includes('--production');
const base = production
  ? 'https://usedatix.com'
  : (process.env.QA_BASE_URL ?? 'http://localhost:3074');
const connectionString = production
  ? process.env.PRODUCTION_DATABASE_URL
  : process.env.DATABASE_URL;
if (
  !connectionString ||
  (production
    ? new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST
    : !['localhost', '127.0.0.1'].includes(new URL(base).hostname) ||
      new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST)
)
  throw Error('Explicit matching QA database required.');
const db = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: 'reduce',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
await context.route('https://usedatix.com/tracker.js', (route) => route.fulfill({ body: '' }));
expect.configure({ timeout: 15000 });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
let owner = '';
const dir = production ? 'web/artifacts/features-production' : 'web/artifacts/features';
let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: 'Feature preview',
      email: `feature-qa-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  owner = (await signup.json()).user.id;
  await seedPro(db, owner);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { Origin: base },
    data: { name: 'North Studio', domain: 'example.com' },
  });
  expect(created.status()).toBe(201);
  const site = (await created.json()).site;
  const root = `${base}/site/${site.id}/${site.id}`;
  const api = `${base}/api/sites/${site.id}/environments/${site.id}`;
  await context.request.patch(api, { headers: { Origin: base }, data: { allowLocalhost: true } });
  await page.goto(`${root}/settings`);
  await page.getByRole('tab', { name: 'Features', exact: true }).click();
  for (const label of ['Goals', 'Error Tracking', 'Globe', 'Pulse'])
    await expect(page.getByRole('switch', { name: label, exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Web Vitals', exact: true })).toBeChecked();
  for (const label of ['Goals', 'Error Tracking', 'Globe', 'Pulse']) {
    await page.getByRole('switch', { name: label, exact: true }).click();
    await expect(page.getByRole('switch', { name: label, exact: true })).toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible();
  }
  await page.screenshot({ path: `${dir}/settings.png`, fullPage: true });
  await page.goto(`${root}/goals`);
  await page.getByLabel('Goal name', { exact: true }).fill('Signed up');
  await page.getByLabel('Event name', { exact: true }).fill('signup');
  await page.getByRole('button', { name: 'Create goal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signed up', exact: true })).toBeVisible();
  const fixtureBase = production ? 'http://127.0.0.1:3076' : base;
  if (production)
    fixtureServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 3076,
      fetch: () => new Response('fixture'),
    });
  const trackerPage = await context.newPage();
  await trackerPage.route(`${base}/tracker.js`, (route) => route.continue());
  await trackerPage.route(`${fixtureBase}/feature-fixture`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>Feature fixture</title></head><body><h1 style="font-size:60px">A real visitor</h1><button id="action" style="padding:25px">Sign up</button><script defer src="${base}/tracker.js" data-site="${site.id}" data-environment="${site.id}"></script></body></html>`,
    }),
  );
  const telemetry: string[] = [];
  trackerPage.on('request', (r) => {
    if (r.url().endsWith('/api/telemetry')) telemetry.push(r.postData() ?? '');
  });
  const vitalsLoaded = trackerPage.waitForResponse(
    (response) => response.url().endsWith('/web-vitals.js') && response.status() === 200,
  );
  await trackerPage.goto(`${fixtureBase}/feature-fixture`);
  await (await vitalsLoaded).finished();
  await expect
    .poll(() =>
      trackerPage.evaluate(
        () => !!(window as unknown as { simpleAnalytics?: unknown }).simpleAnalytics,
      ),
    )
    .toBe(true);
  await trackerPage.waitForTimeout(600);
  await trackerPage.click('#action');
  await trackerPage.evaluate(() => {
    (
      window as unknown as { simpleAnalytics: { track: (name: string) => void } }
    ).simpleAnalytics.track('signup');
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Checkout failed for private@example.org',
        filename: 'https://example.com/app.js?token=secret',
        lineno: 8,
        error: new Error('Checkout failed'),
      }),
    );
  });
  await trackerPage.waitForTimeout(250);
  await trackerPage.goto('about:blank');
  await expect
    .poll(() => telemetry.filter((x) => JSON.parse(x).kind === 'vital').length, { timeout: 10000 })
    .toBeGreaterThan(0);
  expect(telemetry.join('')).not.toContain('private@example.org');
  expect(telemetry.join('')).not.toContain('token=secret');
  await expect
    .poll(
      async () =>
        Number(
          (
            await db.query('select count(*) from diagnostic_events where environment_id=$1', [
              site.id,
            ])
          ).rows[0].count,
        ),
      { timeout: 15000 },
    )
    .toBeGreaterThan(1);
  await page.goto(`${root}/goals`);
  await expect(page.getByText('Signed up', { exact: true })).toBeVisible();
  const goalReport = await (await context.request.get(`${api}/features/goals`)).json();
  expect(goalReport.goals[0].conversions).toBe(1);
  await page.screenshot({ path: `${dir}/goals.png`, fullPage: true });
  await page.goto(`${root}/errors`);
  await expect(page.getByText('Checkout failed for [redacted]', { exact: true })).toBeVisible();
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
  await expect(page.locator('summary')).toContainText('Resolved');
  await page.screenshot({ path: `${dir}/errors.png`, fullPage: true });
  await page.goto(`${root}/web-vitals`);
  await expect(page.getByRole('heading', { name: 'LCP', exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/vitals.png`, fullPage: true });
  const countries = ['DK', 'DE', 'FR', 'US', 'GB', 'IN', 'JP', 'BR', 'AU'];
  for (const [index, country] of (production ? [] : countries).entries())
    await db.query(
      "insert into events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) values($1,$2,now(),current_date,'pageview','','/pricing','google.com',$3,'desktop',$4)",
      [site.id, crypto.randomUUID(), country, String(index).repeat(64)],
    );
  await page.goto(`${root}/globe`);
  await expect(page.getByRole('img', { name: 'Interactive visitor globe' })).toBeVisible();
  if (!production) await expect(page.locator('.globe-countries')).toContainText('Denmark');
  await expect.poll(() => page.locator('.globe-canvas path').count()).toBeGreaterThan(100);
  await page.screenshot({ path: `${dir}/globe.png`, fullPage: true });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.locator('.visitor-globe-full')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.visitor-globe-full')).toHaveCount(0);
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/globe-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${root}/pulse`);
  await expect(
    page.getByText('Add a monitor URL in Settings to start checking availability.'),
  ).toBeVisible();
  const configured = await context.request.post(`${api}/features/pulse`, {
    headers: { Origin: base },
    data: { url: 'https://example.com' },
  });
  expect(configured.status()).toBe(200);
  await expect
    .poll(
      async () =>
        (await (await context.request.get(`${api}/features/pulse`)).json()).monitor?.checkedAt,
      { timeout: 60000, intervals: [2000] },
    )
    .toBeTruthy();
  await page.reload();
  await expect(page.getByText('Recent checks', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/pulse.png`, fullPage: true });
  for (const locale of ['da', 'de']) {
    await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
    await page.goto(`${root}/web-vitals`);
    await expect(page.getByRole('heading', { name: 'LCP', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, telemetry: telemetry.length, artifacts: dir }));
} finally {
  fixtureServer?.stop(true);
  await browser.close();
  if (owner) {
    await cleanupPro(db, [owner]);
    await db.query('delete from "user" where id=$1', [owner]);
  }
  await db.end();
}
