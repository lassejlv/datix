import { en, type Copy } from './en';
import { de } from './de';
import { da } from './da';
import type { Locale } from './preferences';

export type { Copy } from './en';

export type Parameters = Record<string, string | number>;

export type Translate = (text: Copy, values?: Parameters) => string;

export const translations = { en, de, da };

export const formatLocale = { en: 'en-GB', de: 'de-DE', da: 'da-DK' } as const;

export function translate(locale: Locale, text: Copy, values: Parameters = {}): string {
  const template: string = translations[locale][text] ?? en[text];

  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/** Localize application messages only; never run this on names or collected visitor data. */
export function translateMessage(locale: Locale, text: string): string {
  if (Object.hasOwn(en, text)) return translate(locale, text as Copy);

  for (const { key, names, expression } of messagePatterns) {
    const match = expression.exec(text);
    if (match)
      return translate(
        locale,
        key,
        Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? ''])),
      );
  }

  return text;
}

// Legacy API messages include filenames, dates and column names. Match only complete,
// known English templates and preserve captured values as text, never as HTML.
const messagePatterns = (Object.keys(en) as Copy[])
  .filter((key) => /\{\w+\}/.test(key))
  .map((key) => {
    const names: string[] = [];

    const pattern = key
      .split(/(\{\w+\})/g)
      .map((part) => {
        if (/^\{\w+\}$/.test(part)) {
          names.push(part.slice(1, -1));

          return '(.+?)';
        }

        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');

    return { key, names, expression: new RegExp(`^${pattern}$`, 's') };
  });
