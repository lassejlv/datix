'use client';

import { useSitePreferences } from '../site-preferences';
// Source: https://coss.com/ui/r/sheet.json (Coss UI). Adapted to project tokens and breakpoints.

import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { XIcon } from './icons';
import type React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export const Sheet: typeof SheetPrimitive.Root = SheetPrimitive.Root;

export const SheetPortal: typeof SheetPrimitive.Portal = SheetPrimitive.Portal;

export function SheetTrigger(props: SheetPrimitive.Trigger.Props): React.ReactElement {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: SheetPrimitive.Close.Props): React.ReactElement {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export function SheetBackdrop({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <SheetPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 ease-[cubic-bezier(0.19,1,0.22,1)] motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      data-slot="sheet-backdrop"
      {...props}
    />
  );
}

export function SheetViewport({
  className,
  side,
  variant = 'default',
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: 'right' | 'left' | 'top' | 'bottom';
  variant?: 'default' | 'inset';
}): React.ReactElement {
  return (
    <SheetPrimitive.Viewport
      className={cn(
        'fixed inset-0 z-50 grid',
        side === 'bottom' && 'grid grid-rows-[1fr_auto] pt-12',
        side === 'top' && 'grid grid-rows-[auto_1fr] pb-12',
        side === 'left' && 'flex justify-start',
        side === 'right' && 'flex justify-end',
        variant === 'inset' && 'sm:p-4',
        className,
      )}
      data-slot="sheet-viewport"
      {...props}
    />
  );
}

export function SheetPopup({
  className,
  children,
  showCloseButton = true,
  side = 'right',
  variant = 'default',
  closeProps,
  portalProps,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  side?: 'right' | 'left' | 'top' | 'bottom';
  variant?: 'default' | 'inset';
  closeProps?: SheetPrimitive.Close.Props;
  portalProps?: SheetPrimitive.Portal.Props;
}): React.ReactElement {
  const { t } = useSitePreferences();

  return (
    <SheetPortal {...portalProps}>
      <SheetBackdrop />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitive.Popup
          className={cn(
            'relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover text-popover-foreground shadow-[var(--menu-shadow)] transition-[opacity,translate] duration-[280ms] data-ending-style:duration-200 motion-reduce:transition-none ease-[cubic-bezier(0.19,1,0.22,1)] will-change-transform data-ending-style:opacity-0 data-starting-style:opacity-0',
            side === 'bottom' &&
              'row-start-2 border-t data-ending-style:translate-y-full data-starting-style:translate-y-full',
            side === 'top' &&
              'border-b data-ending-style:-translate-y-full data-starting-style:-translate-y-full',
            side === 'left' &&
              'w-[calc(100%-(--spacing(12)))] max-w-md border-e data-ending-style:-translate-x-full data-starting-style:-translate-x-full',
            side === 'right' &&
              'col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-full data-starting-style:translate-x-full',
            variant === 'inset' &&
              'sm:rounded-xl sm:border sm:border-hover sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-xl)-1px)]',
            className,
          )}
          data-slot="sheet-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label={t('Close')}
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
              {...closeProps}
            >
              <XIcon />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

export function SheetHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<'div'>): React.ReactElement {
  const defaultProps = {
    className: cn(
      'flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4',
      className,
    ),
    'data-slot': 'sheet-header',
  };

  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function SheetFooter({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  variant?: 'default' | 'bare';
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      'flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end',
      variant === 'default' && 'pt-2 pb-5',
      variant === 'bare' &&
        'in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pt-3 pt-4 pb-6',
      className,
    ),
    'data-slot': 'sheet-footer',
  };

  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props): React.ReactElement {
  return (
    <SheetPrimitive.Title
      className={cn('font-heading font-semibold text-xl leading-none', className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props): React.ReactElement {
  return (
    <SheetPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export function SheetPanel({
  className,
  scrollFade = true,
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  scrollFade?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      'p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-header])]:pt-1 in-[[data-slot=sheet-popup]:has([data-slot=sheet-footer]:not(.border-t))]:pb-1',
      className,
    ),
    'data-slot': 'sheet-panel',
  };

  return (
    <ScrollArea overscrollContain scrollFade={scrollFade}>
      {useRender({
        defaultTagName: 'div',
        props: mergeProps<'div'>(defaultProps, props),
        render,
      })}
    </ScrollArea>
  );
}

export { SheetPrimitive, SheetBackdrop as SheetOverlay, SheetPopup as SheetContent };
