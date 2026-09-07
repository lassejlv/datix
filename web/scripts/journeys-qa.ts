// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const production = process.argv.includes('--production'),
  base = production ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL'];
if (
  !connectionString ||
  (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw Error('Explicit matching database required');
const db = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const email = `journeys-${crypto.randomUUID()}@example.com`;
const dir = `web/artifacts/journeys/${production ? 'production' : 'local'}`;
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
const post = async (path: string, data: unknown) => {
  const r = await context.request.post(base + '/api' + path, { headers: { Origin: base }, data });
  expect(r.ok()).toBe(true);
  return r.json();
};
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  await post('/auth/sign-up/email', {
    name: 'Journey verification',
    email,
    password: crypto.randomUUID(),
  });
  const site = (await post('/sites', { name: 'North Studio', domain: 'journeys.example.com' }))
    .site;
  const url = `${base}/site/${site.id}/${site.id}/visitors`;
  await page.goto(url);
  await expect(page.getByText('No visits yet', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'View tracking setup' }).click();
  await expect(page).toHaveURL(url.replace('/visitors', '/installation'));
  for (const path of ['/cookieless-start', '/cookieless-next']) {
    const response = await context.request.post(`${base}/api/collect`, {
      headers: {
        Origin: 'https://journeys.example.com',
        'User-Agent': 'Mozilla/5.0 Chrome/153.0.0.0',
      },
      data: {
        siteId: site.id,
        id: crypto.randomUUID(),
        type: 'pageview',
        url: `https://journeys.example.com${path}`,
      },
    });
    expect(response.status()).toBe(202);
  }
  await expect
    .poll(
      async () => {
        const response = await context.request.get(`${base}/api/sites/${site.id}/sessions`);
        const report = await response.json();
        return report.sessions?.[0]?.pageviews;
      },
      { timeout: 120000, intervals: [2000] },
    )
    .toBe(2);
  await page.goto(url);
  await expect(page.getByText('Daily visits', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Open session/ }).click();
  await expect(page.getByRole('heading', { name: '/cookieless-start', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '/cookieless-next', exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/cookieless.png`, fullPage: true });
  pass('default cookieless collect → queue → daily visitor journey, with no session payload');
  await db.query('delete from events where site_id=$1', [site.id]);
  const primary = 'a'.repeat(64),
    visitor = 'b'.repeat(64),
    long = 'c'.repeat(64);
  const seed: any[] = [];
  const add = (
    sessionKey: string,
    visitorKey: string,
    kind: string,
    path: string,
    age: number,
    sequence: number,
    details: object = {},
  ) => {
    const time = Date.now() - age;
    seed.push({
      id: crypto.randomUUID(),
      sessionKey,
      visitorKey,
      kind,
      path,
      time,
      name: kind === 'custom' ? 'newsletter_signup' : '',
      details: {
        clientTime: time,
        sequence,
        viewportWidth: 1280,
        viewportHeight: 800,
        screenWidth: 1440,
        screenHeight: 900,
        language: 'da-DK',
        ...details,
      },
    });
  };
  const events = [
    ['pageview', '/', {}],
    ['scroll', '/', { scrollDepth: 75 }],
    ['click', '/', { target: 'view-collection' }],
    ['pageview', '/collection', {}],
    ['click', '/collection', { target: 'ceramic-cup' }],
    ['pageview', '/collection/ceramic-cup', {}],
    ['form_submit', '/collection/ceramic-cup', { target: 'newsletter-form' }],
    ['custom', '/collection/ceramic-cup', {}],
    ['outbound', '/collection/ceramic-cup', { destination: 'https://shop.example.com/checkout' }],
    ['engagement', '/collection/ceramic-cup', { activeSeconds: 28 }],
  ] as const;
  events.forEach(([kind, path, details], i) =>
    add(primary, visitor, kind, path, (10 - i) * 25000, i, details),
  );
  add('d'.repeat(64), visitor, 'pageview', '/journal', 86400000, 0);
  for (let i = 0; i < 205; i++)
    add(
      long,
      'e'.repeat(64),
      i === 0 ? 'pageview' : 'click',
      '/archive',
      172800000 - i * 1000,
      i,
      i ? { target: 'archive-next' } : {},
    );
  for (let i = 0; i < 49; i++)
    add(
      (i + 1).toString(16).padStart(64, '0'),
      (i + 100).toString(16).padStart(64, '0'),
      'pageview',
      ['/', '/studio', '/journal'][i % 3]!,
      3600000 + i * 60000,
      0,
    );
  // Synthetic records belong only to this disposable fixture account.
  await db.query(
    `insert into activity_events (environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) select $1,(x->>'id')::uuid,x->>'sessionKey',x->>'visitorKey',to_timestamp((x->>'time')::double precision/1000),x->>'kind',x->>'name',x->>'path','google.com','DK','desktop','Chrome','macOS',x->'details' from jsonb_array_elements($2::jsonb) x`,
    [site.id, JSON.stringify(seed)],
  );
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Visitors', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` }),
  ).toBeVisible();
  const dateBox = await page.getByLabel('Visitor date range').boundingBox(),
    refreshBox = await page.getByRole('button', { name: 'Refresh visits' }).boundingBox();
  expect(dateBox!.height).toBe(32);
  expect(refreshBox!.height).toBe(dateBox!.height);
  const row = page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` });
  const resting = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await row.hover();
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(resting);
  await row.focus();
  expect(await row.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
  await page.screenshot({ path: `${dir}/list.png`, fullPage: false });
  await page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` }).click();
  await expect(page.getByText('Element: newsletter-form', { exact: true })).toBeVisible();
  await expect(page.getByText('Scrolled to 75%', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Session timeline' }).getByRole('heading', { level: 2 }),
  ).toBeFocused();
  await expect(page.getByText('🇩🇰', { exact: true })).toBeVisible();
  await expect(page.getByText('Denmark', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'View visitor history' }).click();
  await expect(page.getByRole('button', { name: /Open session/ })).toHaveCount(2);
  const result = await (
    await context.request.get(`${base}/api/sites/${site.id}/sessions?visitor=${visitor}`)
  ).json();
  expect(result.summary.sessions).toBe(2);
  expect(result.summary.visitors).toBe(1);
  expect(result.sessions.every((s: any) => s.visitorKey === visitor)).toBe(true);
  expect(
    (await context.request.get(`${base}/api/sites/${site.id}/sessions?visitor=invalid`)).status(),
  ).toBe(400);
  const missing = await (
    await context.request.get(`${base}/api/sites/${site.id}/sessions?visitor=${'f'.repeat(64)}`)
  ).json();
  expect(missing.summary.sessions).toBe(0);
  await page.getByRole('button', { name: 'All visitors', exact: true }).click();
  await page.getByRole('button', { name: 'Load more visits' }).click();
  await expect(page.getByRole('button', { name: /Open session/ })).toHaveCount(52);
  await page.getByRole('button', { name: `Open session ${long.slice(0, 8)}` }).click();
  await expect(page.getByRole('button', { name: 'Load more activity' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.getByRole('button', { name: 'Load more activity' })).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Activity events' }).getByRole('listitem'),
  ).toHaveCount(205);
  pass(
    'Retained cookieless history, readable event timeline, visitor filter, and both pagination paths',
  );
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` }).click();
  await expect(page.getByText('Element: newsletter-form', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${dir}/mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'All visits', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` }),
  ).toBeFocused();
  await page.screenshot({ path: `${dir}/mobile-history.png`, fullPage: false });
  await page.getByLabel('Visitor date range').selectOption('1');
  await page.getByRole('button', { name: 'Refresh visits' }).click();
  await expect(
    page.getByRole('button', { name: `Open session ${primary.slice(0, 8)}` }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Visitors', exact: true })).toBeVisible();
  // A foreign account cannot read this environment's visitor history.
  const stranger = await browser.newContext();
  expect(
    (
      await stranger.request.get(`${base}/api/sites/${site.id}/sessions?visitor=${visitor}`)
    ).status(),
  ).toBe(401);
  await stranger.close();
  expect(errors).toEqual([]);
  pass(
    'Mobile journey/back focus, date controls, direct-route reload and unauthenticated isolation',
  );
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify(
      {
        base,
        checks,
        errors,
        fixture: 'Synthetic activity in a disposable account',
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  await db.query('delete from "user" where email=$1', [email]);
  await db.end();
}
