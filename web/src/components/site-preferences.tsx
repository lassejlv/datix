import { Globe2, Monitor } from './ui/icons';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale, Preferences, Theme } from '../lib/i18n/preferences';
import {
  translate,
  translateMessage,
  formatLocale,
  type Copy,
  type Parameters,
} from '../lib/i18n/translations';
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
  const formatting = useMemo(() => {
    const language = formatLocale[context.locale];
    const formatter = new Intl.NumberFormat(language);
    return {
      t: (text: Copy, values?: Parameters) => translate(context.locale, text, values),
      message: (text: string) => translateMessage(context.locale, text),
      number: (value: number) => formatter.format(value),
      dateLabel: (
        day: string,
        options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
      ) =>
        new Date(`${day}T12:00:00Z`).toLocaleDateString(language, { ...options, timeZone: 'UTC' }),
      dateTime: (
        value: string,
        options: Intl.DateTimeFormatOptions = {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      ) => new Date(value).toLocaleString(language, { ...options, timeZone: 'UTC' }),
    };
  }, [context.locale]);
  return {
    ...context,
    ...formatting,
    darkMedia:
      context.theme === 'system'
        ? '(prefers-color-scheme: dark)'
        : context.theme === 'dark'
          ? 'all'
          : 'not all',
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
