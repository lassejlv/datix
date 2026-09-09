import { useSitePreferences } from '../site-preferences';
import { Loader2Icon } from './icons';
import type React from 'react';
import { cn } from '@/lib/utils';

export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  const { t } = useSitePreferences();
  return (
    <Loader2Icon
      aria-label={t('Loading')}
      className={cn('animate-spin', className)}
      role="status"
      {...props}
    />
  );
}
