export type ImportProvider = 'plausible' | 'ga4';
export type ImportSummary = {
  id?: string;
  createdAt?: string;
  fingerprint: string;
  provider: ImportProvider;
  sourceName: string;
  timeZone: string;
  visitorMetric: string;
  from: string;
  to: string;
  days: number;
  rowCount: number;
  pageviews: number;
  dailyVisitors: number;
  customEvents: number;
  metrics: string[];
  breakdowns: string[];
  warnings: string[];
  duplicate: boolean;
};
export type ImportedReportSources = {
  sources: Pick<
    ImportSummary,
    | 'id'
    | 'provider'
    | 'sourceName'
    | 'timeZone'
    | 'visitorMetric'
    | 'from'
    | 'to'
    | 'metrics'
    | 'breakdowns'
  >[];
  importedDays: number;
  pageviews: number;
  dailyVisitors: number;
  customEvents: number;
  breakdowns: string[];
  calendarDayWarning: boolean;
};
export const providerName = (provider: ImportProvider) =>
  provider === 'plausible' ? 'Plausible' : 'Google Analytics 4';
export const breakdownName = (dimension: string) =>
  ({
    path: 'Pages',
    referrer: 'Referrers',
    country: 'Countries',
    device: 'Devices',
    event: 'Custom events',
  })[dimension] ?? dimension;
