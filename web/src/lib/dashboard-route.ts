export const dashboardPages = [
  'setup',
  'overview',
  'visitors',
  'installation',
  'imports',
  'settings',
  'goals',
  'errors',
  'web-vitals',
  'globe',
  'pulse',
] as const;
export type DashboardPage = (typeof dashboardPages)[number];
export function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === 'string' && dashboardPages.some((page) => page === value);
}
export const siteRoute = '/site/$siteId/$environmentId/$page' as const;
export const validRouteId = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
