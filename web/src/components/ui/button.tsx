'use client';

import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Hint } from '@/components/ui/tooltip';

export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-sm font-medium outline-none transition-[background-color,color,border-color,opacity,box-shadow] duration-150 ease-[cubic-bezier(0.19,1,0.22,1)] motion-reduce:transition-none pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-36 data-loading:select-none data-loading:text-transparent [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-8 px-3',
        icon: 'size-8',
        'icon-lg': 'size-9',
        'icon-sm': 'size-6',
        'icon-xl': "size-10 [&_svg:not([class*='size-'])]:size-[18px]",
        'icon-xs': 'size-6 rounded-md',
        lg: 'h-9 px-3.5',
        sm: 'h-7 gap-1.5 px-2.5',
        xl: 'h-10 px-4 text-base',
        xs: 'h-6 gap-1 rounded-md px-2 text-xs',
      },
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground hover:bg-primary/85 data-pressed:bg-primary/80 data-pressed:shadow-[inset_0_1px_0_rgb(0_0_0/12%)] active:bg-primary/80 active:shadow-[inset_0_1px_0_rgb(0_0_0/12%)] *:data-[slot=button-loading-indicator]:text-primary-foreground',
        destructive:
          'border-danger bg-danger text-white hover:bg-[#c52d29] data-pressed:bg-[#c52d29] data-pressed:shadow-[inset_0_1px_0_rgb(0_0_0/16%)] active:bg-[#c52d29] active:shadow-[inset_0_1px_0_rgb(0_0_0/16%)] *:data-[slot=button-loading-indicator]:text-white',
        'destructive-outline':
          'border-input bg-transparent text-danger hover:bg-danger-wash data-pressed:bg-danger-wash *:data-[slot=button-loading-indicator]:text-danger',
        ghost:
          'border-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground',
        link: 'border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground',
        outline:
          'border-input bg-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-pressed data-pressed:bg-pressed *:data-[slot=button-loading-indicator]:text-secondary-foreground',
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  loading?: boolean;
  tooltip?: React.ReactNode;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  tooltip,
  title,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled: boolean = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>['type'] = render
    ? undefined
    : 'button';

  const defaultProps = {
    children: (
      <>
        {children}
        {loading && (
          <Spinner className="pointer-events-none absolute" data-slot="button-loading-indicator" />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    'aria-disabled': loading || undefined,
    'data-loading': loading ? '' : undefined,
    'data-slot': 'button',
    disabled: isDisabled,
    type: typeValue,
  };

  const element = useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  });
  const hint = tooltip ?? title ?? (size?.startsWith('icon') ? props['aria-label'] : undefined);
  return hint && !isDisabled ? <Hint content={hint}>{element}</Hint> : element;
}
