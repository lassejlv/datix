import type { AppEnv } from '../../src/runtime/types';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import type { Polar } from '@polar-sh/sdk';
import { database, withDatabase } from '../../src/db/client.server';
import { billingOutbox, billingCustomers, billingCheckouts } from '../../src/db/schema';
import { billingApi, checkoutSelection, syncCustomer } from '../../src/billing/polar.server';
import { POLAR_ORGANIZATION_ID } from '../../src/billing/webhook.server';
import { deliverUsage } from '../../src/billing/delivery.server';
import { ingest, type EventMessage } from '../../src/analytics/ingest.server';
import { seedPro, cleanupPro, testProId, testLargerProId } from '../fixtures/billing';
import { api } from '../../src/api/router.server';

const connectionString = process.env.TEST_DATABASE_URL!;
if (
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('Use isolated test database.');
const client = new Client({ connectionString });
const db = database(client);
const ids: string[] = [];
const env = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: connectionString,
  POLAR_ACCESS_TOKEN: 'test-no-network',
  BETTER_AUTH_SECRET: 'billing-qa-secret-with-more-than-32-chars',
  VISITOR_HASH_SECRET: 'billing-qa-visitor-with-more-than-32-chars',
  API_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as AppEnv;
const missing = () => Promise.reject({ statusCode: 404 });
const request = (path: string, body = {}) =>
  new Request(`${env.APP_URL}/api/billing/${path}`, {
    method: 'POST',
    headers: { origin: env.APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function owner() {
  const value = {
    id: `billing-test-${crypto.randomUUID()}`,
    email: `billing-${crypto.randomUUID()}@example.com`,
    name: 'Billing QA',
  };
  ids.push(value.id);
  await client.query(
    'insert into "user" (id,email,name,created_at,updated_at) values ($1,$2,$3,now(),now())',
    [value.id, value.email, value.name],
  );
  return value;
}
beforeAll(() => client.connect());
afterAll(async () => {
  await cleanupPro(client, ids);
  await client.query('delete from billing_customers where owner_id=any($1::text[])', [ids]);
  await client.query('delete from "user" where id=any($1::text[])', [ids]);
  await client.end();
});

test('checkout allowlist rejects yearly, unknown volumes, supplied customer IDs and prices', () => {
  expect(checkoutSelection({ events: 100000, interval: 'month' }).productId).toBe(testProId);
  for (const body of [
    { events: 100000, interval: 'year' },
    { events: 1, interval: 'month' },
    { events: 100000, interval: 'month', customerId: 'other' },
    { events: 100000, interval: 'month', amount: 0 },
  ])
    expect(() => checkoutSelection(body)).toThrow();
});

test('billing endpoints reject signed-out and cross-origin requests before contacting Polar', async () => {
  for (const path of ['checkout', 'portal', 'sync']) {
    expect((await api(request(path), env)).status).toBe(401);
    const req = request(path);
    req.headers.set('origin', 'https://attacker.example');
    expect((await api(req, env)).status).toBe(403);
  }
});

test('checkout derives identity and price from account/catalog; concurrent attempts reuse one session and recover lost cache', async () => {
  const account = await owner();
  let creates = 0;
  let checkout: any;
  const allCheckouts: any[] = [];
  const polar = {
    customers: { getStateExternal: missing, create: async () => ({ id: 'test-customer' }) },
    products: {
      get: async () => ({
        organizationId: POLAR_ORGANIZATION_ID,
        visibility: 'private',
        isArchived: false,
      }),
    },
    checkouts: {
      list: async () => ({ result: { items: allCheckouts } }),
      get: async () => checkout,
      update: async (input: any) => {
        checkout.productId = input.checkoutUpdate.productId;
        return checkout;
      },
      create: async (input: any) => {
        creates++;
        expect(input.externalCustomerId).toBe(account.id);
        expect(input.customerEmail).toBe(account.email);
        expect(input.successUrl).toBe(`${env.APP_URL}/usage?checkout_id={CHECKOUT_ID}`);
        expect(input.prices).toBeUndefined();
        expect(input.products).toHaveLength(1);
        expect(input.allowTrial).toBe(input.products[0] === testProId);
        checkout = {
          id: crypto.randomUUID(),
          externalCustomerId: account.id,
          organizationId: POLAR_ORGANIZATION_ID,
          status: 'open',
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          allowTrial: input.allowTrial,
          products: input.products.map((id: string) => ({ id })),
          productId: input.products[0],
          url: 'https://polar.sh/checkout/test',
        };
        allCheckouts.push(checkout);
        return checkout;
      },
    },
  } as unknown as Polar;
  const responses = await Promise.all(
    [0, 1].map(() =>
      withDatabase(env, (database) =>
        billingApi(
          request('checkout', { events: 100000, interval: 'month' }),
          database,
          env,
          account,
          polar,
        ),
      ),
    ),
  );
  expect(creates).toBe(1);
  for (const result of responses)
    expect(((await result.json()) as { url: string }).url).toBe(checkout.url);
  await billingApi(
    request('checkout', { events: 250000, interval: 'month' }),
    db,
    env,
    account,
    polar,
  );
  expect(checkout.productId).toBe(testLargerProId);
  expect(creates).toBe(2);
  await db.delete(billingCheckouts).where(eq(billingCheckouts.ownerId, account.id));
  await billingApi(
    request('checkout', { events: 100000, interval: 'month' }),
    db,
    env,
    account,
    polar,
  );
  expect(creates).toBe(2);
});

test('provider state is tenant checked, older API snapshots cannot overwrite a newer webhook, existing subscriptions go to portal', async () => {
  const account = await owner();
  const sub = await seedPro(client, account.id);
  const state = {
    id: crypto.randomUUID(),
    organizationId: POLAR_ORGANIZATION_ID,
    externalId: account.id,
    deletedAt: null,
    activeSubscriptions: [
      {
        ...sub,
        currentPeriodStart: new Date(sub.currentPeriodStart!),
        currentPeriodEnd: new Date(sub.currentPeriodEnd),
        trialEnd: null,
        endsAt: null,
      },
    ],
  };
  let input: any;
  const polar = {
    customers: { getStateExternal: async () => state },
    customerSessions: {
      create: async (body: any) => {
        input = body;
        return { customerPortalUrl: 'https://polar.sh/test-portal' };
      },
    },
  } as unknown as Polar;
  const response = await billingApi(
    request('checkout', { events: 100000, interval: 'month' }),
    db,
    env,
    account,
    polar,
  );
  expect(((await response.json()) as { url: string }).url).toBe('https://polar.sh/test-portal');
  expect(input.externalCustomerId).toBe(account.id);
  await db
    .update(billingCustomers)
    .set({ occurredAt: new Date(Date.now() + 60000).toISOString(), subscriptions: [] })
    .where(eq(billingCustomers.customerId, state.id));
  await syncCustomer(db, account.id, polar);
  expect(
    (await db.select().from(billingCustomers).where(eq(billingCustomers.customerId, state.id)))[0]!
      .subscriptions,
  ).toEqual([]);
  state.externalId = 'different-owner';
  await expect(syncCustomer(db, account.id, polar)).rejects.toThrow('verified');
});

test('committed usage emits only counted quantities; failure, partial response and concurrent delivery preserve stable retry IDs', async () => {
  const account = await owner();
  await seedPro(client, account.id);
  const site = (
    await client.query('insert into sites (owner_id,name,domain) values ($1,$2,$3) returning id', [
      account.id,
      'Outbox QA',
      `${crypto.randomUUID()}.example.com`,
    ])
  ).rows[0].id;
  const now = new Date();
  const event: EventMessage = {
    version: 1,
    siteId: site,
    id: crypto.randomUUID(),
    receivedAt: now.toISOString(),
    day: now.toISOString().slice(0, 10),
    type: 'pageview',
    name: '',
    path: '/private',
    referrer: '',
    country: 'DK',
    device: 'desktop',
    visitor: 'a'.repeat(64),
  };
  await ingest(db, [event, { ...event, id: crypto.randomUUID(), type: 'event', name: 'button' }]);
  await ingest(db, [event]);
  const outgoing = () =>
    db.select().from(billingOutbox).where(eq(billingOutbox.ownerId, account.id));
  expect((await outgoing()).reduce((n, r) => n + r.eventCount, 0)).toBe(1.5);
  const seen = new Map<string, any>();
  let calls = 0;
  const transport = {
    events: {
      ingest: async (body: any) => {
        calls++;
        let duplicates = 0;
        for (const e of body.events) {
          expect(e.externalCustomerId).toBe(account.id);
          expect(Object.keys(e.metadata).sort()).toEqual(['event_count', 'event_type']);
          expect(e.timestamp.toISOString()).toBe(now.toISOString());
          if (seen.has(e.externalId)) duplicates++;
          seen.set(e.externalId, e);
        }
        if (calls === 1) throw new Error('Response lost after provider commit');
        return { inserted: body.events.length - duplicates, duplicates };
      },
    },
  } as unknown as Pick<Polar, 'events'>;
  await expect(deliverUsage(db, transport)).rejects.toThrow('PolarUsageDeliveryFailed');
  expect(await outgoing()).toHaveLength(2);
  await db
    .update(billingOutbox)
    .set({ availableAt: new Date(0) })
    .where(eq(billingOutbox.ownerId, account.id));
  await Promise.all(
    [0, 1].map(() => withDatabase(env, (database) => deliverUsage(database, transport))),
  );
  expect(await outgoing()).toHaveLength(0);
  expect(seen.size).toBe(2);
  expect(calls).toBe(2);
  await ingest(db, [{ ...event, id: crypto.randomUUID() }]);
  await expect(
    deliverUsage(db, {
      events: { ingest: async () => ({ inserted: 0, duplicates: 0 }) },
    } as unknown as Pick<Polar, 'events'>),
  ).rejects.toThrow();
  expect(await outgoing()).toHaveLength(1);
  await db.delete(billingOutbox).where(eq(billingOutbox.ownerId, account.id));
});
