import { Client } from 'pg';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { defaultTrackingSettings } from '../src/lib/tracking-settings';

const production = process.argv.includes('--production');
const base = production ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL']!;
if (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw Error('Production branch mismatch');
const client = new Client({ connectionString });
const email = `pro-only-qa-${crypto.randomUUID()}@example.com`;
const password = 'Pro-only-verification-2026!';
const fixturePath = `/tmp/analytics-pro-only-${production ? 'production' : 'local'}.json`;
let cookie = '',
  ownerId = '',
  server: ReturnType<typeof Bun.serve> | undefined;
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
try {
  await client.connect();
  const signup = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pro-only verification', email, password }),
  });
  if (!signup.ok) throw Error(`Signup: ${signup.status}`);
  ownerId = ((await signup.json()) as any).user.id;
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const initial = await api('/usage');
  if (initial.plan !== null || initial.pauseReason !== 'subscription_required' || !initial.paused)
    throw Error('An account without Pro can still collect');
  const siteId = (
    await api('/sites', { name: 'Pro-only verification', domain: 'pro-only-qa.example.com' })
  ).site.id;
  await api(
    `/sites/${siteId}/environments/${siteId}`,
    {
      allowLocalhost: true,
      trackingSettings: {
        ...defaultTrackingSettings,
        click: false,
        outbound: false,
        download: false,
        form_submit: false,
        engagement: false,
        scroll: false,
      },
    },
    'PATCH',
  );
  const rejected = await fetch(base + '/api/collect', {
    method: 'POST',
    headers: {
      origin: 'https://pro-only-qa.example.com',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 QA Browser',
    },
    body: JSON.stringify({
      siteId,
      id: crypto.randomUUID(),
      type: 'pageview',
      url: 'https://pro-only-qa.example.com/',
    }),
  });
  const collector = (await rejected.json()) as any;
  if (collector.accepted !== false || collector.reason !== 'subscription_required')
    throw Error('Public collector still grants Free');
  let activated = false,
    finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const rawCount = async () =>
    (await client.query('select count(*)::int as n from events where site_id=$1', [siteId])).rows[0]
      .n as number;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 4358,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/activate') {
        if (await rawCount()) throw Error('The tracker stored an event without Pro');
        await seedPro(client, ownerId);
        activated = true;
        return new Response('Disposable Pro fixture activated');
      }
      if (request.method === 'POST' && path === '/finish') {
        finish();
        return new Response('Finished');
      }
      return new Response(
        `<!doctype html><html><head><title>Pro-only tracker verification</title><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body style="font:18px system-ui;margin:48px"><h1>Pro-only tracker verification</h1><p>The real tracker tests collection with and without an active Pro fixture.</p></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  await writeFile(fixturePath, JSON.stringify({ base, email, password, cookie, ownerId, siteId }), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ready: true, email, fixturePath, collector }));
  await done;
  const usage = await api('/usage');
  const raw = await rawCount();
  if (!activated || !raw || usage.plan?.name !== 'Pro' || usage.events.used !== raw * 0.3)
    throw Error('Active Pro tracker verification failed');
  const folder = `artifacts/pro-only/${production ? 'production' : 'local'}`;
  await mkdir(folder, { recursive: true });
  await writeFile(
    `${folder}/verification.json`,
    JSON.stringify(
      { verifiedAt: new Date().toISOString(), initial, collector, usage, raw },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      verified: true,
      initialPaused: initial.paused,
      collector,
      proCredits: usage.events.used,
      raw,
    }),
  );
} finally {
  server?.stop(true);
  if (ownerId) {
    await cleanupPro(client, [ownerId]);
    await client.query('delete from "user" where id=$1', [ownerId]);
  }
  await client.end();
  await unlink(fixturePath).catch(() => {});
}
