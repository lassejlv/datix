import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
import { translate } from '../src/lib/i18n/translations';
process.chdir(new URL('../..', import.meta.url).pathname);
const target = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  target.hostname !== process.env.TEST_DATABASE_HOST ||
  target.hostname === new URL(process.env.DATABASE_URL ?? '').hostname
)
  throw new Error('Isolated database required');
const base = 'http://localhost:3060';
const client = new Client({ connectionString: target.toString() });
const browser = await chromium.launch();
let user: string | undefined;
try {
  await client.connect();
  await mkdir('web/artifacts/settings-tabs', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      name: 'Settings QA',
      email: `settings-qa-${crypto.randomUUID()}@example.com`,
      password: `Qa!${crypto.randomUUID()}`,
    },
  });
  expect(signup.status()).toBe(200);
  user = (await signup.json()).user.id;
  const result = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Forest Studio', domain: 'forest-settings.example.com' },
  });
  expect(result.status()).toBe(201);
  const site = (await result.json()).site.id;
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const locale of ['en', 'da', 'de'] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    await context.addCookies([{ name: 'ab-language', value: locale, url: base }]);
    await page.goto(`${base}/site/${site}/${site}/settings`);
    const website = page.getByRole('tab', { name: t('Website'), exact: true });
    await expect(website).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#environment-name')).toBeHidden();
    await page.locator('#settings-name').fill('Unsaved website');
    await website.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: t('Environment'), exact: true })).toBeFocused();
    await page.locator('#environment-name').fill('Unsaved environment');
    await page.keyboard.press('Tab');
    await page.getByRole('tab', { name: t('Tracking'), exact: true }).click();
    await page
      .getByRole('combobox', { name: t('Analytics mode'), exact: true })
      .selectOption('sessions');
    await expect(
      page.getByRole('button', { name: t('Save tracking mode'), exact: true }),
    ).toBeDisabled();
    await website.click();
    await expect(page.locator('#settings-name')).toHaveValue('Unsaved website');
    await page.getByRole('tab', { name: t('Environment'), exact: true }).click();
    await expect(page.locator('#environment-name')).toHaveValue('Unsaved environment');
    await page.getByRole('tab', { name: t('Tracking'), exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: t('Analytics mode'), exact: true }),
    ).toHaveValue('sessions');
    await page.keyboard.press('Home');
    await expect(website).toBeFocused();
    await page.screenshot({
      path: `web/artifacts/settings-tabs/${locale}-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const key of ['Website', 'Environment', 'Tracking'] as const) {
      await page.getByRole('tab', { name: t(key), exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.screenshot({
      path: `web/artifacts/settings-tabs/${locale}-mobile.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log(`PASS ${locale}: tabs, keyboard, unsaved values, consent guard, mobile`);
  }
  expect(errors).toEqual([]);
} finally {
  if (user) await client.query('DELETE FROM "user" WHERE id=$1', [user]);
  await browser.close();
  await client.end();
}
