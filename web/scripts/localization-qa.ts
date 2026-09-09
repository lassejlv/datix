import { chromium, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
import { en } from '../src/lib/i18n/en';
import { translations, translate, formatLocale, type Copy } from '../src/lib/i18n/translations';
import type { Locale } from '../src/lib/i18n/preferences';
import { seedPro, cleanupPro } from '../tests/fixtures/billing';

process.chdir(new URL('../..', import.meta.url).pathname);
const target = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  target.hostname !== process.env.TEST_DATABASE_HOST ||
  target.hostname === new URL(process.env.DATABASE_URL ?? '').hostname
)
  throw new Error('An explicitly matched isolated database is required.');
const base = process.env.LOCALIZATION_QA_URL ?? 'http://localhost:3060';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('Use a local preview.');
const output = 'web/artifacts/localization';
const client = new Client({ connectionString: target.toString() });
const browser = await chromium.launch();
const errors: string[] = [];
const checks: string[] = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
  colorScheme: 'light',
});
await context.addCookies([{ name: 'ab-language', value: 'en', url: base }]);
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
let user: string | undefined;

async function audit(page: Page, locale: Locale) {
  if (locale === 'en') return;
  const unlocalized = (Object.keys(en) as Copy[]).filter(
    (key) => translations[locale][key] !== en[key],
  );
  const found = await page.evaluate((keys) => {
    const english = new Set<string>(keys);
    const missed = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (
        !parent ||
        !parent.getClientRects().length ||
        parent.closest('script,style,code,textarea,pre')
      )
        continue;
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      if (text && english.has(text)) missed.add(text);
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      '[aria-label],[placeholder],[title]',
    )) {
      if (!element.getClientRects().length) continue;
      for (const key of ['aria-label', 'placeholder', 'title']) {
        const text = element.getAttribute(key)?.trim();
        if (text && english.has(text)) missed.add(text);
      }
    }
    return [...missed];
  }, unlocalized);
  expect(found, `Untranslated text at ${page.url()} (${locale})`).toEqual([]);
}

try {
  await client.connect();
  await mkdir(output, { recursive: true });
  // Public language selection persists and updates an existing validation error immediately.
  await page.goto(`${base}/signin`);
  await page
    .getByLabel('Email address', { exact: true })
    .fill(`no-account-${crypto.randomUUID()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('NotARealAccount!123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('da');
  await expect(page.getByRole('alert')).toHaveText(translate('da', 'Invalid email or password.'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'da');
  await page.screenshot({ path: `${output}/da-signin.png`, fullPage: true });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: translate('da', 'Sign in'), exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: translate('da', 'Language'), exact: true })
    .selectOption('en');
  checks.push('Sign-in error translates immediately; explicit language survives reload');

  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      name: 'Forest Studio',
      email: `locale-qa-${crypto.randomUUID()}@example.com`,
      password: `Qa!${crypto.randomUUID()}`,
    },
  });
  expect(signup.status()).toBe(200);
  user = (await signup.json()).user.id;
  await seedPro(client, user!);
  const created = await context.request.post(`${base}/api/sites`, {
    headers: { origin: base },
    data: { name: 'Forest Studio', domain: 'forest-locale.example.com' },
  });
  expect(created.status()).toBe(201);
  const site = (await created.json()).site.id;
  await client.query(
    `INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor)
    VALUES($1,gen_random_uuid(),now()-interval '5 minutes',current_date,'pageview','','/original-page','google.com','DE','desktop',repeat('a',64))`,
    [site],
  );
  await client.query(
    `INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,visitors,custom_events)
    SELECT $1,current_date,dimension,value,1234,42,5 FROM (VALUES ('total',''),('path','/original-page'),('referrer','google.com'),('country','DE'),('device','desktop'),('event','my original event')) rows(dimension,value)`,
    [site],
  );
  let current: Locale = 'en';
  const route = (pageName: string) => `${base}/site/${site}/${site}/${pageName}`;
  for (const locale of ['en', 'da', 'de'] as const) {
    // Browser sweeps are faster than normal navigation; respect the live API's minute budget.
    if (locale !== 'en') await new Promise((resolve) => setTimeout(resolve, 35_000));
    const t = (key: Copy) => translate(locale, key);
    await page.goto(route('overview'));
    await expect(
      page.getByRole('heading', { name: 'forest-locale.example.com', exact: true }),
    ).toBeVisible();
    await page.getByTestId('account-menu').click();
    await page
      .getByRole('menuitem', { name: translate(current, 'Account settings'), exact: true })
      .click();
    await page
      .getByRole('combobox', { name: translate(current, 'Language'), exact: true })
      .selectOption(locale);
    await expect(page.getByRole('dialog')).toContainText(t('Manage your profile and password.'));
    await page.getByRole('textbox', { name: t('Name'), exact: true }).fill('Unsaved name');
    await page.getByRole('combobox', { name: t('Language'), exact: true }).selectOption(current);
    await expect(
      page.getByRole('textbox', { name: translate(current, 'Name'), exact: true }),
    ).toHaveValue('Unsaved name');
    await page
      .getByRole('combobox', { name: translate(current, 'Language'), exact: true })
      .selectOption(locale);
    await audit(page, locale);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toBeFocused();
    current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page).toHaveTitle(`${t('Overview')} | Analytics Beer`);
    await expect(
      page.getByRole('button', { name: new RegExp(t('Pageviews')) }).first(),
    ).toContainText(new Intl.NumberFormat(formatLocale[locale]).format(1234));
    await expect(
      page.getByText(locale === 'da' ? 'Tyskland' : locale === 'de' ? 'Deutschland' : 'Germany', {
        exact: true,
      }),
    ).toBeVisible();
    await audit(page, locale);
    await page.screenshot({ path: `${output}/${locale}-overview.png`, fullPage: true });

    await page.goto(route('visitors'));
    await page
      .getByRole('button', {
        name: translate(locale, 'Open session {id}', { id: 'aaaaaaaa' }),
        exact: true,
      })
      .click();
    await expect(page.getByRole('heading', { name: '/original-page', exact: true })).toBeVisible();
    await page.getByText(t('Visit details'), { exact: true }).click();
    await audit(page, locale);
    await page.screenshot({ path: `${output}/${locale}-visitor.png`, fullPage: true });

    await page.goto(route('installation'));
    await expect(
      page.getByRole('heading', { name: t('Install your script'), exact: true }),
    ).toBeVisible();
    await expect(page.locator('pre').first()).toContainText(`data-site="${site}"`);
    await audit(page, locale);
    await page.goto(route('settings'));
    await expect(
      page.getByRole('heading', { name: t('Website settings'), exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: t('Tracking'), exact: true }).click();
    await page
      .getByRole('combobox', { name: t('Analytics mode'), exact: true })
      .selectOption('sessions');
    await expect(
      page.getByText(t('Uses cookies — a cookie banner is required.'), { exact: true }),
    ).toBeVisible();
    await audit(page, locale);
    await page.getByRole('tab', { name: t('Website'), exact: true }).click();
    await page.getByRole('button', { name: t('Delete website'), exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(
      translate(locale, 'Type {name} to confirm', { name: 'forest-locale.example.com' }),
    );
    await audit(page, locale);
    await page.keyboard.press('Escape');

    await page.goto(`${base}/usage`);
    await expect(page.getByRole('heading', { name: t('Usage'), exact: true })).toBeVisible();
    await expect(page.getByText(t('Event credits'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: t('Set a website budget'), exact: true }).click();
    await audit(page, locale);
    await page.screenshot({ path: `${output}/${locale}-usage.png`, fullPage: true });

    await page.goto(route('imports'));
    const date = new Date(
      Date.now() - (10 + (locale === 'en' ? 0 : locale === 'da' ? 1 : 2)) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    await page.getByLabel(t('Analytics export file'), { exact: true }).setInputFiles({
      name: 'imported_visitors.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`date,visitors,pageviews\n${date},17,30\n`),
    });
    await page.getByRole('button', { name: t('Review import'), exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: translate(locale, 'Import {count} day', { count: 1 }),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        t(
          'Daily visitor counts are added across days; they are not unique people across the full period.',
        ),
        { exact: true },
      ),
    ).toBeVisible();
    await audit(page, locale);
    await page.screenshot({ path: `${output}/${locale}-imports.png`, fullPage: true });
    await page
      .getByRole('button', {
        name: translate(locale, 'Import {count} day', { count: 1 }),
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('status').filter({
        hasText: translate(
          locale,
          '{count} day imported from {provider}. Your history is ready in Overview.',
          { count: 1, provider: 'Plausible' },
        ),
      }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: translate(locale, 'Remove {provider} import from {date}', {
          provider: 'Plausible',
          date: new Date(`${date}T12:00:00Z`).toLocaleDateString(formatLocale[locale], {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          }),
        }),
        exact: true,
      })
      .click();
    await expect(page.getByRole('dialog')).toContainText(t('Remove this import?'));
    await page.getByRole('button', { name: t('Remove import'), exact: true }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: t('Import removed. Your tracked analytics are unchanged.') }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.getByTestId('navigation-toggle').click();
    await expect(page.getByRole('dialog')).toContainText(t('Navigation'));
    await audit(page, locale);
    await page.screenshot({ path: `${output}/${locale}-mobile-navigation.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${output}/${locale}-mobile-imports.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${base}/pricing`);
    await expect(page).toHaveTitle(`${t('Pricing')} | Analytics Beer`);
    await audit(page, locale);
    await page.goto(`${base}/missing-localized-page`);
    await expect(
      page.getByRole('heading', { name: t('Nothing brewing here.'), exact: true }),
    ).toBeVisible();
    await audit(page, locale);
    checks.push(
      `${locale}: account language/focus, overview numbers/countries, visits, install, consent settings, deletion dialog, usage, real import/removal, mobile and 404`,
    );
    console.log(`PASS ${locale}`);
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  expect(errors).toEqual([]);
  await Bun.write(`${output}/verification.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
} finally {
  if (user) {
    await cleanupPro(client, [user]);
    await client.query('DELETE FROM "user" WHERE id=$1', [user]);
  }
  await browser.close();
  await client.end();
}
