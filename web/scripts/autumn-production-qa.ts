// Creates disposable live checkout sessions, never submits a payment.
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';

process.chdir(new URL('../..', import.meta.url).pathname);
const base = 'https://usedatix.com';
const key = process.env.AUTUMN_SECRET_KEY;
const db = process.env.PRODUCTION_DATABASE_URL;
if (
  !process.argv.includes('--production') ||
  !key?.startsWith('am_sk_live_') ||
  !db ||
  new URL(db).hostname !== process.env.PRODUCTION_DATABASE_HOST
)
  throw Error('Explicit production flag, matching database, and live Autumn key required.');

const client = new Client({ connectionString: db });
await client.connect();
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const dir = 'web/artifacts/autumn-production';
await mkdir(dir, { recursive: true });
let owner: string | undefined;
const autumn = async (path: string, body: unknown) => {
  const r = await fetch(`https://api.useautumn.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-api-version': '2.2',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 404) return null;
  const data = await r.json();
  if (!r.ok) throw Error(`Autumn ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const cleanup = async () => {
  if (owner) {
    const customer = await autumn('customers.get', { customer_id: owner });
    if (customer?.subscriptions?.length)
      throw Error('Unexpected subscription; preserve fixture for review.');
    if (customer) await autumn('customers.delete', { customer_id: owner, delete_in_stripe: true });
    await client.query('DELETE FROM billing_customers WHERE owner_id=$1', [owner]);
    await client.query('DELETE FROM "user" WHERE id=$1', [owner]);
    console.log('PASS Removed disposable checkout customer and app account');
  }
};
try {
  for (const [events, interval, locale, name] of [
    [100000, 'month', 'en', 'Basic'],
    [100000, 'month', 'da', 'Basic'],
    [100000, 'month', 'de', 'Basic'],
    [100000, 'year', 'en', 'Basic'],
    [1000000, 'month', 'en', 'Pro'],
    [1000000, 'year', 'de', 'Pro'],
    [5000000, 'month', 'en', 'Ultra'],
    [5000000, 'year', 'da', 'Ultra'],
  ] as const) {
    if (process.argv.includes('--basic-trials') && (events !== 100000 || interval !== 'month'))
      continue;

    const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
      headers: { Origin: base },
      data: {
        name: 'Autumn production QA',
        email: `autumn-production-qa-${crypto.randomUUID()}@example.com`,
        password: `Qa-${crypto.randomUUID()}!`,
      },
    });
    expect(signup.status()).toBe(200);
    owner = (await signup.json()).user.id;
    const checkout = await context.request.post(`${base}/api/billing/checkout`, {
      headers: { Origin: base },
      data: { events, interval, locale },
    });
    if (!checkout.ok())
      throw Error(
        `Checkout ${name} ${interval} ${locale}: ${checkout.status()} ${await checkout.text()}`,
      );
    const url = (await checkout.json()).url;
    expect(new URL(url).hostname).toBe('checkout.stripe.com');
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Datix', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator('body')).toContainText(name);
    await expect(
      page.locator('a[href="https://support.link.com/topics/sold-through-link"]'),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    const rendered = await page.locator('body').innerText();
    await Bun.write(`${dir}/checkout-${name}-${interval}-${locale}.txt`, rendered);
    await page.screenshot({
      path: `${dir}/checkout-${name}-${interval}-${locale}.png`,
      fullPage: true,
    });
    console.log(
      `PASS ${name} ${interval} ${locale}: live Stripe checkout rendered; no payment submitted`,
    );
    if (name === 'Basic')
      await expect(page.locator('body')).toContainText(
        locale === 'da' ? '14 dage gratis' : locale === 'de' ? '14 Tage kostenlos' : '14 days free',
      );
    await cleanup();
    owner = undefined;
  }
  expect((await context.request.get(`${base}/api/webhooks/polar`)).status()).toBe(404);
} finally {
  try {
    await cleanup();
  } finally {
    await browser.close();
    await client.end();
  }
}
