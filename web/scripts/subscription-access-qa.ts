// Browser acceptance with isolated API fixtures. No database or payment provider is touched.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect, type BrowserContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const base = process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw Error('Subscription access fixtures require localhost');
const dir = 'web/artifacts/subscription-access';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch();
const user = { id: 'subscription-qa-owner', name: 'Sam', email: 'sam@example.com' };
const siteId = '11111111-1111-4111-8111-111111111111';
const environment = {
  id: siteId,
  siteId,
  name: 'Production',
  domain: 'lassejlv.dk',
  enabled: true,
  allowLocalhost: false,
  trackingMode: 'cookieless',
  createdAt: new Date().toISOString(),
};
const site = {
  id: siteId,
  ownerId: user.id,
  name: 'Portfolio',
  domain: environment.domain,
  enabled: true,
  allowLocalhost: false,
  creditBudget: null,
  createdAt: environment.createdAt,
  environments: [environment],
};
const state = {
  siteAdded: false,
  completed: false,
  active: false,
  trial: false,
  exhausted: false,
  usageFails: false,
  signedIn: true,
  checkout: null as null | { events: number; interval: string; locale: string },
  workspaceRequests: [] as string[],
};
const errors: string[] = [];
const unexpected: string[] = [];
async function fixtures(context: BrowserContext) {
  context.setDefaultTimeout(15000);
  await context.route('https://usedatix.com/**', (route) =>
    route.fulfill({ body: '', contentType: 'application/javascript' }),
  );
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    let status = 200;
    let result: unknown;
    if (path === '/preferences') result = { locale: 'en', theme: 'dark' };
    else if (path === '/me') {
      status = state.signedIn ? 200 : 401;
      result = state.signedIn ? { user } : { error: { message: 'Sign in to continue.' } };
    } else if (path === '/usage') {
      status = state.usageFails ? 503 : 200;
      result = state.usageFails
        ? { error: { message: 'Subscription verification is temporarily unavailable.' } }
        : {
            onboardingCompleted: state.completed,
            plan: state.active
              ? { name: 'Basic', trial: state.trial, eventLimit: 100000, websiteLimit: 1 }
              : null,
            period: state.active
              ? {
                  start: new Date(Date.now() - 86400000).toISOString(),
                  end: new Date(Date.now() + 86400000 * 14).toISOString(),
                }
              : null,
            paused: !state.active || state.exhausted,
            pauseReason: !state.active
              ? 'subscription_required'
              : state.exhausted
                ? 'event_limit'
                : null,
            events: { used: state.exhausted ? 100000 : 0, remaining: state.exhausted ? 0 : 100000 },
            websites: state.siteAdded
              ? [
                  {
                    ...site,
                    events: 0,
                    paused: !state.active,
                    pauseReason: state.active ? null : 'subscription_required',
                  },
                ]
              : [],
          };
    } else if (path === '/sites') {
      if (request.method() === 'POST') state.siteAdded = true;
      result = request.method() === 'POST' ? { site } : { sites: state.siteAdded ? [site] : [] };
    } else if (path === '/onboarding/complete') {
      state.completed = true;
      result = { onboardingCompleted: true };
    } else if (path === '/billing') result = { hasCustomer: true };
    else if (path === '/billing/sync') result = { success: true };
    else if (path === '/billing/checkout') {
      state.checkout = request.postDataJSON();
      result = { url: `${base}/dashboard?checkout_id=fixture-checkout` };
    } else if (path === '/auth/sign-out') {
      state.signedIn = false;
      result = { success: true };
    } else if (path.startsWith('/sites/')) {
      state.workspaceRequests.push(`${request.method()} ${path}`);
      if (!state.active) {
        status = 402;
        result = {
          error: { code: 'subscription_required', message: 'Choose a plan to continue.' },
        };
      } else if (path.endsWith('/installation'))
        result = { receiving: true, lastReceivedAt: environment.createdAt };
      else {
        // Post-unlock report traffic is expected; fixtures only model access control.
        status = 503;
        result = { error: { message: 'Report fixtures are unavailable.' } };
      }
    } else {
      unexpected.push(path);
      status = 404;
      result = { error: { message: 'Unhandled fixture' } };
    }
    await route.fulfill({ status, json: result });
  });
}
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  await fixtures(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/dashboard`);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add your first website' }).click();
  await page.getByLabel('Website name', { exact: true }).fill('Portfolio');
  await page.getByLabel('Website domain', { exact: false }).fill('lassejlv.dk');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect your website' })).toBeVisible();
  await expect(page.getByLabel('Tracking script', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore dashboard first' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check installation', exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${dir}/setup-mobile.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue to plans' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to plans' }).click();
  await expect(page.locator('#plan-required-title')).toHaveText('Choose a plan to continue');
  await expect(page).toHaveURL(`${base}/dashboard`);
  expect(state.completed).toBe(true);
  expect(state.workspaceRequests).toEqual([]);
  console.log('PASS first website → install → plans without requiring a billable pageview');

  for (const route of [
    'overview',
    'settings',
    'settings?tab=imports',
    'installation',
    'visitors',
    'setup',
  ]) {
    await page.goto(`${base}/site/${siteId}/${siteId}/${route}`);
    await expect(page.locator('#plan-required-title')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(
      0,
    );
    await expect(page).toHaveURL(`${base}/site/${siteId}/${siteId}/${route}`);
  }
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await expect(page.locator('#plan-required-title')).toBeVisible();
  expect(state.workspaceRequests).toEqual([]);
  console.log('PASS deep links, refresh and cleared browser storage cannot bypass the gate');

  await page.getByRole('button', { name: 'Choose plan', exact: true }).click();
  await expect(page).toHaveURL(/checkout_id=fixture-checkout/);
  await expect(
    page.getByText('Waiting for Polar to confirm your subscription.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('#plan-required-title')).toBeVisible();
  expect(state.checkout?.interval).toBe('month');
  expect(state.checkout?.events).toBeGreaterThan(0);
  expect(state.workspaceRequests).toEqual([]);
  console.log('PASS checkout return alone cannot unlock the app');

  state.active = true;
  state.trial = true;
  await page.getByRole('button', { name: 'Refresh subscription', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toBeVisible();
  await expect(page.locator('#plan-required-title')).toHaveCount(0);
  await page.goto(`${base}/site/${siteId}/${siteId}/settings?tab=usage`);
  await expect(page.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.getByRole('tab', { name: 'Billing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage billing', exact: true })).toBeVisible();
  state.exhausted = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toBeVisible();
  await expect(
    page.getByText('Tracking paused · Event limit reached', { exact: true }),
  ).toBeVisible();
  console.log(
    'PASS verified trial unlocks the app; a spent allowance does not revoke a valid subscription',
  );

  state.usageFails = true;
  await page.reload();
  await expect(
    page.getByText('Subscription verification is temporarily unavailable.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(0);
  state.usageFails = false;
  state.active = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('#plan-required-title')).toBeVisible();
  console.log('PASS failed verification and expired subscriptions close the workspace');
  await context.close();

  for (const locale of ['en', 'da', 'de']) {
    const context = await browser.newContext({ colorScheme: 'dark' });
    await fixtures(context);
    await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/dashboard`);
      await expect(page.locator('#plan-required-title')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 390)
        await page.screenshot({ path: `${dir}/plans-${locale}-mobile.png`, fullPage: true });
    }
    await context.close();
  }
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  console.log('PASS all three locales at phone and desktop widths, no page errors or overflow');
} finally {
  await browser.close();
}
