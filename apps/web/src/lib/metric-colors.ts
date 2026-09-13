import type { Metric } from './client';

/** Matches `Rgb` in the dither kit palette, which seeds the chart from these. */
export type MetricInk = [number, number, number];

// The chart and the overview stat tiles read the same ink, so the selected stat
// and the curve below it are recognisably one metric.
const inks: Record<'light' | 'dark', Record<Metric, MetricInk>> = {
  light: {
    pageviews: [173, 69, 25],
    dailyUniqueVisitors: [20, 117, 103],
    customEvents: [117, 78, 168],
  },
  dark: {
    pageviews: [245, 173, 104],
    dailyUniqueVisitors: [94, 211, 191],
    customEvents: [185, 164, 243],
  },
};

export const metricInk = (metric: Metric, dark: boolean): MetricInk =>
  inks[dark ? 'dark' : 'light'][metric];

export function metricColor(metric: Metric, dark: boolean, alpha = 1): string {
  const [r, g, b] = metricInk(metric, dark);
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
