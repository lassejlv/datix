// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { defaultTrackingSettings } from '../src/lib/tracking-settings';
const base = 'https://usedatix.com';
const connectionString = process.env.PRODUCTION_DATABASE_URL!;
if (new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw Error('Wrong database');
const client = new Client({ connectionString });
let ownerId = '',
  siteId = '',
  cookie = '';
let fixture: ReturnType<typeof Bun.serve> | undefined;
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET', origin = base) {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 Tracking verification',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = (await r.json()) as any;
  if (!r.ok) throw Error(`${path}: ${r.status}`);
  return value;
}
try {
  await client.connect();
  const email = `tracking-live-${crypto.randomUUID()}@example.com`;
  const password = `Qa-${crypto.randomUUID()}`;
  const r = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Tracking verification' }),
  });
  if (!r.ok) throw Error(`Signup ${r.status}`);
  ownerId = ((await r.json()) as any).user.id;
  cookie = r.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  siteId = (
    await api('/sites', { name: 'Tracking verification', domain: 'tracking-qa.example.com' })
  ).site.id;
  await seedPro(client, ownerId);
  const settings = {
    ...defaultTrackingSettings,
    engagement: false,
    referrer: false,
    country: false,
    device: false,
    dimensions: false,
    language: false,
    coordinates: false,
  };
  await api(
    `/sites/${siteId}/environments/${siteId}`,
    { allowLocalhost: true, trackingSettings: settings },
    'PATCH',
  );
  const config = await api(`/tracker-config?siteId=${siteId}`);
  if (config.settings.dimensions !== false) throw Error('Configuration did not persist');
  for (const type of ['pageview', 'event']) {
    const result = await api(
      '/collect',
      {
        siteId,
        id: crypto.randomUUID(),
        type,
        ...(type === 'event' ? { name: 'qa.action' } : {}),
        url: 'https://tracking-qa.example.com/',
      },
      'POST',
      'https://tracking-qa.example.com',
    );
    if (!result.accepted) throw Error('Production collector rejected fixture');
  }
  fixture = Bun.serve({
    port: 4357,
    hostname: '127.0.0.1',
    fetch() {
      return new Response(
        `<!doctype html><html><head><title>Tracking credits verification</title><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body style="font:20px system-ui;padding:40px"><h1>Tracking credits verification</h1><p>This pageview uses 0.3 credits. One click uses 0.15 credits.</p><button data-analytics-label="credit-check">Verify one click</button></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  console.log('Fixture ready at http://127.0.0.1:4357 — open and click once.');
  const deadline = Date.now() + 240000;
  let usage: any;
  while (Date.now() < deadline) {
    usage = await api('/usage');
    if (usage.events.used >= 1.95) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (usage.events.used !== 1.95) throw Error(`Expected 1.95 credits, got ${usage.events.used}`);
  const raw = await client.query(
    'select type,count(*)::int as count from events where site_id=$1 group by type',
    [siteId],
  );
  const activity = await client.query(
    'select country,device,details from activity_events where environment_id=$1',
    [siteId],
  );
  if (
    activity.rows.length !== 2 ||
    activity.rows.some(
      (r) =>
        r.country ||
        r.device ||
        r.details.viewportWidth ||
        r.details.language ||
        r.details.x !== undefined,
    )
  )
    throw Error('Metadata policy failed');
  await api(
    `/sites/${siteId}/environments/${siteId}`,
    { trackingSettings: { ...settings, custom: false } },
    'PATCH',
  );
  const disabled = await api(
    '/collect',
    {
      siteId,
      id: crypto.randomUUID(),
      type: 'event',
      name: 'disabled',
      url: 'https://tracking-qa.example.com/',
    },
    'POST',
    'https://tracking-qa.example.com',
  );
  if (disabled.accepted !== false || disabled.reason !== 'event_disabled')
    throw Error('Disabled event accepted');
  await mkdir('web/artifacts/tracking', { recursive: true });
  const report = {
    verifiedAt: new Date().toISOString(),
    credits: usage.events.used,
    expectedCredits: 1.95,
    rawCounts: raw.rows,
    localhostActivityCount: activity.rows.length,
    disabledEvent: disabled,
    metadataStripped: true,
  };
  await writeFile('web/artifacts/tracking/production.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  fixture?.stop(true);
  if (ownerId) {
    await cleanupPro(client, [ownerId]);
    await client.query('delete from "user" where id=$1', [ownerId]);
  }
  await client.end();
}
