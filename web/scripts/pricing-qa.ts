// Read-only pricing UI checks; no checkout is submitted.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { billingPlans, billingPrice } from '../src/lib/billing-plans';
import { mkdir } from 'node:fs/promises';
const base = process.env.PRICING_QA_URL ?? 'http://localhost:3058';
const output = 'web/artifacts/pricing/autumn';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];
try {
  for (const locale of ['en', 'da', 'de']) {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/pricing`);
      await expect(page.locator('.pricing-card')).toHaveCount(3);
      for (const [index, name] of ['Basic', 'Pro', 'Ultra'].entries()) {
        await expect(page.locator('.pricing-card').nth(index).getByRole('heading')).toHaveText(
          name,
        );
      }
      for (const [period, multiplier] of [
        [0, 1],
        [1, 10],
      ] as const) {
        await page.locator('.pricing-billing-switch button').nth(period).click();
        for (const index of billingPlans.keys()) {
          const formatted = billingPrice(billingPlans[index]!, locale, multiplier === 10);
          await expect(page.locator('.pricing-amount').nth(index)).toContainText(formatted);
          const action = page.locator('.pricing-select').nth(index);
          await action.click();
          await expect(page.getByRole('dialog')).toContainText(formatted);
          await expect(page.locator('.pricing-checkout')).toBeEnabled();
          await page.keyboard.press('Escape');
          await expect(action).toBeFocused();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: `${output}/${locale}-${width}-${period}.png`,
          fullPage: true,
        });
      }
      await context.close();
    }
  }
  expect(errors).toEqual([]);
  console.log(
    'Pricing verified: three plans, monthly/yearly, English/Danish/German, desktop/mobile, dialog and focus.',
  );
} finally {
  await browser.close();
}
