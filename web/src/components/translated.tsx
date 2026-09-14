import { Fragment, type ReactNode } from 'react';
import type { Copy } from '../lib/i18n/translations';
import { useSitePreferences } from './site-preferences';

/** Named React slots let each language place emphasis and code in its own word order. */
export function Translated({ text, values }: { text: Copy; values: Record<string, ReactNode> }) {
  const { t } = useSitePreferences();

  return t(text)
    .split(/(\{\w+\})/g)
    .map((part, index) => (
      <Fragment key={index}>
        {part.startsWith('{') && Object.hasOwn(values, part.slice(1, -1))
          ? values[part.slice(1, -1)]
          : part}
      </Fragment>
    ));
}
