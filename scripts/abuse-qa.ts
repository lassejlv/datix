import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { defaultTrackingSettings } from '../src/lib/tracking-settings';
const production = process.argv.includes('--production');
const base = production ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = production
  ? process.env.PRODUCTION_DATABASE_URL!
  : process.env.DATABASE_URL!;
if (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw Error('Production branch mismatch');
const client = new Client({ connectionString });
const email = `abuse-qa-${crypto.randomUUID()}@example.com`;
const password = 'Abuse-verification-only-2026!';
let cookie = '',
  ownerId = '',
  server: ReturnType<typeof Bun.serve> | undefined;
const fixturePath = `/tmp/analytics-abuse-${production ? 'production' : 'local'}.json`;
async function api(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`${path} returned ${response.status}`);
  return response.json() as Promise<any>;
}
try {
  await client.connect();
  const response = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Spam protection verification', email, password }),
  });
  if (!response.ok) throw Error(`Signup ${response.status}`);
  ownerId = ((await response.json()) as any).user.id;
  cookie = response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  await seedPro(client, ownerId);
  const siteId = (
    await api('/sites', { name: 'Protection verification', domain: 'abuse-qa.example.com' })
  ).site.id;
  const settings = {
    ...defaultTrackingSettings,
    click: false,
    outbound: false,
    download: false,
    form_submit: false,
    engagement: false,
    scroll: false,
  };
  await api(
    `/sites/${siteId}/environments/${siteId}`,
    { allowLocalhost: true, trackingSettings: settings },
    'PATCH',
  );
  for (let d = 1; d <= 4; d++)
    await client.query(
      'insert into daily_stats (site_id,day,dimension,value,pageviews,custom_events,visitors) values ($1,$2,$3,$4,90,10,40)',
      [siteId, new Date(Date.now() - d * 86400000).toISOString().slice(0, 10), 'total', ''],
    );
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 4358,
    async fetch(request) {
      if (request.method === 'POST' && new URL(request.url).pathname === '/finish') {
        finish();
        return new Response('Finished');
      }
      return new Response(
        `<!doctype html><html><head><title>Spam protection verification</title><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body style="font:18px system-ui;margin:48px;max-width:650px"><h1>Spam protection verification</h1><p>The real tracker sends one normal pageview. The button sends 24 identical pageviews with fresh IDs to test the server guard.</p><button id="spam">Send test flood</button><pre id="result" style="white-space:pre-wrap"></pre><script>document.querySelector('#spam').onclick=async()=>{document.querySelector('#spam').disabled=true;const results=await Promise.all(Array.from({length:24},async()=>{const response=await fetch('${base}/api/collect',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({siteId:'${siteId}',id:crypto.randomUUID(),type:'pageview',url:location.origin+'/spam'})});return response.json()}));document.querySelector('#result').textContent=JSON.stringify({accepted:results.filter(r=>r.accepted).length,blocked:results.filter(r=>r.reason==='spam_detected').length,other:results.filter(r=>!r.accepted&&r.reason!=='spam_detected')},null,2)}</script></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  await writeFile(fixturePath, JSON.stringify({ base, email, password, cookie, ownerId, siteId }), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ ready: true, fixture: 'http://127.0.0.1:4358', email, fixturePath }),
  );
  await done;
  const usage = await api('/usage');
  const raw = await client.query('select count(*)::int as count from events where site_id=$1', [
    siteId,
  ]);
  const folder = `artifacts/abuse/${production ? 'production' : 'local'}`;
  await mkdir(folder, { recursive: true });
  await writeFile(
    `${folder}/verification.json`,
    JSON.stringify(
      { verifiedAt: new Date().toISOString(), usage, rawEvents: raw.rows[0].count },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      credits: usage.events.used,
      blocked: usage.protection.blocked,
      rawEvents: raw.rows[0].count,
    }),
  );
} finally {
  server?.stop(true);
  if (ownerId) {
    await cleanupPro(client, [ownerId]);
    await client.query('delete from "user" where id=$1', [ownerId]);
  }
  await client.end();
}
