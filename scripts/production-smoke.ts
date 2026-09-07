import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';

// This writes only a disposable account, then removes that exact account.
// All tracking requests go directly from Chromium to the public Worker.
const base = 'https://analytics.beer';
const connectionString = process.env.PRODUCTION_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST
)
  throw new Error('Set the explicit production database connection and hostname.');
const client = new Client({ connectionString });
const email = `production-qa-${crypto.randomUUID()}@example.com`;
const password = `Qa!${crypto.randomUUID()}`;
const checks: string[] = [];
const errors: string[] = [];
const useBrave = process.env.QA_BROWSER === 'brave';
const browser = await chromium.launch({
  headless: true,
  ...(useBrave
    ? { executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(25000);
page.on('pageerror', (error) => errors.push(error.message));
const pass = (check: string) => {
  checks.push(check);
  console.log(`PASS ${check}`);
};
let fixture: ReturnType<typeof Bun.serve> | undefined;
try {
  await client.connect();
  await mkdir('artifacts/production', { recursive: true });
  expect((await context.request.get(`${base}/api/health`)).status()).toBe(200);
  expect((await context.request.get(`${base}/api/sites`)).status()).toBe(401);
  await page.goto(`${base}/signin`);
  if (useBrave)
    expect(
      await page.evaluate(
        () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl,
      ),
    ).toBe(true);
  await expect(page).toHaveTitle('Analytics Beer | Website analytics');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/production/sign-in.png', fullPage: true });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Production verification');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add your first website' })).toBeVisible();
  const cookies = await context.cookies(base);
  expect(
    cookies.some(
      (cookie) => cookie.name.includes('session_token') && cookie.secure && cookie.httpOnly,
    ),
  ).toBe(true);
  pass(
    'Public HTTPS app, unauthenticated API rejection, browser sign-up and secure session cookie',
  );

  await page.getByRole('button', { name: 'Add your first website' }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Production verification');
  await page.getByLabel('Website domain').fill('production-qa.example.com');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByRole('link', { name: 'Installation', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  const siteId = new URL(page.url()).pathname.split('/')[2]!;
  expect(siteId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator('body')).toContainText(`${base}/tracker.js`);
  const setting = page.getByRole('checkbox', { name: 'Allow localhost for testing', exact: true });
  await expect(setting).not.toBeChecked();
  fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        `<html><head><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body><h1>Production tracker verification</h1><button onclick="history.pushState({},'', '/second')">Next page</button><button onclick="simpleAnalytics.track('production_test')">Event</button><button onclick="history.pushState({},'', '/first')">Back to first</button></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      ),
  });
  const tracker = await context.newPage();
  tracker.on('pageerror', (error) => errors.push(error.message));
  let collectionRequests = 0;
  tracker.on('request', (request) => {
    if (request.url() === `${base}/api/collect`) collectionRequests++;
  });
  const responseOn = () =>
    tracker.waitForResponse((response) => response.url() === `${base}/api/collect`, {
      timeout: 25000,
    });
  let response = responseOn();
  await tracker.goto(`http://localhost:${fixture.port}/first`);
  expect((await response).status()).toBe(403);
  await setting.click();
  await expect(setting).toBeChecked();
  response = responseOn();
  await tracker.reload();
  expect((await response).status()).toBe(202);
  response = responseOn();
  await tracker.getByRole('button', { name: 'Next page' }).click({ noWaitAfter: true });
  expect((await response).status()).toBe(202);
  response = responseOn();
  await tracker.getByRole('button', { name: 'Event', exact: true }).click({ noWaitAfter: true });
  expect((await response).status()).toBe(202);
  const requestsBeforeThrottle = collectionRequests;
  const throttleLog = () =>
    tracker.waitForEvent(
      'console',
      (message) =>
        message.text() ===
        '[Analytics Beer] Pageview ignored - throttled (same URL within 1 minute)',
    );
  let skipped = throttleLog();
  await tracker.reload();
  await skipped;
  skipped = throttleLog();
  await tracker.getByRole('button', { name: 'Back to first' }).click({ noWaitAfter: true });
  await skipped;
  expect(collectionRequests).toBe(requestsBeforeThrottle);
  response = responseOn();
  await tracker.getByRole('button', { name: 'Event', exact: true }).click({ noWaitAfter: true });
  expect((await response).status()).toBe(202);
  pass(
    'Same-URL reload and return navigation are throttled with a console message; custom events remain independent',
  );
  await expect
    .poll(
      async () =>
        (await client.query('select count(*)::int as count from events where site_id=$1', [siteId]))
          .rows[0].count,
      { timeout: 60000, intervals: [1000, 2000, 4000] },
    )
    .toBe(4);
  const report = await context.request.get(`${base}/api/sites/${siteId}/overview`);
  expect(report.status()).toBe(200);
  expect(await report.json()).toMatchObject({
    pageviews: 2,
    customEvents: 2,
    dailyUniqueVisitors: 1,
  });
  await page.getByRole('button', { name: 'Check installation' }).click();
  await expect(page.getByText('Your script is working.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'View dashboard' }).click();
  await expect(
    page.getByRole('button', { name: 'Pageviews', exact: false }).locator('strong'),
  ).toHaveText('2');
  await expect(page.getByTestId('traffic-chart').locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/production/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
      timeout: 5000,
    })
    .toBe(true);
  await page.screenshot({ path: 'artifacts/production/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass(
    'Direct browser tracker → public collector → remote Queue → production Neon → report and responsive dashboard',
  );

  const patch = (data: Record<string, unknown>, origin = base) =>
    context.request.patch(`${base}/api/sites/${siteId}`, { headers: { Origin: origin }, data });
  expect((await patch({ name: 'Unauthorized change' }, 'https://untrusted.example')).status()).toBe(
    403,
  );
  expect((await patch({ enabled: false })).status()).toBe(200);
  response = responseOn();
  await tracker.goto(`http://localhost:${fixture.port}/paused-check`);
  expect((await response).status()).toBe(404);
  expect((await patch({ enabled: true, allowLocalhost: false })).status()).toBe(200);
  response = responseOn();
  await tracker.goto(`http://localhost:${fixture.port}/revoked-check`);
  expect((await response).status()).toBe(403);
  await tracker.close();
  pass(
    'Cross-origin mutation rejection, immediately paused collection, and immediately revoked localhost permission',
  );

  const oldCookie = (await context.cookies(base))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    (await context.request.get(`${base}/api/me`, { headers: { Cookie: oldCookie } })).status(),
  ).toBe(401);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'production-qa.example.com', exact: true }),
  ).toBeVisible();
  pass(
    'Browser sign-out revokes the old cookie immediately; invalid password rejected; valid sign-in succeeds',
  );
  expect(errors).toEqual([]);
} catch (error) {
  await page.screenshot({ path: 'artifacts/production/failure.png', fullPage: true });
  console.error('Browser state:', (await page.locator('body').innerText()).slice(0, 1600));
  console.error(
    'Overflow:',
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('body *'))
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          width: element.getBoundingClientRect().width,
          right: element.getBoundingClientRect().right,
        })),
    ),
  );
  throw error;
} finally {
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
  fixture?.stop(true);
  await browser.close();
}
await writeFile(
  'artifacts/production/verification.json',
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      base,
      runtime: `${useBrave ? 'Brave with GPC enabled' : 'Chromium'} → public Cloudflare Worker/Hyperdrive/Queues → Neon production`,
      checks,
      errors,
      disposableAccountRemoved: true,
    },
    null,
    2,
  ) + '\n',
);
