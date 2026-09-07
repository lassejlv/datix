import { defaultTrackingSettings } from '../../src/lib/tracking-settings';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(
  process.env.TRACKER_TEST_FILE ?? new URL('../../public/tracker.js', import.meta.url),
  'utf8',
);
function tracker({
  env = 'environment',
  shared = new Map<string, { value: string; expires: number }>(),
  now = 1000000,
  saved = false,
  status = 202,
  mode = 'sessions',
  local = new Map<string, string>(),
  blocked = false,
}: {
  env?: string;
  shared?: Map<string, { value: string; expires: number }>;
  now?: number;
  saved?: boolean;
  status?: number;
  mode?: string;
  local?: Map<string, string>;
  blocked?: boolean;
} = {}) {
  const requests: any[] = [],
    timers: Function[] = [],
    intervals: Function[] = [],
    writes: string[] = [];
  let reads = 0,
    storageReads = 0;
  const listeners: Record<string, Function> = {};
  const window: any = { analyticsBeerConsent: saved };
  const document: any = {
    currentScript: {
      src: 'https://analytics.example/tracker.js',
      getAttribute: (key: string) =>
        ({
          'data-site': 'site',
          'data-environment': env,
          'data-mode': mode,
        })[key] ?? null,
      hasAttribute: () => false,
    },
    documentElement: { hasAttribute: () => false },
    body: { hasAttribute: () => false },
    referrer: 'https://referrer.example/?private=secret',
    visibilityState: 'visible',
    addEventListener() {},
  };
  Object.defineProperty(document, 'cookie', {
    get() {
      reads++;
      return [...shared]
        .filter(([, c]) => c.expires > now)
        .map(([k, c]) => `${k}=${c.value}`)
        .join('; ');
    },
    set(value: string) {
      writes.push(value);
      const [part] = value.split(';');
      const [key, val] = part!.split('=');
      const seconds = Number(value.match(/Max-Age=(\d+)/)?.[1]);
      shared.set(key!, { value: val!, expires: now + seconds * 1000 });
    },
  });
  runInNewContext(source, {
    window,
    document,
    navigator: { language: 'en-GB', doNotTrack: null },
    URL,
    crypto,
    AbortController,
    Date: { now: () => now },
    location: {
      hostname: 'session.example',
      protocol: 'https:',
      origin: 'https://session.example',
      pathname: '/start',
      href: 'https://session.example/start?private=secret',
    },
    history: { pushState() {}, replaceState() {} },
    innerWidth: 1200,
    innerHeight: 800,
    screen: { width: 1440, height: 900 },
    addEventListener: (name: string, fn: Function) => {
      listeners[name] = fn;
    },
    localStorage: {
      getItem: (key: string) => {
        storageReads++;
        if (blocked) throw Error('blocked');
        return local.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (blocked) throw Error('blocked');
        local.set(key, value);
      },
      removeItem: (key: string) => {
        if (blocked) throw Error('blocked');
        local.delete(key);
      },
    },
    setInterval: (f: Function) => intervals.push(f),
    setTimeout: (f: Function) => timers.push(f),
    console: { info() {} },
    fetch: async (_url: string, options: any) => {
      if (_url.includes('/api/tracker-config'))
        return {
          status: 200,
          json: async () => ({ enabled: true, settings: defaultTrackingSettings }),
        };
      requests.push(JSON.parse(options.body));
      return { status, json: async () => ({ accepted: true }) };
    },
  });
  return {
    window,
    requests,
    writes,
    shared,
    document,
    readCount: () => reads,
    local,
    listeners,
    storageReadCount: () => storageReads,
    advance: (ms: number) => {
      now += ms;
    },
    timers,
    intervals,
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('session mode neither accesses tracking cookies nor sends data until affirmative consent', async () => {
  const t = tracker();
  await settle();
  expect(t.requests).toHaveLength(0);
  expect(t.readCount()).toBe(0);
  expect(t.writes).toHaveLength(0);
  t.window.simpleAnalytics.track('before');
  await settle();
  expect(t.requests).toHaveLength(0);
  t.window.simpleAnalytics.consent(true);
  await settle();
  expect(t.requests).toHaveLength(1);
  expect(t.requests[0]).toMatchObject({
    type: 'pageview',
    session: { consent: true, kind: 'pageview' },
  });
  expect(JSON.stringify(t.requests)).not.toContain('private=');
  expect(t.writes.every((c) => c.includes('SameSite=Lax') && c.includes('Secure'))).toBe(true);
  t.window.simpleAnalytics.consent(true);
  await settle();
  expect(t.requests).toHaveLength(1);
});
test('visitor and session cookies survive pages, expire on inactivity, and stay environment scoped', async () => {
  const first = tracker({ saved: true });
  await settle();
  const ids = first.requests[0].session;
  const next = tracker({ shared: first.shared, saved: true, now: 1001000 });
  await settle();
  expect(next.requests[0].session.visitorId).toBe(ids.visitorId);
  expect(next.requests[0].session.sessionId).toBe(ids.sessionId);
  next.advance(1800001);
  next.window.simpleAnalytics.track('later');
  await settle();
  expect(next.requests[1].session.visitorId).toBe(ids.visitorId);
  expect(next.requests[1].session.sessionId).not.toBe(ids.sessionId);
  const other = tracker({ env: 'another', shared: first.shared, saved: true });
  await settle();
  expect(other.requests[0].session.visitorId).not.toBe(ids.visitorId);
});
test('withdrawal deletes cookies and cancels future events and pending retries', async () => {
  const t = tracker({ saved: true, status: 503 });
  await settle();
  await settle();
  expect(t.timers).toHaveLength(1);
  t.window.simpleAnalytics.consent(false);
  await settle();
  expect(t.document.cookie).toBe('');
  t.window.simpleAnalytics.track('after');
  await settle();
  t.timers[0]!();
  await settle();
  expect(t.requests).toHaveLength(1);
  t.advance(15000);
  t.intervals[0]!();
  await settle();
  expect(t.requests).toHaveLength(1);
  t.window.simpleAnalytics.consent(true);
  await settle();
  expect(t.requests).toHaveLength(2);
  expect(t.requests[1].session.visitorId).not.toBe(t.requests[0].session.visitorId);
});
test('engagement only counts recently active visible time and never extends idle sessions forever', async () => {
  const t = tracker({ saved: true });
  await settle();
  t.advance(15000);
  t.intervals[0]!();
  await settle();
  expect(t.requests[1]).toMatchObject({
    session: { kind: 'engagement', details: { activeSeconds: 15 } },
  });
  t.advance(31000);
  t.intervals[0]!();
  await settle();
  expect(t.requests).toHaveLength(2);
});

test('a private whole page creates no cookies or activity even when consent is granted', async () => {
  const t = tracker();
  await settle();
  t.document.documentElement.hasAttribute = () => true;
  t.window.simpleAnalytics.consent(true);
  await settle();
  t.window.simpleAnalytics.track('private_action');
  await settle();
  expect(t.requests).toHaveLength(0);
  expect(t.writes).toHaveLength(0);
  expect(t.readCount()).toBe(0);
});

test('local visitors wait for consent without touching storage or cookies, persist across pages and expire', async () => {
  const t = tracker({ mode: 'local' });
  await settle();
  expect(t.storageReadCount()).toBe(0);
  expect(t.requests).toHaveLength(0);
  t.window.simpleAnalytics.consent(true);
  await settle();
  const first = t.requests[0].session;
  expect(first.storage).toBe('local');
  expect(t.writes).toHaveLength(0);
  expect(t.readCount()).toBe(0);
  const next = tracker({ mode: 'local', local: t.local, saved: true, now: 1001000 });
  await settle();
  expect(next.requests[0].session.visitorId).toBe(first.visitorId);
  expect(next.requests[0].session.sessionId).toBe(first.sessionId);
  next.advance(1800001);
  next.window.simpleAnalytics.track('return');
  await settle();
  expect(next.requests[1].session.visitorId).toBe(first.visitorId);
  expect(next.requests[1].session.sessionId).not.toBe(first.sessionId);
  next.advance(90 * 86400000 + 1);
  next.window.simpleAnalytics.track('expired');
  await settle();
  expect(next.requests[2].session.visitorId).not.toBe(first.visitorId);
  const other = tracker({ mode: 'local', local: t.local, saved: true, env: 'other' });
  await settle();
  expect(other.requests[0].session.visitorId).not.toBe(first.visitorId);
});

test('local withdrawal removes only scoped identifiers, cancels retries and propagates without BroadcastChannel', async () => {
  const t = tracker({ mode: 'local', saved: true, status: 503 });
  await settle();
  t.local.set('unrelated', 'keep');
  await settle();
  t.window.simpleAnalytics.consent(false);
  await settle();
  expect(t.local.has('analytics-beer:identity:environment')).toBe(false);
  expect(t.local.get('unrelated')).toBe('keep');
  t.timers[0]!();
  t.window.simpleAnalytics.track('after');
  await settle();
  await settle();
  expect(t.requests).toHaveLength(1);
  const other = tracker({ mode: 'local', saved: true });
  await settle();
  other.listeners.storage!({ key: 'analytics-beer:identity:environment', newValue: null });
  await settle();
  other.window.simpleAnalytics.track('after');
  await settle();
  expect(other.requests).toHaveLength(1);
  expect(other.local.size).toBe(0);
  expect(other.writes).toHaveLength(0);
});

test('local storage failure stops collection; malformed IDs are replaced and private pages create no identifiers', async () => {
  const blocked = tracker({ mode: 'local', saved: true, blocked: true });
  await settle();
  expect(blocked.requests).toHaveLength(0);
  expect(blocked.writes).toHaveLength(0);
  const local = new Map([['analytics-beer:identity:environment', '{bad json']]);
  const repaired = tracker({ mode: 'local', saved: true, local });
  await settle();
  expect(repaired.requests).toHaveLength(1);
  expect(JSON.parse(local.values().next().value!).visitorId).toBe(
    repaired.requests[0].session.visitorId,
  );
  const privatePage = tracker({ mode: 'local' });
  await settle();
  privatePage.document.documentElement.hasAttribute = () => true;
  privatePage.window.simpleAnalytics.consent(true);
  await settle();
  expect(privatePage.local.size).toBe(0);
  expect(privatePage.requests).toHaveLength(0);
});

test('cookieless activity starts by default with full metadata and never accesses identity storage', async () => {
  const t = tracker({ mode: 'cookieless', blocked: true });
  await settle();
  expect(t.requests).toHaveLength(1);
  expect(t.requests[0].session).toBeUndefined();
  expect(t.requests[0].activity).toMatchObject({
    kind: 'pageview',
    details: {
      viewportWidth: 1200,
      viewportHeight: 800,
      screenWidth: 1440,
      screenHeight: 900,
      language: 'en-GB',
    },
  });
  expect(t.requests[0].activity.visitorId).toBeUndefined();
  expect(t.requests[0].activity.sessionId).toBeUndefined();
  t.advance(15000);
  t.intervals[0]!();
  await settle();
  expect(t.requests[1].activity).toMatchObject({
    kind: 'engagement',
    details: { activeSeconds: 15 },
  });
  t.window.simpleAnalytics.track('checkout');
  await settle();
  expect(t.requests[2].activity.kind).toBe('custom');
  t.window.simpleAnalytics.consent(false);
  await settle();
  t.window.simpleAnalytics.track('after-stop');
  await settle();
  expect(t.requests).toHaveLength(3);
  expect(t.readCount()).toBe(0);
  expect(t.writes).toEqual([]);
  expect(t.storageReadCount()).toBe(0);
  expect(t.local.size).toBe(0);
  expect(JSON.stringify(t.requests)).not.toContain('private=secret');
});
