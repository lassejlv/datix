import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const anonymous = process.argv.includes('--cookieless');
const localMode = process.argv.includes('--local-storage');
const mode = anonymous ? 'cookieless' : localMode ? 'local' : 'sessions';
const prod = process.argv.includes('--production'),
  base = prod ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = process.env[prod ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL']!;
if (prod && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw Error('Wrong production database');
const client = new Client({ connectionString }),
  email = `sessions-qa-${crypto.randomUUID()}@example.com`,
  dir = `artifacts/${anonymous ? 'cookieless-activity' : localMode ? 'local-visitors' : 'sessions'}-${prod ? 'production' : 'local'}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
let fixture: ReturnType<typeof Bun.serve> | undefined;
try {
  await client.connect();
  await mkdir(dir, { recursive: true });
  await page.goto(`${base}/signin`);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Sessions QA');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(`Qa!${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Add your first website' }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Session verification');
  await page.getByLabel('Website domain').fill('sessions-qa.example.com');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByRole('link', { name: 'Install', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  const site = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('checkbox', { name: 'Allow localhost for testing', exact: true }).click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Allow localhost for testing',
      exact: true,
    }),
  ).toBeChecked();
  if (!anonymous) {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Analytics mode', { exact: true }).selectOption(mode);
    await expect(page.getByRole('button', { name: 'Save tracking mode' })).toBeDisabled();
    await expect(
      page.getByText(
        localMode
          ? 'Uses local storage — analytics consent is required.'
          : 'Uses cookies — a cookie banner is required.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await page
      .getByRole('checkbox', {
        name: localMode
          ? 'I understand that local storage requires analytics consent.'
          : 'I understand that I need a cookie banner and analytics consent.',
      })
      .check();
    await page.getByRole('button', { name: 'Save tracking mode' }).click();
    await expect(page.getByRole('button', { name: 'Save tracking mode' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Install', exact: true }).click();
    await expect(page.getByLabel('Tracking script')).toContainText(`data-mode="${mode}"`);
    await expect(page.getByLabel('Consent integration')).toContainText('simpleAnalytics?.consent');
    await page.screenshot({ path: `${dir}/installation.png`, fullPage: true });
    pass(
      'Mode is opt-in, requires consent acknowledgement, and exposes consent-aware installation code',
    );
  }
  fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new Response(
        `<!doctype html><html ${new URL(req.url).pathname === '/private' ? 'data-analytics-ignore' : ''}><head><script>window.analyticsBeerConsent=localStorage.getItem('qa-consent')==='yes';function choose(value){localStorage.setItem('qa-consent',value?'yes':'no');window.analyticsBeerConsent=value;window.simpleAnalytics?.consent(value);}</script><script defer src="${base}/tracker.js" data-site="${site}" data-mode="${mode}"></script></head><body><div data-analytics-ignore><button onclick="choose(true)">Accept analytics</button><button onclick="choose(false)">Reject analytics</button></div><button data-analytics-label="checkout-button">Buy</button><div data-analytics-ignore><button>Private action</button><input aria-label="Private value"></div><form onsubmit="event.preventDefault()" data-analytics-label="signup-form"><input aria-label="Email" type="email"><button type="submit">Submit</button></form><a href="https://external.example/document?email=secret#fragment" onclick="event.preventDefault()" data-analytics-label="external-link">External</a><a href="/download?token=secret" download onclick="event.preventDefault()">Download</a><button onclick="history.pushState({},'', '/next')">Next page</button><div style="height:2400px">Scroll area</div></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      ),
  });
  const origin = `http://localhost:${fixture.port}`,
    tracker = await context.newPage();
  tracker.on('pageerror', (e) => errors.push(e.message));
  const payloads: any[] = [];
  const statuses: number[] = [];
  tracker.on('request', (r) => {
    if (r.url() === `${base}/api/collect`) payloads.push(r.postDataJSON());
  });
  tracker.on('response', (r) => {
    if (r.url() === `${base}/api/collect`) statuses.push(r.status());
  });
  await tracker.goto(origin);
  if (!anonymous) {
    await tracker.getByRole('button', { name: 'Buy', exact: true }).click();
    await tracker.getByLabel('Email', { exact: true }).fill('SensitiveBeforeConsent@example.com');
    await tracker.waitForTimeout(600);
    expect(payloads).toHaveLength(0);
    expect((await context.cookies(origin)).filter((c) => c.name.startsWith('ab_'))).toHaveLength(0);
    await tracker.getByRole('button', { name: 'Accept analytics' }).click();
  }
  await expect.poll(() => payloads.length).toBe(1);
  const first = payloads[0].session ?? payloads[0].activity;
  if (anonymous) {
    expect(payloads[0].session).toBeUndefined();
    expect(first.visitorId).toBeUndefined();
    expect(first.sessionId).toBeUndefined();
    expect(await tracker.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(first.details).toMatchObject({ viewportWidth: 1440, viewportHeight: 1000 });
  } else expect(first.consent).toBe(true);
  const cookies = (await context.cookies(origin)).filter((c) => c.name.startsWith('ab_'));
  expect(cookies).toHaveLength(anonymous || localMode ? 0 : 2);
  if (localMode) {
    expect(first.storage).toBe('local');
    const stored = await tracker.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || 'null'),
      `analytics-beer:identity:${site}`,
    );
    expect(stored.visitorId).toBe(first.visitorId);
    expect(stored.sessionId).toBe(first.sessionId);
  }
  expect(cookies.every((c) => c.sameSite === 'Lax')).toBe(true);
  await tracker.getByRole('button', { name: 'Buy', exact: true }).click();
  await tracker.getByRole('button', { name: 'Private action' }).click();
  await tracker.getByLabel('Private value').fill('SensitivePrivateText');
  await tracker.getByLabel('Email', { exact: true }).fill('SensitivePerson@example.com');
  await tracker.getByRole('button', { name: 'Submit', exact: true }).click();
  await tracker.getByRole('link', { name: 'External', exact: true }).click();
  await tracker.getByRole('link', { name: 'Download', exact: true }).click();
  await tracker.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await tracker.waitForTimeout(650);
  await tracker.getByRole('button', { name: 'Next page', exact: true }).click();
  await tracker.reload();
  await expect
    .poll(() => payloads.filter((p) => p.type === 'pageview').length)
    .toBe(anonymous ? 2 : 3);
  expect(
    payloads.every((p) =>
      anonymous
        ? !p.session && !p.activity.visitorId && !p.activity.sessionId
        : p.session.visitorId === first.visitorId && p.session.sessionId === first.sessionId,
    ),
  ).toBe(true);
  expect(JSON.stringify(payloads)).not.toContain('Sensitive');
  expect(JSON.stringify(payloads)).not.toContain('email=');
  expect(JSON.stringify(payloads)).not.toContain('token=');
  expect(JSON.stringify(payloads)).not.toContain('Private action');
  for (const kind of ['pageview', 'click', 'form_submit', 'outbound', 'download', 'scroll'])
    expect(payloads.some((p) => (p.session ?? p.activity).kind === kind)).toBe(true);
  await expect
    .poll(() => payloads.some((p) => (p.session ?? p.activity).kind === 'engagement'), {
      timeout: 20000,
      intervals: [1000],
    })
    .toBe(true);
  pass(
    'Tracking captures navigation, clicks, forms, links, downloads, scroll and active time; private values excluded; cookieless sends no persistent identifiers',
  );
  await expect
    .poll(
      async () =>
        (
          await client.query(
            "select coalesce(sum((details->>'activeSeconds')::int),0)::int n from activity_events where environment_id=$1",
            [site],
          )
        ).rows[0].n,
      { timeout: 60000, intervals: [1000, 2000, 4000] },
    )
    .toBeGreaterThan(0);
  const second = await context.newPage();
  second.on('request', (r) => {
    if (r.url() === `${base}/api/collect`) payloads.push(r.postDataJSON());
  });
  await second.goto(`${origin}/another-tab`);
  await expect
    .poll(() => payloads.filter((p) => p.type === 'pageview').length)
    .toBe(anonymous ? 3 : 4);
  if (localMode)
    expect((await context.cookies(origin)).filter((c) => c.name.startsWith('ab_'))).toHaveLength(0);
  await tracker.getByRole('button', { name: 'Reject analytics' }).click();
  await expect
    .poll(
      async () => (await context.cookies(origin)).filter((c) => c.name.startsWith('ab_')).length,
    )
    .toBe(0);
  if (localMode)
    await expect
      .poll(() =>
        tracker.evaluate((key) => localStorage.getItem(key), `analytics-beer:identity:${site}`),
      )
      .toBeNull();
  const before = payloads.length;
  await tracker.getByRole('button', { name: 'Buy', exact: true }).click();
  await second.getByRole('button', { name: 'Buy', exact: true }).click();
  await tracker.waitForTimeout(650);
  expect(payloads).toHaveLength(before);
  expect((await context.cookies(origin)).filter((c) => c.name.startsWith('ab_'))).toHaveLength(0);
  pass('Reject/withdraw deletes tracking identifiers and stops activity across tabs');
  await second.close();
  await tracker.close();
  const sessions = async () =>
    (await context.request.get(`${base}/api/sites/${site}/sessions`)).json();
  await expect
    .poll(async () => (await sessions()).summary.clicks, {
      timeout: 60000,
      intervals: [1000, 2000, 4000],
    })
    .toBeGreaterThanOrEqual(5);
  const report = await sessions();
  expect(report.summary.sessions).toBe(1);
  expect(report.summary.visitors).toBe(1);
  expect(report.summary.averageActiveSeconds).toBeGreaterThan(0);
  const key = report.sessions[0].id;
  const timeline = await (
    await context.request.get(`${base}/api/sites/${site}/sessions?session=${key}`)
  ).json();
  expect(
    timeline.events.some((e: any) => e.kind === 'click' && e.details.target === 'checkout-button'),
  ).toBe(true);
  expect(JSON.stringify(timeline)).not.toContain('Sensitive');
  expect(timeline.events[0]).toMatchObject({ browser: 'Chrome', os: 'macOS', device: 'desktop' });
  expect(timeline.events[0].details.viewportWidth).toBe(1440);
  expect(statuses.every((s) => s === 202)).toBe(true);
  await page.getByRole('link', { name: 'Visitors', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Visitors' })).toBeVisible();
  await page.getByRole('button', { name: `Open session ${key.slice(0, 8)}` }).click();
  await expect(
    page.getByRole('region', { name: 'Session timeline' }).getByRole('heading', { level: 2 }),
  ).toBeVisible();
  await expect(page.getByText('Element: checkout-button', { exact: true })).toBeVisible();
  await page.getByText('Visit details', { exact: true }).click();
  await expect(page.getByText('Chrome', { exact: true })).toBeVisible();
  await expect(page.getByText('macOS', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `${dir}/timeline-desktop.png`,
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/timeline-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
      timeout: 5000,
    })
    .toBe(true);
  await page.screenshot({ path: `${dir}/timeline-mobile.png`, fullPage: true });
  pass(
    'Real browser → collector → Queue → database → session metrics and detailed responsive activity timeline',
  );
  expect(errors).toEqual([]);
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify({ base, checks, errors, verifiedAt: new Date().toISOString() }, null, 2),
  );
} finally {
  fixture?.stop(true);
  await context.close();
  await browser.close();
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
}
