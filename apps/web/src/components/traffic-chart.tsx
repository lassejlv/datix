import type { Copy } from '../lib/i18n/translations';
import { useSitePreferences } from './site-preferences';
import { useMemo } from 'react';
import { Activity } from './ui/icons';
import { MotionConfig } from 'motion/react';
import { AreaChart } from './dither-kit/area-chart';
import type { Annotation } from './overview-extras';
import { useChart } from './dither-kit/chart-context';
import { Area, Line } from './dither-kit/area';
import { Grid } from './dither-kit/grid';
import { XAxis } from './dither-kit/x-axis';
import { YAxis } from './dither-kit/y-axis';
import { Tooltip } from './dither-kit/tooltip';
import { type Metric, type Point } from '../lib/client';
import { metricInk } from '../lib/metric-colors';

const metricLabels: Record<Metric, Copy> = {
  pageviews: 'Pageviews',
  dailyUniqueVisitors: 'Daily visitors',
  customEvents: 'Events',
};

export function TrafficChart({
  data,
  metric,
  previous,
  annotations = [],
}: {
  data: Point[];
  metric: Metric;
  previous?: Point[];
  annotations?: Annotation[];
}) {
  const { dateLabel, dateTime, number, t, dark } = useSitePreferences();
  const hourly = !!data[0]?.at;

  const rows = useMemo(() => {
    const label = (point: Point) => (point.at ? dateTime(point.at) : dateLabel(point.day));

    return data.map((point, index) => ({
      ...point,
      previous: previous?.[index]?.[metric] ?? 0,
      label: previous?.[index] ? `${label(point)} / ${label(previous[index])}` : label(point),
      axisLabel: point.at
        ? dateTime(point.at, { hour: '2-digit', minute: '2-digit' })
        : dateLabel(point.day),
    }));
  }, [data, dateLabel, dateTime, previous, metric]);

  const config = useMemo(() => {
    const ink = metricInk(metric, dark);

    return {
      [metric]: {
        label: t(metricLabels[metric]),
        color: 'grey' as const,
        seed: { fill: ink, line: ink, star: ink },
      },
      ...(previous ? { previous: { label: t('Previous period'), color: 'grey' as const } } : {}),
    };
  }, [metric, dark, t, previous]);

  const allZero =
    data.every((point) => point[metric] === 0) &&
    !previous?.some((point) => point[metric] > 0) &&
    !annotations.length;

  return (
    <div data-testid="traffic-chart" className="relative mt-4 h-[190px] md:h-[200px]">
      {allZero ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
          role="status"
        >
          <Activity className="size-[22px] text-muted-foreground" />
          <strong className="text-[15px] font-medium">{t('No activity in this period')}</strong>
          <span className="text-[13px] text-secondary-ink max-md:max-w-[230px]">
            {t('Choose another date range or check your installation.')}
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
            ariaLabel={t(
              hourly
                ? 'Hourly traffic chart. Use left and right arrow keys to inspect each hour.'
                : 'Daily traffic chart. Use left and right arrow keys to inspect each day.',
            )}
            margins={{ top: 16, right: 8, bottom: 28, left: 36 }}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Grid strokeDasharray="3 5" />
            <XAxis dataKey="axisLabel" maxTicks={3} tickMargin={12} />
            <YAxis tickFormatter={(value) => (Number.isInteger(value) ? number(value) : '')} />
            <Tooltip labelKey="label" valueFormatter={number} />
            <Area dataKey={metric} variant="gradient" />
            {previous && <Line dataKey="previous" strokeVariant="dashed" />}
            <AnnotationMarkers annotations={annotations} />
          </AreaChart>
        </MotionConfig>
      )}
    </div>
  );
}

function AnnotationMarkers({ annotations }: { annotations: Annotation[] }) {
  const ctx = useChart();
  const { dateLabel } = useSitePreferences();
  if (!ctx.ready) return null;

  return (
    <g>
      {annotations.map((note) => {
        const index = ctx.data.findIndex((point) => point.day === note.day);
        if (index < 0) return null;
        const x = ctx.xCenter(index);

        return (
          <g key={note.id} className="stroke-muted-foreground" data-testid="annotation-marker">
            <title>
              {dateLabel(note.day)}: {note.label}
            </title>
            <line x1={x} x2={x} y1={0} y2={ctx.plot.height} strokeDasharray="2 4" opacity={0.5} />
            <circle cx={x} cy={3} r={3} className="fill-background" />
          </g>
        );
      })}
    </g>
  );
}
