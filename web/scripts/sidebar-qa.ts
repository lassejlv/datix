// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chooseWorkspace } from './picker-helper';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
const production = process.argv.includes('--production');
const base = production ? 'https://analytics.beer' : 'http://localhost:3000';
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL'];
if (
  !connectionString ||
  (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw Error('Explicit matching database required');
const client = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const email = `sidebar-qa-${crypto.randomUUID()}@example.com`;
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
const dir = `web/artifacts/sidebar/${production ? 'production' : 'local'}`;
try {
  await client.connect();
  await mkdir(dir, { recursive: true });
  await post('/auth/sign-up/email', {
    name: 'Sidebar verification',
    email,
    password: crypto.randomUUID(),
  });
  const site = (await post('/sites', { name: 'North Studio', domain: 'sidebar-qa.example.com' }))
    .site;
  const env = (
    await post(`/sites/${site.id}/environments`, {
      name: 'Staging',
      domain: 'staging.sidebar-qa.example.com',
    })
  ).environment;
  await page.goto(`${base}/site/${site.id}/${site.id}/overview`);
  await expect(
    page.getByRole('button', { name: 'Pageviews', exact: false }).locator('strong'),
  ).toHaveText('0', { timeout: 20000 });
  await expect(page.locator('[data-slot=sidebar-container]')).toBeVisible();
  const nav = page.getByRole('link', { name: 'Overview', exact: true });
  await expect(nav).toHaveAttribute('aria-current', 'page');
  const activeFill = await nav.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(activeFill).not.toBe('rgba(0, 0, 0, 0)');
  const install = page.getByRole('link', { name: 'Install', exact: true });
  await install.hover();
  await expect
    .poll(() => install.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  const hoverFill = await install.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hoverFill).not.toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  await nav.focus();
  const ring = await nav.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe('none');
  await page.screenshot({ path: `${dir}/desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.locator('[data-slot=sidebar][data-state]')).toHaveAttribute(
    'data-state',
    'collapsed',
  );
  await page.keyboard.press('Control+b');
  await expect(page.locator('[data-slot=sidebar][data-state]')).toHaveAttribute(
    'data-state',
    'expanded',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${dir}/dark.png`, fullPage: true });
  pass('Desktop Coss sidebar, active state, hover, keyboard focus, collapse and keyboard shortcut');
  for (const width of [768, 800, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('[data-slot=sidebar-container]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/mobile.png`, fullPage: true });
  const open = async () => {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect
      .poll(() => page.getByRole('dialog').evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');
  };
  await open();
  await page.screenshot({ path: `${dir}/mobile-sidebar.png` });
  await page.getByRole('button', { name: 'Close navigation' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  await open();
  await chooseWorkspace(page, 'environment', env.id);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`${base}/site/${site.id}/${env.id}/overview`);
  await open();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: `${dir}/mobile-settings.png`, fullPage: true });
  pass('Mobile drawer traps and restores focus, Escape closes, selections and page links close it');
  await open();
  await page.getByLabel('Selected environment').click();
  await page.getByRole('button', { name: 'Add environment', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByLabel('Environment name', { exact: true }).last().fill('Preview');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add environment', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  await open();
  await page.getByLabel('Selected website').click();
  await page.getByRole('button', { name: 'Add a website', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByLabel('Website name', { exact: true }).fill('Studio Journal');
  await page.getByLabel('Website domain').fill('journal.sidebar-qa.example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Add website', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await open();
  expect(
    await page.getByRole('dialog').evaluate((el) => getComputedStyle(el).transitionProperty),
  ).toBe('none');
  await page.screenshot({ path: `${dir}/mobile-sidebar-dark.png` });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await open();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${base}/signin`);
  pass(
    'Add website, environment and sign out remain reachable on mobile; dark mode and reduced motion work',
  );
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify(
      { base, checks, errors, activeFill, hoverFill, ring, verifiedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
}
