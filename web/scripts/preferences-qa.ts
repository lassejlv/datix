// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
const results: string[] = [];
const errors: string[] = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await context.route('https://analytics.beer/tracker.js', (route) => route.fulfill({ body: '' }));
  await context.route('https://usedatix.com/tracker.js', (route) => route.fulfill({ body: '' }));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('http://localhost:3000');
  await expect(page.locator('.pricing-billing-switch button').first()).toBeEnabled();
  for (const [locale, heading] of [
    ['de', 'Klare Einblicke.'],
    ['da', 'Gode indsigter.'],
    ['en', 'Good insights.'],
  ]) {
    await page.locator('.footer-preferences select').first().selectOption(locale);
    await expect(page.locator('h1')).toContainText(heading!);
    await expect(page.locator('html')).toHaveAttribute('lang', locale!);
    await page.reload();
    await expect(page.locator('.pricing-billing-switch button').first()).toBeEnabled();
    await expect(page.locator('h1')).toContainText(heading!);
    await expect(page.locator('.footer-preferences select').first()).toHaveValue(locale!);
    for (const theme of ['light', 'dark', 'system']) {
      await page.locator('.footer-preferences select').last().selectOption(theme);
      const expectedDark = theme !== 'light';
      await expect
        .poll(() =>
          page.locator('.landing-page').evaluate((el) => getComputedStyle(el).backgroundColor),
        )
        .toBe(expectedDark ? 'rgb(24, 24, 24)' : 'rgb(255, 255, 255)');
      await expect
        .poll(() =>
          page.locator('.landing-film img').evaluate((el: HTMLImageElement) => el.currentSrc),
        )
        .toContain(expectedDark ? 'dark' : 'light');
      await page.reload();
      await expect(page.locator('.pricing-billing-switch button').first()).toBeEnabled();
      await expect(page.locator('.footer-preferences select').last()).toHaveValue(theme);
      results.push(`${locale}: ${theme} theme, matching poster, saved across reload`);
    }
    await page.locator('.pricing-billing-switch button').last().click();
    await expect(page.locator('.pricing-amount').last()).toContainText('$90');
    await expect(page.locator('.pricing-billing-note').last()).toContainText('90');
    await page.locator('.pricing-select').last().click();
    await expect(page.getByRole('dialog')).toContainText('$90');
    await page.keyboard.press('Escape');
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({
        path: `web/artifacts/landing/preferences-${locale}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.locator('.footer-preferences select').last().selectOption('dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('video')).toHaveAttribute('src', /dark.mp4/);
  await page.locator('.footer-preferences select').last().selectOption('light');
  await expect(page.locator('video')).toHaveAttribute('src', /light.mp4/);
  results.push(
    'System theme follows OS changes; manual dark overrides light OS; video follows manual theme',
  );
  expect(errors).toEqual([]);
  await writeFile(
    'web/artifacts/landing/preferences-qa.json',
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser.close();
}
