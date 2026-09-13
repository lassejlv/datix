import { useSitePreferences } from '../site-preferences';
import type React from 'react';
import { cn } from '@/lib/utils';

export function Spinner({ className, ...props }: React.ComponentProps<'span'>): React.ReactElement {
  const { t } = useSitePreferences();
  return (
    <span
      aria-label={t('Loading')}
      className={cn('kit-spinner', className)}
      role="status"
      {...props}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
      </svg>
    </span>
  );
}
