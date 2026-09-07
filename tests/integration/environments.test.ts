import { seedPro, cleanupPro } from '../fixtures/billing';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { database } from '../../src/db/client.server';
import { api } from '../../src/api/router.server';
import { ingest, eventMessageSchema, type EventMessage } from '../../src/analytics/ingest.server';

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('Use the isolated Neon test branch.');
const client = new Client({ connectionString });
const db = database(client);
const prefix = crypto.randomUUID();
const accountIds: string[] = [];
const pending: EventMessage[] = [];
let owner = '',
  stranger = '',
  siteId = '',
  otherSiteId = '',
  stagingId = '';
const env = {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'environment-tests-auth-secret-at-least-32-characters',
  VISITOR_HASH_SECRET: 'environment-tests-visitor-secret-at-least-32-characters',
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
  method = 'GET',
  body?: unknown,
  cookie = owner,
  origin: string = env.APP_URL,
) {
  return api(
    new Request(`${env.APP_URL}/api${path}`, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'user-agent': 'Environment integration browser',
        'cf-connecting-ip': '192.0.2.87',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
const payload = (environmentId?: string, extras: Record<string, unknown> = {}) => ({
  siteId,
  ...(environmentId ? { environmentId } : {}),
  id: crypto.randomUUID(),
  type: 'pageview',
  url: 'https://environment.example/page',
  ...extras,
});
const collect = (body: ReturnType<typeof payload>, origin = 'https://environment.example') =>
  request('/collect', 'POST', body, '', origin);
const overview = async (id?: string) =>
  (
    await request(`/sites/${siteId}/overview${id ? `?environment=${id}` : ''}`)
  ).json() as Promise<any>;

beforeAll(async () => {
  await client.connect();
  for (const name of ['owner', 'stranger']) {
    const response = await request(
      '/auth/sign-up/email',
      'POST',
      { name, email: `${name}-${prefix}@example.com`, password: 'environment-tests-password' },
      '',
    );
    expect(response.status).toBe(200);
    accountIds.push(((await response.json()) as any).user.id);
    await seedPro(client, accountIds.at(-1)!);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (name === 'owner') owner = cookie;
    else stranger = cookie;
  }
  for (const [cookie, assign] of [
    [
      owner,
      (id: string) => {
        siteId = id;
      },
    ],
    [
      stranger,
      (id: string) => {
        otherSiteId = id;
      },
    ],
  ] as const) {
    const response = await request(
      '/sites',
      'POST',
      { name: 'Environment tests', domain: 'environment.example' },
      cookie,
    );
    expect(response.status).toBe(201);
    assign(((await response.json()) as any).site.id);
  }
}, 60000);
afterAll(async () => {
  await cleanupPro(client, accountIds);
  if (accountIds.length)
    await client.query('delete from "user" where id = any($1::text[])', [accountIds]);
  await client.end();
}, 30000);

describe('site environments', () => {
  test('every site has a default environment with its original ID; custom names are unique per site', async () => {
    const site = ((await (await request(`/sites/${siteId}`)).json()) as any).site;
    expect(site.environments).toHaveLength(1);
    expect(site.environments[0]).toMatchObject({
      id: siteId,
      siteId,
      name: 'Production',
      domain: 'environment.example',
      enabled: true,
      allowLocalhost: false,
    });
    const created = await request(`/sites/${siteId}/environments`, 'POST', { name: 'Staging' });
    expect(created.status).toBe(201);
    stagingId = ((await created.json()) as any).environment.id;
    expect(stagingId).not.toBe(siteId);
    expect(
      (await request(`/sites/${siteId}/environments`, 'POST', { name: ' staging ' })).status,
    ).toBe(409);
    expect(
      (await request(`/sites/${siteId}/environments`, 'POST', { name: 'Bad\nName' })).status,
    ).toBe(400);
    expect(
      (
        await request(`/sites/${siteId}/environments`, 'POST', {
          name: 'Bad host',
          domain: '*.example.com',
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/sites/${siteId}/environments`, 'POST', { name: 'Unauthorized' }, stranger))
        .status,
    ).toBe(404);
    expect(
      (
        await request(
          `/sites/${siteId}/environments`,
          'POST',
          { name: 'Cross origin' },
          owner,
          'https://other.example',
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(`/sites/${siteId}/environments/${stagingId}`, 'PATCH', { name: 'production' }))
        .status,
    ).toBe(409);
  }, 20000);

  test('legacy and environment events stay separate through deduplication, visitors, and every report', async () => {
    pending.length = 0;
    const id = crypto.randomUUID();
    const legacy = await collect(payload(undefined, { id }));
    const staging = await collect(payload(stagingId, { id }));
    expect(((await legacy.json()) as any).accepted).toBe(true);
    expect(((await staging.json()) as any).accepted).toBe(true);
    expect(pending[0]!.version).toBe(1);
    expect(pending[1]!.version).toBe(2);
    expect(pending[0]!.visitor).not.toBe(pending[1]!.visitor);
    expect(pending.every((message) => eventMessageSchema.safeParse(message).success)).toBe(true);
    await collect(payload(stagingId, { type: 'event', name: 'staging_click' }));
    expect((await ingest(db, [...pending, ...pending])).inserted).toBe(3);
    expect(await overview()).toMatchObject({
      pageviews: 1,
      customEvents: 0,
      dailyUniqueVisitors: 1,
    });
    expect(await overview(stagingId)).toMatchObject({
      pageviews: 1,
      customEvents: 1,
      dailyUniqueVisitors: 1,
    });
    expect(
      (
        (await (
          await request(`/sites/${siteId}/breakdown?environment=${stagingId}&dimension=event`)
        ).json()) as any
      ).data,
    ).toEqual([{ value: 'staging_click', count: 1 }]);
    expect(
      ((await (await request(`/sites/${siteId}/breakdown?dimension=event`)).json()) as any).data,
    ).toEqual([]);
    const points = (
      (await (await request(`/sites/${siteId}/timeseries?environment=${stagingId}`)).json()) as any
    ).data;
    expect(points.reduce((sum: number, point: any) => sum + point.pageviews, 0)).toBe(1);
    expect(
      (
        (await (
          await request(`/sites/${siteId}/installation?environment=${stagingId}`)
        ).json()) as any
      ).receiving,
    ).toBe(true);
    expect((await request(`/sites/${siteId}/overview?environment=${otherSiteId}`)).status).toBe(
      404,
    );
    expect(
      (
        await request(
          `/sites/${otherSiteId}/overview?environment=${stagingId}`,
          'GET',
          undefined,
          stranger,
        )
      ).status,
    ).toBe(404);
    expect((await collect(payload(otherSiteId))).status).toBe(404);
    expect((await collect(payload(stagingId, { siteId: otherSiteId }))).status).toBe(404);
    const malformed = { ...pending[1]!, siteId: otherSiteId };
    expect((await ingest(db, [{ ...malformed, id: crypto.randomUUID() }])).inserted).toBe(0);
  }, 30000);

  test('domain, localhost, pause, rename and legacy settings are environment-scoped', async () => {
    const path = `/sites/${siteId}/environments/${stagingId}`;
    expect(
      (
        await request(path, 'PATCH', {
          name: 'Preview / QA',
          domain: 'staging.environment.example',
          allowLocalhost: true,
        })
      ).status,
    ).toBe(200);
    expect((await collect(payload(stagingId))).status).toBe(403);
    expect(
      (
        await collect(
          payload(stagingId, { url: 'https://staging.environment.example/page' }),
          'https://staging.environment.example',
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await collect(
          payload(stagingId, { url: 'http://localhost:4567/test' }),
          'http://localhost:4567',
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await collect(
          payload(undefined, { url: 'http://localhost:4567/test' }),
          'http://localhost:4567',
        )
      ).status,
    ).toBe(403);
    expect((await request(path, 'PATCH', { enabled: false })).status).toBe(200);
    expect((await collect(payload(stagingId))).status).toBe(404);
    expect((await collect(payload())).status).toBe(202);
    expect(
      (await request(`/sites/${siteId}`, 'PATCH', { allowLocalhost: true, enabled: false })).status,
    ).toBe(200);
    const production = (
      (await (await request(`/sites/${siteId}/environments/${siteId}`)).json()) as any
    ).environment;
    expect(production).toMatchObject({ allowLocalhost: true, enabled: false });
    expect(
      (
        await request(`/sites/${siteId}/environments/${siteId}`, 'PATCH', {
          name: 'Live',
          enabled: true,
          allowLocalhost: false,
        })
      ).status,
    ).toBe(200);
    const site = ((await (await request(`/sites/${siteId}`)).json()) as any).site;
    expect(site).toMatchObject({ enabled: true, allowLocalhost: false });
    expect(site.environments.find((e: any) => e.id === siteId).name).toBe('Live');
    expect((await collect(payload())).status).toBe(202);
    expect((await request(path, 'PATCH', { enabled: true })).status).toBe(200);
  }, 30000);

  test('deleting an environment removes only its data and queued messages cannot recreate it', async () => {
    expect((await request(`/sites/${siteId}/environments/${siteId}`, 'DELETE')).status).toBe(409);
    expect(
      (await request(`/sites/${siteId}/environments/${stagingId}`, 'DELETE', undefined, stranger))
        .status,
    ).toBe(404);
    const queued = pending
      .filter((message) => message.version === 2 && message.environmentId === stagingId)
      .map((message) => ({ ...message, id: crypto.randomUUID() }));
    expect((await request(`/sites/${siteId}/environments/${stagingId}`, 'DELETE')).status).toBe(
      204,
    );
    expect((await ingest(db, queued)).inserted).toBe(0);
    for (const table of ['events', 'daily_visitors', 'daily_stats'])
      expect(
        (
          await client.query(`select count(*)::int as count from ${table} where site_id=$1`, [
            stagingId,
          ])
        ).rows[0].count,
      ).toBe(0);
    expect(await overview()).toMatchObject({ pageviews: 1, dailyUniqueVisitors: 1 });
    expect((await request(`/sites/${siteId}/overview?environment=${stagingId}`)).status).toBe(404);
  }, 15000);

  test('concurrent environment creation enforces the per-site limit', async () => {
    const created = await request('/sites', 'POST', {
      name: 'Quota test',
      domain: 'quota.example',
    });
    const quotaId = ((await created.json()) as any).site.id;
    await client.query(
      "insert into environments (site_id,name,domain) select $1,'Environment ' || n,'quota.example' from generate_series(1,18) n",
      [quotaId],
    );
    const responses = await Promise.all(
      ['Last A', 'Last B'].map((name) =>
        request(`/sites/${quotaId}/environments`, 'POST', { name }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      (
        await client.query('select count(*)::int as count from environments where site_id=$1', [
          quotaId,
        ])
      ).rows[0].count,
    ).toBe(20);
    expect((await request(`/sites/${quotaId}`, 'DELETE')).status).toBe(204);
    expect(
      (
        await client.query('select count(*)::int as count from environments where site_id=$1', [
          quotaId,
        ])
      ).rows[0].count,
    ).toBe(0);
  }, 15000);
});
