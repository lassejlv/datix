import type { TrackingSettings } from './tracking-settings';
import type { ImportedReportSources } from './imports';
export type User = { id: string; name: string; email: string };
export type SiteEnvironment = {
  trackingSettings?: Partial<TrackingSettings>;
  trackingMode: 'cookieless' | 'sessions' | 'local';
  id: string;
  siteId: string;
  name: string;
  domain: string;
  enabled: boolean;
  allowLocalhost: boolean;
  createdAt: string;
};
export type Site = {
  creditBudget: number | null;
  id: string;
  ownerId: string;
  name: string;
  domain: string;
  enabled: boolean;
  allowLocalhost: boolean;
  createdAt: string;
  environments: SiteEnvironment[];
};
export type Metric = 'pageviews' | 'dailyUniqueVisitors' | 'customEvents';
export type Point = {
  day: string;
  pageviews: number;
  dailyUniqueVisitors: number;
  customEvents: number;
};
export type Breakdown = { data: { value: string; count: number }[] };
export type Reports = {
  overview: {
    pageviews: number;
    dailyUniqueVisitors: number;
    customEvents: number;
    imports?: ImportedReportSources;
  };
  timeseries: { data: Point[] };
  path: Breakdown;
  referrer: Breakdown;
  country: Breakdown;
  device: Breakdown;
  event: Breakdown;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function apiClient<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json()) as { error?: { message?: string }; message?: string };
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.message ??
        data.message ??
        (response.status === 429
          ? 'Too many requests. Try again in a minute.'
          : 'This request could not be completed. Please try again.'),
    );
  return data as T;
}
export const write = (method: string, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(value),
});
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
export function dateLabel(
  day: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}
export const number = (value: number) => new Intl.NumberFormat('en-GB').format(value);
