// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { ingest, type EventMessage } from '../tests/fixtures/queued-events';
const production = process.argv.includes('--production');
const base = production
  ? 'https://usedatix.com'
  : (process.env.QA_BASE_URL ?? 'http://localhost:3000');
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL'];
if (
  !connectionString ||
  (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw Error('Explicit matching database required');
const db = new Client({ connectionString });
const browser = await chromium.launch();
const owner = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const secondSession = await browser.newContext();
const stranger = await browser.newContext();
const anon = await browser.newContext();
const page = await owner.newPage();
page.setDefaultTimeout(20000);
const email = `delete-qa-${crypto.randomUUID()}@example.com`,
  otherEmail = `delete-keep-${crypto.randomUUID()}@example.com`,
  password = crypto.randomUUID();
const dir = `web/artifacts/account-delete/${production ? 'production' : 'local'}`;
const errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const post = (context: typeof owner, path: string, data: unknown, origin = base) =>
  context.request.post(`${base}/api${path}`, { headers: { Origin: origin }, data });
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  const signup = await post(owner, '/auth/sign-up/email', { name: 'Delete QA', email, password });
  expect(signup.ok()).toBe(true);
  const userId = (await signup.json()).user.id;
  await seedPro(db, userId);
  expect((await post(secondSession, '/auth/sign-in/email', { email, password })).ok()).toBe(true);
  const otherSignup = await post(stranger, '/auth/sign-up/email', {
    name: 'Keep QA',
    email: otherEmail,
    password: crypto.randomUUID(),
  });
  expect(otherSignup.ok()).toBe(true);
  const otherUserId = (await otherSignup.json()).user.id;
  const created = await post(owner, '/sites', {
    name: 'Delete fixture',
    domain: 'delete-qa.example.com',
  });
  expect(created.ok()).toBe(true);
  const site = (await created.json()).site.id;
  const extra = await post(owner, `/sites/${site}/environments`, { name: 'Staging' });
  expect(extra.ok()).toBe(true);
  const environmentId = (await extra.json()).environment.id;
  const keepSite = (
    await (
      await post(stranger, '/sites', { name: 'Keep fixture', domain: 'keep-qa.example.com' })
    ).json()
  ).site.id;
  const now = new Date().toISOString();
  const events: EventMessage[] = [site, environmentId].map((id) => ({
    version: 3,
    siteId: site,
    environmentId: id,
    id: crypto.randomUUID(),
    receivedAt: now,
    day: now.slice(0, 10),
    type: 'pageview',
    name: '',
    path: '/',
    referrer: '',
    country: 'DK',
    device: 'desktop',
    visitor: 'a'.repeat(64),
    activity: {
      sessionKey: 'b'.repeat(64),
      visitorKey: 'c'.repeat(64),
      kind: 'pageview',
      browser: 'Chrome',
      os: 'macOS',
      details: {
        viewportWidth: 1440,
        viewportHeight: 900,
        screenWidth: 1440,
        screenHeight: 900,
        language: 'en',
      },
    },
  }));
  expect((await ingest(db, events)).inserted).toBe(2);
  for (const [table, column] of [
    ['events', 'site_id'],
    ['daily_visitors', 'site_id'],
    ['daily_stats', 'site_id'],
    ['activity_events', 'environment_id'],
  ]) {
    expect(
      (
        await db.query(`select count(*)::int n from ${table} where ${column}=any($1::uuid[])`, [
          [site, environmentId],
        ])
      ).rows[0].n,
    ).toBeGreaterThan(0);
  }
  expect((await post(owner, '/auth/delete-user', {})).status()).toBe(400);
  expect((await post(owner, '/auth/delete-user', { password, userId: otherUserId })).status()).toBe(
    400,
  );
  expect(
    (await post(owner, '/auth/delete-user', { password }, 'https://foreign.example')).status(),
  ).toBe(403);
  expect((await post(anon, '/auth/delete-user', { password })).status()).toBe(401);
  await page.goto(`${base}/site/${site}/${site}/overview`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Delete account' }).click();
  await expect(page.getByText('Permanently removes your account', { exact: false })).toBeVisible();
  await page.getByLabel('Confirm your password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await owner.request.get(`${base}/api/me`)).status()).toBe(200);
  await page.getByLabel('Confirm your password').fill(password);
  await page.screenshot({ path: `${dir}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await page.locator('summary').filter({ hasText: 'Delete account' }).click();
  await page.getByLabel('Confirm your password').fill(password);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/mobile-dark.png`, fullPage: true });
  await cleanupPro(db, [userId]);
  await page.getByRole('button', { name: 'Permanently delete account' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  expect((await owner.request.get(`${base}/api/me`)).status()).toBe(401);
  expect((await secondSession.request.get(`${base}/api/me`)).status()).toBe(401);
  expect((await post(anon, '/auth/sign-in/email', { email, password })).status()).toBe(401);
  for (const table of ['user', 'session', 'account']) {
    const column = table === 'user' ? 'id' : 'user_id';
    expect(
      (await db.query(`select count(*)::int n from "${table}" where ${column}=$1`, [userId]))
        .rows[0].n,
    ).toBe(0);
  }
  expect(
    (await db.query('select count(*)::int n from sites where owner_id=$1', [userId])).rows[0].n,
  ).toBe(0);
  expect(
    (await db.query('select count(*)::int n from environments where site_id=$1', [site])).rows[0].n,
  ).toBe(0);
  for (const [table, column] of [
    ['events', 'site_id'],
    ['daily_visitors', 'site_id'],
    ['daily_stats', 'site_id'],
    ['activity_events', 'environment_id'],
  ]) {
    expect(
      (
        await db.query(`select count(*)::int n from ${table} where ${column}=any($1::uuid[])`, [
          [site, environmentId],
        ])
      ).rows[0].n,
    ).toBe(0);
  }
  expect((await ingest(db, events)).inserted).toBe(0);
  expect((await stranger.request.get(`${base}/api/sites/${keepSite}`)).status()).toBe(200);
  expect((await stranger.request.get(`${base}/api/me`)).status()).toBe(200);
  expect(errors).toEqual([]);
  checks.push(
    'Password required, wrong-password/origin/unauthenticated/foreign-ID rejection',
    'Mobile deletion signs out all sessions, prevents login, cascades account/sites/environments/all analytics, and ignores delayed events',
    'Other account and website preserved',
  );
  console.log('PASS ' + checks.join('\nPASS '));
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify({ base, checks, errors, verifiedAt: new Date().toISOString() }, null, 2),
  );
} finally {
  await browser.close();
  await db.query(
    'delete from billing_customers where customer_id in (select \'qa-billing-\' || id from "user" where email=any($1::text[]))',
    [[email, otherEmail]],
  );
  await db.query('delete from "user" where email=any($1::text[])', [[email, otherEmail]]);
  await db.end();
}
