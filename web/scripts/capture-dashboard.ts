import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { ingest, type EventMessage } from '../tests/fixtures/queued-events';
import { createHash } from 'node:crypto';
process.chdir(new URL('../..', import.meta.url).pathname);
const hash = async (...v: string[]) => createHash('sha256').update(v.join(':')).digest('hex');
const base = 'http://localhost:3073';
if (
  !process.env.TEST_DATABASE_HOST ||
  new URL(process.env.DATABASE_URL!).hostname !== process.env.TEST_DATABASE_HOST
)
  throw Error('Isolated test database required.');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: 'reduce',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
await context.route('https://usedatix.com/tracker.js', (r) => r.fulfill({ body: '' }));
const page = await context.newPage();
const email = `browser-datix-preview-${crypto.randomUUID()}@example.com`;
let ownerId = '',
  siteId = '';
try {
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: { name: 'Sam', email, password: `Qa-${crypto.randomUUID()}!` },
  });
  expect(signup.status()).toBe(200);
  ownerId = (await signup.json()).user.id;
  await seedPro(client, ownerId);
  const site = await context.request.post(`${base}/api/sites`, {
    headers: { Origin: base },
    data: { name: 'Forest Studio', domain: 'forest-studio.example' },
  });
  expect(site.status()).toBe(201);
  siteId = (await site.json()).site.id;
  const items: EventMessage[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let day = 0; day < 30; day++) {
    const receivedAt = new Date(Date.parse(today) - (29 - day) * 86400000 + 3600000).toISOString();
    const count = 12 + day;
    for (let index = 0; index < count; index++)
      items.push({
        version: 1,
        siteId,
        id: crypto.randomUUID(),
        receivedAt,
        day: receivedAt.slice(0, 10),
        type: day % 5 === 0 ? 'event' : 'pageview',
        name: day % 5 === 0 ? 'contact' : '',
        path: ['/', '/work', '/about', '/contact'][index % 4]!,
        referrer: ['', 'google.com', 'instagram.com', 'linkedin.com'][index % 4]!,
        country: ['DK', 'US', 'GB', 'DE'][index % 4]!,
        device: index % 3 === 0 ? 'mobile' : 'desktop',
        visitor: await hash('browser-qa-fixture', `${day}:${index % 15}`),
      });
  }
  for (let index = 0; index < items.length; index += 100)
    await ingest(client, items.slice(index, index + 100));

  await client.query('UPDATE "user" SET email=$2 WHERE id=$1', [
    ownerId,
    'sam@forest-studio.example',
  ]);
  await page.goto(`${base}/site/${siteId}/${siteId}/overview`);
  await expect(
    page.getByRole('heading', { name: 'forest-studio.example', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Pageviews/ })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'ab-theme', value: theme, url: base }]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Top pages', exact: true })).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `web/artifacts/datix-dashboard-${theme}.png`, fullPage: true });
    console.log(theme, await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  }
} finally {
  if (ownerId) await cleanupPro(client, [ownerId]);
  if (ownerId) await client.query('delete from "user" where id=$1', [ownerId]);
  await client.end();
  await browser.close();
}
