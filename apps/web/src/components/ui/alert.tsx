import type { ComponentProps } from 'react';
import { Info, Warning } from './icons';
import { cn } from '@/lib/utils';

export function Alert({
  children,
  className,
  variant = 'error',
  ...props
}: ComponentProps<'div'> & { variant?: 'error' | 'warning' | 'info' }) {
  const Icon = variant === 'info' ? Info : Warning;

  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      {...props}
      data-variant={variant}
      className={cn('kit-alert', className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
