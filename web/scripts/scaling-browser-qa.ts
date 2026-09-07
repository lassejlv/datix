import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
process.chdir(new URL('../..', import.meta.url).pathname);
const target = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  target.hostname !== process.env.TEST_DATABASE_HOST ||
  target.hostname === new URL(process.env.DATABASE_URL ?? '').hostname
)
  throw new Error('An explicitly matched isolated branch is required.');
const client = new Client({ connectionString: target.toString() });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const base = 'http://localhost:3057';
let user: string | undefined;
try {
  await client.connect();
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      name: 'Scaling browser QA',
      email: `scaling-browser-${crypto.randomUUID()}@example.com`,
      password: `Qa!${crypto.randomUUID()}`,
    },
  });
  expect(signup.status()).toBe(200);
  user = (await signup.json()).user.id;
  await seedPro(client, user!);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Scaling browser QA', domain: 'scaling-browser.example.com' },
  });
  expect(created.status()).toBe(201);
  const site = (await created.json()).site.id;
  await client.query(
    `INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor)
    SELECT $1,gen_random_uuid(),now()-interval '5 minutes',current_date,'pageview','','/visitor/'||n,'','DK','desktop',md5(n::text)||md5(n::text) FROM generate_series(1,55) n`,
    [site],
  );
  await client.query(
    `INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor)
    SELECT $1,gen_random_uuid(),now()-interval '1 minute'+n*interval '1 millisecond',current_date,'pageview','','/timeline/'||n,'','DK','desktop',repeat('a',64) FROM generate_series(1,205) n`,
    [site],
  );
  const page = await context.newPage();
  const errors: string[] = [];
  const pagination: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/sessions') && url.searchParams.has('cursor'))
      pagination.push(url.searchParams.has('session') ? 'activity' : 'visits');
  });
  await page.goto(`${base}/site/${site}/${site}/visitors`);
  const visits = page.getByRole('button', { name: /^Open session / });
  await expect(visits).toHaveCount(50, { timeout: 15000 });
  await page.getByRole('button', { name: 'Load more visits', exact: true }).click();
  await expect(visits).toHaveCount(56);
  await page.getByRole('button', { name: 'Open session aaaaaaaa', exact: true }).click();
  const events = page.getByRole('list', { name: 'Activity events' }).locator('li');
  await expect(events).toHaveCount(200);
  await page.getByRole('button', { name: 'Load more activity', exact: true }).click();
  await expect(events).toHaveCount(205);
  expect(pagination).toEqual(['visits', 'activity']);
  expect(new Set(await events.locator('h3').allTextContents()).size).toBe(205);
  await Bun.write(
    'web/artifacts/scaling/browser.json',
    JSON.stringify(
      { visits: 56, activityEvents: 205, cursorRequests: pagination, errors },
      null,
      2,
    ),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'web/artifacts/scaling/browser-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: 'web/artifacts/scaling/browser-mobile.png', fullPage: false });
  expect(errors).toEqual([]);
  console.log(
    'PASS real browser loaded all 56 visits and 205 activity events using cursors; desktop/mobile without overflow or page errors',
  );
} finally {
  if (user) {
    await cleanupPro(client, [user]);
    await client.query('DELETE FROM "user" WHERE id=$1', [user]);
  }
  await browser.close();
  await client.end();
}
