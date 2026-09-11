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
  reducedMotion: 'reduce',
});
const other = await browser.newContext();
const fresh = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(20000);
const email = `account-qa-${crypto.randomUUID()}@example.com`,
  password = crypto.randomUUID(),
  newPassword = crypto.randomUUID();
const dir = `web/artifacts/account/${production ? 'production' : 'local'}`;
const errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const pass = (message: string) => {
  console.log(`PASS ${message}`);
  checks.push(message);
};
const post = (ctx: typeof context, path: string, data: unknown, origin = base) =>
  ctx.request.post(`${base}/api${path}`, { headers: { Origin: origin }, data });
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  expect(
    (await post(context, '/auth/sign-up/email', { name: 'Account QA', email, password })).ok(),
  ).toBe(true);
  expect((await post(other, '/auth/sign-in/email', { email, password })).ok()).toBe(true);
  await page.goto(`${base}/dashboard`);
  const menu = page.getByRole('button', { name: 'Account menu', exact: true });
  await expect(menu).toBeVisible();
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Account settings', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await menu.click();
  await page.screenshot({ path: `${dir}/menu.png`, fullPage: true });
  await page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByLabel('Name', { exact: true }).fill('Updated Account');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved.', { exact: true })).toBeVisible();
  await expect(menu).toContainText('Updated Account');
  await page.reload();
  await expect(menu).toContainText('Updated Account');
  expect(
    (
      await post(context, '/auth/update-user', { name: 'Forbidden' }, 'https://foreign.example')
    ).status(),
  ).toBe(403);
  expect((await post(fresh, '/auth/update-user', { name: 'Unauthenticated' })).status()).toBe(401);
  pass(
    'Account menu keyboard focus, profile persistence, read-only email, authentication and origin checks',
  );
  await page.goto(`${base}/dashboard`);
  await menu.click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await page.locator('summary').filter({ hasText: 'Change password' }).click();
  await page.getByLabel('Current password', { exact: true }).fill('incorrect-password');
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(`${newPassword}x`);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('alert')).not.toContainText('do not match');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password changed. Other sessions are signed out.')).toBeVisible();
  expect((await other.request.get(`${base}/api/me`)).status()).toBe(401);
  expect((await context.request.get(`${base}/api/me`)).status()).toBe(200);
  expect((await post(fresh, '/auth/sign-in/email', { email, password })).status()).toBe(401);
  expect((await post(fresh, '/auth/sign-in/email', { email, password: newPassword })).ok()).toBe(
    true,
  );
  await page.screenshot({ path: `${dir}/settings.png`, fullPage: true });
  pass(
    'Password mismatch and wrong-current-password rejection, successful change, old password invalidated and other sessions revoked',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/account`);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await menu.click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Change password' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${dir}/mobile.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/mobile-dark.png`, fullPage: true });
  await page.goto(`${base}/dashboard`);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await menu.click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  expect((await context.request.get(`${base}/api/me`)).status()).toBe(401);
  expect(errors).toEqual([]);
  pass('Mobile navigation to account page, dark layout and account-menu sign-out');
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify({ base, checks, errors, verifiedAt: new Date().toISOString() }, null, 2),
  );
} finally {
  await browser.close();
  await db.query('delete from "user" where email=$1', [email]);
  await db.end();
}
