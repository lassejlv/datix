// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { seedPro, cleanupPro } from '../tests/fixtures/billing';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { ingest, type EventMessage } from '../tests/fixtures/queued-events';
import { createHash } from 'node:crypto';
const hash = async (...values: string[]) =>
  createHash('sha256').update(values.join(':')).digest('hex');
import { mkdir, writeFile } from 'node:fs/promises';
expect.configure({ timeout: 15000 });

const base = process.env.QA_BASE_URL ?? 'http://localhost:3000';
const suffix = crypto.randomUUID();
const email = `browser-${suffix}@example.com`;
const password = `browser-test-${crypto.randomUUID()}`;
const domain = 'forest-studio.example';
const client = new Client({ connectionString: process.env.DATABASE_URL });
const checks: string[] = [],
  errors: string[] = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  colorScheme: 'light',
  reducedMotion: 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'],
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && /Base UI|hydration|uncontrolled|React/.test(message.text()))
    errors.push(message.text());
});
let siteId = '';
let ownerId = '';
function passed(text: string) {
  checks.push(text);
  console.log(`PASS ${text}`);
}
try {
  await client.connect();
  await mkdir('web/artifacts', { recursive: true });
  await page.goto(`${base}/signin`);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Datix | Website analytics');
  await page.screenshot({ path: 'web/artifacts/sign-in-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'web/artifacts/sign-in-mobile.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'web/artifacts/sign-in-dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Sam - browser QA');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add your first website' })).toBeVisible();
  ownerId = (await (await context.request.get(`${base}/api/me`)).json()).user.id;
  await seedPro(client, ownerId);
  passed('Browser sign-up, password visibility, hydration, and onboarding');
  await page.getByRole('button', { name: 'Add your first website' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Add your first website' }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Forest Studio · QA');
  await page.getByLabel('Website domain').fill(`https://${domain}/`);
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByRole('link', { name: 'Install', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'web/artifacts/installation-desktop.png', fullPage: true });
  siteId = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('button', { name: 'Copy script', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check installation' })).toBeVisible();
  await page.getByRole('button', { name: 'Check installation' }).click();
  await expect(page.getByText('No pageview yet.', { exact: false })).toBeVisible();
  passed('Accessible setup dialog, hostname normalization, script copy, empty installation check');

  // Map the reserved QA hostname onto the Rust server. This executes the real
  // tracker in a browser and forwards API requests; no collection response is mocked.
  const tracking = await context.newPage();
  tracking.setDefaultTimeout(15000);
  const trackerErrors: string[] = [];
  tracking.on('pageerror', (error) => trackerErrors.push(error.message));
  tracking.on('response', (response) => {
    if (response.url().includes('/api/collect')) console.log('Tracker HTTP', response.status());
  });
  await tracking.route(`https://${domain}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname === '/work') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<html><head><title>QA website</title><script defer src="/tracker.js" data-site="${siteId}"></script></head><body><h1>QA tracker fixture</h1><button data-analytics-ignore onclick="history.pushState({}, '', '/work')">Work</button><button data-analytics-ignore onclick="window.simpleAnalytics.track('contact')">Contact</button></body></html>`,
      });
    } else {
      const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
        method: route.request().method(),
        headers: route.request().headers(),
        body: route.request().postData() ?? undefined,
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (url.pathname === '/api/collect')
        expect(JSON.parse(body.toString())).toEqual({ accepted: true });
      // Do not forward transfer/content encoding headers after fetch decodes the body.
      await route.fulfill({
        status: upstream.status,
        contentType: upstream.headers.get('content-type') ?? 'text/plain',
        body,
      });
    }
  });
  const firstEvent = tracking.waitForResponse(
    (response) => response.url().includes('/api/collect') && response.status() === 202,
  );
  await tracking.goto(`https://${domain}/`);
  await firstEvent;
  const secondEvent = tracking.waitForResponse(
    (response) => response.url().includes('/api/collect') && response.status() === 202,
  );
  await tracking.getByRole('button', { name: 'Work', exact: true }).click({ noWaitAfter: true });
  await secondEvent;
  const customEvent = tracking.waitForResponse(
    (response) => response.url().includes('/api/collect') && response.status() === 202,
  );
  await tracking.getByRole('button', { name: 'Contact', exact: true }).click({ noWaitAfter: true });
  await customEvent;
  expect(trackerErrors).toEqual([]);
  await tracking.close();
  await expect
    .poll(
      async () =>
        (await client.query('select count(*)::int as count from events where site_id=$1', [siteId]))
          .rows[0].count,
      { timeout: 30000 },
    )
    .toBe(3);
  await page.getByRole('button', { name: 'Check installation' }).click();
  await expect(page.getByText('Your script is working.', { exact: false })).toBeVisible();
  passed(
    'Real browser tracker: first page, History API navigation, custom event, Queue ingestion, and installation success',
  );

  // Synthetic traffic belongs only to this disposable QA account and is removed
  // below. It exercises real aggregation and gives screenshots varied data.
  const items: EventMessage[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let day = 0; day < 30; day++) {
    const receivedAt = new Date(Date.parse(today) - (29 - day) * 86400000 + 3600000).toISOString();
    const count = 1;
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
  await page.getByRole('button', { name: 'View dashboard' }).click();
  await expect(page.getByRole('heading', { name: domain, exact: true })).toBeVisible();
  await expect(page.getByText('Loading analytics…')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top pages', exact: true })).toBeVisible();
  await expect(page.getByText('Denmark', { exact: true })).toBeVisible();
  const chart = page.getByRole('group', { name: 'Daily traffic chart.', exact: false });
  const chartCanvas = page.getByTestId('traffic-chart').locator('canvas').first();
  await expect
    .poll(() =>
      chartCanvas.evaluate((canvas) => {
        const context = (canvas as HTMLCanvasElement).getContext('2d')!;
        const pixels = context.getImageData(
          0,
          0,
          (canvas as HTMLCanvasElement).width,
          (canvas as HTMLCanvasElement).height,
        ).data;
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted++;
        return painted;
      }),
    )
    .toBeGreaterThan(100);
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-slot=chart-tooltip]')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-slot=chart-tooltip]')).toContainText('Pageviews');
  await page.keyboard.press('End');
  await expect(page.locator('[data-slot=chart-tooltip]')).toContainText(
    new Date().toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot=chart-tooltip]')).not.toBeVisible();
  await page.keyboard.press('Tab');
  await page.screenshot({ path: 'web/artifacts/dashboard-desktop.png', fullPage: true });
  const firstMetric = page.getByRole('button', { name: 'Pageviews', exact: false });
  await expect(firstMetric).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await page.screenshot({ path: 'web/artifacts/dashboard-dark.png', fullPage: true });
  const theme = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(document.body).color,
  }));
  expect(theme.background).toBe('rgb(18, 18, 18)');
  expect(theme.ink).toBe('rgb(237, 237, 237)');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByLabel('Date range', { exact: true }).selectOption('7');
  await expect(page.getByText('Loading analytics…')).not.toBeVisible();
  await page.getByRole('button', { name: 'Daily visitors', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Daily visitors', exact: false })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Date range', { exact: true }).selectOption('custom');
  await expect(page.getByLabel('From date')).toBeVisible();
  await expect(chartCanvas).toBeVisible();
  await expect
    .poll(() =>
      chartCanvas.evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement;
        const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const columns = new Set<number>();
        for (let i = 3; i < pixels.length; i += 4)
          if (pixels[i]) columns.add(((i - 3) / 4) % c.width);
        return columns.size;
      }),
    )
    .toBe(3);
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-slot=chart-tooltip]')).toContainText(
    new Date().toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  );
  await page.keyboard.press('Tab');
  await page.getByLabel('From date').fill('');
  await expect(page.getByRole('alert')).toContainText('Choose a range');
  await expect(
    page.getByRole('button', { name: 'Pageviews', exact: false }).locator('strong'),
  ).toHaveText('-');
  await page.getByLabel('From date').fill(today);
  await expect(chartCanvas).toBeVisible();
  await expect
    .poll(() =>
      chartCanvas.evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement;
        const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const columns = new Set<number>();
        for (let i = 3; i < pixels.length; i += 4)
          if (pixels[i]) columns.add(((i - 3) / 4) % c.width);
        return columns.size;
      }),
    )
    .toBe(3);
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-slot=chart-tooltip]')).toContainText(
    new Date().toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  );
  await page.keyboard.press('Tab');
  await page.getByLabel('Date range', { exact: true }).selectOption('30');
  passed(
    'Real reports, Dither Kit canvas painting, keyboard chart inspection, metric switching, single-day marker, and invalid date ranges',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Loading analytics…')).not.toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Denmark', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'web/artifacts/dashboard-mobile.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'web/artifacts/dashboard-mobile-dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  await page.screenshot({ path: 'web/artifacts/settings-mobile.png', fullPage: true });
  await page.getByLabel('Website name', { exact: true }).fill('Forest Studio updated');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible();
  // Use an actual loopback HTTP server on a separate port and the unchanged tracker.
  const localServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        `<html><head><script defer src="${base}/tracker.js" data-site="${siteId}"></script></head><body><button data-analytics-ignore onclick="window.simpleAnalytics.track('localhost_test')">Local event</button></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  const localPage = await context.newPage();
  localPage.setDefaultTimeout(15000);
  localPage.on('pageerror', (error) => errors.push(error.message));
  try {
    const localUrl = `http://localhost:${localServer.port}/localhost-test`;
    const setting = page.getByRole('checkbox', {
      name: 'Allow localhost for testing',
      exact: true,
    });
    await expect(setting).not.toBeChecked();
    const rejected = localPage.waitForResponse((response) =>
      response.url().endsWith('/api/collect'),
    );
    await localPage.goto(localUrl);
    expect((await rejected).status()).toBe(403);
    await setting.click();
    await expect(setting).toBeChecked();
    await page.reload();
    await expect(setting).toBeChecked();
    const accepted = localPage.waitForResponse((response) =>
      response.url().endsWith('/api/collect'),
    );
    await localPage.reload();
    expect((await accepted).status()).toBe(202);
    console.log('Localhost pageview accepted');
    const localCustom = localPage.waitForResponse((response) =>
      response.url().endsWith('/api/collect'),
    );
    await localPage.getByRole('button', { name: 'Local event' }).click({ noWaitAfter: true });
    expect((await localCustom).status()).toBe(202);
    console.log('Localhost custom event accepted');
    await expect
      .poll(
        async () =>
          (
            await client.query(
              'select count(*)::int as count from events where site_id=$1 and path=$2',
              [siteId, '/localhost-test'],
            )
          ).rows[0].count,
        { timeout: 30000 },
      )
      .toBe(2);
    const breakdown = await context.request.get(
      `${base}/api/sites/${siteId}/breakdown?dimension=path&limit=100`,
    );
    expect((await breakdown.json()).data).toContainEqual({ value: '/localhost-test', count: 1 });
    await page.screenshot({ path: 'web/artifacts/localhost-settings-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('link', { name: 'Install', exact: true }).click();
    await expect(setting).toBeChecked();
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.screenshot({
      path: 'web/artifacts/localhost-installation-desktop.png',
      fullPage: true,
    });
    await setting.click();
    await expect(setting).not.toBeChecked();
    const revoked = localPage.waitForResponse((response) =>
      response.url().endsWith('/api/collect'),
    );
    await localPage.goto(localUrl.replace('/localhost-test', '/localhost-revoked'));
    expect((await revoked).status()).toBe(403);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(setting).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    passed(
      'Localhost toggle: default rejection, saved opt-in, real cross-port tracker and Queue/report ingestion, Installation sync, and revocation',
    );
  } finally {
    await localPage.close();
    localServer.stop(true);
  }
  await page.getByRole('button', { name: 'Pause collection' }).click();
  await expect(page.getByRole('button', { name: 'Resume collection' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume collection' }).click();
  await expect(page.getByRole('button', { name: 'Pause collection' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete website', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Delete website', exact: true }),
  ).toBeDisabled();
  await page.getByLabel(`Type ${domain} to confirm`).fill(domain);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete website', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Add your first website' })).toBeVisible();
  passed(
    'Light/dark rendering, keyboard and selected states, mobile navigation, rename, pause/resume, and guarded deletion',
  );
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add your first website' })).toBeVisible();
  passed('Browser sign-out, invalid credentials, and sign-in');
  expect(errors).toEqual([]);
  await writeFile(
    'web/artifacts/browser-qa.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        desktop: [1440, 1024],
        mobile: [390, 844],
        runtime: 'Chromium, Rust/Axum, Redis Streams, remote Neon',
        build: process.env.QA_BUILD ?? 'development',
        screenshotsContain:
          'Synthetic traffic for a disposable QA account, removed after this test',
        checks,
        browserErrors: errors,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await page.screenshot({ path: 'web/artifacts/browser-failure.png', fullPage: true });
  console.error('Browser state:', (await page.locator('body').innerText()).slice(0, 3500));
  throw error;
} finally {
  if (ownerId) await cleanupPro(client, [ownerId]);
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
  await browser.close();
}
