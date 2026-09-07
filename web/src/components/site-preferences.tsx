import { Globe2, Monitor } from './ui/icons';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Locale, Preferences, Theme } from '../lib/i18n/preferences';
import { translations, type Copy } from '../lib/i18n/translations';
const Context = createContext({
  locale: 'en' as Locale,
  theme: 'system' as Theme,
  dark: false,
  setLocale: (_locale: Locale) => {},
  setTheme: (_theme: Theme) => {},
});
export function SitePreferences({
  initial,
  children,
}: {
  initial: Preferences;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState(initial.locale);
  const [theme, setTheme] = useState(initial.theme);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle(
      'dark',
      theme === 'dark' ||
        (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches),
    );
  }, [locale, theme, dark]);
  const save = (name: string, value: string) => {
    document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };
  return (
    <Context.Provider
      value={{
        locale,
        theme,
        dark,
        setLocale: (value) => {
          setLocale(value);
          save('ab-language', value);
        },
        setTheme: (value) => {
          setTheme(value);
          save('ab-theme', value);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSitePreferences() {
  const context = useContext(Context);
  return {
    ...context,
    darkMedia:
      context.theme === 'system'
        ? '(prefers-color-scheme: dark)'
        : context.theme === 'dark'
          ? 'all'
          : 'not all',
    t: (text: Copy) => (context.locale === 'en' ? text : translations[text][context.locale]),
  };
}
export function FooterPreferences() {
  const { locale, theme, setLocale, setTheme, t } = useSitePreferences();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="footer-preferences">
      <label>
        <span className="sr-only">{t('Language')}</span>
        <Globe2 size={14} />
        <select
          disabled={!mounted}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="en">English</option>
          <option value="de">Deutsch</option>
          <option value="da">Dansk</option>
        </select>
      </label>
      <label>
        <span className="sr-only">{t('Theme')}</span>
        <Monitor size={14} />
        <select
          disabled={!mounted}
          value={theme}
          onChange={(event) => setTheme(event.target.value as Theme)}
        >
          <option value="system">{t('System')}</option>
          <option value="light">{t('Light')}</option>
          <option value="dark">{t('Dark')}</option>
        </select>
      </label>
    </div>
  );
}
