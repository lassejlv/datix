import { useSitePreferences } from './site-preferences';
import type { Locale } from '../lib/i18n/preferences';

const regionNames = Object.fromEntries(
  ['en', 'de', 'da'].map((locale) => [
    locale,
    new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }),
  ]),
);

export function countryName(code: string, locale: Locale = 'en') {
  const region = code.toUpperCase();

  return /^[A-Z]{2}$/.test(region) && !['XX', 'ZZ'].includes(region)
    ? regionNames[locale]!.of(region)
    : undefined;
}

export function CountryLabel({ code }: { code: string }) {
  const { locale, t } = useSitePreferences();
  const name = countryName(code, locale);

  const flag = name
    ? String.fromCodePoint(
        ...Array.from(code.toUpperCase(), (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
      )
    : null;

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {flag && (
        <span aria-hidden="true" className="shrink-0 text-base leading-none">
          {flag}
        </span>
      )}
      <span className="truncate">{name ?? t('Unknown location')}</span>
    </span>
  );
}
