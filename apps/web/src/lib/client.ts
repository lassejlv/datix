import type { FeatureSettings } from './features';
import type { TrackingSettings } from './tracking-settings';
import type { ImportedReportSources } from './imports';
/** `admin` only reveals administrative navigation; every /api/admin route re-checks access. */
export type User = { id: string; name: string; email: string; admin?: boolean };
export type SiteEnvironment = {
  featureSettings?: Partial<FeatureSettings>;
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
  at?: string;
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
  const data = (await response.json()) as {
    error?: { code?: string; message?: string };
    message?: string;
  };
  if (
    response.status === 402 &&
    data.error?.code === 'subscription_required' &&
    typeof window !== 'undefined'
  )
    window.dispatchEvent(new Event('datix:subscription-required'));
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
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message))
    return 'Network error. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
export function dateLabel(
  day: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}
export const number = (value: number) => new Intl.NumberFormat('en-GB').format(value);
