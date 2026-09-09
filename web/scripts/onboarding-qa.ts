// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const production = process.argv.includes('--production');
const base = production ? 'https://usedatix.com' : 'http://localhost:3000';
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
  permissions: ['clipboard-read', 'clipboard-write'],
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const email = `onboarding-${crypto.randomUUID()}@example.com`;
const dir = `web/artifacts/onboarding/${production ? 'production' : 'local'}`;
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
let fixture: ReturnType<typeof Bun.serve> | undefined;
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
  await page.goto(`${base}/signup`);
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  await page.screenshot({ path: `${dir}/signup.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/signup-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Your name', { exact: true }).fill('Sam');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID());
  await page.getByTestId('auth-submit').click();
  await expect(
    page.getByRole('heading', {
      name: 'Getting started',
    }),
  ).toBeVisible();
  await page.screenshot({ path: `${dir}/welcome.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/welcome-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/welcome-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Add your first website', exact: true }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Sam’s little studio');
  await page.getByLabel('Website domain').fill('https://onboarding.example.com');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await expect(page).toHaveURL(/\/setup$/);
  const setupUrl = page.url();
  const siteId = new URL(setupUrl).pathname.split('/')[2]!;
  await expect(page.getByRole('heading', { name: 'Connect your website' })).toBeVisible();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied for agent', exact: true })).toBeVisible();
  const agentPrompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(agentPrompt).toContain(`data-site="${siteId}"`);
  expect(agentPrompt).toContain('Keep this integration cookieless');
  expect(agentPrompt).toContain('Check installation');
  await page.getByRole('button', { name: 'Copy script', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    `data-site="${siteId}"`,
  );
  await page.getByRole('button', { name: 'Check installation', exact: true }).click();
  await expect(page.getByText('No pageview yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toHaveCount(0);
  await page.screenshot({ path: `${dir}/connect-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Explore dashboard first' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.goto(`${base}/dashboard`);
  await expect(page).toHaveURL(setupUrl);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect your website' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${dir}/connect.png`, fullPage: true });
  pass(
    'Signup, website creation, clipboard, honest pending state, skip and resume, mobile and dark rendering',
  );
  await page.getByText('Testing locally or tracking custom events?', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Allow localhost for testing', exact: true }).click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Allow localhost for testing',
      exact: true,
    }),
  ).toBeChecked();
  const script = await page.getByLabel('Tracking script', { exact: true }).innerText();
  expect(script).not.toContain('data-mode="sessions"');
  fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><html><head>${script}</head><body><h1>My first real visit</h1></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      ),
  });
  const visitor = await context.newPage();
  visitor.setDefaultTimeout(20000);
  console.log('Checking real tracker collection');
  const collected = visitor.waitForResponse(
    (r) => r.url().startsWith(`${base}/api/collect`) && r.request().method() === 'POST',
  );
  await visitor.goto(`http://127.0.0.1:${fixture.port}/hello`);
  const collection = await collected;
  expect(collection.status()).toBe(202);
  expect((await collection.json()).accepted).toBe(true);
  console.log('Collector accepted pageview; waiting for persistence');
  await expect
    .poll(
      async () =>
        (await (await context.request.get(`${base}/api/sites/${siteId}/installation`)).json())
          .receiving,
      { timeout: 120000, intervals: [5000] },
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Check installation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeFocused();
  await page.screenshot({ path: `${dir}/success.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/success-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/success-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(setupUrl);
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.goto(`${base}/dashboard`);
  await expect(page).toHaveURL(/\/overview$/);
  expect(errors).toEqual([]);
  pass(
    'Real tracker → collector → Queue → onboarding success, keyboard focus, and completed setup resume',
  );
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify({ base, checks, errors, verifiedAt: new Date().toISOString() }, null, 2),
  );
} finally {
  fixture?.stop(true);
  await context.close();
  await browser.close();
  await db.query('delete from "user" where email=$1', [email]);
  await db.end();
}
