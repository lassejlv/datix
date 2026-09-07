import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.PRICING_QA_URL ?? 'http://localhost:3002';
const output = `artifacts/pricing/${new URL(base).hostname === 'analytics.beer' ? 'production' : 'local'}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];
const results: unknown[] = [];
try {
  for (const locale of ['en', 'da', 'de']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
    await context.route('https://analytics.beer/tracker.js', (r) => r.fulfill({ body: '' }));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/pricing`);
    await expect(page.locator('.pricing-select').first()).toBeEnabled();
    await expect(page.locator('.pricing-card')).toHaveCount(1);
    await expect(page.locator('.pricing-card-free')).toHaveCount(0);
    await expect(page.locator('.pricing-heading')).toContainText('14');
    await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText('$9');
    await page.locator('.pricing-billing-switch button').last().click();
    await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText('$90');
    for (let i = 0; i < 1; i++) {
      await page.locator('.pricing-select').nth(i).focus();
      const outline = await page
        .locator('.pricing-select')
        .nth(i)
        .evaluate((el) => getComputedStyle(el).outlineWidth);
      expect(parseFloat(outline)).toBeGreaterThanOrEqual(2);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('dialog')).toContainText('14');
      await expect(page.getByRole('dialog')).toContainText('100');
      await page.keyboard.press('Escape');
      await expect(page.locator('.pricing-select').nth(i)).toBeFocused();
    }
    const slider = page.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('Home');
    for (const [index, monthly] of [9, 19, 29, 49, 79, 149].entries()) {
      if (index) await page.keyboard.press('ArrowRight');
      await expect(slider).toHaveValue(String(index));
      await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText(
        `$${monthly * 10}`,
      );
    }
    await page.locator('.pricing-select').last().click();
    await expect(page.getByRole('dialog')).toContainText('$1490');
    await expect(page.getByRole('dialog')).toContainText(
      new Intl.NumberFormat(locale).format(5_000_000),
    );
    await page.keyboard.press('Escape');
    await page.locator('.pricing-billing-switch button').first().click();
    await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText('$149');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText('$9');
    // Exercise pointer dragging as well as keyboard selection.
    const range = await slider.boundingBox();
    await page.mouse.move(range!.x + 8, range!.y + range!.height / 2);
    await page.mouse.down();
    await page.mouse.move(range!.x + range!.width - 8, range!.y + range!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(slider).toHaveValue('6');
    await expect(page.locator('#plan-pro')).toHaveText('Enterprise');
    await expect(page.locator('.pricing-card-pro .pricing-amount')).not.toContainText('$');
    await expect(page.locator('.pricing-card-pro .pricing-select')).toHaveText(
      locale === 'en'
        ? 'Contact sales'
        : locale === 'de'
          ? 'Vertrieb kontaktieren'
          : 'Kontakt salg',
    );
    await page.locator('h1#pricing-title').click();
    const action = page.locator('.pricing-select').first();
    await expect(action).toHaveAttribute('href', 'mailto:hello@analytics.beer');
    await action.focus();
    await expect(action).toBeFocused();
    const resting = await action.evaluate((el) => getComputedStyle(el).backgroundColor);
    await action.hover();
    await expect
      .poll(() => action.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(resting);
    await page.mouse.move(0, 0);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page
          .locator('#pricing')
          .screenshot({ path: `${output}/${locale}-${theme}-${width}-enterprise.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveValue('5');
    await expect(page.locator('#plan-pro')).toHaveText('Pro');
    await expect(page.locator('.pricing-card-pro .pricing-amount')).toContainText('$149');
    await page.keyboard.press('Home');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#pricing-title').click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${output}/${locale}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/${locale}-mobile.png`, fullPage: true });
    results.push({
      locale,
      tiers: 1,
      trialDays: 14,
      proMonthly: 9,
      proYearly: 90,
      keyboard: 'passed',
      widths: [1440, 390, 320],
    });
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(`${output}/verification.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser.close();
}
