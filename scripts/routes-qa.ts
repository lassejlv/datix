import { chooseWorkspace } from './picker-helper';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const prod = process.argv.includes('--production');
const base = prod ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = process.env[prod ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL'];
if (
  !connectionString ||
  (prod && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw Error('Explicit matching database required');
const db = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const email = `routes-${crypto.randomUUID()}@example.com`,
  password = crypto.randomUUID();
const checks: string[] = [];
const pass = (s: string) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
const post = async (path: string, data: unknown) => {
  const r = await context.request.post(`${base}/api${path}`, { headers: { Origin: base }, data });
  expect(r.ok()).toBe(true);
  return r.json();
};
try {
  await db.connect();
  await page.goto(`${base}/signin`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(`${base}/signup`);
  await page.goBack();
  await expect(page).toHaveURL(`${base}/signin`);
  await expect(page.getByLabel('Email address')).toHaveValue(email);
  await page.goForward();
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await post('/auth/sign-up/email', { name: 'Routes QA', email, password });
  const a = (await post('/sites', { name: 'Routes A', domain: 'a.routes.example' })).site.id;
  const b = (await post('/sites', { name: 'Routes B', domain: 'b.routes.example' })).site.id;
  const path = (s: string, e: string, p: string) => `${base}/site/${s}/${e}/${p}`;
  await page.goto(path(a, a, 'overview'));
  await expect(page.getByLabel('Selected website')).toHaveAttribute('data-value', a);
  await page.getByRole('link', { name: 'Installation', exact: true }).click();
  await expect(page).toHaveURL(path(a, a, 'installation'));
  await page.getByRole('link', { name: 'Website settings', exact: true }).click();
  await expect(page).toHaveURL(path(a, a, 'settings'));
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  pass('Auth routes and dashboard links support browser back/forward');
  await page.getByRole('button', { name: 'Add environment', exact: true }).click();
  await page.getByLabel('Environment name', { exact: true }).last().fill('Staging');
  await page.locator('#new-environment-domain').fill('staging.routes.example');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add environment', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const env = new URL(page.url()).pathname.split('/')[3]!;
  expect(env).not.toBe(a);
  await expect(page).toHaveURL(path(a, env, 'installation'));
  await page.reload();
  await expect(page.getByLabel('Selected environment')).toHaveAttribute('data-value', env);
  await chooseWorkspace(page, 'website', b);
  await expect(page).toHaveURL(path(b, b, 'overview'));
  await chooseWorkspace(page, 'website', a);
  await expect(page).toHaveURL(path(a, env, 'overview'));
  await page.goto(`${base}/?site=${a}&environment=${env}&view=settings`);
  await expect(page).toHaveURL(path(a, env, 'settings'));
  await page.goto(`${base}/site/${a}`);
  await expect(page).toHaveURL(path(a, env, 'overview'));
  pass(
    'Environment creation, reload, site switching, legacy links and partial links resolve correctly',
  );
  const fresh = await browser.newContext();
  const login = await fresh.newPage();
  await login.goto(path(a, env, 'settings'));
  await login.getByLabel('Email address').fill(email);
  await login.getByLabel('Password', { exact: true }).fill(password);
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(login.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  await expect(login).toHaveURL(path(a, env, 'settings'));
  await fresh.close();
  await page.goto(path(a, crypto.randomUUID(), 'overview'));
  await expect(page.getByText('Website or environment unavailable', { exact: true })).toBeVisible();
  await page.goto(path(a, env, 'invalid'));
  await expect(page.getByRole('heading', { name: 'Nothing brewing here.' })).toBeVisible();
  await expect(page.getByLabel('Selected website')).toHaveCount(0);
  pass(
    'Unauthenticated deep links return to the requested page; missing and invalid routes show errors',
  );
  await page.goto(path(a, env, 'settings'));
  await page.getByRole('button', { name: 'Delete environment', exact: true }).click();
  await page.getByLabel('Type Staging to confirm').fill('Staging');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete environment', exact: true })
    .click();
  await expect(page).toHaveURL(path(a, a, 'settings'));
  await page.reload();
  await expect(page.getByLabel('Selected environment')).toHaveAttribute('data-value', a);
  pass('Deleting the selected environment replaces the URL with Production');
  expect(errors).toEqual([]);
  await mkdir('artifacts/routes', { recursive: true });
  await writeFile(
    `artifacts/routes/${prod ? 'production' : 'local'}.json`,
    JSON.stringify({ base, checks, errors, verifiedAt: new Date().toISOString() }, null, 2),
  );
} finally {
  await context.close();
  await browser.close();
  await db.query('delete from "user" where email=$1', [email]);
  await db.end();
}
