// Browser verification against an isolated local database; inserts and removes its own account.
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
process.chdir(new URL('../..', import.meta.url).pathname);
const base = process.env.QA_BASE_URL ?? 'http://localhost:3074';
if (
  !['localhost', '127.0.0.1'].includes(new URL(base).hostname) ||
  !process.env.TEST_DATABASE_HOST ||
  new URL(process.env.DATABASE_URL!).hostname !== process.env.TEST_DATABASE_HOST
) {
  throw Error('An isolated local app and test database are required.');
}
const db = new Client({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: 'reduce',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
await context.route('https://usedatix.com/tracker.js', (route) => route.fulfill({ body: '' }));
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const dir = 'web/artifacts/journey-flow';
let owner = '';
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: {
      name: 'Journey preview',
      email: `journey-flow-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
    },
  });
  expect(signup.status()).toBe(200);
  owner = (await signup.json()).user.id;
  const response = await context.request.post(`${base}/api/sites`, {
    headers: { Origin: base },
    data: { name: 'North Studio', domain: 'north-studio.example' },
  });
  expect(response.status()).toBe(201);
  const site = (await response.json()).site;
  const policy = await (
    await context.request.get(`${base}/api/tracker-config?siteId=${site.id}`)
  ).json();
  expect(policy.settings).toMatchObject({
    click: false,
    download: false,
    scroll: false,
    pageview: true,
  });
  const enabled = { ...policy.settings, click: true, download: true, scroll: true };
  const update = await context.request.patch(
    `${base}/api/sites/${site.id}/environments/${site.id}`,
    {
      headers: { Origin: base },
      data: { trackingSettings: enabled },
    },
  );
  expect(update.ok()).toBe(true);
  expect(
    (await (await context.request.get(`${base}/api/tracker-config?siteId=${site.id}`)).json())
      .settings,
  ).toMatchObject({ click: true, download: true, scroll: true });
  const session = 'a'.repeat(64);
  const records = [
    ['pageview', '/', {}],
    ['scroll', '/', { scrollDepth: 75 }],
    ['click', '/', { target: 'a.view-collection' }],
    ['pageview', '/collection', {}],
    ['click', '/collection', { target: 'button.ceramic-cup' }],
    ['custom', '/collection', {}],
    ['pageview', '/collection/ceramic-cup', {}],
    ['form_submit', '/collection/ceramic-cup', { target: 'form.newsletter' }],
    ['outbound', '/collection/ceramic-cup', { destination: 'https://shop.example.com/checkout' }],
    ['engagement', '/collection/ceramic-cup', { activeSeconds: 28 }],
    ['pageview', '/', {}],
    ['click', '/', { target: `button.${'a-long-element-name-'.repeat(20)}` }],
  ].map(([kind, path, details], i) => {
    const time = Date.now() - 3600000 + i * 1000;
    return {
      id: crypto.randomUUID(),
      kind,
      path,
      time,
      name: kind === 'custom' ? 'search' : '',
      details: { ...(details as object), sequence: i, clientTime: time },
    };
  });
  for (let i = records.length; i < 206; i++) {
    const time = Date.now() - 3500000 + i * 1000;
    records.push({
      id: crypto.randomUUID(),
      kind: 'click',
      path: '/',
      time,
      name: '',
      details: { sequence: i, clientTime: time },
    });
  }
  await db.query(
    `insert into activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details)
    select $1,(x->>'id')::uuid,$2,$3,to_timestamp((x->>'time')::double precision/1000),x->>'kind',x->>'name',x->>'path','google.com','DK','desktop','Chrome','macOS',x->'details' from jsonb_array_elements($4::jsonb) x`,
    [site.id, session, 'b'.repeat(64), JSON.stringify(records)],
  );
  await db.query(
    `insert into events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor)
    select environment_id,id,received_at,(received_at at time zone 'UTC')::date,case when kind='pageview' then 'pageview' else 'event' end,name,path,referrer,country,device,visitor_key from activity_events where environment_id=$1`,
    [site.id],
  );
  const url = `${base}/site/${site.id}/${site.id}/visitors`;
  async function open() {
    await page.goto(url);
    await page.getByRole('button', { name: `Open session ${session.slice(0, 8)}` }).click();
    await expect(page.getByRole('list', { name: 'Journey steps', exact: true })).toBeVisible();
  }
  await open();
  const nodeBox = await page.locator('button.journey-node').first().boundingBox();
  expect(nodeBox!.height).toBe(34);
  expect(nodeBox!.width).toBeLessThanOrEqual(320);
  await expect(page.getByRole('button', { name: 'Journey', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.journey-node').filter({ hasText: /^\/$/ })).toHaveCount(2);
  const form = page.getByRole('button', { name: 'Submitted a form', exact: true });
  await form.focus();
  await page.keyboard.press('Enter');
  await expect(form).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Element: form.newsletter', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(form).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Clicked an external link', exact: true }).click();
  await expect(
    page.getByText('Destination: https://shop.example.com/checkout', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clicked an external link', exact: true }).click();
  await expect(
    page.getByText('Showing loaded activity. Load more to continue the journey.', { exact: false }),
  ).toBeVisible();
  // Capture the first page groups without hundreds of fixture rows below them.
  for (const theme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'ab-theme', value: theme, url: base }]);
    await open();
    await page.screenshot({ path: `${dir}/${theme}.png`, fullPage: false });
  }
  await page.getByRole('button', { name: 'Load more activity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more activity', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('button.journey-node')).toHaveCount(205);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Activity events', exact: true }).getByRole('listitem'),
  ).toHaveCount(205);
  await page.getByRole('button', { name: 'Journey', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Clicked an element', exact: true }).nth(2).click();
  await expect(page.locator('.journey-detail')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Clicked an element', exact: true }).nth(2).click();
  await page.getByRole('button', { name: 'Journey', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/mobile.png`, fullPage: false });
  for (const [locale, label] of [
    ['da', 'Trin i besøget'],
    ['de', 'Besuchsschritte'],
  ]) {
    await context.addCookies([{ name: 'ab-language', value: locale!, url: base }]);
    await page.goto(url);
    await page.locator(`[id="visit-${session}"]`).click();
    await expect(page.getByRole('list', { name: label!, exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
  console.log(
    'PASS journey graph, repeated pages, keyboard details, pagination, timeline, mobile long content, light/dark and DA/DE localization.',
  );
} catch (error) {
  console.log('Page:', page.url(), (await page.locator('body').innerText()).slice(0, 2000));
  await page.screenshot({ path: `${dir}/failure.png`, fullPage: false });
  throw error;
} finally {
  await browser.close();
  if (owner) await db.query('delete from "user" where id=$1', [owner]);
  await db.end();
}
