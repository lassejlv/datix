// Sandbox-only billing smoke. Start the app on localhost:3058 against TEST_DATABASE_URL.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
const key = process.env.AUTUMN_SECRET_KEY;
const db = process.env.TEST_DATABASE_URL;
if (
  !key?.startsWith('am_sk_test_') ||
  !db ||
  new URL(db).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(db).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw Error('Isolated database and Autumn sandbox required.');
const base = 'http://localhost:3058';
const client = new Client({ connectionString: db });
await client.connect();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
let owner: string | undefined;
const directory = 'web/artifacts/autumn';
await Bun.$`mkdir -p ${directory}`;
const autumn = async (path: string, body: unknown) => {
  const response = await fetch(`https://api.useautumn.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'x-api-version': '2.2',
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (path === 'customers.delete' && response.status === 404) return {};
  if (!response.ok) throw Error(`Autumn ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value as any;
};
try {
  await page.goto(`${base}/pricing`);
  await expect(page.getByRole('heading', { name: 'Basic', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ultra', exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/pricing-monthly.png`, fullPage: true });
  await page.getByRole('button', { name: /Yearly/ }).click();
  await expect(page.locator('.pricing-card').first()).toContainText('$90');
  await page.screenshot({ path: `${directory}/pricing-annual.png`, fullPage: true });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: 'Autumn QA',
      email: `autumn-qa-${crypto.randomUUID()}@example.com`,
      password: `Qa-${crypto.randomUUID()}!`,
    },
  });
  if (!signup.ok()) throw Error(`Signup failed ${signup.status()}`);
  owner = (await signup.json()).user.id;
  const checkout = await context.request.post(`${base}/api/billing/checkout`, {
    headers: { Origin: base },
    data: { events: 100000, interval: 'month', locale: 'en' },
  });
  if (!checkout.ok()) throw Error(`Checkout failed ${checkout.status()} ${await checkout.text()}`);
  const url = (await checkout.json()).url;
  const host = new URL(url).hostname;
  if (host !== 'checkout.stripe.com' && !host.endsWith('.useautumn.com'))
    throw Error('Unexpected hosted checkout');
  console.log('Hosted checkout created:', host);
  await page.goto(url);
  await page.locator('body').waitFor();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${directory}/checkout.png`, fullPage: true });
  console.log((await page.locator('body').innerText()).slice(0, 5000));
  if (process.argv.includes('--complete-test-checkout')) {
    await page.locator('[name="cardNumber"]').fill('4242424242424242');
    await page.locator('[name="cardExpiry"]').fill('1230');
    await page.locator('[name="cardCvc"]').fill('123');
    const name = page.locator('[name="billingName"]');
    if (await name.count()) await name.fill('Autumn QA');
    const postal = page.locator('[name="billingPostalCode"]');
    if (await postal.count()) await postal.fill('2100');
    await page.getByRole('button', { name: /Start trial|Subscribe/ }).click();
    await page.waitForURL(`${base}/usage**`, { timeout: 60000 });
    await expect
      .poll(
        async () => {
          const r = await context.request.post(`${base}/api/billing/sync`, {
            headers: { Origin: base },
            data: {},
          });
          return (await r.json()).plan?.name;
        },
        { timeout: 45000 },
      )
      .toBe('Basic');
    const customer = await autumn('customers.get', { customer_id: owner });
    if (!customer.subscriptions?.length) throw Error('Sandbox subscription missing');
    console.log('Basic trial activated and synchronized without app webhooks');
  }
} finally {
  if (owner) {
    await autumn('customers.delete', { customer_id: owner, delete_in_stripe: true });
    await client.query('DELETE FROM billing_customers WHERE owner_id=$1', [owner]);
    await client.query('DELETE FROM "user" WHERE id=$1', [owner]);
  }
  await browser.close();
  await client.end();
}
