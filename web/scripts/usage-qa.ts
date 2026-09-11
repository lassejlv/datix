// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import catalog from '../../config/polar-catalog.json';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { cleanupPro, seedPro, testLargerProId } from '../tests/fixtures/billing';

const production = process.argv.includes('--production');
const base = production
  ? 'https://usedatix.com'
  : (process.env.QA_BASE_URL ?? 'http://localhost:3000');
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL']!;
if (
  !connectionString ||
  (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw new Error('Wrong database environment.');
const client = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const dir = `web/artifacts/usage/${production ? 'production' : 'local'}`;
const email = `usage-browser-${crypto.randomUUID()}@example.com`;
const password = `Qa!${crypto.randomUUID()}`;
let ownerId: string | undefined;
let fixture: ReturnType<typeof Bun.serve> | undefined;
const readUsage = async () => (await context.request.get(`${base}/api/usage`)).json();
const refresh = async () => {
  await page.reload();
  await expect(page.getByRole('progressbar')).toBeVisible();
};
try {
  await client.connect();
  await mkdir(dir, { recursive: true });
  await page.goto(`${base}/signup`);
  await page.getByLabel('Your name', { exact: true }).fill('Usage verification');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add your first website' })).toBeVisible();
  ownerId = ((await (await context.request.get(`${base}/api/me`)).json()) as any).user.id;
  const response = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Example website', domain: 'usage-qa.example.com' },
  });
  expect(response.status()).toBe(201);
  const siteId = (await response.json()).site.id;
  const setting = await context.request.patch(
    `${base}/api/sites/${siteId}/environments/${siteId}`,
    { headers: { origin: base }, data: { allowLocalhost: true } },
  );
  expect(setting.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect your website' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to plans' }).click();
  await expect(page.locator('#plan-required-title')).toBeVisible();
  await page.screenshot({ path: `${dir}/no-plan.png`, fullPage: true });
  await seedPro(client, ownerId!);
  const period = (await readUsage()).period;
  await client.query(
    'insert into billing_organization_usage (owner_id,site_id,period_start,period_end,events,organization_id) values ($1,$2,$3,$4,70020,$5)',
    [ownerId, siteId, period.start, period.end, catalog.organizationId],
  );
  await page.goto(`${base}/site/${siteId}/${siteId}/settings?tab=usage`);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70020');
  await expect(page.getByText('Collecting', { exact: true })).toBeVisible();
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
    ['dark', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `${dir}/${theme}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await client.query('update billing_organization_usage set events=99999 where owner_id=$1', [
    ownerId,
  ]);
  fixture = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return new Response(
        `<!doctype html><html><head><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body><button data-analytics-label="over-limit-click">Click</button></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  const tracked = await context.newPage();
  await tracked.goto(`http://localhost:${fixture.port}`);
  await expect.poll(async () => (await readUsage()).events.used, { timeout: 30000 }).toBe(100000);
  await refresh();
  await expect(page.getByText('Tracking paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100000');
  await page.screenshot({ path: `${dir}/limit-reached.png`, fullPage: true });
  const rejected = tracked.waitForResponse((r) => r.url().endsWith('/api/collect'));
  await tracked.getByRole('button', { name: 'Click', exact: true }).click();
  expect(await (await rejected).json()).toMatchObject({ accepted: false, reason: 'event_limit' });
  expect((await readUsage()).events.used).toBe(100000);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByText('Tracking paused · Event limit reached', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'View usage', exact: true }).click();
  await seedPro(client, ownerId!, { productId: testLargerProId });
  await refresh();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '250000');
  await expect(page.getByText('Tracking paused', { exact: true })).toBeVisible();
  const accepted = tracked.waitForResponse((r) => r.url().endsWith('/api/collect'));
  await tracked.getByRole('button', { name: 'Click', exact: true }).click();
  expect(await (await accepted).json()).toMatchObject({ accepted: true });
  await expect.poll(async () => (await readUsage()).events.used, { timeout: 30000 }).toBe(100001);
  await tracked.close();
  expect(errors).toEqual([]);
  const result = {
    base,
    verifiedAt: new Date().toISOString(),
    noPlanPaused: true,
    navigation: true,
    responsive: true,
    exactEventLimit: true,
    realTrackerAndQueue: true,
    upgradeResumed: true,
    errors,
  };
  await writeFile(`${dir}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (ownerId) {
    await cleanupPro(client, [ownerId]);
    await client.query('delete from "user" where id=$1', [ownerId]);
  } else await client.query('delete from "user" where email=$1', [email]);
  fixture?.stop(true);
  await client.end();
  await browser.close();
}
