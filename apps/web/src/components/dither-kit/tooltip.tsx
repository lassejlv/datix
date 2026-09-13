'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useState } from 'react';
import { useCommonChart } from './common-context';
import { cn } from './lib';
import { rgb } from './palette';

export type TooltipVariant = 'default' | 'frosted-glass';

const VARIANT: Record<TooltipVariant, string> = {
  default: 'bg-tooltip',
  'frosted-glass': 'bg-tooltip',
};

/**
 * Floating hover tooltip. Reads the shared common context so it works in every
 * chart family. It glides between points and fades in/out (instead of snapping),
 * and dims unselected series/slices.
 */
export function Tooltip({
  labelKey,
  valueFormatter,
  variant = 'default',
}: {
  labelKey?: string;
  valueFormatter?: (value: number, name: string) => string;
  variant?: TooltipVariant;
}) {
  const chart = useCommonChart();
  const [bounds, setBounds] = useState({ width: 0, container: 0 });
  const measureTooltip = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => {
      const width = node.offsetWidth;
      const container = node.parentElement?.clientWidth ?? 0;
      setBounds((previous) =>
        previous.width === width && previous.container === container
          ? previous
          : { width, container },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.parentElement) observer.observe(node.parentElement);
    measure();
    return () => observer.disconnect();
  }, []);
  const left = bounds.container
    ? Math.max(
        bounds.width / 2 + 4,
        Math.min(bounds.container - bounds.width / 2 - 4, chart.tooltipLeft),
      )
    : chart.tooltipLeft;
  const show = chart.ready && chart.hoverIndex != null;

  // Retain the last hovered index so the card keeps its content while fading
  // out — adjust-state-during-render (no refs in render).
  const [lastIndex, setLastIndex] = useState(0);
  if (chart.hoverIndex != null && chart.hoverIndex !== lastIndex) {
    setLastIndex(chart.hoverIndex);
  }
  const index = chart.hoverIndex ?? lastIndex;

  const heading = chart.heading(index, labelKey);
  const items = chart.itemsAt(index);

  return (
    <AnimatePresence>
      {show && items.length > 0 && (
        <motion.div
          key="dither-tooltip"
          ref={measureTooltip}
          data-slot="chart-tooltip"
          role="status"
          aria-live="polite"
          initial={{
            opacity: 0,
            x: '-50%',
            y: '-115%',
            top: chart.tooltipTop,
            left,
          }}
          animate={{
            opacity: 1,
            x: '-50%',
            y: '-115%',
            top: chart.tooltipTop,
            left,
          }}
          exit={{ opacity: 0 }}
          transition={{
            type: 'spring',
            stiffness: 520,
            damping: 38,
            mass: 0.6,
          }}
          className={cn(
            'pointer-events-none absolute z-10 max-w-[calc(100%-8px)] rounded-lg px-2 py-1.5 text-tooltip-foreground shadow-[var(--menu-shadow)]',
            VARIANT[variant],
          )}
        >
          {heading && (
            <div className="mb-0.5 font-sans text-sm text-tooltip-foreground">{heading}</div>
          )}
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <div
                key={item.name}
                className="flex items-center gap-1.5 font-sans text-sm text-tooltip-foreground tabular-nums"
                style={{ opacity: item.dimmed ? 0.4 : 1 }}
              >
                <span
                  className="size-2 rounded-[1px]"
                  style={{ backgroundColor: rgb(item.seed.fill) }}
                />
                <span className="text-tooltip-foreground">{item.label}</span>
                <span className="ml-auto pl-2 text-tooltip-foreground">
                  {valueFormatter
                    ? valueFormatter(item.value, item.name)
                    : item.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

Tooltip.chartLayer = 'dom' as const;
