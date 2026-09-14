'use client';

import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  'size'
> & {
  size?: 'sm' | 'default' | 'lg' | number;
  unstyled?: boolean;
  nativeInput?: boolean;
};

export function Input({
  className,
  size = 'default',
  unstyled = false,
  nativeInput = false,
  style,
  ...props
}: InputProps): React.ReactElement {
  const inputClassName = cn(
    'h-8 w-full min-w-0 rounded-[inherit] px-3 text-foreground text-sm leading-5 outline-none placeholder:text-muted-foreground placeholder:opacity-100 autofill:[-webkit-text-fill-color:var(--foreground)]',
    size === 'sm' && 'h-7 px-2.5',
    size === 'lg' && 'h-9 px-3.5 text-base leading-6',
    props.type === 'search' &&
      '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
    props.type === 'file' &&
      'text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm',
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            'relative inline-flex w-full rounded-lg border border-input bg-transparent text-sm transition-[border-color,box-shadow] duration-(--duration-quick) ease-smooth-out motion-reduce:transition-none has-focus-visible:border-[var(--input-focus)] has-focus-visible:shadow-[0_0_0_1px_var(--input-focus)] has-aria-invalid:border-danger has-focus-visible:has-aria-invalid:border-danger has-disabled:opacity-40',
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === 'number' ? size : undefined}
          style={typeof style === 'function' ? undefined : style}
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === 'number' ? size : undefined}
          style={style}
          {...props}
        />
      )}
    </span>
  );
}

export { InputPrimitive };

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-(--duration-quick) ease-smooth-out motion-reduce:transition-none focus-visible:border-[var(--input-focus)] focus-visible:shadow-[0_0_0_1px_var(--input-focus)] aria-invalid:border-danger disabled:opacity-40',
        className,
      )}
      {...props}
    />
  );
}
