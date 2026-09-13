import { resolvePreferences, type Preferences } from './preferences';

export async function getPreferences(): Promise<Preferences> {
  let countryPreferences: Preferences | undefined;
  try {
    const response = await fetch('/api/preferences', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const preferences = (await response.json()) as Partial<Preferences> | null;
      if (
        preferences &&
        (preferences.locale === 'en' ||
          preferences.locale === 'de' ||
          preferences.locale === 'da') &&
        (preferences.theme === 'system' ||
          preferences.theme === 'light' ||
          preferences.theme === 'dark')
      ) {
        countryPreferences = preferences as Preferences;
      }
    }
  } catch {
    // The app can still render with saved preferences when country lookup is unavailable.
  }

  const cookie = document.cookie;
  const saved = resolvePreferences(cookie);
  const manualLanguage = /(?:^|;\s*)ab-language=(?:en|de|da)(?:;|$)/.test(cookie);
  const manualTheme = /(?:^|;\s*)ab-theme=(?:system|light|dark)(?:;|$)/.test(cookie);
  return {
    locale: manualLanguage ? saved.locale : (countryPreferences?.locale ?? saved.locale),
    theme: manualTheme ? saved.theme : (countryPreferences?.theme ?? saved.theme),
  };
}
