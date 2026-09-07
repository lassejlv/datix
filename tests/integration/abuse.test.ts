import type { AppEnv } from '../../src/runtime/types';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { Client } from 'pg';
import { database, withDatabase } from '../../src/db/client.server';
import { collect } from '../../src/api/collect.server';
import { guardActivity, protectionSummary } from '../../src/abuse/guard.server';
import { ingest, type EventMessage } from '../../src/analytics/ingest.server';
import { accountUsage } from '../../src/billing/usage.server';
import { cleanupPro, seedPro } from '../fixtures/billing';
const connectionString = process.env.TEST_DATABASE_URL!;
if (
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw Error('Use isolated test DB');
const client = new Client({ connectionString });
const db = database(client);
const owners: string[] = [];
const pending: EventMessage[] = [];
const env = {
  DATABASE_URL: connectionString,
  VISITOR_HASH_SECRET: 'abuse-test-secret-with-more-than-32-chars',
  COLLECT_LIMITER: { limit: async () => ({ success: true }) },
  EVENTS: {
    send: async (message: EventMessage) => {
      pending.push(message);
    },
  },
} as unknown as AppEnv;
beforeAll(() => client.connect());
afterAll(async () => {
  await cleanupPro(client, owners);
  await client.query('delete from "user" where id=any($1::text[])', [owners]);
  await client.end();
});
async function workspace() {
  const ownerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  owners.push(ownerId);
  await client.query(
    'insert into "user" (id,name,email,email_verified,created_at,updated_at) values ($1,$2,$3,false,now(),now())',
    [ownerId, 'Abuse QA', `${ownerId}@example.com`],
  );
  await client.query('insert into sites (id,owner_id,name,domain) values ($1,$2,$3,$4)', [
    id,
    ownerId,
    'Abuse QA',
    'abuse.example',
  ]);
  await seedPro(client, ownerId);
  return { ownerId, id };
}
function request(siteId: string, ua = 'Abuse QA browser', ip = '192.0.2.10') {
  return new Request('https://analytics.example/api/collect', {
    method: 'POST',
    headers: {
      origin: 'https://abuse.example',
      'content-type': 'application/json',
      'user-agent': ua,
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify({
      siteId,
      id: crypto.randomUUID(),
      type: 'pageview',
      url: 'https://abuse.example/reload?secret=never-store',
    }),
  });
}

test('concurrent fresh-ID reloads with changing user-agents are blocked before queue, reports and billing', async () => {
  const work = await workspace(),
    now = new Date();
  const result = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      collect(
        request(work.id, `Different browser ${i}`),
        env,
        (run) => withDatabase(env, run),
        now,
      ).then((r) => r.json() as Promise<any>),
    ),
  );
  expect(result.filter((r) => r.accepted).length).toBe(20);
  expect(result.filter((r) => r.reason === 'spam_detected').length).toBe(4);
  const queued = pending.filter((e) => e.siteId === work.id);
  expect(queued.length).toBe(20);
  expect((await ingest(db, queued, now)).inserted).toBe(20);
  expect((await accountUsage(db, work.ownerId, now)).events.used).toBe(20);
  expect(
    (
      await client.query(
        'select sum(event_count)::float8 as total from billing_outbox where owner_id=$1',
        [work.ownerId],
      )
    ).rows[0].total,
  ).toBe(20);
  expect((await protectionSummary(db, work.ownerId, now)).blocked).toBe(4);
  const sources = (
    await client.query('select source,activity::text from abuse_sources where environment_id=$1', [
      work.id,
    ])
  ).rows;
  expect(sources.length).toBe(1);
  expect(sources[0].source).toMatch(/^[a-f0-9]{64}$/);
  expect(sources[0].activity).not.toContain('192.0.2');
  expect(sources[0].activity).not.toContain('never-store');
  const next = await collect(
    request(work.id),
    env,
    (run) => withDatabase(env, run),
    new Date(now.getTime() + 60000),
  );
  expect((await next.json()) as any).toEqual({ accepted: true });
}, 60000);

test('history is learned from prior accepted days and affects detection without blocking new visitors', async () => {
  const work = await workspace(),
    now = new Date();
  for (let day = 1; day <= 4; day++)
    await client.query(
      'insert into daily_stats (site_id,day,dimension,value,pageviews,custom_events,visitors) values ($1,$2,$3,$4,90,10,40)',
      [work.id, new Date(now.getTime() - day * 86400000).toISOString().slice(0, 10), 'total', ''],
    );
  await guardActivity(db, {
    environmentId: work.id,
    source: 'a'.repeat(64),
    signature: 'b'.repeat(64),
    pageview: true,
    now,
  });
  await client.query('update abuse_environment set traffic=$2 where environment_id=$1', [
    work.id,
    JSON.stringify({ start: Math.floor(now.getTime() / 300000), events: 350, custom: 0 }),
  ]);
  for (let i = 1; i < 11; i++) {
    const result = await guardActivity(db, {
      environmentId: work.id,
      source: 'a'.repeat(64),
      signature: 'b'.repeat(64),
      pageview: true,
      now,
    });
    expect(result.reason).toBe(i < 10 ? null : 'unusual_activity');
  }
  expect(
    (
      await guardActivity(db, {
        environmentId: work.id,
        source: 'c'.repeat(64),
        signature: 'b'.repeat(64),
        pageview: true,
        now,
      })
    ).blocked,
  ).toBe(false);
  const summary = await protectionSummary(db, work.ownerId, now);
  expect(summary.learned).toBe(1);
  expect(summary.blocked).toBe(1);
  const other = await workspace();
  expect((await protectionSummary(db, other.ownerId, now)).blocked).toBe(0);
  expect((await protectionSummary(db, other.ownerId, now)).learned).toBe(0);
}, 30000);

test('independent sources stay eligible during concurrent traffic and window counters do not lose updates', async () => {
  const work = await workspace(),
    now = new Date();
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      withDatabase(env, (connection) =>
        guardActivity(connection, {
          environmentId: work.id,
          source: i.toString(16).padStart(64, '0'),
          signature: 'f'.repeat(64),
          pageview: true,
          now,
        }),
      ),
    ),
  );
  expect(results.every((result) => !result.blocked)).toBe(true);
  const traffic = (
    await client.query('select traffic from abuse_environment where environment_id=$1', [work.id])
  ).rows[0].traffic;
  expect(traffic.events).toBe(16);
  expect(
    (
      await client.query(
        'select count(*)::int as total from abuse_sources where environment_id=$1',
        [work.id],
      )
    ).rows[0].total,
  ).toBe(16);
}, 30000);
