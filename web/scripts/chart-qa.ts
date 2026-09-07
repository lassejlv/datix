// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { writeFile } from 'node:fs/promises';

const base = 'http://localhost:3000';
const email = `chart-${crypto.randomUUID()}@example.com`;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [],
  results: unknown[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await client.connect();
  const auth = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: { name: 'Chart QA', email, password: crypto.randomUUID() },
  });
  expect(auth.status()).toBe(200);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { Origin: base },
    data: { name: 'Dither Kit QA', domain: 'chart-qa.example' },
  });
  expect(created.status()).toBe(201);
  const { site } = await created.json();
  // Chart-only fixtures belong to a disposable account and are removed below.
  await client.query(
    `insert into daily_stats (site_id, day, dimension, value, pageviews, custom_events, visitors)
    select $1, current_date - n, 'total', '', 10 + (30-n)*2 + (n%4)*3, (n%5)+1, 5+(30-n)
    from generate_series(0,29) n`,
    [site.id],
  );
  await page.goto(`${base}/?site=${site.id}&view=overview`);
  const chart = page.getByRole('group', { name: 'Daily traffic chart.', exact: false });
  const canvas = page.getByTestId('traffic-chart').locator('canvas').first();
  const tooltip = page.locator('[data-slot=chart-tooltip]');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const expected = theme === 'dark' ? 222 : 51;
      await expect
        .poll(() =>
          canvas.evaluate((c, expected) => {
            const el = c as HTMLCanvasElement;
            const values = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
            for (let i = 0; i < values.length; i += 4)
              if (values[i + 3]! > 250) return Math.abs(values[i]! - expected);
            return Infinity;
          }, expected),
        )
        .toBeLessThanOrEqual(1);
      await chart.focus();
      await page.keyboard.press('Home');
      await expect(tooltip).toContainText('Pageviews');
      await expect
        .poll(async () => {
          const box = await tooltip.boundingBox();
          return !!box && box.x >= 0 && box.x + box.width <= width;
        })
        .toBe(true);
      await page.keyboard.press('End');
      await expect
        .poll(async () => {
          const box = await tooltip.boundingBox();
          return !!box && box.x >= 0 && box.x + box.width <= width;
        })
        .toBe(true);
      const bounds = (await chart.boundingBox())!;
      await chart.hover({ position: { x: Math.round(bounds.width / 2), y: 70 } });
      await expect(tooltip).toBeVisible();
      await page.screenshot({ path: `web/artifacts/dither-${width}-${theme}.png`, fullPage: true });
      results.push({
        width,
        theme,
        ink: expected,
        keyboard: true,
        pointer: true,
        tooltipFits: true,
      });
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
    }
  }
  expect(errors).toEqual([]);
  await writeFile(
    'web/artifacts/chart-qa.json',
    JSON.stringify({ verifiedAt: new Date().toISOString(), results, errors }, null, 2) + '\n',
  );
  console.log(
    'PASS Dither canvas contrast, theme changes, keyboard/pointer tooltips, and mobile bounds',
  );
} catch (error) {
  await page.screenshot({ path: 'web/artifacts/chart-failure.png', fullPage: true });
  throw error;
} finally {
  await client.query('delete from "user" where email=$1', [email]);
  await client.end();
  await browser.close();
}
