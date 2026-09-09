// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    site: { type: 'string' },
    environment: { type: 'string' },
    url: { type: 'string' },
    mode: { type: 'string', default: 'cookieless' },
    endpoint: { type: 'string', default: 'https://usedatix.com/api/collect' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Send 30 synthetic pageviews to test spam protection on your own website.

bun scripts/test-spam.ts --site SITE_UUID --url https://yourdomain.com/__abuse_test__

Optional:
  --environment UUID       The snippet's data-environment value
  --mode sessions|local    Match a consent-based environment (synthetic IDs only)
  --endpoint URL           Collector override for local development
  --dry-run                Show the target and payload without sending requests

Use the snippet's data-site value and an allowed website URL. Pageviews must be
enabled and the website must have an active allowance. Accepted events consume
normal credits and appear in reports; blocked requests consume none.
This exercises repetition protection; historical detection may block earlier.`);
  process.exit(0);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (
  !values.site ||
  !uuid.test(values.site) ||
  (values.environment && !uuid.test(values.environment))
)
  throw Error('Provide --site with the UUID from data-site, and a valid --environment if used.');
if (!values.url) throw Error('Provide --url with an allowed URL on your own website.');
if (!['cookieless', 'sessions', 'local'].includes(values.mode!))
  throw Error('--mode must be cookieless, sessions, or local.');
const page = new URL(values.url);
const endpoint = new URL(values.endpoint!);
for (const url of [page, endpoint])
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Use HTTP(S) URLs without embedded credentials.');
page.search = '';
page.hash = '';
const visitorId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
function payload() {
  return {
    siteId: values.site,
    ...(values.environment ? { environmentId: values.environment } : {}),
    id: crypto.randomUUID(),
    type: 'pageview',
    url: page.href,
    ...(values.mode === 'cookieless'
      ? {}
      : {
          session: {
            consent: true,
            ...(values.mode === 'local' ? { storage: 'local' } : {}),
            visitorId,
            sessionId,
            kind: 'pageview',
            details: {
              viewportWidth: 1280,
              viewportHeight: 800,
              screenWidth: 1280,
              screenHeight: 800,
              language: 'en',
            },
          },
        }),
  };
}

console.log(
  `Target: ${page.href}\nCollector: ${endpoint.href}\nRequests: 30 (fresh event IDs, same page)`,
);
if (values['dry-run']) {
  console.log(JSON.stringify(payload(), null, 2));
  process.exit(0);
}
console.log('Accepted events use normal credits. No account token or API key is needed.');
// Leave enough time for the bounded burst to finish inside a single UTC minute.
const elapsed = Date.now() % 60000;
if (elapsed > 40000) {
  const wait = 60500 - elapsed;
  console.log(`Waiting ${Math.ceil(wait / 1000)}s for a fresh minute window…`);
  await Bun.sleep(wait);
}
const startedMinute = Math.floor(Date.now() / 60000);
const counts = { queued: 0, spamBlocked: 0, rateLimited: 0, other: 0, networkErrors: 0 };
async function send(index: number) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: page.origin,
        'user-agent': 'AnalyticsBeerQA/1.0',
      },
      body: JSON.stringify(payload()),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    const data = (await response.json()) as {
      accepted?: boolean;
      reason?: string;
      error?: { code?: string; message?: string };
    };
    const accepted = response.status === 202 && data.accepted === true;
    const spam =
      response.status === 202 && data.accepted === false && data.reason === 'spam_detected';
    const label = accepted
      ? 'queued'
      : spam
        ? 'spam_detected'
        : (data.reason ?? data.error?.code ?? `HTTP ${response.status}`);
    if (accepted) counts.queued++;
    else if (spam) counts.spamBlocked++;
    else if (response.status === 429) counts.rateLimited++;
    else counts.other++;
    console.log(
      `${String(index).padStart(2, '0')}: ${response.status} ${label}${data.error?.message ? ` — ${data.error.message}` : ''}`,
    );
    return accepted || spam;
  } catch (error) {
    counts.networkErrors++;
    console.error(
      `${index}: request failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// Stop on configuration, quota or network errors before sending the rest.
if (await send(1)) {
  for (let first = 2; first <= 30; first += 6) {
    const results = await Promise.all(
      Array.from({ length: Math.min(6, 31 - first) }, (_, i) => send(first + i)),
    );
    if (results.some((ok) => !ok)) break;
  }
}
console.table(counts);
console.log('Queued means accepted by the collector, not guaranteed storage or billing.');
if (counts.spamBlocked)
  console.log('Spam protection responded. Check Usage → Spam protection for the blocked totals.');
else {
  console.log(
    'No spam rejection observed. Check the results above; a minute boundary or interleaved real traffic can change the outcome.',
  );
  process.exitCode = 1;
}
if (Math.floor(Date.now() / 60000) !== startedMinute)
  console.log('This run crossed a minute boundary, so the repetition counter may have reset.');
