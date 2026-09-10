// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.LANDING_QA_URL ?? 'http://localhost:3000';
await mkdir('web/artifacts/landing', { recursive: true });
const browser = await chromium.launch();
const checks: string[] = [];
const errors: string[] = [];
const measured: unknown[] = [];
try {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    // The production tracking integration is covered by its separate smoke suite.
    await context.route('https://analytics.beer/tracker.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await context.route('https://usedatix.com/tracker.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
    let page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const videos: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('.mp4')) videos.push(request.url());
    });
    await page.goto(base);
    await expect(
      page.getByRole('heading', { name: 'Good insights. Less head scratching.' }),
    ).toBeVisible();
    await expect(page.locator('.landing-film img')).toHaveJSProperty('complete', true);
    await expect
      .poll(() =>
        page.locator('.landing-film img').evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(600);
    expect(videos).toEqual([]);
    checks.push(`${theme}: reduced motion uses the poster without downloading video`);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const title = document.querySelector('h1')!.getBoundingClientRect();
        const cta = document
          .querySelector('.landing-actions .landing-button')!
          .getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          center: title.x + title.width / 2,
          ctaBottom: cta.bottom,
          ctaHeight: cta.height,
          viewportHeight: innerHeight,
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
      expect(Math.abs(geometry.center - viewport.width / 2)).toBeLessThan(1);
      expect(geometry.ctaBottom).toBeLessThan(viewport.height);
      expect(geometry.ctaHeight).toBe(48);
      await page.screenshot({
        path: `web/artifacts/landing/${theme}-${viewport.width}.png`,
        fullPage: true,
      });
      measured.push({ theme, viewport, geometry });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    const primary = page.locator('.landing-actions .landing-button');
    await primary.focus();
    expect(await primary.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    const resting = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    await primary.hover();
    const hovered = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(hovered).not.toBe(resting);
    const contrast = await primary.evaluate((el) => {
      const style = getComputedStyle(el);
      const lum = (color: string) =>
        (color.match(/[\d.]+/g) ?? [])
          .slice(0, 3)
          .map(Number)
          .map((v) => (color.startsWith('color(srgb') ? v : v / 255))
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = lum(style.color),
        b = lum(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThan(4.5);
    measured.push({ theme, resting, hovered, contrast });
    await page.getByRole('button', { name: 'Take a look', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByText('An actual Datix dashboard, shown with example traffic.'),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.landing-demo').evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1440);
    await page.screenshot({ path: `web/artifacts/landing/demo-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Take a look', exact: true }).first(),
    ).toBeFocused();
    for (const detail of await page.locator('.landing-faq details').all()) {
      await detail.locator('summary').click();
      await expect(detail).toHaveAttribute('open', '');
      await expect(detail.locator('p')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Tracking & privacy' }).click();
    await expect(page.getByRole('dialog')).toContainText(
      'Persistent visitor tracking uses first party cookies or local storage',
    );
    await page.keyboard.press('Escape');
    checks.push(
      `${theme}: centered at four widths, visible CTA, no overflow, keyboard focus, contrast, preview, FAQ and privacy dialog`,
    );

    // A fresh tab isolates playback from the router restoring the footer scroll
    // position after the preceding privacy-dialog checks.
    await page.close();
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', (request) => {
      if (request.url().endsWith('.mp4')) videos.push(request.url());
    });
    await page.goto(base);
    await expect(page.locator('.landing-motion-button')).toBeEnabled();
    // Let hydration and scroll restoration settle before positioning the film.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page
      .locator('.landing-film')
      .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect
      .poll(
        () =>
          page.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0.2),
        { message: `${theme}: manual play with reduced motion` },
      )
      .toBe(true);
    await page
      .locator('.landing-film')
      .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page
      .locator('.landing-film')
      .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect
      .poll(
        () =>
          page.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0),
        { message: `${theme}: play after changing motion preference` },
      )
      .toBe(true);
    expect(videos.every((url) => url.endsWith(`beer-stop-motion-${theme}.mp4`))).toBe(true);
    await page
      .locator('.landing-film')
      .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.paused))
      .toBe(true);
    await page.locator('.landing-footer').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), {
        message: `${theme}: offscreen pause`,
      })
      .toBe(true);
    await page.locator('.landing-film').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.paused), {
        message: `${theme}: visible resume`,
      })
      .toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), {
        message: `${theme}: preference change pauses video`,
      })
      .toBe(true);
    checks.push(
      `${theme}: manual playback from the reduced-motion poster, themed video playback, pause, resume, offscreen pause and live reduced-motion preference`,
    );
    await context.close();
  }

  const page = await browser.newPage();
  await page.context().addCookies([{ name: 'ab-language', value: 'en', url: base }]);
  await page.route('https://analytics.beer/tracker.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('https://usedatix.com/tracker.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto(base);
  await page.locator('.landing-actions .landing-button').click();
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home.', exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/signup');
  await page.getByLabel('Your name', { exact: true }).fill('Landing QA');
  await page.getByLabel('Email address').fill('not-an-email');
  await page.getByLabel('Password', { exact: true }).fill('long-enough-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect(
    await page
      .getByLabel('Email address')
      .evaluate((input: HTMLInputElement) => input.validity.typeMismatch),
  ).toBe(true);
  await page.getByRole('link', { name: 'Datix home' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  await page.goto(`${base}/?site=${crypto.randomUUID()}&view=installation`);
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  await page.goto(`${base}/page-that-does-not-exist`);
  await expect(page.getByRole('heading', { name: 'Nothing brewing here.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page.locator('h1')).toHaveText('Good insights.Less head scratching.');
  checks.push(
    'Signup and sign-in links, email validation, return home, protected report deep links and branded 404',
  );
  await page.route('**/media/*.mp4', (route) => route.abort());
  await page.reload();
  await expect(
    page.getByText('Animation unavailable. The illustration is still here.'),
  ).toBeVisible();
  await expect(page.locator('.landing-film img')).toBeVisible();
  checks.push('Video network failure leaves a visible poster and clear status');
  expect(errors).toEqual([]);
  await writeFile(
    'web/artifacts/landing/verification.json',
    JSON.stringify({ checks, errors, measured }, null, 2) + '\n',
  );
  console.log(checks.map((c) => `PASS ${c}`).join('\n'));
} finally {
  await browser.close();
}
