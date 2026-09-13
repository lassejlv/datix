import { useChartPart } from './chart-context';

export function XAxis({
  dataKey,
  tickFormatter,
  tickMargin = 8,
  maxTicks = 8,
}: {
  dataKey?: string;
  tickFormatter?: (value: unknown, index: number) => string;
  tickMargin?: number;
  maxTicks?: number;
}) {
  const ctx = useChartPart('XAxis');
  if (!ctx.ready) return null;

  const count = Math.max(1, Math.min(ctx.dataLength, maxTicks));

  const ticks = new Set(
    Array.from({ length: count }, (_, i) =>
      count === 1 ? 0 : Math.round((i * (ctx.dataLength - 1)) / (count - 1)),
    ),
  );

  const y = ctx.plot.height + tickMargin;

  return (
    <g className="fill-current font-sans text-[11px] text-muted-foreground">
      {ctx.data.map((row, i) => {
        if (!ticks.has(i)) return null;
        const raw = dataKey ? row[dataKey] : i;
        const label = tickFormatter ? tickFormatter(raw, i) : String(raw ?? '');

        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: index is the stable x position
            key={i}
            x={ctx.xCenter(i) ?? 0}
            y={y}
            textAnchor={
              ctx.dataLength === 1
                ? 'middle'
                : i === 0
                  ? 'start'
                  : i === ctx.dataLength - 1
                    ? 'end'
                    : 'middle'
            }
            dominantBaseline="hanging"
            fill="currentColor"
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}
