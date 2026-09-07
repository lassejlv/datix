import { chromium, expect } from '@playwright/test';
import { Polar } from '@polar-sh/sdk';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';

const production = process.argv.includes('--production');
const base = production ? 'https://analytics.beer' : 'http://localhost:3000';
const dbUrl = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL']!;
if (production && new URL(dbUrl).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw new Error('Wrong database.');
const polar = new Polar({
  accessToken: (await Bun.file('.local/polar-access-token').text()).trim(),
  timeoutMs: 10000,
  retryConfig: { strategy: 'none' },
});
const client = new Client({ connectionString: dbUrl });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
const page = await context.newPage();
const directory = `artifacts/billing/${production ? 'production' : 'local'}`;
const email = `billing-qa-${crypto.randomUUID()}@analytics.beer`;
let ownerId: string | undefined, customerId: string | undefined, checkoutId: string | undefined;
let fixture: ReturnType<typeof Bun.serve> | undefined;
let step = 'start';
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.name));
try {
  await client.connect();
  await mkdir(directory, { recursive: true });
  step = 'guest pricing and signup';
  await page.goto(`${base}/pricing`);
  await page.getByRole('button', { name: 'Explore Pro', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page).toHaveURL(`${base}/signup`);
  await page.getByLabel('Your name', { exact: true }).fill('Billing verification');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(`Qa!${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(`${base}/usage`);
  await expect(page.getByRole('button', { name: 'Start Pro', exact: true })).toBeVisible();
  ownerId = (await (await context.request.get(`${base}/api/me`)).json()).user.id;
  await page.screenshot({ path: `${directory}/usage-monthly.png`, fullPage: true });
  step = 'hosted checkout';
  const checkoutResponsePromise = page.waitForResponse(
    (r) => r.url() === `${base}/api/billing/checkout` && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start Pro', exact: true }).click();
  const checkoutResponse = await checkoutResponsePromise;
  expect(checkoutResponse.status()).toBe(200);
  await page.waitForURL('https://polar.sh/**', { timeout: 30000 });
  await expect(page.getByText('Pro 100k — Monthly', { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });
  checkoutId = (
    await client.query('select checkout_id from billing_checkouts where owner_id=$1', [ownerId])
  ).rows[0].checkout_id;
  const checkout = await polar.checkouts.get({ id: checkoutId! });
  customerId = checkout.customerId ?? undefined;
  expect(checkout.products).toHaveLength(1);
  await expect(page.getByText('Pro 250k — Monthly', { exact: true })).toHaveCount(0);
  expect(checkout.productId).toBe('a0de3cc9-ea92-4e95-b23e-b8d9240685aa');
  expect(checkout.amount).toBe(900);
  expect(checkout.activeTrialIntervalCount).toBe(14);
  expect(checkout.status).toBe('open');
  await page.screenshot({ path: `${directory}/hosted-checkout.png`, fullPage: true });
  step = 'checkout retry and annual gate';
  const repeated = await context.request.post(`${base}/api/billing/checkout`, {
    headers: { origin: base },
    data: { events: 100000, interval: 'month' },
  });
  expect(repeated.status()).toBe(200);
  expect((await repeated.json()).url).toBe(checkout.url);
  const annual = await context.request.post(`${base}/api/billing/checkout`, {
    headers: { origin: base },
    data: { events: 100000, interval: 'year' },
  });
  expect(annual.status()).toBe(400);
  await page.goto(`${base}/pricing`);
  await page.getByRole('button', { name: 'Yearly', exact: true }).click();
  await page.getByRole('button', { name: 'Explore Pro', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue to checkout' })).toHaveCount(0);
  await expect(
    page.getByText('Yearly billing is not available yet. Choose monthly billing to start Pro.'),
  ).toBeVisible();
  step = 'provider customer and portal';
  const sync = await context.request.post(`${base}/api/billing/sync`, {
    headers: { origin: base },
    data: {},
  });
  expect(sync.status()).toBe(200);
  expect((await sync.json()).plan).toBeNull();
  await page.goto(`${base}/usage`);
  await expect(page.getByRole('button', { name: 'Manage billing' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage billing' }).click();
  await page.waitForURL('https://polar.sh/**', { timeout: 30000 });
  await expect(page.getByText('No Active Subscriptions', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.screenshot({ path: `${directory}/billing-portal.png`, fullPage: true });
  step = 'tracker usage delivery';
  // Only local entitlement fixtures are synthesized: this never starts a paid subscription.
  await seedPro(client, ownerId!);
  const siteResponse = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Billing QA', domain: `billing-qa-${crypto.randomUUID()}.analytics.beer` },
  });
  expect(siteResponse.status()).toBe(201);
  const siteId = (await siteResponse.json()).site.id;
  expect(
    (
      await context.request.patch(`${base}/api/sites/${siteId}/environments/${siteId}`, {
        headers: { origin: base },
        data: { allowLocalhost: true },
      })
    ).status(),
  ).toBe(200);
  fixture = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        `<html><body><button id="action">Test action</button><script defer src="${base}/tracker.js" data-site="${siteId}" data-endpoint="${base}/api/collect" data-respect-dnt="false"></script></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  const tracker = await context.newPage();
  await tracker.goto(`http://127.0.0.1:${fixture.port}`);
  await tracker.waitForFunction(() => Boolean((window as any).simpleAnalytics));
  await tracker.evaluate(() => (window as any).simpleAnalytics.track('billing_verification'));
  await expect
    .poll(
      async () =>
        Number(
          (
            await client.query(
              'select coalesce(sum(events),0) as n from billing_usage where owner_id=$1',
              [ownerId],
            )
          ).rows[0].n,
        ),
      { timeout: 45000 },
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        Number(
          (
            await client.query('select count(*) as n from billing_outbox where owner_id=$1', [
              ownerId,
            ])
          ).rows[0].n,
        ),
      { timeout: 45000 },
    )
    .toBe(0);
  const eventId = `billing-qa-dedup-${crypto.randomUUID()}`;
  const event = {
    name: 'analytics.events.v1',
    externalCustomerId: ownerId!,
    externalId: eventId,
    metadata: { event_type: 'event', event_count: 1 },
  };
  const first = await polar.events.ingest({ events: [event] });
  const duplicate = await polar.events.ingest({ events: [event] });
  expect(first.inserted).toBe(1);
  expect(duplicate.duplicates).toBe(1);
  expect(duplicate.inserted).toBe(0);
  const meters = await polar.customerMeters.list({ externalCustomerId: ownerId, limit: 100 });
  const meterSummary = meters.result.items.map((m) => ({
    meterId: m.meterId,
    consumedUnits: m.consumedUnits,
  }));
  await page.goto(`${base}/usage`);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await page.screenshot({ path: `${directory}/usage-active.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: `${directory}/usage-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
  await writeFile(
    `${directory}/verification.json`,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        production,
        hostedCheckoutOpened: true,
        checkoutId,
        monthlyPriceCents: checkout.amount,
        trialDays: checkout.activeTrialIntervalCount,
        retryReused: true,
        annualBlocked: true,
        portalOpened: true,
        actualTrackerEvents: 2,
        outboxDrained: true,
        providerDeduplication: true,
        meterSummary,
        paidPurchaseCompleted: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      success: true,
      production,
      actualTrackerEvents: 2,
      providerDeduplication: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      success: false,
      step,
      error: error instanceof Error ? error.name : 'UnknownError',
      status: (error as any)?.statusCode,
      diagnostic:
        error instanceof Error && error.name === 'Error'
          ? error.message
              .replace(/https?:\/\/\S+/g, '[url]')
              .replace(/polar_[A-Za-z0-9_]+/g, '[redacted]')
              .slice(0, 600)
          : undefined,
    }),
  );
  await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  fixture?.stop();
  if (!customerId && ownerId) {
    try {
      customerId = (await polar.customers.getStateExternal({ externalId: ownerId })).id;
    } catch {
      /* no customer created */
    }
  }
  if (customerId)
    await polar.customers
      .delete({ id: customerId })
      .catch(() => console.error('QA customer cleanup failed'));
  if (ownerId) {
    await cleanupPro(client, [ownerId]);
    await client.query('delete from billing_customers where owner_id=$1', [ownerId]);
    await client.query('delete from "user" where id=$1', [ownerId]);
  }
  await client.end();
  await browser.close();
}
