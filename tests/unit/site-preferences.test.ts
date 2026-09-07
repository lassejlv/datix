import { describe, expect, test } from 'bun:test';
import { resolvePreferences } from '../../src/lib/i18n/preferences';

describe('visitor preferences', () => {
  test('country detection with English fallback', () => {
    for (const country of ['DE', 'AT']) expect(resolvePreferences('', country).locale).toBe('de');
    expect(resolvePreferences('', 'DK').locale).toBe('da');
    for (const country of [undefined, 'US', 'GB', 'CH', 'XX'])
      expect(resolvePreferences('', country).locale).toBe('en');
  });
  test('explicit choices take precedence over country', () => {
    expect(resolvePreferences('other=x; ab-language=en; ab-theme=light', 'DK')).toEqual({
      locale: 'en',
      theme: 'light',
    });
    expect(resolvePreferences('ab-language=da; ab-theme=dark', 'DE')).toEqual({
      locale: 'da',
      theme: 'dark',
    });
  });
  test('invalid preferences fall back safely', () => {
    expect(resolvePreferences('ab-language=<script>; ab-theme=invalid', 'DE')).toEqual({
      locale: 'de',
      theme: 'system',
    });
    expect(resolvePreferences('ab-language=; ab-theme=system')).toEqual({
      locale: 'en',
      theme: 'system',
    });
  });
});
