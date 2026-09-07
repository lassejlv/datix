import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.FOOTER_QA_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  const language = page.locator('.footer-preferences select').first();
  const theme = page.locator('.footer-preferences select').last();
  await expect(language).toBeEnabled();
  await page.locator('.landing-footer').scrollIntoViewIfNeeded();
  await language.focus();
  await expect(language).toBeFocused();
  expect(await language.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await mkdir('artifacts/footer', { recursive: true });
  for (const locale of ['en', 'de', 'da']) {
    await language.selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.reload();
    await expect(language).toHaveValue(locale);
    for (const value of ['light', 'dark']) {
      await theme.selectOption(value);
      await expect(page.locator('html')).toHaveAttribute('data-theme', value);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('.landing-footer').scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page
          .locator('.landing-footer')
          .screenshot({ path: `artifacts/footer/${locale}-${value}-${width}.png` });
      }
    }
  }
  await language.selectOption('en');
  await theme.selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Tracking & privacy' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/footer/verification.json',
    JSON.stringify(
      {
        base,
        errors,
        checks: [
          'All three languages persist',
          'Light/dark/system theme controls work',
          'No overflow at 320/390/1280px',
          'Keyboard focus and privacy dialog work',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS footer languages, persistence, themes, responsive layout, keyboard focus, and privacy dialog',
  );
} finally {
  await browser.close();
}
