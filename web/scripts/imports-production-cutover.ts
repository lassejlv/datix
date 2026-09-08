// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';

const mode = process.argv[2];
if (!['prepare', 'verify', 'cleanup'].includes(mode ?? ''))
  throw new Error('Use prepare, verify, or cleanup.');
const base = 'https://analytics.beer';
const connectionString = process.env.PRODUCTION_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST
)
  throw new Error('Explicit matching production database is required.');
const dir = 'web/artifacts/imports-release-production';
const filename = `${dir}/fixture.json`;
type Fixture = {
  userId: string;
  email: string;
  password: string;
  site: string;
  storage: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>;
};
const client = new Client({ connectionString });
let fixture: Fixture | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const browser = await chromium.launch();
try {
  await mkdir(dir, { recursive: true });
  await client.connect();
  if (await Bun.file(filename).exists()) fixture = JSON.parse(await readFile(filename, 'utf8'));
  else if (mode !== 'prepare') throw new Error('No prepared cutover fixture exists.');
  const context = await browser.newContext({
    ...(fixture ? { storageState: fixture.storage } : {}),
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  const post = (path: string, data: unknown) =>
    context.request.post(`${base}/api${path}`, { headers: { origin: base }, data });
  if (mode === 'cleanup') {
    await cleanupPro(client, [fixture!.userId]);
    await client.query('delete from "user" where id=$1 and email=$2', [
      fixture!.userId,
      fixture!.email,
    ]);
    await unlink(filename);
    console.log(
      'PASS Removed the disposable cutover account, billing fixture, and saved login credentials',
    );
  } else {
    if (mode === 'prepare' && !fixture) {
      const email = `imports-release-cutover-${crypto.randomUUID()}@example.com`,
        password = `Qa!${crypto.randomUUID()}`;
      const signup = await post('/auth/sign-up/email', {
        name: 'Imports release cutover QA',
        email,
        password,
      });
      expect(signup.status()).toBe(200);
      const userId = (await signup.json()).user.id;
      fixture = { userId, email, password, site: '', storage: await context.storageState() };
      await writeFile(filename, JSON.stringify(fixture), { mode: 0o600 });
      await chmod(filename, 0o600);
      const created = await post('/sites', {
        name: 'Imports release cutover QA',
        domain: 'imports-release-cutover.example.com',
      });
      expect(created.status()).toBe(201);
      fixture.site = (await created.json()).site.id;
      await writeFile(filename, JSON.stringify(fixture), { mode: 0o600 });
      await seedPro(client, userId);
      const setting = await context.request.patch(
        `${base}/api/sites/${fixture.site}/environments/${fixture.site}`,
        { headers: { origin: base }, data: { allowLocalhost: true } },
      );
      expect(setting.status()).toBe(200);
    }
    const me = await context.request.get(`${base}/api/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).user.id).toBe(fixture!.userId);
    const ready = await context.request.get(`${base}/health/ready`);
    expect(ready.status()).toBe(200);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const path = mode === 'prepare' ? '/before-imports-release' : '/after-imports-release';
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><head><script defer src="${base}/tracker.js" data-site="${fixture!.site}"></script></head><body><h1>Cutover QA</h1><button data-analytics-ignore onclick="window.simpleAnalytics.track('imports-release_cutover')">Record event</button></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    const existing = Number(
      (
        await client.query('select count(*) n from events where site_id=$1 and path=$2', [
          fixture!.site,
          path,
        ])
      ).rows[0].n,
    );
    if (existing !== 2) {
      expect(existing).toBe(0);
      const tracked = await context.newPage();
      const first = tracked.waitForResponse((r) => r.url() === `${base}/api/collect`);
      await tracked.goto(`http://localhost:${server.port}${path}`);
      expect((await first).status()).toBe(202);
      const custom = tracked.waitForResponse((r) => r.url() === `${base}/api/collect`);
      await tracked.getByRole('button', { name: 'Record event' }).click();
      expect((await custom).status()).toBe(202);
      await expect
        .poll(
          async () =>
            Number(
              (
                await client.query('select count(*) n from events where site_id=$1 and path=$2', [
                  fixture!.site,
                  path,
                ])
              ).rows[0].n,
            ),
          { timeout: 45000 },
        )
        .toBe(2);
      await tracked.close();
    }
    const overview = await context.request.get(`${base}/api/sites/${fixture!.site}/overview`);
    expect(overview.status()).toBe(200);
    const report = await overview.json();
    expect(report.pageviews).toBe(mode === 'prepare' ? 1 : 2);
    const usage = await context.request.get(`${base}/api/usage`);
    expect(usage.status()).toBe(200);
    const allowance = await usage.json();
    expect(allowance.events.used).toBe(mode === 'prepare' ? 0.45 : 0.9);
    await page.goto(`${base}/site/${fixture!.site}/${fixture!.site}/overview`);
    await expect(
      page.getByRole('heading', { name: 'imports-release-cutover.example.com', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Loading analytics…')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Pageviews', exact: false })).toContainText(
      mode === 'prepare' ? '1' : '2',
    );
    await page.screenshot({ path: `${dir}/${mode}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: `${dir}/${mode}-mobile-dark.png`, fullPage: true });
    expect(errors).toEqual([]);
    if (mode === 'verify') {
      expect((await post('/auth/sign-out', {})).status()).toBe(200);
      expect((await context.request.get(`${base}/api/me`)).status()).toBe(401);
      const signin = await post('/auth/sign-in/email', {
        email: fixture!.email,
        password: fixture!.password,
      });
      expect(signin.status()).toBe(200);
      expect((await context.request.get(`${base}/api/me`)).status()).toBe(200);
    }
    const result = {
      verifiedAt: new Date().toISOString(),
      mode,
      sessionContinuity: true,
      publicTracker: true,
      exactCredits: allowance.events.used,
      pageviews: report.pageviews,
      responsive: true,
      browserErrors: errors,
    };
    await writeFile(`${dir}/${mode}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  server?.stop(true);
  await browser.close();
  await client.end();
}
