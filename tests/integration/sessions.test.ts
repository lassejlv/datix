import type { AppEnv } from '../../src/runtime/types';
import { seedPro, cleanupPro } from '../fixtures/billing';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { database } from '../../src/db/client.server';
import { api } from '../../src/api/router.server';
import { ingest, eventMessageSchema, type EventMessage } from '../../src/analytics/ingest.server';
import { retain } from '../../src/analytics/retention.server';
const url = process.env.TEST_DATABASE_URL!;
if (
  new URL(url).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(url).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw Error('Isolated test database required');
const client = new Client({ connectionString: url }),
  db = database(client),
  pending: EventMessage[] = [];
const users: string[] = [];
let cookie = '',
  stranger = '',
  site = '',
  other = '';
const env = {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'sessions-test-auth-secret-at-least-32-characters',
  VISITOR_HASH_SECRET: 'sessions-test-visitor-secret-at-least-32-characters',
  DATABASE_URL: url,
  EVENTS: {
    send: async (e: EventMessage) => {
      pending.push(e);
    },
  },
  COLLECT_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  API_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as AppEnv;
const req = (
  path: string,
  method = 'GET',
  body?: unknown,
  auth = cookie,
  origin: string = env.APP_URL,
) =>
  api(
    new Request(`${env.APP_URL}/api${path}`, {
      method,
      headers: {
        cookie: auth,
        origin,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 Chrome/153.0.0.0',
        'cf-connecting-ip': '192.0.2.123',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
const visitorId = crypto.randomUUID(),
  sessionId = crypto.randomUUID();
const details = {
  viewportWidth: 1280,
  viewportHeight: 800,
  screenWidth: 1920,
  screenHeight: 1080,
  language: 'en-GB',
};
const payload = (kind = 'pageview', extra: Record<string, unknown> = {}) => ({
  siteId: site,
  id: crypto.randomUUID(),
  type: kind === 'pageview' ? 'pageview' : 'event',
  ...(kind === 'pageview' ? {} : { name: `auto.${kind}` }),
  url: 'https://session.example/page?secret=discard',
  session: { consent: true, visitorId, sessionId, kind, details },
  ...extra,
});
const send = (body: unknown) => req('/collect', 'POST', body, '', 'https://session.example');
const report = async (suffix = '') =>
  (await req(`/sites/${site}/sessions${suffix}`)).json() as Promise<any>;
beforeAll(async () => {
  await client.connect();
  for (const role of ['owner', 'stranger']) {
    const r = await req(
      '/auth/sign-up/email',
      'POST',
      {
        name: role,
        email: `session-${role}-${crypto.randomUUID()}@example.com`,
        password: 'sessions-test-password',
      },
      '',
    );
    expect(r.status).toBe(200);
    users.push(((await r.json()) as any).user.id);
    await seedPro(client, users.at(-1)!);
    const c = r.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    if (role === 'owner') cookie = c;
    else stranger = c;
  }
  for (const set of [(id: string) => (site = id), (id: string) => (other = id)]) {
    const r = await req('/sites', 'POST', {
      name: 'Session QA',
      domain: `s${crypto.randomUUID()}.example`,
    });
    expect(r.status).toBe(201);
    set(((await r.json()) as any).site.id);
  }
  await client.query('update sites set domain=$1 where id=$2', ['session.example', site]);
}, 30000);
afterAll(async () => {
  await cleanupPro(client, users);
  await client.query('delete from "user" where id=any($1::text[])', [users]);
  await client.end();
}, 30000);

test('mode requires explicit consent metadata and strict, limited activity fields', async () => {
  expect((await send(payload())).status).toBe(400); // Sessions cannot enter cookieless environment.
  expect(
    (
      await req(`/sites/${site}/environments/${site}`, 'PATCH', {
        trackingMode: 'sessions',
      })
    ).status,
  ).toBe(200);
  const legacy = {
    siteId: site,
    id: crypto.randomUUID(),
    type: 'pageview',
    url: 'https://session.example/',
  };
  expect((await send(legacy)).status).toBe(400);
  const p = payload();
  expect((await send({ ...p, session: { ...p.session, consent: false } })).status).toBe(400);
  expect(
    (
      await send({
        ...p,
        session: { ...p.session, details: { ...details, password: 'private' } },
      })
    ).status,
  ).toBe(400);
  expect((await send({ ...p, session: { ...p.session, kind: 'click' } })).status).toBe(400);
  expect(
    (
      await req(
        `/sites/${site}/environments/${site}`,
        'PATCH',
        { trackingMode: 'sessions' },
        stranger,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await req(
        `/sites/${site}/environments/${site}`,
        'PATCH',
        { trackingMode: 'sessions' },
        cookie,
        'https://foreign.example',
      )
    ).status,
  ).toBe(403);
  expect((await send(p)).status).toBe(202);
  expect(pending[0]?.version).toBe(3);
  expect(eventMessageSchema.safeParse(pending[0]).success).toBe(true);
  expect(JSON.stringify(pending[0])).not.toContain(visitorId);
  expect(JSON.stringify(pending[0])).not.toContain(sessionId);
  expect(JSON.stringify(pending[0])).not.toContain('secret');
}, 15000);

test('sessions retain ordered actions, deduplicate retries, count clicks and active time, and reject tenant access', async () => {
  const click = payload('click');
  click.session.details = {
    ...details,
    target: 'checkout-button',
  } as typeof details;
  await send(click);
  const engagement = payload('engagement');
  engagement.session.details = {
    ...details,
    activeSeconds: 15,
  } as typeof details;
  await send(engagement);
  const outbound = payload('outbound');
  outbound.session.details = {
    ...details,
    destination: 'https://external.example/path?email=secret#token',
  } as typeof details;
  await send(outbound);
  expect(JSON.stringify(pending)).not.toContain('email=');
  expect((await ingest(db, [...pending, ...pending])).inserted).toBe(4);
  expect((await ingest(db, pending)).inserted).toBe(0);
  const r = await report();
  expect(r.summary).toEqual({
    sessions: 1,
    visitors: 1,
    averageActiveSeconds: 15,
    clicks: 1,
  });
  expect(r.sessions[0]).toMatchObject({
    pageviews: 1,
    clicks: 1,
    events: 3,
    entryPath: '/page',
  });
  const visitorKey = r.sessions[0].visitorKey;
  expect((await report(`?visitor=${visitorKey}`)).summary.sessions).toBe(1);
  expect((await report(`?visitor=${'f'.repeat(64)}`)).summary.sessions).toBe(0);
  expect((await req(`/sites/${site}/sessions?visitor=invalid`)).status).toBe(400);
  expect(
    (await req(`/sites/${site}/sessions?visitor=${visitorKey}`, 'GET', undefined, stranger)).status,
  ).toBe(404);
  const key = r.sessions[0].id;
  const timeline = await report(`?session=${key}`);
  expect(timeline.events).toHaveLength(3);
  expect(timeline.events.some((e: any) => e.details.target === 'checkout-button')).toBe(true);
  expect((await req(`/sites/${site}/sessions`, 'GET', undefined, stranger)).status).toBe(404);
  expect((await req(`/sites/${other}/sessions?session=${key}`)).status).toBe(404);
  expect((await req(`/sites/${site}/sessions?environment=${other}`)).status).toBe(404);
  const totals = (await (await req(`/sites/${site}/overview`)).json()) as any;
  expect(totals).toMatchObject({
    pageviews: 1,
    customEvents: 2,
    dailyUniqueVisitors: 1,
  });
  expect((await req(`/sites/${site}/sessions?offset=-1`)).status).toBe(400);
  pending.length = 0;
  const next = payload();
  next.session.sessionId = crypto.randomUUID();
  next.session.details = {
    ...details,
    clientTime: Date.now() - 1000,
    sequence: 2,
  } as typeof details;
  await send(next);
  const earlier = {
    ...next,
    id: crypto.randomUUID(),
    session: { ...next.session, details: { ...next.session.details, sequence: 1 } },
  };
  await send(earlier);
  await ingest(db, pending);
  const updated = await report();
  expect(updated.summary.sessions).toBe(2);
  expect(updated.summary.visitors).toBe(1);
  const ordered = updated.sessions.find((s: any) => s.pageviews === 2);
  const orderedEvents = await report(`?session=${ordered.id}`);
  expect(orderedEvents.events.map((e: any) => e.details.sequence)).toEqual([1, 2]);
}, 60000);

test('local-storage visitors require matching mode and consent, and appear in isolated visitor history', async () => {
  const created = await req('/sites', 'POST', {
    name: 'Local visitors',
    domain: 'local.session.example',
  });
  expect(created.status).toBe(201);
  const localSite = ((await created.json()) as any).site.id;
  const start = pending.length;
  const sendLocal = (event: unknown) =>
    req('/collect', 'POST', event, '', 'https://local.session.example');
  try {
    expect(
      (
        await req(`/sites/${localSite}/environments/${localSite}`, 'PATCH', {
          trackingMode: 'local',
        })
      ).status,
    ).toBe(200);
    const event = {
      ...payload(),
      siteId: localSite,
      url: 'https://local.session.example/page',
      session: { ...payload().session, storage: 'local' },
    };
    expect(
      (await sendLocal({ ...event, session: { ...event.session, consent: false } })).status,
    ).toBe(400);
    expect(
      (await sendLocal({ ...event, session: { ...event.session, storage: 'cookie' } })).status,
    ).toBe(400);
    expect(
      (
        await sendLocal({
          siteId: localSite,
          id: crypto.randomUUID(),
          type: 'pageview',
          url: event.url,
        })
      ).status,
    ).toBe(400);
    expect((await sendLocal(event)).status).toBe(202);
    const batch = pending.slice(start);
    expect((await ingest(db, batch)).inserted).toBe(1);
    const r = (await (await req(`/sites/${localSite}/sessions`)).json()) as any;
    expect(r.summary.sessions).toBe(1);
    expect(r.summary.visitors).toBe(1);
    expect((await req(`/sites/${localSite}/sessions`, 'GET', undefined, stranger)).status).toBe(
      404,
    );
    expect(
      (
        await req(`/sites/${localSite}/environments/${localSite}`, 'PATCH', {
          trackingMode: 'sessions',
        })
      ).status,
    ).toBe(200);
    expect((await sendLocal({ ...event, id: crypto.randomUUID() })).status).toBe(400);
  } finally {
    pending.splice(start);
    await req(`/sites/${localSite}`, 'DELETE');
  }
}, 60000);

test('default cookieless visitors expose daily page journeys without storage metadata', async () => {
  const created = (await (
    await req('/sites', 'POST', { name: 'Daily journeys', domain: 'daily.example' })
  ).json()) as any;
  const id = created.site.id;
  const start = pending.length;
  try {
    for (const path of ['/', '/pricing']) {
      expect(
        (
          await req(
            '/collect',
            'POST',
            {
              siteId: id,
              id: crypto.randomUUID(),
              type: 'pageview',
              url: `https://daily.example${path}?private=removed`,
            },
            '',
            'https://daily.example',
          )
        ).status,
      ).toBe(202);
    }
    const batch = pending.slice(start);
    expect(batch).toHaveLength(2);
    expect(batch[0]!.visitor).toBe(batch[1]!.visitor);
    expect(JSON.stringify(batch)).not.toContain('192.0.2.123');
    expect(JSON.stringify(batch)).not.toContain('private=removed');
    expect(batch.every((e) => e.version !== 3)).toBe(true);
    await ingest(db, batch);
    const report = (await (await req(`/sites/${id}/sessions`)).json()) as any;
    expect(report.summary.sessions).toBe(1);
    expect(report.summary.visitors).toBe(1);
    expect(report.sessions[0].pageviews).toBe(2);
    const detail = (await (
      await req(`/sites/${id}/sessions?session=${report.sessions[0].id}`)
    ).json()) as any;
    expect(detail.events.map((e: any) => e.path).sort()).toEqual(['/', '/pricing']);
    const missing = (await (
      await req(`/sites/${id}/sessions?visitor=${'f'.repeat(64)}`)
    ).json()) as any;
    expect(missing.summary.sessions).toBe(0);
    expect((await req(`/sites/${id}/sessions`, 'GET', undefined, stranger)).status).toBe(404);
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await ingest(db, [
      {
        ...batch[0]!,
        id: crypto.randomUUID(),
        receivedAt: yesterday,
        day: yesterday.slice(0, 10),
        visitor: 'e'.repeat(64),
      },
    ]);
    const from = yesterday.slice(0, 10),
      to = new Date().toISOString().slice(0, 10);
    const days = (await (await req(`/sites/${id}/sessions?from=${from}&to=${to}`)).json()) as any;
    expect(days.summary.visitors).toBe(2);
  } finally {
    await req(`/sites/${id}`, 'DELETE');
    pending.splice(start);
  }
});

test('cookieless activity validates metadata and shares daily identity with basic events', async () => {
  const { site: created } = (await (
    await req('/sites', 'POST', { name: 'Cookieless details', domain: 'details.example' })
  ).json()) as any;
  const start = pending.length;
  const base = {
    siteId: created.id,
    id: crypto.randomUUID(),
    type: 'pageview',
    url: 'https://details.example/start',
  };
  try {
    expect((await req('/collect', 'POST', base, '', 'https://details.example')).status).toBe(202);
    const activity = { kind: 'pageview', details };
    expect(
      (
        await req(
          '/collect',
          'POST',
          { ...base, id: crypto.randomUUID(), activity },
          '',
          'https://details.example',
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await req(
          '/collect',
          'POST',
          { ...base, activity: { ...activity, visitorId } },
          '',
          'https://details.example',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await req(
          '/collect',
          'POST',
          { ...base, activity: { ...activity, details: { ...details, text: 'private' } } },
          '',
          'https://details.example',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await req(
          '/collect',
          'POST',
          { ...base, activity: { ...activity, kind: 'click' } },
          '',
          'https://details.example',
        )
      ).status,
    ).toBe(400);
    const batch = pending.slice(start);
    expect(batch).toHaveLength(2);
    expect(eventMessageSchema.safeParse(batch[1]).success).toBe(true);
    expect(batch[1]).toMatchObject({
      version: 3,
      activity: {
        visitorKey: batch[0]!.visitor,
        sessionKey: batch[0]!.visitor,
        browser: 'Chrome',
        details,
      },
    });
    await ingest(db, batch);
    const report = (await (await req(`/sites/${created.id}/sessions`)).json()) as any;
    expect(report.summary.sessions).toBe(1);
    expect(report.sessions[0].pageviews).toBe(2);
    expect(report.sessions[0].daily).toBe(true);
    const timeline = (await (
      await req(`/sites/${created.id}/sessions?session=${report.sessions[0].id}`)
    ).json()) as any;
    expect(timeline.events).toHaveLength(2);
    expect(
      timeline.events.some((e: any) => e.browser === 'Chrome' && e.details.screenWidth === 1920),
    ).toBe(true);
  } finally {
    await req(`/sites/${created.id}`, 'DELETE');
    pending.splice(start);
  }
});

test('detailed activity expires and environment deletion cannot be undone by queue redelivery', async () => {
  const old = new Date(Date.now() - 31 * 86400000);
  await client.query('update activity_events set received_at=$1 where environment_id=$2', [
    old,
    site,
  ]);
  expect((await report()).summary.sessions).toBe(0);
  await retain(db);
  expect(
    (
      await client.query('select count(*)::int n from activity_events where environment_id=$1', [
        site,
      ])
    ).rows[0].n,
  ).toBe(0);
  expect((await req(`/sites/${site}`, 'DELETE')).status).toBe(204);
  expect((await ingest(db, pending)).inserted).toBe(0);
}, 15000);
