import { defaultTrackingSettings } from '../../src/lib/tracking-settings';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const tracker = readFileSync(
  process.env.TRACKER_TEST_FILE ?? new URL('../../public/tracker.js', import.meta.url),
  'utf8',
);
function run({
  features = { errors: false, webVitals: false },
  settings = defaultTrackingSettings,
  configStatus = 200,
  hostname = 'localhost',
  dnt = null,
  gpc = false,
  debug = false,
  siteId = 'test-site',
  environmentId,
  storage = new Map<string, string>(),
  now = 1_000_000,
  status = 202,
  storageDisabled = false,
}: {
  features?: { errors: boolean; webVitals: boolean };
  settings?: typeof defaultTrackingSettings;
  configStatus?: number;
  hostname?: string;
  dnt?: string | null;
  gpc?: boolean;
  debug?: boolean;
  siteId?: string;
  environmentId?: string;
  storage?: Map<string, string>;
  now?: number;
  status?: number;
  storageDisabled?: boolean;
} = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const logs: string[] = [],
    requests: string[] = [];
  const window = {} as {
    simpleAnalytics?: { track(name: string): void; consent(granted: boolean): void };
  };
  const location = {
    hostname,
    href: `http://${hostname}/test?secret=discard`,
    origin: `http://${hostname}`,
    pathname: '/test',
  };
  const history = {
    pushState(_state: unknown, _unused: string, path: string) {
      const url = new URL(path, location.href);
      location.href = url.href;
      location.pathname = url.pathname;
    },
    replaceState(_state: unknown, _unused: string, path: string) {
      this.pushState(_state, _unused, path);
    },
  };
  runInNewContext(tracker, {
    window,
    URL,
    crypto,
    setTimeout,
    setInterval() {},
    AbortController,
    innerWidth: 1200,
    innerHeight: 800,
    screen: { width: 1440, height: 900 },
    Date: { now: () => now },
    location,
    history,
    sessionStorage: {
      getItem: (key: string) => {
        if (storageDisabled) throw new Error('blocked');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageDisabled) throw new Error('blocked');
        storage.set(key, value);
      },
    },
    document: {
      currentScript: {
        src: 'https://analytics.example/tracker.js',
        getAttribute: (name: string) =>
          name === 'data-site'
            ? siteId
            : name === 'data-environment'
              ? (environmentId ?? null)
              : null,
        hasAttribute: () => debug,
      },
      documentElement: { hasAttribute: () => false },
      body: { hasAttribute: () => false },
      addEventListener() {},
      referrer: '',
      visibilityState: 'visible',
    },
    navigator: { doNotTrack: dnt, globalPrivacyControl: gpc },
    addEventListener(name: string, callback: (event: unknown) => void) {
      listeners.set(name, callback);
    },
    console: { info: (message: string) => logs.push(message) },
    fetch: async (_endpoint: string, options: { body: string }) => {
      if (_endpoint.includes('/api/tracker-config'))
        return { status: configStatus, json: async () => ({ enabled: true, settings, features }) };
      requests.push(options.body);
      return { status, json: async () => ({ accepted: status === 202 }) };
    },
  });
  return {
    emit: (name: string, event: unknown) => listeners.get(name)?.(event),
    logs,
    requests,
    window,
    storage,
    advance: (ms: number) => {
      now += ms;
    },
    navigate: (path: string) => history.pushState({}, '', path),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function readyRun(options?: Parameters<typeof run>[0]) {
  const result = run(options);
  await settle();
  return result;
}
test('tracker still respects Do Not Track even with GPC enabled', async () => {
  const result = run({ dnt: '1', gpc: true });
  await settle();
  expect(result.requests).toHaveLength(0);
  expect(result.logs[0]).toContain('Do Not Track');
  expect(result.window).not.toHaveProperty('simpleAnalytics');
});
test('GPC does not prevent tracker initialization or pageview collection', async () => {
  const result = run({ gpc: true });
  await settle();
  expect(result.window).toHaveProperty('simpleAnalytics');
  expect(result.requests).toHaveLength(1);
  expect(JSON.parse(result.requests[0]!)).toMatchObject({
    type: 'pageview',
    url: 'http://localhost/test',
  });
});
test('tracker diagnostics are local or explicit, and never log page payloads', async () => {
  expect((await readyRun({ hostname: 'example.com', dnt: '1' })).logs).toHaveLength(0);
  expect((await readyRun({ hostname: 'example.com', dnt: '1', debug: true })).logs[0]).toContain(
    'Do Not Track',
  );
  expect((await readyRun({ siteId: '' })).logs[0]).toContain('Missing data-site');
  const result = run();
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  expect(result.requests).toHaveLength(1);
  expect(result.logs).toEqual(['[Datix] Collector returned HTTP 202.']);
  expect(result.requests[0]).not.toContain('secret');
});

test('same page is throttled across reloads until exactly one minute, without extending the window', async () => {
  const first = run();
  await settle();
  await settle();
  const reload = run({ storage: first.storage, now: 1_059_999 });
  await settle();
  expect(reload.requests).toHaveLength(0);
  expect(reload.logs).toEqual(['[Datix] Pageview ignored - throttled (same URL within 1 minute)']);
  expect((await readyRun({ storage: first.storage, now: 1_060_000 })).requests).toHaveLength(1);
});
test('navigation to a different page counts, returning within a minute does not, and custom events are unaffected', async () => {
  const result = run();
  await settle();
  result.navigate('/other');
  await settle();
  result.navigate('/test?different=query#fragment');
  await settle();
  expect(result.requests).toHaveLength(2);
  result.window.simpleAnalytics!.track('click');
  await settle();
  result.window.simpleAnalytics!.track('click');
  await settle();
  expect(result.requests.map((body) => JSON.parse(body).type)).toEqual([
    'pageview',
    'pageview',
    'event',
    'event',
  ]);
  result.advance(60_000);
  result.navigate('/other');
  await settle();
  result.navigate('/test');
  await settle();
  expect(result.requests).toHaveLength(6);
  result.advance(60_000);
  result.navigate('/test?only=query');
  await settle();
  expect(result.requests).toHaveLength(6);
});
test('throttle is scoped to the site and tab, and survives blocked or malformed storage', async () => {
  const first = run();
  await settle();
  expect(
    (await readyRun({ storage: first.storage, siteId: 'another-site' })).requests,
  ).toHaveLength(1);
  expect((await readyRun()).requests).toHaveLength(1);
  const blocked = run({ storageDisabled: true });
  await settle();
  blocked.navigate('/other');
  await settle();
  blocked.navigate('/test');
  await settle();
  expect(blocked.requests).toHaveLength(2);
  const malformed = new Map([['analytics-beer:pageviews:test-site', '{invalid']]);
  expect((await readyRun({ storage: malformed })).requests).toHaveLength(1);
});
test('rejected collection clears its throttle so a corrected installation can retry immediately', async () => {
  const rejected = run({ status: 403 });
  await settle();
  await settle();
  expect((await readyRun({ storage: rejected.storage })).requests).toHaveLength(1);
});

test('environment payloads and throttling stay separate under the same site', async () => {
  const production = run();
  await settle();
  await settle();
  const staging = run({ storage: production.storage, environmentId: 'staging-id' });
  await settle();
  expect(staging.requests).toHaveLength(1);
  expect(JSON.parse(staging.requests[0]!)).toMatchObject({
    siteId: 'test-site',
    environmentId: 'staging-id',
  });
  expect(JSON.parse(production.requests[0]!)).not.toHaveProperty('environmentId');
  expect((await readyRun({ storage: production.storage })).requests).toHaveLength(0);
  expect(
    (await readyRun({ storage: production.storage, environmentId: 'staging-id' })).requests,
  ).toHaveLength(0);
});

test('tracker blocks disabled activity, strips details, refreshes policy and fails closed', async () => {
  const settings = {
    ...defaultTrackingSettings,
    custom: false,
    referrer: false,
    dimensions: false,
    language: false,
  };
  const result = await readyRun({ settings });
  const page = JSON.parse(result.requests[0]!);
  expect(page.referrer).toBe('');
  expect(page.activity.details).toMatchObject({
    viewportWidth: 0,
    viewportHeight: 0,
    screenWidth: 0,
    screenHeight: 0,
    language: '',
  });
  result.window.simpleAnalytics!.track('disabled');
  await settle();
  expect(result.requests).toHaveLength(1);
  settings.pageview = false;
  result.advance(60001);
  result.navigate('/disabled');
  await settle();
  expect(result.requests).toHaveLength(1);
  expect((await readyRun({ configStatus: 503 })).requests).toHaveLength(0);
});

test('JavaScript error capture is opt-in, bounded, redacted and stops after consent revocation', async () => {
  const event = {
    message: 'Failure for private@example.org',
    filename: 'https://example.com/app.js?token=secret',
    error: { stack: 'at https://example.com/app.js?token=secret' },
    lineno: 8,
    colno: 2,
  };
  const off = await readyRun();
  off.emit('error', event);
  await settle();
  expect(
    off.requests.map((value) => JSON.parse(value)).filter((value) => value.kind === 'error'),
  ).toHaveLength(0);
  const on = await readyRun({ features: { errors: true, webVitals: false } });
  on.emit('error', event);
  on.emit('error', event);
  await settle();
  const rows = on.requests
    .map((value) => JSON.parse(value))
    .filter((value) => value.kind === 'error');
  expect(rows).toHaveLength(1);
  expect(rows[0].payload.message).toBe('Failure for [redacted]');
  expect(JSON.stringify(rows)).not.toContain('token=secret');
  on.window.simpleAnalytics!.consent(false);
  on.emit('error', { ...event, message: 'Different failure' });
  await settle();
  expect(
    on.requests.map((value) => JSON.parse(value)).filter((value) => value.kind === 'error'),
  ).toHaveLength(1);
});
