// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chooseWorkspace } from './picker-helper';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';

const production = process.env.QA_TARGET === 'production';
const base = production ? 'https://usedatix.com' : 'http://localhost:3000';
const connectionString = production
  ? process.env.PRODUCTION_DATABASE_URL
  : process.env.DATABASE_URL;
if (
  !connectionString ||
  (production && new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST)
)
  throw new Error('Explicit database credentials required');
const email = `transitions-${crypto.randomUUID()}@example.com`;
const client = new Client({ connectionString });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'no-preference',
});
await context.addInitScript(() => {
  (window as any).__viewAnimations = [];
  const original = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const animation = original.call(this, keyframes, options);
    if (this.hasAttribute('data-page-transition'))
      (window as any).__viewAnimations.push({
        view: this.getAttribute('data-page-transition'),
        timing: animation.effect?.getTiming(),
        frames: (animation.effect as KeyframeEffect | null)?.getKeyframes(),
      });
    return animation;
  };
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const animations = () =>
  page.evaluate(
    () =>
      (window as any).__viewAnimations as {
        view: string;
        timing: { duration: number };
        frames: unknown[];
      }[],
  );
const settled = () =>
  expect
    .poll(() =>
      page.locator('[data-page-transition]').evaluate((el) => ({
        opacity: getComputedStyle(el).opacity,
        active: el.getAnimations().some((a) => a.playState === 'running'),
      })),
    )
    .toEqual({ opacity: '1', active: false });
try {
  await client.connect();
  await mkdir('web/artifacts/transitions', { recursive: true });
  await page.goto(`${base}/signin`);
  await page.getByLabel('Email address').fill('preserved@example.com');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home.', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('preserved@example.com');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Email address')).toHaveValue('preserved@example.com');
  await settled();
  const authAnimations = await animations();
  expect(authAnimations.some((a) => a.view === 'sign-up' && a.timing.duration === 180)).toBe(true);
  const auth = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: { name: 'Transitions QA', email, password: crypto.randomUUID() },
  });
  expect(auth.status()).toBe(200);
  const siteIds: string[] = [];
  for (const name of ['first', 'second']) {
    const response = await context.request.post(`${base}/api/sites`, {
      headers: { Origin: base },
      data: { name: `Transitions ${name}`, domain: `${name}.transitions.example` },
    });
    expect(response.status()).toBe(201);
    siteIds.push((await response.json()).site.id);
  }
  await page.goto(`${base}/?site=${siteIds[0]}&view=overview`);
  await expect(
    page.getByRole('heading', { name: 'first.transitions.example', exact: true }),
  ).toBeVisible();
  for (const [button, view, heading] of [
    ['Installation', 'installation', 'Install your script'],
    ['Website settings', 'settings', 'Website settings'],
    ['Overview', 'overview', 'first.transitions.example'],
  ]) {
    await page.getByRole('link', { name: button, exact: true }).click();
    await expect(page.locator('[data-page-transition]')).toHaveAttribute(
      'data-page-transition',
      `${siteIds[0]}:${view}`,
    );
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: button, exact: true })).toBeFocused();
    await settled();
    expect(
      (await animations()).some(
        (a) => a.view === `${siteIds[0]}:${view}` && a.timing.duration === 180,
      ),
    ).toBe(true);
  }
  await chooseWorkspace(page, 'website', siteIds[1]!);
  await expect(
    page.getByRole('heading', { name: 'second.transitions.example', exact: true }),
  ).toBeVisible();
  await settled();
  expect((await animations()).some((a) => a.view === `${siteIds[1]}:overview`)).toBe(true);
  // Successive clicks are allowed during the incoming animation.
  for (const name of ['Installation', 'Website settings', 'Overview'])
    await page
      .getByRole('link', { name, exact: true })
      .evaluate((el: HTMLAnchorElement) => el.click());
  await expect(
    page.getByRole('heading', { name: 'second.transitions.example', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-page-transition]')).toHaveCount(1);
  await settled();
  await page.screenshot({ path: 'web/artifacts/transitions/desktop.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const before = (await animations()).length;
  await page.getByRole('link', { name: 'Website settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Website settings', exact: true })).toBeVisible();
  await settled();
  expect((await animations()).length).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('link', { name: 'Installation', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Install your script', exact: true }),
  ).toBeVisible();
  expect((await animations()).length).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'web/artifacts/transitions/mobile-reduced-motion.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await writeFile(
    'web/artifacts/transitions/verification.json',
    JSON.stringify(
      {
        base,
        verifiedAt: new Date().toISOString(),
        checks: [
          '180ms page transitions for auth, dashboard panels, and website changes',
          'Auth field values preserved',
          'Tab focus retained',
          'Rapid switching ends on the latest view without duplicate panels',
          'Reduced motion disables page animations, including mobile navigation',
        ],
        animations: await animations(),
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS view transitions, preserved form state, focus, rapid switching, reduced motion, and mobile layout',
  );
} finally {
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
  await browser.close();
}
