// Source: https://coss.com/ui/r/tooltip.json (Coss UI). Adapted to project tokens and breakpoints.
'use client';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { createContext, useContext, useId, useState, type ReactElement } from 'react';
import type React from 'react';
import { cn } from '@/lib/utils';

export const TooltipCreateHandle: typeof TooltipPrimitive.createHandle =
  TooltipPrimitive.createHandle;

export const TooltipProvider: typeof TooltipPrimitive.Provider = TooltipPrimitive.Provider;

const TooltipContext = createContext<{ id: string; open: boolean } | null>(null);

export function Tooltip({ onOpenChange, ...props }: TooltipPrimitive.Root.Props): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(props.defaultOpen ?? false);

  return (
    <TooltipContext.Provider value={{ id, open: props.open ?? open }}>
      <TooltipPrimitive.Root
        {...props}
        onOpenChange={(next, details) => {
          setOpen(next);
          onOpenChange?.(next, details);
        }}
      />
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props): React.ReactElement {
  const context = useContext(TooltipContext);

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      aria-describedby={
        [props['aria-describedby'], context?.open ? context.id : undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
    />
  );
}

export function TooltipPopup({
  className,
  align = 'center',
  sideOffset = 4,
  side = 'bottom',
  anchor,
  children,
  portalProps,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props['align'];
  side?: TooltipPrimitive.Positioner.Props['side'];
  sideOffset?: TooltipPrimitive.Positioner.Props['sideOffset'];
  anchor?: TooltipPrimitive.Positioner.Props['anchor'];
  portalProps?: TooltipPrimitive.Portal.Props;
}): React.ReactElement {
  const context = useContext(TooltipContext);

  return (
    <TooltipPrimitive.Portal {...portalProps}>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="z-[130] h-(--positioner-height) w-(--positioner-width) max-w-[min(300px,calc(100vw-16px))] transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          role="tooltip"
          id={context?.id}
          className={cn(
            'relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-lg bg-tooltip text-tooltip-foreground text-sm leading-[20px] shadow-[var(--menu-shadow)] transition-[width,height,scale,opacity] duration-(--duration-quick) ease-out motion-reduce:transition-none data-ending-style:scale-(--scale-small) data-starting-style:scale-(--scale-small) data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0',
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-2 py-0.5 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipPrimitive, TooltipPopup as TooltipContent };

export function Hint({
  children,
  content,
}: {
  children: React.ReactElement;
  content: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{content}</TooltipPopup>
    </Tooltip>
  );
}

export function HintText({
  content,
  children,
  tabIndex = 0,
  ...props
}: Omit<React.ComponentProps<'span'>, 'content'> & { content: React.ReactNode }) {
  return (
    <Hint content={content}>
      <span {...props} tabIndex={tabIndex}>
        {children}
      </span>
    </Hint>
  );
}
