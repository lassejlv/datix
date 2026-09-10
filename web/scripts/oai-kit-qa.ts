// UI interaction acceptance using isolated browser fixtures. Never touches a database.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw Error('UI fixtures require localhost');
const dir = 'web/artifacts/oai-kit';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch();
const checks: string[] = [];
const errors: string[] = [];
const unexpected: string[] = [];
const today = new Date().toISOString().slice(0, 10);
const at = `${today}T10:30:00Z`;
const pass = (label: string) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};

async function capture(page: Page, options: Parameters<Page['screenshot']>[0]) {
  await expect(page.locator('[data-starting-style]:visible')).toHaveCount(0);
  return page.screenshot({ ...options, animations: 'disabled' });
}

async function fixtures(context: BrowserContext) {
  const user = { id: 'ui-owner', name: 'Sam Taylor', email: 'sam@example.com' };
  const environment = {
    id: '11111111-1111-4111-8111-111111111111',
    siteId: '11111111-1111-4111-8111-111111111111',
    name: 'Production',
    domain: 'northstudio.example',
    enabled: true,
    allowLocalhost: false,
    trackingMode: 'cookieless',
    createdAt: at,
    featureSettings: { goals: true, errors: true, webVitals: true, geography: true, pulse: true },
  };
  const site = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: user.id,
    name: 'North Studio',
    domain: environment.domain,
    enabled: true,
    allowLocalhost: false,
    creditBudget: null,
    createdAt: at,
    environments: [
      environment,
      {
        ...environment,
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Staging',
        domain: 'staging.northstudio.example',
      },
    ],
  };
  const state = { failSave: false, signedIn: true, site, environment, user };
  const session = {
    id: 'session-1',
    visitorKey: 'visitor-12345678',
    daily: true,
    startedAt: at,
    lastSeenAt: at,
    pageviews: 4,
    clicks: 3,
    events: 8,
    activeSeconds: 124,
    entryPath: '/journal/designing-for-everyday-life',
    country: 'DK',
    device: 'desktop',
  };
  await context.route('https://usedatix.com/**', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api', '');
    const method = req.method();
    let result: unknown;
    let status = 200;
    if (path === '/preferences') result = { locale: 'en', theme: 'system' };
    else if (path === '/me') {
      result = state.signedIn ? { user } : { error: { message: 'Unauthorized' } };
      if (!state.signedIn) status = 401;
    } else if (path === '/sites' && method === 'GET') result = { sites: [site] };
    else if (path === '/usage')
      result = {
        plan: { name: 'Basic', trial: false, eventLimit: 100000, websiteLimit: 10 },
        period: { start: `${today}T00:00:00Z`, end: '2026-12-01T00:00:00Z' },
        events: { used: 24810, remaining: 75190 },
        paused: false,
        pauseReason: null,
        websites: [{ ...site, events: 24810, paused: false, pauseReason: null }],
        protection: {
          since: at,
          blocked: 42,
          reasons: [{ reason: 'automation', blocked: 42 }],
          lastBlockedAt: at,
          learning: 0,
          learned: 1,
        },
      };
    else if (path === '/billing') result = { hasCustomer: true };
    else if (path === '/billing/sync') result = { success: true };
    else if (path === '/auth/update-user') {
      if (state.failSave) {
        status = 500;
        result = { error: { message: 'Something went wrong. Please try again.' } };
      } else {
        Object.assign(user, req.postDataJSON());
        result = { success: true };
      }
    } else if (path === '/sites/11111111-1111-4111-8111-111111111111' && method === 'PATCH') {
      Object.assign(site, req.postDataJSON());
      result = { site };
    } else if (
      path ===
        '/sites/11111111-1111-4111-8111-111111111111/environments/11111111-1111-4111-8111-111111111111' &&
      method === 'PATCH'
    ) {
      if (state.failSave) {
        status = 500;
        result = { error: { message: 'Something went wrong. Please try again.' } };
      } else {
        Object.assign(environment, req.postDataJSON());
        result = { environment };
      }
    } else if (path.endsWith('/installation')) result = { receiving: true, lastReceivedAt: at };
    else if (path.endsWith('/overview'))
      result = { pageviews: 24810, dailyUniqueVisitors: 8932, customEvents: 1624 };
    else if (path.endsWith('/timeseries'))
      result = {
        data: Array.from({ length: 30 }, (_, i) => ({
          day: new Date(Date.parse(today) - (29 - i) * 86400000).toISOString().slice(0, 10),
          pageviews: 420 + ((i * 67) % 920),
          dailyUniqueVisitors: 180 + ((i * 29) % 350),
          customEvents: 18 + ((i * 7) % 80),
        })),
      };
    else if (path.endsWith('/breakdown')) {
      const values: Record<string, string[]> = {
        path: ['/', '/journal', '/work', '/about'],
        referrer: ['google.com', 'github.com', '', 'news.ycombinator.com'],
        country: ['DK', 'DE', 'US', 'GB'],
        device: ['desktop', 'mobile', 'tablet'],
        event: ['signup', 'download', 'contact'],
      };
      result = {
        data: (values[url.searchParams.get('dimension') ?? 'path'] ?? []).map((value, i) => ({
          value,
          count: 3250 - i * 580,
        })),
      };
    } else if (path.endsWith('/sessions'))
      result = url.searchParams.has('session')
        ? {
            events: [
              {
                id: 'ev1',
                receivedAt: at,
                occurredAt: at,
                kind: 'pageview',
                name: '',
                path: '/',
                browser: 'Chrome',
                os: 'macOS',
                device: 'desktop',
                country: 'DK',
                referrer: 'google.com',
                details: {},
              },
              {
                id: 'ev2',
                receivedAt: at,
                occurredAt: at,
                kind: 'click',
                name: '',
                path: '/',
                browser: 'Chrome',
                os: 'macOS',
                device: 'desktop',
                country: 'DK',
                referrer: '',
                details: { target: 'View our work' },
              },
            ],
            hasMore: false,
            nextOffset: 2,
          }
        : {
            sessions: [session],
            summary: { sessions: 824, visitors: 612, averageActiveSeconds: 124, clicks: 1635 },
            hasMore: false,
            nextOffset: 1,
          };
    else if (path.endsWith('/imports')) result = { imports: [] };
    else if (path.endsWith('/features/goals'))
      result = {
        goals: [
          {
            id: 'g1',
            name: 'Newsletter signup',
            matchType: 'event',
            matchValue: 'signup',
            conversions: 86,
            visitors: 72,
          },
        ],
        visitors: 1200,
      };
    else if (path.endsWith('/features/errors'))
      result = {
        items: [
          {
            fingerprint: 'error1',
            message: 'Failed to load image',
            source: 'gallery.js',
            stack: 'Error: Failed to load image\n  at loadImage (gallery.js:42:8)',
            path: '/work',
            occurrences: 12,
            visitors: 8,
            lastSeen: at,
            resolved: false,
          },
        ],
      };
    else if (path.endsWith('/features/web-vitals'))
      result = {
        items: [
          { name: 'LCP', device: 'desktop', samples: 850, p75: 1840 },
          { name: 'INP', device: 'desktop', samples: 640, p75: 125 },
          { name: 'CLS', device: 'desktop', samples: 850, p75: 0.04 },
        ],
      };
    else if (path.endsWith('/features/pulse'))
      result = {
        monitor: {
          url: 'https://northstudio.example',
          hasWebhook: true,
          state: 'up',
          checkedAt: at,
          latencyMs: 142,
          statusCode: 200,
          error: null,
        },
        summary: { checks: 1440, uptime: 99.98, uptime24h: 100 },
        checks: Array.from({ length: 40 }, (_, i) => ({
          checkedAt: new Date(Date.parse(at) - i * 60000).toISOString(),
          available: i !== 8,
          statusCode: i === 8 ? 503 : 200,
          latencyMs: 142 + i,
        })),
        alert: null,
      };
    else if (path.endsWith('/features/globe'))
      result = {
        active: 24,
        countries: [
          { code: 'DK', visitors: 248 },
          { code: 'DE', visitors: 192 },
          { code: 'US', visitors: 164 },
        ],
        recent: [{ id: 'g1', country: 'DK', path: '/journal', at, name: null, type: 'pageview' }],
        referrers: [{ value: 'google.com', count: 180 }],
        devices: [{ value: 'desktop', count: 420 }],
      };
    else {
      unexpected.push(`${method} ${path}`);
      status = 404;
      result = { error: { message: `Unhandled UI fixture: ${path}` } };
    }
    await route.fulfill({ status, json: result });
  });
  return state;
}

try {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      permissions: ['clipboard-read', 'clipboard-write'],
      reducedMotion: 'reduce',
    });
    const state = await fixtures(context);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /Base UI|React|hydration|uncontrolled/.test(message.text()))
        errors.push(message.text());
    });
    for (const route of process.argv.includes('--interactions-only')
      ? []
      : [
          'overview',
          'visitors',
          'installation',
          'imports',
          'settings',
          'goals',
          'errors',
          'web-vitals',
          'pulse',
          'globe',
        ]) {
      await page.goto(
        `${base}/site/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111/${route}`,
      );
      await expect(page.locator('[data-slot="sidebar-container"]')).toBeVisible();
      await expect(page.locator('h1').last()).toBeVisible();
      await capture(page, { path: `${dir}/${theme}-${route}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    if (!process.argv.includes('--interactions-only'))
      pass(`${theme}: ten workspace pages render without horizontal overflow`);
    if (process.argv.includes('--screenshots-only')) {
      await context.close();
      continue;
    }
    const path = `${base}/site/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111111`;
    try {
      await page.goto(`${path}/overview`);
      const range = page.getByRole('combobox', { name: 'Date range', exact: true });
      await range.click();
      await expect(page.getByRole('option', { name: 'Last 30 days' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await capture(page, { path: `${dir}/${theme}-select.png` });
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('From date')).toBeVisible();
      await expect(range).toBeFocused();
      await range.click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).not.toBeVisible();
      await expect(range).toBeFocused();
      pass(
        `${theme}: date select supports keyboard selection, custom dates and Escape focus return`,
      );
      const fromDate = page.getByRole('button', { name: 'From date', exact: true });
      const originalDate = await fromDate.getAttribute('data-value');
      await fromDate.click();
      await expect(page.getByRole('grid')).toBeVisible();
      await capture(page, { path: `${dir}/${theme}-calendar.png` });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('grid')).not.toBeVisible();
      await expect(fromDate).toHaveAttribute(
        'data-value',
        new Date(Date.parse(originalDate!) - 86400000).toISOString().slice(0, 10),
      );
      await expect(fromDate).toBeFocused();
      const toDate = page.getByRole('button', { name: 'To date', exact: true });
      await toDate.click();
      await expect(page.getByRole('grid')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await expect(toDate).toHaveAttribute('data-value', today);
      pass(
        `${theme}: calendar supports keyboard date selection, prevents future dates and restores focus`,
      );
      const refresh = page.getByRole('button', { name: 'Refresh analytics' });
      await refresh.focus();
      await expect(page.getByRole('tooltip')).toHaveText('Refresh analytics');
      expect(
        await page.getByRole('tooltip').evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe('rgb(175, 175, 175)');
      await capture(page, { path: `${dir}/${theme}-tooltip.png` });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).not.toBeVisible();
      pass(`${theme}: keyboard tooltip uses the Paper colors and dismisses with Escape`);

      await page.getByRole('combobox', { name: 'Selected website' }).click();
      await page.getByRole('combobox', { name: 'Search websites' }).fill('no-matching-site');
      await expect(page.getByText('No websites found.')).toBeVisible();
      await page.getByRole('combobox', { name: 'Search websites' }).fill('North');
      await expect(page.getByRole('option', { name: /North Studio/ })).toBeVisible();
      await page.keyboard.press('Escape');
      pass(`${theme}: searchable workspace menu supports empty results and recovery`);

      await page.goto(`${path}/settings`);
      await page.getByRole('tab', { name: 'Website', exact: true }).focus();
      await page.keyboard.press('End');
      const goals = page.getByRole('switch', { name: 'Goals', exact: true });
      await expect(goals).toBeChecked();
      await goals.click();
      await expect(goals).not.toBeChecked();
      await expect(page.locator('.kit-toast')).toContainText('Changes saved.');
      await capture(page, { path: `${dir}/${theme}-features-toast.png` });
      await page.getByRole('button', { name: 'Dismiss notification' }).click();
      await expect(page.locator('.kit-toast')).toHaveCount(0);
      state.failSave = true;
      await goals.click();
      await expect(page.getByRole('alert')).toContainText('Something went wrong.');
      await expect(goals).not.toBeChecked();
      await expect(page.locator('.kit-toast')).toHaveCount(0);
      state.failSave = false;
      pass(
        `${theme}: switches persist successful responses; failed saves retain state and never claim success`,
      );

      await page.getByRole('tab', { name: 'Tracking', exact: true }).click();
      const mode = page.getByRole('combobox', { name: 'Analytics mode' });
      await mode.click();
      await page.getByRole('option', { name: /Cookie-based/ }).click();
      const consent = page.getByRole('checkbox', {
        name: /I understand that I need a cookie banner/,
      });
      await expect(page.getByRole('button', { name: 'Save tracking mode' })).toBeDisabled();
      await consent.check();
      await expect(page.getByRole('button', { name: 'Save tracking mode' })).toBeEnabled();
      pass(`${theme}: tracking select and checkbox preserve the consent gate`);

      await page.getByRole('button', { name: 'Account menu' }).click();
      await expect(page.getByRole('menu', { name: 'Account menu', exact: true })).toBeVisible();
      await capture(page, { path: `${dir}/${theme}-account-menu.png` });
      await page
        .getByRole('menuitemradio', { name: theme === 'light' ? 'Dark' : 'Light', exact: true })
        .click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        theme === 'light' ? 'dark' : 'light',
      );
      await page
        .getByRole('menuitemradio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Account settings' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Sam from North Studio');
      await page.getByRole('button', { name: 'Save name' }).click();
      await expect(page.locator('.kit-toast')).toContainText('Name saved.');
      await capture(page, { path: `${dir}/${theme}-account-dialog.png` });
      await page.getByRole('button', { name: 'Dismiss notification' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused();
      pass(
        `${theme}: account theme controls, saved profile toast, modal dismissal and focus return`,
      );

      await page.goto(`${path}/installation`);
      await page.getByRole('button', { name: 'Copy script', exact: true }).click();
      await expect(page.locator('.kit-toast')).toContainText('Tracking script copied.');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('data-site=');
      await page.getByRole('button', { name: 'Dismiss notification' }).click();
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        };
      });
      await page.getByRole('button', { name: 'Copied', exact: true }).click();
      await expect(page.locator('.kit-toast[data-kind=error]')).toContainText(
        'Copy is unavailable',
      );
      await capture(page, { path: `${dir}/${theme}-clipboard-error.png` });
      pass(
        `${theme}: clipboard success is verified and denied clipboard access produces an error toast`,
      );

      await page.goto(`${base}/usage`);
      await page.getByRole('tab', { name: 'Websites', exact: true }).click();
      await page.getByRole('button', { name: 'Set a website budget' }).click();
      await page.getByLabel('Credits per allowance period').fill('50000');
      await page.getByRole('button', { name: 'Save budget' }).click();
      await expect(page.locator('.kit-toast')).toContainText('Website budget saved.');
      expect(state.site.creditBudget).toBe(50000);
      await page.getByRole('button', { name: 'Dismiss notification' }).click();
      pass(`${theme}: budget form submits the numeric value and confirms the completed save`);

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const view of [
          'overview',
          'settings',
          'installation',
          'imports',
          'goals',
          'web-vitals',
          'pulse',
          'globe',
        ]) {
          // Restore the goal feature changed by the switch test for the mobile page capture.
          state.environment.featureSettings.goals = true;
          await page.goto(`${path}/${view}`);
          await expect(page.locator('h1').last()).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (width === 390)
            await capture(page, { path: `${dir}/${theme}-${view}-mobile.png`, fullPage: true });
        }
        await page.goto(`${path}/settings`);
        await page.getByRole('button', { name: 'Delete website', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('button', { name: 'Delete website', exact: true }),
        ).toBeDisabled();
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.width).toBeLessThanOrEqual(width);
        await capture(page, {
          path: `${dir}/${theme}-delete-sheet-${width}.png`,
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Keep website' }).click();
        await expect(dialog).not.toBeVisible();
      }
      pass(`${theme}: mobile pages at 320/390 px and guarded deletion sheet fit the viewport`);

      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${base}/`);
      await capture(page, { path: `${dir}/${theme}-landing.png`, fullPage: true });
      await page.goto(`${base}/pricing`);
      await capture(page, { path: `${dir}/${theme}-pricing.png`, fullPage: true });
      state.signedIn = false;
      await page.goto(`${base}/signin`);
      await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
      await page.getByRole('button', { name: 'Show password' }).click();
      await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
      await capture(page, { path: `${dir}/${theme}-signin.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, { path: `${dir}/${theme}-signin-mobile.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const language = page.getByRole('combobox', { name: 'Language', exact: true });
      await language.click();
      await page.getByRole('option', { name: 'Dansk' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'da');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'da');
      await page.getByRole('combobox', { name: 'Sprog', exact: true }).click();
      await page.getByRole('option', { name: 'Deutsch' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      pass(
        `${theme}: landing, pricing, auth, password visibility and persisted Danish/German preferences`,
      );
    } catch (error) {
      await capture(page, { path: `${dir}/failure.png`, fullPage: true });
      console.error(await page.locator('body').innerText());
      throw error;
    }
    await context.close();
  }
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await writeFile(`${dir}/results.json`, JSON.stringify({ checks, errors, unexpected }, null, 2));
} finally {
  await browser.close();
}
