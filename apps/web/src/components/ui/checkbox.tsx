import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Native form semantics, with the kit's neutral checked, disabled and focus states.
export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      {...props}
      type="checkbox"
      data-slot="checkbox"
      className={cn('kit-checkbox', className)}
    />
  );
}

export function Switch({ className, ...props }: Omit<ComponentProps<'input'>, 'type' | 'role'>) {
  return (
    <input
      {...props}
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn('kit-switch', className)}
    />
  );
}
