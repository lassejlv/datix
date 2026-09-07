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
const db = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const email = `switcher-${crypto.randomUUID()}@example.com`;
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const dir = `artifacts/switchers/${production ? 'production' : 'local'}`;
const post = async (path: string, data: unknown) => {
  const r = await context.request.post(base + '/api' + path, { headers: { Origin: base }, data });
  expect(r.ok()).toBe(true);
  return r.json();
};
try {
  await db.connect();
  await mkdir(dir, { recursive: true });
  await post('/auth/sign-up/email', { name: 'Switcher QA', email, password: crypto.randomUUID() });
  const a = (await post('/sites', { name: 'North Studio', domain: 'north.switcher.example.com' }))
    .site;
  const b = (
    await post('/sites', { name: 'Studio Journal', domain: 'journal.switcher.example.com' })
  ).site;
  const env = (
    await post(`/sites/${a.id}/environments`, {
      name: 'Staging',
      domain: 'preview.switcher.example.com',
    })
  ).environment;
  await page.goto(`${base}/site/${a.id}/${a.id}/overview`);
  await expect(page.getByLabel('Selected website')).toHaveAttribute('data-value', a.id);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page
    .locator('[data-slot=sidebar-container]')
    .screenshot({ path: `${dir}/closed-dark.png` });
  await page.getByLabel('Selected website').click();
  await expect(page.locator('[data-slot=combobox-item]')).toHaveCount(2);
  await page.screenshot({ path: `${dir}/website-dark.png` });
  const triggerBox = await page.getByLabel('Selected website').boundingBox(),
    popupBox = await page.locator('[data-slot=combobox-popup]').boundingBox();
  expect(Math.abs(triggerBox!.width - popupBox!.width)).toBeLessThanOrEqual(2);
  const search = page.getByRole('combobox', { name: 'Search websites' });
  await search.fill('nothing-matches');
  await expect(page.getByText('No websites found.', { exact: true })).toBeVisible();
  await search.fill('journal.switcher');
  await expect(page.locator('[data-slot=combobox-item]')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Selected website')).toHaveAttribute('data-value', b.id);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.getByLabel('Selected website').click();
  await expect(page.locator('[data-slot=combobox-item]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Selected website')).toBeFocused();
  console.log(
    'PASS Search by name/domain, empty results, keyboard selection and focus restoration',
  );
  await page.getByLabel('Selected website').click();
  await page.getByRole('option', { name: 'North Studio', exact: false }).click();
  await page.getByLabel('Selected environment').click();
  await expect(page.getByRole('option', { name: 'Staging', exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/environment-dark.png` });
  await page.getByRole('option', { name: 'Staging', exact: true }).click();
  await expect(page).toHaveURL(`${base}/site/${a.id}/${env.id}/overview`);
  await page.reload();
  await expect(page.getByLabel('Selected environment')).toHaveAttribute('data-value', env.id);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByLabel('Selected website').click();
  await page.screenshot({ path: `${dir}/website-light.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByLabel('Selected website').click();
  await expect(page.locator('[data-slot=combobox-item]')).toHaveCount(2);
  await page.screenshot({ path: `${dir}/mobile-website.png` });
  await page.getByRole('combobox', { name: 'Search websites' }).fill('journal');
  await page.getByRole('option', { name: 'Studio Journal', exact: false }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`${base}/site/${b.id}/${b.id}/overview`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log('PASS Environment persistence, themed menus and nested mobile picker selection');
  await writeFile(
    `${dir}/verification.json`,
    JSON.stringify(
      {
        base,
        errors,
        verifiedAt: new Date().toISOString(),
        checks: [
          'Search and empty results',
          'Keyboard selection and focus restoration',
          'Environment URL and reload',
          'Light and dark popup visuals',
          'Mobile nested picker and drawer close',
        ],
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
