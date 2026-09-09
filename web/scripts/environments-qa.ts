// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chooseWorkspace } from './picker-helper';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const prod = process.argv.includes('--production');
const base = prod ? 'https://usedatix.com' : 'http://localhost:3000';
const connectionString = process.env[prod ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL']!;
if (prod && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw Error('Wrong database');
const client = new Client({ connectionString });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const email = `env-qa-${crypto.randomUUID()}@example.com`;
const dir = `web/artifacts/environments-${prod ? 'production' : 'local'}`;
const checks: string[] = [];
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
  await page.getByLabel('Your name', { exact: true }).fill('Environment QA');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(`Qa!${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Add your first website' }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Environment QA');
  await page.getByLabel('Website domain').fill('environment-qa.example.com');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByRole('link', { name: 'Install', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  const site = new URL(page.url()).pathname.split('/')[2]!;
  const selection = page.getByLabel('Selected environment', { exact: true });
  await expect(selection).toHaveAttribute('data-value', site);
  await page.getByRole('button', { name: 'Add environment', exact: true }).click();
  await page.getByLabel('Environment name', { exact: true }).fill('Staging');
  await page.locator('#new-environment-domain').fill('staging.environment-qa.example.com');
  await page
    .getByRole('checkbox', { name: 'Allow localhost for testing', exact: true })
    .last()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add environment', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const env = new URL(page.url()).pathname.split('/')[3]!;
  expect(env).not.toBe(site);
  expect(env).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator('body')).toContainText(`data-environment="${env}"`);
  await page.reload();
  await expect(selection).toHaveAttribute('data-value', env);
  pass(
    'Create custom Staging domain and localhost permission; snippet and selection survive reload',
  );
  fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new Response(
        `<html><head><script defer src="${base}/tracker.js" data-site="${site}" ${new URL(req.url).searchParams.has('staging') ? `data-environment="${env}"` : ''}></script></head><body>Environment fixture</body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      ),
  });
  const tracker = await context.newPage();
  const visit = async (path: string, status: number) => {
    const r = tracker.waitForResponse((r) => r.url() === `${base}/api/collect`);
    await tracker.goto(`http://localhost:${fixture!.port}${path}`);
    expect((await r).status()).toBe(status);
  };
  await visit('/same?staging', 202);
  await visit('/same', 403); // Production has not opted into localhost.
  await chooseWorkspace(page, 'environment', site);
  await page.getByRole('checkbox', { name: 'Allow localhost for testing', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Allow localhost for testing', exact: true }),
  ).toBeChecked();
  await visit('/same', 202); // Same path/tab remains independent of staging throttle.
  const overview = async (id: string) =>
    (await context.request.get(`${base}/api/sites/${site}/overview?environment=${id}`)).json();
  await expect
    .poll(async () => (await overview(env)).pageviews, {
      timeout: 60000,
      intervals: [1000, 2000, 4000],
    })
    .toBe(1);
  await expect
    .poll(async () => (await overview(site)).pageviews, {
      timeout: 60000,
      intervals: [1000, 2000, 4000],
    })
    .toBe(1);
  pass(
    'Actual browser tracker and Queue isolate same-path traffic; localhost permission is environment scoped',
  );
  await chooseWorkspace(page, 'environment', env);
  await page.getByRole('button', { name: 'Check installation' }).click();
  await expect(page.getByText('Your script is working.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'View dashboard' }).click();
  await expect(
    page.getByRole('button', { name: 'Pageviews', exact: false }).locator('strong'),
  ).toHaveText('1');
  await page.screenshot({ path: `${dir}/dashboard-desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/dashboard-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
      timeout: 5000,
    })
    .toBe(true);
  await page.screenshot({ path: `${dir}/dashboard-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Environment name', { exact: true }).fill('QA preview');
  await page.getByRole('button', { name: 'Save environment', exact: true }).click();
  await expect(selection).toContainText('QA preview');
  await page.getByRole('button', { name: 'Pause collection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume collection', exact: true })).toBeVisible();
  await visit('/paused?staging', 404);
  await visit('/production-active', 202);
  await page.screenshot({ path: `${dir}/settings.png`, fullPage: true });
  await page.reload();
  await expect(page.getByLabel('Environment name', { exact: true })).toHaveValue('QA preview');
  pass(
    'Reports render on desktop/mobile; custom rename persists and pause leaves Production active',
  );
  await page.getByRole('button', { name: 'Delete environment', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Delete environment', exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel('Type QA preview to confirm').fill('QA preview');
  await dialog.getByRole('button', { name: 'Delete environment', exact: true }).click();
  await expect(selection).toHaveAttribute('data-value', site);
  await expect.poll(async () => (await overview(site)).pageviews, { timeout: 60000 }).toBe(2);
  expect(
    (await client.query('select count(*)::int n from events where site_id=$1', [env])).rows[0].n,
  ).toBe(0);
  expect(
    (await context.request.get(`${base}/api/sites/${site}/overview?environment=${env}`)).status(),
  ).toBe(404);
  await page.reload();
  await expect(selection).toHaveAttribute('data-value', site);
  pass(
    'Typed deletion removes only the custom environment and its traffic, retaining Production and default selection',
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
