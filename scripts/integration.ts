import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';

const root = 'http://localhost:3107',
  origin = root;

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL ?? '');
if (
  testUrl.hostname !== process.env.TEST_DATABASE_HOST ||
  runtimeUrl.hostname.replace('-pooler.', '.') !== testUrl.hostname ||
  testUrl.hostname === new URL(process.env.DATABASE_URL_UNPOOLED ?? '').hostname
)
  throw new Error('Use an isolated test branch with explicit TEST_DATABASE_HOST');
const db = new SQL(testUrl.toString(), { max: 2, prepare: false });
const analytics = db;
const email = `bun-migration-${randomUUID()}@example.test`;
const otherEmail = `bun-migration-${randomUUID()}@example.test`;

const child = Bun.spawn(['bun', 'apps/api/src/main.ts'], {
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    REDIS_URL: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL,
    DATABASE_URL: runtimeUrl.toString(),
    APP_URL: origin,
    PORT: '3107',
    EXTERNAL_EFFECTS: 'disabled',
    BILLING_STATE_MODE: 'snapshot',
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'isolated-integration-secret-32-characters',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    POLAR_ACCESS_TOKEN: '',
    POLAR_WEBHOOK_SECRET: '',
    S3_BUCKET: '',
    QUEUE_PREFIX: 'datix-it-' + randomUUID(),
    SERVICE_ROLE: 'combined',
    ADMIN_EMAILS: email,
  },
});

let cookie = '',
  owner = '',
  site = '',
  otherOwner = '',
  otherSite = '';

let shutdownExit = 0;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(root + '/api' + path, {
    method,
    headers: { origin, 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(value)}`);

  return { response, value };
}

try {
  for (let n = 0; n < 30; n++) {
    if (
      await fetch(root + '/health/ready')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await Bun.sleep(1000);
  }

  const signup = await request('/auth/sign-up/email', 'POST', {
    name: 'Bun Migration Fixture',
    email,
    password: 'secure-isolated-fixture-password',
  });

  cookie = signup.response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  owner = signup.value.user.id;
  if (!(await request('/me')).value.user.id) throw new Error('Session failed');
  site = (
    await request('/sites', 'POST', { name: 'Bun migration fixture', domain: 'example.test' })
  ).value.site.id;
  const firstCookie = cookie;

  try {
    cookie = '';

    const otherSignup = await request('/auth/sign-up/email', 'POST', {
      name: 'Other tenant fixture',
      email: otherEmail,
      password: 'secure-other-fixture-password',
    });

    otherOwner = otherSignup.value.user.id;
    cookie = otherSignup.response.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
    otherSite = (
      await request('/sites', 'POST', { name: 'Other tenant', domain: 'other.example.test' })
    ).value.site.id;
  } finally {
    cookie = firstCookie;
  }

  const preferences = (await request('/preferences')).value;
  if (!Array.isArray(preferences.oauth)) throw new Error('Provider discovery contract mismatch');

  // Unpaid accounts must finish setup to reach plans without unlocking the workspace.
  const beforeSetup = (await request('/usage')).value;
  if (beforeSetup.onboardingCompleted || beforeSetup.plan)
    throw new Error('Expected a new unpaid account before setup');

  await request('/onboarding/complete', 'POST', {});
  await request('/onboarding/complete', 'POST', {});
  const afterSetup = (await request('/usage')).value;
  if (!afterSetup.onboardingCompleted || afterSetup.plan)
    throw new Error('Completing setup must reveal plans without granting a subscription');

  const gated = await fetch(root + `/api/sites/${site}`, { headers: { cookie } });
  if (gated.status !== 402) throw new Error('Unpaid workspace access must remain gated');

  const now = new Date(),
    start = new Date(now.getTime() - 3600000).toISOString(),
    end = new Date(now.getTime() + 86400000).toISOString();

  const subscription = {
    id: randomUUID(),
    productId: '585ae927-4cc9-48b0-bb20-1323c9ac2837',
    status: 'active',
    currentPeriodStart: start,
    currentPeriodEnd: end,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    endsAt: null,
    entitlements: {
      name: 'Basic',
      eventLimit: 1500000,
      websiteLimit: 10,
      used: 0,
      remaining: 1500000,
      localBaseline: 0,
      pending: 0,
      periodStart: start,
      periodEnd: end,
    },
  };

  await db`INSERT INTO billing_customers(customer_id,owner_id,subscriptions,occurred_at,organization_id) VALUES(${randomUUID()},${owner},${JSON.stringify([subscription])}::text::jsonb,now(),'8ded9438-0be0-4f4a-8cef-f448d77c202c')`;
  await request('/onboarding/complete', 'POST', {});

  for (const [path, body] of [
    [`/sites/${site}`, { enabled: false, ownerId: otherOwner }],
    [`/sites/${site}`, { creditBudget: -1 }],
  ] as const) {
    const response = await fetch(root + '/api' + path, {
      method: 'PATCH',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status !== 400 || (await response.json()).error.code !== 'invalid_request')
      throw new Error('Typed validation failure did not preserve the API contract');
  }

  const csrf = await fetch(root + `/api/sites/${site}`, {
    method: 'PATCH',
    headers: { cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });

  if (csrf.status !== 403) throw new Error('Mutation origin boundary failed');

  const event = randomUUID();

  const collect = await fetch(root + '/api/collect', {
    method: 'POST',
    headers: {
      origin: 'https://example.test',
      'user-agent': 'Mozilla/5.0 Firefox/128.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      siteId: site,
      id: event,
      type: 'pageview',
      url: 'https://example.test/pricing?secret=hidden',
    }),
  });

  const result = await collect.json();
  if (!result.accepted) throw new Error('Collect failed ' + JSON.stringify(result));
  let delivered = false;

  for (let i = 0; i < 30; i++) {
    const rows =
      await analytics`SELECT path FROM events WHERE site_id=${site}::uuid AND id=${event}::uuid`;

    if (rows.length) {
      if (rows[0].path !== '/pricing') throw new Error('Private URL leak');
      delivered = true;
      break;
    }

    await Bun.sleep(1000);
  }

  if (!delivered) throw new Error('Queue did not deliver');

  for (const path of [
    `/sites/${site}/overview`,
    `/sites/${site}/timeseries`,
    `/sites/${site}/breakdown`,
    `/sites/${site}/installation`,
    `/sites/${site}/sessions`,
    `/sites/${site}/environments/${site}/features/overview`,
    `/sites/${site}/environments/${site}/features/overview?window=24h`,
    `/sites/${site}/environments/${site}/features/overview?path=%2Fpricing`,
  ]) {
    const result = await request(path);
    console.log('PASS', path);
    if (
      path.endsWith('/overview') &&
      result.value.pageviews !== undefined &&
      result.value.pageviews !== 1
    )
      throw new Error('Overview mismatch');
  }

  // A duplicate must not create another raw event or reserve credits twice.
  const retry = await fetch(root + '/api/collect', {
    method: 'POST',
    headers: {
      origin: 'https://example.test',
      'user-agent': 'Mozilla/5.0 Firefox/128.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      siteId: site,
      id: event,
      type: 'pageview',
      url: 'https://example.test/pricing',
    }),
  });

  if (!(await retry.json()).accepted) throw new Error('Duplicate rejected');

  const [ledger] =
    await db`SELECT events::text FROM billing_organization_usage WHERE owner_id=${owner} AND site_id=${site}::uuid`;

  if (Number(ledger.events) !== 1) throw new Error('Duplicate usage');
  const usage = (await request('/usage')).value;
  if (usage.events.used !== 1 || usage.protection.blocked !== 0)
    throw new Error('Usage contract mismatch');

  // Import a complete prior day, preview fingerprint, duplicate upload and delete.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    csv = `date,visitors,pageviews\n${yesterday},3,4\n`;

  const importPath = `/sites/${site}/environments/${site}/imports`,
    params = '?provider=plausible&filename=imported_visitors.csv&timeZone=UTC';

  async function upload(path: string) {
    const response = await fetch(root + '/api' + path, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'text/csv' },
      body: csv,
    });

    const value = await response.json();
    if (!response.ok) throw new Error(`Import ${response.status} ${JSON.stringify(value)}`);

    return value;
  }

  const preview = await upload(importPath + '/preview' + params);
  if (preview.pageviews !== 4) throw new Error('Import preview mismatch');
  const created = await upload(importPath + params + '&fingerprint=' + preview.fingerprint);
  if (!created.import.id) throw new Error('Import failed');
  const duplicate = await upload(importPath + params + '&fingerprint=' + preview.fingerprint);
  if (!duplicate.duplicate || duplicate.import.id !== created.import.id)
    throw new Error('Import idempotency failed');
  await request(importPath + '/' + created.import.id, 'DELETE');
  const featurePath = `/sites/${site}/environments/${site}/features`;
  await request(`/sites/${site}/environments/${site}`, 'PATCH', {
    trackingMode: 'sessions',
    featureSettings: { goals: true, errors: true, webVitals: true },
  });
  await request(featurePath + '/goals', 'POST', {
    name: 'Pricing viewed',
    matchType: 'page',
    matchValue: '/pricing',
  });

  const sessionEvent = randomUUID(),
    pageId = randomUUID();

  async function track(path: string, body: unknown) {
    const response = await fetch(root + '/api/' + path, {
      method: 'POST',
      headers: {
        origin: 'https://example.test',
        'user-agent': 'Mozilla/5.0 Firefox/128.0',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const value = await response.json();
    if (!value.accepted) throw new Error(`Tracking ${path}: ${JSON.stringify(value)}`);
  }

  await track('collect', {
    siteId: site,
    environmentId: site,
    id: sessionEvent,
    type: 'pageview',
    url: 'https://example.test/pricing',
    session: {
      visitorId: randomUUID(),
      sessionId: randomUUID(),
      kind: 'pageview',
      consent: true,
      details: {
        clientTime: Date.now(),
        sequence: 1,
        viewportWidth: 1280,
        viewportHeight: 800,
        screenWidth: 1280,
        screenHeight: 800,
        language: 'en',
      },
    },
  });
  for (const [kind, payload] of [
    ['vital', { name: 'LCP', value: 1200 }],
    ['error', { message: 'Fixture error', source: 'https://example.test/app.js?token=secret' }],
  ] as const)
    await track('telemetry', {
      siteId: site,
      environmentId: site,
      id: randomUUID(),
      pageId,
      url: 'https://example.test/pricing',
      kind,
      payload,
      consent: true,
    });

  for (let i = 0; i < 30; i++) {
    const [row] =
      await analytics`SELECT (SELECT count(*) FROM activity_events WHERE environment_id=${site}::uuid) AS activity,(SELECT count(*) FROM diagnostic_events WHERE environment_id=${site}::uuid) AS diagnostics`;

    if (Number(row.activity) === 1 && Number(row.diagnostics) === 2) break;
    await Bun.sleep(1000);
  }

  const sessionList = (await request(`/sites/${site}/sessions`)).value;
  const recordedSession = sessionList.sessions.find((row: { daily: boolean }) => !row.daily);
  if (sessionList.sessions.length !== 2 || !recordedSession)
    throw new Error('Session report mismatch ' + JSON.stringify(sessionList));
  const detail = (await request(`/sites/${site}/sessions?session=${recordedSession.id}`)).value;
  if (detail.events[0]?.id !== sessionEvent) throw new Error('Session detail mismatch');
  const goals = (await request(featurePath + '/goals')).value;
  if (goals.goals[0]?.conversions !== 1) throw new Error('Goal conversion mismatch');
  const vitals = (await request(featurePath + '/web-vitals')).value;
  if (vitals.items[0]?.p75 !== 1200) throw new Error('Web Vitals mismatch');
  const errors = (await request(featurePath + '/errors')).value;
  if (errors.items.length !== 1 || JSON.stringify(errors).includes('token=secret'))
    throw new Error('Diagnostics privacy mismatch');
  await request(featurePath + '/errors', 'POST', { fingerprint: errors.items[0].fingerprint });
  if (!(await request(featurePath + '/errors')).value.items[0].resolved)
    throw new Error('Error resolution failed');
  // Rehearse a legacy v1 receipt whose analytics commit survived a primary rollback.
  const recoveredEvent = randomUUID();
  const receivedAt = new Date().toISOString();

  const legacyReceipt = {
    version: 1,
    siteId: site,
    id: recoveredEvent,
    receivedAt,
    day: receivedAt.slice(0, 10),
    type: 'pageview',
    name: '',
    path: '/recovered',
    referrer: '',
    country: '',
    device: '',
    visitor: 'a'.repeat(64),
  };

  const [outboxBefore] =
    await db`SELECT coalesce(sum(event_count),0)::text AS units FROM billing_outbox WHERE owner_id=${owner}`;

  await analytics`INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES(${site}::uuid,${recoveredEvent}::uuid,${receivedAt},${legacyReceipt.day},'pageview','','/recovered','','','',${legacyReceipt.visitor})`;
  await db.begin(async (tx) => {
    const rows = await tx`SELECT id FROM "user" WHERE id=${owner} AND email=${email} FOR UPDATE`;
    if (rows.length !== 1) throw new Error('Recovery fixture owner mismatch');
    await tx`INSERT INTO ingestion_receipts(environment_id,event_id,owner_id,site_id,period_start,period_end,units,payload) VALUES(${site}::uuid,${recoveredEvent}::uuid,${owner},${site}::uuid,${start},${end},100,${JSON.stringify(legacyReceipt)}::text::jsonb)`;
    await tx`UPDATE billing_organization_usage SET events=events+1 WHERE owner_id=${owner} AND site_id=${site}::uuid AND period_start=${start} AND organization_id='8ded9438-0be0-4f4a-8cef-f448d77c202c'::uuid`;
  });
  let recovered = false;

  for (let n = 0; n < 30; n++) {
    const [receipt] =
      await db`SELECT state FROM ingestion_receipts WHERE owner_id=${owner} AND environment_id=${site}::uuid AND event_id=${recoveredEvent}::uuid`;

    if (receipt?.state === 'delivered') {
      recovered = true;
      break;
    }

    await Bun.sleep(1000);
  }

  if (!recovered) throw new Error('Legacy receipt was not recovered');

  const [rawAfter] =
    await analytics`SELECT count(*)::int AS count FROM events WHERE site_id=${site}::uuid AND id=${recoveredEvent}::uuid`;

  const [outboxAfter] =
    await db`SELECT coalesce(sum(event_count),0)::text AS units FROM billing_outbox WHERE owner_id=${owner}`;

  if (rawAfter.count !== 1 || Number(outboxAfter.units) !== Number(outboxBefore.units) + 1)
    throw new Error('Recovery duplicated analytics or billing');
  console.log('PASS legacy pending receipt recovery after analytics commit');
  // Disabled and suspended sites cannot collect; authentication stays tenant-scoped.
  await request(`/sites/${site}`, 'PATCH', { enabled: false });

  const disabled = await fetch(root + '/api/collect', {
    method: 'POST',
    headers: {
      origin: 'https://example.test',
      'user-agent': 'Mozilla/5.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      siteId: site,
      id: randomUUID(),
      type: 'pageview',
      url: 'https://example.test/',
    }),
  });

  if ((await disabled.json()).accepted !== false) throw new Error('Disabled site collected');
  const foreign = await fetch(root + `/api/sites/${randomUUID()}`, { headers: { cookie } });
  if (foreign.status !== 404) throw new Error('Tenant boundary failed');

  for (const path of [
    `/sites/${otherSite}`,
    `/sites/${otherSite}/overview`,
    `/sites/${otherSite}/environments/${otherSite}`,
  ]) {
    const response = await fetch(root + '/api' + path, { headers: { cookie } });
    if (response.status !== 404) throw new Error(`Existing tenant boundary failed: ${path}`);
  }

  for (const path of ['/admin/status', '/admin/users', '/admin/sites']) await request(path);
  await request(`/admin/users/${otherOwner}`, 'PATCH', {
    suspended: true,
    reason: 'Integration admin suspension',
  });

  const [audit] =
    await db`SELECT count(*)::int AS count FROM admin_audit_log WHERE actor_user_id=${owner} AND target_id=${otherOwner} AND action='user.suspended'`;

  if (audit.count !== 1) throw new Error('Administrative suspension audit failed');
  await request(`/admin/users/${otherOwner}`, 'PATCH', { suspended: false });
  await db`INSERT INTO user_suspensions(user_id,reason,suspended_by) VALUES(${owner},'Integration suspension',${owner})`;
  const suspended = await fetch(root + '/api/me', { headers: { cookie } });
  if (suspended.status !== 403) throw new Error('Suspension failed');
  console.log(
    'PASS auth, onboarding, ingestion, idempotency, Timescale reports, usage, imports, tenant isolation, suspension',
  );
} finally {
  for (const [fixtureOwner, fixtureEmail] of [
    [owner, email],
    [otherOwner, otherEmail],
  ])
    if (fixtureOwner)
      await db.begin(async (tx) => {
        const rows =
          await tx`SELECT id FROM "user" WHERE id=${fixtureOwner} AND email=${fixtureEmail} FOR UPDATE`;

        if (rows.length !== 1) throw new Error('Fixture cleanup identity mismatch');
        await tx`DELETE FROM billing_customers WHERE owner_id=${fixtureOwner} AND organization_id='8ded9438-0be0-4f4a-8cef-f448d77c202c'::uuid`;
        await tx`DELETE FROM "user" WHERE id=${fixtureOwner} AND email=${fixtureEmail}`;
      });
  child.kill('SIGTERM');
  shutdownExit = await child.exited;
  await db.close();
}

if (shutdownExit !== 0) throw new Error('Effect runtime did not shut down cleanly');
