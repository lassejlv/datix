import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';

process.chdir(new URL('../..', import.meta.url).pathname);
const target = new URL(process.env.PRODUCTION_DATABASE_URL ?? '');
if (target.hostname !== process.env.PRODUCTION_DATABASE_HOST || target.username !== 'analytics_owner')
  throw new Error('Explicitly matched production owner connection required.');
const base = 'https://analytics.beer';
const client = new Client({ connectionString: target.toString() });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
  colorScheme: 'light',
});
const output = 'web/artifacts/imports-production';
const day = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
const from = day(10),
  to = day(9);
const files = {
  'imported_visitors.csv': `date,visitors,pageviews,bounces,visits,visit_duration\n${from},17,30,5,20,1200\n${to},12,25,3,14,800\n`,
  'imported_pages.csv': `date,hostname,page,visits,visitors,pageviews\n${from},import-browser.example.com,/,20,17,30\n${to},import-browser.example.com,/work,14,12,25\n`,
  'imported_sources.csv': `date,source,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,pageviews,visitors,visits,visit_duration,bounces\n${from},Google,google.com,,,,,,30,17,20,1200,5\n${to},Google,google.com,,,,,,25,12,14,800,3\n`,
  'imported_devices.csv': `date,device,visitors,visits,visit_duration,bounces,pageviews\n${from},Desktop,17,20,1200,5,30\n${to},Mobile,12,14,800,3,25\n`,
  'imported_locations.csv': `date,country,region,city,visitors,visits,visit_duration,bounces,pageviews\n${from},DK,DK-84,2618425,17,20,1200,5,30\n${to},DE,DE-BE,2950159,12,14,800,3,25\n`,
  'imported_custom_events.csv': `date,name,link_url,path,visitors,events\n${from},signup,,/,3,4\n${to},signup,,/work,2,3\n`,
};
let user: string | undefined;
const errors: string[] = [];
const checks: string[] = [];
try {
  await client.connect();
  await mkdir(output, { recursive: true });
  const archive = Bun.spawn(
    [
      'python3',
      '-c',
      'import json,sys,zipfile\nfiles=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as archive:\n for name,body in files.items(): archive.writestr(name,body)\n',
      `${output}/plausible-export.zip`,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  archive.stdin.write(JSON.stringify(files));
  archive.stdin.end();
  if (await archive.exited) throw new Error(await new Response(archive.stderr).text());
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      name: 'Imports browser QA',
      email: `imports-browser-${crypto.randomUUID()}@example.com`,
      password: `Qa!${crypto.randomUUID()}`,
    },
  });
  expect(signup.status(), await signup.text()).toBe(200);
  user = (await signup.json()).user.id;
  await seedPro(client, user!);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Forest Studio', domain: 'import-browser.example.com' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const site = (await created.json()).site.id;
  const route = `${base}/site/${site}/${site}/imports`;
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(route);
  await expect(page.getByRole('heading', { name: 'Import analytics', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Imports', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.screenshot({ path: `${output}/desktop-upload.png`, fullPage: true });
  await page.getByLabel('Analytics export file').setInputFiles(`${output}/plausible-export.zip`);
  await page.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review your import' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Import 2 days', exact: true })).toBeVisible();
  await expect(page.locator('#import-review-title').locator('..')).toContainText('55');
  const before = await context.request.get(
    `${base}/api/sites/${site}/overview?from=${from}&to=${to}`,
  );
  expect((await before.json()).pageviews).toBe(0);
  await page.screenshot({ path: `${output}/desktop-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Import 2 days', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '2 days imported from Plausible' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'View report', exact: true })).toBeVisible();
  checks.push('Real ZIP upload, read-only preview, commit, history and focus');
  await page.getByRole('button', { name: 'View report', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`overview\\?from=${from}&to=${to}`));
  await expect(page.getByRole('button', { name: /Pageviews/ })).toContainText('55');
  await expect(page.getByRole('button', { name: /Daily visitors/ })).toContainText('29');
  await expect(page.getByText('Includes 2 days of imported history')).toBeVisible();
  const report = await context.request.get(
    `${base}/api/sites/${site}/overview?from=${from}&to=${to}`,
  );
  const totals = await report.json();
  expect([totals.pageviews, totals.dailyUniqueVisitors, totals.customEvents]).toEqual([55, 29, 7]);
  for (const [dimension, values] of Object.entries({
    path: ['/', '/work'],
    referrer: ['google.com'],
    country: ['DK', 'DE'],
    device: ['desktop', 'mobile'],
    event: ['signup'],
  })) {
    const response = await context.request.get(
      `${base}/api/sites/${site}/breakdown?from=${from}&to=${to}&dimension=${dimension}`,
    );
    expect((await response.json()).data.map((row: { value: string }) => row.value).sort()).toEqual(
      [...values].sort(),
    );
  }
  await page.screenshot({ path: `${output}/desktop-report.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: /Pageviews/ })).toContainText('55');
  checks.push('Overview, all five breakdowns, custom events, deep link and reload');
  await page.getByRole('link', { name: 'Imports', exact: true }).click();
  await page.getByLabel('Analytics export file').setInputFiles(`${output}/plausible-export.zip`);
  await page.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'already imported' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import 2 days', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Google Analytics 4', exact: false }).click();
  await page.getByLabel('This export contains only my website').check();
  await page.getByLabel('Analytics export file').setInputFiles({
    name: 'ga4.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Date,Views,Total users\n${day(20).replaceAll('-', '')},100,120\n`),
  });
  await page.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import 1 day', exact: true })).toBeVisible();
  await expect(page.locator('#import-review-title').locator('..')).toContainText(
    'Daily totals only',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: `${output}/mobile-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Import 1 day', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '1 day imported from Google Analytics 4' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: `${output}/mobile-history.png`, fullPage: true });
  checks.push(
    'Duplicate ZIP is prevented; GA4 daily CSV preserves total users greater than views; mobile/dark layout',
  );
  const remove = page.getByRole('button', { name: new RegExp(`Remove Google Analytics 4 import`) });
  await remove.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(remove).toBeFocused();
  await remove.click();
  await page.getByRole('button', { name: 'Remove import', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(remove).toHaveCount(0);
  const remaining = await context.request.get(
    `${base}/api/sites/${site}/environments/${site}/imports`,
  );
  expect((await remaining.json()).imports).toHaveLength(1);
  const usage = await context.request.get(`${base}/api/usage`);
  expect((await usage.json()).events.used).toBe(0);
  checks.push(
    'Remove dialog cancellation restores focus; confirmed removal preserves other imports and billing stays zero',
  );
  expect(errors).toEqual([]);
  await Bun.write(
    `${output}/verification.json`,
    JSON.stringify({ checks, errors, totals }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  if (user) {
    await cleanupPro(client, [user]);
    await client.query('DELETE FROM "user" WHERE id=$1', [user]);
  }
  await browser.close();
  await client.end();
}
