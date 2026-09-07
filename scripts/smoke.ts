import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { Client } from 'pg';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const origin = process.env.SMOKE_APP_ORIGIN ?? 'http://localhost:3000';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error(
    'This smoke runner creates disposable fixtures. Use it against the local Bun runtime only.',
  );
const prefix = crypto.randomUUID();
const emails = [`smoke-first-${prefix}@example.com`, `smoke-second-${prefix}@example.com`];
const password = `smoke-password-${crypto.randomUUID()}`;
const cookies: string[] = [];
const userIds: string[] = [];
const checks: string[] = [];
const client = new Client({ connectionString: process.env.DATABASE_URL });
let siteId: string | undefined;
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
  requestOrigin = origin,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: requestOrigin,
      'user-agent': 'Analytics smoke browser',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function check(label: string) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

try {
  await client.connect();
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/tracker.js`)).status, 200);
  check('Hono/Bun health, frontend shell, tracker, and unauthenticated rejection');
  for (const email of emails) {
    const response = await request('/api/auth/sign-up/email', 'POST', {
      name: 'API smoke',
      email,
      password,
    });
    const body = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(body));
    cookies.push(
      response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    );
    userIds.push(body.user.id);
  }
  check('Better Auth sign-up and cookie sessions in Bun against Neon');
  await seedPro(client, userIds[0]!);
  const site = await request(
    '/api/sites',
    'POST',
    { name: 'Smoke website', domain: 'example.com' },
    cookies[0],
  );
  assert.equal(site.status, 201);
  siteId = ((await site.json()) as any).site.id;
  assert.equal(
    (await request(`/api/sites/${siteId}/overview`, 'GET', undefined, cookies[1])).status,
    404,
  );
  assert.equal(
    (await request(`/api/sites/${siteId}`, 'DELETE', undefined, cookies[1])).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/sites/${siteId}`,
        'PATCH',
        { enabled: false },
        cookies[0],
        'https://attacker.example',
      )
    ).status,
    403,
  );
  check('Owner isolation and cross-origin mutation rejection');
  const pageview = {
    siteId,
    id: crypto.randomUUID(),
    type: 'pageview',
    url: 'https://example.com/pricing?secret=discarded',
    referrer: 'https://search.example/?q=discarded',
  };
  assert.equal(
    (await request('/api/collect', 'POST', pageview, undefined, 'https://attacker.example')).status,
    403,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await request('/api/collect', 'POST', pageview, undefined, 'https://example.com')).status,
      202,
    );
  assert.equal(
    (
      await request(
        '/api/collect',
        'POST',
        { ...pageview, id: crypto.randomUUID(), type: 'event', name: 'signup' },
        undefined,
        'https://example.com',
      )
    ).status,
    202,
  );
  let summary: any;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const response = await request(`/api/sites/${siteId}/overview`, 'GET', undefined, cookies[0]);
    assert.equal(response.status, 200);
    summary = await response.json();
    if (summary.pageviews === 1 && summary.customEvents === 1) break;
    await Bun.sleep(1000);
  }
  assert.equal(summary.pageviews, 1, 'Queue must deliver and deduplicate the pageview');
  assert.equal(summary.customEvents, 1);
  assert.equal(summary.dailyUniqueVisitors, 1);
  check('Actual Redis queue → Bun worker → Neon delivery and duplicate suppression');
  const raw = await client.query('select path, referrer, visitor from events where site_id = $1', [
    siteId,
  ]);
  assert.equal(raw.rows.length, 2);
  assert.equal(raw.rows[0].path, '/pricing');
  assert.equal(raw.rows[0].referrer, 'search.example');
  assert.match(raw.rows[0].visitor, /^[a-f0-9]{64}$/);
  const status = (await (
    await request(`/api/sites/${siteId}/installation`, 'GET', undefined, cookies[0])
  ).json()) as any;
  assert.equal(status.receiving, true);
  const breakdown = (await (
    await request(`/api/sites/${siteId}/breakdown?dimension=event`, 'GET', undefined, cookies[0])
  ).json()) as any;
  assert.deepEqual(breakdown.data, [{ value: 'signup', count: 1 }]);
  check('Stored event sanitization, installation verification, and reporting');
  assert.equal(
    (
      await request('/api/auth/sign-in/email', 'POST', {
        email: emails[0],
        password: 'definitely-incorrect-password',
      })
    ).status,
    401,
  );
  assert.equal((await request('/api/auth/sign-out', 'POST', {}, cookies[0])).status, 200);
  assert.equal((await request('/api/me', 'GET', undefined, cookies[0])).status, 401);
  const signin = await request('/api/auth/sign-in/email', 'POST', { email: emails[0], password });
  assert.equal(signin.status, 200);
  const newCookie = signin.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.equal((await request('/api/me', 'GET', undefined, newCookie)).status, 200);
  check('Invalid credentials, immediate sign-out, and sign-in');
  assert.equal((await request(`/api/sites/${siteId}`, 'DELETE', undefined, newCookie)).status, 204);
  assert.equal(
    (await client.query('select count(*)::int as count from events where site_id=$1', [siteId]))
      .rows[0].count,
    0,
  );
  check('Site deletion removes its analytics data');
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/api-smoke.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        runtime: 'Local Bun web + Bun worker + Redis + isolated Neon test branch',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  // Delete only users created in this run; site records cascade from their owner.
  if (userIds.length) await cleanupPro(client, userIds);
  if (userIds.length)
    await client.query(
      'delete from "user" where id = any($1::text[]) and email = any($2::text[])',
      [userIds, emails],
    );
  await client.end();
}
