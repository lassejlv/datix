import { useSitePreferences } from './site-preferences';
import { useMemo } from 'react';
import { Activity } from './ui/icons';
import { MotionConfig } from 'motion/react';
import { AreaChart } from './dither-kit/area-chart';
import { Area } from './dither-kit/area';
import type { Rgb } from './dither-kit/palette';
import { Grid } from './dither-kit/grid';
import { XAxis } from './dither-kit/x-axis';
import { YAxis } from './dither-kit/y-axis';
import { Tooltip } from './dither-kit/tooltip';
import { dateLabel, number, type Metric, type Point } from '../lib/client';

const metricLabels: Record<Metric, string> = {
  pageviews: 'Pageviews',
  dailyUniqueVisitors: 'Daily visitors',
  customEvents: 'Events',
};

export function TrafficChart({ data, metric }: { data: Point[]; metric: Metric }) {
  const { dark } = useSitePreferences();
  const rows = useMemo(
    () => data.map((point) => ({ ...point, label: dateLabel(point.day) })),
    [data],
  );
  const config = useMemo(() => {
    const ink: Rgb = dark ? [222, 222, 222] : [51, 51, 51];
    return {
      [metric]: {
        label: metricLabels[metric],
        color: 'grey' as const,
        seed: { fill: ink, line: ink, star: ink },
      },
    };
  }, [metric, dark]);
  const allZero = data.every((point) => point[metric] === 0);

  return (
    <div data-testid="traffic-chart" className="relative mt-4 h-[190px] md:h-[200px]">
      {allZero ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
          role="status"
        >
          <Activity className="size-[22px] text-muted-foreground" />
          <strong className="text-[15px] font-medium">No activity in this period</strong>
          <span className="text-[13px] text-secondary-ink max-md:max-w-[230px]">
            Choose another date range or check your installation.
          </span>
        </div>
      ) : (
        <MotionConfig reducedMotion="user">
          <AreaChart
            key={metric}
            data={rows}
            config={config}
            bloom="off"
            animationDuration={450}
            ariaLabel="Daily traffic chart. Use left and right arrow keys to inspect each day."
            margins={{ top: 16, right: 8, bottom: 28, left: 36 }}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Grid strokeDasharray="3 5" />
            <XAxis dataKey="label" maxTicks={3} tickMargin={12} />
            <YAxis tickFormatter={(value) => (Number.isInteger(value) ? number(value) : '')} />
            <Tooltip labelKey="label" valueFormatter={number} />
            <Area dataKey={metric} variant="gradient" />
          </AreaChart>
        </MotionConfig>
      )}
    </div>
  );
}
