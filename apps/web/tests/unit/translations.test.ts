import { describe, expect, test } from 'bun:test';
import { en } from '../../src/lib/i18n/en';
import { da } from '../../src/lib/i18n/da';
import { de } from '../../src/lib/i18n/de';
import { translate, translateMessage, type Copy } from '../../src/lib/i18n/translations';
import { countryName } from '../../src/components/country-label';
import { visitorAlias, activityTitle, type Activity } from '../../src/lib/visitor-journey';

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('complete language catalogs', () => {
  for (const [locale, catalog] of Object.entries({ da, de })) {
    test(`${locale} covers the English catalog and preserves every named value`, () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());

      for (const key of Object.keys(en) as Copy[]) {
        expect(catalog[key].trim().length, key).toBeGreaterThan(0);
        expect(placeholders(catalog[key]), key).toEqual(placeholders(en[key]));
      }
    });
  }

  test('sentences can reorder values without interpreting user input as markup', () => {
    expect(translate('de', 'Import {count} days', { count: 2 })).toBe('2 Tage importieren');
    expect(translate('da', 'Import {count} day', { count: 1 })).toBe('Importér 1 dag');
    expect(translate('de', 'Delete {name}?', { name: '<script>$&{count}</script>' })).toBe(
      '<script>$&{count}</script> löschen?',
    );
  });
  test('API errors and import warnings preserve their useful details', () => {
    expect(translateMessage('da', 'Invalid email or password.')).toBe(
      'Ugyldig e-mail eller adgangskode.',
    );
    expect(translateMessage('de', 'The CSV is missing its pageviews column.')).toBe(
      'Der CSV fehlt die Spalte pageviews.',
    );
    expect(translateMessage('da', 'Ignored unsupported file: unexpected.$&.csv.')).toBe(
      'Ikke-understøttet fil ignoreret: unexpected.$&.csv.',
    );

    const cutoff =
      'Live analytics starts on 2026-09-08 UTC. Export source days that end before that boundary; the source timezone may require excluding the preceding calendar day.';

    expect(translateMessage('de', cutoff)).toContain('beginnt am 2026-09-08 UTC');
    expect(
      translateMessage('da', '2 days imported from Plausible. Your history is ready in Overview.'),
    ).toBe('2 dage importeret fra Plausible. Din historik er klar i Overblik.');
    expect(translateMessage('en', cutoff)).toBe(cutoff);
    expect(translateMessage('da', 'An unknown diagnostic with useful details')).toBe(
      'An unknown diagnostic with useful details',
    );
  });
  test('country names and generated aliases follow the locale without changing identities', () => {
    expect(countryName('DE', 'da')).toBe('Tyskland');
    expect(countryName('DE', 'de')).toBe('Deutschland');
    expect(countryName('XX', 'da')).toBeUndefined();

    for (const key of ['a'.repeat(64), 'b'.repeat(64), 'visitor-123']) {
      const english = visitorAlias(key, 'en');

      for (const locale of ['da', 'de'] as const) {
        const translated = visitorAlias(key, locale);
        expect(translated.animal).toBe(english.animal);
        expect(translated.name).toBe(translate(locale, english.name as Copy));
        expect(translated.name).not.toBe(english.name);
      }
    }

    expect(activityTitle({ kind: 'scroll', details: { scrollDepth: 75 } } as Activity, 'de')).toBe(
      'Bis 75% gescrollt',
    );
    expect(activityTitle({ kind: 'custom', name: 'my original event' } as Activity, 'da')).toBe(
      'my original event',
    );
  });
});
