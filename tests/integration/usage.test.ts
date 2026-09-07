import type { AppEnv } from '../../src/runtime/types';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { api } from '../../src/api/router.server';
import { database, withDatabase } from '../../src/db/client.server';
import { ingest, type EventMessage } from '../../src/analytics/ingest.server';
import { accountUsage } from '../../src/billing/usage.server';
import { allowancePeriod } from '../../src/billing/allowance';
import { cleanupPro, seedPro, testLargerProId } from '../fixtures/billing';

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('Use the isolated Neon test database.');
const client = new Client({ connectionString });
const db = database(client);
const ids: string[] = [];
const pending: EventMessage[] = [];
let testIp = Math.floor(Math.random() * 100);
const env = {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'usage-tests-auth-secret-with-more-than-32-chars',
  VISITOR_HASH_SECRET: 'usage-tests-visitor-secret-with-more-than-32-chars',
  DATABASE_URL: connectionString,
  EVENTS: {
    send: async (event: EventMessage) => {
      pending.push(event);
    },
  },
  COLLECT_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  API_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as AppEnv;
const request = (
  path: string,
  cookie = '',
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) =>
  api(
    new Request(`${env.APP_URL}/api${path}`, {
      method,
      headers: {
        cookie,
        origin: body && path === '/collect' ? 'https://usage.example' : env.APP_URL,
        'content-type': 'application/json',
        'user-agent': 'Usage QA browser',
        'cf-connecting-ip': `198.51.100.${1 + (++testIp % 200)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
async function workspace(pro = true) {
  const response = await request('/auth/sign-up/email', '', {
    name: 'Usage QA',
    email: `usage-${crypto.randomUUID()}@example.com`,
    password: 'usage-qa-password-long-enough',
  });
  expect(response.status).toBe(200);
  const id = ((await response.json()) as any).user.id as string;
  ids.push(id);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const sub = pro ? await seedPro(client, id) : null;
  const created = await request('/sites', cookie, { name: 'Usage QA', domain: 'usage.example' });
  expect(created.status).toBe(201);
  return { id, cookie, sub, siteId: ((await created.json()) as any).site.id as string };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
const message = (siteId: string, received = new Date()): EventMessage => ({
  version: 1,
  siteId,
  id: crypto.randomUUID(),
  receivedAt: received.toISOString(),
  day: received.toISOString().slice(0, 10),
  type: 'pageview',
  name: '',
  path: '/',
  referrer: '',
  country: '',
  device: 'desktop',
  visitor: 'a'.repeat(64),
});
const collect = (siteId: string) =>
  request('/collect', '', {
    siteId,
    id: crypto.randomUUID(),
    type: 'pageview',
    url: 'https://usage.example/',
  });
async function setUsed(work: Workspace, count: number) {
  const period = allowancePeriod(work.sub!, new Date())!;
  await client.query(
    'insert into billing_usage (owner_id,site_id,period_start,period_end,events) values ($1,$2,$3,$4,$5) on conflict (owner_id,period_start,site_id) do update set events=excluded.events',
    [work.id, work.siteId, period.start, period.end, count],
  );
}
beforeAll(() => client.connect());
afterAll(async () => {
  await cleanupPro(client, ids);
  await client.query('delete from "user" where id=any($1::text[])', [ids]);
  await client.end();
});

test('no Pro subscription pauses collection while setup and authenticated usage remain available', async () => {
  const work = await workspace(false);
  expect((await request('/usage')).status).toBe(401);
  const response = await collect(work.siteId);
  expect(response.status).toBe(202);
  expect((await response.json()) as any).toEqual({
    accepted: false,
    reason: 'subscription_required',
  });
  expect(await ingest(db, [message(work.siteId)])).toEqual({ inserted: 0 });
  const usage = (await (await request('/usage', work.cookie)).json()) as any;
  expect(usage).toMatchObject({ paused: true, pauseReason: 'subscription_required', plan: null });
  expect(usage.websites[0].paused).toBe(true);
  await seedPro(client, work.id);
  expect((await (await collect(work.siteId)).json()) as any).toEqual({ accepted: true });
});

test('concurrent batches and duplicate events never exceed the shared account limit', async () => {
  const work = await workspace();
  await setUsed(work, 99998);
  const second = await request('/sites', work.cookie, { name: 'Second', domain: 'second.example' });
  const secondId = ((await second.json()) as any).site.id;
  const duplicate = message(work.siteId);
  const results = await Promise.all([
    withDatabase(env, (db) => ingest(db, [duplicate, message(secondId)])),
    withDatabase(env, (db) => ingest(db, [duplicate, message(secondId), message(work.siteId)])),
  ]);
  expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(2);
  const usage = await accountUsage(db, work.id);
  expect(usage.events).toEqual({ used: 100000, remaining: 0 });
  expect(usage.pauseReason).toBe('event_limit');
  expect(usage.websites.every((site) => site.paused)).toBe(true);
  expect((await (await collect(work.siteId)).json()) as any).toEqual({
    accepted: false,
    reason: 'event_limit',
  });
  expect(
    (await client.query('select enabled from environments where id=$1', [work.siteId])).rows[0]
      .enabled,
  ).toBe(true);
  expect(
    (
      await client.query('select count(*)::int as n from events where site_id=any($1::uuid[])', [
        [work.siteId, secondId],
      ])
    ).rows[0].n,
  ).toBe(2);
  const stranger = await workspace();
  expect((await accountUsage(db, stranger.id)).events.used).toBe(0);
  expect(
    (await accountUsage(db, stranger.id)).websites.some((site) => site.id === work.siteId),
  ).toBe(false);
});

test('an upgrade resumes immediately without resetting usage; a new month gets a new allowance', async () => {
  const work = await workspace();
  await setUsed(work, 100000);
  expect((await accountUsage(db, work.id)).paused).toBe(true);
  work.sub = await seedPro(client, work.id, { productId: testLargerProId });
  expect((await accountUsage(db, work.id)).events).toEqual({ used: 100000, remaining: 150000 });
  expect((await ingest(db, [message(work.siteId)])).inserted).toBe(1);
  expect((await accountUsage(db, work.id)).events.used).toBe(100001);
  const next = new Date(allowancePeriod(work.sub, new Date())!.end);
  expect((await accountUsage(db, work.id, next)).events.used).toBe(0);
  expect((await ingest(db, [message(work.siteId, next)], next)).inserted).toBe(1);
  expect((await accountUsage(db, work.id, next)).events.used).toBe(1);
});

test('duplicate delivery and engagement do not consume an allowance; environment actions do', async () => {
  const work = await workspace();
  const first = message(work.siteId);
  const heartbeat: EventMessage = {
    ...message(work.siteId),
    version: 3,
    environmentId: work.siteId,
    type: 'event',
    name: 'auto.engagement',
    activity: {
      sessionKey: 'b'.repeat(64),
      visitorKey: 'b'.repeat(64),
      kind: 'engagement',
      browser: 'Chrome',
      os: 'macOS',
      details: {
        activeSeconds: 10,
        viewportWidth: 1440,
        viewportHeight: 900,
        screenWidth: 1440,
        screenHeight: 900,
        language: 'en',
      },
    },
  };
  expect((await ingest(db, [first, first, heartbeat])).inserted).toBe(2);
  expect((await ingest(db, [first, heartbeat])).inserted).toBe(0);
  expect((await accountUsage(db, work.id)).events.used).toBe(1);
  const created = await request(`/sites/${work.siteId}/environments`, work.cookie, {
    name: 'Staging',
    domain: 'usage.example',
  });
  expect(created.status).toBe(201);
  const environmentId = ((await created.json()) as any).environment.id;
  const action: EventMessage = {
    ...message(work.siteId),
    version: 2,
    environmentId,
    type: 'event',
    name: 'signup',
  };
  expect((await ingest(db, [action])).inserted).toBe(1);
  expect((await accountUsage(db, work.id)).events.used).toBe(1.5);
  expect(
    (
      await request(
        `/sites/${work.siteId}/environments/${work.siteId}`,
        work.cookie,
        { enabled: false },
        'PATCH',
      )
    ).status,
  ).toBe(200);
  const staging = await request('/collect', '', {
    siteId: work.siteId,
    environmentId,
    id: crypto.randomUUID(),
    type: 'pageview',
    url: 'https://usage.example/',
  });
  expect((await staging.json()) as any).toMatchObject({ accepted: true });
  expect((await ingest(db, [pending.at(-1)!])).inserted).toBe(1);
  expect((await accountUsage(db, work.id)).websites[0]!.paused).toBe(false);
});

test('deleting a site retains its usage and a queued event cannot bypass subscription revocation', async () => {
  const work = await workspace();
  await setUsed(work, 123);
  expect((await request(`/sites/${work.siteId}`, work.cookie, undefined, 'DELETE')).status).toBe(
    204,
  );
  expect((await accountUsage(db, work.id)).events.used).toBe(123);
  const other = await workspace();
  expect((await collect(other.siteId)).status).toBe(202);
  const queued = pending.at(-1)!;
  await client.query('update billing_customers set subscriptions=$1 where owner_id=$2', [
    '[]',
    other.id,
  ]);
  expect((await ingest(db, [queued])).inserted).toBe(0);
  expect((await accountUsage(db, other.id)).paused).toBe(true);
});

test('expired trials stop collection and concurrent website creation cannot exceed ten sites', async () => {
  const work = await workspace();
  await seedPro(client, work.id, {
    status: 'trialing',
    trialEnd: new Date(Date.now() - 1000).toISOString(),
  });
  expect((await (await collect(work.siteId)).json()) as any).toMatchObject({
    accepted: false,
    reason: 'subscription_required',
  });
  await seedPro(client, work.id);
  for (let i = 0; i < 8; i++)
    expect(
      (await request('/sites', work.cookie, { name: `Site ${i}`, domain: `usage-${i}.example` }))
        .status,
    ).toBe(201);
  const results = await Promise.all([
    request('/sites', work.cookie, { name: 'Last', domain: 'usage-last.example' }),
    request('/sites', work.cookie, { name: 'Extra', domain: 'usage-extra.example' }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect((await accountUsage(db, work.id)).websites).toHaveLength(10);
}, 20000);

test('weighted credits preserve raw counts, exact fractional boundaries and deduplication', async () => {
  const work = await workspace();
  await request(
    `/sites/${work.siteId}/environments/${work.siteId}`,
    work.cookie,
    { allowLocalhost: true },
    'PATCH',
  );
  const input = [
    message(work.siteId),
    { ...message(work.siteId), type: 'event' as const, name: 'click' },
    { ...message(work.siteId), localhost: true },
    { ...message(work.siteId), localhost: true, type: 'event' as const, name: 'click' },
  ];
  expect(await ingest(db, input)).toEqual({ inserted: 4 });
  expect(await ingest(db, input)).toEqual({ inserted: 0 });
  expect((await accountUsage(db, work.id)).events).toEqual({ used: 1.95, remaining: 99998.05 });
  const outbox = await client.query(
    'select sum(event_count)::text as credits from billing_outbox where owner_id=$1',
    [work.id],
  );
  expect(Number(outbox.rows[0].credits)).toBe(1.95);
  const totals = await client.query(
    "select pageviews,custom_events from daily_stats where site_id=$1 and dimension='total'",
    [work.siteId],
  );
  expect(Number(totals.rows[0].pageviews)).toBe(2);
  expect(Number(totals.rows[0].custom_events)).toBe(2);
  await setUsed(work, 99999.55);
  const results = await Promise.all(
    [0, 1].map(() =>
      withDatabase(env, (db) =>
        ingest(db, [
          { ...message(work.siteId), localhost: true },
          { ...message(work.siteId), localhost: true, type: 'event', name: 'click' },
        ]),
      ),
    ),
  );
  expect(results.reduce((sum, r) => sum + r.inserted, 0)).toBe(2);
  expect((await accountUsage(db, work.id)).events).toEqual({ used: 100000, remaining: 0 });
});

test('environment policy filters collection and queued events and strips optional details', async () => {
  const { defaultTrackingSettings } = await import('../../src/lib/tracking-settings');
  const work = await workspace();
  const path = `/sites/${work.siteId}/environments/${work.siteId}`;
  const settings = {
    ...defaultTrackingSettings,
    custom: false,
    referrer: false,
    country: false,
    device: false,
    dimensions: false,
    language: false,
    coordinates: false,
  };
  expect((await request(path, work.cookie, { trackingSettings: settings }, 'PATCH')).status).toBe(
    200,
  );
  const config = await request(`/tracker-config?siteId=${work.siteId}`);
  expect(config.headers.get('access-control-allow-origin')).toBe('*');
  expect((await config.json()) as any).toEqual({ enabled: true, settings });
  expect(
    (await request(path, work.cookie, { trackingSettings: { click: false } }, 'PATCH')).status,
  ).toBe(400);
  const rejected = await request('/collect', '', {
    siteId: work.siteId,
    id: crypto.randomUUID(),
    type: 'event',
    name: 'custom',
    url: 'https://usage.example/',
  });
  expect((await rejected.json()) as any).toEqual({ accepted: false, reason: 'event_disabled' });
  const pendingEvent: EventMessage = {
    ...message(work.siteId),
    version: 3,
    environmentId: work.siteId,
    referrer: 'private.example',
    country: 'DK',
    activity: {
      kind: 'click',
      sessionKey: 'a'.repeat(64),
      visitorKey: 'b'.repeat(64),
      browser: 'Chrome',
      os: 'macOS',
      details: {
        viewportWidth: 100,
        viewportHeight: 100,
        screenWidth: 200,
        screenHeight: 200,
        language: 'da-DK',
        x: 5,
        y: 10,
      },
    },
    type: 'event',
    name: 'auto.click',
  };
  expect(await ingest(db, [pendingEvent])).toEqual({ inserted: 1 });
  const raw = (
    await client.query('select * from activity_events where environment_id=$1 and id=$2', [
      work.siteId,
      pendingEvent.id,
    ])
  ).rows[0];
  expect(raw).toMatchObject({
    referrer: '',
    country: '',
    device: '',
    browser: '',
    os: '',
    details: { viewportWidth: 0, viewportHeight: 0, screenWidth: 0, screenHeight: 0, language: '' },
  });
  expect(raw.details.x).toBeUndefined();
  await request(path, work.cookie, { trackingSettings: { ...settings, click: false } }, 'PATCH');
  expect(await ingest(db, [{ ...pendingEvent, id: crypto.randomUUID() }])).toEqual({ inserted: 0 });
  expect((await accountUsage(db, work.id)).events.used).toBe(0.5);
  // Collector classifies local origins only after URL/Origin validation; clients cannot set the discount.
  await request(path, work.cookie, { allowLocalhost: true }, 'PATCH');
  const local = (origin: string, extra = {}) =>
    api(
      new Request(`${env.APP_URL}/api/collect`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'user-agent': 'QA Browser' },
        body: JSON.stringify({
          siteId: work.siteId,
          id: crypto.randomUUID(),
          type: 'pageview',
          url: 'http://localhost:4321/',
          ...extra,
        }),
      }),
      env,
    );
  expect((await local('http://localhost:4321')).status).toBe(202);
  expect(pending.at(-1)?.localhost).toBe(true);
  expect((await local('https://usage.example')).status).toBe(403);
  expect((await local('http://localhost:4321', { localhost: true })).status).toBe(400);
});

test('website budgets are authenticated, share capacity across environments, and renew independently', async () => {
  const work = await workspace();
  const stranger = await workspace();
  expect(
    (await request(`/sites/${work.siteId}`, stranger.cookie, { creditBudget: 1 }, 'PATCH')).status,
  ).toBe(404);
  for (const creditBudget of [-1, 0, 0.149, '5'])
    expect(
      (await request(`/sites/${work.siteId}`, work.cookie, { creditBudget }, 'PATCH')).status,
    ).toBe(400);
  const saved = await request(`/sites/${work.siteId}`, work.cookie, { creditBudget: 1 }, 'PATCH');
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as any).site.creditBudget).toBe(1);
  const staging = await request(`/sites/${work.siteId}/environments`, work.cookie, {
    name: 'Budget staging',
  });
  const environmentId = ((await staging.json()) as any).environment.id;
  const results = await Promise.all([
    withDatabase(env, (connection) => ingest(connection, [message(work.siteId)])),
    withDatabase(env, (connection) =>
      ingest(connection, [{ ...message(work.siteId), version: 2, environmentId }]),
    ),
  ]);
  expect(results.reduce((total, result) => total + result.inserted, 0)).toBe(1);
  let usage = await accountUsage(db, work.id);
  expect(usage.paused).toBe(false);
  expect(usage.events.used).toBe(1);
  expect(usage.websites[0]).toMatchObject({
    paused: true,
    pauseReason: 'website_budget',
    creditBudget: 1,
  });
  expect(((await (await collect(work.siteId)).json()) as any).reason).toBe('website_budget');
  const otherSite = (
    (await (
      await request('/sites', work.cookie, {
        name: 'Other website',
        domain: 'other-budget.example',
      })
    ).json()) as any
  ).site.id;
  expect((await ingest(db, [message(otherSite)])).inserted).toBe(1);
  expect(
    (await accountUsage(db, work.id)).websites.find((site) => site.id === otherSite)?.paused,
  ).toBe(false);

  const next = new Date(allowancePeriod(work.sub!, new Date())!.end);
  expect((await accountUsage(db, work.id, next)).websites[0]?.paused).toBe(false);
  expect(
    (await request(`/sites/${work.siteId}`, work.cookie, { creditBudget: null }, 'PATCH')).status,
  ).toBe(200);
  expect((await ingest(db, [message(work.siteId)])).inserted).toBe(1);
  usage = await accountUsage(db, work.id);
  expect(usage.websites[0]?.paused).toBe(false);
  expect(usage.events.used).toBe(3);
  const publicUsage = (await (await request('/usage', work.cookie)).json()) as any;
  expect(publicUsage.protection.blocked).toBe(0);
}, 30000);
