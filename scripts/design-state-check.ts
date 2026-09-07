import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch();
const results = [];
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, colorScheme });
    await page.goto('http://localhost:3000/signin');
    const button = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(button).toBeVisible();
    const read = () =>
      button.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          background: style.backgroundColor,
          color: style.color,
          shadow: style.boxShadow,
          outline: style.outlineWidth,
        };
      });
    const resting = await read();
    await button.hover();
    const hovered = await read();
    expect(hovered.background).not.toBe(resting.background);
    await page.mouse.down();
    await expect.poll(async () => (await read()).shadow).not.toBe(hovered.shadow);
    const pressed = await read();
    await page.mouse.up();
    await page.getByLabel('Password', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    const focused = await read();
    expect(focused.outline === '2px' || focused.shadow !== resting.shadow).toBe(true);
    await page
      .getByTestId('password-control')
      .screenshot({ path: `artifacts/password-control-${colorScheme}.png` });
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const paint = (color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const luminance = (rgb: number[]) =>
        rgb
          .map((c) => c / 255)
          .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const ratio = (foreground: string, background: string) => {
        paint(getComputedStyle(document.body).backgroundColor);
        const bg = luminance(paint(background)),
          fg = luminance(paint(foreground));
        return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
      };
      const button = getComputedStyle(document.querySelector('[data-testid=auth-submit]')!);
      const input = document.querySelector('#auth-email')!;
      const placeholder = getComputedStyle(input, '::placeholder');
      return {
        button: ratio(button.color, button.backgroundColor),
        placeholder: ratio(placeholder.color, getComputedStyle(document.body).backgroundColor),
      };
    });
    expect(contrast.button).toBeGreaterThanOrEqual(4.5);
    expect(contrast.placeholder).toBeGreaterThanOrEqual(4.5);
    results.push({ colorScheme, resting, hovered, pressed, focused, contrast });
    await page.close();
  }
  await writeFile('artifacts/design-states.json', JSON.stringify(results, null, 2) + '\n');
  console.log(
    'PASS Light/dark button hover, pressed, and keyboard focus styles measured in Chromium',
  );
} finally {
  await browser.close();
}
