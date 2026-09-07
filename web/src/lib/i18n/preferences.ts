export type Locale = 'en' | 'de' | 'da';
export type Theme = 'system' | 'light' | 'dark';
export type Preferences = { locale: Locale; theme: Theme };
export function resolvePreferences(cookie: string, country?: string): Preferences {
  const cookies = Object.fromEntries(
    cookie.split(';').map((part) => {
      const [name, ...value] = part.trim().split('=');
      return [name, value.join('=')];
    }),
  );
  const language = cookies['ab-language'];
  const theme = cookies['ab-theme'];
  return {
    locale:
      language === 'en' || language === 'de' || language === 'da'
        ? language
        : country === 'DK'
          ? 'da'
          : country === 'DE' || country === 'AT'
            ? 'de'
            : 'en',
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
  };
}
