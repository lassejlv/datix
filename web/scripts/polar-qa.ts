// Local Rust/browser integration with a disposable, in-process Polar-compatible mock.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import fixture from '../tests/fixtures/polar-customer-state.json';
import catalog from '../../config/polar-catalog.json';
const db = process.env.TEST_DATABASE_URL;
if (
  !db ||
  new URL(db).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(db).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw Error('Isolated test database required');
const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
const port = probe.port!;
probe.stop(true);
const base = `http://localhost:${port}`;
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
const state = structuredClone(fixture);
state.id = crypto.randomUUID();
state.active_subscriptions[0].id = crypto.randomUUID();
state.active_subscriptions[0].status = 'trialing';
state.active_subscriptions[0].current_period_start = new Date(Date.now() - 60000).toISOString();
state.active_subscriptions[0].current_period_end = new Date(
  Date.now() + 14 * 86400000,
).toISOString();
Object.assign(state.active_subscriptions[0], {
  trial_end: state.active_subscriptions[0].current_period_end,
});
let customer = false;
let active = false;
let checkout: any;
let webhookId: string | undefined;
let owner: string | undefined;
const mock = Bun.serve({
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/checkout')
      return new Response(
        '<h1>Local Polar checkout</h1><p>Basic · USD 9 · 14-day trial</p><form action="/confirm" method="post"><button>Confirm test trial</button></form>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    if (path === '/portal')
      return new Response('<h1>Local Polar customer portal</h1>', {
        headers: { 'Content-Type': 'text/html' },
      });
    if (path === '/confirm') {
      active = true;
      webhookId = `polar-qa-${crypto.randomUUID()}`;
      const timestamp = `${Math.floor(Date.now() / 1000)}`;
      const body = JSON.stringify({
        type: 'customer.state_changed',
        timestamp: new Date().toISOString(),
        data: state,
      });
      const signature = createHmac('sha256', key)
        .update(`${webhookId}.${timestamp}.${body}`)
        .digest('base64');
      const response = await fetch(`${base}/api/webhooks/polar`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${signature}`,
        },
        body,
      });
      if (!response.ok) return new Response(`Webhook failed ${response.status}`, { status: 500 });
      return Response.redirect(`${base}/usage?checkout_id=${checkout.id}`, 303);
    }
    if (
      request.headers.get('authorization') !== 'Bearer polar-local-qa' ||
      request.headers.get('Polar-Version') !== catalog.apiVersion
    )
      return new Response('', { status: 401 });
    if (path.endsWith('/state'))
      return customer
        ? Response.json({
            ...state,
            active_subscriptions: active ? state.active_subscriptions : [],
            granted_benefits: active ? state.granted_benefits : [],
          })
        : new Response('', { status: 404 });
    if (path === '/v1/customers/') {
      const body = (await request.json()) as any;
      state.external_id = body.external_id;
      customer = true;
      return Response.json(state);
    }
    if (path === '/v1/subscriptions/')
      return Response.json({
        items: active ? [{ ...state.active_subscriptions[0], customer_id: state.id }] : [],
        pagination: { max_page: 1 },
      });
    if (path === '/v1/checkouts/') {
      const body = (await request.json()) as any;
      if (
        body.currency !== 'usd' ||
        body.products[0] !== catalog.plans[0].productId ||
        !body.allow_trial
      )
        return new Response('', { status: 422 });
      checkout = {
        id: crypto.randomUUID(),
        product_id: body.products[0],
        customer_id: state.id,
        currency: 'usd',
        status: 'open',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        url: `${mock.url}checkout`,
      };
      return Response.json(checkout);
    }
    if (path.startsWith('/v1/checkouts/')) return Response.json(checkout);
    if (path === '/v1/customer-sessions/')
      return Response.json({ customer_id: state.id, customer_portal_url: `${mock.url}portal` });
    return new Response('', { status: 404 });
  },
});
const app = Bun.spawn(['target/debug/analytics-server'], {
  env: {
    ...process.env,
    DATABASE_URL: db,
    REDIS_URL: 'redis://127.0.0.1:6394',
    APP_URL: base,
    PORT: `${port}`,
    SERVICE_ROLE: 'api',
    POLAR_ACCESS_TOKEN: 'polar-local-qa',
    POLAR_API_URL: mock.url.toString().replace(/\/$/, ''),
    POLAR_WEBHOOK_SECRET: `whsec_${key.toString('base64')}`,
    EVENT_STREAM: `polar-qa-${crypto.randomUUID()}`,
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const client = new Client({ connectionString: db });
await client.connect().catch(async (error) => {
  app.kill();
  await app.exited;
  mock.stop(true);
  throw error;
});
const browser = await chromium.launch().catch(async (error) => {
  app.kill();
  await app.exited;
  mock.stop(true);
  await client.end();
  throw error;
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir('web/artifacts/polar', { recursive: true });
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${base}/api/health`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 30000 },
    )
    .toBe(200);
  for (const locale of ['en', 'da', 'de']) {
    await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
    await page.goto(`${base}/pricing`);
    await expect(page.getByRole('heading', { name: 'Basic', exact: true })).toBeVisible();
    await expect(page.locator('.pricing-card').first()).toContainText('9');
    await expect(page.locator('.pricing-card').first()).toContainText('$');
    await page.screenshot({ path: `web/artifacts/polar/pricing-${locale}.png`, fullPage: true });
  }
  await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
  await page.reload();
  await page.getByRole('button', { name: /Yearly/ }).click();
  await expect(page.locator('.pricing-card').first()).toContainText('90');
  await expect(page.locator('.pricing-card').first()).toContainText('Coming soon');
  for (const button of await page.getByRole('button', { name: 'Coming soon' }).all()) {
    await expect(button).toBeDisabled();
  }
  await page.screenshot({ path: 'web/artifacts/polar/pricing-annual.png', fullPage: true });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: 'Polar QA',
      email: `polar-qa-${crypto.randomUUID()}@example.com`,
      password: `Qa-${crypto.randomUUID()}!`,
    },
  });
  if (!signup.ok()) throw Error(`Signup ${signup.status()}`);
  owner = (await signup.json()).user.id;
  await page.goto(`${base}/usage`);
  await page.getByRole('tab', { name: 'Billing', exact: true }).click();
  await page.getByRole('button', { name: 'Choose plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local Polar checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm test trial' }).click();
  await page.getByRole('tab', { name: 'Billing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage billing', exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText('Basic');
  await page.screenshot({ path: 'web/artifacts/polar/active-trial.png', fullPage: true });
  await page.getByRole('button', { name: 'Manage billing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local Polar customer portal' })).toBeVisible();
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    'PASS: USD pricing en/da/de, annual gate, browser checkout, signed trial activation, portal; local mock only.',
  );
} finally {
  await browser.close();
  app.kill();
  await app.exited;
  mock.stop(true);
  if (webhookId)
    await client.query('DELETE FROM billing_webhook_events WHERE id=$1', [
      `polar:${catalog.organizationId}:${webhookId}`,
    ]);
  if (owner) {
    await client.query('DELETE FROM billing_customers WHERE owner_id=$1', [owner]);
    await client.query('DELETE FROM "user" WHERE id=$1', [owner]);
  }
  await client.end();
}
