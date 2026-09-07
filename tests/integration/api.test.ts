import { seedPro, cleanupPro } from '../fixtures/billing';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { database } from '../../src/db/client.server';
import { dailyStats, dailyVisitors, events, sites, user } from '../../src/db/schema';
import { api } from '../../src/api/router.server';
import { eventMessageSchema, ingest, type EventMessage } from '../../src/analytics/ingest.server';
import { retain } from '../../src/analytics/retention.server';
import { hash } from '../../src/lib/privacy';
import { consume } from '../../src/analytics/queue.server';

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('Integration tests require an explicitly isolated Neon test branch in .env.');
const client = new Client({ connectionString });
const db = database(client);
const pending: EventMessage[] = [];
const ids: string[] = [];
const prefix = crypto.randomUUID();
let firstCookie = '',
  secondCookie = '',
  siteId = '';
const env = {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'integration-auth-secret-with-more-than-32-characters',
  VISITOR_HASH_SECRET: 'integration-visitor-secret-with-more-than-32-characters',
  HYPERDRIVE: { connectionString },
  EVENTS: {
    send: async (message: EventMessage) => {
      pending.push(message);
    },
  },
  COLLECT_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  API_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;

async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return api(
    new Request(`http://localhost:3000${path}`, {
      method: options.method ?? 'GET',
      headers: {
        origin: options.origin ?? env.APP_URL,
        'content-type': 'application/json',
        'user-agent': 'Integration browser',
        'cf-connecting-ip': '192.0.2.50',
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
  );
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
}
const event = (overrides: Record<string, unknown> = {}) => ({
  siteId,
  id: crypto.randomUUID(),
  type: 'pageview',
  url: 'https://example.com/pricing?token=never-store-me#private',
  referrer: 'https://search.example/search?q=private',
  ...overrides,
});

beforeAll(async () => {
  await client.connect();
  for (const label of ['first', 'second']) {
    const response = await request('/api/auth/sign-up/email', {
      method: 'POST',
      body: {
        name: label,
        email: `${label}-${prefix}@example.com`,
        password: 'test-password-with-24-chars',
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    ids.push(body.user.id);
    await seedPro(client, ids.at(-1)!);
    if (label === 'first') firstCookie = cookie(response);
    else secondCookie = cookie(response);
  }
}, 60000);
afterAll(async () => {
  await cleanupPro(client, ids);
  if (ids.length) await db.delete(user).where(inArray(user.id, ids));
  await client.end();
}, 30000);

describe('authenticated API with real Neon PostgreSQL', () => {
  test('sessions protect account data and mutation origins', async () => {
    expect((await request('/api/me')).status).toBe(401);
    const me = await request('/api/me', { cookie: firstCookie });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.id).toBe(ids[0]);
    expect(
      (
        await request('/api/sites', {
          method: 'POST',
          cookie: firstCookie,
          origin: 'https://attacker.example',
          body: { name: 'Site', domain: 'example.com' },
        })
      ).status,
    ).toBe(403);
  }, 15000);
  test('creates, validates and lists owner websites', async () => {
    const response = await request('/api/sites', {
      method: 'POST',
      cookie: firstCookie,
      body: { name: 'Test site', domain: 'Example.com' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    siteId = body.site.id;
    expect(body.site.domain).toBe('example.com');
    expect(body.site.allowLocalhost).toBe(false);
    expect(
      (
        await request('/api/sites', {
          method: 'POST',
          cookie: firstCookie,
          body: { name: 'Duplicate', domain: 'example.com' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request('/api/sites', {
          method: 'POST',
          cookie: firstCookie,
          body: { name: 'Bad', domain: '*.example.com' },
        })
      ).status,
    ).toBe(400);
    expect(
      ((await (await request('/api/sites', { cookie: secondCookie })).json()) as any).sites,
    ).toHaveLength(0);
  }, 20000);
  test('another tenant cannot read, modify, delete or query a site', async () => {
    for (const suffix of ['', '/overview', '/timeseries', '/breakdown', '/installation'])
      expect(
        (await request(`/api/sites/${siteId}${suffix}`, { cookie: secondCookie })).status,
      ).toBe(404);
    for (const method of ['PATCH', 'DELETE'])
      expect(
        (
          await request(`/api/sites/${siteId}`, {
            method,
            cookie: secondCookie,
            ...(method === 'PATCH' ? { body: { enabled: false } } : {}),
          })
        ).status,
      ).toBe(404);
  }, 30000);
  test('collection validates origin, payloads, opt-outs, queue availability and rate limits', async () => {
    expect(
      (
        await request('/api/collect', {
          method: 'POST',
          origin: 'https://attacker.example',
          body: event(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/collect', {
          method: 'POST',
          origin: 'https://example.com',
          body: event({ properties: { email: 'private' } }),
        })
      ).status,
    ).toBe(400);
    const excluded = await request('/api/collect', {
      method: 'POST',
      origin: 'https://example.com',
      body: event(),
      headers: { dnt: '1' },
    });
    expect(((await excluded.json()) as any).accepted).toBe(false);
    expect(pending).toHaveLength(0);
    const original = env.EVENTS;
    env.EVENTS = {
      send: async () => {
        throw new Error('Simulated queue outage');
      },
    } as unknown as Queue;
    expect(
      (
        await request('/api/collect', {
          method: 'POST',
          origin: 'https://example.com',
          body: event(),
        })
      ).status,
    ).toBe(503);
    env.EVENTS = original;
    const limiter = env.COLLECT_LIMITER;
    env.COLLECT_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await request('/api/collect', {
      method: 'POST',
      origin: 'https://example.com',
      body: event(),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    env.COLLECT_LIMITER = limiter;
    const gpcEvent = event();
    const gpcResponse = await request('/api/collect', {
      method: 'POST',
      origin: 'https://example.com',
      body: gpcEvent,
      headers: { 'sec-gpc': '1' },
    });
    expect(gpcResponse.status).toBe(202);
    expect(((await gpcResponse.json()) as any).accepted).toBe(true);
    expect(pending.pop()?.id).toBe(gpcEvent.id);
  }, 20000);
  test('localhost opt-in persists, is owner-scoped, and can be revoked', async () => {
    const start = pending.length;
    const localEvent = (url: string) => event({ url });
    try {
      expect(
        (
          await request('/api/collect', {
            method: 'POST',
            origin: 'http://localhost:5173',
            body: localEvent('http://localhost:5173/local'),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(`/api/sites/${siteId}`, {
            method: 'PATCH',
            cookie: secondCookie,
            body: { allowLocalhost: true },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(`/api/sites/${siteId}`, {
            method: 'PATCH',
            cookie: firstCookie,
            body: { allowLocalhost: 'true' },
          })
        ).status,
      ).toBe(400);
      const updated = await request(`/api/sites/${siteId}`, {
        method: 'PATCH',
        cookie: firstCookie,
        body: { allowLocalhost: true },
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as any).site.allowLocalhost).toBe(true);
      expect(
        ((await (await request(`/api/sites/${siteId}`, { cookie: firstCookie })).json()) as any)
          .site.allowLocalhost,
      ).toBe(true);
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const origin = `http://${host}:5173`;
        const response = await request('/api/collect', {
          method: 'POST',
          origin,
          body: localEvent(`${origin}/local?secret=discard`),
        });
        expect(response.status).toBe(202);
        expect(((await response.json()) as any).accepted).toBe(true);
      }
      expect(pending.length - start).toBe(3);
      expect(pending.at(-1)!.path).toBe('/local');
      for (const origin of [
        'http://localhost:3000',
        'https://localhost:5173',
        'http://localhost.attacker.com:5173',
      ]) {
        expect(
          (
            await request('/api/collect', {
              method: 'POST',
              origin,
              body: localEvent('http://localhost:5173/local'),
            })
          ).status,
        ).toBe(403);
      }
      const excluded = await request('/api/collect', {
        method: 'POST',
        origin: 'http://localhost:5173',
        body: localEvent('http://localhost:5173/local'),
        headers: { dnt: '1' },
      });
      expect(((await excluded.json()) as any).accepted).toBe(false);
      await request(`/api/sites/${siteId}`, {
        method: 'PATCH',
        cookie: firstCookie,
        body: { enabled: false },
      });
      expect(
        (
          await request('/api/collect', {
            method: 'POST',
            origin: 'http://localhost:5173',
            body: localEvent('http://localhost:5173/local'),
          })
        ).status,
      ).toBe(404);
      await request(`/api/sites/${siteId}`, {
        method: 'PATCH',
        cookie: firstCookie,
        body: { enabled: true, allowLocalhost: false },
      });
      expect(
        (
          await request('/api/collect', {
            method: 'POST',
            origin: 'http://localhost:5173',
            body: localEvent('http://localhost:5173/local'),
          })
        ).status,
      ).toBe(403);
      expect(pending.length - start).toBe(3);
    } finally {
      pending.splice(start);
      await request(`/api/sites/${siteId}`, {
        method: 'PATCH',
        cookie: firstCookie,
        body: { enabled: true, allowLocalhost: false },
      });
    }
  }, 40000);
  test('queue retries and duplicate events count once, with private fields discarded', async () => {
    const body = event();
    for (let i = 0; i < 2; i++)
      expect(
        (await request('/api/collect', { method: 'POST', origin: 'https://example.com', body }))
          .status,
      ).toBe(202);
    expect(pending).toHaveLength(2);
    expect(eventMessageSchema.parse(pending[0]).path).toBe('/pricing');
    expect(pending[0]!.referrer).toBe('search.example');
    expect(JSON.stringify(pending)).not.toContain('never-store-me');
    expect(JSON.stringify(pending)).not.toContain('192.0.2.50');
    expect(await ingest(db, pending)).toEqual({ inserted: 1 });
    expect(await ingest(db, pending)).toEqual({ inserted: 0 });
    const result = (await (
      await request(`/api/sites/${siteId}/overview`, { cookie: firstCookie })
    ).json()) as any;
    expect(result).toMatchObject({ pageviews: 1, customEvents: 0, dailyUniqueVisitors: 1 });
  }, 20000);
  test('multiple pageviews count one daily visitor and custom events stay separate', async () => {
    const base = pending[0]!;
    const differentDay = new Date(Date.now() - 86400000).toISOString();
    const items: EventMessage[] = [
      { ...base, id: crypto.randomUUID(), path: '/about' },
      { ...base, id: crypto.randomUUID(), type: 'event', name: 'signup' },
      {
        ...base,
        id: crypto.randomUUID(),
        receivedAt: differentDay,
        day: differentDay.slice(0, 10),
        visitor: await hash('test', 'yesterday'),
      },
    ];
    expect((await ingest(db, items)).inserted).toBe(3);
    const overview = (await (
      await request(`/api/sites/${siteId}/overview`, { cookie: firstCookie })
    ).json()) as any;
    expect(overview).toMatchObject({
      pageviews: 3,
      customEvents: 1,
      dailyUniqueVisitors: 2,
      visitorMetric: 'sum_of_daily_unique_visitors',
    });
    const series = (await (
      await request(`/api/sites/${siteId}/timeseries`, { cookie: firstCookie })
    ).json()) as any;
    expect(series.data).toHaveLength(30);
    expect(series.data.slice(0, -2).every((point: any) => point.pageviews === 0)).toBe(true);
    const paths = (await (
      await request(`/api/sites/${siteId}/breakdown?dimension=path`, { cookie: firstCookie })
    ).json()) as any;
    expect(paths.data).toEqual([
      { value: '/pricing', count: 2 },
      { value: '/about', count: 1 },
    ]);
    const custom = (await (
      await request(`/api/sites/${siteId}/breakdown?dimension=event`, { cookie: firstCookie })
    ).json()) as any;
    expect(custom.data).toEqual([{ value: 'signup', count: 1 }]);
    expect(
      (
        (await (
          await request(`/api/sites/${siteId}/installation`, { cookie: firstCookie })
        ).json()) as any
      ).receiving,
    ).toBe(true);
  }, 30000);
  test('concurrent redelivery is idempotent across separate database connections', async () => {
    const other = new Client({ connectionString });
    await other.connect();
    const item = { ...pending[0]!, id: crypto.randomUUID() };
    try {
      const results = await Promise.all([ingest(db, [item]), ingest(database(other), [item])]);
      expect(results.reduce((n, result) => n + result.inserted, 0)).toBe(1);
    } finally {
      await other.end();
    }
  }, 20000);
  test('a full 100-event queue batch aggregates without losing pageviews', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...pending[0]!,
      id: crypto.randomUUID(),
      path: `/batch/${index}`,
    }));
    const before = (await (
      await request(`/api/sites/${siteId}/overview`, { cookie: firstCookie })
    ).json()) as any;
    expect((await ingest(db, items)).inserted).toBe(100);
    const after = (await (
      await request(`/api/sites/${siteId}/overview`, { cookie: firstCookie })
    ).json()) as any;
    expect(after.pageviews - before.pageviews).toBe(100);
    expect(after.dailyUniqueVisitors).toBe(before.dailyUniqueVisitors);
  }, 20000);
  test('a malformed queue envelope is retried without blocking valid messages', async () => {
    const state = { validAcked: 0, validRetried: 0, invalidAcked: 0, invalidRetried: 0 };
    const batch = {
      queue: 'analytics-events',
      messages: [
        {
          id: 'valid',
          body: { ...pending[0]!, id: crypto.randomUUID() },
          ack: () => state.validAcked++,
          retry: () => state.validRetried++,
        },
        {
          id: 'invalid',
          body: { version: 999 },
          ack: () => state.invalidAcked++,
          retry: () => state.invalidRetried++,
        },
      ],
    } as unknown as MessageBatch<unknown>;
    await consume(batch, env);
    expect(state).toEqual({ validAcked: 1, validRetried: 0, invalidAcked: 0, invalidRetried: 1 });
  }, 20000);
  test('failed summary writes roll back raw insertion and can be retried', async () => {
    // Force failure after the raw insert; the queue must retry instead of acknowledging.
    await db.execute(
      sql`create or replace function test_reject_summary() returns trigger language plpgsql as $$ begin raise exception 'intentional test failure'; end $$`,
    );
    await db.execute(
      sql`create trigger test_reject_summary before insert on daily_stats for each statement execute function test_reject_summary()`,
    );
    const item = { ...pending[0]!, id: crypto.randomUUID() };
    let acknowledged = 0,
      retried = 0;
    try {
      await expect(ingest(db, [item])).rejects.toThrow();
      await consume(
        {
          queue: 'analytics-events',
          messages: [
            { id: 'rollback-test', body: item, ack: () => acknowledged++, retry: () => retried++ },
          ],
        } as unknown as MessageBatch<unknown>,
        env,
      );
      expect(acknowledged).toBe(0);
      expect(retried).toBe(1);
    } finally {
      await db.execute(sql`drop trigger test_reject_summary on daily_stats`);
      await db.execute(sql`drop function test_reject_summary()`);
    }
    expect(await db.select().from(events).where(eq(events.id, item.id))).toHaveLength(0);
    expect((await ingest(db, [item])).inserted).toBe(1);
  }, 20000);
  test('retention removes old raw data but keeps the corresponding daily summaries', async () => {
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const item = {
      ...pending[0]!,
      id: crypto.randomUUID(),
      receivedAt: old,
      day: old.slice(0, 10),
    };
    await ingest(db, [item], new Date(old));
    const before = await db.select().from(dailyStats).where(eq(dailyStats.siteId, siteId));
    const result = await retain(db);
    expect(result.deleted.events).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(events).where(eq(events.id, item.id))).toHaveLength(0);
    const after = await db.select().from(dailyStats).where(eq(dailyStats.siteId, siteId));
    expect(after).toHaveLength(before.length);
    expect((await ingest(db, [item])).inserted).toBe(0);
  }, 20000);
  test('pause stops collection, deletion cascades and queued events cannot resurrect data', async () => {
    expect(
      (
        await request(`/api/sites/${siteId}`, {
          method: 'PATCH',
          cookie: firstCookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request('/api/collect', {
          method: 'POST',
          origin: 'https://example.com',
          body: event(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/api/sites/${siteId}`, { method: 'DELETE', cookie: firstCookie })).status,
    ).toBe(204);
    expect((await ingest(db, pending)).inserted).toBe(0);
    for (const table of [events, dailyStats, dailyVisitors])
      expect(await db.select().from(table).where(eq(table.siteId, siteId))).toHaveLength(0);
  }, 20000);
  test('invalid passwords fail and signing out invalidates the session immediately', async () => {
    expect(
      (
        await request('/api/auth/sign-in/email', {
          method: 'POST',
          body: { email: `first-${prefix}@example.com`, password: 'incorrect-password' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await request('/api/auth/sign-out', { method: 'POST', cookie: firstCookie, body: {} }))
        .status,
    ).toBe(200);
    expect((await request('/api/me', { cookie: firstCookie })).status).toBe(401);
    const signedIn = await request('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email: `first-${prefix}@example.com`, password: 'test-password-with-24-chars' },
    });
    expect(signedIn.status).toBe(200);
    expect((await request('/api/me', { cookie: cookie(signedIn) })).status).toBe(200);
  }, 20000);
});
